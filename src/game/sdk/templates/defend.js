import { Mission, FACTION, MODE, ZONE, fmt, pick } from '../../mission.js';
import { ORANGE, WHITE, RED } from '../colors.js';
import { inPoly, near, ringDist } from '../geometry.js';
import { cars, squads } from '../spawn.js';

// Template: hold a building for 12 minutes against announced waves of protesters. Extend it and set the usual statics plus
// target (a name in city.targets), short (how the text refers to it) and waves [ { t, n, label, from (a place or landmark name),
// at?, agitation?, morale?, bikes? } ]. Optional: exitAt (hand-placed exits), routes [ { name, legs: [ [ x, y ], … ], rally } ]
// (waves march in columns along these) and outrage (force anywhere near a crowd angers it).
const DEFEND_OUTRAGE = { c: [ 45, 0.2, 'Baton charge' ], k: [ 50, 0.25, 'Kettle' ], g: [ 60, 0.25, 'Tear gas' ], w: [ 50, 0.2, 'Water cannon' ], a: [ 35, 0.12, 'Arrests' ], x: [ 35, 0.12, 'Snatch squad' ], s: [ 40, 0.15, 'Shield push' ] };

export class DefendMission extends Mission {

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
			for ( const i of g.members ) { const f = I.faction( i ); if ( ( f > 9.5 && f < 19.5 ) || f === FACTION.ARRESTED ) hp ++; }
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

			if ( I.faction( i ) !== FACTION.PROTESTER || I.agitation( i ) < 0.4 ) continue;
			const x = I.x( i ), y = I.y( i );
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
