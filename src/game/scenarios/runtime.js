import { check, fields, normalizeScenario, point } from './definition.js';

let nextRun = 1;
const terminal = new Set( [ 'finished', 'failed', 'disposed' ] );

export function formatTime( seconds ) {

	const whole = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( whole / 60 )}:${String( whole % 60 ).padStart( 2, '0' )}`;

}

export class ScenarioRuntime {

	constructor( definition, adapter, { onFinish = () => {}, onFailure = () => {}, timeout = 15000 } = {} ) {

		this.definition = normalizeScenario( definition );
		check( Number.isFinite( timeout ) && timeout > 0, 'runtime.timeout', 'must be positive and finite' );
		this.adapter = adapter;
		this.onFinish = onFinish;
		this.onFailure = onFailure;
		this.timeout = timeout;
		this.state = 'created';
		this.time = 0;
		this.result = null;
		this.error = null;
		this.run = nextRun ++;
		this.locations = new Map();
		this.actors = new Map();
		this.operations = new Set();
		this.nextOperation = 1;
		this.observation = null;
		this.lastSample = null;
		this.setupFailure = null;
		const runtime = this;
		this.context = Object.freeze( {
			spawn: Object.freeze( {
				crowd: ( options ) => this.spawn( 'crowd', options ),
				squad: ( options ) => this.spawn( 'squad', options ),
			} ),
			locations: Object.freeze( { get: ( id ) => this.location( id ) } ),
			actors: Object.freeze( { get: ( handle ) => this.actor( handle ) } ),
			presentation: Object.freeze( {
				focus: ( at, zoom = 0.5 ) => {

					this.writable();
					check( Number.isFinite( zoom ) && zoom > 0, 'presentation.focus.zoom', 'must be positive and finite' );
					this.adapter.focus( this.location( at ), zoom );

				},
			} ),
			get time() { return runtime.time; },
			get observation() { return runtime.observation; },
		} );

	}

	writable() {

		check( [ 'setting-up', 'briefing', 'running', 'paused' ].includes( this.state ), 'runtime', `cannot mutate while ${this.state}` );

	}

	location( reference ) {

		if ( Array.isArray( reference ) ) return point( reference, 'location' );
		check( typeof reference === 'string' && this.locations.has( reference ), 'location', `unknown location '${reference}'` );
		return this.locations.get( reference );

	}

	async setup() {

		check( this.state === 'created', 'runtime.setup', 'may only run once' );
		this.state = 'setting-up';
		try {

			for ( const [ id, reference ] of Object.entries( this.definition.locations ) ) {

				const value = Array.isArray( reference ) ? reference : this.adapter.place( reference.name );
				check( value !== undefined && value !== null, `scenario.locations.${id}`, `place '${reference.name}' was not found` );
				this.locations.set( id, point( value, `scenario.locations.${id}` ) );

			}

			let timer;
			try {

				await Promise.race( [ Promise.resolve().then( () => this.definition.setup?.( this.context ) ),
					new Promise( ( _, reject ) => { timer = setTimeout( () => reject( new Error( 'scenario.setup: timed out' ) ), this.timeout ); } ) ] );

			} finally { clearTimeout( timer ); }
			while ( this.operations.size && this.state === 'setting-up' ) await Promise.all( [ ...this.operations ].map( ( operation ) => operation.settled ) );
			if ( this.setupFailure ) throw this.setupFailure;
			check( this.state === 'setting-up', 'runtime.setup', `interrupted while ${this.state}` );
			this.state = 'briefing';

		} catch ( error ) {

			this.fail( error );
			throw error;

		}

	}

	spawn( kind, options ) {

		this.writable();
		fields( options, [ 'id', 'at', 'people', 'spread' ], `spawn.${kind}` );
		check( typeof options.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test( options.id ), 'spawn.id', 'must be a lowercase slug' );
		check( ! this.actors.has( options.id ), 'spawn.id', `'${options.id}' is already allocated` );
		const people = options.people ?? ( kind === 'squad' ? 24 : 100 );
		check( Number.isInteger( people ) && people > 0 && people <= 10000, 'spawn.people', 'must be an integer from 1 to 10000' );
		const spread = options.spread ?? ( kind === 'squad' ? 5 : 20 );
		check( Number.isFinite( spread ) && spread >= 0 && spread <= 1000, 'spawn.spread', 'must be between 0 and 1000 meters' );
		const at = this.location( options.at );
		const handle = Object.freeze( { id: options.id, kind, run: this.run } );
		const record = { handle, backend: null };
		this.actors.set( handle.id, record );
		const controller = new AbortController();
		let resolve, done = false, timer;
		const operation = {
			id: `${this.run}:${this.nextOperation ++}`,
			state: 'preparing', signal: controller.signal,
			settled: new Promise( ( settle ) => { resolve = settle; } ),
			cancel: ( reason = 'cancelled' ) => {

				if ( done ) return Object.freeze( { status: 'already-settled' } );
				controller.abort( reason );
				settle( { status: 'cancelled', reason } );
				return Object.freeze( { status: 'requested' } );

			},
		};
		const settle = ( outcome ) => {

			if ( done ) return;
			done = true;
			clearTimeout( timer );
			operation.state = outcome.status;
			this.operations.delete( operation );
			if ( outcome.status !== 'completed' ) this.actors.delete( handle.id );
			resolve( Object.freeze( outcome ) );

		};
		this.operations.add( operation );
		timer = setTimeout( () => {

			const error = new Error( `spawn.${options.id}: timed out` );
			controller.abort( error );
			settle( { status: 'failed', error } );
			this.operationFailed( error );

		}, this.timeout );
		Promise.resolve().then( () => {

			if ( done ) return;
			return this.adapter.spawn( kind, Object.freeze( { id: options.id, at, people, spread } ), controller.signal );

		} ).then( ( backend ) => {

			if ( done ) { if ( backend !== undefined ) this.release( backend ); return; }
			if ( backend === undefined || backend === null ) {

				const error = new Error( `spawn.${options.id}: adapter returned no actor allocation` );
				settle( { status: 'failed', error } );
				this.operationFailed( error );
				return;

			}
			record.backend = backend;
			settle( { status: 'completed', value: handle } );

		}, ( error ) => {

			if ( done ) return;
			settle( { status: 'failed', error } );
			this.operationFailed( error );

		} );
		return Object.freeze( { id: operation.id, signal: operation.signal, settled: operation.settled,
			get state() { return operation.state; }, cancel: operation.cancel } );

	}

	operationFailed( error ) {

		if ( this.state === 'setting-up' ) this.setupFailure ??= error;
		else this.fail( error );

	}

	release( backend ) {

		try { this.adapter.release( backend ); } catch ( error ) { this.onFailure( error ); }

	}

	actor( handle ) {

		check( handle?.run === this.run && this.actors.get( handle.id )?.handle === handle, 'actors.get', 'unknown or foreign actor handle' );
		return this.observation?.actors.find( ( actor ) => actor.handle === handle ) ?? null;

	}

	observe( sample ) {

		if ( terminal.has( this.state ) || this.state === 'setting-up' || sample === this.lastSample ) return;
		check( sample !== null && typeof sample === 'object', 'observation', 'must be a sample token' );
		const actors = [];
		for ( const record of this.actors.values() ) {

			if ( record.backend === null ) continue;
			const state = this.adapter.readActor( record.backend, sample );
			if ( ! state ) continue;
			check( Number.isInteger( state.alive ) && state.alive >= 0, 'observation.alive', 'must be a non-negative integer' );
			actors.push( Object.freeze( { handle: record.handle, alive: state.alive,
				center: state.center ? point( state.center, 'observation.center' ) : null } ) );

		}

		this.lastSample = sample;
		this.observation = Object.freeze( { sequence: ( this.observation?.sequence ?? 0 ) + 1,
			receivedAt: this.time, actors: Object.freeze( actors ) } );

	}

	start() {

		check( this.state === 'briefing', 'runtime.start', 'must be awaiting briefing confirmation' );
		check( this.observation !== null, 'runtime.start', 'requires an initial observation' );
		this.state = 'running';

	}

	pause( paused ) {

		if ( this.state === 'running' && paused ) this.state = 'paused';
		else if ( this.state === 'paused' && ! paused ) this.state = 'running';

	}

	update( dt ) {

		check( Number.isFinite( dt ) && dt >= 0, 'runtime.update.dt', 'must be non-negative and finite' );
		if ( this.state !== 'running' ) return;
		this.time += dt;
		const objective = this.definition.objectives[ 0 ];
		if ( this.time + 1e-9 < objective.seconds ) return;
		this.time = Math.max( this.time, objective.seconds );
		this.state = 'finished';
		this.result = Object.freeze( { win: true, reason: objective.reason, stars: 3,
			lines: Object.freeze( [ Object.freeze( [ 'Time held', formatTime( this.time ) ] ) ] ) } );
		for ( const operation of [ ...this.operations ] ) operation.cancel( 'scenario finished' );
		this.onFinish( this.result );

	}

	objectives() {

		const objective = this.definition.objectives[ 0 ];
		return [ { label: objective.label, value: Math.min( 1, this.time / objective.seconds ),
			text: formatTime( objective.seconds - this.time ), state: this.result ? 'done' : 'ok' } ];

	}

	fail( error ) {

		if ( terminal.has( this.state ) ) return;
		this.state = 'failed';
		this.error = error;
		for ( const operation of [ ...this.operations ] ) operation.cancel( 'scenario failed' );
		for ( const record of this.actors.values() ) if ( record.backend !== null ) this.release( record.backend );
		this.actors.clear();
		this.onFailure( error );

	}

	dispose() {

		if ( this.state === 'disposed' ) return;
		this.state = 'disposed';
		for ( const operation of [ ...this.operations ] ) operation.cancel( 'scenario disposed' );
		for ( const record of this.actors.values() ) if ( record.backend !== null ) this.release( record.backend );
		this.actors.clear();
		this.observation = null;
		this.lastSample = null;

	}

}