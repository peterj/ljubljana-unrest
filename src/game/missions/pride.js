import { Mission, FACTION, MODE, ROLE, fmt, pick } from '../mission.js';
import { ORANGE, RED } from './shared/colors.js';
import { drawPending } from './shared/draw.js';
import { along, near, polyline, project } from './shared/geometry.js';
import { cars, squads } from './shared/spawn.js';

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
