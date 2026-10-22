import {
	Mission, FACTION, MODE, ROLE, STAT, fmt, rand, WATER_RANGE,
	RED, WHITE, along, near, polyline, project, cars, squads,
} from '../sdk/index.ts';

// ======================================================================================= RING ROAD
// After ljubljanainfo.com, 29 September 2021: ~2,000 at a rally on Trg republike against the COVID
// measures, an unregistered march past the Presidential palace and up Celovška; at 17:06 the northern
// ring road was closed in both directions, at 17:13 a water cannon pushed people off it, by 17:55 it was
// open again and the march was heading back to the centre. Played on its own map (data/north).

const CAR_GAP = 7.5, CAR_SPEED = 17; // queued spacing (m), free-flow speed (m/s)
const LIMIT = 420; // seconds of closure that lose the mission
const RUN_MARCH = 10000, RUN_ONLOOKERS = 10000; // marchers from the Tivoli end of Celovška · onlookers lining the route
const RUN_FAST = 2.4, RUN_SLOW_AT = 350; // the march walks this much faster (compressed time) until this far from the interchange (m)
// onlookers within this many metres of police force join the march (firearms: all of them)
const RUN_PROVOKE = { c: 150, k: 150, s: 150, a: 120, x: 120, g: 300, w: 300 };
const RUN_JOIN = 1 / 3; // share of the onlooker groups near police force that join; the rest keep watching

export class ResnicaRun extends Mission {

	declare R: any;
	declare inter: any;
	declare duration: number;
	declare closed: number;
	declare gasOpinion: number;
	declare waterOpinion: number;
	declare focus: [ number, number ];
	declare zoom: number;
	declare ring: any;
	declare mask: Int8Array<ArrayBuffer>;
	declare onRing: any;
	declare ringPoint: any;
	declare vodnikova: any[];
	declare litostrojska: any[];
	declare spots: any[];
	declare toInter: any;
	declare march: any[];
	declare wanderPlaces: any[];
	declare _intel: any;

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

			const near = this.ring.flatMap( ( L ) => [ - 60, 0, 60 ].map( ( o ) => along( L.pts, L.cum, project( L, ...( c as [ number, number ] ) ) + o ) ) )
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
					const o = along( R.pts, R.cum, project( R, ...( c as [ number, number ] ) ) );
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

			const live = g.members.filter( ( i ) => I.faction( i ) === FACTION.BYSTANDER );
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

			if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
			const x = I.x( i ), y = I.y( i ), id = this.onRing( x, y );
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
