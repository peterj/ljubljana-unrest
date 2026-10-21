import {
	Mission, FACTION, MODE, ROLE, STAT, ZONE, fmt, rand, pick,
	BLUE, ORANGE, RED, WHITE, near, cars, squads,
} from '../sdk/index.js';

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
