import {
	Mission, FACTION, MODE, ROLE, fmt, rand,
	ORANGE, RED, drawPending, along, near, polyline, project, squads,
} from '../sdk/index.js';

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

			if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
			const d = ( I.x( i ) - P.pos[ 0 ] ) ** 2 + ( I.y( i ) - P.pos[ 1 ] ) ** 2;
			if ( d < bd ) { bd = d; bi = i; }

		}

		const from = bi >= 0 && W.groups[ I.group( bi ) ];
		if ( ! from || ( from.kind === 'medics' && from !== g ) ) return;
		if ( from !== g ) { from.members = from.members.filter( ( i ) => i !== bi ); g.members.push( bi ); }
		this.crowd.regroup( bi, g.id, ROLE.LEADER );
		this.crowd.setGroup( g.id, { leader: bi, speed: 0.85 } );
		Object.assign( g, { leader: bi, leaderState: 'active', leaderPos: [ I.x( bi ), I.y( bi ) ], leaderReported: false } );
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
			for ( const i of P.group.members ) if ( I.faction( i ) === FACTION.PROTESTER && near( [ I.x( i ), I.y( i ) ], at, 12 ) ) this.crowd.setFaction( i, - 1 );
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
			const mine = q.members.filter( ( i ) => I.faction( i ) === FACTION.PROTESTER );
			for ( const i of mine ) if ( I.agitation( i ) > 0.56 ) this.crowd.nudge( i, 0.55 - I.agitation( i ), 0 );
			// blows: officers of that squad with AntiFa members on them go down
			for ( const j of T.members ) {

				if ( I.faction( j ) !== FACTION.POLICE ) continue;
				const x = I.x( j ), y = I.y( j );
				let k = 0;
				for ( const i of mine ) if ( ( I.x( i ) - x ) ** 2 + ( I.y( i ) - y ) ** 2 < 6.25 ) k ++;
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

				if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
				const [ x, y ] = o.toScreen( I.x( i ), I.y( i ) );
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

			if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
			const x = I.x( i ), y = I.y( i );
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
