import { Mission, FACTION, MODE, STAT, ZONE, fmt, rand, pick } from '../mission.js';
import { inPoly } from './shared/geometry.js';
import { cars, squads } from './shared/spawn.js';

// ======================================================================================= THE MASSACRE
// Fictional. A peaceful anti-war demonstration in front of the US Embassy on Prešernova; an AntiFa squad shoves
// through the crowd to the compound fence, the Marine guard sounds an alert and uncovers two machine-gun posts, a
// minute later the fence gives way and the guns fire for a minute into whoever is in front of them. The breach
// cannot be stopped: the job is to get people out of the line of fire before it comes.
const EMB_FENCE = [ [ - 694, 32.9 ], [ - 694, 27.5 ], [ - 665, 20.8 ], [ - 621.9, 8.7 ], [ - 593.7, 2.5 ], [ - 587, 19.4 ], [ - 580.3, 41 ],
	[ - 568.2, 57.1 ], [ - 564.2, 75.9 ], [ - 560.1, 99.5 ], [ - 587, 108.1 ], [ - 611.2, 113.5 ], [ - 638.1, 119.4 ],
	[ - 644.5, 107.1 ], [ - 655, 93.9 ], [ - 665.6, 81.4 ], [ - 672, 67.5 ], [ - 673.9, 58 ], [ - 687.1, 48.6 ], [ - 694, 32.9 ] ]; // drawn by the user, closed
const EMB_YARD = EMB_FENCE.flat(); // the compound
const EMB_GUNS = [ [ - 571.7, 85 ], [ - 578.9, 68.4 ] ]; // the two Marine posts, east face of the embassy
const EMB_BREACH = [ - 565, 71 ]; // where the AntiFa squad goes through the fence (opposite Tomšičeva)
const EMB_RALLY = [ - 552, 86 ]; // the demonstration: Prešernova in front of the embassy and the mouth of Tomšičeva
const FENCE_HALF = 0.4; // m: the fence as an obstacle in the SDF
const GUN_RANGE = 220, GUN_ARC = 80 * Math.PI / 180; // m · half the traverse either side of straight out from the fence
// rounds per second per gun · aim scatter (rad, σ) · how close to the line of a round a person is hit (m) ·
// hit → dead (else wounded) · a round goes on through someone to the next
const FIRE_RATE = 6, SPREAD = 0.9 * Math.PI / 180, HIT_W = 0.45, KILL_P = 0.5, PASS_P = 0.3;
const ANTIFA_AT = 120, ALERT_LATEST = 120, BREACH_AFTER = 15, FIRE_FOR = 60, AFTERMATH = 20; // s
const CROWD_START = 2500, BACK_OFF_R = 150, BACK_OFF_SPEED = 0.6; // people at the start · who backs off at the alarm (m), how slowly
const DEAD_MAX = 100;
const GREEN = 'rgb(80,255,120)';

export class MassacreMission extends Mission {

	static id = 'massacre';
	static title = 'The Massacre';
	static flashing = true; // the strobe: the top bar gets its on / off button
	static subtitle = 'fictional · the US Embassy · keep the death toll under 100';
	static side = 'police';
	static brief = `A <b>peaceful anti-war demonstration</b> in front of the <b>US Embassy</b> on Prešernova, and more people are
		on their way. Your intelligence is bad: an <b>AntiFa squad</b> will shove its way through the crowd to the compound fence.
		The Marine guard will sound the alert and uncover two <b>machine-gun posts</b>. Fifteen seconds later the fence gives way
		and the Marines open fire for a full minute, at protesters and police alike. <b>You cannot stop the breach.</b> You can
		only make sure as few people as possible are in front of those guns when it comes. <i>Fiction. Contains rapid
		flashing light during the shooting: the ☀ button in the top bar turns it off.</i>`;
	static goals = [ 'Fewer than 100 dead when the shooting stops', '★ Fewer than 50 dead', '★ Fewer than 25 dead, no officer killed' ];
	static tips = [ 'The red fan is the guns\' field of fire. Buildings stop bullets; the fence does not. "In the line of fire" counts who is in it',
		'A lawful, peaceful crowd mostly ignores an order to leave (B) until the alarm sounds. After it, B sends them off at a run',
		'At the alarm the crowd starts backing away, slowly, and newcomers keep pushing in. Fifteen seconds is not long: prepare before',
		'Cordons across the approach streets stop newcomers from walking into the field of fire',
		'Your squads at the fence are in the line of fire too. Officers die like everyone else',
		'Prešernova, north and south of the embassy, is the killing ground. Tomšičeva and Cankarjeva give cover a few dozen metres in, and so do the lanes along the sides of the compound',
		'Delaying the AntiFa squad does not stop the breach, but arresting it keeps the crowd calmer',
		'☀ in the top bar turns the flashing effects off' ];

	// the fence becomes a wall before the routes and the crowd see the map (Game.load). Bullets read the city without it.
	static prepare( city ) {

		city.sdfRaw = city.sdfData.slice();
		const { w, h } = city.sdf, C = city.cost, [ x0, y0 ] = city.bounds;
		for ( let k = 1; k < EMB_FENCE.length; k ++ ) {

			const [ ax, ay ] = EMB_FENCE[ k - 1 ], [ bx, by ] = EMB_FENCE[ k ];
			for ( let iy = Math.floor( Math.min( ay, by ) - 3 - y0 ); iy <= Math.ceil( Math.max( ay, by ) + 3 - y0 ); iy ++ ) {

				for ( let ix = Math.floor( Math.min( ax, bx ) - 3 - x0 ); ix <= Math.ceil( Math.max( ax, bx ) + 3 - x0 ); ix ++ ) {

					if ( ix < 0 || iy < 0 || ix >= w || iy >= h ) continue;
					const v = Math.max( - 127, Math.min( 127, Math.round( ( segDist( x0 + ix + 0.5, y0 + iy + 0.5, ax, ay, bx, by ) - FENCE_HALF ) * 10 ) ) );
					if ( v < city.sdfData[ iy * w + ix ] ) city.sdfData[ iy * w + ix ] = v;

				}

			}

			// routes: blocked cells along the fence, a band thick enough that no diagonal step slips through
			const len = Math.hypot( bx - ax, by - ay ), nx = - ( by - ay ) / len, ny = ( bx - ax ) / len;
			for ( let s = 0; s <= len; s += 0.5 ) for ( const o of [ - 1.2, 0, 1.2 ] ) {

				const q = Math.floor( ( ax + ( bx - ax ) * s / len + nx * o - x0 ) / C.res ), r = Math.floor( ( ay + ( by - ay ) * s / len + ny * o - y0 ) / C.res );
				if ( q >= 0 && r >= 0 && q < C.w && r < C.h ) city.costData[ r * C.w + q ] = 255;

			}

		}

		// nobody routes, spawns or strolls inside the compound
		for ( let r = 0; r < C.h; r ++ ) for ( let q = 0; q < C.w; q ++ ) {

			const x = x0 + ( q + 0.5 ) * C.res, y = y0 + ( r + 0.5 ) * C.res;
			if ( x > - 700 && x < - 550 && y > 0 && y < 125 && inPoly( EMB_YARD, x, y ) ) city.costData[ r * C.w + q ] = 255;

		}

	}

	async setup() {

		const W = this.world, M = W.marks;
		await W.exits();
		this.focus = [ - 560, 60 ];
		this.zoom = 0.45;
		this.opinion = 60;
		this.dead = 0;
		this.deadPolice = 0;
		this.inFire = 0;
		this.tracers = [];
		this.hit = new Set(); // agents already shot (the readback lags the edit queue)
		this.resources = { gas: { left: 2, max: 2 }, water: { left: 2, max: 2 }, reinforce: { left: 4, max: 4, cooldown: 20, ready: 0 }, order: { left: 99, max: 99, cooldown: 6, ready: 0 } };
		this.guns = EMB_GUNS.map( ( [ x, y ], k ) => ( { x, y, k, face: this.faceOut( x, y ), ang: 0, phase: Math.random() * 6, acc: 0, target: null, retarget: 0 } ) );
		for ( const G of this.guns ) { G.ang = G.face; G.fan = this.fan( G ); }
		this.visGrid();
		this.setZones( [ { x: EMB_RALLY[ 0 ], y: EMB_RALLY[ 1 ], r: 60, type: ZONE.CIVIL } ] );

		// where people can run to: street spots out of both guns' sight, spread round the compass
		this.rallyL = await W.field( 'rally', EMB_RALLY[ 0 ], EMB_RALLY[ 1 ], 30, true );
		this.safe = [];
		const mid = this.mid = [ ( EMB_GUNS[ 0 ][ 0 ] + EMB_GUNS[ 1 ][ 0 ] ) / 2, ( EMB_GUNS[ 0 ][ 1 ] + EMB_GUNS[ 1 ][ 1 ] ) / 2 ];
		const cands = [];
		for ( const r of [ 150, 180, 210, 240 ] ) for ( let a = 0; a < 360; a += 7.5 ) {

			const p = W.roadSpot( mid[ 0 ] + Math.cos( a * Math.PI / 180 ) * r, mid[ 1 ] + Math.sin( a * Math.PI / 180 ) * r, 25 );
			if ( p && ! inPoly( EMB_YARD, ...p ) && ! this.exposed( p[ 0 ], p[ 1 ], 10 ) ) cands.push( { p, a: Math.atan2( p[ 1 ] - mid[ 1 ], p[ 0 ] - mid[ 0 ] ), r } );

		}

		for ( const c of cands ) if ( this.safe.length < 6 && this.safe.every( ( s ) => Math.abs( angDiff( s.a, c.a ) ) > 0.7 ) ) this.safe.push( c );
		for ( const [ k, s ] of this.safe.entries() ) s.layer = await W.field( 'safe' + k, s.p[ 0 ], s.p[ 1 ], 16, true );
		if ( ! this.safe.length ) this.safe.push( { p: [ mid[ 0 ], mid[ 1 ] - 300 ], layer: W.exitLayer } ); // never expected: the map's exits

		// the approaches the demonstrators come by (map streets, 250–400 m out)
		this.approaches = [ [ - 505, 330 ], [ - 400, 150 ], [ - 450, 55 ], [ - 575, - 150 ], [ - 760, 200 ] ].map( ( p ) => W.roadSpot( ...p, 60 ) ?? p );
		this.crowdGroups = [];
		// the demonstration: already a crowd, standing in the street (never inside the compound)
		const pts = [];
		for ( let t = 0; pts.length < CROWD_START && t < 150000; t ++ ) {

			const a = Math.random() * Math.PI * 2, d = Math.sqrt( Math.random() ) * 75;
			const x = EMB_RALLY[ 0 ] + Math.cos( a ) * d, y = EMB_RALLY[ 1 ] + Math.sin( a ) * d;
			if ( W.sdf( x, y ) > 0.7 && W.cost( x, y ) <= 18 && ! inPoly( EMB_YARD, x, y ) ) pts.push( [ x, y ] );

		}

		pts.sort( ( p, q ) => Math.atan2( p[ 1 ] - EMB_RALLY[ 1 ], p[ 0 ] - EMB_RALLY[ 0 ] ) - Math.atan2( q[ 1 ] - EMB_RALLY[ 1 ], q[ 0 ] - EMB_RALLY[ 0 ] ) );
		this.crowdGroups.push( ...await W.placeBloc( { kind: 'crowd', label: 'Anti-war demonstration', points: pts, groupSize: 50, layer: this.rallyL, mode: MODE.MARCH,
			agitation: [ 0.05, 0.2 ], resolve: [ 0.9, 1.3 ], morale: 0.7 } ) );

		// the embassy's police protection: a line along the fence, the rest round the block
		const line = await squads( W, [ [ - 560, 70 ], [ - 558, 80 ] ] );
		await W.lineSquads( line, [ - 563.2, 59 ], [ - 557.4, 97 ], null );
		await squads( W, [ M[ 'PU Ljubljana' ], [ - 540, 150 ], P( W, 'Trg republike' ), P( W, 'Trg republike' ), [ - 490, 150 ] ] );
		await cars( W, [ [ - 600, - 30 ], [ - 520, 175 ] ] );
		await W.patrols.add( { at: [ - 585, - 45 ], water: true } ); // PU Ljubljana
		this.crowd.u.panicAt.value.set( this.mid[ 0 ], this.mid[ 1 ], 120, 0 );
		await this.bystanders( 500 );

	}

	start() {

		this.after( 2, () => this.event( 'A peaceful anti-war demonstration in front of the US Embassy. More people are on their way.', 'info', EMB_RALLY ) );
		for ( let t = 12; t < ANTIFA_AT + ALERT_LATEST + 30; t += 18 ) this.after( t, () => this.arrive() );
		this.after( ANTIFA_AT, () => this.antifaIn() );
		this.after( ANTIFA_AT + ALERT_LATEST, () => this.alert() );

	}

	// newcomers from one of the approaches, walking to the demonstration (until 30 s after the alarm)
	async arrive() {

		if ( this.firing || ( this.alertAt && this.t > this.alertAt + 30 ) ) return;
		const at = pick( this.approaches );
		this.crowdGroups.push( ...await this.world.bloc( { kind: 'crowd', label: 'Anti-war demonstration', at, n: Math.round( rand( 90, 170 ) ), groupSize: 45, spread: 15,
			layer: this.rallyL, agitation: [ 0.05, 0.2 ], resolve: [ 0.9, 1.3 ], morale: 0.7 } ) );

	}

	async antifaIn() {

		const W = this.world;
		const L = await W.field( 'antifa', EMB_BREACH[ 0 ] + 2.5, EMB_BREACH[ 1 ] + 0.5, 3 );
		[ this.antifa ] = await W.bloc( { kind: 'antifa', label: 'AntiFa', at: W.roadSpot( - 470, 70 ) ?? [ - 470, 70 ], n: 24, groupSize: 24, spread: 4, layer: L,
			mode: MODE.PUSH, agitation: [ 0.65, 0.85 ], resolve: [ 1.3, 1.5 ], morale: 0.95, speed: [ 1.15, 1.15 ] } );
		this.antifa.closed = true;
		this.antifa.ordered = true; // an order to leave only winds them up
		this.crowd.u.parting.value = this.antifa.id; // the crowd always makes way for them
		this.event( 'An AntiFa squad is shoving its way through the crowd toward the embassy fence', 'bad', this.antifa.center ?? [ - 470, 70 ] );

	}

	// the Marines sound the alarm and uncover the guns; a minute to the breach
	alert() {

		if ( this.alertAt ) return;
		this.alertAt = this.t;
		this.wander = null; // bystanders stop strolling about
		this.game.sound?.klaxon( this.mid, BREACH_AFTER + FIRE_FOR );
		this.event( 'ALERT at the embassy: the Marines have uncovered two machine-gun posts. The crowd starts backing away from the fence.', 'bad', this.mid );
		// the crowd backs off, slowly (no panic yet); newcomers further out do not know and keep coming
		for ( const g of this.civilians() ) if ( g !== this.antifa && g.center && dist( g.center, EMB_BREACH ) < BACK_OFF_R ) this.evacuate( g, BACK_OFF_SPEED );
		this.after( BREACH_AFTER / 2, () => this.event( 'The fence is giving way', 'bad', EMB_BREACH ) );
		this.after( BREACH_AFTER, () => this.breach() );

	}

	breach() {

		const W = this.world, { w } = this.city.sdf, [ x0, y0 ] = this.city.bounds;
		// a gap in the fence: the city as it was, 3 m either side of the breach
		for ( let iy = Math.floor( EMB_BREACH[ 1 ] - 4 - y0 ); iy <= Math.ceil( EMB_BREACH[ 1 ] + 4 - y0 ); iy ++ ) {

			for ( let ix = Math.floor( EMB_BREACH[ 0 ] - 4 - x0 ); ix <= Math.ceil( EMB_BREACH[ 0 ] + 4 - x0 ); ix ++ ) {

				if ( Math.hypot( x0 + ix + 0.5 - EMB_BREACH[ 0 ], y0 + iy + 0.5 - EMB_BREACH[ 1 ] ) < 3.2 ) this.city.sdfData[ iy * w + ix ] = this.city.sdfRaw[ iy * w + ix ];

			}

		}

		this.crowd.sdfTex.needsUpdate = true;
		this.breached = true;
		this.firing = true;
		this.fireAt = this.t;
		this.atBreach = this.inFire;
		this.crowd.u.panicAt.value.w = 1;
		this.game.sound?.stampede( this.mid );
		this.event( 'The fence is down. The Marines OPEN FIRE.', 'bad', this.mid );
		// total panic: everyone runs, the way they were already going or straight away from the guns
		for ( const g of [ ...this.civilians(), ...W.groupsOf( FACTION.BYSTANDER ) ] ) {

			if ( ! g.center || dist( g.center, this.mid ) > 320 ) continue;
			if ( g.evac === undefined ) g.evac = this.radial( g.center );
			W.setLayer( g, this.safe[ g.evac ].layer );
			W.setMode( [ g ], MODE.PANIC, { speed: rand( 1.1, 1.3 ) } );

		}

		this.crowd.u.parting.value = - 1;
		this.after( FIRE_FOR, () => {

			this.firing = false;
			this.crowd.u.panicAt.value.w = 0.4;
			this.event( `Cease fire. ${this.dead} dead.`, this.dead < DEAD_MAX ? 'warn' : 'bad', this.mid );

		} );
		this.after( FIRE_FOR + AFTERMATH, () => this.finishUp() );

	}

	finishUp() {

		const n = this.dead;
		if ( n < DEAD_MAX ) this.end( true, n ? `${n} people were killed in front of the embassy. Without your work it would have been many more.` : 'Nobody was in front of the guns when they fired.' );
		else this.end( false, `${n} people were killed in front of the embassy. The street was still full when the guns opened up.` );

	}

	civilians() { return this.world.groups.filter( ( g ) => ( g.faction === FACTION.PROTESTER || g.faction === FACTION.COUNTER ) && ( g.alive ?? 1 ) > 0 && g.members.length ); }

	// a group heads for the nearest way out that does not lead past the front of the embassy
	evacuate( g, speed = 1.25 ) {

		if ( ! g.center ) return;
		let best = 0, bd = Infinity;
		this.safe.forEach( ( s, k ) => {

			const d = dist( g.center, s.p ) + ( segDist( ...this.mid, ...g.center, ...s.p ) < 20 ? 400 : 0 );
			if ( d < bd ) { bd = d; best = k; }

		} );
		g.evac = best;
		g.home = true;
		this.world.setLayer( g, this.safe[ best ].layer );
		this.world.setMode( [ g ], MODE.MARCH, { speed } );

	}

	// panic: whichever way out lies straight away from the guns
	radial( c ) {

		let best = 0, bs = Infinity;
		const ax = c[ 0 ] - this.mid[ 0 ], ay = c[ 1 ] - this.mid[ 1 ], al = Math.hypot( ax, ay ) || 1;
		this.safe.forEach( ( s, k ) => {

			const dx = s.p[ 0 ] - c[ 0 ], dy = s.p[ 1 ] - c[ 1 ], d = Math.hypot( dx, dy ) || 1;
			const score = d * ( 1.6 - ( dx * ax + dy * ay ) / ( d * al ) );
			if ( score < bs ) { bs = score; best = k; }

		} );
		return best;

	}

	commands() {

		return [ ...this.policeCommands(), { key: 'b', label: 'Order to leave', resource: 'order',
			desc: 'loudspeaker over the crowd at the cursor (70 m). Before the alarm a lawful demonstration mostly ignores it and it costs opinion; after it, everyone within 90 m hurries off to the nearest way out the guns cannot see',
			run: ( x, y ) => this.order( x, y ) } ];

	}

	order( x, y ) {

		if ( ! this.spend( 'order' ) ) return;
		if ( ! this.alertAt ) {

			const home = this.dispersal( x, y, 70, { calm: 0.08, chance: 0.12 } );
			this.nudgeOpinion( - 2, 'ordering a lawful demonstration away' );
			this.event( home ? `Order to leave: ~${home} people go` : 'Order to leave: the demonstration stays. It is lawful and peaceful', home ? 'good' : 'warn', [ x, y ] );
			return;

		}

		this.game.sound?.dispersal( [ x, y ] );
		let n = 0;
		for ( const g of [ ...this.civilians(), ...this.world.groupsOf( FACTION.BYSTANDER ) ] ) {

			if ( ! g.center || dist( g.center, [ x, y ] ) > 90 || g.mode === MODE.PANIC || g === this.antifa ) continue;
			this.evacuate( g );
			n += g.alive ?? 0;

		}

		this.event( n ? `Evacuation: ~${n} people leave by the side streets` : 'Nobody to evacuate there', n ? 'good' : 'info', [ x, y ] );

	}

	// ---------------------------------------------------------------- the guns
	faceOut( x, y ) {

		let best = Infinity, n = [ 1, 0 ];
		for ( let k = 1; k < EMB_FENCE.length; k ++ ) {

			const [ ax, ay ] = EMB_FENCE[ k - 1 ], [ bx, by ] = EMB_FENCE[ k ];
			const d = segDist( x, y, ax, ay, bx, by ), l = Math.hypot( bx - ax, by - ay );
			if ( d < best ) { best = d; n = [ - ( by - ay ) / l, ( bx - ax ) / l ]; }

		}

		if ( inPoly( EMB_YARD, x + n[ 0 ] * ( best + 3 ), y + n[ 1 ] * ( best + 3 ) ) ) n = [ - n[ 0 ], - n[ 1 ] ];
		return Math.atan2( n[ 1 ], n[ 0 ] );

	}

	rawSdf( x, y ) {

		const { w, h } = this.city.sdf, ix = Math.floor( x - this.city.bounds[ 0 ] ), iy = Math.floor( y - this.city.bounds[ 1 ] );
		return ix < 0 || iy < 0 || ix >= w || iy >= h ? - 1 : this.city.sdfRaw[ iy * w + ix ] / 10;

	}

	// how far a round from the gun travels along angle a before a building stops it
	reach( G, a, max = GUN_RANGE ) {

		const dx = Math.cos( a ), dy = Math.sin( a );
		for ( let s = 2; s < max; s += 0.5 ) if ( this.rawSdf( G.x + dx * s, G.y + dy * s ) < 0 ) return s;
		return max;

	}

	sees( G, x, y ) {

		const d = Math.hypot( x - G.x, y - G.y ), a = Math.atan2( y - G.y, x - G.x );
		return d <= GUN_RANGE && Math.abs( angDiff( a, G.face ) ) <= GUN_ARC && this.reach( G, a, d ) >= d - 0.5;

	}

	// the gun's field of fire as a polygon, for the overlay
	fan( G ) {

		const pts = [ [ G.x, G.y ] ];
		for ( let a = - GUN_ARC; a <= GUN_ARC + 1e-6; a += Math.PI / 360 ) {

			const d = this.reach( G, G.face + a );
			pts.push( [ G.x + Math.cos( G.face + a ) * d, G.y + Math.sin( G.face + a ) * d ] );

		}

		return pts;

	}

	// which 4 m cells either gun can see (counting who is in the line of fire, choosing safe spots)
	visGrid() {

		const { w, h, res } = this.city.cost, [ x0, y0 ] = this.city.bounds;
		this.vis = new Uint8Array( w * h );
		for ( const G of this.guns ) {

			const q0 = Math.floor( ( G.x - GUN_RANGE - x0 ) / res ), q1 = Math.ceil( ( G.x + GUN_RANGE - x0 ) / res );
			const r0 = Math.floor( ( G.y - GUN_RANGE - y0 ) / res ), r1 = Math.ceil( ( G.y + GUN_RANGE - y0 ) / res );
			for ( let r = Math.max( 0, r0 ); r <= Math.min( h - 1, r1 ); r ++ ) for ( let q = Math.max( 0, q0 ); q <= Math.min( w - 1, q1 ); q ++ ) {

				if ( ! this.vis[ r * w + q ] && this.sees( G, x0 + ( q + 0.5 ) * res, y0 + ( r + 0.5 ) * res ) ) this.vis[ r * w + q ] = 1;

			}

		}

	}

	// in sight of a gun, or within r of a cell that is
	exposed( x, y, r = 0 ) {

		const { w, h, res } = this.city.cost, [ x0, y0 ] = this.city.bounds;
		const R = Math.ceil( r / res ), q = Math.floor( ( x - x0 ) / res ), rr = Math.floor( ( y - y0 ) / res );
		for ( let j = rr - R; j <= rr + R; j ++ ) for ( let i = q - R; i <= q + R; i ++ ) if ( i >= 0 && j >= 0 && i < w && j < h && this.vis[ j * w + i ] ) return true;
		return false;

	}

	// once per readback: who stands where each gun can reach (by angle, for the rounds), who is in the line of fire
	perIntel( I ) {

		const n = this.crowd.count;
		for ( const G of this.guns ) G.cand = [];
		let inFire = 0;
		for ( let i = 0; i < n; i ++ ) {

			const f = I.st[ i * 4 ];
			if ( f < 0 || f > 3.5 || this.hit.has( i ) ) continue;
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
			if ( ! this.exposed( x, y ) ) continue;
			if ( f !== FACTION.BYSTANDER || dist( [ x, y ], this.mid ) < 120 ) inFire ++;
			for ( const G of this.guns ) if ( ( x - G.x ) ** 2 + ( y - G.y ) ** 2 < GUN_RANGE * GUN_RANGE ) G.cand.push( i, x, y );

		}

		this.inFire = inFire;
		this.peakFire = Math.max( this.peakFire ?? 0, inFire );

	}

	// each gun sweeps left and right across the nearest group it can see, FIRE_RATE rounds a second
	shoot( dt ) {

		const W = this.world, I = W.intel;
		if ( ! I || ! this.guns[ 0 ].cand ) return;
		for ( const G of this.guns ) {

			if ( this.t >= G.retarget || ! G.target || ! ( G.target.alive > 0 ) ) {

				G.retarget = this.t + 1.5;
				let best = null, bd = Infinity;
				for ( const g of W.groups ) {

					if ( ! g.center || ! ( g.alive > 0 ) ) continue;
					const d = dist( g.center, [ G.x, G.y ] );
					if ( d < bd && this.sees( G, ...g.center ) ) { bd = d; best = g; }

				}

				G.target = best;

			}

			G.phase += dt * 2.6;
			if ( G.target ) {

				const [ cx, cy ] = G.target.center, d = Math.max( 4, dist( G.target.center, [ G.x, G.y ] ) );
				const amp = Math.min( 0.26, Math.max( 0.07, Math.atan2( Math.sqrt( G.target.alive ) * 0.5 + 2, d ) ) );
				G.ang = Math.atan2( cy - G.y, cx - G.x ) + Math.sin( G.phase ) * amp;

			} else G.ang = G.face + Math.sin( G.phase * 0.4 ) * GUN_ARC;

			G.ang = G.face + Math.max( - GUN_ARC, Math.min( GUN_ARC, angDiff( G.ang, G.face ) ) );
			G.acc += dt * FIRE_RATE;
			while ( G.acc >= 1 ) { G.acc --; this.round( G, G.ang + gauss() * SPREAD ); }

		}

	}

	round( G, a ) {

		const I = this.world.intel, dx = Math.cos( a ), dy = Math.sin( a ), C = G.cand;
		const wall = this.reach( G, a );
		const inLine = [];
		for ( let k = 0; k < C.length; k += 3 ) {

			const rx = C[ k + 1 ] - G.x, ry = C[ k + 2 ] - G.y, along = rx * dx + ry * dy;
			if ( along < 2 || along > wall || Math.abs( rx * dy - ry * dx ) > HIT_W ) continue;
			inLine.push( [ along, C[ k ] ] );

		}

		inLine.sort( ( p, q ) => p[ 0 ] - q[ 0 ] );
		let end = wall;
		for ( const [ along, i ] of inLine ) {

			if ( this.hit.has( i ) ) continue;
			const f = I.st[ i * 4 ] % 10;
			this.hit.add( i );
			this.crowd.setFaction( i, ( Math.random() < KILL_P ? 30 : 20 ) + f );
			end = along;
			if ( Math.random() > PASS_P ) break;
			end = wall;

		}

		const now = performance.now();
		this.tracers.push( { a: [ G.x + dx * 1.5, G.y + dy * 1.5 ], b: [ G.x + dx * end, G.y + dy * end ], t: now, hit: end < wall } );
		G.flashAt = now;
		if ( Math.random() < 0.6 ) this.game.sound?.round( [ G.x, G.y ] );

	}

	// ---------------------------------------------------------------- per frame
	tick( dt ) {

		const W = this.world, I = W.intel;
		if ( this.stats ) { this.dead = this.stats[ STAT.KILLED ]; this.deadPolice = this.stats[ STAT.KILLED_POLICE ]; }
		if ( I && I !== this._intel ) { this._intel = I; this.perIntel( I ); }
		if ( this.firing ) this.shoot( dt );

		const A = this.antifa;
		if ( A && ! this.alertAt && A.center && dist( A.center, EMB_BREACH ) < 15 ) {

			this.event( 'The AntiFa squad is at the fence, climbing it', 'bad', EMB_BREACH );
			this.alert();

		}

		for ( const m of [ 25, 50, 100 ] ) if ( this.dead >= m && ! this.flags[ 'dead' + m ] ) { this.flags[ 'dead' + m ] = true; this.event( `${m} dead`, 'bad', this.mid ); }

	}

	opinionWeights() {

		return { injByPolice: - 0.5, injPolice: 0.1, arrested: - 0.05, arrestedSitters: 0, injOther: - 0.1 };

	}

	phase() {

		if ( this.firing ) return `FIRING · ${fmt( FIRE_FOR - ( this.t - this.fireAt ) )} · ${this.dead} dead`;
		if ( this.breached ) return `Cease fire · ${this.dead} dead`;
		if ( this.alertAt ) return `ALERT · the fence gives way in ${fmt( BREACH_AFTER - ( this.t - this.alertAt ) )} · ${this.inFire} in the line of fire`;
		if ( this.antifa ) return `AntiFa pushing for the fence · ${this.antifa.center ? Math.round( dist( this.antifa.center, EMB_BREACH ) ) + ' m' : ''}`;
		return `Peaceful demonstration · ${this.zone( 0 )} in front of the embassy`;

	}

	objectives() {

		const d = this.dead;
		return [
			{ label: 'Dead (fail at 100)', value: d / DEAD_MAX, text: `${d}${this.deadPolice ? ` · ${this.deadPolice} officers` : ''}`, state: d >= DEAD_MAX ? 'bad' : d >= 50 ? 'warn' : this.breached ? 'done' : 'ok', invert: true },
			{ label: 'In the line of fire', value: Math.min( 1, this.inFire / 1500 ), text: `${this.inFire}`, state: this.inFire > 300 ? 'bad' : this.inFire > 60 ? 'warn' : 'ok', invert: true },
			{ label: 'In front of the embassy', value: Math.min( 1, this.zone( 0 ) / 3000 ), text: `${this.zone( 0 )}`, state: this.alertAt && this.zone( 0 ) > 200 ? 'warn' : 'ok', invert: true },
		];

	}

	score( win ) {

		const d = this.dead;
		const stars = ! win ? 0 : 1 + ( d < 50 ) + ( d < 25 && this.deadPolice === 0 );
		return { stars, lines: [ [ 'Dead', d ], [ 'Officers killed', this.deadPolice ], [ 'Wounded', this.counters.injOther + this.counters.injByPolice ],
			[ 'In the line of fire at the breach', this.atBreach ?? 0 ], [ 'Most in the line of fire', this.peakFire ?? 0 ],
			[ 'Arrests', this.counters.arrested ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const ctx = o.ctx, now = performance.now();
		const path = ( pts ) => { ctx.beginPath(); pts.forEach( ( p, k ) => { const [ x, y ] = o.toScreen( ...p ); k ? ctx.lineTo( x, y ) : ctx.moveTo( x, y ); } ); };
		// fields of fire: faint until the guns are uncovered
		for ( const G of this.guns ) {

			path( G.fan );
			ctx.closePath();
			ctx.fillStyle = `rgba(255,45,85,${this.alertAt ? ( this.firing ? 0.12 : 0.08 ) : 0.025})`;
			ctx.fill();
			if ( this.alertAt ) { ctx.setLineDash( [ 5, 6 ] ); ctx.strokeStyle = 'rgba(255,45,85,0.45)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash( [] ); }

		}

		// the fence, with its gap once breached
		ctx.strokeStyle = 'rgba(160,200,255,0.75)';
		ctx.lineWidth = Math.max( 1.5, 0.6 / o.mpp );
		ctx.beginPath();
		let pen = false;
		for ( let k = 1; k < EMB_FENCE.length; k ++ ) {

			const [ ax, ay ] = EMB_FENCE[ k - 1 ], [ bx, by ] = EMB_FENCE[ k ], l = Math.hypot( bx - ax, by - ay );
			for ( let s = 0; s <= l; s += 1 ) {

				const p = [ ax + ( bx - ax ) * s / l, ay + ( by - ay ) * s / l ];
				if ( this.breached && dist( p, EMB_BREACH ) < 3.2 ) { pen = false; continue; }
				const [ x, y ] = o.toScreen( ...p );
				pen ? ctx.lineTo( x, y ) : ctx.moveTo( x, y );
				pen = true;

			}

		}

		ctx.stroke();
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		if ( this.alertAt && ! this.breached ) {

			const [ x, y ] = o.toScreen( ...EMB_BREACH );
			for ( let k = 0; k < 4; k ++ ) { ctx.fillStyle = `rgba(255,${180 + Math.random() * 70},90,0.9)`; ctx.fillRect( x + ( Math.random() - 0.5 ) * 10, y + ( Math.random() - 0.5 ) * 10, 2, 2 ); }

		}

		// the posts: covered (grey) until the alert, then green; muzzle flashes while firing
		for ( const G of this.guns ) {

			const [ x, y ] = o.toScreen( G.x, G.y );
			if ( this.alertAt ) {

				const glow = ctx.createRadialGradient( x, y, 0, x, y, 14 );
				glow.addColorStop( 0, 'rgba(80,255,120,0.55)' );
				glow.addColorStop( 1, 'rgba(80,255,120,0)' );
				ctx.fillStyle = glow;
				ctx.beginPath(); ctx.arc( x, y, 14, 0, Math.PI * 2 ); ctx.fill();
				ctx.fillStyle = GREEN;
				ctx.beginPath(); ctx.arc( x, y, 4.5, 0, Math.PI * 2 ); ctx.fill();
				// the barrel
				ctx.strokeStyle = GREEN;
				ctx.lineWidth = 2;
				ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( x + Math.cos( G.ang ) * 11, y - Math.sin( G.ang ) * 11 ); ctx.stroke();

			} else {

				ctx.fillStyle = 'rgba(160,170,185,0.7)';
				ctx.fillRect( x - 3.5, y - 3.5, 7, 7 );

			}

			if ( this.firing && now - ( G.flashAt ?? 0 ) < 70 ) {

				const r = 8 + Math.random() * 10, fx = x + Math.cos( G.ang ) * 8, fy = y - Math.sin( G.ang ) * 8;
				const g = ctx.createRadialGradient( fx, fy, 0, fx, fy, r );
				g.addColorStop( 0, 'rgba(255,250,210,1)' );
				g.addColorStop( 0.4, 'rgba(255,200,80,0.8)' );
				g.addColorStop( 1, 'rgba(255,140,40,0)' );
				ctx.fillStyle = g;
				ctx.beginPath(); ctx.arc( fx, fy, r, 0, Math.PI * 2 ); ctx.fill();

			}

		}

		if ( ! this.alertAt ) { const [ x, y ] = o.toScreen( ...this.mid ); ctx.fillStyle = 'rgba(160,170,185,0.8)'; ctx.fillText( 'MARINE GUARD POSTS', x - 34, y + 3 ); }
		else if ( ! this.breached ) { const [ x, y ] = o.toScreen( ...this.mid ); ctx.fillStyle = GREEN; ctx.fillText( 'GUNS UNCOVERED', x - 34, y + 3 ); }

		// tracers and hits
		this.tracers = this.tracers.filter( ( s ) => now - s.t < 110 );
		ctx.lineWidth = 1.6;
		for ( const s of this.tracers ) {

			const k = ( now - s.t ) / 110, [ ax, ay ] = o.toScreen( ...s.a ), [ bx, by ] = o.toScreen( ...s.b );
			ctx.strokeStyle = `rgba(255,236,170,${0.95 * ( 1 - k )})`;
			ctx.beginPath(); ctx.moveTo( ax, ay ); ctx.lineTo( bx, by ); ctx.stroke();
			if ( s.hit ) { ctx.fillStyle = `rgba(255,45,85,${1 - k})`; ctx.beginPath(); ctx.arc( bx, by, 3 + k * 4, 0, Math.PI * 2 ); ctx.fill(); }

		}

		// the strobe: irregular white flares, never more than ~3 a second (real time, whatever the game speed);
		// gentler and slower for people who asked their system for reduced motion
		if ( this.firing && ! this.game.paused && now >= ( this.nextFlash ?? 0 ) ) {

			const calm = matchMedia( '(prefers-reduced-motion: reduce)' ).matches;
			this.game.flash( calm ? rand( 0.1, 0.18 ) : rand( 0.35, 0.75 ) );
			this.nextFlash = now + ( calm ? rand( 1000, 1600 ) : rand( 340, 650 ) );

		}

	}

}

const dist = ( a, b ) => Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ] );
const angDiff = ( a, b ) => Math.atan2( Math.sin( a - b ), Math.cos( a - b ) );
const gauss = () => Math.sqrt( - 2 * Math.log( 1 - Math.random() ) ) * Math.cos( 2 * Math.PI * Math.random() );
const P = ( W, name ) => W.places[ name ];

function segDist( x, y, ax, ay, bx, by ) {

	const dx = bx - ax, dy = by - ay;
	const t = Math.max( 0, Math.min( 1, ( ( x - ax ) * dx + ( y - ay ) * dy ) / ( dx * dx + dy * dy || 1 ) ) );
	return Math.hypot( x - ax - t * dx, y - ay - t * dy );

}
