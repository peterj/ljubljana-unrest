// Mission base: timeline, objectives, public opinion, resources, events and the order set shared
// by every mission on the same side. Concrete missions live in missions.js.
import { FACTION, MODE, ROLE, STAT, ZONE } from '../sim/crowd.js';
import { World, pick, rand, WATER_JET } from '../sim/world.js';
import { CannonAI } from './cannon.js';

const STORM_TIME = 40; // seconds a storming group keeps going before it is exhausted

export const fmt = ( s ) => `${Math.floor( Math.max( 0, s ) / 60 )}:${String( Math.floor( Math.max( 0, s ) % 60 ) ).padStart( 2, '0' )}`;

export class Mission {

	static id = 'base';
	static title = '';
	static subtitle = '';
	static side = 'police';
	static brief = '';
	static goals = [];
	static tips = [];

	constructor( game ) {

		this.game = game;
		this.world = game.world;
		this.crowd = game.crowd;
		this.city = game.city;
		this.t = 0;
		this.opinion = 60;
		this.opinionLabel = this.side === 'police' ? 'Public opinion' : 'Public sympathy';
		this.resources = {}; // name → { left, max, cooldown, ready }
		this.result = null; // { win, reason }
		this.prev = null; // previous stats for deltas
		this.stats = null;
		this.counters = { injByPolice: 0, injOther: 0, injPolice: 0, arrested: 0, arrestedSitters: 0, gone: 0, gas: 0 };
		this.zones = [];
		this.timers = [];
		this.flags = {};
		this.escalation = 0; // 0 none · 1 force · 2 tear gas · 3 water cannon · 4 firearms
		this.shelters = []; // protest side: { id, until } groups under umbrellas
		// protest side: the AI police call in a water cannon truck when officers go down or a line is overrun
		const M = this.world.marks;
		if ( this.side === 'protest' ) this.cannonAI = new CannonAI( this, { stations: [ M[ 'PU Ljubljana' ], M[ 'PP Ljubljana Center' ] ] } );

	}

	get side() { return this.constructor.side; }

	// ---------------------------------------------------------------- lifecycle (overridden)
	async setup() {}
	tick() {} // mission logic, called every frame with this.stats available
	objectives() { return []; }
	phase() { return ''; }
	score() { return { stars: 0, lines: [] }; }
	draw() {} // mission overlay (route, exits, zones)

	// ---------------------------------------------------------------- helpers
	event( text, kind = 'info', at = null ) {

		this.game.hud.toast( text, kind );
		if ( at ) this.game.overlay.ping( at[ 0 ], at[ 1 ], kind );
		if ( kind === 'bad' ) this.game.sound?.alarm();

	}

	after( seconds, fn ) {

		this.timers.push( { at: this.t + seconds, fn } );

	}

	nudgeOpinion( d, why ) {

		const before = this.opinion;
		this.opinion = Math.max( 0, Math.min( 100, this.opinion + d ) );
		this.game.hud.opinionDelta( d, why );
		// protest side: sympathy moves people (see sway)
		if ( this.side === 'protest' ) this._sway = ( this._sway ?? 0 ) + this.opinion - before;

	}

	// Protest side: sympathy is the crowd. Each point lost sends ~1 % of the calm protesters (agitation < 0.3) back to
	// the pavement as onlookers, so a storm leaves a smaller, angrier crowd; each point gained draws ~2 % of the
	// onlookers within 30 m of a protest group into it. Applied at once for ≥ 5 points, else every 8 s for ≥ 2.
	sway() {

		const I = this.world.intel, W = this.world, pts = this._sway;
		this._sway = 0;
		// closed groups (an escort, a militant squad) neither lose people to sympathy nor take onlookers in
		const mine = W.groupsOf( FACTION.PROTESTER ).filter( ( g ) => g.kind !== 'medics' && ! g.closed && g.center );
		const groupOf = ( i ) => W.groups[ I.st[ i * 4 + 1 ] ];
		const take = ( list, share ) => {

			const n = Math.round( list.length * Math.min( 0.5, share ) );
			for ( let k = list.length - 1; k > 0; k -- ) { const j = Math.floor( Math.random() * ( k + 1 ) ); [ list[ k ], list[ j ] ] = [ list[ j ], list[ k ] ]; }
			return list.slice( 0, n );

		};
		const leave = ( moved ) => { // drop moved agents from the groups they were in

			const by = new Map();
			for ( const i of moved ) { const g = groupOf( i ); if ( ! by.has( g ) ) by.set( g, new Set() ); by.get( g ).add( i ); }
			for ( const [ g, out ] of by ) if ( g ) g.members = g.members.filter( ( i ) => ! out.has( i ) );

		};

		if ( pts < 0 ) {

			const calm = [];
			for ( const g of mine ) for ( const i of g.members ) if ( i !== g.leader && I.st[ i * 4 ] === FACTION.PROTESTER && I.st[ i * 4 + 2 ] < 0.3 ) calm.push( i );
			const out = take( calm, - pts * 0.01 );
			if ( ! out.length ) return;
			leave( out );
			const g = W.newGroup( FACTION.BYSTANDER, 'bystanders', 'Onlookers' );
			g.members = out;
			g.leader = out[ 0 ];
			for ( const i of out ) { this.crowd.regroup( i, g.id, ROLE.MEMBER ); this.crowd.setFaction( i, FACTION.BYSTANDER ); }
			this.crowd.setGroup( g.id, { leader: g.leader, speed: 1, mode: MODE.MARCH, scale: 1, morale: 0.5 } );
			W.setLayer( g, this.wander ? pick( this.wander ) : W.exitLayer );
			this.event( `${Math.round( pts )} sympathy: ~${out.length} people step back and watch`, 'warn', mine[ 0 ]?.center );

		} else {

			const near = [];
			for ( let i = 0; i < this.crowd.count; i ++ ) {

				if ( I.st[ i * 4 ] !== FACTION.BYSTANDER ) continue;
				const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
				let best = null, bd = 900;
				for ( const g of mine ) { const d = ( g.center[ 0 ] - x ) ** 2 + ( g.center[ 1 ] - y ) ** 2; if ( d < bd ) { bd = d; best = g; } }
				if ( best ) near.push( [ i, best ] );

			}

			const join = take( near, pts * 0.02 );
			if ( ! join.length ) return;
			leave( join.map( ( [ i ] ) => i ) );
			for ( const [ i, g ] of join ) { g.members.push( i ); this.crowd.regroup( i, g.id, ROLE.MEMBER ); this.crowd.setFaction( i, FACTION.PROTESTER ); }
			this.event( `+${Math.round( pts )} sympathy: ${join.length} onlookers join the protest`, 'good', join[ 0 ][ 1 ].center );

		}

	}

	setZones( list ) {

		this.zones = list;
		this.crowd.setZones( list );

	}

	zone( k ) {

		return this.stats ? this.stats[ STAT.ZONE + k ] : 0;

	}

	escalate( level, label ) {

		if ( level <= this.escalation ) return;
		this.escalation = level;
		this.game.sound?.escalate( level );
		if ( level >= 2 ) this.event( `Escalation: ${label}`, level >= 4 ? 'bad' : 'warn' );

	}

	end( win, reason ) {

		if ( this.result ) return;
		this.result = { win, reason, ...this.score( win ) };
		if ( this.escalation >= 4 ) {

			this.result.stars = Math.min( this.result.stars, 1 );
			this.result.lines.push( [ 'Firearms used', 'yes — max ★' ] );

		}
		this.game.finish( this.result );

	}

	async bystanders( n ) {

		const P = this.world.places, M = this.world.marks;
		// a mission on its own map lists its own places to wander between
		const dests = this.wanderPlaces ?? [ P[ 'Prešernov trg' ], P[ 'Kongresni trg' ], P[ 'Metelkova' ], M[ 'Železniška postaja' ], P[ 'Park Tivoli' ], P[ 'Mestni trg' ], P[ 'Zmajski most' ] ];
		this.wander = await Promise.all( dests.map( ( d, k ) => this.world.field( 'wander' + k, d[ 0 ], d[ 1 ], 25, true ) ) );
		const [ x0, y0, x1, y1 ] = this.city.bounds;
		for ( let k = 0; k * 12 < n; k ++ ) {

			await this.world.bloc( { faction: FACTION.BYSTANDER, kind: 'bystanders', at: [ rand( x0 + 80, x1 - 80 ), rand( y0 + 80, y1 - 80 ) ],
				n: Math.min( 12, n - k * 12 ), groupSize: 12, spread: 60, layer: pick( this.wander ), speed: [ 0.7, 1.1 ] } );

		}

	}

	// ---------------------------------------------------------------- per frame (driven by Game)
	update( dt, stats ) {

		this.t += dt;
		this.stats = stats;
		if ( stats ) this._trackOpinion( stats );
		for ( const r of Object.values( this.resources ) ) if ( r.cooldown ) r.ready = Math.max( 0, r.ready - dt );
		const due = this.timers.filter( ( t ) => t.at <= this.t );
		this.timers = this.timers.filter( ( t ) => t.at > this.t );
		for ( const t of due ) t.fn();

		if ( this.shelters.length && this.shelters.some( ( s ) => s.until <= this.t ) ) {

			this.shelters = this.shelters.filter( ( s ) => s.until > this.t );
			this.crowd.setShelter( this.shelters.map( ( s ) => s.id ) );

		}

		if ( this.world.intel && this.world.intel !== this._medIntel ) { this._medIntel = this.world.intel; this.treat( this.world.intel ); }
		// big swings at once, small ones (a storm's steady drain) batched every 8 s
		const sw = Math.abs( this._sway ?? 0 );
		if ( this.side === 'protest' && this.world.intel && ( sw >= 5 || ( sw >= 2 && this.t - ( this._swayT ?? - 99 ) >= 8 ) ) ) { this._swayT = this.t; this.sway(); }
		if ( this.side === 'protest' ) { this.fireTick( dt ); if ( this.world.intel && this.t - ( this._succT ?? 0 ) > 2 ) { this._succT = this.t; this.succession(); } }

		if ( this.wander && Math.random() < dt * 0.5 ) {

			const by = this.world.groupsOf( FACTION.BYSTANDER );
			if ( by.length ) this.world.setLayer( pick( by ), pick( this.wander ) );

		}

		// leaders snatched by police → group loses heart
		for ( const g of this.world.groups ) {

			if ( g.faction === FACTION.POLICE || g.leaderState !== 'arrested' || g.leaderReported ) continue;
			g.leaderReported = true;
			this.crowd.setGroup( g.id, { morale: 0.15 } );
			this.onLeaderArrested?.( g );

		}

		if ( ! this.result ) { this.cannonAI?.tick( dt ); this.tick( dt ); }

	}

	// a cordon closed ranks or fell back (World.cordonCheck, from Game.onIntel)
	onCordon( e ) {

		this.cannonAI?.onCordon( e );

	}

	_trackOpinion( s ) {

		const c = {
			injByPolice: s[ STAT.INJ_BY_POLICE ], injOther: s[ STAT.INJ_OTHER ], injPolice: s[ STAT.INJ_POLICE ],
			arrested: s[ STAT.ARRESTED ], arrestedSitters: s[ STAT.ARRESTED_SITTERS ], gone: s[ STAT.GONE ],
		};
		if ( this.prev ) {

			const d = ( k ) => Math.max( 0, c[ k ] - this.prev[ k ] );
			const w = this.opinionWeights();
			const delta = d( 'injByPolice' ) * w.injByPolice + d( 'injPolice' ) * w.injPolice + d( 'arrested' ) * w.arrested
				+ d( 'arrestedSitters' ) * w.arrestedSitters + d( 'injOther' ) * w.injOther;
			if ( delta !== 0 ) {

				this._pending = ( this._pending ?? 0 ) + delta;
				this._pendingWhy = d( 'injByPolice' ) ? 'injuries by police' : d( 'injPolice' ) ? 'officers hurt' : d( 'arrestedSitters' ) ? 'arrests' : this._pendingWhy;

			}

		}

		// show opinion movement in readable chunks rather than every frame
		if ( Math.abs( this._pending ?? 0 ) >= 1 ) {

			const k = Math.trunc( this._pending );
			this.nudgeOpinion( k, this._pendingWhy );
			this._pending -= k;

		}

		Object.assign( this.counters, c );
		this.prev = c;

	}

	// opinion change per event; police missions: violence by police costs, violence against police earns
	opinionWeights() {

		return { injByPolice: - 0.5, injPolice: 0.25, arrested: - 0.05, arrestedSitters: - 0.15, injOther: - 0.05 };

	}

	// ---------------------------------------------------------------- orders: police side
	policeCommands() {

		const g = this.game;
		return [
			{ key: 'rmb', label: 'Move', hint: 'right-click', needsSel: true },
			{ key: 'l', label: 'Cordon line', needsSel: true, run: () => g.drawLine() },
			{ key: 'k', label: 'Kettle', needsSel: true, run: ( x, y ) => this.escalate( 1 ) || this.world.kettle( g.squads, x, y, Math.max( 14, Math.sqrt( g.squads.reduce( ( s, q ) => s + q.members.length, 0 ) ) * 2.6 ), this.world.intel.pos ) },
			{ key: 'c', label: 'Charge', needsSel: true, run: ( x, y ) => this.escalate( 1 ) || this.world.charge( g.squads, x, y ) },
			{ key: 'a', label: 'Arrest', needsSel: true, run: ( x, y ) => this.world.arrest( g.squads, x, y ) },
			{ key: 's', label: 'Shield push', needsSel: true, forCordon: true, aim: true, hint: 'squads in a cordon line · S · hold the left button to aim, release to advance', run: ( x, y ) => this.shieldPush( x, y ) },
			{ key: 'x', label: 'Snatch leader', needsSel: true, run: ( x, y ) => this.snatch( x, y ) },
			{ key: 'g', label: 'Tear gas', resource: 'gas', run: ( x, y ) => this.useGas( x, y ) },
			...( this.world.patrols?.cars.some( ( c ) => c.water && c.selectable )
				? [ { key: 'w', label: 'Water cannon', resource: 'water', needsSel: true, forCars: true, aim: true, hint: 'select the truck · W · hold the left button to aim, release to spray', run: ( x, y ) => this.spray( x, y ) } ] : [] ),
			{ key: 'f', label: 'Reinforce', resource: 'reinforce', run: ( x, y ) => this.reinforce( x, y ) },
			{ key: 'o', label: 'Open fire', needsSel: true, danger: true, run: () => this.game.confirmFirearms() },
			...( this.world.patrols?.cars.some( ( c ) => c.selectable ) ? [ { key: 'u', label: 'Crew in / out', needsSel: true, forCars: true, run: () => this.world.patrols.toggleCrew( g.cars ) } ] : [] ),
		];

	}

	// nearest CCTV-identified leader to the cursor → selected squads go and arrest them
	snatch( x, y ) {

		const cands = this.world.groups.filter( ( q ) => q.faction !== FACTION.POLICE && q.identified && q.leaderState === 'active' );
		let best = null, bd = 60 * 60;
		for ( const q of cands ) {

			const d = ( q.leaderPos[ 0 ] - x ) ** 2 + ( q.leaderPos[ 1 ] - y ) ** 2;
			if ( d < bd ) { bd = d; best = q; }

		}

		if ( ! best ) { this.game.sound?.refuse(); this.event( 'No identified leader near the cursor — leaders show up under CCTV coverage', 'warn' ); return; }
		for ( const s of this.game.squads ) s.snatch = best;
		this.world.arrest( this.game.squads, ...best.leaderPos );
		this.event( `Snatch squad sent after the leader of ${best.label}`, 'info', best.leaderPos );

	}

	// a cordon advances shields up and shoves the crowd in front of it back (World.shieldPush)
	shieldPush( x, y ) {

		const L = this.world.shieldPush( this.game.squads, x, y );
		if ( ! L ) { this.game.sound?.refuse(); this.event( 'Aim ahead of the line to push (up to 40 m)', 'warn' ); return null; }
		this.escalate( 1 );
		this.game.sound?.order( 's', [ x, y ] );
		this.event( `${L.squads.map( ( q ) => q.label ).join( ' + ' )}: shields up, advancing ${Math.round( L.push.d )} m`, 'info', [ x, y ] );
		return L;

	}

	useGas( x, y ) {

		if ( ! this.spend( 'gas' ) ) return;
		this.escalate( 2, 'tear gas' );
		this.world.gas( x, y );
		this.counters.gas ++;
		this.nudgeOpinion( this.gasOpinion ?? - 2, 'tear gas' );
		this.event( 'Tear gas deployed', 'warn', [ x, y ] );

	}

	// a water cannon truck (selected, aimed with W): a 10 s jet from the truck toward (x, y)
	spray( x, y ) {

		const truck = this.game.cars.find( ( c ) => c.water );
		if ( ! truck ) return;
		if ( truck.sprayUntil > this.t ) { this.game.sound?.refuse(); this.event( `${truck.label} is still spraying`, 'warn' ); return; }
		if ( ! this.spend( 'water' ) ) return;
		this.world.spray( truck, Math.atan2( y - truck.y, x - truck.x ) );
		truck.sprayUntil = this.t + WATER_JET;
		this.escalate( 3, 'water cannon' );
		this.nudgeOpinion( this.waterOpinion ?? - 4, 'water cannon' );
		this.event( 'Water cannon spraying', 'warn', [ x, y ] );

	}

	// Last resort. Abstract but heavy: casualties around the selected squads, mass panic, rage among the
	// radicals, a collapse in public opinion, and the mission result is capped at one star.
	openFire() {

		const I = this.world.intel;
		if ( ! I || ! this.game.squads.length ) return;
		this.game.sound?.firearms( this.game.squads.find( ( q ) => q.center )?.center ?? null );
		const civ = ( f ) => f === FACTION.PROTESTER || f === FACTION.COUNTER || f === FACTION.BYSTANDER;
		let hit = 0;
		for ( const sq of this.game.squads ) {

			if ( ! sq.center ) continue;
			const [ cx, cy ] = sq.center;
			const near = [];
			for ( let i = 0; i < this.crowd.count; i ++ ) {

				const f = I.st[ i * 4 ];
				if ( ! civ( f ) ) continue;
				const d = Math.hypot( I.pos[ i * 2 ] - cx, I.pos[ i * 2 + 1 ] - cy );
				if ( d < 35 ) near.push( i );
				if ( d < 110 ) {

					const ag = I.st[ i * 4 + 2 ];
					if ( ag > 0.65 && f !== FACTION.BYSTANDER ) this.crowd.nudge( i, 0.4, 0.3 ); // radicals: rage
					else this.crowd.nudge( i, 0.3, - 2 ); // everyone else: run

				}

			}

			for ( let k = 0; k < Math.min( 8, near.length ); k ++ ) {

				const i = near.splice( Math.floor( Math.random() * near.length ), 1 )[ 0 ];
				this.crowd.setFaction( i, 10 + I.st[ i * 4 ] );
				hit ++;

			}

		}

		this.counters.shot = ( this.counters.shot ?? 0 ) + hit;
		this.escalate( 4, 'FIREARMS' );
		this.nudgeOpinion( - 25 - hit, 'shots fired' );
		this.event( `Shots fired — ${hit} people down. The crowd is panicking.`, 'bad', this.game.squads[ 0 ].center );

	}

	async reinforce( x, y ) {

		if ( ! this.spend( 'reinforce' ) ) return;
		const stations = this.city.landmarks.filter( ( l ) => l.kind === 'police' && l.name !== 'Policija' ).map( ( l ) => l.pos );
		let best = stations[ 0 ], bd = Infinity;
		for ( const s of stations ) {

			const d = ( s[ 0 ] - x ) ** 2 + ( s[ 1 ] - y ) ** 2;
			if ( d < bd ) { bd = d; best = s; }

		}

		this.game.sound?.reinforce( best );
		const sq = await this.world.squad( { kind: 'squad', label: 'Reinforcements', at: best, n: 30 } );
		await this.world.moveSquads( [ sq ], x, y );
		this.event( 'Reinforcement squad dispatched from ' + ( this.city.landmarks.find( ( l ) => l.pos === best )?.name ?? 'station' ), 'good', best );

	}

	// loudspeaker dispersal order over (x, y): calmer groups give up (sendHome), the hard core gets angrier.
	// A group hears the order once; repeating it only winds them up. calm: agitation below which a group
	// complies, chance: odds that a more agitated one does. Returns how many people were sent home.
	dispersal( x, y, r = 70, { calm = 0.45, chance = 0.35 } = {} ) {

		let home = 0;
		this.game.sound?.dispersal( [ x, y ] );
		for ( const g of this.world.groupsOf( FACTION.PROTESTER ) ) {

			if ( ! g.center || g.home || ( ( g.center[ 0 ] - x ) ** 2 + ( g.center[ 1 ] - y ) ** 2 ) > r * r ) continue;
			if ( g.kind === 'hard' || g.kind === 'bloc' || g.ordered ) { for ( const i of g.members ) this.crowd.nudge( i, g.ordered ? 0.04 : 0.12, 0 ); continue; }
			g.ordered = true;
			if ( g.agitation < calm || Math.random() < chance ) { this.sendHome( g ); home += g.alive; }
			else for ( const i of g.members ) this.crowd.nudge( i, 0.05, - 0.2 );

		}

		return home;

	}

	sendHome( g ) {

		g.home = true;
		for ( const i of g.members ) this.crowd.nudge( i, 0, - 2 );

	}

	spend( name ) {

		const r = this.resources[ name ];
		if ( ! r || r.left <= 0 || r.ready > 0 ) return false;
		r.left --;
		if ( r.cooldown ) r.ready = r.cooldown;
		return true;

	}

	// ---------------------------------------------------------------- orders: protest side
	protestCommands() {

		const g = this.game;
		return [
			{ key: 'rmb', label: 'March', hint: 'right-click', needsSel: true },
			{ key: 'h', label: 'Hold', needsSel: true, run: () => this.world.setMode( g.selected, MODE.HOLD ) },
			{ key: 'e', label: 'Fire up', hint: 'again: push the line · 3×: storm it (costs sympathy)', needsSel: true, run: () => this.fireUp( g.selected ) },
			{ key: 'q', label: 'Calm down', hint: 'one level down', needsSel: true, run: () => this.calmDown( g.selected ) },
			{ key: 'd', label: 'Disperse', needsSel: true, run: () => this.world.setMode( g.selected, MODE.DISPERSE ) },
			{ key: 's', label: 'Sit down / stand up', needsSel: true, run: () => this.sitDown( g.selected ) },
			{ key: 'b', label: 'Shield wall', hint: 'slow, hard to push or snatch from', needsSel: true, run: () => this.shieldWall( g.selected ) },
			{ key: 'w', label: 'Be water', hint: 'scatter, regroup at the cursor', needsSel: true, run: ( x, y ) => this.beWater( g.selected, x, y ) },
			{ key: 'v', label: 'Split', needsSel: true, run: () => this.splitSel() },
			{ key: 'm', label: 'Merge', needsSel: true, run: () => this.mergeSel() },
			{ key: 'u', label: 'Umbrellas', hint: 'gas barely reaches them for 0:30', resource: 'umbrella', needsSel: true, run: () => this.umbrellas( g.selected ) },
			{ key: 'r', label: 'Rally call', resource: 'rally', run: ( x, y ) => this.rally( x, y ) },
		].filter( ( c ) => ! c.resource || this.resources[ c.resource ] )
			// any order to a group also brings back those who were drifting home
			.map( ( c ) => ( c.needsSel && c.run ? { ...c, run: ( ...a ) => { this.recall( g.selected ); return c.run( ...a ); } } : c ) );

	}

	// orders reach a group through its leader: wavering members (resolve below 0.3, even those already
	// heading home) come back. A group without a leader does not listen until someone steps up.
	recall( groups ) {

		const deaf = [];
		for ( const q of this.civ( groups ) ) {

			if ( q.leaderState !== 'active' ) { deaf.push( q ); continue; }
			for ( const i of q.members ) this.crowd.recall( i, 0.3 );

		}

		if ( deaf.length ) this.event( `${deaf[ 0 ].label} has no leader: they won't listen until someone steps up${deaf[ 0 ].succession ? ` (${Math.ceil( Math.max( 0, deaf[ 0 ].succession - this.t ) )} s)` : ''}`, 'warn', deaf[ 0 ].center );

	}

	// protest side: 20 s after a leader is arrested or hurt, the nearest member to the group's centre takes over
	succession() {

		const I = this.world.intel;
		for ( const g of this.world.groups ) {

			if ( g.faction !== FACTION.PROTESTER || g.kind === 'bystanders' || ! g.leaderState || g.leaderState === 'active' || ! ( g.alive >= 5 ) ) { g.succession = null; continue; }
			if ( ! g.succession ) { g.succession = this.t + 20; continue; }
			if ( this.t < g.succession || ! g.center ) continue;
			let bi = - 1, bd = Infinity;
			for ( const i of g.members ) {

				if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
				const d = ( I.pos[ i * 2 ] - g.center[ 0 ] ) ** 2 + ( I.pos[ i * 2 + 1 ] - g.center[ 1 ] ) ** 2;
				if ( d < bd ) { bd = d; bi = i; }

			}

			if ( bi < 0 ) continue;
			this.crowd.regroup( bi, g.id, ROLE.LEADER );
			this.crowd.setGroup( g.id, { leader: bi, morale: 0.45 } );
			Object.assign( g, { leader: bi, leaderState: 'active', leaderPos: [ I.pos[ bi * 2 ], I.pos[ bi * 2 + 1 ] ], leaderReported: false, succession: null } );
			this.event( `A new leader steps up in ${g.label}`, 'good', g.leaderPos );

		}

	}

	civ( groups ) { return groups.filter( ( q ) => q.faction === FACTION.PROTESTER && ( q.alive ?? 1 ) > 0 ); }

	// passive resistance: sitters are slow to arrest, and force against them is a bad look
	sitDown( groups ) {

		const gs = this.civ( groups );
		const up = gs.length && gs.every( ( q ) => q.mode === MODE.SIT );
		this.world.setMode( gs, up ? MODE.HOLD : MODE.SIT );
		this.event( up ? `${gs.length} group(s) stand up` : `${gs.length} group(s) sit down: slow to arrest, hard to justify force against`, 'info' );

	}

	// locked arms and banners at the front: half speed, pushed back far less, hard to pull people out of
	shieldWall( groups ) {

		const gs = this.civ( groups );
		const off = gs.length && gs.every( ( q ) => q.mode === MODE.SHIELD );
		this.world.setMode( gs, off ? MODE.MARCH : MODE.SHIELD );
		this.event( off ? `${gs.length} group(s) break the shield wall` : `${gs.length} group(s) form a shield wall`, 'info' );

	}

	// scatter in all directions for 8 s (out of a closing kettle, away from a charge), then meet again at (x, y)
	beWater( groups, x, y ) {

		const gs = this.civ( groups );
		if ( ! gs.length ) return;
		this.world.setMode( gs, MODE.DISPERSE );
		for ( const q of gs ) { q.scatterUntil = this.t + 8; for ( const i of q.members ) this.crowd.nudge( i, - 0.1, 0 ); }
		this.after( 8, () => this.world.march( gs.filter( ( q ) => ( q.alive ?? 0 ) > 0 ), x, y, 20 ) );
		this.event( `${gs.length} group(s) scatter; they regroup at the marked point`, 'info', [ x, y ] );

	}

	splitSel() {

		const made = this.civ( this.game.selected ).map( ( q ) => this.world.split( q ) ).filter( Boolean );
		if ( ! made.length ) { this.event( 'Too few people to split', 'warn' ); return; }
		this.game.selected.push( ...made );
		this.event( `Split: ${made.length} new group(s)`, 'info' );

	}

	mergeSel() {

		const into = this.world.merge( this.civ( this.game.selected ) );
		if ( ! into ) { this.event( 'Select two or more groups to merge', 'warn' ); return; }
		this.game.selected = [ into ];
		this.event( `Merged into ${into.label}`, 'info', into.center );

	}

	umbrellas( groups ) {

		const gs = this.civ( groups ).slice( 0, 8 );
		if ( ! gs.length || ! this.spend( 'umbrella' ) ) return;
		this.shelters = [ ...this.shelters.filter( ( s ) => ! gs.some( ( q ) => q.id === s.id ) ), ...gs.map( ( q ) => ( { id: q.id, until: this.t + 30 } ) ) ].slice( - 8 );
		this.crowd.setShelter( this.shelters.map( ( s ) => s.id ) );
		this.event( `Umbrellas up: ${gs.length} group(s) shielded from gas for 0:30`, 'good' );

	}

	// medics (groups of kind 'medics'): take injured protesters within 10 m off the street, two per readback each
	treat( I ) {

		const med = this.world.groups.filter( ( q ) => q.kind === 'medics' && ( q.alive ?? 0 ) > 0 && q.center );
		for ( const q of med ) {

			let n = 0;
			for ( let i = 0; i < this.crowd.count && n < 2; i ++ ) {

				const f = I.st[ i * 4 ];
				if ( ( f !== 10 && f !== 20 ) || ( I.pos[ i * 2 ] - q.center[ 0 ] ) ** 2 + ( I.pos[ i * 2 + 1 ] - q.center[ 1 ] ) ** 2 > 100 ) continue;
				this.crowd.setFaction( i, - 1 ); // off the map, not "went home"
				this.counters.treated = ( this.counters.treated ?? 0 ) + 1;
				n ++;

			}

			// medics keep their heads
			if ( q.agitation > 0.3 ) for ( const i of q.members ) this.crowd.nudge( i, - 0.05, 0 );

		}

	}

	// Fire up in levels (g.fire): 1 angrier and more committed · 2 PUSH: lean on police lines (−1 sympathy) ·
	// 3 STORM: through the line whatever it costs, for STORM_TIME s, then exhausted back to PUSH (−8 sympathy,
	// and a steady drain while storming)
	fireUp( groups ) {

		const gs = this.civ( groups ).filter( ( q ) => q.mode !== MODE.SIT && q.kind !== 'medics' );
		if ( ! gs.length ) return;
		const level = Math.min( 3, Math.max( ...gs.map( ( q ) => this.fireLevel( q ) ) ) + 1 );
		for ( const q of gs ) {

			q.fire = level;
			for ( const i of q.members ) this.crowd.nudge( i, level === 3 ? 0.6 : 0.25, 0.25 * level );
			this.crowd.setGroup( q.id, { morale: Math.min( 1, 0.6 + 0.15 * level ) } );
			if ( level === 2 ) this.world.setMode( [ q ], MODE.PUSH );
			if ( level === 3 ) { this.world.setMode( [ q ], MODE.STORM ); q.stormUntil = this.t + STORM_TIME; }

		}

		for ( const q of gs ) if ( q.center ) this.game.sound?.swell( q.center, level / 3 );
		if ( level === 1 ) this.event( `${gs.length} group(s) fired up: angrier, more committed. Again to push the line`, 'warn' );
		if ( level === 2 ) { this.nudgeOpinion( - 1, 'pushing the police' ); this.event( `${gs.length} group(s) lean on the police line. Once more to storm it`, 'warn' ); }
		if ( level === 3 ) {

			this.nudgeOpinion( - 8, 'storming the police line' );
			this.event( `${gs.length} group(s) STORM the police line, whatever it costs. Sympathy is collapsing`, 'bad', gs[ 0 ].center );

		}

	}

	// another order (hold, sit, shield wall, disperse) ends a push or a storm
	fireLevel( q ) { return q.mode === MODE.STORM ? 3 : q.mode === MODE.PUSH ? 2 : q.fire === 1 ? 1 : 0; }

	calmDown( groups ) {

		const gs = this.civ( groups );
		for ( const q of gs ) {

			q.fire = Math.max( 0, this.fireLevel( q ) - 1 );
			q.stormUntil = null;
			for ( const i of q.members ) this.crowd.nudge( i, - 0.35, 0.1 );
			if ( q.mode === MODE.STORM || q.mode === MODE.PUSH ) this.world.setMode( [ q ], q.fire >= 2 ? MODE.PUSH : MODE.MARCH );

		}

		this.event( `${gs.length} group(s) calmed down`, 'good' );

	}

	// storms burn out; while they last, sympathy drains
	fireTick( dt ) {

		let storming = 0;
		for ( const q of this.world.groups ) {

			if ( q.mode !== MODE.STORM || ! ( q.alive > 0 ) ) continue;
			storming ++;
			if ( this.t >= q.stormUntil ) {

				q.fire = 2;
				this.world.setMode( [ q ], MODE.PUSH );
				this.event( `${q.label} is exhausted: back to pushing`, 'info', q.center );

			}

		}

		if ( storming ) {

			this._storm = ( this._storm ?? 0 ) + dt * Math.min( storming, 3 ) / 10; // up to −0.3/s
			if ( this._storm >= 1 ) { this.nudgeOpinion( - Math.trunc( this._storm ), 'riot on camera' ); this._storm %= 1; }

		}

	}

	rouse( groups, dAg, dRes ) {

		for ( const q of groups ) {

			for ( const i of q.members ) this.crowd.nudge( i, dAg, dRes );
			this.crowd.setGroup( q.id, { morale: Math.min( 1, 0.5 + dRes * 2 ) } );

		}

		this.event( dAg > 0 ? `${groups.length} group(s) fired up — angrier, more committed` : `${groups.length} group(s) calmed down`, dAg > 0 ? 'warn' : 'good' );

	}

	// default rally: no-op unless a mission sets one up
	rally() {}

	// ---------------------------------------------------------------- shared drawing helpers
	// protest-side status tags on groups: medics, sitting, shield wall, umbrellas, scattering
	drawTools( o ) {

		this.cannonAI?.draw( o );
		if ( o.mpp > 1.2 ) return;
		const ctx = o.ctx, shel = new Set( this.shelters.map( ( s ) => s.id ) );
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		for ( const g of this.world.groups ) {

			if ( g.faction !== FACTION.PROTESTER || ! g.center || ! ( g.alive > 0 ) ) continue;
			const tags = [];
			if ( g.kind === 'medics' ) tags.push( '✚ MEDICS' );
			if ( g.mode === MODE.SIT ) tags.push( 'SITTING' );
			if ( g.mode === MODE.SHIELD ) tags.push( 'SHIELD WALL' );
			if ( g.mode === MODE.PUSH ) tags.push( 'PUSHING' );
			if ( g.mode === MODE.STORM ) tags.push( `STORMING ${Math.ceil( Math.max( 0, g.stormUntil - this.t ) )}s` );
			if ( this.fireLevel( g ) === 1 ) tags.push( 'FIRED UP' );
			if ( shel.has( g.id ) ) tags.push( '☂' );
			if ( g.scatterUntil > this.t ) tags.push( 'SCATTERING' );
			if ( ! tags.length ) continue;
			const [ x, y ] = o.toScreen( ...g.center );
			ctx.fillStyle = g.kind === 'medics' ? 'rgba(233,228,216,0.95)' : 'rgba(255,176,32,0.9)';
			ctx.fillText( tags.join( ' · ' ), x, y + 4 );

		}

	}

	drawZone( o, x, y, r, color, label, fill = 0.06 ) {

		const [ sx, sy ] = o.toScreen( x, y );
		const rr = r / o.mpp;
		const ctx = o.ctx;
		ctx.beginPath();
		ctx.arc( sx, sy, rr, 0, Math.PI * 2 );
		ctx.fillStyle = color.replace( ')', `,${fill})` ).replace( 'rgb', 'rgba' );
		ctx.fill();
		ctx.setLineDash( [ 6, 6 ] );
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.2;
		ctx.stroke();
		ctx.setLineDash( [] );
		if ( label ) {

			ctx.fillStyle = color;
			ctx.font = '600 11px "IBM Plex Mono", monospace';
			ctx.textAlign = 'center';
			ctx.fillText( label, sx, sy - rr - 6 );

		}

	}

}

export { World, FACTION, MODE, ROLE, STAT, ZONE, rand, pick };
