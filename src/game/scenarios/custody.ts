// Arrest-and-transport custody jobs, ported from the built-in Sit-in squads: walk to the spot in formation, restrain
// people one at a time, carry them to the nearest drop-off and hand them over. Private host code; scenarios see
// handles, counts and events only.
import { FACTION, MODE } from '../../sim/crowd.ts';
import { check, fields, point } from './definition.ts';

export const CUSTODY_DEFAULTS = Object.freeze( { capacity: 8, processSeconds: 3.5, unloadSeconds: 5, blockadeRadius: 10, blockadePeople: 15 } );

export function custodyOptions( value ) {

	if ( value === true ) return CUSTODY_DEFAULTS;
	fields( value, Object.keys( CUSTODY_DEFAULTS ), 'policeCommands.custody' );
	const options = { ...CUSTODY_DEFAULTS, ...value };
	check( Number.isInteger( options.capacity ) && options.capacity >= 1 && options.capacity <= 50, 'policeCommands.custody.capacity', 'must be an integer from 1 to 50' );
	for ( const key of [ 'processSeconds', 'unloadSeconds' ] ) check( Number.isFinite( options[ key ] ) && options[ key ] >= 0 && options[ key ] <= 120,
		`policeCommands.custody.${key}`, 'must be from 0 to 120 seconds' );
	check( Number.isFinite( options.blockadeRadius ) && options.blockadeRadius > 0 && options.blockadeRadius <= 100, 'policeCommands.custody.blockadeRadius', 'must be positive and at most 100 meters' );
	check( Number.isInteger( options.blockadePeople ) && options.blockadePeople >= 1 && options.blockadePeople <= 1000, 'policeCommands.custody.blockadePeople', 'must be an integer from 1 to 1000' );
	return Object.freeze( options );

}

const near = ( a, b, r ) => ( a[ 0 ] - b[ 0 ] ) ** 2 + ( a[ 1 ] - b[ 1 ] ) ** 2 < r * r;
const bump = ( map, key, n = 1 ) => map.set( key, ( map.get( key ) ?? 0 ) + n );

// env: time, intel, count, capacity, police, moveSquads, arrest, setGroup, countNear, sitter, actorOf, emit, fail
export class CustodyJobs {

	declare env: any;
	declare options: any;
	declare dropoffs: any[];
	declare jobs: Map<any, any>;
	declare prevFac: Float32Array | null;
	declare handedOver: Map<string | null, number>;
	declare unescorted: Map<string | null, number>;

	constructor( env, options, dropoffs = [] ) {

		this.env = env;
		this.options = options;
		this.dropoffs = dropoffs;
		this.jobs = new Map<any, any>();
		this.prevFac = null;
		this.handedOver = new Map();
		this.unescorted = new Map();

	}

	get carried() { let n = 0; for ( const job of this.jobs.values() ) n += job.held; return n; }

	start( squads, at ) {

		for ( const s of squads.filter( ( q ) => q.faction === FACTION.POLICE ) ) {

			const previous = this.jobs.get( s );
			const job = { at, held: previous?.held ?? 0, byActor: previous?.byActor ?? new Map() };
			this.jobs.set( s, job );
			if ( job.held >= this.options.capacity ) this.cart( s );
			else this.approach( s );

		}

	}

	stop( squads ) { for ( const s of squads ) this.jobs.delete( s ); }

	approach( s ) {

		const job = this.jobs.get( s );
		Object.assign( job, { state: 'approach', ready: false } );
		this.env.moveSquads( [ s ], ...job.at ).then( () => { job.ready = true; this.env.setGroup( s.id, { aggression: 0.15 } ); }, this.env.fail );

	}

	engage( s ) {

		const job = this.jobs.get( s );
		Object.assign( job, { state: 'arrest', ready: false } );
		this.env.arrest( [ s ], ...job.at, 14 ).then( () => { job.target = s.arrestAt; job.ready = true; this.env.setGroup( s.id, { aggression: 0.15 } ); }, this.env.fail );

	}

	// one detainee at a time: the squad holds formation where it stands for processSeconds
	restrain( s ) {

		const job = this.jobs.get( s ), c = s.center;
		Object.assign( job, { state: 'process', t: this.env.time(), hold: c } );
		s.mode = MODE.FORMATION;
		s.anchor = c;
		this.env.setGroup( s.id, { mode: MODE.FORMATION, ax: c[ 0 ], ay: c[ 1 ], aggression: 0.15 } );

	}

	cart( s ) {

		const job = this.jobs.get( s ), c = s.center ?? job.at;
		const van = this.dropoffs.reduce( ( p, q ) => ( ( q.at[ 0 ] - c[ 0 ] ) ** 2 + ( q.at[ 1 ] - c[ 1 ] ) ** 2 < ( p.at[ 0 ] - c[ 0 ] ) ** 2 + ( p.at[ 1 ] - c[ 1 ] ) ** 2 ? q : p ) );
		Object.assign( job, { state: 'cart', van, ready: false } );
		this.env.moveSquads( [ s ], ...van.at ).then( () => { job.ready = true; }, this.env.fail );

	}

	// another order took the squad: it keeps its detainees but drops the job
	cancelled( s ) {

		const j = this.jobs.get( s );
		if ( ! j.ready ) return false;
		if ( j.state === 'arrest' ) return s.mode !== MODE.ARREST || ! s.arrestAt || s.arrestAt !== j.target;
		if ( j.state === 'process' ) return s.mode !== MODE.FORMATION || s.anchor !== j.hold;
		const to = j.state === 'approach' ? j.at : j.van?.at;
		if ( to ) return s.mode !== MODE.FORMATION || ! s.anchor || Math.hypot( s.anchor[ 0 ] - to[ 0 ], s.anchor[ 1 ] - to[ 1 ] ) > 1;
		return false;

	}

	// once per readback: who got arrested (and by which squad), then each squad's job, then the drop-off blockades
	update( I ) {

		const env = this.env, { capacity, processSeconds, unloadSeconds, blockadeRadius, blockadePeople } = this.options;
		const pol = env.police();
		if ( ! this.prevFac || this.prevFac.length < env.capacity() ) {

			const grown = new Float32Array( env.capacity() ).fill( - 1 );
			if ( this.prevFac ) grown.set( this.prevFac );
			this.prevFac = grown;

		}
		for ( let i = 0; i < env.count(); i ++ ) {

			const f = I.faction( i ), was = this.prevFac[ i ];
			this.prevFac[ i ] = f;
			if ( ( f !== FACTION.ARRESTED && f !== FACTION.ARRESTED_SITTER ) || was === f || was < 0 || was > 9.5 ) continue;
			const actor = env.actorOf( i ), x = I.x( i ), y = I.y( i );
			let s = null, bd = 12 * 12; // the nearest squad making arrests, else the nearest squad at all
			for ( const q of pol ) { const d = ( q.center[ 0 ] - x ) ** 2 + ( q.center[ 1 ] - y ) ** 2 - ( q.mode === MODE.ARREST ? 1e4 : 0 ); if ( d < bd ) { bd = d; s = q; } }
			if ( s ) {

				if ( ! this.jobs.has( s ) ) this.jobs.set( s, { state: 'idle', held: 0, byActor: new Map(), ready: true } );
				const job = this.jobs.get( s );
				job.held ++;
				bump( job.byActor, actor );
				if ( job.state === 'arrest' && job.ready ) this.restrain( s );

			} else bump( this.unescorted, actor );
			env.emit( 'custody.detained', { squad: s, actor, position: [ x, y ] } );

		}

		for ( const s of pol ) {

			const j = this.jobs.get( s );
			if ( ! j ) continue;
			if ( this.cancelled( s ) ) { j.state = 'idle'; j.ready = true; }
			const c = s.center;

			if ( j.state === 'approach' && j.ready && near( c, j.at, 10 ) ) this.engage( s );
			else if ( j.state === 'process' && env.time() - j.t >= processSeconds ) {

				if ( j.held >= capacity ) { this.cart( s ); continue; }
				j.state = 'arrest';
				s.mode = MODE.ARREST;
				env.setGroup( s.id, { mode: MODE.ARREST, ax: s.arrestAt[ 0 ], ay: s.arrestAt[ 1 ] } );

			} else if ( j.state === 'arrest' && j.ready ) {

				if ( j.held >= capacity ) { this.cart( s ); continue; }
				// the next person: sitters within 12 m of the spot, else anyone on the spot itself (6 m), nearest first
				let best = null, bd = Infinity, sit = false;
				for ( let i = 0; i < env.count(); i ++ ) {

					if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
					const x = I.x( i ), y = I.y( i ), dSpot = ( x - j.at[ 0 ] ) ** 2 + ( y - j.at[ 1 ] ) ** 2;
					const isSit = env.sitter( i ) && dSpot < 144;
					if ( ! isSit && ( sit || dSpot > 36 ) ) continue;
					const d = ( x - c[ 0 ] ) ** 2 + ( y - c[ 1 ] ) ** 2;
					if ( isSit && ! sit ) { sit = true; bd = Infinity; }
					if ( d < bd ) { bd = d; best = [ x, y ]; }

				}

				if ( best ) {

					if ( Math.hypot( best[ 0 ] - s.arrestAt[ 0 ], best[ 1 ] - s.arrestAt[ 1 ] ) > 1 ) {

						s.arrestAt = best;
						j.target = best;
						env.setGroup( s.id, { ax: best[ 0 ], ay: best[ 1 ] } );

					}

				} else if ( j.held ) this.cart( s );
				else { j.state = 'idle'; env.emit( 'custody.idle', { squad: s, reason: 'nobody-left', at: j.at } ); }

			} else if ( j.state === 'cart' && j.ready && near( c, j.van.at, 14 ) ) { j.state = 'unload'; j.t = env.time(); }
			else if ( j.state === 'unload' ) {

				if ( j.van.blocked ) j.t = env.time();
				else if ( env.time() - j.t >= unloadSeconds ) this.handOver( s );

			} else if ( j.state === 'idle' && j.held ) {

				const van = this.dropoffs.find( ( v ) => near( c, v.at, 14 ) && ! v.blocked );
				if ( van ) { j.van = van; j.state = 'unload'; j.t = env.time(); }

			}

		}

		for ( const v of this.dropoffs ) {

			const blocked = env.countNear( v.at[ 0 ], v.at[ 1 ], blockadeRadius ) >= blockadePeople;
			if ( blocked !== v.blocked ) env.emit( blocked ? 'custody.blockaded' : 'custody.cleared', { dropoff: v.id } );
			v.blocked = blocked;

		}

	}

	handOver( s ) {

		const j = this.jobs.get( s );
		for ( const [ actor, n ] of j.byActor ) bump( this.handedOver, actor, n );
		if ( j.held ) this.env.emit( 'custody.handed-over', { squad: s, dropoff: j.van.id, people: j.held,
			byActor: Object.fromEntries( [ ...j.byActor ].filter( ( [ actor ] ) => actor !== null ) ) } );
		j.held = 0;
		j.byActor = new Map();
		// back to the spot while there are sitters left there
		if ( j.at && this.sittersNear( j.at, 12 ) ) this.approach( s );
		else j.state = 'idle';

	}

	sittersNear( at, r ) {

		const I = this.env.intel();
		for ( let i = 0; i < this.env.count(); i ++ ) if ( this.env.sitter( i ) && I.faction( i ) === FACTION.PROTESTER && ( I.x( i ) - at[ 0 ] ) ** 2 + ( I.y( i ) - at[ 1 ] ) ** 2 < r * r ) return true;
		return false;

	}

}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// runtime side: drop-off registry, job driver, immutable observations and handle-based events
export class CustodyHost {

	declare runtime: any;
	declare dropoffs: Map<string, any>;
	declare jobs: CustodyJobs | null;
	declare lastIntel: any;

	constructor( runtime ) {

		this.runtime = runtime;
		this.dropoffs = new Map();
		this.jobs = null;
		this.lastIntel = null;

	}

	get options() { return this.runtime.definition.commands.find( ( command ) => command.id === 'arrest' )?.custody ?? null; }

	addDropoff( options ) {

		this.runtime.writable();
		check( this.options, 'custody.addDropoff', 'requires policeCommands({ custody })' );
		fields( options, [ 'id', 'at' ], 'custody.addDropoff' );
		check( typeof options.id === 'string' && ID.test( options.id ), 'custody.addDropoff.id', 'must be a lowercase slug' );
		check( ! this.dropoffs.has( options.id ), 'custody.addDropoff.id', `'${options.id}' is already registered` );
		this.dropoffs.set( options.id, { id: options.id, at: this.runtime.location( options.at ), blocked: false } );
		return Object.freeze( { id: options.id } );

	}

	driver() {

		if ( ! this.jobs ) {

			const runtime = this.runtime, env = runtime.adapter.custodyEnvironment();
			const squad = ( group ) => group && [ ...runtime.actors.values() ].find( ( record ) => Array.isArray( record.backend ) && record.backend.includes( group ) )?.handle || null;
			const actor = ( id ) => id === null ? null : runtime.actors.get( id )?.handle ?? null;
			this.jobs = new CustodyJobs( { ...env, fail: ( error ) => runtime.fail( error ),
				emit: ( type, payload ) => runtime.event( type, Object.freeze( {
					...payload, ...( 'squad' in payload ? { squad: squad( payload.squad ) } : {} ), ...( 'actor' in payload ? { actor: actor( payload.actor ) } : {} ),
					...( payload.position ? { position: point( payload.position, 'custody.position' ) } : {} ),
					...( payload.at ? { at: Object.freeze( [ ...payload.at ] ) } : {} ),
					...( payload.byActor ? { byActor: Object.freeze( { ...payload.byActor } ) } : {} ) } ) ) }, this.options, [] );

		}
		this.jobs.dropoffs = [ ...this.dropoffs.values() ];
		return this.jobs;

	}

	start( groups, at ) { this.driver().start( groups, at ); }

	update() {

		if ( ! this.jobs ) return;
		const intel = this.runtime.adapter.custodyEnvironment().intel();
		if ( ! intel || intel === this.lastIntel ) return;
		this.lastIntel = intel;
		this.driver().update( intel );

	}

	state() {

		const jobs = this.jobs, record = ( map ) => Object.freeze( Object.fromEntries( [ ...( map ?? [] ) ].filter( ( [ id ] ) => id !== null ) ) );
		const squads = jobs ? [ ...jobs.jobs ].map( ( [ group, job ] ) => ( { squad: [ ...this.runtime.actors.values() ]
			.find( ( value ) => Array.isArray( value.backend ) && value.backend.includes( group ) )?.handle, state: job.state, held: job.held } ) ).filter( ( entry ) => entry.squad ) : [];
		return Object.freeze( {
			carried: jobs?.carried ?? 0,
			handedOver: record( jobs?.handedOver ),
			unescorted: record( jobs?.unescorted ),
			dropoffs: Object.freeze( [ ...this.dropoffs.values() ].map( ( v ) => Object.freeze( { id: v.id, position: point( v.at, 'custody.dropoff' ), blocked: v.blocked } ) ) ),
			squads: Object.freeze( squads.map( ( entry ) => Object.freeze( entry ) ) ),
		} );

	}

	context() {

		return Object.freeze( { addDropoff: ( options ) => this.addDropoff( options ), state: () => this.state() } );

	}

}
