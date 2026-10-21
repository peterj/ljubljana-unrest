// The missions. Each one: a briefing, a timeline (waves announced ahead of time so the player can
// prepare), live objectives with clear fail states, and a 1–3 star result.
import { Mission, World, FACTION, MODE, ROLE, STAT, ZONE, fmt, rand, pick } from './mission.js';
import { Convoy } from './convoy.js';
import { WATER_RANGE } from '../sim/world.js';

const ORANGE = 'rgb(255,106,16)', BLUE = 'rgb(43,140,255)', WHITE = 'rgb(233,228,216)', RED = 'rgb(255,45,85)', LIME = 'rgb(154,214,42)';

// shared: spawn a numbered set of police squads at positions
async function squads( world, list, n = 24 ) {

	const out = [];
	for ( const [ x, y ] of list ) out.push( await world.squad( { kind: 'squad', label: `Squad ${world.groups.filter( ( g ) => g.faction === FACTION.POLICE ).length + 1}`, at: [ x, y ], n } ) );
	return out;

}

// shared: patrol cars (each with a small crew squad) parked at positions
async function cars( world, list, opts = {} ) {

	const out = [];
	for ( const at of list ) out.push( await world.patrols.add( { at, ...opts } ) );
	return out;

}

function ringDist( r, x, y ) {

	let best = Infinity;
	for ( let k = 0; k < r.length; k += 2 ) {

		const ax = r[ k ], ay = r[ k + 1 ], bx = r[ ( k + 2 ) % r.length ], by = r[ ( k + 3 ) % r.length ];
		const dx = bx - ax, dy = by - ay;
		const t = Math.max( 0, Math.min( 1, ( ( x - ax ) * dx + ( y - ay ) * dy ) / ( dx * dx + dy * dy || 1 ) ) );
		best = Math.min( best, Math.hypot( x - ax - t * dx, y - ay - t * dy ) );

	}

	return best;

}

function inPoly( r, x, y ) {

	let inside = false;
	for ( let k = 0, j = r.length - 2; k < r.length; j = k, k += 2 ) {

		const ax = r[ k ], ay = r[ k + 1 ], bx = r[ j ], by = r[ j + 1 ];
		if ( ( ay > y ) !== ( by > y ) && x < ( bx - ax ) * ( y - ay ) / ( by - ay ) + ax ) inside = ! inside;

	}

	return inside;

}

const near = ( a, b, r ) => ( a[ 0 ] - b[ 0 ] ) ** 2 + ( a[ 1 ] - b[ 1 ] ) ** 2 < r * r;

// ======================================================================================= CONVOY
export class ConvoyMission extends Mission {

	static id = 'convoy';
	static title = 'Convoy';
	static subtitle = 'Escort the VIP convoy from Celovška to the National Assembly';
	static side = 'police';
	static brief = `A foreign head of state lands at Brnik and is driven to the National Assembly. Word has spread:
		protesters are gathering along <b>Celovška</b>, at <b>Bavarski dvor</b> and on <b>Župančičeva</b>. The convoy will not
		stop for anyone. If it is boxed in, the VIP is in danger.`;
	static goals = [ 'Get the convoy to the Assembly', 'Keep the VIP car intact', 'Avoid injuring people — the cameras are watching' ];
	static tips = [ 'You have 1:15 before departure — put squads where the hotspots are', 'Right-drag a cordon line along the road to keep crowds off it',
		'Patrol cars drive ahead fast and park as roadblocks — their crews get out (U)',
		'Leaders appear as rings under CCTV coverage — Snatch (X) them to break a group up', 'V departs early' ];

	async setup() {

		const city = this.city, W = this.world;
		await W.exits();
		this.convoy = new Convoy( city.route );
		this.game.scene.add( this.convoy.group );
		const C = this.convoy;
		this.departAt = 75;
		this.focus = [ C.at( C.length * 0.3 ).x, C.at( C.length * 0.3 ).y ];
		this.zoom = 1.1;
		this.resources = { gas: { left: 3, max: 3 }, water: { left: 3, max: 3 }, reinforce: { left: 2, max: 2 } };
		this.waterOpinion = - 2;

		// hotspots: crowds waiting beside the route, they surge onto it when the convoy approaches
		this.hotspots = [];
		const spots = [ [ 0.3, 'Celovška', 520 ], [ 0.6, 'Bavarski dvor', 800 ], [ 0.86, 'Župančičeva', 1000 ] ];
		for ( const [ f, name, n ] of spots ) {

			const s = f * C.length;
			const p = C.at( s );
			const side = Math.random() < 0.5 ? 1 : - 1;
			const at = W.spot( p.x + Math.cos( p.heading + side * Math.PI / 2 ) * 30, p.y + Math.sin( p.heading + side * Math.PI / 2 ) * 30, 15 );
			const L = await W.fieldTo( p.x, p.y, 10 );
			const groups = await W.bloc( { kind: 'hotspot', label: name, at, n, groupSize: 80, spread: 25, layer: L, mode: MODE.HOLD, agitation: [ 0.15, 0.4 ] } );
			// Friday cyclists ride along Celovška to block the road
			if ( name === 'Celovška' ) groups.push( ...await W.bloc( { kind: 'hotspot', label: 'Cyclists', at: W.spot( at[ 0 ], at[ 1 ], 20 ), n: 220, groupSize: 55, spread: 15, layer: L, mode: MODE.HOLD, agitation: [ 0.2, 0.45 ], bikes: 1 } ) );
			this.hotspots.push( { name, s, pos: [ p.x, p.y ], groups, active: false } );

		}

		// a small radical cell hidden off the route in Tivoli — they go for the car when it passes
		const pr = C.at( 0.45 * C.length );
		await W.bloc( { kind: 'radicals', label: 'Radical cell', at: W.spot( pr.x - 60, pr.y - 30, 30 ), n: 120, groupSize: 40, spread: 15, mode: MODE.HOLD, agitation: [ 0.55, 0.8 ], morale: 0.9 } );
		// and a standing crowd at the destination
		const sq = W.places[ 'Trg republike' ];
		await W.bloc( { kind: 'crowd', label: 'Trg republike crowd', at: sq, n: 1400, groupSize: 100, spread: 45, goal: sq, goalR: 40, mode: MODE.HOLD, agitation: [ 0.1, 0.35 ] } );

		// police: escort at the start, a mid-route detachment, a reception at the Assembly
		const start = C.at( 30 ), mid = C.at( C.length * 0.55 ), end = C.at( C.length - 40 );
		await squads( W, [ [ start.x + 12, start.y ], [ start.x - 12, start.y ], [ start.x, start.y + 15 ] ] );
		await squads( W, [ [ mid.x + 15, mid.y ], [ mid.x - 15, mid.y ], [ mid.x, mid.y - 15 ] ] );
		await squads( W, [ [ end.x + 15, end.y ], [ end.x - 15, end.y ], [ end.x, end.y + 15 ], [ end.x, end.y - 15 ] ] );
		const ahead = C.at( 70 ), late = C.at( C.length * 0.75 );
		await cars( W, [ [ ahead.x, ahead.y ], [ mid.x, mid.y ], [ late.x, late.y ] ] );
		// the water cannon waits on the route between Tivoli and Bavarski dvor (the middle of the trouble)
		const wc = C.at( C.length * 0.5 );
		await W.patrols.add( { at: [ wc.x, wc.y ], water: true } );
		await this.bystanders( 2200 );

	}

	start() {

		this.event( 'Convoy departs in 1:15. Position your squads along the route.', 'info', this.convoy.route[ 0 ] );

	}

	depart() {

		if ( this.convoy.moving ) return;
		this.convoy.moving = true;
		this.departedAt = this.t;
		this.event( 'Convoy is moving', 'good', this.convoy.route[ 0 ] );

	}

	commands() {

		return [ ...this.policeCommands(), { key: 'v', label: 'Depart now', run: () => this.depart(), hide: () => this.convoy.moving } ];

	}

	tick( dt ) {

		const C = this.convoy;
		if ( ! C.moving && this.t >= this.departAt ) this.depart();
		C.update( dt, this.stats );
		this.world.convoyVehicles = C.vehicles();

		for ( const h of this.hotspots ) {

			if ( ! h.active && C.s > h.s - 320 ) {

				h.active = true;
				this.world.setMode( h.groups, MODE.MARCH );
				for ( const g of h.groups ) for ( const i of g.members ) this.crowd.nudge( i, 0.2, 0 );
				this.event( `${h.name}: the crowd is surging onto the road!`, 'bad', h.pos );

			}

		}

		const lead = C.poses[ 0 ];
		if ( C.moving && C.speed < 0.5 && ! C.arrived ) {

			if ( ! this.flags.halted ) { this.flags.halted = true; this.event( 'Convoy HALTED — road blocked ahead', 'bad', [ lead.x, lead.y ] ); }

		} else this.flags.halted = false;

		if ( C.attackers > 0.5 && this.t - ( this.flags.attackMsg ?? - 99 ) > 8 ) {

			this.flags.attackMsg = this.t;
			this.event( 'VIP car under attack!', 'bad', [ C.poses[ C.vip ].x, C.poses[ C.vip ].y ] );

		}

		for ( const m of [ 0.75, 0.5, 0.25 ] ) {

			if ( C.integrity < m && ! this.flags[ 'int' + m ] ) { this.flags[ 'int' + m ] = true; this.event( `VIP car integrity ${m * 100}%`, 'bad' ); }

		}

		if ( C.integrity <= 0 ) this.end( false, 'The VIP car was overrun.' );
		else if ( C.blockedFor > 75 ) this.end( false, 'The convoy was stuck for too long — the VIP was evacuated by helicopter.' );
		else if ( C.arrived ) this.end( true, 'The VIP arrived at the National Assembly.' );

	}

	get travel() { return this.departedAt !== undefined ? this.t - this.departedAt : 0; }

	phase() {

		const C = this.convoy;
		if ( ! C.moving ) return `Convoy departs in ${fmt( this.departAt - this.t )} — press V to go now`;
		if ( C.speed < 0.5 ) return `CONVOY HALTED · ${fmt( C.blockedFor )} / 1:15`;
		return `Convoy moving · ${Math.round( C.speed * 3.6 )} km/h · ${C.blockers} on the road ahead`;

	}

	objectives() {

		const C = this.convoy, inj = this.counters.injByPolice;
		return [
			{ label: 'Convoy reaches the Assembly', value: C.progress, text: `${Math.round( C.progress * 100 )}%`, state: C.arrived ? 'done' : C.speed < 0.5 && C.moving ? 'warn' : 'ok' },
			{ label: 'VIP car integrity', value: C.integrity, text: `${Math.round( C.integrity * 100 )}%`, state: C.integrity < 0.35 ? 'bad' : C.integrity < 0.7 ? 'warn' : 'ok' },
			{ label: '★ Arrive within 6:00 of departure', value: Math.min( 1, this.travel / 360 ), text: fmt( this.travel ), state: this.travel > 360 ? 'bad' : 'ok', invert: true },
			{ label: '★ Injuries caused by police ≤ 15', value: Math.min( 1, inj / 15 ), text: `${inj}`, state: inj > 15 ? 'bad' : inj > 10 ? 'warn' : 'ok', invert: true },
		];

	}

	score( win ) {

		const C = this.convoy;
		const s1 = win, s2 = win && C.integrity >= 0.6 && this.travel <= 360, s3 = win && this.counters.injByPolice <= 15;
		return { stars: s1 + s2 + s3, lines: [
			[ 'VIP car integrity', `${Math.round( C.integrity * 100 )}%` ], [ 'Travel time', fmt( this.travel ) ],
			[ 'Injuries caused by police', this.counters.injByPolice ], [ 'Officers injured', this.counters.injPolice ],
			[ 'Arrests', this.counters.arrested ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const C = this.convoy, ctx = o.ctx;
		ctx.lineWidth = 2;
		const path = ( a, b ) => {

			ctx.beginPath();
			for ( let s = a; s <= b; s += 8 ) {

				const p = C.at( s );
				const [ x, y ] = o.toScreen( p.x, p.y );
				s === a ? ctx.moveTo( x, y ) : ctx.lineTo( x, y );

			}

			ctx.stroke();

		};

		ctx.strokeStyle = 'rgba(233,228,216,0.75)';
		path( 0, C.s );
		ctx.setLineDash( [ 8, 8 ] );
		ctx.strokeStyle = 'rgba(43,140,255,0.6)';
		path( C.s, C.length );
		ctx.setLineDash( [] );
		for ( const h of this.hotspots ) this.drawZone( o, h.pos[ 0 ], h.pos[ 1 ], 30, h.active ? RED : ORANGE, h.active ? `${h.name} ⚠` : h.name );
		const end = C.at( C.length );
		this.drawZone( o, end.x, end.y, 12, WHITE, 'ASSEMBLY', 0.12 );

	}

}

// ======================================================================================= DEFEND
const DEFEND_OUTRAGE = { c: [ 45, 0.2, 'Baton charge' ], k: [ 50, 0.25, 'Kettle' ], g: [ 60, 0.25, 'Tear gas' ], w: [ 50, 0.2, 'Water cannon' ], a: [ 35, 0.12, 'Arrests' ], x: [ 35, 0.12, 'Snatch squad' ], s: [ 40, 0.15, 'Shield push' ] };

class DefendMission extends Mission {

	static side = 'police';
	static target = 'Državni zbor';
	static waves = [];
	static exitAt = {};	// exit index → hand-placed spot (local m), used as is: not pushed out from the façade

	async setup() {

		const base = this.city.targets[ this.constructor.target ];
		// evacuation exits that hug the building (Vlada's are 6–10 m off the façade) are pushed out to
		// 20 m along their street, otherwise any crowd pressing on a façade cordon also "blocks" them
		const W = this.world, rings = base.poly.map( ( p ) => p[ 0 ] );
		const T = { ...base, exits: base.exits.map( ( e, k ) => {

			const at = this.constructor.exitAt[ k ];
			if ( at ) return W.patrols.snap( ...at ) ?? at;
			let dx = e[ 0 ] - base.pos[ 0 ], dy = e[ 1 ] - base.pos[ 1 ];
			const l = Math.hypot( dx, dy ) || 1; dx /= l; dy /= l;
			let p = e;
			for ( let d = 0; d < 40 && Math.min( ...rings.map( ( r ) => ringDist( r, ...p ) ) ) < 20; d += 2 ) p = [ e[ 0 ] + dx * d, e[ 1 ] + dy * d ];
			return W.patrols.snap( ...p ) ?? p;

		} ) };
		this.T = T;
		this.focus = T.pos;
		this.zoom = 0.55;
		await W.exits();
		this.duration = 12 * 60;
		this.breach = 0;
		this.evac = 0;
		this.resources = { gas: { left: 4, max: 4 }, water: { left: 4, max: 4 }, reinforce: { left: 3, max: 3 } };
		this.waterOpinion = - 2;
		// zone 0: facade pressure; zones 1..n: exits
		this.setZones( [ { x: T.pos[ 0 ], y: T.pos[ 1 ], r: T.radius + 10, type: ZONE.PROT_FACADE },
			...T.exits.map( ( e ) => ( { x: e[ 0 ], y: e[ 1 ], r: 12, type: ZONE.PROT } ) ) ] );
		// objective points the protest AI chooses between: the four longest façade sides + the exits.
		// Taken from the footprint, not the radius — on a long, narrow building (Vlada) a circle puts
		// the "doors" 20 m out in the street.
		const outer = T.poly[ 0 ][ 0 ], edges = [];
		for ( let k = 0; k < outer.length; k += 2 ) {

			const ax = outer[ k ], ay = outer[ k + 1 ], bx = outer[ ( k + 2 ) % outer.length ], by = outer[ ( k + 3 ) % outer.length ];
			edges.push( { len: Math.hypot( bx - ax, by - ay ), mx: ( ax + bx ) / 2, my: ( ay + by ) / 2 } );

		}

		this.targets = edges.sort( ( a, b ) => b.len - a.len ).slice( 0, 4 ).map( ( e ) => {

			const dx = e.mx - T.pos[ 0 ], dy = e.my - T.pos[ 1 ], l = Math.hypot( dx, dy ) || 1;
			return W.spot( e.mx + dx / l * 5, e.my + dy / l * 5, 4 );

		} ).concat( T.exits );

		// starting ring: 14 m off the footprint in six directions (a circle around a long building
		// leaves a 30 m buffer off its long sides that no passive crowd ever crosses)
		const ring = [ 0, 1, 2, 3, 4, 5 ].map( ( k ) => {

			const a = k / 6 * Math.PI * 2, c = Math.cos( a ), s = Math.sin( a );
			let r = 0;
			while ( r < T.radius * 2 && inPoly( outer, T.pos[ 0 ] + c * r, T.pos[ 1 ] + s * r ) ) r += 1;
			return W.spot( T.pos[ 0 ] + c * ( r + 14 ), T.pos[ 1 ] + s * ( r + 14 ), 8, false );

		} );
		await squads( W, [ ...ring, ...T.exits, ...ring.slice( 0, 3 ) ], 30 );
		// the water cannon truck parks in front of the first exit, the patrol cars take the rest
		await W.patrols.add( { at: T.exits[ 0 ], water: true } );
		await cars( W, [ ...T.exits.slice( 1 ), W.marks[ 'PU Ljubljana' ], W.marks[ 'PU Ljubljana' ] ].slice( 0, 2 ) );
		// calm crowds demonstrate in sight of the building: the nearest open square if there is one close
		// by, otherwise the street in front of it (toward the first wave). Only agitated groups go for
		// doors and exits.
		const dist = ( p ) => Math.hypot( p[ 0 ] - T.pos[ 0 ], p[ 1 ] - T.pos[ 1 ] );
		const square = Object.values( W.places ).filter( ( p ) => dist( p ) > T.radius + 30 && dist( p ) < T.radius + 130 ).sort( ( a, b ) => dist( a ) - dist( b ) )[ 0 ];
		const first = this.constructor.waves[ 0 ], from = first && ( first.at ?? W.places[ first.from ] ?? W.marks[ first.from ] );
		const dir = from ? Math.atan2( from[ 1 ] - T.pos[ 1 ], from[ 0 ] - T.pos[ 0 ] ) : 0;
		this.rallyPoint = square ?? W.spot( T.pos[ 0 ] + Math.cos( dir ) * ( T.radius + 50 ), T.pos[ 1 ] + Math.sin( dir ) * ( T.radius + 50 ), 12 );
		await this.bystanders( 2200 );
		this.waveList = this.constructor.waves.map( ( w ) => ( { ...w } ) );

	}

	start() {

		for ( const w of this.waveList ) {

			this.after( Math.max( 0, w.t - 30 ), () => this.event( `${w.label}: ~${w.n.toLocaleString()} people from ${w.from} in ${fmt( Math.min( 30, w.t ) )}`, 'warn', w.at ?? this.world.places[ w.from ] ?? this.world.marks[ w.from ] ) );
			this.after( w.t, () => this.spawnWave( w ) );

		}

		this.after( 2, () => this.event( 'Hold for 12 minutes. Keep them off the façade and keep the exits open.', 'info', this.T.pos ) );

	}

	async spawnWave( w ) {

		const at = w.at ?? this.world.places[ w.from ] ?? this.world.marks[ w.from ];
		const routes = this.constructor.routes;
		const angry = ! routes && ( w.agitation?.[ 0 ] ?? 0 ) > 0.45;
		w.groups = await this.world.bloc( { kind: 'wave', label: w.label, at, n: w.n, groupSize: 100, spread: routes ? 35 : 50,
			goal: angry ? pick( this.targets ) : routes ? routes[ 0 ].legs[ 0 ] : this.rallyPoint, goalR: angry ? 12 : routes ? 12 : 35,
			agitation: w.agitation ?? [ 0.1, 0.35 ], morale: w.morale ?? 0.55, bikes: w.bikes ?? 0 } );
		w.spawned = true;
		for ( const g of w.groups ) { g.goalKind = angry ? 'target' : 'rally'; g.committedAt = angry ? this.t : undefined; }
		if ( routes ) {

			// the wave splits into columns, each along its own street to the building
			w.groups.forEach( ( g, k ) => { g.route = routes[ k % routes.length ]; g.leg = 0; g.goalKind = 'route'; } );
			for ( const r of routes ) this.world.march( w.groups.filter( ( g ) => g.route === r ), ...r.legs[ 0 ], 12 );
			this.event( `${w.label} set off from ${w.from} by ${routes.map( ( r ) => r.name ).join( ' and ' )}`, 'bad', at );
			return;

		}

		this.event( `${w.label} ${angry ? 'are heading straight for the building!' : 'are marching to the square'}`, angry ? 'bad' : 'warn', at );

	}

	commands() {

		if ( ! this.constructor.outrage ) return this.policeCommands();
		// an angry crowd: any force used near it winds up every group around it
		return this.policeCommands().map( ( c ) => {

			const o = DEFEND_OUTRAGE[ c.key ];
			if ( ! o ) return c;
			return { ...c, run: ( x, y ) => {

				const left = c.resource ? this.resources[ c.resource ].left : 0;
				const r = c.run( x, y );
				if ( ! c.resource || this.resources[ c.resource ].left < left ) this.outrage( x, y, ...o );
				return r;

			} };

		} );

	}

	outrage( x, y, r, d, why ) {

		let n = 0;
		for ( const g of this.world.groupsOf( FACTION.PROTESTER ) ) {

			if ( ! g.center || ! near( g.center, [ x, y ], r ) ) continue;
			for ( const i of g.members ) this.crowd.nudge( i, d, 0 );
			if ( g.goalKind !== 'route' && g.mode !== MODE.RIOT && d >= 0.2 ) this.world.setMode( [ g ], MODE.RIOT );
			n += g.alive ?? 0;

		}

		if ( n > 50 && this.t - ( this.flags.outrageMsg ?? - 99 ) > 10 ) {

			this.flags.outrageMsg = this.t;
			this.event( `${why}: ~${n} people around it turn on the police`, 'bad', [ x, y ] );

		}

	}

	// once per readback, angry crowds only: a group that sees its own people beaten or detained gets angrier, and so do its neighbours
	hurtCheck( I ) {

		const groups = this.world.groupsOf( FACTION.PROTESTER );
		let worst = null, wn = 0;
		for ( const g of groups ) {

			let hp = 0;
			for ( const i of g.members ) { const f = I.st[ i * 4 ]; if ( ( f > 9.5 && f < 19.5 ) || f === FACTION.ARRESTED ) hp ++; }
			const fresh = hp - ( g.hurtByPolice ?? 0 );
			g.hurtByPolice = hp;
			if ( fresh <= 0 || ! g.center ) continue;
			const d = Math.min( 0.35, 0.1 * fresh );
			for ( const i of g.members ) this.crowd.nudge( i, d, 0.05 );
			for ( const q of groups ) if ( q !== g && q.center && near( q.center, g.center, 50 ) ) for ( const i of q.members ) this.crowd.nudge( i, d / 2, 0 );
			if ( fresh > wn ) { wn = fresh; worst = g; }

		}

		if ( worst && this.t - ( this.flags.hurtMsg ?? - 99 ) > 15 ) {

			this.flags.hurtMsg = this.t;
			this.event( `${worst.label}: they saw their own people beaten — the crowd around them boils over`, 'bad', worst.center );

		}

	}

	tick( dt ) {

		const I = this.world.intel;
		if ( this.constructor.outrage && I && I !== this._hurtIntel ) { this._hurtIntel = I; this.hurtCheck( I ); }

		// marching columns: on to the next leg within 25 m of this one; at the end they rally in front of the building
		for ( const g of this.world.groupsOf( FACTION.PROTESTER ) ) {

			if ( g.goalKind !== 'route' || ! g.center ) continue;
			const legs = g.route.legs;
			if ( ! near( g.center, legs[ g.leg ], 25 ) ) continue;
			if ( ++ g.leg < legs.length ) { this.world.march( [ g ], ...legs[ g.leg ], 12 ); continue; }
			g.goalKind = 'rally';
			g.rally = g.route.rally;
			this.world.march( [ g ], ...g.rally, 25 );

		}

		// protest AI: every 20 s each group heads for the objective point with the fewest officers
		if ( this.t - ( this.flags.ai ?? 0 ) > 20 && this.world.intel ) {

			this.flags.ai = this.t;
			const guard = this.targets.map( ( p ) => this.world.countNear( p[ 0 ], p[ 1 ], 25, FACTION.POLICE ) );
			for ( const g of this.world.groupsOf( FACTION.PROTESTER ) ) {

				if ( g.goalKind === 'route' || Math.random() < 0.5 ) continue;
				// hysteresis: a group heading for the building keeps going for at least 2 minutes (anger cools
				// on a long walk, contact with the line brings it back), then only turns back once it has really
				// cooled down; it mostly sticks to the door it picked
				const committed = g.goalKind === 'target';
				const sticky = committed && this.t - ( g.committedAt ?? - 999 ) < 120;
				if ( ! sticky && g.agitation < ( committed ? 0.25 : 0.45 ) ) {

					if ( g.goalKind !== 'rally' ) { g.goalKind = 'rally'; this.world.march( [ g ], ...( g.rally ?? this.rallyPoint ), g.rally ? 25 : 35 ); }
					continue;

				}

				const riot = g.agitation > 0.65;
				if ( committed && Math.random() < 0.7 ) { if ( riot && g.mode !== MODE.RIOT ) this.world.setMode( [ g ], MODE.RIOT ); continue; }
				if ( ! committed ) { g.committedAt = this.t; this.event( `${g.label}: an angry group is heading for the building`, 'warn', g.center ); }
				g.goalKind = 'target';
				let best = 0, bs = Infinity;
				// weakest door, but weighted by distance: walking round a whole block to the far side stalls in the crowd
				this.targets.forEach( ( p, k ) => { const s = guard[ k ] + Math.hypot( p[ 0 ] - g.center[ 0 ], p[ 1 ] - g.center[ 1 ] ) / 3 + Math.random() * 25; if ( s < bs ) { bs = s; best = k; } } );
				this.world.march( [ g ], ...this.targets[ best ], 10 ).then( () => riot && this.world.setMode( [ g ], MODE.RIOT ) );

			}

		}

		const facade = this.facadeCount();
		// capped: a full breach takes at least 40 s, time to answer with gas, water or reserves
		this.breach = Math.max( 0, Math.min( 1, this.breach + ( facade > 20 ? Math.min( 0.025, ( facade - 20 ) / 2500 ) : - 0.015 ) * dt ) );
		// hysteresis so a crowd hovering at the threshold does not flood the feed
		this.blocked = this.T.exits.map( ( _, k ) => this.zone( 1 + k ) >= ( this.flags[ 'ex' + k ] ? 12 : 20 ) );
		const allBlocked = this.blocked.length && this.blocked.every( Boolean );
		this.evac = Math.max( 0, Math.min( 1, this.evac + ( allBlocked ? dt / 45 : - dt / 90 ) ) );
		this.blocked.forEach( ( b, k ) => {

			if ( b && ! this.flags[ 'ex' + k ] ) this.event( `Exit ${k + 1} blocked!`, 'bad', this.T.exits[ k ] );
			if ( ! b && this.flags[ 'ex' + k ] ) this.event( `Exit ${k + 1} cleared`, 'good', this.T.exits[ k ] );
			this.flags[ 'ex' + k ] = b;

		} );
		if ( this.breach > 0.25 && ! this.flags.b25 ) { this.flags.b25 = true; this.event( 'Protesters are pressing against the doors', 'warn', this.T.pos ); }
		if ( this.breach < 0.1 ) this.flags.b25 = false;
		if ( this.breach > 0.5 && ! this.flags.b50 ) { this.flags.b50 = true; this.event( 'The doors are giving way — push them off the façade!', 'bad', this.T.pos ); }
		if ( this.breach < 0.3 ) this.flags.b50 = false;

		if ( this.breach >= 1 ) this.end( false, `Protesters forced their way into ${this.constructor.short}.` );
		else if ( this.evac >= 1 ) this.end( false, 'Every exit was blocked — the evacuation could not proceed.' );
		else if ( this.t >= this.duration ) this.end( true, `${this.constructor.short} held. The crowd is going home.` );

	}

	// agitated protesters within 3 m of the target's own footprint (a circle would also count the
	// neighbouring buildings and the backs of the police line)
	facadeCount() {

		const I = this.world.intel;
		if ( ! I || I === this._facadeIntel ) return this.facade ?? 0;
		this._facadeIntel = I;
		const rings = this.T.poly.map( ( p ) => p[ 0 ] );
		const [ cx, cy ] = this.T.pos, R = this.T.radius + 40;
		let n = 0;
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER || I.st[ i * 4 + 2 ] < 0.4 ) continue;
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
			if ( ( x - cx ) ** 2 + ( y - cy ) ** 2 > R * R ) continue;
			if ( rings.some( ( r ) => ringDist( r, x, y ) < 3 ) ) n ++;

		}

		this.facade = n;
		return n;

	}

	nextWave() {

		return this.waveList.find( ( w ) => ! w.spawned );

	}

	phase() {

		const w = this.nextWave();
		return w ? `Next: ${w.label} from ${w.from} in ${fmt( w.t - this.t )}` : `Hold out · ${fmt( this.duration - this.t )} left`;

	}

	objectives() {

		const clear = this.blocked ? this.blocked.filter( ( b ) => ! b ).length : this.T.exits.length;
		const inj = this.counters.injByPolice;
		return [
			{ label: 'Hold out for 12:00', value: this.t / this.duration, text: fmt( this.duration - this.t ), state: 'ok' },
			{ label: 'Façade breach', value: this.breach, text: `${this.facade ?? 0} at the doors`, state: this.breach > 0.6 ? 'bad' : this.breach > 0.25 ? 'warn' : 'ok', invert: true },
			{ label: `Exits clear ${clear}/${this.T.exits.length}`, value: this.evac, text: this.evac > 0 ? `evac ${Math.round( this.evac * 100 )}%` : 'open', state: this.evac > 0.5 ? 'bad' : clear < this.T.exits.length ? 'warn' : 'ok', invert: true },
			{ label: '★ Injuries caused by police ≤ 25', value: Math.min( 1, inj / 25 ), text: `${inj}`, state: inj > 25 ? 'bad' : inj > 15 ? 'warn' : 'ok', invert: true },
		];

	}

	score( win ) {

		const s2 = win && this.opinion >= 45, s3 = win && this.counters.injByPolice <= 25;
		return { stars: win + s2 + s3, lines: [
			[ 'Public opinion', Math.round( this.opinion ) ], [ 'Injuries caused by police', this.counters.injByPolice ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Arrests', this.counters.arrested ], [ 'Tear gas used', this.counters.gas ] ] };

	}

	draw( o ) {

		const T = this.T;
		this.drawZone( o, T.pos[ 0 ], T.pos[ 1 ], T.radius + 10, this.breach > 0.3 ? RED : ORANGE, this.constructor.short.toUpperCase(), 0.05 + this.breach * 0.2 );
		T.exits.forEach( ( e, k ) => this.drawZone( o, e[ 0 ], e[ 1 ], 12, this.blocked?.[ k ] ? RED : WHITE, `EXIT ${k + 1}${this.blocked?.[ k ] ? ' ✕' : ''}` ) );
		const w = this.nextWave();
		if ( w && w.t - this.t < 60 ) {

			const at = w.at ?? this.world.places[ w.from ] ?? this.world.marks[ w.from ];
			this.drawZone( o, at[ 0 ], at[ 1 ], 40, ORANGE, `${w.label} · ${fmt( w.t - this.t )}` );

		}

	}

}

export class DefendAssembly extends DefendMission {

	static id = 'defend-assembly';
	static title = 'National Assembly';
	static short = 'the Assembly';
	static subtitle = 'Hold the National Assembly for 12 minutes';
	static target = 'Državni zbor';
	static exitAt = { 1: [ - 404, - 55 ] };	// Šubičeva, in front of the south façade (user's placement)
	static brief = `A controversial law passes its final reading tonight. Unions, students and the Metelkova scene have called
		everyone to <b>Trg republike</b>. Keep the crowd off the doors of the National Assembly and keep at least one evacuation exit open.`;
	static goals = [ 'Survive 12:00', 'Do not let the façade breach meter fill', 'Keep at least one exit open' ];
	static tips = [ 'Waves are announced 30 s ahead — meet them before they reach the square', 'Cordon lines (right-drag) hold better than loose blocks',
		'Cyclists arrive fast and get off their bikes once they hit a line', 'Patrol cars parked across a street make a quick roadblock',
		'Gas clears a crowd fast but costs public opinion', 'Agitated groups become rioters — calm areas stay calm' ];
	static waves = [
		{ t: 8, n: 2200, from: 'Kongresni trg', label: 'Students' },
		{ t: 120, n: 1800, from: 'Prešernov trg', label: 'Metelkova bloc' },
		{ t: 190, n: 450, from: 'Prešernov trg', label: 'Friday cyclists', bikes: 1 },
		{ t: 250, n: 1100, from: 'PU Ljubljana', label: 'Radicals', agitation: [ 0.5, 0.8 ], morale: 0.8 },
		{ t: 400, n: 2600, from: 'Kongresni trg', label: 'Trade unions' },
		{ t: 560, n: 1500, from: 'Ministrstvo za finance', label: 'Late arrivals' },
	];

}

export class DefendVlada extends DefendMission {

	static id = 'defend-vlada';
	static title = 'Government Palace';
	static short = 'the Government building';
	static subtitle = 'Hold the Government building on Gregorčičeva';
	static target = 'Vlada RS';
	static brief = `The cabinet is in an emergency session at <b>Gregorčičeva</b>. An angry crowd gathers on <b>Erjavčeva</b> and
		marches on the Government building in two columns: west by <b>Prešernova</b>, east by <b>Igriška</b>, both onto Gregorčičeva.
		They are spoiling for a fight: every baton, canister and arrest makes the crowd around it angrier. The ministers must be able to leave.
		A <b>water cannon</b> is parked in front of exit 1.`;
	static goals = [ 'Survive 12:00', 'Do not let the façade breach meter fill', 'Keep at least one exit open' ];
	static tips = [ 'Both columns are announced 30 s ahead — meet them on Prešernova and Igriška before they reach Gregorčičeva',
		'Water cannon: click the truck, right-click to drive it by road; W shows its reach — hold the left button to aim, release to spray',
		'Force (charges, kettles, gas, water, arrests, injuries) makes the crowd around it angrier — use it sparingly and far from the main body',
		'Cordon lines (right-drag) hold better than loose blocks', 'Cyclists arrive fast and get off their bikes once they hit a line' ];
	static outrage = true;
	static routes = [
		{ name: 'Prešernova', legs: [ [ - 668, - 216 ], [ - 700, - 300 ] ], rally: [ - 682, - 308 ] },
		{ name: 'Igriška', legs: [ [ - 410, - 279 ], [ - 500, - 361 ] ], rally: [ - 548, - 350 ] },
	];
	static waves = [
		{ t: 8, n: 2000, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Students', agitation: [ 0.35, 0.6 ] },
		{ t: 130, n: 2000, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Farmers', agitation: [ 0.35, 0.6 ] },
		{ t: 200, n: 450, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Friday cyclists', bikes: 1, agitation: [ 0.35, 0.6 ] },
		{ t: 270, n: 1000, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Radicals', agitation: [ 0.55, 0.85 ], morale: 0.8 },
		{ t: 420, n: 2400, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Everyone else', agitation: [ 0.35, 0.6 ] },
	];

	async setup() {

		await super.setup();
		this.resources.water = { left: 6, max: 6 };

	}

}

// ======================================================================================= RALLY (protest side)
export class RallyMission extends Mission {

	static id = 'rally';
	static title = 'Rally';
	static subtitle = 'Coordinate the protest: fill Trg republike and hold it';
	static side = 'protest';
	static brief = `You coordinate the protest. The police have orders to keep <b>Trg republike</b> clear. Bring
		<b>5,000 people</b> onto the square and hold it for <b>3 minutes</b>. Every rally call sends small groups in from all
		over town, and more answer when the public is on your side. The fuller the square, the harder the police push:
		more cordons, reinforcements, baton charges, and tear gas at 5,000. Police violence wins you sympathy; rioting loses it.`;
	static goals = [ 'Get 5,000 protesters onto Trg republike', 'Hold the square for 3:00 in total', 'Keep the protest alive (≥ 500 people)' ];
	static tips = [ 'Click a group, right-click to march. Shift adds to the selection; shift-drag selects a box',
		'Kolesarji (cyclists) are 2–3× faster: use them to fill the square early or draw the police away',
		'R: rally call — small groups set off from all over town (up to 2 km away) toward the cursor; call early. Arrivals grow with your headcount and sympathy',
		'The police get reinforcements and cordon off more streets as the square fills; at 2/3 of the goal they start clearing it, at 5,000 they gas it',
		'Q calms a group, E fires it up — angry groups push through cordons but riot', 'Isolated small groups get kettled — move in numbers' ];

	async setup() {

		const W = this.world, P = W.places;
		await W.exits();
		this.crowd.u.revealLeaders.value = 1;
		this.opinion = 50;
		this.goal = 5000;
		this.holdNeed = 180;
		this.held = 0;
		this.target = P[ 'Trg republike' ];
		this.focus = [ this.target[ 0 ] + 150, this.target[ 1 ] + 60 ];
		this.zoom = 0.95;
		this.setZones( [ { x: this.target[ 0 ], y: this.target[ 1 ], r: 60, type: ZONE.PROT } ] );
		this.resources = { rally: { left: 99, max: 99, cooldown: 30, ready: 0 } };
		for ( const [ from, n ] of [ [ 'Prešernov trg', 900 ], [ 'Metelkova', 700 ], [ 'Park Tivoli', 600 ] ] ) {

			await W.bloc( { kind: 'bloc', label: from, at: P[ from ], n, groupSize: 100, spread: 40, goal: P[ from ], goalR: 30, mode: MODE.HOLD, morale: 0.6, resolve: [ 0.7, 1.0 ] } );

		}

		// the Friday bike protest: fast, and slips round cordons, but riders get off once they hit a line
		await W.bloc( { kind: 'bloc', label: 'Kolesarji', at: P[ 'Kongresni trg' ], n: 300, groupSize: 60, spread: 25, goal: P[ 'Kongresni trg' ], goalR: 25, mode: MODE.HOLD, morale: 0.7, resolve: [ 0.8, 1.1 ], bikes: 1 } );

		// police: cordons on the approaches + reserves, more cordons and reinforcements as the square fills
		this.ai = new PoliceAI( this, this.target );
		await this.ai.setup();
		await this.bystanders( 2000 );

	}

	start() {

		this.after( 2, () => this.event( 'Select a bloc and right-click Trg republike to march', 'info', this.target ) );

	}

	commands() { return this.protestCommands(); }

	opinionWeights() {

		return { injByPolice: 0.4, injPolice: - 0.6, arrested: 0.05, arrestedSitters: 0.1, injOther: - 0.1 };

	}

	get headcount() { return this.zone( 0 ); }

	// rally call: people answer from all over town, 0.3–2 km out (most from nearer by), and converge on (x, y)
	// in small groups, so a call takes minutes to show on the square and its groups can be cut off on the way
	async rally( x, y ) {

		if ( ! this.spend( 'rally' ) ) return;
		const W = this.world, [ x0, y0, x1, y1 ] = this.city.bounds;
		const momentum = Math.min( 1, this.headcount / this.goal ) * 0.5 + this.opinion / 200;
		const n = Math.round( 200 + 900 * momentum );
		const layer = await W.fieldTo( x, y, 20 );
		let left = n, groups = 0;
		while ( left > 0 ) {

			const size = Math.min( left, Math.round( rand( 20, 45 ) ) );
			let at = null;
			for ( let t = 0; t < 40 && ! at; t ++ ) {

				const a = Math.random() * Math.PI * 2, d = 300 + 1700 * Math.random() ** 1.5;
				const px = x + Math.cos( a ) * d, py = y + Math.sin( a ) * d;
				if ( px > x0 + 20 && px < x1 - 20 && py > y0 + 20 && py < y1 - 20 ) at = W.roadSpot( px, py, 60 );

			}

			await W.bloc( { kind: 'bloc', label: 'Arrivals', at: at ?? pick( this.city.entries ).pos, n: size, groupSize: size, spread: 4, layer,
				morale: 0.6, resolve: [ 0.7, 1.0 ], speed: [ 1.05, 1.3 ] } );
			left -= size;
			groups ++;

		}

		this.event( `Rally call answered: ${n} people in ${groups} small groups heading in from across town`, 'good', [ x, y ] );

	}

	tick( dt ) {

		this.ai.tick( dt );
		const hc = this.headcount;
		if ( hc >= this.goal ) {

			if ( ! this.flags.holding ) { this.flags.holding = true; this.event( 'The square is ours — hold it!', 'good', this.target ); }
			this.held += dt;

		} else if ( this.flags.holding ) { this.flags.holding = false; this.event( 'Headcount fell below 5,000 — the clock is paused', 'warn', this.target ); }

		for ( const m of [ 0.25, 0.5, 0.75 ] ) {

			if ( hc >= this.goal * m && ! this.flags[ 'hc' + m ] ) { this.flags[ 'hc' + m ] = true; this.event( `${Math.round( hc ).toLocaleString()} on the square`, 'good', this.target ); }

		}

		const alive = this.stats ? this.stats[ STAT.PROT ] : 9999;
		if ( this.held >= this.holdNeed ) this.end( true, 'Trg republike belongs to the people tonight.' );
		else if ( this.t > 60 && alive < 500 ) this.end( false, 'The protest fizzled out.' );
		else if ( this.t > 20 * 60 ) this.end( false, 'The night is over — the square was never held long enough.' );

	}

	phase() {

		const r = this.resources.rally;
		const police = this.ai.gassing ? ' · POLICE GASSING THE SQUARE' : this.ai.clearing ? ' · POLICE CLEARING THE SQUARE' : '';
		return ( this.flags.holding ? `HOLDING · ${fmt( this.holdNeed - this.held )} to go` : `Rally call ${r.ready > 0 ? 'in ' + fmt( r.ready ) : 'ready (R)'} · ${fmt( 20 * 60 - this.t )} left` ) + police;

	}

	objectives() {

		const hc = this.headcount, alive = this.stats ? this.stats[ STAT.PROT ] : 0;
		return [
			{ label: 'People on Trg republike', value: Math.min( 1, hc / this.goal ), text: `${hc.toLocaleString()} / ${this.goal.toLocaleString()}`, state: hc >= this.goal ? 'done' : 'ok' },
			{ label: 'Square held', value: this.held / this.holdNeed, text: `${fmt( this.held )} / ${fmt( this.holdNeed )}`, state: this.flags.holding ? 'done' : 'ok' },
			{ label: 'Protesters on the streets', value: Math.min( 1, alive / 6000 ), text: alive.toLocaleString(), state: alive < 900 ? 'bad' : 'ok' },
			{ label: '★ Officers injured ≤ 10 (stay peaceful)', value: Math.min( 1, this.counters.injPolice / 10 ), text: `${this.counters.injPolice}`, state: this.counters.injPolice > 10 ? 'bad' : 'ok', invert: true },
		];

	}

	score( win ) {

		const s2 = win && this.t <= 12 * 60, s3 = win && this.counters.injPolice <= 10;
		return { stars: win + s2 + s3, lines: [
			[ 'Time', fmt( this.t ) ], [ 'Public sympathy', Math.round( this.opinion ) ], [ 'Protesters injured', this.counters.injByPolice ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Arrested', this.counters.arrested ], [ 'Went home', this.counters.gone ] ] };

	}

	draw( o ) {

		this.drawZone( o, this.target[ 0 ], this.target[ 1 ], 60, this.flags.holding ? 'rgb(255,176,32)' : ORANGE, `TRG REPUBLIKE · ${this.headcount.toLocaleString()}`, 0.06 );
		this.ai.draw( o );

	}

}

// Police commander for the rally mission. Escalates with the headcount on the square (f = headcount / goal):
// - always: cordons on the four approaches, reserves kettle isolated groups and snatch visible leaders, gas on a
//   hard-pressed cordon; reinforcements every 90 s (60 s from f ≥ 1/3, 40 s from f ≥ 2/3), which first close off
//   more streets around the square (outer cordons wall to wall, where protesters are coming in), then join the reserves
// - f ≥ 0.66 (until < 0.5): clearing — the approach lines advance on the square, reserves baton-charge the crowd's edge
// - f ≥ 1 (until < 0.85): tear gas volleys into the square
// Charges and gas are announced a few seconds ahead (dashed red rings), like CourtPolice.
const RALLY_R = 60;

class PoliceAI {

	constructor( mission, target ) {

		this.m = mission;
		this.W = mission.world;
		this.target = target;
		this.gas = 6; // for pressed cordons; the square's volleys have their own supply
		this.squareGas = 40;
		this.lastGas = - 99;
		this.lastKettle = - 99;
		this.last = { reinf: 0, charge: - 99, volley: - 99, advance: - 99 };
		this.clearing = false;
		this.gassing = false;
		this.extra = 0; // reinforcement squads so far
		this.pending = [];

	}

	async setup() {

		const W = this.W, [ tx, ty ] = this.target;
		this.cordons = [];
		const P = W.places;
		for ( const from of [ P[ 'Prešernov trg' ], P[ 'Park Tivoli' ], W.marks[ 'Železniška postaja' ], P[ 'Kongresni trg' ] ] ) {

			let dx = from[ 0 ] - tx, dy = from[ 1 ] - ty;
			const l = Math.hypot( dx, dy ); dx /= l; dy /= l;
			const c = W.spot( tx + dx * 85, ty + dy * 85, 10, false );
			const sq = await squads( W, [ c, c ] );
			const a = [ c[ 0 ] - dy * 22, c[ 1 ] + dx * 22 ], b = [ c[ 0 ] + dy * 22, c[ 1 ] - dx * 22 ];
			await W.lineSquads( sq, a, b, null );
			this.cordons.push( { at: c, squads: sq } );
			await W.patrols.add( { at: [ c[ 0 ] - dx * 12, c[ 1 ] - dy * 12 ], crew: 0, selectable: false, label: 'Police car' } );

		}

		this.reserves = await squads( W, [ W.marks[ 'PU Ljubljana' ], W.marks[ 'PU Ljubljana' ], W.marks[ 'PP Ljubljana Center' ], W.marks[ 'PP Ljubljana Center' ], [ tx, ty ], [ tx + 10, ty ] ], 26 );
		this.busy = new Set();
		this.posts = new Map(); // reserve squad → where it stands between charges

		// streets 120–220 m out where an outer cordon fits wall to wall (6–28 m across), ≥ 45 m apart
		this.outer = [];
		for ( const R of [ 140, 190 ] ) for ( let k = 0; k < 48; k ++ ) {

			const t = k / 48 * Math.PI * 2;
			const at = W.roadSpot( tx + Math.cos( t ) * R, ty + Math.sin( t ) * R, 30 );
			if ( ! at || ! near( at, this.target, 220 ) || near( at, this.target, 120 ) ) continue;
			if ( this.outer.some( ( o ) => near( o.at, at, 45 ) ) || this.cordons.some( ( c ) => near( c.at, at, 45 ) ) ) continue;
			const [ a, b ] = W.across( ...at, 16 );
			const w = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
			if ( w >= 6 && w <= 28 ) this.outer.push( { at, a, b, used: false } );

		}

	}

	// announce, then act
	tell( at, r, label, delay, fn ) {

		this.pending.push( { at, r, label, until: this.m.t + delay } );
		this.m.event( `Police: ${label} in ${delay} s`, 'warn', at );
		this.m.after( delay, fn );

	}

	free() { return this.reserves.filter( ( s ) => ! this.busy.has( s ) && ( s.alive ?? s.members.length ) > 10 ); }

	// protesters inside the square (positions), from the last intel readback
	inSquare() {

		const I = this.W.intel, [ tx, ty ] = this.target, out = [];
		for ( let i = 0; i < this.m.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
			if ( ( x - tx ) ** 2 + ( y - ty ) ** 2 < RALLY_R * RALLY_R ) out.push( [ x, y ] );

		}

		return out;

	}

	// Squads standing on their line or post hand back their own flow field (a layer per line runs the 32-layer pool
	// dry) and share the square's: officers in formation within 30 m of their slots ignore the field anyway.
	async settle() {

		const W = this.W;
		const idle = W.groupsOf( FACTION.POLICE ).filter( ( s ) => s.mode === MODE.FORMATION && ! this.busy.has( s ) && s.center && s.anchor && near( s.center, s.anchor, 25 ) );
		if ( ! idle.length ) return;
		const home = await W.fieldTo( ...this.target, 20 );
		for ( const s of idle ) if ( s.mode === MODE.FORMATION && ! this.busy.has( s ) ) W.setLayer( s, home );

	}

	async reinforce( f ) {

		const W = this.W, m = this.m;
		if ( this.extra >= 30 ) return;
		const from = pick( [ W.marks[ 'PU Ljubljana' ], W.marks[ 'PP Ljubljana Center' ] ] );
		const sq = await squads( W, [ from, from ] );
		this.extra += 2;

		// below 2/3: close off another street, the open one with most protesters coming in
		const open = this.outer.filter( ( o ) => ! o.used );
		if ( f < 0.66 && open.length ) {

			const score = ( o ) => W.countNear( ...o.at, 70, FACTION.PROTESTER ) - W.countNear( ...o.at, 12, FACTION.PROTESTER ) * 2 + Math.random() * 5;
			const o = open.reduce( ( p, q ) => ( score( q ) > score( p ) ? q : p ) );
			o.used = true;
			await W.lineSquads( sq, o.a, o.b, W.intel?.pos );
			this.cordons.push( { at: o.at, squads: sq, outer: true } );
			m.event( 'Police reinforcements cordon off another street', 'warn', o.at );
			return;

		}

		// clearing: every other wave thickens the weakest approach line, the rest join the reserves
		const inner = this.cordons.filter( ( c ) => ! c.outer && c.squads[ 0 ].cordon );
		if ( this.clearing && inner.length && this.extra % 4 === 0 ) {

			const c = inner.reduce( ( p, q ) => ( q.squads.length < p.squads.length ? q : p ) );
			const L = c.squads[ 0 ].cordon;
			c.squads.push( ...sq );
			await W.lineSquads( c.squads, L.a, L.b, W.intel?.pos );
			m.event( 'Police reinforcements join a line on the square', 'warn', c.at );
			return;

		}

		this.reserves.push( ...sq );
		m.event( 'Police reinforcements arrive', 'warn', from );

	}

	tick() {

		const m = this.m, W = this.W;
		if ( ! W.intel || m.t - ( this.lastTick ?? 0 ) < 5 ) return;
		this.lastTick = m.t;
		const f = m.headcount / m.goal;

		if ( ! this.clearing && f >= 0.66 ) {

			this.clearing = true;
			m.event( 'Police order: clear Trg republike! Lines advance, charges coming', 'bad', this.target );
			this.reinforce( f ).then( () => this.reinforce( f ) );

		} else if ( this.clearing && f < 0.5 ) { this.clearing = false; m.event( 'The police stop advancing and hold their lines', 'info', this.target ); }

		if ( ! this.gassing && f >= 1 ) { this.gassing = true; m.event( 'Police are firing tear gas into the square!', 'bad', this.target ); }
		else if ( this.gassing && f < 0.85 ) this.gassing = false;

		const every = f >= 0.66 ? 40 : f >= 1 / 3 ? 60 : 90;
		if ( m.t - this.last.reinf >= every ) { this.last.reinf = m.t; this.reinforce( f ); }

		// pressure on a cordon → gas it (limited, cooldown)
		for ( const c of this.cordons ) {

			const n = W.countNear( c.at[ 0 ], c.at[ 1 ], 30, FACTION.PROTESTER );
			if ( n > 250 && this.gas > 0 && m.t - this.lastGas > 45 ) {

				this.gas --;
				this.lastGas = m.t;
				W.gas( c.at[ 0 ] + rand( - 8, 8 ), c.at[ 1 ] + rand( - 8, 8 ) );
				m.event( 'Police fire tear gas at the cordon!', 'bad', c.at );
				break;

			}

		}

		this.settle();
		const sq = this.clearing || this.gassing ? this.inSquare() : [];

		// clearing: the approach lines step 8 m toward the square every 15 s, down to 30 m from its middle
		if ( this.clearing && m.t - this.last.advance >= 15 ) {

			this.last.advance = m.t;
			const [ tx, ty ] = this.target;
			for ( const c of this.cordons ) {

				const L = c.squads[ 0 ]?.cordon;
				if ( c.outer || ! L || m.t - L.retreatAt < 20 ) continue;
				const mx = ( L.a[ 0 ] + L.b[ 0 ] ) / 2, my = ( L.a[ 1 ] + L.b[ 1 ] ) / 2, d = Math.hypot( tx - mx, ty - my );
				if ( d < 38 ) continue;
				const sx = ( tx - mx ) / d * 8, sy = ( ty - my ) / d * 8;
				c.at = [ mx + sx, my + sy ];
				W.lineSquads( L.squads, [ L.a[ 0 ] + sx, L.a[ 1 ] + sy ], [ L.b[ 0 ] + sx, L.b[ 1 ] + sy ], W.intel.pos, L, { keepField: true } );

			}

		}

		// clearing: up to two free reserve squads baton-charge the edge of the crowd nearest to them, 15 m in, then re-form
		if ( this.clearing && sq.length > 50 && m.t - this.last.charge >= 25 ) {

			const team = this.free().filter( ( s ) => s.center ).slice( 0, 2 );
			if ( team.length ) {

				this.last.charge = m.t;
				const c = team[ 0 ].center;
				let edge = sq[ 0 ], bd = Infinity;
				for ( const p of sq ) { const d = ( p[ 0 ] - c[ 0 ] ) ** 2 + ( p[ 1 ] - c[ 1 ] ) ** 2; if ( d < bd ) { bd = d; edge = p; } }
				const [ tx, ty ] = this.target, dl = Math.hypot( tx - edge[ 0 ], ty - edge[ 1 ] ) || 1;
				const k = Math.min( 15, dl ) / dl, goal = [ edge[ 0 ] + ( tx - edge[ 0 ] ) * k, edge[ 1 ] + ( ty - edge[ 1 ] ) * k ];
				team.forEach( ( s ) => { this.busy.add( s ); this.posts.set( s, edge ); } );
				this.tell( goal, 15, 'baton charge', 5, () => {

					W.charge( team, ...goal );
					m.after( 14, () => { team.forEach( ( s ) => this.busy.delete( s ) ); W.moveSquads( team, ...this.posts.get( team[ 0 ] ) ); } );

				} );

			}

		}

		// gas: two canisters into the thick of the square every 20 s (a random protester there = density-weighted)
		if ( this.gassing && sq.length && this.squareGas > 0 && m.t - this.last.volley >= 20 ) {

			this.last.volley = m.t;
			const shots = [ pick( sq ), pick( sq ) ];
			this.tell( shots[ 0 ], 22, 'tear gas', 5, () => {

				for ( const p of shots ) if ( this.squareGas > 0 ) { this.squareGas --; W.gas( ...p ); }
				m.nudgeOpinion( 1, 'tear gas on a packed square' );

			} );

		}

		// isolated small groups far from the square → kettle with two reserve squads
		if ( m.t - this.lastKettle > 60 ) {

			const free = this.free();
			const lone = W.groupsOf( FACTION.PROTESTER ).filter( ( g ) => g.center && g.alive > 20 && ! near( g.center, this.target, 150 ) )
				.filter( ( g ) => W.countNear( g.center[ 0 ], g.center[ 1 ], 40, FACTION.PROTESTER ) < 160 );
			if ( lone.length && free.length >= 2 ) {

				const g = pick( lone ), team = free.slice( 0, 2 );
				team.forEach( ( s ) => this.busy.add( s ) );
				W.kettle( team, g.center[ 0 ], g.center[ 1 ], 16, W.intel.pos );
				this.lastKettle = m.t;
				m.event( `Police are kettling ${g.label}! Move other groups in to break it.`, 'bad', g.center );
				m.after( 90, () => { team.forEach( ( s ) => this.busy.delete( s ) ); W.moveSquads( team, ...this.target ); } );

			}

		}

		// visible leader close to the square → snatch
		const free = this.free();
		const leader = W.groupsOf( FACTION.PROTESTER ).find( ( g ) => g.identified && g.leaderState === 'active' && near( g.leaderPos, this.target, 160 ) );
		if ( leader && free.length && Math.random() < 0.3 ) {

			const s = free[ 0 ];
			this.busy.add( s );
			W.arrest( [ s ], ...leader.leaderPos );
			m.event( `Snatch squad going for the leader of ${leader.label}`, 'warn', leader.leaderPos );
			m.after( 45, () => { this.busy.delete( s ); W.moveSquads( [ s ], ...this.target ); } );

		}

	}

	draw( o ) {

		this.pending = this.pending.filter( ( p ) => p.until > this.m.t );
		drawPending( o, this.pending, this.m.t );

	}

}

// announced police moves: dashed red rings with a countdown
function drawPending( o, pending, t ) {

	const ctx = o.ctx;
	for ( const p of pending ) {

		const [ x, y ] = o.toScreen( ...p.at ), r = p.r / o.mpp;
		ctx.setLineDash( [ 6, 5 ] );
		ctx.strokeStyle = RED;
		ctx.lineWidth = 1.5;
		ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.stroke();
		ctx.setLineDash( [] );
		ctx.fillStyle = RED;
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		ctx.fillText( `${p.label.toUpperCase()} · ${Math.ceil( p.until - t )}`, x, y - r - 4 );

	}

}

// ======================================================================================= CLASH
// ======================================================================================= CLASH
// The march goes round the north (its shortest way, Wolfova and the north edge of Kongresni trg, runs through the
// counter-protest); the opening cordons seal the short ways out of the square toward that route: [ a, b, squads ].
const CLASH_LEGS = [ [ - 225, 65, 15 ], [ - 314, 100, 15 ], [ - 450, - 80, 30 ] ]; // Čopova → Cankarjeva → Beethovnova / Šubičeva → Trg republike
const CLASH_LINES = [
	[ [ - 80, - 109 ], [ - 89, - 104 ], 3 ], // Wolfova
	[ [ - 59, - 112 ], [ - 64, - 109 ], 1 ], // Hribarjevo nabrežje
	[ [ - 193, - 96 ], [ - 183, - 95 ], 1 ], // Južni trg → Knafljev prehod
	[ [ - 286, - 86 ], [ - 252, - 86 ], 3 ], // Slovenska, north of Šubičeva
	[ [ - 309, - 107 ], [ - 302, - 83 ], 2 ], // Šubičeva
];

export class ClashMission extends Mission {

	static id = 'clash';
	static title = 'Clash';
	static subtitle = 'Keep the march and the counter-protest apart';
	static side = 'police';
	static brief = `A Pride-style march sets off from <b>Prešernov trg</b> to <b>Trg republike</b> by Čopova, Cankarjeva and Beethovnova.
		A counter-protest has gathered on <b>Kongresni trg</b>, between the two, and more are coming. Your squads already hold
		cordons across the streets out of the square: Wolfova and the embankment, the Južni trg passage, Slovenska and Šubičeva.
		If the two crowds meet, there will be a brawl. Every injury your officers cause will be on the evening news.`;
	static goals = [ 'Keep the clash meter from filling for 12:00', 'Injure as few people as possible' ];
	static tips = [ 'The cordons seal the short ways out of Kongresni trg — the long way round (Vegova, Gosposka) is open',
		'Counter-protesters chase the march — watch for flanking through side streets', 'Reserves wait on Tomšičeva, Trg republike and at PU Ljubljana',
		'Kettling the counter-protest works, but it boils', 'Gas affects both sides equally' ];

	async setup() {

		const W = this.world, P = W.places;
		await W.exits();
		this.duration = 12 * 60;
		this.clash = 0;
		this.focus = P[ 'Kongresni trg' ];
		this.zoom = 0.55;
		this.resources = { gas: { left: 4, max: 4 }, water: { left: 4, max: 4 }, reinforce: { left: 2, max: 2 } };
		this.waterOpinion = - 2;
		this.march = await W.bloc( { kind: 'march', label: 'March', at: P[ 'Prešernov trg' ], n: 2600, groupSize: 100, spread: 40, goal: P[ 'Prešernov trg' ], goalR: 25, mode: MODE.HOLD, agitation: [ 0.05, 0.2 ], morale: 0.7 } );
		await W.bloc( { faction: FACTION.COUNTER, kind: 'counter', label: 'Counter-protest', at: P[ 'Kongresni trg' ], n: 900, groupSize: 60, spread: 30, goal: P[ 'Kongresni trg' ], goalR: 25, mode: MODE.HOLD, agitation: [ 0.3, 0.55 ], morale: 0.7 } );
		const s = P[ 'Trg republike' ];
		// cordons already formed across the short ways out of Kongresni trg toward the march's route (well clear of
		// both crowds: spawning on the squares injured dozens before the player could act)
		for ( const [ a, b, n ] of CLASH_LINES ) {

			const at = [ ( a[ 0 ] + b[ 0 ] ) / 2, ( a[ 1 ] + b[ 1 ] ) / 2 ];
			await W.lineSquads( await squads( W, Array( n ).fill( at ) ), a, b, null );

		}

		await squads( W, [ [ - 285, 12 ], s, [ s[ 0 ] + 15, s[ 1 ] ], W.marks[ 'PU Ljubljana' ], W.marks[ 'PU Ljubljana' ] ] );
		await cars( W, [ [ - 251, - 45 ], W.marks[ 'PU Ljubljana' ] ] );
		await W.patrols.add( { at: [ s[ 0 ] + 10, s[ 1 ] + 25 ], water: true } ); // Slovenska by Trg republike, behind the lines
		this.waves = [
			{ t: 200, n: 600, at: W.marks[ 'Železniška postaja' ], label: 'Counter-protesters from the station' },
			{ t: 420, n: 500, at: P[ 'Park Tivoli' ], label: 'Counter-protesters from Tivoli' },
		];
		await this.bystanders( 2000 );

	}

	start() {

		this.after( 40, () => {

			for ( const g of this.march ) { g.leg = 0; this.world.march( [ g ], ...CLASH_LEGS[ 0 ] ); }
			this.event( 'The march sets off for Trg republike by Čopova', 'info', this.world.places[ 'Prešernov trg' ] );

		} );
		this.after( 2, () => this.event( 'The march starts in 0:40 — hold the cordons', 'info', this.world.places[ 'Kongresni trg' ] ) );
		for ( const w of this.waves ) {

			this.after( w.t - 30, () => this.event( `${w.label} in 0:30`, 'warn', w.at ) );
			this.after( w.t, async () => {

				await this.world.bloc( { faction: FACTION.COUNTER, kind: 'counter', label: w.label, at: w.at, n: w.n, groupSize: 60, spread: 30, goal: w.at, goalR: 20, agitation: [ 0.4, 0.65 ], morale: 0.8 } );
				w.spawned = true;
				this.event( `${w.label} have arrived`, 'bad', w.at );

			} );

		}

	}

	commands() { return this.policeCommands(); }

	tick( dt ) {

		// the march: a group moves on to its next leg when its centre is within 30 m of this one's goal
		for ( const g of this.march ) {

			if ( g.leg === undefined || g.leg >= CLASH_LEGS.length - 1 || ! g.center || g.mode !== MODE.MARCH ) continue;
			const [ x, y ] = CLASH_LEGS[ g.leg ];
			if ( near( g.center, [ x, y ], 30 ) ) this.world.march( [ g ], ...CLASH_LEGS[ ++ g.leg ] );

		}

		// counter-protest AI: go after the nearest part of the march
		if ( this.t > 30 && this.t - ( this.flags.ai ?? 0 ) > 6 && this.world.intel ) {

			this.flags.ai = this.t;
			const marchers = this.world.groupsOf( FACTION.PROTESTER ).filter( ( g ) => g.center );
			for ( const g of this.world.groupsOf( FACTION.COUNTER ) ) {

				if ( ! g.center || Math.random() < 0.4 ) continue;
				let best = null, bd = 450 * 450;
				for ( const q of marchers ) {

					const d = ( q.center[ 0 ] - g.center[ 0 ] ) ** 2 + ( q.center[ 1 ] - g.center[ 1 ] ) ** 2;
					if ( d < bd ) { bd = d; best = q; }

				}

				if ( best ) this.world.march( [ g ], ...best.center.map( ( v ) => Math.round( v / 12 ) * 12 ), 8 ); // 12 m grid: chasers share fields

			}

		}

		const c = this.stats ? this.stats[ STAT.CLASH ] : 0;
		// capped like the façade breach: a full-on brawl still takes ~35 s to lose, time to react
		this.clash = Math.max( 0, Math.min( 1, this.clash + ( c > 0 ? Math.min( 0.028, c / 2400 ) : - 0.012 ) * dt ) );
		if ( this.clash > 0.3 && ! this.flags.c30 ) { this.flags.c30 = true; this.event( 'Fighting has broken out!', 'bad' ); }
		if ( this.clash > 0.7 && ! this.flags.c70 ) { this.flags.c70 = true; this.event( 'The brawl is spreading — separate them now!', 'bad' ); }
		if ( this.clash < 0.15 ) this.flags.c30 = this.flags.c70 = false;

		if ( this.clash >= 1 ) this.end( false, 'A full street brawl erupted between the two crowds.' );
		else if ( this.t >= this.duration ) this.end( true, 'The march ended without a brawl.' );

	}

	phase() {

		const w = this.waves.find( ( q ) => ! q.spawned );
		return w ? `Next: ${w.label} in ${fmt( w.t - this.t )}` : `${fmt( this.duration - this.t )} left`;

	}

	objectives() {

		const inj = this.counters.injByPolice;
		return [
			{ label: 'Keep them apart for 12:00', value: this.t / this.duration, text: fmt( this.duration - this.t ), state: 'ok' },
			{ label: 'Clash', value: this.clash, text: `${Math.round( this.clash * 100 )}%`, state: this.clash > 0.6 ? 'bad' : this.clash > 0.2 ? 'warn' : 'ok', invert: true },
			{ label: '★ Injuries caused by police ≤ 20', value: Math.min( 1, inj / 20 ), text: `${inj}`, state: inj > 20 ? 'bad' : inj > 12 ? 'warn' : 'ok', invert: true },
			{ label: '★ Brawl injuries ≤ 10', value: Math.min( 1, this.counters.injOther / 10 ), text: `${this.counters.injOther}`, state: this.counters.injOther > 10 ? 'bad' : 'ok', invert: true },
		];

	}

	score( win ) {

		const s2 = win && this.counters.injByPolice <= 20, s3 = win && this.counters.injOther <= 10;
		return { stars: win + s2 + s3, lines: [
			[ 'Injuries caused by police', this.counters.injByPolice ], [ 'Brawl injuries', this.counters.injOther ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Arrests', this.counters.arrested ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const s = this.world.places[ 'Trg republike' ];
		this.drawZone( o, s[ 0 ], s[ 1 ], 40, ORANGE, 'MARCH DESTINATION' );
		const w = this.waves.find( ( q ) => ! q.spawned );
		if ( w && w.t - this.t < 60 ) this.drawZone( o, w.at[ 0 ], w.at[ 1 ], 35, LIME, `${fmt( w.t - this.t )}` );

	}

}

// ======================================================================================= SIT-IN
// The sit-in: 160 readers sit in a grid in the middle of Trg republike, a ring of supporters stands around them.
// Arrest squads work by themselves once sent (A): they walk to the spot in formation (no arrests on the way through
// the ring), then restrain whoever is there (sitters first, SIT_PROCESS s each, holding formation), hold up to
// SIT_CAP detainees, carry them to the nearest prisoner van, hand them over and come back. Only sitters handed over
// count. Every arrest raises the crowd's tension (it cools, but not below 0.007 per sitter arrested so far; TENSION stages): protective (groups crowd the arrest spot, linked
// arms), blockade (groups sit down in front of the vans, mobs pull detainees free), anger (pushing and fighting).
const SIT_CAP = 8, SIT_UNLOAD = 5, SIT_PROCESS = 3.5; // detainees per trip, s to hand over, s to restrain each one
const TENSION = [ { at: 0.12, name: 'protective' }, { at: 0.4, name: 'blockade' }, { at: 0.8, name: 'anger' } ];

export class SitInMission extends Mission {

	static id = 'sitin';
	static title = 'Constitution';
	static subtitle = 'Clear the constitution sit-in on Trg republike';
	static side = 'police';
	static brief = `Since dawn, 160 people have been sitting in rows on <b>Trg republike</b> in front of the Assembly, reading the
		Constitution aloud. Thousands of supporters stand in a ring around them. The government wants the square cleared:
		arrest the sitters and get them into the <b>prisoner vans</b>. Every arrest makes the crowd angrier, and an angry
		crowd blocks your squads, sits in front of the vans and pulls detainees free.`;
	static goals = [ 'Hand 120 sitters over at the prisoner vans', 'Within 15:00', 'Keep public opinion above 15' ];
	static tips = [ `A: the squad arrests at that spot by itself, carries every ${SIT_CAP} detainees to the nearest van and comes back`,
		'Tension rises with every arrest and falls slowly: pause the arrests to let the crowd cool down',
		'Blockades at the vans stop the hand-over: clear them, or use the other van', 'Squads carrying detainees through a packed crowd lose them',
		'Cordon the approaches to stop new supporters arriving', 'Gas and charges are a disaster for opinion and tension here' ];

	async setup() {

		const W = this.world, s = W.places[ 'Trg republike' ], P = W.places, M = W.marks;
		await W.exits();
		this.square = s;
		this.focus = s;
		this.zoom = 0.4;
		this.opinion = 55;
		this.goal = 120;
		this.duration = 15 * 60;
		this.gasOpinion = - 6;
		this.waterOpinion = - 3.5;
		this.resources = { gas: { left: 2, max: 2 }, water: { left: 2, max: 2 }, reinforce: { left: 3, max: 3 } };
		this.tension = 0;
		this.stage = 0;
		this.peak = 0;
		this.handed = 0; // sitters handed over at a van
		this.handedOther = 0;
		this.freed = 0;

		// sitters: 10 rows of 16, 1.8 m apart, one group per row
		const grid = [];
		for ( let r = 0; r < 10; r ++ ) for ( let c = 0; c < 16; c ++ ) {

			const x = s[ 0 ] + ( c - 7.5 ) * 1.8, y = s[ 1 ] + ( r - 4.5 ) * 1.8;
			if ( W.sdf( x, y ) > 0.7 ) grid.push( [ x, y ] );

		}

		this.grid = { hw: 7.5 * 1.8 + 1, hh: 4.5 * 1.8 + 1 };
		const L = await W.fieldTo( s[ 0 ], s[ 1 ], 18 );
		this.sitters = await W.placeBloc( { kind: 'sitters', label: 'Constitution readers', points: grid, groupSize: 16, layer: L, mode: MODE.SIT, agitation: [ 0, 0.05 ], resolve: [ 1, 1.2 ], morale: 0.9, sitters: true } );

		// supporters: a ring round the grid, groups of 80 each holding an arc of it
		const r0 = Math.hypot( this.grid.hw, this.grid.hh ) + 2, r1 = Math.sqrt( 2200 / ( 1.3 * Math.PI ) + r0 * r0 ), ring = [];
		while ( ring.length < 2200 ) {

			const a = Math.random() * Math.PI * 2, r = Math.sqrt( r0 * r0 + Math.random() * ( r1 * r1 - r0 * r0 ) );
			const x = s[ 0 ] + Math.cos( a ) * r, y = s[ 1 ] + Math.sin( a ) * r;
			if ( W.sdf( x, y ) > 0.7 ) ring.push( [ x, y, a ] );

		}

		ring.sort( ( p, q ) => p[ 2 ] - q[ 2 ] );
		this.home = await W.fieldTo( s[ 0 ], s[ 1 ], 35 );
		this.supporters = await W.placeBloc( { kind: 'supporters', label: 'Supporters', points: ring, groupSize: 80, layer: this.home, mode: MODE.HOLD, agitation: [ 0.05, 0.2 ], morale: 0.7 } );

		await squads( W, [ M[ 'Državni zbor' ], M[ 'Državni zbor' ], M[ 'PU Ljubljana' ], M[ 'PU Ljubljana' ], M[ 'PU Ljubljana' ],
			M[ 'Cankarjev dom' ], M[ 'Cankarjev dom' ], M[ 'Ministrstvo za zunanje zadeve' ], M[ 'Ministrstvo za zunanje zadeve' ], P[ 'Kongresni trg' ], P[ 'Kongresni trg' ], M[ 'Predsedniška palača' ] ], 26 );

		// prisoner vans ~85 m out toward PU Ljubljana and Cankarjev dom
		this.vans = [];
		for ( const m of [ M[ 'PU Ljubljana' ], M[ 'Cankarjev dom' ] ] ) {

			const dx = m[ 0 ] - s[ 0 ], dy = m[ 1 ] - s[ 1 ], l = Math.hypot( dx, dy );
			const at = W.roadSpot( s[ 0 ] + dx / l * 85, s[ 1 ] + dy / l * 85, 40 ) ?? [ s[ 0 ] + dx / l * 85, s[ 1 ] + dy / l * 85 ];
			await W.patrols.add( { at, crew: 0, selectable: false, label: 'Prisoner van' } );
			this.vans.push( { at, blocked: false } );

		}

		this.setZones( [ { x: s[ 0 ], y: s[ 1 ], r: 60, type: ZONE.PROT } ] );
		await cars( W, [ M[ 'PU Ljubljana' ], M[ 'Cankarjev dom' ] ] );
		await W.patrols.add( { at: [ M[ 'PU Ljubljana' ][ 0 ] + 15, M[ 'PU Ljubljana' ][ 1 ] ], water: true } );
		await this.bystanders( 1800 );
		this.sitterSet = new Set( this.sitters.flatMap( ( g ) => g.members ) );
		this.prevFac = new Float32Array( this.crowd.N ).fill( - 1 );

	}

	start() {

		this.after( 2, () => this.event( 'Select squads and press A over the sitters: they arrest and cart people off by themselves', 'info', this.square ) );
		this.nextArrival = 75;

	}

	// A starts an arrest job; force raises the crowd's tension (on top of the usual opinion cost)
	commands() {

		const heat = { c: 0.12, k: 0.12, s: 0.08, g: 0.25, w: 0.25, o: 1 };
		return this.policeCommands().map( ( c ) => {

			if ( c.key === 'a' ) return { ...c, label: 'Arrest & cart off', desc: 'the squads walk to the spot in formation, arrest there (sitters first), carry every 8 detainees to the nearer prisoner van and come back. Only sitters handed over count',
				run: ( x, y ) => this.startArrests( this.game.squads, x, y ) };
			if ( heat[ c.key ] && c.run ) return { ...c, run: ( ...a ) => { const r = c.run( ...a ); this.heat( heat[ c.key ] ); return r; } };
			return c;

		} );

	}

	opinionWeights() {

		return { injByPolice: - 0.7, injPolice: 0.2, arrested: - 0.03, arrestedSitters: - 0.1, injOther: - 0.05 };

	}

	heat( d ) { this.tension = Math.min( 1.2, this.tension + d ); this.peak = Math.max( this.peak, this.tension ); }

	async startArrests( squads, x, y ) {

		const W = this.world;
		for ( const s of squads.filter( ( q ) => q.faction === FACTION.POLICE ) ) {

			s.job = { at: [ x, y ], held: s.job?.held ?? 0, sitters: s.job?.sitters ?? 0 };
			if ( s.job.held >= SIT_CAP ) this.cart( s );
			else this.approach( s );

		}

		this.event( `Arrest squads moving in: each carries every ${SIT_CAP} detainees to a van`, 'info', [ x, y ] );

	}

	// in formation to the spot: pushing through the ring is not an arrest
	approach( s ) {

		const job = s.job;
		Object.assign( job, { state: 'approach', ready: false } );
		this.world.moveSquads( [ s ], ...job.at ).then( () => { job.ready = true; this.crowd.setGroup( s.id, { aggression: 0.15 } ); } );

	}

	// at the spot: arrest mode, steered from person to person by jobs()
	engage( s ) {

		const job = s.job;
		Object.assign( job, { state: 'arrest', ready: false } );
		this.world.arrest( [ s ], ...job.at, 14 ).then( () => { job.target = s.arrestAt; job.ready = true; this.crowd.setGroup( s.id, { aggression: 0.15 } ); } );

	}

	// a detainee to restrain: the squad holds formation where it stands for SIT_PROCESS s (one arrest at a time)
	restrain( s ) {

		const j = s.job, c = s.center;
		Object.assign( j, { state: 'process', t: this.t, hold: c } );
		s.mode = MODE.FORMATION;
		s.anchor = c;
		this.crowd.setGroup( s.id, { mode: MODE.FORMATION, ax: c[ 0 ], ay: c[ 1 ], aggression: 0.15 } );

	}

	cart( s ) {

		const c = s.center ?? s.job.at;
		const van = this.vans.reduce( ( p, q ) => ( ( q.at[ 0 ] - c[ 0 ] ) ** 2 + ( q.at[ 1 ] - c[ 1 ] ) ** 2 < ( p.at[ 0 ] - c[ 0 ] ) ** 2 + ( p.at[ 1 ] - c[ 1 ] ) ** 2 ? q : p ) );
		const job = s.job;
		Object.assign( job, { state: 'cart', van, ready: false } );
		this.world.moveSquads( [ s ], ...van.at ).then( () => { job.ready = true; } );

	}

	// the player gave the squad another order: it keeps its detainees but drops the job
	cancelled( s ) {

		const j = s.job;
		if ( ! j.ready ) return false;
		if ( j.state === 'arrest' ) return s.mode !== MODE.ARREST || ! s.arrestAt || s.arrestAt !== j.target;
		if ( j.state === 'process' ) return s.mode !== MODE.FORMATION || s.anchor !== j.hold;
		const to = j.state === 'approach' ? j.at : j.van?.at;
		if ( to ) return s.mode !== MODE.FORMATION || ! s.anchor || Math.hypot( s.anchor[ 0 ] - to[ 0 ], s.anchor[ 1 ] - to[ 1 ] ) > 1;
		return false;

	}

	// once per intel readback: who got arrested (and by which squad), then each squad's job
	jobs( I ) {

		const W = this.world, pol = W.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center && q.kind !== 'crew' );
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			const f = I.st[ i * 4 ], was = this.prevFac[ i ];
			this.prevFac[ i ] = f;
			if ( ( f !== FACTION.ARRESTED && f !== FACTION.ARRESTED_SITTER ) || was === f || was < 0 || was > 9.5 ) continue;
			const sitter = this.sitterSet.has( i ), x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
			let s = null, bd = 12 * 12; // the nearest squad making arrests, else the nearest squad at all
			for ( const q of pol ) { const d = ( q.center[ 0 ] - x ) ** 2 + ( q.center[ 1 ] - y ) ** 2 - ( q.mode === MODE.ARREST ? 1e4 : 0 ); if ( d < bd ) { bd = d; s = q; } }
			if ( s ) {

				s.job = s.job ?? { state: 'idle', held: 0, sitters: 0, ready: true };
				s.job.held ++;
				if ( sitter ) s.job.sitters ++;
				if ( s.job.state === 'arrest' && s.job.ready ) this.restrain( s );

			} else if ( sitter ) this.handed ++;
			this.onArrest( x, y, sitter );

		}

		for ( const s of pol ) {

			const j = s.job;
			if ( ! j ) continue;
			if ( this.cancelled( s ) ) { j.state = 'idle'; j.ready = true; }
			const c = s.center;

			if ( j.state === 'approach' && j.ready && near( c, j.at, 10 ) ) this.engage( s );
			else if ( j.state === 'process' && this.t - j.t >= SIT_PROCESS ) {

				if ( j.held >= SIT_CAP ) { this.cart( s ); continue; }
				j.state = 'arrest';
				s.mode = MODE.ARREST;
				this.crowd.setGroup( s.id, { mode: MODE.ARREST, ax: s.arrestAt[ 0 ], ay: s.arrestAt[ 1 ] } );

			}
			else if ( j.state === 'arrest' && j.ready ) {

				if ( j.held >= SIT_CAP ) { this.cart( s ); continue; }
				// the next person: sitters within 12 m of the spot, else anyone sitting on the spot itself, nearest first
				let best = null, bd = Infinity, sit = false;
				for ( let i = 0; i < this.crowd.count; i ++ ) {

					if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
					const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ], dSpot = ( x - j.at[ 0 ] ) ** 2 + ( y - j.at[ 1 ] ) ** 2;
					const isSit = this.sitterSet.has( i ) && dSpot < 144;
					if ( ! isSit && ( sit || dSpot > 36 ) ) continue;
					const d = ( x - c[ 0 ] ) ** 2 + ( y - c[ 1 ] ) ** 2;
					if ( isSit && ! sit ) { sit = true; bd = Infinity; }
					if ( d < bd ) { bd = d; best = [ x, y ]; }

				}

				if ( best ) {

					if ( Math.hypot( best[ 0 ] - s.arrestAt[ 0 ], best[ 1 ] - s.arrestAt[ 1 ] ) > 1 ) {

						s.arrestAt = best;
						j.target = best;
						this.crowd.setGroup( s.id, { ax: best[ 0 ], ay: best[ 1 ] } );

					}

				} else if ( j.held ) this.cart( s );
				else { j.state = 'idle'; this.event( `${s.label}: nobody left to arrest there`, 'info', j.at ); }

			} else if ( j.state === 'cart' && j.ready && near( c, j.van.at, 14 ) ) { j.state = 'unload'; j.t = this.t; }
			else if ( j.state === 'unload' ) {

				// no hand-over while the van is blockaded
				if ( j.van.blocked ) j.t = this.t;
				else if ( this.t - j.t >= SIT_UNLOAD ) this.handOver( s );

			} else if ( j.state === 'idle' && j.held ) {

				const van = this.vans.find( ( v ) => near( c, v.at, 14 ) && ! v.blocked );
				if ( van ) { j.van = van; j.state = 'unload'; j.t = this.t; }

			}

			// a packed, angry crowd round a squad holding detainees pulls one free now and then
			if ( j.held && this.stage >= 2 ) {

				const n = W.countNear( c[ 0 ], c[ 1 ], 6, FACTION.PROTESTER );
				if ( n >= 20 && Math.random() < 0.025 * this.tension * Math.min( 2, n / 20 ) ) this.free( s );

			}

		}

		for ( const v of this.vans ) {

			const b = W.countNear( v.at[ 0 ], v.at[ 1 ], 10, FACTION.PROTESTER ) >= 15;
			if ( b && ! v.blocked ) this.event( 'The prisoner van is blockaded: no hand-overs until it is cleared', 'bad', v.at );
			v.blocked = b;

		}

	}

	handOver( s ) {

		const j = s.job;
		this.handed += j.sitters;
		this.handedOther += j.held - j.sitters;
		if ( j.held ) this.event( `${s.label} hands ${j.held} detainee${j.held > 1 ? 's' : ''} over at the van`, 'good', j.van.at );
		j.held = j.sitters = 0;
		// back to the spot while there are sitters left there
		if ( j.at && this.sittersNear( j.at, 12 ) ) this.approach( s );
		else j.state = 'idle';

	}

	sittersNear( at, r ) {

		const I = this.world.intel;
		for ( const i of this.sitterSet ) if ( I.st[ i * 4 ] === FACTION.PROTESTER && ( I.pos[ i * 2 ] - at[ 0 ] ) ** 2 + ( I.pos[ i * 2 + 1 ] - at[ 1 ] ) ** 2 < r * r ) return true;
		return false;

	}

	// a detainee pulled free sits down again where they land (a sitter) or rejoins the crowd
	free( s ) {

		const j = s.job, c = s.center, sitter = j.sitters > 0;
		j.held --;
		if ( sitter ) j.sitters --;
		const g = sitter ? this.sitters[ 0 ] : this.supporters[ 0 ];
		const [ a ] = this.crowd.spawn( [ { x: c[ 0 ] + rand( - 2, 2 ), y: c[ 1 ] + rand( - 2, 2 ), faction: FACTION.PROTESTER, group: g.id, role: sitter ? ROLE.SITTER : ROLE.MEMBER, agitation: 0.4, resolve: 1 } ] );
		if ( a?.index !== undefined ) { g.members.push( a.index ); if ( sitter ) this.sitterSet.add( a.index ); }
		this.freed ++;
		this.heat( 0.02 );
		if ( this.t - ( this._freedT ?? - 99 ) > 6 ) { this._freedT = this.t; this.event( `The crowd pulls a detainee away from ${s.label}!`, 'bad', c ); }

	}

	// every arrest winds up the supporters nearby: their leaders and a tenth of the rest
	onArrest( x, y, sitter ) {

		this.heat( sitter ? 0.018 : 0.012 );
		const I = this.world.intel;
		for ( const g of this.world.groupsOf( FACTION.PROTESTER, 'supporters' ) ) {

			if ( ! g.center || ! near( g.center, [ x, y ], 80 ) ) continue;
			this.crowd.nudge( g.leader, sitter ? 0.15 : 0.06, 0.05 );
			for ( const i of g.members ) if ( I.st[ i * 4 ] === FACTION.PROTESTER && Math.random() < 0.1 ) this.crowd.nudge( i, sitter ? 0.1 : 0.04, 0.02 );

		}

	}

	// every 4 s: the crowd reacts to the tension stage
	async director() {

		const W = this.world, T = this.tension;
		const st = TENSION.reduce( ( n, s, k ) => ( T >= s.at || ( this.stage > k && T >= s.at - 0.08 ) ? k + 1 : n ), 0 );
		if ( st !== this.stage ) {

			const msg = [ 'The crowd calms down', 'The crowd closes in to protect the sitters', 'Supporters are blockading the vans and grabbing detainees', 'The crowd turns on the police!' ][ st ];
			if ( st > this.stage || st === 0 ) this.event( msg, st >= 2 ? 'bad' : st ? 'warn' : 'good', this.square );
			this.stage = st;

		}

		const sup = W.groupsOf( FACTION.PROTESTER, 'supporters' ).filter( ( g ) => g.center && ( g.alive ?? 0 ) > 5 );
		for ( const g of sup ) this.crowd.setGroup( g.id, { morale: 0.7 + 0.3 * Math.min( 1, T ) } );
		const free = () => sup.filter( ( g ) => ! g.task );
		const nearest = ( at, r ) => free().filter( ( g ) => near( g.center, at, r ) ).sort( ( p, q ) => Math.hypot( p.center[ 0 ] - at[ 0 ], p.center[ 1 ] - at[ 1 ] ) - Math.hypot( q.center[ 0 ] - at[ 0 ], q.center[ 1 ] - at[ 1 ] ) );

		// 1 protective: two groups crowd into every arrest spot, arm in arm from 0.3
		if ( st >= 1 ) for ( const s of W.groupsOf( FACTION.POLICE ) ) {

			if ( ! [ 'approach', 'arrest' ].includes( s.job?.state ) || sup.filter( ( g ) => g.task?.squad === s ).length >= 2 ) continue;
			for ( const g of nearest( s.job.at, 70 ).slice( 0, 2 ) ) {

				g.task = { type: 'block', squad: s, stage: 1, until: this.t + 45 };
				W.setLayer( g, await W.fieldTo( ...s.job.at, 4 ) );
				W.setMode( [ g ], T >= 0.3 ? MODE.SHIELD : MODE.MARCH );

			}

		}

		// 2 blockade: up to two groups per van walk there and sit down in front of it
		if ( st >= 2 ) for ( const v of this.vans ) {

			if ( sup.filter( ( g ) => g.task?.van === v ).length >= 2 ) continue;
			const g = nearest( v.at, 160 )[ 0 ];
			if ( ! g ) continue;
			g.task = { type: 'van', van: v, stage: 2, until: this.t + 60 };
			W.setLayer( g, await W.fieldTo( ...v.at, 8 ) );
			W.setMode( [ g ], MODE.MARCH );
			this.event( 'Supporters head for the prisoner van to block it', 'warn', v.at );

		}

		// blockaders sit down at the van, or wherever they meet police on the way: they block, they do not shove
		const cops = W.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center );
		for ( const g of sup ) if ( g.task?.type === 'van' && g.mode !== MODE.SIT && ( near( g.center, g.task.van.at, 12 ) || cops.some( ( q ) => near( q.center, g.center, 12 ) ) ) ) W.setMode( [ g ], MODE.SIT );

		// 3 anger: agitated groups near police push at them; the angriest fight (at most two groups at a time)
		if ( st >= 3 ) {

			const pol = W.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center );
			const rioting = sup.filter( ( g ) => g.task?.type === 'riot' ).length;
			for ( const g of sup ) {

				if ( g.task && g.task.type !== 'block' ) continue;
				if ( g.agitation < 0.5 || ! pol.some( ( q ) => near( q.center, g.center, 50 ) ) ) continue;
				if ( g.agitation > 0.8 && rioting < 2 && Math.random() < 0.15 ) {

					g.task = { type: 'riot', stage: 3, until: this.t + 40 };
					W.setMode( [ g ], MODE.RIOT );

				} else if ( g.mode !== MODE.PUSH ) { g.task = { ...( g.task ?? { type: 'push', until: this.t + 40 } ), stage: 3 }; W.setMode( [ g ], MODE.PUSH ); }

			}

		}

		// tasks run out once the tension has dropped below their stage: back to the ring
		for ( const g of sup ) {

			if ( ! g.task || this.t < g.task.until || st >= g.task.stage ) continue;
			g.task = null;
			W.setLayer( g, await W.fieldTo( ...this.square, 35 ) );
			W.setMode( [ g ], MODE.HOLD );

		}

	}

	async arrivals() {

		const n = Math.round( Math.max( 100, 150 + ( 60 - this.opinion ) * 14 ) * ( 1 + this.tension ) );
		const e = pick( this.city.entries );
		const bikes = Math.random() < 0.35 ? 1 : 0;
		await this.world.bloc( { kind: 'supporters', label: bikes ? 'Cyclists' : 'Supporters', at: e.pos, n, groupSize: 80, spread: 20, goal: this.square, goalR: 35, agitation: [ 0.1, 0.35 ], morale: 0.7, bikes } );
		this.event( `${n} more supporters arriving ${bikes ? 'by bike ' : ''}from ${e.name ?? 'the edge of town'}`, 'warn', e.pos );

	}

	tick( dt ) {

		if ( this.t >= this.nextArrival ) {

			this.nextArrival += 75;
			this.arrivals();

		}

		const I = this.world.intel;
		if ( I && I !== this._jobIntel ) { this._jobIntel = I; this.jobs( I ); }
		// injuries by police wind the crowd up too
		const inj = this.counters.injByPolice;
		if ( inj > ( this._inj ?? 0 ) ) this.heat( ( inj - ( this._inj ?? 0 ) ) * 0.008 );
		this._inj = inj;
		// cools ~0.24 a minute, but never below what the arrests so far have built up (100 sitters → angry)
		this.tension = Math.max( this.counters.arrestedSitters * 0.007, this.tension - 0.004 * dt );
		if ( I && this.t - ( this._dirT ?? - 99 ) >= 4 ) { this._dirT = this.t; this.director(); }

		const done = this.handed;
		for ( const m of [ 0.25, 0.5, 0.75 ] ) {

			if ( done >= this.goal * m && ! this.flags[ 'a' + m ] ) { this.flags[ 'a' + m ] = true; this.event( `${done} sitters in the vans`, 'good', this.square ); }

		}

		if ( this.opinion < 30 && ! this.flags.o30 ) { this.flags.o30 = true; this.event( 'Public outrage is growing — the government is getting nervous', 'bad' ); }
		if ( done >= this.goal ) this.end( true, 'The square is clear. The Constitution will be read elsewhere.' );
		else if ( this.opinion < 15 ) this.end( false, 'Public outcry — the government ordered the police to withdraw.' );
		else if ( this.t >= this.duration ) this.end( false, 'Time ran out; the sit-in continues.' );

	}

	get carried() { return this.world.groupsOf( FACTION.POLICE ).reduce( ( n, s ) => n + ( s.job?.held ?? 0 ), 0 ); }

	phase() {

		return `In custody, not yet at a van: ${this.carried} · supporters arriving in ${fmt( this.nextArrival - this.t )} · ${fmt( this.duration - this.t )} left`;

	}

	objectives() {

		const done = this.handed, left = this.stats ? this.stats[ STAT.SITTERS ] : 160, T = this.tension;
		return [
			{ label: 'Sitters handed over at the vans', value: done / this.goal, text: `${done} / ${this.goal}`, state: done >= this.goal ? 'done' : 'ok' },
			{ label: 'Time left', value: this.t / this.duration, text: fmt( this.duration - this.t ), state: this.t > this.duration * 0.8 ? 'warn' : 'ok', invert: true },
			{ label: 'Crowd tension', value: Math.min( 1, T ), text: [ 'calm', 'protective', 'blockade', 'angry' ][ this.stage ], state: this.stage >= 2 ? 'bad' : this.stage ? 'warn' : 'ok', invert: true },
			{ label: `★ Opinion ≥ 40 · sitters left ${left}`, value: this.opinion / 100, text: `${Math.round( this.opinion )}`, state: this.opinion < 25 ? 'bad' : this.opinion < 40 ? 'warn' : 'ok' },
		];

	}

	score( win ) {

		const s2 = win && this.opinion >= 40, s3 = win && this.t <= 10 * 60;
		return { stars: win + s2 + s3, lines: [
			[ 'Sitters handed over', this.handed ], [ 'Other detainees', this.handedOther ], [ 'Pulled free by the crowd', this.freed ], [ 'Time', fmt( this.t ) ],
			[ 'Peak crowd tension', `${Math.round( this.peak * 100 )}%` ], [ 'Injuries caused by police', this.counters.injByPolice ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const ctx = o.ctx, [ sx, sy ] = o.toScreen( ...this.square );
		const w = this.grid.hw * 2 / o.mpp, h = this.grid.hh * 2 / o.mpp;
		ctx.strokeStyle = 'rgba(233,228,216,0.5)';
		ctx.lineWidth = 1;
		ctx.setLineDash( [ 4, 4 ] );
		ctx.strokeRect( sx - w / 2, sy - h / 2, w, h );
		ctx.setLineDash( [] );
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		ctx.fillStyle = WHITE;
		ctx.fillText( 'SIT-IN', sx, sy - h / 2 - 5 );

		for ( const v of this.vans ) {

			const [ x, y ] = o.toScreen( ...v.at );
			ctx.fillStyle = v.blocked ? RED : BLUE;
			ctx.fillText( v.blocked ? 'VAN · BLOCKADED' : 'PRISONER VAN', x, y - 14 );

		}

		// detainees held by each squad: small dots round it, and the spot it is working
		for ( const s of this.world.groupsOf( FACTION.POLICE ) ) {

			const j = s.job;
			if ( ! j || ! s.center ) continue;
			const [ x, y ] = o.toScreen( ...s.center );
			for ( let k = 0; k < j.held; k ++ ) {

				const a = k / SIT_CAP * Math.PI * 2 + this.t * 0.5, r = 6 / o.mpp + 4;
				ctx.fillStyle = k < j.sitters ? WHITE : ORANGE;
				ctx.beginPath(); ctx.arc( x + Math.cos( a ) * r, y + Math.sin( a ) * r, 2.5, 0, Math.PI * 2 ); ctx.fill();

			}

			if ( j.held || j.state !== 'idle' ) { ctx.fillStyle = BLUE; ctx.fillText( `${j.held}/${SIT_CAP}${j.state === 'cart' ? ' → VAN' : j.state === 'unload' ? ( j.van.blocked ? ' VAN BLOCKED' : ' HANDING OVER' ) : ''}`, x, y + 6 / o.mpp + 16 ); }
			if ( j.state === 'arrest' || j.state === 'approach' ) {

				const [ ax, ay ] = o.toScreen( ...j.at );
				ctx.strokeStyle = 'rgba(43,140,255,0.7)';
				ctx.setLineDash( [ 3, 4 ] );
				ctx.beginPath(); ctx.arc( ax, ay, 12 / o.mpp, 0, Math.PI * 2 ); ctx.stroke();
				ctx.setLineDash( [] );

			}

		}

	}

}

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

// ======================================================================================= RING ROAD
// After ljubljanainfo.com, 29 September 2021: ~2,000 at a rally on Trg republike against the COVID
// measures, an unregistered march past the Presidential palace and up Celovška; at 17:06 the northern
// ring road was closed in both directions, at 17:13 a water cannon pushed people off it, by 17:55 it was
// open again and the march was heading back to the centre. Played on its own map (data/north).

// point at distance s along a polyline of [ x, y ] pairs with cumulative lengths cum
function along( pts, cum, s ) {

	s = Math.max( 0, Math.min( cum.at( - 1 ), s ) );
	let k = 1;
	while ( k < pts.length - 1 && cum[ k ] < s ) k ++;
	const t = ( s - cum[ k - 1 ] ) / ( cum[ k ] - cum[ k - 1 ] || 1 );
	return [ pts[ k - 1 ][ 0 ] + ( pts[ k ][ 0 ] - pts[ k - 1 ][ 0 ] ) * t, pts[ k - 1 ][ 1 ] + ( pts[ k ][ 1 ] - pts[ k - 1 ][ 1 ] ) * t ];

}

function polyline( pts ) {

	const cum = [ 0 ];
	for ( let k = 1; k < pts.length; k ++ ) cum.push( cum[ k - 1 ] + Math.hypot( pts[ k ][ 0 ] - pts[ k - 1 ][ 0 ], pts[ k ][ 1 ] - pts[ k - 1 ][ 1 ] ) );
	return { pts, cum, len: cum.at( - 1 ) };

}

// distance along a polyline of the point nearest to (x, y)
function project( L, x, y ) {

	let best = Infinity, bs = 0;
	for ( let k = 1; k < L.pts.length; k ++ ) {

		const [ ax, ay ] = L.pts[ k - 1 ], [ bx, by ] = L.pts[ k ];
		const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
		const t = Math.max( 0, Math.min( 1, ( ( x - ax ) * dx + ( y - ay ) * dy ) / l2 ) );
		const d = ( x - ax - t * dx ) ** 2 + ( y - ay - t * dy ) ** 2;
		if ( d < best ) { best = d; bs = L.cum[ k - 1 ] + t * Math.sqrt( l2 ); }

	}

	return bs;

}

const CAR_GAP = 7.5, CAR_SPEED = 17; // queued spacing (m), free-flow speed (m/s)
const LIMIT = 420; // seconds of closure that lose the mission
const RUN_MARCH = 10000, RUN_ONLOOKERS = 10000; // marchers from the Tivoli end of Celovška · onlookers lining the route
const RUN_FAST = 2.4, RUN_SLOW_AT = 350; // the march walks this much faster (compressed time) until this far from the interchange (m)
// onlookers within this many metres of police force join the march (firearms: all of them)
const RUN_PROVOKE = { c: 150, k: 150, s: 150, a: 120, x: 120, g: 300, w: 300 };
const RUN_JOIN = 1 / 3; // share of the onlooker groups near police force that join; the rest keep watching

export class ResnicaRun extends Mission {

	static id = 'resnica';
	static city = 'north';
	static title = 'Resni.ca COVID run';
	static subtitle = '29 September 2021 · keep the northern ring road open';
	static side = 'police';
	static brief = `After a rally against the COVID measures and for early elections, an <b>unregistered march</b> of
		<b>~10,000</b> sets off up <b>Celovška</b> from the Tivoli end. The organisers want to shut the <b>northern ring road</b>.
		The crowd is peaceful (people are pinning roses on officers' vests), but it is huge and very determined.
		<b>~10,000 people line Celovška</b> to watch: at the first sign of police force near them, they join the march.
		Keep the ring road open, and do not turn a peaceful march into a riot on camera.`;
	static goals = [ 'Ring road closed for less than 7:00 in total (on the day: 17:06–17:55, about 7:20 here)', 'Hold until 18:00', '★ Closed ≤ 3:30 · ★ ≤ 25 injuries caused by police, opinion ≥ 40' ];
	static tips = [ 'The march starts 3 km away, at the Tivoli end of Celovška: you have time to get lines across the ramps and Celovška',
		'Every charge, kettle, shield push, arrest, gas or water turns the onlookers nearby into marchers',
		'Patrol cars parked across Celovška make a quick roadblock (crews get out with U)',
		'Groups will split off: up Vodnikova to the west and towards the Litostrojska interchange to the east',
		'B: dispersal order. Most of this crowd ignores it the first time, and a second order only winds people up',
		'The water cannon pushes people off the carriageway and sends many of them home, but it costs opinion',
		'Every blocked carriageway backs traffic up. The tailback shows on the ring road' ];

	async setup() {

		const W = this.world, C = this.city, P = W.places;
		// everyone who gives up heads back south, to the centre (not over the ring road to the northern edge)
		W.exitLayer = await W.flow.request( 'exits-south', C.entries.filter( ( e ) => e.pos[ 1 ] < 0 ).map( ( e ) => ( { x: e.pos[ 0 ], y: e.pos[ 1 ], r: 14 } ) ), { pinned: true } );
		this.crowd.u.exitLayer.value = W.exitLayer;
		this.R = polyline( C.route ); // Celovška: Tivoli end → ring-road interchange
		this.inter = C.route.at( - 1 );
		this.duration = 25 * 60;
		this.closed = 0;
		this.opinion = 55;
		this.gasOpinion = - 5;
		this.waterOpinion = - 1.5;
		this.resources = { gas: { left: 1, max: 1 }, water: { left: 10, max: 10 }, reinforce: { left: 3, max: 3 }, order: { left: 99, max: 99, cooldown: 12, ready: 0 } };
		this.crowd.u.resolveDecay.value = 0.0004; // a very determined crowd (default 0.0015/s)
		this.focus = along( this.R.pts, this.R.cum, this.R.len - 260 );
		this.zoom = 0.95;

		// ring road: carriageway pieces (one-way polylines) and a 4 m mask of the cells within 9 m of each
		this.ring = C.ring.map( ( flat ) => {

			const pts = [];
			for ( let k = 0; k < flat.length; k += 2 ) pts.push( [ flat[ k ], flat[ k + 1 ] ] );
			return { ...polyline( pts ), cars: [], wait: 0, n: 0, block: Infinity };

		} );
		const { w, h, res } = C.cost, [ x0, y0 ] = C.bounds;
		this.mask = new Int8Array( w * h );
		this.ring.forEach( ( L, id ) => {

			for ( let k = 1; k < L.pts.length; k ++ ) {

				const [ ax, ay ] = L.pts[ k - 1 ], [ bx, by ] = L.pts[ k ], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
				for ( let r = Math.floor( ( Math.min( ay, by ) - 9 - y0 ) / res ); r <= ( Math.max( ay, by ) + 9 - y0 ) / res; r ++ ) {

					for ( let q = Math.floor( ( Math.min( ax, bx ) - 9 - x0 ) / res ); q <= ( Math.max( ax, bx ) + 9 - x0 ) / res; q ++ ) {

						if ( q < 0 || r < 0 || q >= w || r >= h ) continue;
						const x = x0 + ( q + 0.5 ) * res, y = y0 + ( r + 0.5 ) * res;
						const t = Math.max( 0, Math.min( 1, ( ( x - ax ) * dx + ( y - ay ) * dy ) / l2 ) );
						if ( ( x - ax - t * dx ) ** 2 + ( y - ay - t * dy ) ** 2 < 81 ) this.mask[ r * w + q ] = id + 1;

					}

				}

			}

		} );
		this.onRing = ( x, y ) => {

			const q = Math.floor( ( x - x0 ) / res ), r = Math.floor( ( y - y0 ) / res );
			return q < 0 || r < 0 || q >= w || r >= h ? 0 : this.mask[ r * w + q ];

		};
		// nearest carriageway point to (x, y)
		this.ringPoint = ( x, y ) => {

			let best = null, bd = Infinity;
			for ( const L of this.ring ) {

				const p = along( L.pts, L.cum, project( L, x, y ) ), d = ( p[ 0 ] - x ) ** 2 + ( p[ 1 ] - y ) ** 2;
				if ( d < bd ) { bd = d; best = p; }

			}

			return best;

		};
		this.vodnikova = this.ringPoint( - 1097, 715 );
		this.litostrojska = this.ringPoint( ...P[ 'Priključek Litostrojska' ] );
		// where groups stand on the road: three spots per crossing (both carriageways, either side), so the AI
		// shares a handful of flow-field layers instead of asking for a new one per group
		this.spots = [];
		for ( const c of [ this.inter, this.vodnikova, this.litostrojska ] ) {

			const near = this.ring.flatMap( ( L ) => [ - 60, 0, 60 ].map( ( o ) => along( L.pts, L.cum, project( L, ...c ) + o ) ) )
				.filter( ( p ) => Math.hypot( p[ 0 ] - c[ 0 ], p[ 1 ] - c[ 1 ] ) < 110 );
			for ( let k = 0; k < 3 && near.length; k ++ ) this.spots.push( near.splice( Math.floor( Math.random() * near.length ), 1 )[ 0 ] );

		}

		// the march: a ~400 m column at the Tivoli end of Celovška, head first; it walks fast (compressed time) until it
		// is RUN_SLOW_AT from the interchange
		const toInter = this.toInter = await W.fieldTo( ...this.inter, 30 );
		this.march = [];
		const groups = Math.ceil( RUN_MARCH / 100 );
		for ( let k = 0; k < groups; k ++ ) {

			const at = along( this.R.pts, this.R.cum, 420 - k * 400 / groups );
			const gs = await W.bloc( { kind: 'march', label: 'March', at, n: Math.min( 100, RUN_MARCH - k * 100 ), groupSize: 100, spread: 10, layer: toInter,
				agitation: [ 0.05, 0.3 ], morale: 0.9, resolve: [ 1.3, 1.5 ], speed: [ 0.9 * RUN_FAST, 1.1 * RUN_FAST ] } );
			for ( const g of gs ) g.fast = true;
			this.march.push( ...gs );

		}

		// police: a thin presence at the three crossings, reserves staged nearby, nobody in the march's path
		// (a passive squad on Celovška got shoved into and hurt dozens of marchers)
		const I = this.inter, ri = this.ringPoint( ...I );
		const st = P[ 'Aleja' ]; // staging area by the Aleja mall, 200 m east of the interchange
		await squads( W, [ [ ri[ 0 ] + ( ri[ 0 ] - I[ 0 ] ), ri[ 1 ] + ( ri[ 1 ] - I[ 1 ] ) ], this.vodnikova, this.litostrojska, st, st, st, st, st ] );
		// more squads along the way, in the side streets off Celovška (out of the march's path)
		await squads( W, this.sideSpots( [ 650, 950, 1250, 1550, 1850, 2150, 2450, 2700 ] ) );
		await cars( W, [ [ I[ 0 ] - 20, I[ 1 ] - 25 ], this.vodnikova, this.litostrojska ] );
		// on Celovška 50 m short of the interchange, facing the ring-road ramps
		const wa = along( this.R.pts, this.R.cum, this.R.len - 50 ), wb = along( this.R.pts, this.R.cum, this.R.len - 45 );
		await W.patrols.add( { at: wa, heading: Math.atan2( wb[ 1 ] - wa[ 1 ], wb[ 0 ] - wa[ 0 ] ), water: true } );
		this.wanderPlaces = [ P[ 'Tržnica Koseze' ], P[ 'Aleja' ], P[ 'Hala Tivoli' ], P[ 'Celovška · Šiška' ], P[ 'Stadion ŽAK' ] ];
		await this.bystanders( 900 );
		await this.onlookers( RUN_ONLOOKERS );

	}

	// a street spot off Celovška at each distance along it: the first point on the street network, either side,
	// that is ≥ 22 m from the route (a side street or a forecourt), alternating sides
	sideSpots( list ) {

		const W = this.world, R = this.R;
		return list.map( ( s, k ) => {

			const p = along( R.pts, R.cum, s ), q = along( R.pts, R.cum, s + 5 );
			const l = Math.hypot( q[ 0 ] - p[ 0 ], q[ 1 ] - p[ 1 ] ) || 1, nx = - ( q[ 1 ] - p[ 1 ] ) / l, ny = ( q[ 0 ] - p[ 0 ] ) / l;
			for ( const side of k % 2 ? [ 1, - 1 ] : [ - 1, 1 ] ) {

				for ( let d = 30; d <= 90; d += 10 ) for ( const ds of [ 0, - 20, 20, - 40, 40 ] ) {

					const a = along( R.pts, R.cum, s + ds );
					const c = W.roadSpot( a[ 0 ] + nx * side * d, a[ 1 ] + ny * side * d, 12 );
					if ( ! c ) continue;
					const o = along( R.pts, R.cum, project( R, ...c ) );
					if ( Math.hypot( c[ 0 ] - o[ 0 ], c[ 1 ] - o[ 1 ] ) >= 22 ) return c;

				}

			}

			return [ p[ 0 ] + nx * 30, p[ 1 ] + ny * 30 ];

		} );

	}

	// onlookers on both pavements of Celovška, from the Tivoli end to the interchange: standing still, watching
	async onlookers( n, size = 20 ) {

		const W = this.world, R = this.R, k = Math.ceil( n / size );
		for ( let j = 0; j < k; j ++ ) {

			const s = 40 + Math.floor( j / 2 ) / Math.ceil( k / 2 ) * ( R.len - 120 ), side = j % 2 ? 1 : - 1;
			const p = along( R.pts, R.cum, s ), q = along( R.pts, R.cum, s + 5 );
			const l = Math.hypot( q[ 0 ] - p[ 0 ], q[ 1 ] - p[ 1 ] ) || 1;
			const at = [ p[ 0 ] - ( q[ 1 ] - p[ 1 ] ) / l * side * 17, p[ 1 ] + ( q[ 0 ] - p[ 0 ] ) / l * side * 17 ];
			await W.bloc( { faction: FACTION.BYSTANDER, kind: 'onlookers', label: 'Onlookers', at, n: Math.min( size, n - j * size ), groupSize: size, spread: 3,
				layer: W.exitLayer, speed: [ 0, 0 ], agitation: [ 0, 0.1 ], resolve: [ 1.3, 1.5 ] } );

		}

	}

	// police force on camera: the onlookers within r of it take sides. Each group decides once, the first time force is
	// used near it: a third join the march (very determined), the rest stay onlookers. Firearms: everyone left joins.
	provoke( x, y, r ) {

		const W = this.world, I = W.intel;
		if ( ! I ) return;
		let n = 0, at = null;
		for ( const g of W.groupsOf( FACTION.BYSTANDER, 'onlookers' ) ) {

			if ( ! g.center || ( r < Infinity && ! near( g.center, [ x, y ], r ) ) ) continue;
			if ( r < Infinity ) {

				if ( g.decided ) continue;
				g.decided = true;
				if ( Math.random() >= RUN_JOIN ) continue;

			}

			const live = g.members.filter( ( i ) => I.st[ i * 4 ] === FACTION.BYSTANDER );
			if ( ! live.length ) continue;
			Object.assign( g, { faction: FACTION.PROTESTER, kind: 'march', label: 'Locals', mode: MODE.MARCH, leader: live[ 0 ], joined: true } );
			live.forEach( ( i, k ) => { this.crowd.regroup( i, g.id, k ? ROLE.MEMBER : ROLE.LEADER ); this.crowd.setFaction( i, FACTION.PROTESTER ); this.crowd.nudge( i, 0.25, 1 ); } );
			this.crowd.setGroup( g.id, { leader: g.leader, speed: rand( 0.9, 1.15 ), mode: MODE.MARCH, morale: 0.9 } );
			W.setLayer( g, this.toInter );
			n += live.length;
			at = at ?? g.center;

		}

		if ( n ) this.event( `Police force on camera: ~${n} onlookers along Celovška join the march`, 'bad', at );

	}

	openFire() {

		super.openFire();
		this.provoke( 0, 0, Infinity );

	}

	start() {

		this.after( 2, () => this.event( 'The march is on Celovška, heading for the ring road', 'warn', this.march[ 0 ].center ?? this.inter ) );
		// side groups that walked up through Šiška go for the other crossings
		this.after( 540, () => this.sideGroup( 300, this.vodnikova, 'A second group is coming up Vodnikova, for the ring road' ) );
		this.after( 660, () => this.sideGroup( 200, this.litostrojska, 'A group is heading for the Litostrojska interchange' ) );

	}

	// a group appears ~350 m south of a crossing and heads for it
	async sideGroup( n, to, msg ) {

		const at = this.world.spot( to[ 0 ], to[ 1 ] - 350, 30 );
		this.event( msg, 'bad', at );
		const gs = await this.world.bloc( { kind: 'march', label: 'Side march', at, n, groupSize: 100, spread: 20, goal: to, goalR: 15,
			agitation: [ 0.1, 0.4 ], morale: 0.9, resolve: [ 1.3, 1.5 ] } );
		for ( const g of gs ) g.split = true;

	}

	commands() {

		const early = ( run ) => ( x, y ) => {

			if ( ! this.flags.dissolved && ! this.flags.early && this.world.countNear( x, y, 60, FACTION.PROTESTER ) > 30 ) {

				this.flags.early = true;
				this.nudgeOpinion( - 4, 'force before dispersal order' );
				this.event( 'Force used on a peaceful march before it was declared dissolved', 'bad' );

			}

			return run( x, y );

		};
		// force near the onlookers turns them into marchers (only when it actually happened: resource spent, push started)
		const provoking = ( c ) => ( x, y ) => {

			const left = c.resource ? this.resources[ c.resource ].left : 0;
			const r = c.run( x, y );
			if ( c.resource ? this.resources[ c.resource ].left < left : c.key !== 's' || r ) this.provoke( x, y, RUN_PROVOKE[ c.key ] );
			return r;

		};
		return [ ...this.policeCommands().map( ( c ) => ( [ 'c', 'k', 's', 'g', 'w' ].includes( c.key ) ? { ...c, run: early( c.run ) } : c ) )
			.map( ( c ) => ( RUN_PROVOKE[ c.key ] && c.run ? { ...c, run: provoking( c ) } : c ) ),
		{ key: 'b', label: 'Dispersal order', resource: 'order', run: ( x, y ) => this.order( x, y ) } ];

	}

	order( x, y ) {

		if ( ! this.spend( 'order' ) ) return;
		const present = this.world.countNear( x, y, 70, FACTION.PROTESTER );
		const home = this.dispersal( x, y, 70, { calm: 0.05, chance: 0.1 } ); // very determined: few turn back
		if ( present > 30 && ! this.flags.dissolved ) { this.flags.dissolved = true; this.event( 'The march is declared dissolved: unregistered, and on a motorway', 'warn', [ x, y ] ); }
		this.event( `Dispersal order: ~${home} people turn back`, home ? 'good' : 'info', [ x, y ] );

	}

	opinionWeights() {

		return { injByPolice: - 0.6, injPolice: 0.2, arrested: - 0.04, arrestedSitters: 0, injOther: - 0.1 };

	}

	// on an open carriageway there is nowhere to stand clear of the jet: groups it reaches mostly give up and
	// head back to the centre (real: the cannon pushed people off in both directions within minutes)
	spray( x, y ) {

		const before = this.resources.water.left, truck = this.game.cars.find( ( c ) => c.water );
		super.spray( x, y );
		if ( this.resources.water.left === before ) return;
		// groups in front of the truck, within its reach (it may have moved in the meantime)
		const a = Math.atan2( y - truck.y, x - truck.x );
		this.after( 4, () => {

			let n = 0;
			const hit = [ truck.x + Math.cos( a ) * WATER_RANGE * 0.6, truck.y + Math.sin( a ) * WATER_RANGE * 0.6 ];
			for ( const g of this.world.groupsOf( FACTION.PROTESTER ) ) {

				if ( ! g.center || g.home || ! near( g.center, hit, 35 ) ) continue;
				if ( g.agitation < 0.35 && Math.random() < 0.6 || Math.random() < 0.15 ) { this.sendHome( g ); n += g.alive; } // very determined
				else for ( const i of g.members ) this.crowd.nudge( i, 0.1, - 0.3 );

			}

			if ( n ) this.event( `Soaked and pushed off the road: ~${n} people turn back`, 'good', hit );

		} );

	}

	// reinforcements come from the nearest of: the station, the centre (south end of Celovška), the north edge
	async reinforce( x, y ) {

		if ( ! this.spend( 'reinforce' ) ) return;
		const from = [ this.world.marks[ 'Policija' ], this.R.pts[ 0 ], this.city.entries.find( ( e ) => e.name === 'Celovška cesta' )?.pos ].filter( Boolean )
			.sort( ( a, b ) => Math.hypot( a[ 0 ] - x, a[ 1 ] - y ) - Math.hypot( b[ 0 ] - x, b[ 1 ] - y ) )[ 0 ];
		const sq = await this.world.squad( { kind: 'squad', label: 'Reinforcements', at: from, n: 30 } );
		await this.world.moveSquads( [ sq ], x, y );
		this.event( 'Reinforcement squad dispatched', 'good', from );

	}

	tick( dt ) {

		const W = this.world, I = W.intel;
		if ( I && I !== this._intel ) { this._intel = I; this.countRing( I ); }
		this.traffic( dt );
		this.ai();

		const shut = this.ring.filter( ( L ) => L.n >= 12 ).length;
		if ( shut ) this.closed += dt;
		if ( shut && ! this.flags.shut ) { this.flags.shut = true; this.event( `Ring road BLOCKED (${this.clock}) — traffic is backing up`, 'bad', this.inter ); }
		if ( ! shut && this.flags.shut ) { this.flags.shut = false; this.event( 'Ring road open again', 'good', this.inter ); }
		for ( const m of [ 120, 240, 300, 360 ] ) if ( this.closed >= m && ! this.flags[ 'c' + m ] ) { this.flags[ 'c' + m ] = true; this.event( `The ring road has been closed for ${fmt( m )} in total`, 'bad' ); }

		const alive = this.stats ? this.stats[ STAT.PROT ] : 9999;
		if ( this.closed >= LIMIT ) this.end( false, 'The ring road was shut for too long. Rush-hour traffic is gridlocked across the north of the city.' );
		else if ( this.t > 240 && alive < 150 ) this.end( true, 'The march has turned back to the centre. The ring road stayed open.' );
		else if ( this.t >= this.duration ) this.end( true, 'It is 18:00. The ring road is open and the march is heading back to the centre.' );

	}

	// protesters on each carriageway, and how far along it the first of them stands
	countRing( I ) {

		for ( const L of this.ring ) { L.n = 0; L.block = Infinity; }
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ], id = this.onRing( x, y );
			if ( ! id ) continue;
			const L = this.ring[ id - 1 ];
			L.n ++;
			L.block = Math.min( L.block, project( L, x, y ) );

		}

		for ( const L of this.ring ) if ( L.n < 6 ) L.block = Infinity; // a few people on the verge do not stop traffic

	}

	// cars along each carriageway: free flow, queue behind the first person on the road, tailback when the
	// queue reaches the start of the piece
	traffic( dt ) {

		for ( const L of this.ring ) {

			L.wait += dt;
			const first = L.cars[ L.cars.length - 1 ];
			if ( L.wait > 1.4 ) {

				L.wait = 0;
				if ( ! first || first.s > CAR_GAP ) L.cars.push( { s: 0, v: CAR_SPEED } );
				else L.backlog = ( L.backlog ?? 0 ) + 1;

			}

			if ( L.backlog && ( ! first || first.s > CAR_GAP * 2 ) ) { L.backlog --; L.cars.push( { s: 0, v: CAR_SPEED * 0.5 } ); }
			let ahead = L.block - 6; // stop line in front of the protesters
			for ( const c of L.cars ) {

				const limit = Math.min( ahead, L.len + 50 ) - c.s;
				c.v = limit < 0.5 ? 0 : Math.min( CAR_SPEED, c.v + 6 * dt, limit / Math.max( dt, 0.05 ) );
				c.s += c.v * dt;
				ahead = c.s - CAR_GAP;

			}

			L.cars = L.cars.filter( ( c ) => c.s < L.len );

		}

	}

	get tailback() {

		let m = 0;
		for ( const L of this.ring ) m += L.cars.filter( ( c ) => c.v < 1 ).length * CAR_GAP + ( L.backlog ?? 0 ) * CAR_GAP;
		return m;

	}

	// protest AI, every 8 s: arrivals spread out over the carriageways, away from police; late on, the
	// march turns back to the centre
	ai() {

		const W = this.world;
		if ( ! W.intel || this.t - ( this.flags.ai ?? 0 ) < 8 ) return;
		this.flags.ai = this.t;
		const police = W.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center );
		const guards = ( p, r ) => police.reduce( ( n, q ) => n + ( near( q.center, p, r ) ? q.alive : 0 ), 0 );
		for ( const g of W.groupsOf( FACTION.PROTESTER ) ) {

			if ( ! g.center || g.home ) continue;
			// the march slows to a walk near the interchange
			if ( g.fast && Math.hypot( g.center[ 0 ] - this.inter[ 0 ], g.center[ 1 ] - this.inter[ 1 ] ) < RUN_SLOW_AT ) {

				g.fast = false;
				this.crowd.setGroup( g.id, { speed: rand( 0.9, 1.1 ) } );

			}

			// late in the afternoon the march heads back (real: back on Celovška by 17:55)
			if ( this.t > this.duration * 0.8 && Math.random() < 0.08 ) { this.sendHome( g ); continue; }
			const p = this.ringPoint( ...g.center );
			const d = Math.hypot( p[ 0 ] - g.center[ 0 ], p[ 1 ] - g.center[ 1 ] );
			if ( d > 90 || g.onRoad && Math.random() < 0.7 ) continue;
			// close to the ring: the road spot with the fewest officers, weighted by distance
			let best = p, bs = Infinity;
			for ( const q of this.spots ) {

				const sc = guards( q, 30 ) * 3 + Math.hypot( q[ 0 ] - g.center[ 0 ], q[ 1 ] - g.center[ 1 ] ) * 0.3 + rand( 0, 20 );
				if ( sc < bs ) { bs = sc; best = q; }

			}

			g.onRoad = true;
			W.march( [ g ], ...best, 14 );

		}

	}

	// story clock: 16:20–18:00
	get clock() {

		const min = 16 * 60 + 20 + this.t / this.duration * 100;
		return `${Math.floor( min / 60 )}:${String( Math.floor( min % 60 ) ).padStart( 2, '0' )}`;

	}

	phase() {

		const head = this.march.find( ( g ) => g.center && ! g.split && ! g.home );
		const dist = head ? Math.round( Math.hypot( head.center[ 0 ] - this.inter[ 0 ], head.center[ 1 ] - this.inter[ 1 ] ) ) : 0;
		if ( ! this.closed && dist > 60 ) return `${this.clock} · the march is ${dist} m from the interchange`;
		return `${this.clock} · ${this.ring.reduce( ( s, L ) => s + L.n, 0 )} on the carriageways · tailback ${( this.tailback / 1000 ).toFixed( 1 )} km`;

	}

	objectives() {

		const inj = this.counters.injByPolice, shut = this.ring.filter( ( L ) => L.n >= 12 ).length;
		return [
			{ label: 'Ring road closed (max 7:00)', value: this.closed / LIMIT, text: `${fmt( this.closed )}${shut ? ' · BLOCKED' : ''}`, state: shut ? 'bad' : this.closed > LIMIT / 2 ? 'warn' : 'ok', invert: true },
			{ label: 'Hold until 18:00', value: this.t / this.duration, text: this.clock, state: 'ok' },
			{ label: 'Tailback', value: Math.min( 1, this.tailback / 3000 ), text: `${( this.tailback / 1000 ).toFixed( 1 )} km`, state: this.tailback > 1500 ? 'bad' : this.tailback > 300 ? 'warn' : 'ok', invert: true },
			{ label: '★ Injuries caused by police ≤ 25', value: Math.min( 1, inj / 25 ), text: `${inj}`, state: inj > 25 ? 'bad' : inj > 15 ? 'warn' : 'ok', invert: true },
		];

	}

	score( win ) {

		const s2 = win && this.closed <= LIMIT / 2, s3 = win && this.counters.injByPolice <= 25 && this.opinion >= 40;
		return { stars: win + s2 + s3, lines: [
			[ 'Ring road closed', fmt( this.closed ) ], [ 'Finished at', this.clock ], [ 'Injuries caused by police', this.counters.injByPolice ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Arrests', this.counters.arrested ], [ 'Water cannon sprays', this.resources.water.max - this.resources.water.left ],
			[ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const ctx = o.ctx;
		// the march route up Celovška
		ctx.setLineDash( [ 6, 8 ] );
		ctx.strokeStyle = 'rgba(255,106,16,0.45)';
		ctx.lineWidth = 2;
		ctx.beginPath();
		this.R.pts.forEach( ( p, k ) => { const [ x, y ] = o.toScreen( ...p ); k ? ctx.lineTo( x, y ) : ctx.moveTo( x, y ); } );
		ctx.stroke();
		ctx.setLineDash( [] );
		// carriageways: blue when open, red from the blockage back; cars as dots, stopped ones red
		for ( const L of this.ring ) {

			ctx.strokeStyle = L.n >= 12 ? 'rgba(255,45,85,0.55)' : 'rgba(43,140,255,0.35)';
			ctx.lineWidth = 3;
			ctx.beginPath();
			L.pts.forEach( ( p, k ) => { const [ x, y ] = o.toScreen( ...p ); k ? ctx.lineTo( x, y ) : ctx.moveTo( x, y ); } );
			ctx.stroke();
			for ( const c of L.cars ) {

				const [ x, y ] = o.toScreen( ...along( L.pts, L.cum, c.s ) );
				ctx.fillStyle = c.v < 1 ? 'rgb(255,45,85)' : 'rgba(233,228,216,0.85)';
				ctx.fillRect( x - 1.5, y - 1.5, 3, 3 );

			}

		}

		this.drawZone( o, this.inter[ 0 ], this.inter[ 1 ], 45, this.ring.some( ( L ) => L.n >= 12 ) ? RED : WHITE, 'CELOVŠKA INTERCHANGE', 0.04 );
		this.drawZone( o, this.vodnikova[ 0 ], this.vodnikova[ 1 ], 30, WHITE, 'VODNIKOVA', 0.03 );
		this.drawZone( o, this.litostrojska[ 0 ], this.litostrojska[ 1 ], 30, WHITE, 'LITOSTROJSKA', 0.03 );

	}

}

// ======================================================================================= BLACKBLOC
// A peaceful rally with a BlackBloc inside it. The cells look like everyone else until they mask up for
// an action. Their actions come on a countdown in a random order and end with three fires that cannot be
// stopped. The player is scored on the people around them: ordinary protesters hurt, BlackBloc detained.

const BLOC_FIRES = [ [ 'Frančiškanska cerkev', 'the Franciscan church' ], [ 'Državni zbor', 'the Assembly' ], [ 'Vlada RS', 'the Government building' ] ];
const BLOC_ACTS = [ 'stones', 'stones', 'flares', 'smash', 'smash', 'push' ];
const LEAD = 40, LEAD_SMASH = 80, LEAD_FIRE = 60; // seconds a cell is masked and moving before its action
const NORMAL_MAX = 200; // ordinary protesters hurt: the operation is called off
const BLOC_STAR = 35;
// police force near the crowd: radius, agitation added to every ordinary group in it
const OUTRAGE = { c: [ 45, 0.15, 'Baton charge' ], k: [ 50, 0.2, 'Kettle' ], g: [ 60, 0.2, 'Tear gas' ], w: [ 50, 0.15, 'Water cannon' ], s: [ 40, 0.12, 'Shield push' ] };

// a street spot just off the longest façade of a footprint ring
function facadeSpot( W, ring, pos ) {

	let best = null, bl = 0;
	for ( let k = 0; k < ring.length; k += 2 ) {

		const ax = ring[ k ], ay = ring[ k + 1 ], bx = ring[ ( k + 2 ) % ring.length ], by = ring[ ( k + 3 ) % ring.length ];
		const len = Math.hypot( bx - ax, by - ay ), mx = ( ax + bx ) / 2, my = ( ay + by ) / 2;
		const dx = mx - pos[ 0 ], dy = my - pos[ 1 ], l = Math.hypot( dx, dy ) || 1;
		const p = [ mx + dx / l * 6, my + dy / l * 6 ];
		if ( len > bl && W.sdf( ...p ) > 1 && W.cost( ...p ) <= 12 ) { bl = len; best = p; }

	}

	return best ?? W.spot( pos[ 0 ], pos[ 1 ], 30 );

}

export class BlackBloc extends Mission {

	static id = 'blackbloc';
	static title = 'BlackBloc';
	static subtitle = 'Infiltrators in a peaceful rally · three fires are coming';
	static side = 'police';
	static brief = `Several thousand people rally peacefully on <b>Trg republike</b>, <b>Prešernov trg</b> and in front of the
		Government. Hidden among them is a <b>BlackBloc</b>: about a hundred people in small cells who came to make the police
		hit the crowd. They look like everyone else until they mask up. Intelligence has their countdown but not the order:
		stones and flares at your lines, smashed shop fronts, pushes against the cordons, and three arsons:
		<b>Frančiškanska cerkev</b>, the <b>National Assembly</b> and <b>Vlada</b>. The fires cannot be prevented. The people
		around them can be protected. The crowd does not know who is among them: every blow that lands on an ordinary
		protester turns their neighbours against you.`;
	static goals = [ 'Get through the night: it ends when the third building burns', `Fewer than ${NORMAL_MAX} ordinary protesters hurt, opinion above 10`,
		`★ Detain or disable ≥ ${BLOC_STAR} of the BlackBloc · ★ ≤ 30 ordinary protesters hurt, opinion ≥ 40` ];
	static tips = [ 'Masked cells show as black dots. Seen by CCTV while masked, they stay tagged: Snatch (X) them later, when the crowd is calm',
		'Charges, kettles, gas and water anger every ordinary group nearby, and so does every protester your officers hurt',
		'Stones and flares make officers jumpy. A line out of contact cannot hit anyone: step back rather than charge into the crowd',
		'Before a fire, get people away from the building: B sends calm groups home (it costs opinion while all is quiet)',
		'Arrest (A) is slow but gentle. In a dense crowd it mostly detains the innocent' ];

	async setup() {

		const W = this.world, P = W.places, M = W.marks, T = this.city.targets;
		await W.exits();
		this.focus = [ - 250, - 70 ];
		this.zoom = 0.75;
		this.opinion = 60;
		this.resources = { gas: { left: 4, max: 4 }, water: { left: 4, max: 4 }, reinforce: { left: 3, max: 3 }, order: { left: 99, max: 99, cooldown: 15, ready: 0 } };
		this.waterOpinion = - 2;
		this.fires = 0;
		this.smashed = 0;
		this.hurt = { all: 0, police: 0 };
		this.innocent = 0;
		this.blocHeld = 0;
		this.blocDown = 0;
		this.throws = [];

		// the three targets: footprint rings and a façade spot to attack from (one pinned field each)
		const church = M[ 'Frančiškanska cerkev' ];
		const fp = this.city.buildings.find( ( b ) => inPoly( b.p[ 0 ], ...church ) );
		this.buildings = [];
		for ( const [ name, short ] of BLOC_FIRES ) {

			const t = T[ name ], pos = t ? t.pos : church;
			const rings = t ? t.poly.map( ( p ) => p[ 0 ] ) : [ fp.p[ 0 ] ];
			let r = 0;
			for ( const ring of rings ) for ( let k = 0; k < ring.length; k += 2 ) r = Math.max( r, Math.hypot( ring[ k ] - pos[ 0 ], ring[ k + 1 ] - pos[ 1 ] ) );
			const at = facadeSpot( W, rings[ 0 ], pos );
			this.buildings.push( { name, short, pos, rings, r, at } );

		}

		// shop fronts to smash; targets get their flow fields only when a cell heads there (the pool has 32)
		this.sites = [ [ 'Čopova', [ - 138, 24 ] ], [ 'Nebotičnik', M[ 'Nebotičnik' ] ], [ 'Slovenska', [ - 330, - 240 ] ], [ 'Mestni trg', P[ 'Mestni trg' ] ] ]
			.map( ( [ name, at ] ) => ( { name, at: W.spot( at[ 0 ], at[ 1 ], 8 ) } ) );

		// the rally: three crowds, each next to one of the targets
		const V = this.buildings[ 2 ], dx = V.at[ 0 ] - V.pos[ 0 ], dy = V.at[ 1 ] - V.pos[ 1 ], dl = Math.hypot( dx, dy ) || 1;
		const picket = W.spot( V.at[ 0 ] + dx / dl * 22, V.at[ 1 ] + dy / dl * 22, 10 );
		this.sq = P[ 'Trg republike' ];
		// where crowds stand, with goal radii: crowds drifting between them share these four fields
		this.rallies = [ [ this.sq, 45 ], [ P[ 'Prešernov trg' ], 30 ], [ picket, 20 ], [ P[ 'Kongresni trg' ], 35 ] ];
		this.normalGroups = [];
		const crowds = [];
		for ( const [ label, n, [ at, r ] ] of [ [ 'Trg republike rally', 2000, this.rallies[ 0 ] ], [ 'Prešernov trg rally', 900, this.rallies[ 1 ] ], [ 'Gregorčičeva picket', 500, this.rallies[ 2 ] ] ] ) {

			const groups = await W.bloc( { kind: 'crowd', label, at, n, groupSize: 50, spread: r, goal: at, goalR: r, mode: MODE.HOLD, agitation: [ 0.05, 0.25 ], morale: 0.6, resolve: [ 0.6, 1.1 ] } );
			for ( const g of groups ) g.rally = this.rallies.find( ( q ) => q[ 0 ] === at ); // [ at, r ] (World.march overwrites g.goal)
			this.normalGroups.push( ...groups );
			crowds.push( { at, r, groups } );

		}

		// the BlackBloc: one arson cell in each crowd (so each fire has a team close by), six smaller cells anywhere
		this.cells = [];
		const cell = async ( crowd, n, role ) => {

			const host = pick( crowd.groups );
			const [ c ] = await W.bloc( { kind: 'bloc', label: host.label, at: crowd.at, n, groupSize: n, spread: crowd.r, layer: host.layer, mode: MODE.HOLD,
				agitation: [ 0.3, 0.45 ], morale: 0.9, resolve: [ 1.0, 1.3 ] } );
			Object.assign( c, { role, host } );
			this.cells.push( c );

		};

		for ( const crowd of crowds ) await cell( crowd, 15, 'arson' );
		for ( let k = 0; k < 6; k ++ ) await cell( crowds[ k % 2 ], 10, 'provoke' );
		this.blocTotal = this.cells.reduce( ( s, c ) => s + c.members.length, 0 );

		// nobody starts in contact with the crowd (officers in contact hurt people): Vlada's two squads wait on
		// the streets round the building farthest from the picket
		const A = T[ 'Državni zbor' ].pos, Vp = V.pos;
		const round = [ ...Array( 12 ).keys() ].map( ( k ) => W.roadSpot( Vp[ 0 ] + Math.cos( k * Math.PI / 6 ) * ( V.r + 20 ), Vp[ 1 ] + Math.sin( k * Math.PI / 6 ) * ( V.r + 20 ) ) )
			.filter( Boolean ).sort( ( a, b ) => Math.hypot( b[ 0 ] - picket[ 0 ], b[ 1 ] - picket[ 1 ] ) - Math.hypot( a[ 0 ] - picket[ 0 ], a[ 1 ] - picket[ 1 ] ) );
		await squads( W, [ [ A[ 0 ] + 15, A[ 1 ] + 35 ], [ A[ 0 ] + 40, A[ 1 ] + 15 ], round[ 0 ], round[ 1 ],
			[ - 60, 30 ], M[ 'PU Ljubljana' ], M[ 'PU Ljubljana' ], M[ 'Cankarjev dom' ], P[ 'Kongresni trg' ] ] );
		await cars( W, [ M[ 'PU Ljubljana' ], [ - 300, - 330 ] ] );
		await W.patrols.add( { at: [ M[ 'PU Ljubljana' ][ 0 ] + 15, M[ 'PU Ljubljana' ][ 1 ] ], water: true } );
		await this.bystanders( 1500 );

		// the countdown: provocations and fires shuffled, the last one always a fire
		const acts = [ ...BLOC_ACTS.map( ( kind ) => ( { kind } ) ), ...this.buildings.map( ( b ) => ( { kind: 'fire', b } ) ) ];
		for ( let k = acts.length - 1; k > 0; k -- ) {

			const j = Math.floor( Math.random() * ( k + 1 ) );
			[ acts[ k ], acts[ j ] ] = [ acts[ j ], acts[ k ] ];

		}

		const lastFire = acts.findLastIndex( ( a ) => a.kind === 'fire' );
		[ acts[ lastFire ], acts[ acts.length - 1 ] ] = [ acts[ acts.length - 1 ], acts[ lastFire ] ];
		let t = rand( 100, 125 );
		for ( const a of acts ) { a.t = t; t += rand( 65, 110 ); }
		this.acts = acts;
		this.endAt = acts.at( - 1 ).t + 45;

	}

	start() {

		this.after( 2, () => this.event( `Intelligence: a BlackBloc of ~${Math.round( this.blocTotal / 10 ) * 10} is hiding in the crowds. First action in ${fmt( this.acts[ 0 ].t - this.t )}.`, 'warn', this.sq ) );
		for ( const a of this.acts ) {

			this.after( a.t - ( a.kind === 'fire' ? LEAD_FIRE : a.kind === 'smash' ? LEAD_SMASH : LEAD ), () => this.prepare( a ) );
			this.after( a.t, () => this.strike( a ) );

		}

	}

	normal() { return this.normalGroups.filter( ( g ) => ( g.alive ?? 1 ) > 0 && ! g.home ); }

	commands() {

		// force near the crowd angers everyone around it, guilty or not
		return [ ...this.policeCommands().map( ( c ) => {

			const o = OUTRAGE[ c.key ];
			if ( ! o ) return c;
			return { ...c, run: ( x, y ) => {

				const left = c.resource ? this.resources[ c.resource ].left : 0;
				const r = c.run( x, y );
				if ( ! c.resource || this.resources[ c.resource ].left < left ) this.outrage( x, y, ...o );
				return r;

			} };

		} ), { key: 'b', label: 'Dispersal order', resource: 'order', run: ( x, y ) => this.order( x, y ) } ];

	}

	outrage( x, y, r, d, why ) {

		let n = 0;
		for ( const g of this.normal() ) {

			if ( ! g.center || ! near( g.center, [ x, y ], r ) ) continue;
			for ( const i of g.members ) this.crowd.nudge( i, d, 0 );
			n += g.alive ?? 0;

		}

		if ( n > 50 && this.t - ( this.flags.outrageMsg ?? - 99 ) > 12 ) {

			this.flags.outrageMsg = this.t;
			this.event( `${why} into the rally: ~${n} people around it turn on the police`, 'warn', [ x, y ] );

		}

	}

	order( x, y ) {

		if ( ! this.spend( 'order' ) ) return;
		const home = this.dispersal( x, y, 70, { calm: 0.4, chance: 0.3 } );
		// with nothing happening it looks like breaking up a lawful rally
		if ( home > 0 && this.t - ( this.lastViolence ?? - 999 ) > 60 && ! this.buildings.some( ( b ) => b.due ) ) this.nudgeOpinion( - 2, 'dispersing a peaceful rally' );
		this.event( `Dispersal order: ~${home} people leaving`, home ? 'good' : 'info', [ x, y ] );

	}

	opinionWeights() {

		// arrests are scored per group (innocent or BlackBloc) in perIntel
		return { injByPolice: - 0.35, injPolice: 0.25, arrested: 0, arrestedSitters: 0, injOther: - 0.05 };

	}

	// a free cell for an action: the preferred role first, nearest to the target if there is one
	pickCell( role, at ) {

		const ok = this.cells.filter( ( c ) => ! c.busy && ! c.broken && ( c.alive ?? c.members.length ) >= 3 && c.center );
		const pref = ok.filter( ( c ) => c.role === role );
		const list = pref.length ? pref : ok;
		if ( ! list.length ) return null;
		if ( ! at ) return pick( list );
		return list.reduce( ( a, b ) => ( Math.hypot( a.center[ 0 ] - at[ 0 ], a.center[ 1 ] - at[ 1 ] ) < Math.hypot( b.center[ 0 ] - at[ 0 ], b.center[ 1 ] - at[ 1 ] ) ? a : b ) );

	}

	mask( c, a ) {

		c.masked = true;
		c.busy = a;
		this.crowd.setGroup( c.id, { speed: 1.35 } ); // masked, they run
		for ( const i of c.members ) this.crowd.nudge( i, 0.35, 0.3 );

	}

	prepare( a ) {

		const W = this.world;
		if ( a.kind === 'fire' ) {

			const b = a.b;
			this.after( LEAD_FIRE - 20, () => { b.due = a.t; this.event( `Fuel canisters spotted: they are going for ${b.short}! Get people away from it.`, 'bad', b.pos ); } );
			const c = a.cell = this.pickCell( 'arson', b.pos );
			if ( ! c ) return;
			this.mask( c, a );
			W.march( [ c ], ...b.at, 8 );
			this.event( `A group is masking up inside the ${c.host.label} and moving off`, 'warn', c.center );
			return;

		}

		const c = a.cell = this.pickCell( 'provoke' );
		if ( ! c ) return;
		this.mask( c, a );
		if ( a.kind === 'smash' ) {

			a.site = this.sites.reduce( ( p, q ) => ( Math.hypot( p.at[ 0 ] - c.center[ 0 ], p.at[ 1 ] - c.center[ 1 ] ) < Math.hypot( q.at[ 0 ] - c.center[ 0 ], q.at[ 1 ] - c.center[ 1 ] ) ? p : q ) );
			W.march( [ c ], ...a.site.at, 8 );

		}

		this.event( `A group is masking up inside the ${c.host.label}`, 'warn', c.center );

	}

	strike( a ) {

		const W = this.world;
		a.done = true;
		this.lastViolence = this.t;
		const c = a.cell && ! a.cell.broken && ( a.cell.alive ?? 0 ) >= 2 ? a.cell : null;
		if ( a.kind === 'fire' ) {

			const b = a.b;
			this.ignite( b );
			const there = c && near( c.center, b.pos, b.r + 45 );
			this.event( there ? `${b.name} is on fire. The masked group is slipping back into the crowd.` : `${b.name} is on fire: a second team was already inside.`, 'bad', b.pos );
			if ( c ) this.after( 12, () => this.rejoin( c ) );
			return;

		}

		if ( ! c ) { this.event( 'Intelligence: the BlackBloc has lost the people for its next action', 'good' ); return; }
		let back = 30;
		if ( a.kind === 'stones' || a.kind === 'flares' ) {

			const stones = a.kind === 'stones';
			c.volley = stones ? { until: this.t + 25, rate: 1.5, hit: 0.06, stress: 0.1 } : { until: this.t + 15, rate: 2.2, hit: 0.03, stress: 0.2, flare: true };
			back = stones ? 50 : 35;
			this.event( stones ? `Stones thrown at the police from inside the ${c.host.label}` : `Flares fired into the police line from the ${c.host.label}`, 'bad', c.center );

		} else if ( a.kind === 'smash' ) {

			const s = a.site;
			if ( ! near( c.center, s.at, 50 ) ) this.event( `The masked group never reached ${s.name}`, 'good', s.at );
			else if ( W.countNear( ...s.at, 30, FACTION.POLICE ) >= 6 ) this.event( `Police at ${s.name}: the masked group turns away`, 'good', s.at );
			else {

				s.hit = true;
				this.smashed ++;
				this.game.sound?.smash( s.at );
				this.event( `${s.name}: bank and shop windows smashed`, 'bad', s.at );

			}

		} else {

			// push: the front rows of the crowd around the cell are shoved into the nearest police line
			const hosts = this.normal().filter( ( g ) => g.center && near( g.center, c.center, 45 ) );
			for ( const g of hosts ) for ( const i of g.members ) this.crowd.nudge( i, 0.35, 0.1 );
			W.setMode( [ c, ...hosts ], MODE.RIOT );
			this.event( `Masked people shove the ${c.host.label} toward the police`, 'bad', c.center );

		}

		this.after( back, () => this.rejoin( c ) );

	}

	// unmask and melt back into the nearest ordinary crowd
	rejoin( c ) {

		if ( c.broken ) return;
		const hosts = this.normal().filter( ( g ) => g.center && ( g.alive ?? 0 ) > 10 );
		c.busy = null;
		c.volley = null;
		c.masked = false;
		this.crowd.setGroup( c.id, { speed: 1 } );
		if ( ! hosts.length || ! c.center ) return;
		c.host = hosts.reduce( ( a, b ) => ( Math.hypot( a.center[ 0 ] - c.center[ 0 ], a.center[ 1 ] - c.center[ 1 ] ) < Math.hypot( b.center[ 0 ] - c.center[ 0 ], b.center[ 1 ] - c.center[ 1 ] ) ? a : b ) );
		this.world.setLayer( c, c.host.layer );
		this.world.setMode( [ c ], MODE.HOLD );
		for ( const i of c.members ) this.crowd.nudge( i, - 0.25, 0 );

	}

	ignite( b ) {

		b.burning = true;
		b.litAt = this.t;
		this.game.sound?.fire( b, b.pos );
		b.due = null;
		this.fires ++;
		// people close by run: calm groups go home, the rest are wound up
		for ( const g of this.world.groups ) {

			if ( g.faction === FACTION.POLICE || g.kind === 'bloc' || ! g.center || ! near( g.center, b.pos, b.r + 70 ) ) continue;
			if ( g.faction === FACTION.PROTESTER && ! g.home && Math.random() < 0.6 ) this.sendHome( g );
			else for ( const i of g.members ) this.crowd.nudge( i, 0.3, 0 );

		}

	}

	tick( dt ) {

		const I = this.world.intel;
		if ( I && I !== this._intel ) { this._intel = I; this.perIntel( I ); }
		this.volleys( dt );
		this.ai();
		const all = this.hurt.all;
		for ( const m of [ 25, 50, 100, 150 ] ) if ( all >= m && ! this.flags[ 'h' + m ] ) { this.flags[ 'h' + m ] = true; this.event( `${m} ordinary protesters hurt`, 'bad' ); }

		if ( all >= NORMAL_MAX ) this.end( false, 'Hundreds of ordinary protesters hurt. The BlackBloc got the pictures it came for; the operation is called off.' );
		else if ( this.opinion < 10 ) this.end( false, 'The public blames the police for the night. The minister orders a withdrawal.' );
		else if ( this.t >= this.endAt ) this.end( true, 'Three buildings burned, as planned. What the cameras show around them is your doing.' );

	}

	// once per readback: who is hurt or detained, CCTV tags, burns around the fires
	perIntel( I ) {

		const st = I.st, pos = I.pos, W = this.world;
		let all = 0, byPolice = 0, innocent = 0;
		for ( const g of this.normalGroups ) {

			let h = 0, hp = 0;
			for ( const i of g.members ) {

				const f = st[ i * 4 ];
				if ( f > 9.5 ) { h ++; if ( f < 19.5 ) hp ++; } else if ( f === FACTION.ARRESTED ) innocent ++;

			}

			// the crowd sees its own people beaten: the group and its neighbours turn on the police
			const fresh = hp - ( g.hurtByPolice ?? 0 );
			if ( fresh > 0 ) {

				const d = Math.min( 0.3, 0.08 * fresh );
				for ( const i of g.members ) this.crowd.nudge( i, d, 0 );
				for ( const q of this.normalGroups ) if ( q !== g && q.center && g.center && near( q.center, g.center, 40 ) ) for ( const i of q.members ) this.crowd.nudge( i, d / 3, 0 );

			}

			g.hurtByPolice = hp;
			all += h;
			byPolice += hp;

		}

		this.hurt = { all, police: byPolice };
		let held = 0, down = 0;
		for ( const c of this.cells ) for ( const i of c.members ) {

			const f = st[ i * 4 ];
			if ( f === FACTION.ARRESTED ) held ++;
			else if ( f > 9.5 ) down ++;

		}

		// arrests: of the innocent cost, of the BlackBloc earn (shown in chunks like the base opinion)
		this._arr = ( this._arr ?? 0 ) - 0.6 * Math.max( 0, innocent - this.innocent ) + 0.2 * Math.max( 0, held - this.blocHeld );
		if ( Math.abs( this._arr ) >= 1 ) { this.nudgeOpinion( Math.trunc( this._arr ), this._arr < 0 ? 'innocent people detained' : 'BlackBloc detained' ); this._arr %= 1; }
		if ( innocent >= 5 && ! this.flags.innoMsg ) { this.flags.innoMsg = true; this.event( 'Peaceful protesters are being detained: the footage is everywhere', 'bad' ); }
		for ( const m of [ 1, 10, 25, 50 ] ) if ( held + down >= m && ! this.flags[ 'b' + m ] ) { this.flags[ 'b' + m ] = true; this.event( m === 1 ? 'First BlackBloc member detained or down' : `${m} of the BlackBloc detained or down`, 'good' ); }
		this.innocent = innocent;
		this.blocHeld = held;
		this.blocDown = down;

		// masked under a camera: tagged for good, and their leader can be snatched
		for ( const c of this.cells ) {

			if ( ! c.masked || c.tagged || ! c.center || W.cctv( ...c.center ) <= 0 ) continue;
			c.tagged = true;
			c.identified = true;
			c.label = `BlackBloc cell ${this.cells.indexOf( c ) + 1}`;
			this.event( 'CCTV tagged a masked BlackBloc cell. It stays marked after they unmask: snatch them (X) when the crowd is calm', 'info', c.center );

		}

		// smoke and burning debris close to a fire in its first 45 s
		for ( const b of this.buildings ) {

			if ( ! b.burning || this.t - b.litAt > 45 ) continue;
			for ( let i = 0; i < this.crowd.count; i ++ ) {

				const f = st[ i * 4 ], x = pos[ i * 2 ], y = pos[ i * 2 + 1 ];
				if ( f < 0 || f > 3.5 || ( x - b.pos[ 0 ] ) ** 2 + ( y - b.pos[ 1 ] ) ** 2 > ( b.r + 10 ) ** 2 ) continue;
				if ( Math.random() < 0.02 && b.rings.some( ( r ) => ringDist( r, x, y ) < 6 ) ) this.crowd.setFaction( i, 20 + f );

			}

		}

	}

	// stones and flares from a masked cell inside the crowd at police within throwing range
	volleys( dt ) {

		const I = this.world.intel;
		this.throws = this.throws.filter( ( s ) => this.t - s.t < 0.8 );
		if ( ! I ) return;
		for ( const c of this.cells ) {

			const v = c.volley;
			if ( ! v || this.t > v.until || ! c.center || ( c.alive ?? 0 ) < 2 || Math.random() > dt * v.rate ) continue;
			const [ cx, cy ] = c.center, targets = [];
			for ( let i = 0; i < this.crowd.count; i ++ ) {

				if ( I.st[ i * 4 ] !== FACTION.POLICE ) continue;
				const d = Math.hypot( I.pos[ i * 2 ] - cx, I.pos[ i * 2 + 1 ] - cy );
				if ( d > 5 && d < 28 ) targets.push( i );

			}

			if ( ! targets.length ) {

				// nobody in range: go and find a line (and leave the crowd's cover doing it)
				if ( ! v.closing ) {

					v.closing = true;
					v.until += 20;
					const pol = this.world.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center );
					const q = pol.length && pol.reduce( ( a, b ) => ( Math.hypot( a.center[ 0 ] - cx, a.center[ 1 ] - cy ) < Math.hypot( b.center[ 0 ] - cx, b.center[ 1 ] - cy ) ? a : b ) );
					if ( q ) this.world.march( [ c ], ...q.center, 15 );

				}

				continue;

			}

			const i = pick( targets ), to = [ I.pos[ i * 2 ], I.pos[ i * 2 + 1 ] ];
			this.throws.push( { from: [ cx, cy ], to, t: this.t, flare: v.flare } );
			if ( Math.random() < v.hit ) this.crowd.setFaction( i, 21 ); // officer hurt, by others
			// officers under a barrage get jumpy; the crowd the stones came from gets excited
			for ( let j = 0; j < this.crowd.count; j ++ ) if ( I.st[ j * 4 ] === FACTION.POLICE && Math.hypot( I.pos[ j * 2 ] - to[ 0 ], I.pos[ j * 2 + 1 ] - to[ 1 ] ) < 6 ) this.crowd.nudge( j, v.stress, 0 );
			for ( const g of this.normalGroups ) if ( g.center && near( g.center, c.center, 30 ) ) for ( const k of g.members ) this.crowd.nudge( k, 0.015, 0 );

		}

	}

	// every 8 s: keep the cells determined and hidden, let the ordinary crowds drift and react
	ai() {

		const W = this.world;
		if ( ! W.intel || this.t - ( this.flags.ai ?? 0 ) < 8 ) return;
		this.flags.ai = this.t;
		for ( const c of this.cells ) {

			if ( c.broken ) continue;
			// most of the cell detained or down: the rest slip away
			if ( ( c.alive ?? 0 ) < 3 ) {

				c.broken = true;
				c.masked = false;
				c.volley = null;
				for ( const i of c.members ) this.crowd.nudge( i, - 0.3, - 2 );
				continue;

			}

			// determined: gas, water and blows do not send them home
			for ( const i of c.members ) this.crowd.nudge( i, c.masked ? 0.15 : 0, 0.25 );
			if ( c.busy ) continue;
			if ( ! c.host || c.host.home || ! c.host.alive ) { this.rejoin( c ); continue; }
			if ( c.layer !== c.host.layer ) { W.setLayer( c, c.host.layer ); W.setMode( [ c ], MODE.HOLD ); }

		}

		const police = W.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center );
		for ( const g of this.normal() ) {

			if ( ! g.center ) continue;
			if ( g.mode !== MODE.RIOT && g.agitation > 0.75 && police.some( ( q ) => near( q.center, g.center, 30 ) ) ) {

				W.setMode( [ g ], MODE.RIOT );
				if ( this.t - ( this.flags.riotMsg ?? - 99 ) > 20 ) { this.flags.riotMsg = this.t; this.event( `Part of the ${g.label} is fighting the police`, 'bad', g.center ); }

			} else if ( g.mode === MODE.RIOT && g.agitation < 0.35 ) W.march( [ g ], ...g.rally[ 0 ], g.rally[ 1 ] );
			else if ( g.mode !== MODE.RIOT && Math.random() < 0.03 ) { g.rally = pick( this.rallies ); W.march( [ g ], ...g.rally[ 0 ], g.rally[ 1 ] ); }

		}

	}

	next() { return this.acts.find( ( a ) => ! a.done ); }

	phase() {

		const a = this.next();
		if ( ! a ) return `All three buildings are burning · the night ends in ${fmt( this.endAt - this.t )}`;
		return `Next BlackBloc action in ${fmt( a.t - this.t )} · fires ${this.fires}/3 · ${this.hurt.all} protesters hurt`;

	}

	objectives() {

		const a = this.next(), all = this.hurt.all, bloc = this.blocHeld + this.blocDown;
		return [
			{ label: `Fires ${this.fires}/3`, value: Math.min( 1, this.t / this.endAt ), text: a ? `next action ${fmt( a.t - this.t )}` : `ends ${fmt( this.endAt - this.t )}`, state: this.buildings.some( ( b ) => b.due ) ? 'bad' : 'warn' },
			{ label: 'Ordinary protesters hurt', value: Math.min( 1, all / NORMAL_MAX ), text: `${all} / ${NORMAL_MAX}`, state: all > NORMAL_MAX * 0.6 ? 'bad' : all > 30 ? 'warn' : 'ok', invert: true },
			{ label: `★ BlackBloc detained or down ≥ ${BLOC_STAR}`, value: Math.min( 1, bloc / BLOC_STAR ), text: `${bloc} of ${this.blocTotal}`, state: bloc >= BLOC_STAR ? 'done' : 'ok' },
			{ label: '★ Protesters hurt ≤ 30, opinion ≥ 40', value: Math.min( 1, all / 30 ), text: `${all} · ${Math.round( this.opinion )}`, state: all > 30 || this.opinion < 40 ? 'bad' : all > 20 ? 'warn' : 'ok', invert: true },
		];

	}

	score( win ) {

		const bloc = this.blocHeld + this.blocDown, all = this.hurt.all;
		const s2 = win && bloc >= BLOC_STAR, s3 = win && all <= 30 && this.opinion >= 40;
		return { stars: win + s2 + s3, lines: [
			[ 'BlackBloc detained', `${this.blocHeld} of ${this.blocTotal}` ], [ 'BlackBloc injured', this.blocDown ],
			[ 'Ordinary protesters hurt', `${all} (${this.hurt.police} by police)` ], [ 'Innocent people detained', this.innocent ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Shop fronts smashed', `${this.smashed} of ${this.sites.length}` ],
			[ 'Tear gas used', this.counters.gas ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const ctx = o.ctx, I = this.world.intel;
		ctx.font = '600 11px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		for ( const b of this.buildings ) {

			ctx.beginPath();
			for ( const r of b.rings ) {

				for ( let k = 0; k < r.length; k += 2 ) { const [ x, y ] = o.toScreen( r[ k ], r[ k + 1 ] ); k ? ctx.lineTo( x, y ) : ctx.moveTo( x, y ); }
				ctx.closePath();

			}

			if ( b.burning ) {

				ctx.fillStyle = `rgba(255,${70 + Math.floor( Math.random() * 70 )},20,${0.35 + Math.random() * 0.25})`;
				ctx.fill();

			}

			ctx.setLineDash( b.burning || b.due ? [] : [ 5, 5 ] );
			ctx.strokeStyle = b.burning || b.due ? RED : ORANGE;
			ctx.lineWidth = b.due ? 2.5 : 1.5;
			ctx.stroke();
			ctx.setLineDash( [] );
			if ( b.due ) this.drawZone( o, b.pos[ 0 ], b.pos[ 1 ], b.r + 25 + Math.sin( this.t * 4 ) * 3, RED, null, 0.05 );
			const [ lx, ly ] = o.toScreen( b.pos[ 0 ], b.pos[ 1 ] + b.r + 8 );
			ctx.fillStyle = b.burning || b.due ? RED : ORANGE;
			ctx.fillText( b.burning ? `${b.name.toUpperCase()} · BURNING` : b.due ? `${b.name.toUpperCase()} · ${fmt( b.due - this.t )}` : b.name.toUpperCase(), lx, ly );
			if ( ! b.burning ) continue;
			// smoke drifting north-east
			for ( let k = 0; k < 10; k ++ ) {

				const f = ( this.t * 0.12 + k / 10 ) % 1, d = f * 120;
				const [ x, y ] = o.toScreen( b.pos[ 0 ] + d * 0.8 + Math.sin( k * 2.1 + this.t * 0.3 ) * 8, b.pos[ 1 ] + d * 0.6 + Math.cos( k * 1.7 ) * 8 );
				ctx.beginPath();
				ctx.arc( x, y, ( 6 + f * 30 ) / o.mpp, 0, Math.PI * 2 );
				ctx.fillStyle = `rgba(110,108,112,${0.22 * ( 1 - f )})`;
				ctx.fill();

			}

		}

		for ( const s of this.sites ) {

			if ( ! s.hit ) continue;
			const [ x, y ] = o.toScreen( ...s.at );
			ctx.beginPath();
			ctx.arc( x, y, 4, 0, Math.PI * 2 );
			ctx.fillStyle = RED;
			ctx.fill();

		}

		ctx.lineWidth = 1.5;
		for ( const s of this.throws ) {

			const k = Math.min( 1, ( this.t - s.t ) / 0.6 );
			const [ ax, ay ] = o.toScreen( ...s.from ), [ bx, by ] = o.toScreen( ...s.to );
			ctx.strokeStyle = s.flare ? 'rgba(255,176,32,0.95)' : 'rgba(255,45,85,0.85)';
			ctx.beginPath();
			ctx.moveTo( ax + ( bx - ax ) * Math.max( 0, k - 0.3 ), ay + ( by - ay ) * Math.max( 0, k - 0.3 ) );
			ctx.lineTo( ax + ( bx - ax ) * k, ay + ( by - ay ) * k );
			ctx.stroke();

		}

		// masked cells: every member as a black dot; tagged cells keep a ring after they unmask
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		for ( const c of this.cells ) {

			if ( c.broken || ! c.center || ! ( c.masked || c.tagged ) ) continue;
			if ( c.masked && I ) {

				for ( const i of c.members ) {

					if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
					const [ x, y ] = o.toScreen( I.pos[ i * 2 ], I.pos[ i * 2 + 1 ] );
					ctx.beginPath();
					ctx.arc( x, y, Math.max( 2.4, 0.6 / o.mpp ), 0, Math.PI * 2 );
					ctx.fillStyle = 'rgba(8,8,10,0.95)';
					ctx.fill();
					ctx.strokeStyle = RED;
					ctx.lineWidth = 1;
					ctx.stroke();

				}

			}

			const [ x, y ] = o.toScreen( ...c.center );
			const r = Math.max( 12, ( Math.sqrt( c.alive ?? 10 ) * 0.9 + 4 ) / o.mpp );
			ctx.setLineDash( c.masked ? [] : [ 3, 4 ] );
			ctx.strokeStyle = RED;
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.arc( x, y, r, 0, Math.PI * 2 );
			ctx.stroke();
			ctx.setLineDash( [] );
			ctx.fillStyle = RED;
			ctx.fillText( c.masked ? 'BLACKBLOC' : 'BLOC · CCTV', x, y - r - 4 );

		}

	}

}

// ======================================================================================= COURT
// Protest side, capture the flag: carry the banner up Miklošičeva to the steps of the Palace of Justice
// before the verdict. The banner is a unit (its bloc's leader); if the bearer falls, the banner lies in the
// street until a group picks it up, or the police hold it and confiscate it.

const STEPS_R = 40, STEPS_NEED = 300, STEPS_HOLD = 20; // crowd on the steps, how many, for how long
const VERDICT = 600, COURT_END = 900;
// Miklošičeva's axis (from its street label): Prešernov trg (by the Franciscan church) → the station
const MIKLOSICEVA = [ [ 10, 75 ], [ 200, 741 ] ];
const onMiklosiceva = ( y ) => [ MIKLOSICEVA[ 0 ][ 0 ] + ( y - MIKLOSICEVA[ 0 ][ 1 ] ) * ( MIKLOSICEVA[ 1 ][ 0 ] - MIKLOSICEVA[ 0 ][ 0 ] ) / ( MIKLOSICEVA[ 1 ][ 1 ] - MIKLOSICEVA[ 0 ][ 1 ] ), y ];

export class CourtMission extends Mission {

	static id = 'court';
	static title = 'The Court';
	static subtitle = 'Carry the banner up Miklošičeva to the court before the verdict';
	static side = 'protest';
	static brief = `At 10:00 the court reads the verdict against seven climate activists who blockaded the ring road. You
		coordinate the march from <b>Prešernov trg</b> up <b>Miklošičeva</b> to the <b>Palace of Justice</b>. The police have
		closed the street with cordons and hold the steps. The march is about one thing: the <b>banner</b>. Get it to the
		court steps with at least ${STEPS_NEED} people around it and hold for ${STEPS_HOLD} seconds. If its bearer is arrested
		the banner falls; pick it up before the police do. Police violence on camera wins you sympathy and new arrivals;
		rioting loses both.`;
	static goals = [ `Banner on the court steps with ≥ ${STEPS_NEED} people for ${STEPS_HOLD} s`, 'Do not lose the banner to the police', 'Within 15:00',
		'★ Before the verdict (10:00) · ★ Sympathy ≥ 50 and ≤ 10 officers injured' ];
	static tips = [ 'The banner bloc is slow and precious: screen it with other groups, put it in a shield wall (B) near the lines',
		'Police moves are announced a few seconds ahead (red dashed rings): scatter (W) out of a forming kettle, umbrellas (U) against gas',
		'Gas drifts with the wind (shown top left)', 'Miklošičeva is the obvious way. Kolodvorska, the park and the square south of the court are not',
		'Split (V) a decoy off a big group; merge (M) groups back together before a line', 'Medics take the injured off the street; R calls more people in' ];

	async setup() {

		const W = this.world, P = W.places, M = W.marks;
		await W.exits();
		this.crowd.u.revealLeaders.value = 1;
		this.opinion = 50;
		this.focus = [ 30, 160 ];
		this.zoom = 0.55;
		this.resources = { rally: { left: 99, max: 99, cooldown: 40, ready: 0 }, umbrella: { left: 3, max: 3 } };
		const a = Math.random() * Math.PI * 2, ws = rand( 0.5, 1.0 );
		W.wind = [ Math.cos( a ) * ws, Math.sin( a ) * ws ];

		// the court: the Palace of Justice footprint, steps on the open façade closest to Miklošičeva
		const court = M[ 'Vrhovno sodišče' ];
		const ring = this.city.buildings.find( ( b ) => inPoly( b.p[ 0 ], ...court ) ).p[ 0 ];
		this.courtRing = ring;
		let best = null;
		for ( let k = 0; k < ring.length; k += 2 ) {

			const ax = ring[ k ], ay = ring[ k + 1 ], bx = ring[ ( k + 2 ) % ring.length ], by = ring[ ( k + 3 ) % ring.length ];
			const len = Math.hypot( bx - ax, by - ay ), mx = ( ax + bx ) / 2, my = ( ay + by ) / 2;
			let nx = ( by - ay ) / len, ny = - ( bx - ax ) / len;
			if ( inPoly( ring, mx + nx * 2, my + ny * 2 ) ) { nx = - nx; ny = - ny; }
			// the main façade: long enough, open in front, facing Miklošičeva
			if ( len < 25 || W.sdf( mx + nx * 8, my + ny * 8 ) <= 1 ) continue;
			const d = Math.hypot( mx - onMiklosiceva( my )[ 0 ], 0 );
			if ( ! best || d < best.d ) best = { d, ax, ay, bx, by, nx, ny, mx, my };

		}

		this.facade = best;
		this.steps = W.spot( best.mx + best.nx * 7, best.my + best.ny * 7, 4 );
		this.setZones( [ { x: this.steps[ 0 ], y: this.steps[ 1 ], r: STEPS_R, type: ZONE.PROT } ] );

		// the march
		const start = P[ 'Prešernov trg' ];
		const [ banner ] = await W.bloc( { kind: 'bloc', label: 'Banner bloc', at: start, n: 250, groupSize: 250, spread: 15, goal: start, goalR: 20, mode: MODE.HOLD, morale: 0.75, agitation: [ 0.05, 0.2 ], resolve: [ 0.9, 1.2 ] } );
		this.banner = { group: banner, pos: banner.leaderPos ?? start, bearers: 1 };
		await W.bloc( { kind: 'bloc', label: 'Students', at: start, n: 600, groupSize: 100, spread: 35, goal: start, goalR: 30, mode: MODE.HOLD, morale: 0.6 } );
		await W.bloc( { kind: 'bloc', label: 'Unions', at: P[ 'Kongresni trg' ], n: 500, groupSize: 100, spread: 30, goal: P[ 'Kongresni trg' ], goalR: 30, mode: MODE.HOLD, morale: 0.65, resolve: [ 0.8, 1.1 ] } );
		await W.bloc( { kind: 'bloc', label: 'Kolesarji', at: P[ 'Tromostovje' ], n: 120, groupSize: 40, spread: 15, goal: P[ 'Tromostovje' ], goalR: 20, mode: MODE.HOLD, morale: 0.7, bikes: 1 } );
		await W.bloc( { kind: 'medics', label: 'Medics', at: start, n: 20, groupSize: 20, spread: 8, goal: start, goalR: 15, mode: MODE.HOLD, agitation: [ 0, 0.05 ], morale: 0.9, resolve: [ 1.0, 1.3 ] } );

		this.arrivals = [ ...this.city.entries.map( ( e ) => ( { name: e.name ?? 'street', pos: e.pos } ) ),
			...this.city.pois.filter( ( p ) => p.kind === 'bus' ).map( ( p ) => ( { name: p.name, pos: p.pos } ) ),
			{ name: 'Railway station', pos: M[ 'Železniška postaja' ] } ];

		this.ai = new CourtPolice( this );
		await this.ai.setup();
		await this.bystanders( 1500 );
		this.held = 0;

	}

	start() {

		this.after( 2, () => this.event( 'Select the Banner bloc and march it up Miklošičeva. The court is waiting.', 'info', this.steps ) );
		this.after( VERDICT - 60, () => this.event( 'The verdict is read in 1:00', 'warn', this.steps ) );
		this.after( VERDICT, () => this.event( 'The verdict is read. The banner can still make the evening news: keep going', 'warn', this.steps ) );

	}

	commands() { return this.protestCommands(); }

	opinionWeights() {

		return { injByPolice: 0.4, injPolice: - 0.6, arrested: 0.05, arrestedSitters: 0.1, injOther: - 0.1 };

	}

	// rally call: people arrive at the nearest stop or street; more when the public is with you
	async rally( x, y ) {

		let best = this.arrivals[ 0 ], bd = Infinity;
		for ( const a of this.arrivals ) {

			const d = ( a.pos[ 0 ] - x ) ** 2 + ( a.pos[ 1 ] - y ) ** 2;
			if ( d < bd ) { bd = d; best = a; }

		}

		if ( ! this.spend( 'rally' ) ) return;
		const n = Math.round( 80 + this.opinion * 4 );
		await this.world.bloc( { kind: 'bloc', label: 'Arrivals', at: best.pos, n, groupSize: 100, spread: 20, goal: [ x, y ], goalR: 20, morale: 0.6, resolve: [ 0.6, 1.0 ] } );
		this.event( `Rally call answered: ${n} arriving at ${best.name ?? 'the edge of town'}`, 'good', best.pos );

	}

	tick( dt ) {

		const W = this.world, I = W.intel;
		this.ai.tick( dt );
		if ( I && I !== this._intel ) { this._intel = I; this.bannerTick( I, this._intelT ? this.t - this._intelT : 0 ); this._intelT = this.t; }

		const B = this.banner, onSteps = B.group && near( B.pos, this.steps, 18 ) && this.zone( 0 ) >= STEPS_NEED;
		if ( onSteps ) {

			if ( ! this.flags.steps ) { this.flags.steps = true; this.event( `The banner is on the steps! Hold ${STEPS_HOLD} seconds`, 'good', this.steps ); }
			this.held += dt;

		} else {

			if ( this.flags.steps ) this.event( 'Pushed off the steps', 'warn', this.steps );
			this.flags.steps = false;
			this.held = 0;

		}

		const alive = this.stats ? this.stats[ STAT.PROT ] : 9999;
		if ( this.held >= STEPS_HOLD ) this.end( true, this.t < VERDICT ? 'The banner stood on the court steps as the verdict was read.' : 'The banner made it to the court steps, and onto every front page.' );
		else if ( B.lost ) this.end( false, 'The police confiscated the banner. The march breaks up.' );
		else if ( this.t > 60 && alive < 300 ) this.end( false, 'The march fizzled out.' );
		else if ( this.t >= COURT_END ) this.end( false, 'The evening is over and the banner never reached the court.' );

	}

	// the banner follows its bearer (the group's leader); when the bearer falls it lies in the street until a group
	// picks it up, or until police standing over it for 10 s confiscate it
	bannerTick( I, dt ) {

		const W = this.world, B = this.banner;
		if ( B.group ) {

			const g = B.group;
			if ( g.leaderState === 'active' && ( g.alive ?? 0 ) > 0 ) { B.pos = g.leaderPos; this.crowd.u.parting.value = g.id; return; }
			B.group = null;
			B.held = 0;
			this.crowd.u.parting.value = - 1;
			this.event( 'The banner bearer is down: the banner is lying in the street! Get a group to it', 'bad', B.pos );

		}

		const prot = W.countNear( ...B.pos, 8, FACTION.PROTESTER ), pol = W.countNear( ...B.pos, 8, FACTION.POLICE );
		B.held = pol >= 5 && prot < 5 ? ( B.held ?? 0 ) + dt : 0;
		if ( B.held > 10 ) { B.lost = true; return; }
		if ( prot < 5 || pol >= prot ) return;
		// nearest protester lifts it and becomes the group's new leader
		let bi = - 1, bd = 64;
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
			const d = ( I.pos[ i * 2 ] - B.pos[ 0 ] ) ** 2 + ( I.pos[ i * 2 + 1 ] - B.pos[ 1 ] ) ** 2;
			if ( d < bd ) { bd = d; bi = i; }

		}

		const g = bi >= 0 && W.groups[ I.st[ bi * 4 + 1 ] ];
		if ( ! g || g.kind === 'medics' ) return;
		if ( g.leaderState !== 'active' || g.leader !== bi ) {

			this.crowd.regroup( bi, g.id, ROLE.LEADER );
			this.crowd.setGroup( g.id, { leader: bi } );
			g.leader = bi;
			g.leaderState = 'active';
			g.leaderPos = [ I.pos[ bi * 2 ], I.pos[ bi * 2 + 1 ] ];

		}

		B.group = g;
		B.bearers ++;
		this.event( `${g.label} picked up the banner`, 'good', B.pos );

	}

	get windArrow() {

		const a = Math.atan2( this.world.wind[ 1 ], this.world.wind[ 0 ] );
		return [ '→', '↗', '↑', '↖', '←', '↙', '↓', '↘' ][ ( Math.round( a / ( Math.PI / 4 ) ) + 8 ) % 8 ];

	}

	phase() {

		const B = this.banner;
		const where = B.group ? `banner ${Math.round( Math.hypot( B.pos[ 0 ] - this.steps[ 0 ], B.pos[ 1 ] - this.steps[ 1 ] ) )} m from the steps` : 'BANNER IN THE STREET';
		const v = this.t < VERDICT ? `verdict in ${fmt( VERDICT - this.t )}` : `${fmt( COURT_END - this.t )} left`;
		return `${where} · ${v} · wind ${this.windArrow}`;

	}

	objectives() {

		const B = this.banner, z = this.zone( 0 ), d = Math.hypot( B.pos[ 0 ] - this.steps[ 0 ], B.pos[ 1 ] - this.steps[ 1 ] );
		return [
			{ label: 'Banner to the court steps', value: Math.max( 0, 1 - d / 420 ), text: B.group ? `${Math.round( d )} m` : 'dropped!', state: ! B.group ? 'bad' : d < 18 ? 'done' : 'ok' },
			{ label: `People on the steps (${STEPS_NEED})`, value: Math.min( 1, z / STEPS_NEED ), text: `${z}${this.held > 0 ? ` · ${Math.ceil( STEPS_HOLD - this.held )} s` : ''}`, state: z >= STEPS_NEED ? 'done' : 'ok' },
			{ label: '★ Before the verdict', value: Math.min( 1, this.t / VERDICT ), text: this.t < VERDICT ? fmt( VERDICT - this.t ) : 'read', state: this.t < VERDICT ? 'ok' : 'bad', invert: true },
			{ label: '★ Sympathy ≥ 50, officers injured ≤ 10', value: Math.min( 1, this.counters.injPolice / 10 ), text: `${Math.round( this.opinion )} · ${this.counters.injPolice}`, state: this.opinion < 50 || this.counters.injPolice > 10 ? 'bad' : 'ok', invert: true },
		];

	}

	score( win ) {

		const s2 = win && this.t < VERDICT, s3 = win && this.opinion >= 50 && this.counters.injPolice <= 10;
		return { stars: win + s2 + s3, lines: [
			[ 'Time', fmt( this.t ) ], [ 'Banner bearers', this.banner.bearers ], [ 'Public sympathy', Math.round( this.opinion ) ],
			[ 'Protesters injured', this.counters.injByPolice ], [ 'Treated by medics', this.counters.treated ?? 0 ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Arrested', this.counters.arrested ], [ 'Tear gas fired', this.ai.gasUsed ] ] };

	}

	draw( o ) {

		const ctx = o.ctx, B = this.banner, z = this.zone( 0 );
		this.drawZone( o, this.steps[ 0 ], this.steps[ 1 ], STEPS_R, this.flags.steps ? 'rgb(255,176,32)' : WHITE, `COURT STEPS · ${z} / ${STEPS_NEED}`, 0.06 );
		// the banner: a flag over its bearer, or a pulsing marker where it fell
		const [ x, y ] = o.toScreen( ...B.pos );
		if ( B.group ) {

			ctx.strokeStyle = ORANGE;
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( x, y - 26 ); ctx.stroke();
			ctx.fillStyle = ORANGE;
			ctx.beginPath(); ctx.moveTo( x, y - 26 ); ctx.lineTo( x + 18, y - 21 + Math.sin( this.t * 4 ) * 2 ); ctx.lineTo( x, y - 16 ); ctx.closePath(); ctx.fill();

		} else {

			const r = 10 + ( this.t * 2 % 1 ) * 12;
			ctx.strokeStyle = RED;
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.stroke();
			ctx.fillStyle = RED;
			ctx.font = '600 11px "IBM Plex Mono", monospace';
			ctx.textAlign = 'center';
			ctx.fillText( B.held > 0 ? `BANNER · police ${Math.ceil( 10 - B.held )} s` : 'BANNER', x, y - r - 4 );

		}

		// wind, top left
		ctx.fillStyle = 'rgba(217,226,220,0.8)';
		ctx.font = '600 12px "IBM Plex Mono", monospace';
		ctx.textAlign = 'left';
		ctx.fillText( `WIND ${this.windArrow} ${Math.hypot( ...this.world.wind ).toFixed( 1 )} m/s`, 16, 96 );
		this.ai.draw( o );

	}

}

// Police commander for the court march: cordons across Miklošičeva and a line on the steps, flank blocks,
// reserves at PP Ljubljana Center. Every move is announced a few seconds ahead (the livestream sees the vans
// move) and drawn as a dashed red ring with a countdown: gas, charges, kettles, snatches of the banner bearer.
class CourtPolice {

	constructor( m ) {

		this.m = m;
		this.W = m.world;
		this.gas = 6;
		this.gasUsed = 0;
		this.busy = new Set();
		this.pending = []; // { at, r, label, until }
		this.last = { gas: - 99, charge: - 99, kettle: - 99, snatch: - 99 };

	}

	async setup() {

		const W = this.W, M = W.marks, m = this.m, F = m.facade;
		const across = async ( p ) => {

			const c = W.roadSpot( ...p, 30 ) ?? p;
			const [ a, b ] = W.across( ...c );
			const sq = await squads( W, [ c, c ], 24 );
			await W.lineSquads( sq, a, b, null );
			return { at: c, a, b, squads: sq };

		};

		this.cordons = [ await across( onMiklosiceva( 110 ) ), await across( onMiklosiceva( 220 ) ) ];
		// the steps: a line along the façade, 12 m out
		const a = [ F.ax + F.nx * 12, F.ay + F.ny * 12 ], b = [ F.bx + F.nx * 12, F.by + F.ny * 12 ];
		const at = [ ( a[ 0 ] + b[ 0 ] ) / 2, ( a[ 1 ] + b[ 1 ] ) / 2 ];
		const sq = await squads( W, [ at, at ], 24 );
		await W.lineSquads( sq, a, b, null );
		this.cordons.push( { at, a, b, squads: sq, steps: true } );
		this.posts = new Map();
		this.flanks = await squads( W, [ [ 20, 285 ], [ 160, 330 ] ], 24 );
		this.reserves = await squads( W, [ M[ 'PP Ljubljana Center' ], M[ 'PP Ljubljana Center' ], [ 130, 200 ] ], 24 );
		for ( const s of [ ...this.flanks, ...this.reserves ] ) this.posts.set( s, s.anchor );
		for ( const c of this.cordons.slice( 0, 2 ) ) await W.patrols.add( { at: W.roadSpot( c.at[ 0 ] + 2, c.at[ 1 ] + 14, 20 ) ?? c.at, crew: 0, selectable: false, label: 'Police van' } );

	}

	// protesters within r of p: count and centroid
	crowdAt( p, r ) {

		const I = this.W.intel;
		let n = 0, sx = 0, sy = 0;
		for ( let i = 0; i < this.W.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
			if ( ( x - p[ 0 ] ) ** 2 + ( y - p[ 1 ] ) ** 2 > r * r ) continue;
			n ++; sx += x; sy += y;

		}

		return { n, c: n ? [ sx / n, sy / n ] : p };

	}

	// announce, then act: the player sees it coming
	tell( at, r, label, delay, fn ) {

		this.pending.push( { at, r, label, until: this.m.t + delay } );
		this.m.event( `Police: ${label} in ${delay} s`, 'warn', at );
		this.m.after( delay, () => { this.pending = this.pending.filter( ( p ) => p.until > this.m.t ); fn(); } );

	}

	free() { return [ ...this.reserves, ...this.flanks ].filter( ( s ) => ! this.busy.has( s ) && ( s.alive ?? 0 ) > 10 && s.center ); }

	release( team ) {

		for ( const s of team ) { this.busy.delete( s ); s.snatch = null; }
		for ( const s of team ) if ( this.posts.get( s ) ) this.W.moveSquads( [ s ], ...this.posts.get( s ) );

	}

	tick() {

		const m = this.m, W = this.W;
		if ( ! W.intel || m.t - ( this.lastTick ?? 0 ) < 4 ) return;
		this.lastTick = m.t;
		const B = m.banner, close = B.group && near( B.pos, m.steps, 170 ); // second stage: the banner is near the court

		for ( const c of this.cordons ) {

			if ( ! c.squads.some( ( s ) => ( s.alive ?? 0 ) > 5 ) ) continue;
			const { n, c: crowd } = this.crowdAt( c.at, 30 );
			// gas on a pressed cordon, thrown toward the crowd's middle
			if ( n > 150 && this.gas > 0 && m.t - this.last.gas > 35 ) {

				this.last.gas = m.t;
				this.gas --;
				const p = [ c.at[ 0 ] + ( crowd[ 0 ] - c.at[ 0 ] ) * 0.6, c.at[ 1 ] + ( crowd[ 1 ] - c.at[ 1 ] ) * 0.6 ];
				this.tell( p, 20, 'tear gas', 6, () => {

					W.gas( ...p );
					this.gasUsed ++;
					m.nudgeOpinion( 1.5, 'tear gas on camera' );
					m.event( 'Tear gas fired into the march', 'bad', p );

				} );
				break;

			}

			// once the banner is close: a hard-pressed line charges 20 m into the crowd, then re-forms
			if ( close && n > 220 && m.t - this.last.charge > 60 && ! c.squads.some( ( s ) => this.busy.has( s ) ) ) {

				this.last.charge = m.t;
				this.tell( crowd, 15, 'baton charge', 6, () => {

					c.squads.forEach( ( s ) => this.busy.add( s ) );
					W.charge( c.squads, ...crowd );
					m.after( 12, () => { c.squads.forEach( ( s ) => this.busy.delete( s ) ); W.lineSquads( c.squads, c.a, c.b, W.intel?.pos ); } );

				} );
				break;

			}

		}

		// snatch squads go for the banner bearer when one is close
		const free = this.free();
		if ( B.group && m.t - this.last.snatch > 40 ) {

			const s = free.find( ( q ) => near( q.center, B.pos, 80 ) );
			if ( s ) {

				this.last.snatch = m.t;
				this.busy.add( s );
				this.tell( B.pos, 10, 'snatch squad for the banner bearer', 5, () => {

					if ( ! B.group ) { this.release( [ s ] ); return; }
					s.snatch = B.group;
					W.arrest( [ s ], ...B.pos );
					m.after( 40, () => this.release( [ s ] ) );

				} );

			}

		}

		// isolated groups (or the banner bloc on its own) get kettled by two free squads
		if ( m.t - this.last.kettle > 60 ) {

			const team = this.free().slice( 0, 2 );
			const lone = W.groupsOf( FACTION.PROTESTER ).filter( ( g ) => g.center && ( g.alive ?? 0 ) > 20 && g.kind !== 'medics'
				&& this.crowdAt( g.center, 40 ).n < 170 && team.length === 2 && team.every( ( q ) => near( q.center, g.center, 160 ) ) );
			const g = lone.find( ( q ) => q === B.group ) ?? pick( lone );
			if ( g ) {

				this.last.kettle = m.t;
				team.forEach( ( s ) => this.busy.add( s ) );
				const at = g.center;
				this.tell( at, 18, `kettle around ${g.label}`, 8, () => {

					W.kettle( team, ...g.center, 16, W.intel.pos );
					m.after( 90, () => this.release( team ) );

				} );

			}

		}

	}

	draw( o ) {

		this.pending = this.pending.filter( ( p ) => p.until > this.m.t );
		drawPending( o, this.pending, this.m.t );

	}

}

// ======================================================================================= PRIDE
// Police side: get the Pride march from Metelkova along Masarykova and down Slovenska to Kongresni trg. A peaceful,
// legal counter-protest stands on both pavements of Slovenska from Gosposvetska to Šubičeva; wherever the march passes
// it with no officers in between, tension builds until that stretch boils over. Small violent groups gather in the
// side streets (announced) and go for the march and its banner; halfway down, counter-protesters sit in the road.

// the march route (local metres, from the OSM centre lines): Metelkova → Masarykova → Trg OF → Bavarski dvor →
// Slovenska → Kongresni trg. GAUNTLET = the stretch of Slovenska lined by the counter-protest.
const PRIDE_ROUTE = [ [ 829, 565 ], [ 812, 642 ], [ 560, 649 ], [ 300, 647 ], [ 60, 645 ], [ - 30, 642 ], [ - 79, 482 ], [ - 119, 352 ], [ - 143, 295 ],
	[ - 164, 237 ], [ - 187, 170 ], [ - 220, 73 ], [ - 242, - 2 ], [ - 268, - 88 ], [ - 271, - 109 ], [ - 225, - 155 ] ];
const PRIDE_GAUNTLET = [ [ - 143, 295 ], [ - 164, 237 ], [ - 187, 170 ], [ - 220, 73 ], [ - 242, - 2 ], [ - 268, - 88 ], [ - 271, - 109 ] ];
const PRIDE_LEGS = [ [ 812, 642, 15 ], [ 300, 647, 15 ], [ - 30, 642, 15 ], [ - 225, - 155, 30 ] ]; // march flow goals: x, y, r
const PRIDE_FAST = 3; // legs before this one are the open boulevard (Masarykova): the march walks faster there
// side streets off Slovenska: [ name, junction, a point further up the street ]
const PRIDE_SIDE = [
	[ 'Tavčarjeva', [ - 119, 352 ], [ 124, 281 ] ], [ 'Dalmatinova', [ - 143, 295 ], [ - 29, 249 ] ], [ 'Štefanova', [ - 187, 170 ], [ - 277, 198 ] ],
	[ 'Nazorjeva', [ - 204, 118 ], [ - 101, 85 ] ], [ 'Cankarjeva', [ - 220, 73 ], [ - 458, 136 ] ], [ 'Čopova', [ - 223, 64 ], [ - 138, 24 ] ],
	[ 'Tomšičeva', [ - 242, - 2 ], [ - 482, 73 ] ], [ 'Knafljev prehod', [ - 243, - 4 ], [ - 119, - 50 ] ],
];
const PRIDE_N = 3000, PRIDE_DEPART = 60, PRIDE_HOUR = 1200, PRIDE_LIMIT = 1800; // marchers · departure (18:00) · +1 h (19:00) · lose at 19:30
const PRIDE_BOIL = 35, PRIDE_COOL = 120; // s of unscreened march passing to boil over · s to cool from full
const PRIDE_SCREEN = 14; // officers between a pavement group and the street for a full screen

export class PrideMission extends Mission {

	static id = 'pride';
	static title = 'Pride';
	static subtitle = 'Get the Pride march down Slovenska to Kongresni trg';
	static side = 'police';
	static brief = `Ljubljana Pride. The march gathers at <b>Metelkova</b> at 17:00 and sets off at 18:00 along <b>Masarykova</b>, past the
		station, turns left at <b>Bavarski dvor</b> and follows <b>Slovenska</b> to <b>Kongresni trg</b>, where the programme starts at 19:00.
		A traditionalist counter-protest lines both pavements of Slovenska from Gosposvetska to Šubičeva: peaceful and legal, but
		wherever the march passes it with nobody in between, words turn into shoves and shoves into a brawl. Small violent groups
		will gather in the side streets to attack the march and its banner. You have plenty of officers: put them in the right places.`;
	static goals = [ 'Get the banner to Kongresni trg by 19:30', 'Do not let the banner be taken', 'Keep the march together (≥ 40 %)',
		'★ ≥ 70 % of the march arrives · ★ ≤ 25 injured and opinion ≥ 50' ];
	static tips = [ 'Right-drag a cordon line between each pavement group and the street before the march gets there; the bars on the pavements show tension',
		'Lines left behind the march can leapfrog ahead of it: the march is slow, Slovenska is long',
		'Attack groups are announced in the side streets: block the street (cordon, or park a patrol car across it), arrest them, or snatch (X) their leader under CCTV',
		'Arresting or charging the peaceful counter-protest costs opinion; tear gas on the march costs a lot more',
		'Arrest squads (A) detain whoever they get hold of: reach attackers round the march, not through it. A squad close by scatters them',
		'A sit-down blockade will stop the march: get squads onto it before the march arrives; officers carry the sitters off one by one', 'Reinforcements (F) come from PU Ljubljana and PP Center: call them early' ];

	async setup() {

		const W = this.world, P = W.places, M = W.marks;
		await W.exits();
		this.focus = [ 280, 270 ];
		this.zoom = 0.7;
		this.opinion = 60;
		this.gasOpinion = - 5;
		this.waterOpinion = - 3;
		this.resources = { gas: { left: 2, max: 2 }, water: { left: 2, max: 2 }, reinforce: { left: 14, max: 14, cooldown: 15, ready: 0 } };
		this.crowd.u.holdRestraint.value = 0.12; // lines along a peaceful march push, they do not strike
		this.route = polyline( PRIDE_ROUTE );
		this.gaunt = polyline( PRIDE_GAUNTLET );
		this.legS = PRIDE_LEGS.map( ( [ x, y ] ) => project( this.route, x, y ) );
		this.goal = W.spot( PRIDE_LEGS.at( - 1 )[ 0 ], PRIDE_LEGS.at( - 1 )[ 1 ], 6 );

		// the march at Metelkova: the banner bloc and the rest, waiting
		const start = P[ 'Metelkova' ];
		const [ banner ] = await W.bloc( { kind: 'march', label: 'Pride banner', at: start, n: 200, groupSize: 200, spread: 12, goal: start, goalR: 30, mode: MODE.HOLD,
			agitation: [ 0.02, 0.12 ], resolve: [ 1.0, 1.3 ], morale: 0.8, speed: [ 1, 1 ] } );
		this.march = [ banner, ...await W.bloc( { kind: 'march', label: 'Pride march', at: start, n: PRIDE_N - 200, groupSize: 100, spread: 45, goal: start, goalR: 30,
			mode: MODE.HOLD, agitation: [ 0.02, 0.15 ], resolve: [ 0.8, 1.2 ], morale: 0.7, speed: [ 1, 1 ] } ) ];
		this.banner = { group: banner, pos: start, bearers: 1 };
		this.crowd.u.parting.value = banner.id;

		// the counter-protest: 7 groups on each pavement of the gauntlet, three deep along the building line
		this.clusters = [];
		const pave = [];
		for ( let k = 0; k < 7; k ++ ) for ( const side of [ - 1, 1 ] ) {

			const s = 20 + k * 60 + ( side > 0 ? 25 : 0 );
			const c = this.pavement( s, side );
			if ( c ) { this.clusters.push( c ); pave.push( { x: c.at[ 0 ], y: c.at[ 1 ], r: 6 } ); }

		}

		const paveLayer = await this.flow().request( 'pride-pavements', pave, { pinned: true } );
		for ( const c of this.clusters ) {

			[ c.g ] = await W.placeBloc( { faction: FACTION.COUNTER, kind: 'counter', label: 'Counter-protest', points: c.points, groupSize: c.points.length,
				layer: paveLayer, mode: MODE.HOLD, agitation: [ 0.1, 0.3 ], resolve: [ 0.8, 1.1 ], morale: 0.6 } );
			Object.assign( c, { tension: 0, riotUntil: 0, peak: 0 } );

		}

		// police, pre-positioned: lines in front of every other pavement group (the march sees the rest unscreened until
		// you fill the gaps), reserves staged off the route at both ends and in the middle, cars at the staging points
		const posts = [];
		const lined = this.clusters.filter( ( c, k ) => k % 4 === 0 || k % 4 === 3 );
		for ( const c of lined ) {

			const sq = await squads( W, [ c.front ] );
			await W.lineSquads( sq, c.lineA, c.lineB, null );
			posts.push( c.front );

		}

		const staging = [ [ - 40, 705 ], [ - 40, 705 ], [ - 270, 415 ], [ - 270, 415 ], [ - 330, 30 ], [ - 330, 30 ], [ - 450, - 80 ], [ - 190, - 175 ] ];
		await squads( W, staging );
		posts.push( ...staging );
		await cars( W, [ [ - 20, 690 ], [ - 300, 40 ], [ - 200, - 190 ] ] );
		await W.patrols.add( { at: [ - 315, 20 ], water: true } ); // staged mid-gauntlet with the Cankarjeva reserves
		// every squad on one shared field: formation officers walk straight to slots within 30 m, so this field is never
		// followed while they stand; it only keeps the layer pool free for orders (and is what settle() returns them to)
		this.postLayer = await this.flow().request( 'pride-posts', posts.map( ( [ x, y ] ) => ( { x, y, r: 15 } ) ), { pinned: true } );
		for ( const s of W.groupsOf( FACTION.POLICE ) ) if ( s.kind === 'squad' ) W.setLayer( s, this.postLayer );

		// attack groups: four of the side streets, in route order; the blockade halfway down the gauntlet
		const sides = [ ...PRIDE_SIDE ].sort( () => Math.random() - 0.5 ).slice( 0, 4 );
		this.attacks = sides.map( ( [ name, j, up ] ) => {

			const d = Math.hypot( up[ 0 ] - j[ 0 ], up[ 1 ] - j[ 1 ] );
			const lurk = W.roadSpot( j[ 0 ] + ( up[ 0 ] - j[ 0 ] ) / d * 65, j[ 1 ] + ( up[ 1 ] - j[ 1 ] ) / d * 65, 30 ) ?? j;
			return { name, junction: j, lurk, s: project( this.route, ...j ), state: 'wait' };

		} ).sort( ( a, b ) => a.s - b.s );
		const into = pick( [ 150, 250 ] ), bs = project( this.route, ...PRIDE_GAUNTLET[ 0 ] ) + into;
		this.block = { s: bs, at: along( this.route.pts, this.route.cum, bs ), name: into < 200 ? 'Nebotičnik' : 'Cankarjeva', state: 'wait' };

		this.pending = [];
		this.halted = false;
		this.bannerS = 0;
		this.arrests = { march: 0, counter: 0, violent: 0, blockade: 0, brawler: 0 };
		await this.bystanders( 1500 );

	}

	flow() { return this.world.flow; }

	// a pavement group at distance s along the gauntlet on one side (−1 west, +1 east): walls found from the SDF, three rows
	// along the building line, the frontage line 4.5 m out toward the street
	pavement( s, side ) {

		const W = this.world, G = this.gaunt;
		const p = along( G.pts, G.cum, s ), q = along( G.pts, G.cum, s + 2 );
		const l = Math.hypot( q[ 0 ] - p[ 0 ], q[ 1 ] - p[ 1 ] ) || 1;
		const tx = ( q[ 0 ] - p[ 0 ] ) / l, ty = ( q[ 1 ] - p[ 1 ] ) / l;
		// normal pointing to this side: heading south-south-west, west is to the right
		const nx = ty * - side, ny = - tx * - side;
		let wall = 0;
		while ( wall < 22 && W.sdf( p[ 0 ] + nx * wall, p[ 1 ] + ny * wall ) > 0.6 ) wall += 0.5;
		wall = Math.min( wall, 16 );
		if ( wall < 7 ) return null;
		const points = [];
		for ( let r = 0; r < 3; r ++ ) for ( let a = - 8.25; a <= 8.3; a += 1.5 ) {

			const d = wall - 1.2 - r * 1.0, x = p[ 0 ] + nx * d + tx * a, y = p[ 1 ] + ny * d + ty * a;
			if ( W.sdf( x, y ) > 0.5 ) points.push( [ x, y ] );

		}

		if ( points.length < 20 ) return null;
		const fd = wall - 5.6; // the frontage line, between them and the street, leaving the carriageway to the march
		const f = [ p[ 0 ] + nx * fd, p[ 1 ] + ny * fd ];
		return { s, side, points, at: [ p[ 0 ] + nx * ( wall - 2.2 ), p[ 1 ] + ny * ( wall - 2.2 ) ], t: [ tx, ty ], n: [ - nx, - ny ], wall,
			front: f, lineA: [ f[ 0 ] - tx * 11, f[ 1 ] - ty * 11 ], lineB: [ f[ 0 ] + tx * 11, f[ 1 ] + ty * 11 ] };

	}

	start() {

		this.after( 2, () => this.event( 'The march sets off from Metelkova at 18:00 (in 1:00). Fill the gaps along Slovenska before it gets there', 'info', this.march[ 0 ].center ) );
		this.after( 8, () => this.event( 'Blue lines stand in front of every other pavement group; the others are unscreened', 'info', PRIDE_GAUNTLET[ 2 ] ) );
		this.after( PRIDE_DEPART, () => {

			this.event( 'The Pride march sets off along Masarykova', 'good', this.march[ 0 ].center );
			// a column: the banner first, then the groups closest to the way out
			const first = PRIDE_LEGS[ 0 ];
			const order = [ this.march[ 0 ], ...this.march.slice( 1 ).sort( ( a, b ) => Math.hypot( a.center[ 0 ] - first[ 0 ], a.center[ 1 ] - first[ 1 ] ) - Math.hypot( b.center[ 0 ] - first[ 0 ], b.center[ 1 ] - first[ 1 ] ) ) ];
			order.forEach( ( g, k ) => this.after( k * 2.5, () => { g.leg = 0; g.started = true; this.lead( g ); } ) );

		} );

	}

	commands() { return this.policeCommands(); }

	// failing to protect the march is what costs here: brawl injuries weigh heavily, arrests are judged by who (arrestTick)
	opinionWeights() {

		return { injByPolice: - 0.5, injPolice: 0.2, arrested: 0, arrestedSitters: 0, injOther: - 0.3 };

	}

	get clock() {

		const min = this.t < PRIDE_DEPART ? 17 * 60 + this.t / PRIDE_DEPART * 60 : 18 * 60 + ( this.t - PRIDE_DEPART ) / PRIDE_HOUR * 60;
		return `${Math.floor( min / 60 )}:${String( Math.floor( min % 60 ) ).padStart( 2, '0' )}`;

	}

	// send a march group to its current leg (faster on the boulevard), unless the march is halted
	lead( g ) {

		const [ x, y, r ] = PRIDE_LEGS[ g.leg ];
		this.crowd.setGroup( g.id, { speed: g.leg < PRIDE_FAST ? 2.0 : 1.3 } );
		if ( this.halted ) return;
		this.world.march( [ g ], x, y, r );

	}

	marchers() { return this.march.reduce( ( n, g ) => n + ( g.alive ?? 0 ), 0 ); }

	tick( dt ) {

		const W = this.world, I = W.intel;
		if ( I && I !== this._intel ) {

			const di = this._intelT ? this.t - this._intelT : 0;
			this._intel = I;
			this._intelT = this.t;
			this.marchTick();
			this.bannerTick( I, di );
			this.tensionTick( I, di );
			this.attackTick();
			this.blockTick();
			this.arrestTick( I );
			if ( this.t - ( this._settle ?? 0 ) > 5 ) { this._settle = this.t; this.settle(); }

		}

		const B = this.banner;
		const n = this.marchers();
		this.peakMarch = Math.max( this.peakMarch ?? 0, n );
		if ( B.group && near( B.pos, this.goal, 40 ) ) { // the march's field stops within 30 m of the square

			this.arrived = n;
			this.end( true, `The banner reached Kongresni trg at ${this.clock} with ${Math.round( n / PRIDE_N * 100 )} % of the march behind it.` );

		} else if ( B.lost ) this.end( false, 'The banner was torn from the march and carried off. The images go round the world.' );
		else if ( this.t > PRIDE_DEPART && n < PRIDE_N * 0.4 ) this.end( false, 'The march has fallen apart: too many went home, hurt or afraid.' );
		else if ( this.t >= PRIDE_LIMIT ) this.end( false, 'It is 19:30 and the march never reached Kongresni trg.' );

	}

	// march groups move from leg to leg as their centre gets close to the leg's goal; marshals keep them calm (a
	// Pride march that is attacked closes up, it does not go hunting the counter-protest)
	marchTick() {

		for ( const g of this.march ) {

			if ( g.agitation > 0.25 ) for ( const i of g.members ) this.crowd.nudge( i, - 0.06 - ( g.agitation - 0.25 ) * 0.15, 0 );
			if ( ! g.started || ! g.center || ! ( g.alive > 0 ) ) continue;
			g.s = project( this.route, ...g.center );
			if ( g.leg < PRIDE_LEGS.length - 1 && g.s > this.legS[ g.leg ] - 30 ) { g.leg ++; this.lead( g ); }

		}

	}

	// the banner follows its bearer (the bloc's leader); if the bearer falls it lies in the street until marchers pick it up,
	// or attackers stand over it for 8 s with no police there and carry it off
	bannerTick( I, dt ) {

		const W = this.world, B = this.banner;
		if ( B.group ) {

			const g = B.group;
			if ( g.leaderState === 'active' && ( g.alive ?? 0 ) > 0 ) {

				B.pos = g.leaderPos;
				this.bannerS = project( this.route, ...B.pos );
				this.crowd.u.parting.value = g.id;
				// whoever carries the banner does not go home
				if ( this.t - ( B.steady ?? 0 ) > 5 ) { B.steady = this.t; for ( const i of g.members ) this.crowd.recall( i, 0.6 ); }
				return;

			}
			B.group = null;
			B.held = 0;
			this.crowd.u.parting.value = - 1;
			this.event( 'The banner bearer is down: the banner is lying in the street!', 'bad', B.pos );

		}

		const prot = W.countNear( ...B.pos, 8, FACTION.PROTESTER ), ctr = W.countNear( ...B.pos, 8, FACTION.COUNTER ), pol = W.countNear( ...B.pos, 8, FACTION.POLICE );
		B.held = ctr >= 4 && prot < ctr && pol < 3 ? ( B.held ?? 0 ) + dt : 0;
		if ( B.held > 8 ) { B.lost = true; return; }
		if ( prot < 5 || ctr >= prot ) return;
		let bi = - 1, bd = 64;
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
			const d = ( I.pos[ i * 2 ] - B.pos[ 0 ] ) ** 2 + ( I.pos[ i * 2 + 1 ] - B.pos[ 1 ] ) ** 2;
			if ( d < bd ) { bd = d; bi = i; }

		}

		const g = bi >= 0 && W.groups[ I.st[ bi * 4 + 1 ] ];
		if ( ! g || g.kind !== 'march' ) return;
		if ( g.leaderState !== 'active' || g.leader !== bi ) {

			this.crowd.regroup( bi, g.id, ROLE.LEADER );
			this.crowd.setGroup( g.id, { leader: bi } );
			Object.assign( g, { leader: bi, leaderState: 'active', leaderPos: [ I.pos[ bi * 2 ], I.pos[ bi * 2 + 1 ] ] } );

		}

		B.group = g;
		B.bearers ++;
		this.event( `Marchers picked the banner up again (${g.label})`, 'good', B.pos );

	}

	// Tension per pavement group: rises while ≥ 8 marchers are within 22 m and the frontage is not screened by officers
	// standing between them and the street; falls slowly otherwise. Past ½ both sides get angrier; at 1 that stretch
	// boils over (RIOT) for 45 s and the marchers nearby lose heart.
	tensionTick( I, dt ) {

		if ( ! dt ) return;
		const W = this.world, pos = I.pos, st = I.st;
		for ( const c of this.clusters ) {

			const g = c.g;
			if ( ! ( g.alive > 3 ) ) continue;
			const [ cx, cy ] = c.at, [ tx, ty ] = c.t, [ nx, ny ] = c.n;
			let march = 0, screen = 0;
			const close = [];
			for ( let i = 0; i < this.crowd.count; i ++ ) {

				const f = st[ i * 4 ];
				if ( f !== FACTION.PROTESTER && f !== FACTION.POLICE ) continue;
				const dx = pos[ i * 2 ] - cx, dy = pos[ i * 2 + 1 ] - cy;
				if ( dx * dx + dy * dy > 22 * 22 ) continue;
				if ( f === FACTION.PROTESTER ) { march ++; close.push( i ); continue; }
				const a = dx * tx + dy * ty, o = dx * nx + dy * ny;
				if ( Math.abs( a ) < 13 && o > 0.8 && o < 9 ) screen ++;

			}

			const cover = Math.min( 1, screen / PRIDE_SCREEN );
			c.cover = cover;
			const exposed = march >= 8 ? ( 1 - cover ) ** 1.5 : 0;
			c.exposed = exposed > 0.15;
			c.tension = Math.max( 0, Math.min( 1, c.tension + ( exposed > 0.05 ? exposed / PRIDE_BOIL : - 1 / PRIDE_COOL ) * dt ) );
			c.peak = Math.max( c.peak, c.tension );
			if ( c.tension > 0.5 && exposed > 0.05 ) {

				for ( const i of g.members ) this.crowd.nudge( i, 0.03 * c.tension * dt, 0 );
				for ( const i of close ) if ( Math.random() < 0.3 ) this.crowd.nudge( i, 0.02 * dt, 0 );
				if ( ! c.warned ) { c.warned = true; this.event( 'Insults fly on Slovenska: a pavement group is boiling — screen it', 'warn', c.at ); }

			}

			if ( c.tension < 0.3 ) c.warned = false;
			if ( c.tension >= 1 && ! c.riotUntil ) {

				c.riotUntil = this.t + 45;
				W.setMode( [ g ], MODE.RIOT );
				for ( const i of g.members ) this.crowd.nudge( i, 0.6, 0.3 );
				this.counters.brawls = ( this.counters.brawls ?? 0 ) + 1;
				this.nudgeOpinion( - 3, 'brawl at Pride' );
				this.event( 'The counter-protest has gone for the march: a brawl on Slovenska!', 'bad', c.at );
				// marchers close by: some fight back, most are shaken
				for ( const q of this.march ) {

					if ( ! q.center || ! near( q.center, c.at, 45 ) ) continue;
					for ( const i of q.members ) this.crowd.nudge( i, Math.random() < 0.15 ? 0.5 : 0.05, q === this.banner.group ? 0 : - 0.35 );

				}

			}

			if ( c.riotUntil && this.t > c.riotUntil && g.agitation < 0.55 ) {

				c.riotUntil = 0;
				c.tension = 0.5;
				W.setMode( [ g ], MODE.HOLD );
				this.event( 'The brawl on Slovenska has died down', 'info', c.at );

			}

		}

	}

	// attack groups: announced when the banner is ~200 m from their side street (one a minute at most), they gather
	// there for at least 45 s, then go for the march (the banner if it is close); broken when fewer than 5 are left,
	// scattered by ≥ 12 officers close by (before or during the attack), home after 75 s
	attackTick() {

		const W = this.world;
		for ( const a of this.attacks ) {

			if ( a.state === 'wait' && this.bannerS > a.s - 200 && this.t - ( this.lastAttack ?? - 99 ) > 60 ) {

				a.state = 'spawning';
				this.lastAttack = this.t;
				a.from = this.t;
				W.bloc( { faction: FACTION.COUNTER, kind: 'violent', label: `Attackers · ${a.name}`, at: a.lurk, n: 22, groupSize: 22, spread: 6, goal: a.lurk, goalR: 8,
					mode: MODE.HOLD, agitation: [ 0.6, 0.8 ], resolve: [ 1.1, 1.4 ], morale: 0.9, speed: [ 1.1, 1.25 ] } ).then( ( [ g ] ) => { a.g = g; a.state = 'gather'; } );
				this.pending.push( { at: a.lurk, r: 14, label: `attackers · ${a.name}`, until: this.t + 45 } );
				this.event( `A violent group is gathering in ${a.name} ulica — they will go for the march`, 'bad', a.lurk );

			} else if ( a.state === 'gather' && a.g?.center && W.countNear( ...a.g.center, 14, FACTION.POLICE ) >= 12 && Math.random() < 0.3 ) {

				// officers on them before they move: they give up and go
				a.state = 'gone';
				this.sendHome( a.g );
				W.setMode( [ a.g ], MODE.DISPERSE );
				this.event( `The ${a.name} group gives up with police on top of them`, 'good', a.g.center );

			} else if ( a.state === 'gather' && this.t - a.from > 45 && ( this.bannerS > a.s - 70 || this.t - a.from > 150 ) ) {

				a.state = 'strike';
				a.struck = this.t;
				W.setMode( [ a.g ], MODE.RIOT );
				this.event( `The ${a.name} group is attacking!`, 'bad', a.g.center ?? a.lurk );

			}

			if ( a.state !== 'strike' || ! a.g ) continue;
			if ( ! ( a.g.alive >= 5 ) ) { a.state = 'broken'; this.event( `The ${a.name} attackers are broken up`, 'good', a.g.center ); continue; }
			if ( this.t - a.struck > 75 ) { a.state = 'gone'; this.sendHome( a.g ); W.setMode( [ a.g ], MODE.MARCH ); this.event( `The ${a.name} attackers melt away`, 'info', a.g.center ); continue; }
			// officers arriving in numbers scatter them
			if ( W.countNear( ...a.g.center, 12, FACTION.POLICE ) >= 12 && Math.random() < 0.4 ) {

				a.state = 'gone';
				this.sendHome( a.g );
				W.setMode( [ a.g ], MODE.DISPERSE );
				this.event( `Police scatter the ${a.name} attackers`, 'good', a.g.center );
				continue;

			}

			// head for the banner if it is within reach, else the nearest marchers; re-aimed every 4 s
			if ( this.t - ( a.aimed ?? 0 ) < 4 || ! a.g.center ) continue;
			a.aimed = this.t;
			const B = this.banner;
			let goal = near( B.pos, a.g.center, 140 ) ? B.pos : null;
			if ( ! goal ) {

				let bd = Infinity;
				for ( const q of this.march ) if ( q.center && q.alive > 0 ) { const d = Math.hypot( q.center[ 0 ] - a.g.center[ 0 ], q.center[ 1 ] - a.g.center[ 1 ] ); if ( d < bd ) { bd = d; goal = q.center; } }

			}

			if ( goal ) { W.march( [ a.g ], goal[ 0 ], goal[ 1 ], 6 ); W.setMode( [ a.g ], MODE.RIOT ); }

		}

	}

	// the sit-down blockade: announced 40 s ahead when the banner is ~320 m away, then 60 people sit across the street.
	// While ≥ 15 of them are still sitting within 30 m ahead of the banner, the march stops (fewer, it squeezes past).
	blockTick() {

		const W = this.world, K = this.block;
		if ( K.state === 'wait' && this.bannerS > K.s - 320 ) {

			K.state = 'announced';
			this.pending.push( { at: K.at, r: 16, label: 'sit-down blockade', until: this.t + 40 } );
			this.event( `Counter-protesters are about to sit down in the road at ${K.name} (0:40)`, 'warn', K.at );
			this.after( 40, async () => {

				const [ a, b ] = W.across( ...K.at, 24 );
				const len = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ), ux = ( b[ 0 ] - a[ 0 ] ) / len, uy = ( b[ 1 ] - a[ 1 ] ) / len;
				const pts = [];
				for ( let r = 0; r < 4; r ++ ) for ( let k = 0; k < 15; k ++ ) {

					const d = 1.5 + ( len - 3 ) * k / 14, o = ( r - 1.5 ) * 1.3;
					const x = a[ 0 ] + ux * d - uy * o, y = a[ 1 ] + uy * d + ux * o;
					if ( W.sdf( x, y ) > 0.5 ) pts.push( [ x, y ] );

				}

				K.g = ( await W.placeBloc( { faction: FACTION.COUNTER, kind: 'blockade', label: 'Blockade', points: pts, groupSize: pts.length, mode: MODE.SIT,
					agitation: [ 0.05, 0.15 ], resolve: [ 0.9, 1.2 ], morale: 0.8, sitters: true } ) )[ 0 ];
				K.state = 'sitting';
				this.event( `A sit-down blockade at ${K.name}: the march will stop there until the road is cleared`, 'bad', K.at );

			} );

		}

		if ( K.state !== 'sitting' ) return;
		this.carryOff( K );
		const sitting = W.countNear( ...K.at, 15, FACTION.COUNTER );
		const close = this.bannerS > K.s - 30 && this.bannerS < K.s + 5;
		if ( ! this.halted && close && sitting >= 15 ) {

			this.halted = true;
			this.haltedAt = this.t;
			W.setMode( this.march.filter( ( g ) => g.started ), MODE.HOLD );
			this.event( 'The march has stopped at the blockade', 'warn', K.at );

		} else if ( this.halted && sitting < 15 ) {

			this.halted = false;
			K.state = 'cleared';
			this.counters.halted = ( this.counters.halted ?? 0 ) + this.t - this.haltedAt;
			for ( const g of this.march ) if ( g.started ) this.lead( g );
			this.event( 'The road is clear: the march moves on', 'good', K.at );

		}

	}

	// officers carry sitters off the road: a sitter with an officer within 2.2 m for 4 s is detained (a dense sit-in
	// would never yield to the kernel's arrests: packed neighbours hold each other)
	carryOff( K ) {

		const I = this.world.intel, dt = this.t - ( K.lastT ?? this.t );
		K.lastT = this.t;
		K.prog ??= new Map();
		for ( const i of K.g.members ) {

			if ( I.st[ i * 4 ] !== FACTION.COUNTER ) { K.prog.delete( i ); continue; }
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
			let n = 0;
			for ( let j = 0; j < this.crowd.count && ! n; j ++ ) if ( I.st[ j * 4 ] === FACTION.POLICE && ( I.pos[ j * 2 ] - x ) ** 2 + ( I.pos[ j * 2 + 1 ] - y ) ** 2 < 4.84 ) n ++;
			const p = n ? ( K.prog.get( i ) ?? 0 ) + dt : Math.max( 0, ( K.prog.get( i ) ?? 0 ) - dt );
			K.prog.set( i, p );
			if ( p >= 4 ) { this.crowd.setFaction( i, FACTION.ARRESTED_SITTER ); K.prog.delete( i ); }

		}

	}

	// who was arrested: calm marchers (very bad), the peaceful counter-protest (bad), attackers (good), the blockade
	// (neutral); anyone detained mid-brawl (agitation ≥ 0.5) counts as a brawler, whichever side
	arrestTick( I ) {

		const st = I.st, n = this.crowd.count;
		if ( ! this.prevF || this.prevF.length < n ) { const p = new Float32Array( n ); if ( this.prevF ) p.set( this.prevF ); this.prevF = p; }
		const cost = { march: [ - 1, 'police arresting Pride marchers' ], counter: [ - 0.6, 'arresting peaceful counter-protesters' ], violent: [ 0.4, 'attackers arrested' ],
			blockade: [ - 0.05, '' ], brawler: [ - 0.1, '' ] };
		let d = 0, why = '', marchAt = null;
		for ( let i = 0; i < n; i ++ ) {

			const f = st[ i * 4 ];
			if ( ( f === FACTION.ARRESTED || f === FACTION.ARRESTED_SITTER ) && this.prevF[ i ] >= 0 ) {

				const g = this.world.groups[ st[ i * 4 + 1 ] ];
				const kind = g?.kind === 'counter' && g.mode === MODE.RIOT ? 'violent' : ( g?.kind === 'march' || g?.kind === 'counter' ) && st[ i * 4 + 2 ] >= 0.5 ? 'brawler' : g?.kind;
				if ( cost[ kind ] ) { this.arrests[ kind ] ++; d += cost[ kind ][ 0 ]; if ( cost[ kind ][ 1 ] && ( ! why || cost[ kind ][ 0 ] < 0 ) ) why = cost[ kind ][ 1 ]; }
				if ( kind === 'march' ) marchAt = [ I.pos[ i * 2 ], I.pos[ i * 2 + 1 ] ];

			}

			this.prevF[ i ] = f;

		}

		if ( marchAt && this.t - ( this._marchArrestMsg ?? - 99 ) > 20 ) {

			this._marchArrestMsg = this.t;
			this.event( 'Officers are detaining Pride marchers: get squads out of the march\'s way', 'bad', marchAt );

		}

		this.arrestOpinion = ( this.arrestOpinion ?? 0 ) + d;
		if ( Math.abs( this.arrestOpinion ) >= 1 ) { const k = Math.trunc( this.arrestOpinion ); this.nudgeOpinion( k, why ); this.arrestOpinion -= k; }

	}

	// idle squads standing at their post go back on the shared field (keeps the flow-field pool free for orders)
	settle() {

		for ( const s of this.world.groupsOf( FACTION.POLICE ) ) {

			if ( s.kind === 'squad' && s.mode === MODE.FORMATION && ! s.snatch && s.center && s.anchor && near( s.center, s.anchor, 25 ) ) this.world.setLayer( s, this.postLayer );

		}

	}

	phase() {

		const B = this.banner, left = Math.max( 0, this.route.len - this.bannerS );
		if ( this.t < PRIDE_DEPART ) return `${this.clock} · the march sets off in ${fmt( PRIDE_DEPART - this.t )}`;
		return `${this.clock} · ${B.group ? `banner ${Math.round( left )} m from Kongresni trg` : 'BANNER IN THE STREET'}${this.halted ? ' · MARCH HALTED' : ''}`;

	}

	objectives() {

		const B = this.banner, n = this.marchers(), share = n / PRIDE_N, hot = Math.max( 0, ...this.clusters.map( ( c ) => c.tension ) );
		const hurt = this.counters.injByPolice + this.counters.injOther;
		return [
			{ label: 'Banner to Kongresni trg', value: Math.min( 1, this.bannerS / this.route.len ), text: B.group ? `${Math.round( Math.max( 0, this.route.len - this.bannerS ) )} m` : 'dropped!', state: ! B.group ? 'bad' : this.halted ? 'warn' : 'ok' },
			{ label: '★ March together (≥ 70 %)', value: Math.min( 1, share ), text: `${n}`, state: share < 0.5 ? 'bad' : share < 0.7 ? 'warn' : 'ok' },
			{ label: 'Hottest stretch of pavement', value: hot, text: `${Math.round( hot * 100 )}%`, state: hot > 0.7 ? 'bad' : hot > 0.4 ? 'warn' : 'ok', invert: true },
			{ label: '★ Injured ≤ 25, opinion ≥ 50', value: Math.min( 1, hurt / 25 ), text: `${hurt} · ${Math.round( this.opinion )}`, state: hurt > 25 || this.opinion < 50 ? 'bad' : 'ok', invert: true },
		];

	}

	score( win ) {

		const n = this.arrived ?? this.marchers(), hurt = this.counters.injByPolice + this.counters.injOther;
		const s2 = win && n >= PRIDE_N * 0.7, s3 = win && hurt <= 25 && this.opinion >= 50;
		return { stars: win + s2 + s3, lines: [
			[ 'Arrived', this.clock ], [ 'Marchers with the banner', `${n} (${Math.round( n / PRIDE_N * 100 )} %)` ], [ 'Brawls on Slovenska', this.counters.brawls ?? 0 ],
			[ 'Injured in brawls and attacks', this.counters.injOther ], [ 'Injuries caused by police', this.counters.injByPolice ], [ 'Officers injured', this.counters.injPolice ],
			[ 'Attackers arrested', this.arrests.violent ], [ 'Peaceful counter-protesters arrested', this.arrests.counter ], [ 'Blockade cleared', this.block.state === 'cleared' ? `yes (${fmt( this.counters.halted ?? 0 )} halted)` : 'no' ],
			[ 'Banner bearers', this.banner.bearers ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const ctx = o.ctx;
		// the route ahead of the banner, dashed
		ctx.setLineDash( [ 4, 8 ] );
		ctx.strokeStyle = 'rgba(255,106,16,0.45)';
		ctx.lineWidth = 2;
		ctx.beginPath();
		let first = true;
		for ( let s = this.bannerS; s <= this.route.len; s += 10 ) { const [ x, y ] = o.toScreen( ...along( this.route.pts, this.route.cum, s ) ); first ? ctx.moveTo( x, y ) : ctx.lineTo( x, y ); first = false; }
		ctx.stroke();
		ctx.setLineDash( [] );
		this.drawZone( o, this.goal[ 0 ], this.goal[ 1 ], 30, ORANGE, 'KONGRESNI TRG · 19:00', 0.05 );

		// pavement groups: a bar along the building line, white → amber → red with tension; blue tick when screened
		for ( const c of this.clusters ) {

			if ( ! ( c.g.alive > 3 ) ) continue;
			const t = c.tension, [ tx, ty ] = c.t, [ x, y ] = c.at;
			const [ ax, ay ] = o.toScreen( x - tx * 9, y - ty * 9 ), [ bx, by ] = o.toScreen( x + tx * 9, y + ty * 9 );
			ctx.strokeStyle = c.riotUntil ? RED : t > 0.5 ? `rgba(255,${Math.round( 176 - ( t - 0.5 ) * 260 )},40,0.95)` : `rgba(233,228,216,${0.35 + t})`;
			ctx.lineWidth = c.riotUntil ? 5 : 3;
			ctx.beginPath(); ctx.moveTo( ax, ay ); ctx.lineTo( bx, by ); ctx.stroke();
			if ( t > 0.25 || c.riotUntil ) {

				const [ sx, sy ] = o.toScreen( x + c.n[ 0 ] * - 6, y + c.n[ 1 ] * - 6 );
				ctx.fillStyle = c.riotUntil ? RED : 'rgb(255,176,32)';
				ctx.font = '600 10px "IBM Plex Mono", monospace';
				ctx.textAlign = 'center';
				ctx.fillText( c.riotUntil ? 'BRAWL' : `${Math.round( t * 100 )}%`, sx, sy );

			}

		}

		// the banner: a flag over its bearer, or a pulsing marker where it fell
		const B = this.banner, [ x, y ] = o.toScreen( ...B.pos );
		if ( B.group ) {

			ctx.strokeStyle = ORANGE;
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( x, y - 26 ); ctx.stroke();
			const bands = [ '#e40303', '#ff8c00', '#ffed00', '#008026', '#004dff', '#750787' ];
			bands.forEach( ( c, k ) => { ctx.fillStyle = c; ctx.fillRect( x, y - 26 + k * 2, 18, 2 ); } );

		} else {

			const r = 10 + ( this.t * 2 % 1 ) * 12;
			ctx.strokeStyle = RED;
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.stroke();
			ctx.fillStyle = RED;
			ctx.font = '600 11px "IBM Plex Mono", monospace';
			ctx.textAlign = 'center';
			ctx.fillText( B.held > 0 ? `BANNER · taken in ${Math.ceil( 8 - B.held )} s` : 'BANNER', x, y - r - 4 );

		}

		// attackers waiting in their side streets, and the blockade
		for ( const a of this.attacks ) if ( a.state === 'gather' && a.g?.center ) this.drawZone( o, a.g.center[ 0 ], a.g.center[ 1 ], 14, RED, `ATTACKERS · ${a.name.toUpperCase()}`, 0.08 );
		if ( this.block.state === 'sitting' ) this.drawZone( o, this.block.at[ 0 ], this.block.at[ 1 ], 15, RED, 'BLOCKADE', 0.08 );
		this.pending = this.pending.filter( ( p ) => p.until > this.t );
		drawPending( o, this.pending, this.t );

	}

}

// ======================================================================================= RESCUE
// Protest side: a dissident Speaker addresses a big crowd from a stand on Kongresni trg, and the police mean to take
// them at any cost. When the first charge comes the Speaker leaves down Vegova, Hieronimova and Emonska for a car
// waiting on Krakovska; the crowd is their shield, and three AntiFa squads can take a police squad apart.

const RESCUE_STAND = [ - 205, - 178 ];
// the escape (OSM centre lines): the stand → Vegova → Trg francoske revolucije → Hieronimova → across Zoisova → Emonska → Krakovska
const RESCUE_ROUTE = [ [ - 205, - 178 ], [ - 191, - 245 ], [ - 201, - 278 ], [ - 216, - 338 ], [ - 233, - 402 ], [ - 245, - 446 ], [ - 264, - 497 ], [ - 277, - 508 ],
	[ - 289, - 521 ], [ - 294, - 534 ], [ - 298, - 548 ], [ - 301, - 605 ], [ - 302, - 620 ], [ - 299, - 632 ], [ - 295, - 645 ], [ - 294, - 675 ], [ - 297, - 688 ],
	[ - 307, - 719 ], [ - 310, - 730 ], [ - 316, - 759 ], [ - 318, - 772 ] ];
const RESCUE_LEGS = [ [ - 191, - 247 ], [ - 233, - 402 ], [ - 278, - 510 ], [ - 300, - 585 ], [ - 296, - 645 ] ]; // flow goals; the last leg is the car
const RESCUE_CARS = [ [ - 318, - 772, 'Emonska' ], [ - 84, - 760, 'Krakovski nasip' ] ]; // where the car waits: it moves round if the police get there
const RESCUE_EXITS = [ [ - 330, - 948 ], [ - 60, - 657 ], [ - 75, - 903 ] ]; // where it speeds off to
const RESCUE_FORCES = [ [ 'Slovenska', [ - 325, - 275 ] ], [ 'Šubičeva', [ - 322, - 88 ] ], [ 'Prešernov trg', [ - 62, - 76 ] ] ];
const RESCUE_POLICE_CARS = { Slovenska: [ - 372, - 385 ], Barjanska: [ - 515, - 1300 ] };
const RESCUE_LIMIT = 900, RESCUE_STAR = 600, RESCUE_CHARGE = 75; // lose · ★ before · the first charge
const grid12 = ( [ x, y ] ) => [ Math.round( x / 12 ) * 12, Math.round( y / 12 ) * 12 ]; // police moves after the Speaker share fields
const ASSAULT_HIT = 0.2; // per readback (0.5 s) and per AntiFa member on an officer of the assaulted squad: chance the officer goes down
const ASSAULT_BREAK = 0.4;
const SNATCH_HOLD = 4, SNATCH_R = 2.5; // s of officers' hands on the Speaker to drag them out · how close counts
const CREW_LUNGE = 25; // a mobile squad goes for the Speaker when they come this close // a squad cut to this share of its officers breaks and runs back to Policija

export class RescueMission extends Mission {

	static id = 'rescue';
	static title = 'Rescue';
	static subtitle = 'Get the Speaker off Kongresni trg and into the car on Krakovska';
	static side = 'protest';
	static brief = `A dissident <b>Speaker</b> is addressing a big crowd from a stand in the middle of <b>Kongresni trg</b>. The police will not
		tolerate the speech: their orders are to take the Speaker at any cost. Riot squads are forming up on <b>Slovenska</b>, <b>Šubičeva</b> and
		<b>Prešernov trg</b>; they will charge, try to kettle the square and send snatch squads for the stand. When the first charge comes, the
		Speaker leaves down <b>Vegova</b>, <b>Hieronimova</b> and <b>Emonska</b> to a car waiting on <b>Krakovska</b>. Your crowd is the Speaker's
		shield: stand your ground, sit down, lock arms. Three <b>AntiFa</b> squads can take a police squad apart, but every officer hurt costs
		sympathy. Police cars will come along Slovenska and Barjanska with mobile squads.`;
	static goals = [ 'Get the Speaker into the rescue car', 'Do not let the police take the Speaker', 'Within 15:00', '★ Away before 10:00 · ★ Sympathy ≥ 50' ];
	static tips = [ 'Snatch squads are announced (red dashed rings): put people in their way, sit down (S) or lock arms (B) between them and the Speaker',
		'Officers who reach the Speaker drag them out in 4 s unless people crowd round; the escort in a shield wall (B) holds twice as long',
		'Mobile squads off the police cars go for the Speaker as soon as they come within 25 m: clear them first or go round',
		'Select an AntiFa squad and press A over a police squad: they go at it until it is broken. Each officer hurt costs sympathy',
		'The Speaker follows the escape route on their own; right-click them for a detour, they pick the route up again from there',
		'Send groups ahead down Vegova and Emonska: a police cordon across the street stops the Speaker, a crowd in the street stops the police',
		'If the police reach the car, it drives round to Krakovski nasip and the Speaker follows it', 'Be water (W) gets a group out of a closing kettle' ];

	async setup() {

		const W = this.world, S = RESCUE_STAND;
		await W.exits();
		this.crowd.u.revealLeaders.value = 1;
		this.opinion = 55;
		this.focus = [ - 215, - 250 ];
		this.zoom = 0.6;
		this.resources = { umbrella: { left: 3, max: 3 } };
		const a = Math.random() * Math.PI * 2, ws = rand( 0.3, 0.8 );
		W.wind = [ Math.cos( a ) * ws, Math.sin( a ) * ws ];
		this.route = polyline( RESCUE_ROUTE );
		this.counters.broken = 0;

		// everyone on the square shares one field toward the stand (holding groups only shuffle along it)
		const stand = await W.field( 'rescue-stand', S[ 0 ], S[ 1 ], 30, true );
		const [ speaker ] = await W.bloc( { kind: 'speaker', label: 'Speaker', at: S, n: 14, groupSize: 14, spread: 2, layer: stand, mode: MODE.HOLD,
			agitation: [ 0, 0.05 ], resolve: [ 1.5, 2 ], morale: 0.95, speed: [ 1.3, 1.3 ] } );
		speaker.closed = true;
		this.sp = { group: speaker, pos: S, s: 0, leg: - 1, carriers: 0 };
		this.crowd.u.parting.value = speaker.id;
		await W.bloc( { kind: 'stewards', label: 'Stewards', at: S, n: 120, groupSize: 40, spread: 10, layer: stand, mode: MODE.HOLD, agitation: [ 0.05, 0.15 ], resolve: [ 1.0, 1.3 ], morale: 0.85 } );
		await W.bloc( { kind: 'crowd', label: 'Listeners', at: [ S[ 0 ] + 5, S[ 1 ] + 15 ], n: 2200, groupSize: 100, spread: 42, layer: stand, mode: MODE.HOLD, morale: 0.6 } );
		this.antifa = [];
		for ( const [ k, at ] of [ [ - 255, - 140 ], [ - 150, - 140 ], [ - 160, - 225 ] ].entries() ) {

			this.antifa.push( ...await W.bloc( { kind: 'antifa', label: `AntiFa ${k + 1}`, at, n: 24, groupSize: 24, spread: 4, layer: stand, mode: MODE.HOLD,
				agitation: [ 0.35, 0.5 ], resolve: [ 1.3, 1.6 ], morale: 0.9, speed: [ 1.2, 1.25 ] } ) );

		}

		for ( const q of this.antifa ) q.closed = true;

		await W.bloc( { kind: 'medics', label: 'Medics', at: [ S[ 0 ], S[ 1 ] - 25 ], n: 20, groupSize: 20, spread: 6, layer: stand, mode: MODE.HOLD, agitation: [ 0, 0.05 ], morale: 0.9, resolve: [ 1.0, 1.3 ] } );

		this.carSpots = RESCUE_CARS.map( ( [ x, y ] ) => W.patrols.snap( x, y ) ?? [ x, y ] );
		this.carAt = 0;
		this.car = await W.patrols.add( { at: this.carSpots[ 0 ], crew: 0, selectable: false, label: 'Rescue car', civil: true } );
		this.ai = new RescuePolice( this );
		await this.ai.setup();
		await this.bystanders( 800 );

	}

	start() {

		this.after( 2, () => this.event( 'The Speaker is on the stand. Riot squads are forming up on Slovenska, Šubičeva and Prešernov trg', 'info', RESCUE_STAND ) );
		this.after( 14, () => this.event( 'When the police charge, the Speaker leaves down Vegova for the car on Krakovska: keep the way clear', 'info', RESCUE_LEGS[ 0 ] ) );
		this.after( RESCUE_CHARGE - 30, () => this.event( 'The riot squads are lining up: the charge is coming', 'warn', RESCUE_FORCES[ 0 ][ 1 ] ) );

	}

	commands() {

		return [ ...this.protestCommands(), { key: 'a', label: 'Assault', hint: 'AntiFa only: attack the police squad at the cursor',
			desc: 'AntiFa squads only: sprint at the police squad nearest the cursor and stay on it until it breaks (at 40 % down). Every order and every officer hurt costs sympathy', needsSel: true, run: ( x, y ) => this.assault( x, y ) } ];

	}

	opinionWeights() {

		return { injByPolice: 0.15, injPolice: - 0.3, arrested: 0.02, arrestedSitters: 0.05, injOther: - 0.1 };

	}

	// the escort is not merged away (the Speaker would become an ordinary member of another group)
	mergeSel() {

		const sp = this.sp.group;
		if ( this.game.selected.includes( sp ) ) { this.game.selected = this.game.selected.filter( ( q ) => q !== sp ); this.event( 'The Speaker\'s escort stays together', 'info' ); }
		super.mergeSel();

	}

	// the Speaker's own group never picks a new "Speaker" by itself: they are carried (speakerTick) or taken
	succession() {

		this.sp.group.succession = Infinity;
		super.succession();

	}

	tick( dt ) {

		const W = this.world, I = W.intel, P = this.sp;
		this.ai.tick( dt );
		if ( I && I !== this._intel ) {

			const di = this._intelT ? this.t - this._intelT : 0;
			this._intel = I;
			this._intelT = this.t;
			this.speakerTick( I, di );
			this.escapeTick();
			this.carTick( di );
			this.assaultTick( I );

		}

		if ( P.away ) this.end( true, `The Speaker got away at ${fmt( this.t )}${P.carried ? ', carried to the car by the crowd' : ''}.` );
		else if ( P.taken ) this.end( false, P.aboard ? 'The police stopped the car and dragged the Speaker out.' : 'The police took the Speaker.' );
		else if ( this.t >= RESCUE_LIMIT ) this.end( false, 'The police sealed off the district. The Speaker is trapped.' );

	}

	// the Speaker is the group's leader. Arrested: lost. Hurt (or their carrier hurt): on the ground until protesters lift them
	// (the nearest becomes the group's head and carries them, slower), or until police stand over them for 8 s
	speakerTick( I, dt ) {

		const W = this.world, P = this.sp, g = P.group;
		if ( P.aboard ) return;
		if ( ! P.down ) {

			if ( g.leaderState === 'active' && ( g.alive ?? 0 ) > 0 ) {

				P.pos = g.leaderPos;
				P.s = project( this.route, ...P.pos );
				if ( this.t - ( P.steady ?? 0 ) > 5 ) { P.steady = this.t; for ( const i of g.members ) this.crowd.recall( i, 0.8 ); }
				this.grabTick( dt );
				return;

			}

			if ( g.leaderState === 'arrested' ) { P.taken = true; return; }
			P.down = true;
			P.held = 0;
			this.crowd.u.parting.value = - 1;
			this.event( P.carried ? 'The people carrying the Speaker went down: the Speaker is on the ground!' : 'The Speaker is down! Get people round them before the police get there', 'bad', P.pos );

		}

		const prot = W.countNear( ...P.pos, 8, FACTION.PROTESTER ), pol = W.countNear( ...P.pos, 8, FACTION.POLICE );
		P.held = pol >= 4 && pol > prot ? P.held + dt : 0;
		if ( P.held > 8 ) { P.taken = true; return; }
		if ( prot < 4 || pol >= prot ) return;
		let bi = - 1, bd = 64;
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
			const d = ( I.pos[ i * 2 ] - P.pos[ 0 ] ) ** 2 + ( I.pos[ i * 2 + 1 ] - P.pos[ 1 ] ) ** 2;
			if ( d < bd ) { bd = d; bi = i; }

		}

		const from = bi >= 0 && W.groups[ I.st[ bi * 4 + 1 ] ];
		if ( ! from || ( from.kind === 'medics' && from !== g ) ) return;
		if ( from !== g ) { from.members = from.members.filter( ( i ) => i !== bi ); g.members.push( bi ); }
		this.crowd.regroup( bi, g.id, ROLE.LEADER );
		this.crowd.setGroup( g.id, { leader: bi, speed: 0.85 } );
		Object.assign( g, { leader: bi, leaderState: 'active', leaderPos: [ I.pos[ bi * 2 ], I.pos[ bi * 2 + 1 ] ], leaderReported: false } );
		P.down = false;
		P.carried = true;
		P.carriers ++;
		this.crowd.u.parting.value = g.id;
		this.event( 'The Speaker is up again: carried, and slower', 'good', P.pos );

	}

	// officers who get their hands on the Speaker drag them out unless there are enough bodies round them: ≥ 2 officers within
	// SNATCH_R who outnumber half the protesters there, for SNATCH_HOLD s (twice that while the escort locks arms)
	grabTick( dt ) {

		const W = this.world, P = this.sp;
		const pol = W.countNear( ...P.pos, SNATCH_R, FACTION.POLICE ), prot = W.countNear( ...P.pos, SNATCH_R, FACTION.PROTESTER ) - 1;
		if ( pol >= 2 && pol * 2 > prot ) {

			if ( ! P.grab && this.t - ( P.grabMsg ?? - 99 ) > 10 ) { P.grabMsg = this.t; this.event( 'Officers have hold of the Speaker! Get people round them', 'bad', P.pos ); }
			P.grab = ( P.grab ?? 0 ) + dt * Math.min( 2, pol / 2 ) * ( P.group.mode === MODE.SHIELD ? 0.5 : 1 );
			if ( P.grab >= SNATCH_HOLD ) P.taken = true;

		} else P.grab = Math.max( 0, ( P.grab ?? 0 ) - dt );

	}

	startEscape( why ) {

		const P = this.sp;
		if ( P.escaping ) return;
		P.escaping = true;
		P.leg = 0;
		this.crowd.setGroup( P.group.id, { speed: P.carried ? 0.85 : 1.3 } );
		this.event( why === 'charge' ? 'The Speaker leaves the stand: down Vegova, for the car on Krakovska' : 'The Speaker leaves the stand', 'warn', P.pos );
		if ( why !== 'detour' ) this.lead();
		this.ai.onEscape();

	}

	legs() { return [ ...RESCUE_LEGS, this.carSpots[ this.carAt ] ]; }

	// send the Speaker's group to its current leg (World.march sets g.goal once the field is ready: until then, no detour check)
	async lead() {

		const P = this.sp, g = P.group, [ x, y ] = this.legs()[ P.leg ];
		P.leading = true;
		await this.world.march( [ g ], x, y, P.leg === RESCUE_LEGS.length ? 3 : 6 );
		P.legGoal = g.goal;
		P.leading = false;

	}

	escapeTick() {

		const P = this.sp, g = P.group;
		if ( P.aboard || P.down || P.leading ) return;
		const legs = this.legs();
		// a detour by the player (a march to somewhere else): follow it, then take up the route at the nearest leg still ahead
		if ( g.goal && g.goal !== P.legGoal ) {

			this.startEscape( 'detour' );
			if ( ! near( P.pos, g.goal, 12 ) ) return;
			let k = Math.max( 0, P.leg ), bd = Infinity;
			for ( let j = Math.max( 0, P.leg ); j < legs.length; j ++ ) { const d = Math.hypot( legs[ j ][ 0 ] - P.pos[ 0 ], legs[ j ][ 1 ] - P.pos[ 1 ] ); if ( d < bd ) { bd = d; k = j; } }
			P.leg = bd < 14 ? Math.min( k + 1, legs.length - 1 ) : k;
			this.event( 'The Speaker takes up the escape route again', 'info', P.pos );
			this.lead();
			return;

		}

		if ( ! P.escaping ) return;
		if ( P.leg < legs.length - 1 && near( P.pos, legs[ P.leg ], 14 ) ) { P.leg ++; this.lead(); }
		// the car moved: follow it
		else if ( P.leg === legs.length - 1 && P.legGoal && ! near( P.legGoal, legs[ P.leg ], 8 ) ) this.lead();

	}

	carTick( dt ) {

		const W = this.world, C = this.car, P = this.sp, at = [ C.x, C.y ];
		if ( P.aboard ) {

			// boxed in by officers while stopped: they drag the Speaker out
			C.stuck = C.speed < 0.5 && W.countNear( ...at, 8, FACTION.POLICE ) >= 8 ? ( C.stuck ?? 0 ) + dt : 0;
			if ( C.stuck > 10 ) P.taken = true;
			if ( C.s > 120 || ! C.path ) P.away = true;
			return;

		}

		if ( C.path ) return; // moving round to the other pick-up
		if ( P.escaping && ! P.down && near( P.pos, at, 7 ) ) {

			const I = W.intel;
			for ( const i of P.group.members ) if ( I.st[ i * 4 ] === FACTION.PROTESTER && near( [ I.pos[ i * 2 ], I.pos[ i * 2 + 1 ] ], at, 12 ) ) this.crowd.setFaction( i, - 1 );
			P.aboard = true;
			this.crowd.u.parting.value = - 1;
			W.patrols.driveTo( C, ...this.exit() );
			this.event( 'The Speaker is in the car! Keep the road clear', 'good', at );
			return;

		}

		// police at the car and nobody to stop them: the driver goes round to the other pick-up
		const pol = W.countNear( ...at, 14, FACTION.POLICE ), prot = W.countNear( ...at, 14, FACTION.PROTESTER );
		C.threat = pol >= 6 && pol > prot ? ( C.threat ?? 0 ) + dt : 0;
		if ( C.threat > 8 && this.t - ( this.carMoved ?? - 99 ) > 30 ) {

			this.carAt = 1 - this.carAt;
			this.carMoved = this.t;
			C.threat = 0;
			W.patrols.driveTo( C, ...this.carSpots[ this.carAt ] );
			this.event( `Police at the rescue car: the driver goes round to ${RESCUE_CARS[ this.carAt ][ 2 ]}`, 'warn', this.carSpots[ this.carAt ] );

		}

	}

	// the way out with the fewest officers on it (60 m of path per officer near the road)
	exit() {

		const W = this.world, C = this.car;
		let best = RESCUE_EXITS[ 0 ], bs = Infinity;
		for ( const e of RESCUE_EXITS ) {

			if ( near( e, [ C.x, C.y ], 60 ) ) continue;
			const path = W.patrols.route( [ C.x, C.y ], W.patrols.snap( ...e ) ?? e );
			if ( ! path ) continue;
			const L = polyline( path );
			let pol = 0;
			for ( let s = 0; s < L.len; s += 10 ) pol += W.countNear( ...along( L.pts, L.cum, s ), 10, FACTION.POLICE );
			if ( L.len + pol * 60 < bs ) { bs = L.len + pol * 60; best = e; }

		}

		return best;

	}

	// AntiFa: the selected squads go for the police squad nearest the cursor and stay on it until it is broken
	assault( x, y ) {

		const ants = this.game.selected.filter( ( q ) => q.kind === 'antifa' && ( q.alive ?? 0 ) > 0 );
		if ( ! ants.length ) { this.event( 'Only the AntiFa squads assault the police', 'warn' ); return; }
		const T = this.world.groupAt( x, y, [ FACTION.POLICE ], 30 );
		if ( ! T?.center ) { this.event( 'No police squad there', 'warn' ); return; }
		this.world.setMode( ants, MODE.PUSH );
		for ( const q of ants ) {

			q.assault = T;
			this.crowd.setGroup( q.id, { speed: 1.7 } ); // they run at it
			for ( const i of q.members ) this.crowd.recall( i, 0.6 );
			this.aim( q, T.center );

		}

		this.nudgeOpinion( - 2, 'AntiFa attack the police' );
		this.event( `${ants.map( ( q ) => q.label ).join( ', ' )} going for ${T.label}`, 'warn', T.center );

	}

	aim( q, at ) {

		q.aim = [ ...at ];
		q.aimT = this.t;
		q.aiming = this.world.march( [ q ], ...q.aim, 4 ).then( () => { q.aiming = null; } );

	}

	assaultTick( I ) {

		const W = this.world;
		for ( const q of this.antifa ) {

			const T = q.assault;
			if ( ! T ) { if ( q.sprint !== false ) { q.sprint = false; this.crowd.setGroup( q.id, { speed: 1.2 } ); } continue; }
			q.sprint = true;
			if ( ! ( q.alive > 0 ) ) { q.assault = null; continue; }
			if ( T.broken || T.alive < Math.max( 4, T.members.length * ASSAULT_BREAK ) ) {

				// pull back 20 m the way they came and cool off
				q.assault = null;
				const d = Math.hypot( q.center[ 0 ] - T.center[ 0 ], q.center[ 1 ] - T.center[ 1 ] ) || 1;
				W.march( [ q ], q.center[ 0 ] + ( q.center[ 0 ] - T.center[ 0 ] ) / d * 20, q.center[ 1 ] + ( q.center[ 1 ] - T.center[ 1 ] ) / d * 20, 8 );
				for ( const i of q.members ) this.crowd.nudge( i, - 0.3, 0 );
				if ( T.broken ) continue;
				T.broken = true;
				T.chasing = false;
				W.moveSquads( [ T ], - 436, - 41 );
				this.counters.broken ++;
				this.event( `${T.label} is broken and runs: ${q.label} pulls back`, 'good', T.center );
				continue;

			}

			// another order (hold, sit, a march elsewhere) calls the assault off; a re-aim waiting for its field is not one
			if ( q.aiming ) continue;
			if ( q.mode !== MODE.PUSH || ( q.goal && ! near( q.goal, q.aim, 1 ) ) ) { q.assault = null; continue; }
			if ( this.t - q.aimT > 2 && T.center ) this.aim( q, T.center );

			// drilled, not enraged: kept below the agitation at which officers in contact grab fighters (kernel)
			const mine = q.members.filter( ( i ) => I.st[ i * 4 ] === FACTION.PROTESTER );
			for ( const i of mine ) if ( I.st[ i * 4 + 2 ] > 0.56 ) this.crowd.nudge( i, 0.55 - I.st[ i * 4 + 2 ], 0 );
			// blows: officers of that squad with AntiFa members on them go down
			for ( const j of T.members ) {

				if ( I.st[ j * 4 ] !== FACTION.POLICE ) continue;
				const x = I.pos[ j * 2 ], y = I.pos[ j * 2 + 1 ];
				let k = 0;
				for ( const i of mine ) if ( ( I.pos[ i * 2 ] - x ) ** 2 + ( I.pos[ i * 2 + 1 ] - y ) ** 2 < 6.25 ) k ++;
				if ( k && Math.random() < 1 - ( 1 - ASSAULT_HIT ) ** k ) this.crowd.setFaction( j, 21 );

			}

		}

	}

	get windArrow() {

		const a = Math.atan2( this.world.wind[ 1 ], this.world.wind[ 0 ] );
		return [ '→', '↗', '↑', '↖', '←', '↙', '↓', '↘' ][ ( Math.round( a / ( Math.PI / 4 ) ) + 8 ) % 8 ];

	}

	phase() {

		const P = this.sp, d = Math.round( Math.max( 0, this.route.len - P.s ) );
		const where = P.aboard ? 'SPEAKER IN THE CAR' : P.down ? 'SPEAKER DOWN' : ! P.escaping ? 'the Speaker is on the stand' : `Speaker ${d} m from the car`;
		return `${where} · ${fmt( RESCUE_LIMIT - this.t )} left · wind ${this.windArrow}`;

	}

	objectives() {

		const P = this.sp, d = Math.max( 0, this.route.len - P.s ), pol = this.world.countNear( ...P.pos, 15, FACTION.POLICE );
		return [
			{ label: 'Speaker to the rescue car', value: P.aboard ? 1 : Math.min( 1, P.s / this.route.len ), text: P.aboard ? 'in the car' : P.down ? 'DOWN!' : P.escaping ? `${Math.round( d )} m` : 'on the stand',
				state: P.down ? 'bad' : P.aboard ? 'done' : 'ok' },
			{ label: 'Police near the Speaker', value: P.grab > 0 ? P.grab / SNATCH_HOLD : Math.min( 1, pol / 12 ), text: P.grab > 0 ? `SEIZED · ${Math.ceil( SNATCH_HOLD - P.grab )} s` : `${pol}`,
				state: P.grab > 0 || pol > 6 ? 'bad' : pol > 2 ? 'warn' : 'ok', invert: true },
			{ label: '★ Away before 10:00', value: Math.min( 1, this.t / RESCUE_STAR ), text: this.t < RESCUE_STAR ? fmt( RESCUE_STAR - this.t ) : 'missed', state: this.t < RESCUE_STAR ? 'ok' : 'bad', invert: true },
			{ label: '★ Sympathy ≥ 50', value: this.opinion / 100, text: `${Math.round( this.opinion )}`, state: this.opinion < 50 ? 'bad' : 'ok' },
		];

	}

	score( win ) {

		const s2 = win && this.t < RESCUE_STAR, s3 = win && this.opinion >= 50;
		return { stars: win + s2 + s3, lines: [
			[ 'Time', fmt( this.t ) ], [ 'Speaker carried', this.sp.carriers ? `yes (${this.sp.carriers}×)` : 'no' ], [ 'Public sympathy', Math.round( this.opinion ) ],
			[ 'Protesters injured', this.counters.injByPolice ], [ 'Treated by medics', this.counters.treated ?? 0 ], [ 'Arrested', this.counters.arrested ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Police squads broken', this.counters.broken ], [ 'Tear gas fired', this.ai.gasUsed ] ] };

	}

	draw( o ) {

		const ctx = o.ctx, P = this.sp, I = this.world.intel;
		// the way still to go, dashed
		if ( ! P.aboard ) {

			ctx.setLineDash( [ 4, 8 ] );
			ctx.strokeStyle = 'rgba(255,106,16,0.45)';
			ctx.lineWidth = 2;
			ctx.beginPath();
			let first = true;
			for ( let s = P.s; s <= this.route.len; s += 8 ) { const [ x, y ] = o.toScreen( ...along( this.route.pts, this.route.cum, s ) ); first ? ctx.moveTo( x, y ) : ctx.lineTo( x, y ); first = false; }
			ctx.stroke();
			ctx.setLineDash( [] );

		}

		// the stand
		const [ sx, sy ] = o.toScreen( ...RESCUE_STAND ), w = 4 / o.mpp;
		ctx.strokeStyle = 'rgba(233,228,216,0.7)';
		ctx.lineWidth = 1.5;
		ctx.strokeRect( sx - w, sy - w * 0.6, w * 2, w * 1.2 );

		// the rescue car
		const C = this.car;
		this.drawZone( o, C.x, C.y, 9, C.threat > 0 ? RED : ORANGE, C.path && ! P.aboard ? 'RESCUE CAR · moving' : C.threat > 0 ? `RESCUE CAR · police ${Math.ceil( 8 - C.threat )} s` : P.aboard ? 'GO GO GO' : 'RESCUE CAR', 0.05 );

		// AntiFa: black dots, a ring and a label; an assault draws a line to its target
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		for ( const q of this.antifa ) {

			if ( ! ( q.alive > 0 ) || ! q.center ) continue;
			if ( I ) for ( const i of q.members ) {

				if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
				const [ x, y ] = o.toScreen( I.pos[ i * 2 ], I.pos[ i * 2 + 1 ] );
				ctx.beginPath();
				ctx.arc( x, y, Math.max( 2.4, 0.6 / o.mpp ), 0, Math.PI * 2 );
				ctx.fillStyle = 'rgba(8,8,10,0.95)';
				ctx.fill();
				ctx.strokeStyle = ORANGE;
				ctx.lineWidth = 1;
				ctx.stroke();

			}

			const [ x, y ] = o.toScreen( ...q.center );
			if ( q.assault?.center ) {

				const [ tx, ty ] = o.toScreen( ...q.assault.center );
				ctx.strokeStyle = 'rgba(255,45,85,0.8)';
				ctx.setLineDash( [ 2, 4 ] );
				ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( tx, ty ); ctx.stroke();
				ctx.setLineDash( [] );

			}

			ctx.fillStyle = ORANGE;
			ctx.fillText( q.assault ? `${q.label.toUpperCase()} → ${q.assault.label}` : q.label.toUpperCase(), x, y - Math.max( 12, 8 / o.mpp ) );

		}

		// the Speaker: a bright marker with a label, or a pulsing ring where they fell
		if ( ! P.aboard ) {

			const [ x, y ] = o.toScreen( ...P.pos );
			if ( P.down ) {

				const r = 10 + ( this.t * 2 % 1 ) * 12;
				ctx.strokeStyle = RED;
				ctx.lineWidth = 2;
				ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.stroke();
				ctx.fillStyle = RED;
				ctx.font = '600 11px "IBM Plex Mono", monospace';
				ctx.fillText( P.held > 0 ? `SPEAKER DOWN · police ${Math.ceil( 8 - P.held )} s` : 'SPEAKER DOWN', x, y - r - 4 );

			} else {

				ctx.strokeStyle = 'rgba(255,240,220,0.95)';
				ctx.lineWidth = 2;
				ctx.beginPath(); ctx.arc( x, y, 6, 0, Math.PI * 2 ); ctx.stroke();
				ctx.beginPath(); ctx.arc( x, y, 10 + Math.sin( this.t * 4 ) * 1.5, 0, Math.PI * 2 ); ctx.stroke();
				ctx.fillStyle = 'rgba(255,240,220,0.95)';
				ctx.font = '600 11px "IBM Plex Mono", monospace';
				if ( P.grab > 0 ) ctx.fillStyle = RED;
				ctx.fillText( P.grab > 0 ? `SPEAKER · SEIZED ${Math.ceil( SNATCH_HOLD - P.grab )} s` : P.carried ? 'SPEAKER · carried' : 'SPEAKER', x, y - 16 );

			}

		}

		// wind, top left
		ctx.fillStyle = 'rgba(217,226,220,0.8)';
		ctx.font = '600 12px "IBM Plex Mono", monospace';
		ctx.textAlign = 'left';
		ctx.fillText( `WIND ${this.windArrow} ${Math.hypot( ...this.world.wind ).toFixed( 1 )} m/s`, 16, 96 );
		this.ai.draw( o );

	}

}

// Police commander for the rescue: riot squads on Slovenska, Šubičeva and Prešernov trg charge the square together and
// kettle it; snatch squads go for the Speaker every ~30 s (announced, like CourtPolice); once the Speaker runs, cars with
// mobile squads come along Slovenska and Barjanska: they cordon the route ahead of the Speaker or go for the rescue car.
class RescuePolice {

	constructor( m ) {

		this.m = m;
		this.W = m.world;
		this.busy = new Set();
		this.pending = []; // { at, r, label, until }
		this.gas = 4;
		this.gasUsed = 0;
		this.last = { snatch: - 99, gas: - 99, down: - 99 };
		this.phase = 'mass';
		this.cars = [];

	}

	async setup() {

		const W = this.W;
		this.forces = [];
		for ( const [ name, at ] of RESCUE_FORCES ) {

			const sq = await squads( W, [ 0, 1, 2 ].map( ( k ) => [ at[ 0 ] + ( k - 1 ) * 10, at[ 1 ] ] ), 24 );
			const sn = await W.squad( { kind: 'squad', label: `Snatch squad ${this.forces.length + 1}`, at: [ at[ 0 ], at[ 1 ] + 10 ], n: 14 } );
			this.W.crowd.setGroup( sn.id, { speed: 1.45 } ); // light kit: faster than the Speaker on an open street
			this.forces.push( { name, at, squads: sq, snatch: sn } );

		}

		this.reserves = await squads( W, [ [ - 436, - 41 ], [ - 426, - 41 ] ], 20 );
		this.snatchers = [ ...this.forces.map( ( f ) => f.snatch ), ...this.reserves ];
		this.posts = new Map( this.snatchers.map( ( s ) => [ s, s.anchor ] ) );

	}

	// protesters within 70 m of the stand: their centre and count
	crowd() {

		const I = this.W.intel, S = RESCUE_STAND;
		let n = 0, sx = 0, sy = 0;
		for ( let i = 0; i < this.W.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
			if ( ( x - S[ 0 ] ) ** 2 + ( y - S[ 1 ] ) ** 2 > 4900 ) continue;
			n ++; sx += x; sy += y;

		}

		return { n, c: n ? [ sx / n, sy / n ] : S };

	}

	tell( at, r, label, delay, fn ) {

		this.pending.push( { at, r, label, until: this.m.t + delay } );
		this.m.event( `Police: ${label} in ${delay} s`, 'warn', at );
		this.m.after( delay, () => { this.pending = this.pending.filter( ( p ) => p.until > this.m.t ); fn(); } );

	}

	tick() {

		const m = this.m;
		if ( ! this.W.intel || m.t - ( this.lastTick ?? 0 ) < 3 ) return;
		this.lastTick = m.t;
		if ( this.phase === 'mass' && m.t >= RESCUE_CHARGE - 8 ) { this.phase = 'charge'; this.charge(); }
		if ( this.phase === 'mass' ) return;
		this.downTick();
		if ( ! m.sp.down && ! m.sp.aboard ) for ( const s of this.busy ) if ( s.chasing && s.alive > 0 && ! s.broken ) this.chase( s );
		this.snatchTick();
		this.gasTick();
		this.crewTick();

	}

	// three charges at once, into the crowd's edge from each side; the Speaker runs; then the squads kettle the square
	charge() {

		const m = this.m, W = this.W, { c } = this.crowd();
		for ( const f of this.forces ) {

			const d = Math.hypot( f.at[ 0 ] - c[ 0 ], f.at[ 1 ] - c[ 1 ] ) || 1;
			f.target = [ c[ 0 ] + ( f.at[ 0 ] - c[ 0 ] ) / d * Math.min( d, 25 ), c[ 1 ] + ( f.at[ 1 ] - c[ 1 ] ) / d * Math.min( d, 25 ) ];
			this.pending.push( { at: f.target, r: 14, label: `charge from ${f.name}`, until: m.t + 8 } );

		}

		m.event( 'Police: baton charges from Slovenska, Šubičeva and Prešernov trg in 8 s', 'bad', c );
		this.last.snatch = m.t - 10; // the first snatch squad goes in ~15 s after the charge
		m.after( 8, () => {

			for ( const f of this.forces ) W.charge( f.squads, ...f.target );
			m.startEscape( 'charge' );
			m.after( 14, () => this.kettle() );

		} );

	}

	kettle() {

		const m = this.m, W = this.W, { n, c } = this.crowd();
		const team = this.forces.flatMap( ( f ) => f.squads ).filter( ( s ) => s.alive > 5 && ! s.broken );
		if ( ! team.length || n < 50 ) return;
		const r = Math.max( 20, Math.min( 45, Math.sqrt( n / 1.6 / Math.PI ) ) );
		W.kettle( team, ...c, r, W.intel.pos, { tighten: 0.8 } );
		this.phase = 'kettle';
		m.event( 'The police are kettling the square', 'bad', c );

	}

	// a snatch squad for the Speaker, announced; crews off the cars join in when the Speaker comes close to them
	snatchTick() {

		const m = this.m, W = this.W, P = m.sp;
		if ( P.aboard || P.down || m.t - this.last.snatch < ( P.escaping ? 25 : 35 ) ) return;
		const cands = [ ...this.snatchers.map( ( s ) => [ s, 260 ] ), ...this.cars.filter( ( c ) => c.deployed ).map( ( c ) => [ c.crew, 60 ] ) ];
		let best = null, bd = Infinity;
		for ( const [ s, r ] of cands ) {

			if ( this.busy.has( s ) || ! ( s.alive > 5 ) || s.broken || ! s.center ) continue;
			const d = Math.hypot( s.center[ 0 ] - P.pos[ 0 ], s.center[ 1 ] - P.pos[ 1 ] );
			if ( d < r && d < bd ) { bd = d; best = s; }

		}

		if ( ! best ) return;
		const s = best;
		this.last.snatch = m.t;
		this.busy.add( s );
		this.tell( P.pos, 10, `${s.label} for the Speaker`, 5, () => {

			if ( P.aboard ) { this.release( s ); return; }
			s.chasing = true;
			this.chase( s );
			m.after( 45, () => this.release( s ) );

		} );

	}

	// after the Speaker: every chaser within the same 12 m shares one field and makes for the Speaker's exact spot inside it
	// (a field per chaser per step of the Speaker's flooded the flow-field pool)
	chase( s ) {

		this.W.arrest( [ s ], ...grid12( this.m.sp.pos ), 14, this.m.sp.pos );

	}

	// a squad back on the street: it follows the Speaker (or returns to its post before the escape)
	release( s ) {

		const P = this.m.sp;
		this.busy.delete( s );
		s.chasing = false;
		if ( ! ( s.alive > 0 ) || s.broken ) return;
		const to = P.escaping && ! P.aboard ? grid12( P.pos ) : this.posts.get( s ) ?? s.center;
		if ( to ) this.W.moveSquads( [ s ], ...to );

	}

	// the Speaker on the ground: the nearest squads go and stand over them
	downTick() {

		const m = this.m, P = m.sp;
		if ( ! P.down || m.t - this.last.down < 6 ) return;
		this.last.down = m.t;
		const near2 = this.W.groupsOf( FACTION.POLICE ).filter( ( s ) => s.center && s.alive > 5 && ! s.broken && ( s.kind !== 'crew' || s.car?.deployed ) )
			.sort( ( a, b ) => Math.hypot( a.center[ 0 ] - P.pos[ 0 ], a.center[ 1 ] - P.pos[ 1 ] ) - Math.hypot( b.center[ 0 ] - P.pos[ 0 ], b.center[ 1 ] - P.pos[ 1 ] ) ).slice( 0, 2 );
		for ( const s of near2 ) { s.chasing = false; this.W.moveSquads( [ s ], ...grid12( P.pos ) ); }

	}

	// tear gas on a crowd that has a snatch squad stuck in it short of the Speaker
	gasTick() {

		const m = this.m, W = this.W, P = m.sp;
		if ( this.gas <= 0 || m.t - this.last.gas < 40 || P.aboard ) return;
		for ( const s of this.busy ) {

			if ( ! s.chasing || ! s.center || ! near( s.center, P.pos, 50 ) || W.countNear( ...s.center, 15, FACTION.PROTESTER ) < 80 ) continue;
			this.last.gas = m.t;
			this.gas --;
			const p = [ s.center[ 0 ] + ( P.pos[ 0 ] - s.center[ 0 ] ) * 0.6, s.center[ 1 ] + ( P.pos[ 1 ] - s.center[ 1 ] ) * 0.6 ];
			this.tell( p, 20, 'tear gas', 6, () => {

				W.gas( ...p );
				this.gasUsed ++;
				m.nudgeOpinion( 1.5, 'tear gas on camera' );
				m.event( 'Tear gas fired into the crowd', 'bad', p );

			} );
			return;

		}

	}

	// once the Speaker runs: cars with mobile squads along Slovenska (to cut the route ahead) and Barjanska (the rescue car, then the route)
	onEscape() {

		for ( const [ dt, road, task ] of [ [ 20, 'Slovenska', 'ahead' ], [ 55, 'Barjanska', 'car' ], [ 95, 'Slovenska', 'ahead' ], [ 140, 'Barjanska', 'ahead' ] ] ) {

			this.m.after( dt, () => this.dispatch( road, task ) );

		}

	}

	async dispatch( road, task ) {

		const m = this.m, P = m.sp;
		if ( P.aboard || m.result ) return;
		const from = RESCUE_POLICE_CARS[ road ];
		const car = await this.W.patrols.add( { at: from, crew: 12, selectable: false, label: `Police car · ${road}` } );
		car.task = task;
		car.crew.label = `Mobile squad · ${road}`;
		this.cars.push( car );
		m.event( `A police car with a mobile squad is coming along ${road} cesta`, 'warn', from );
		// the crew boards once it shows up in a readback
		m.after( 1.5, () => {

			car.goal = task === 'car' ? m.carSpots[ m.carAt ] : this.ahead();
			// far enough ahead that the Speaker is not there yet when the car is (~9 m/s driving, ~1.7 m/s walking)
			const path = task !== 'car' && this.W.patrols.route( [ car.x, car.y ], this.W.patrols.snap( ...car.goal ) ?? car.goal );
			if ( path ) car.goal = this.ahead( 50 + polyline( path ).len / 9 * 1.7 );
			if ( ! this.W.patrols.driveTo( car, ...car.goal ) ) car.task = 'idle';

		} );

	}

	// a street spot on the escape route well ahead of the Speaker
	ahead( lead = 110 ) {

		const m = this.m, s = Math.min( m.sp.s + lead, m.route.len - 25 );
		const p = along( m.route.pts, m.route.cum, s );
		return this.W.roadSpot( ...p, 20 ) ?? p;

	}

	// a mobile squad goes for the Speaker itself (no shared snatch timer): a short warning, 30 s after them, then it follows
	lunge( crew, delay ) {

		const m = this.m, P = m.sp;
		this.busy.add( crew );
		const go = () => {

			if ( P.aboard || crew.broken ) { this.release( crew ); return; }
			crew.chasing = true;
			this.chase( crew );
			m.after( 30, () => this.release( crew ) );

		};
		if ( delay ) this.tell( P.pos, 8, `${crew.label} goes for the Speaker`, delay, go );
		else { m.event( `${crew.label} goes straight for the Speaker`, 'bad', P.pos ); go(); }

	}

	// cars that have arrived: the crew forms a line across the street (route) or makes for the rescue car on foot
	crewTick() {

		const m = this.m, W = this.W;
		for ( const car of this.cars ) {

			if ( car.path || ! car.goal || ! car.crew || car.task === 'idle' || car.crew.broken ) continue;
			const crew = car.crew;
			if ( ! car.deployed ) {

				car.deployed = true;
				// the Speaker already got past this spot: straight after them
				if ( car.task === 'ahead' && m.sp.s > project( m.route, ...car.goal ) - 10 ) { this.lunge( crew, 0 ); continue; }
				if ( car.task === 'ahead' ) {

					const [ a, b ] = W.across( ...car.goal, 24 );
					W.lineSquads( [ crew ], a, b, W.intel.pos );
					m.event( `${crew.label} blocks the street ahead of the Speaker`, 'bad', car.goal );

				} else {

					W.moveSquads( [ crew ], ...m.carSpots[ m.carAt ] );
					m.event( `${crew.label} is heading for the rescue car`, 'bad', [ car.x, car.y ] );

				}

				continue;

			}

			const P = m.sp;
			if ( ! this.busy.has( crew ) && crew.center && crew.alive > 3 && ! P.aboard && ! P.down && near( crew.center, P.pos, CREW_LUNGE ) ) { this.lunge( crew, 2 ); continue; }
			if ( car.task === 'car' && ! this.busy.has( crew ) && crew.center && ! near( crew.center, m.carSpots[ m.carAt ], 25 ) && m.t - ( crew.moved ?? 0 ) > 10 ) {

				crew.moved = m.t;
				W.moveSquads( [ crew ], ...m.carSpots[ m.carAt ] );

			}

		}

	}

	draw( o ) {

		this.pending = this.pending.filter( ( p ) => p.until > this.m.t );
		drawPending( o, this.pending, this.m.t );

	}

}

export const MISSIONS = [ ConvoyMission, DefendAssembly, DefendVlada, RallyMission, ClashMission, SitInMission, MassacreMission, ResnicaRun, BlackBloc, CourtMission, PrideMission, RescueMission ];
export { World };
