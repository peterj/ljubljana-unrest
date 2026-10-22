import { check, fields, point } from './definition.ts';

export class MovementHost {

	declare runtime: any;
	declare orders: Map<any, any>;
	declare generation: number;
	declare player: any;

	constructor( runtime ) {

		this.runtime = runtime;
		this.orders = new Map<any, any>();
		this.generation = 0;
		this.player = { id: 'player', operations: new Set<any>() };

	}

	order( owner, actor, at, options = {} ) {

		this.runtime.writable();
		fields( options, [ 'radius', 'line' ], 'movement.options' );
		check( [ 'starting', 'running', 'paused' ].includes( this.runtime.state ), 'movement', 'requires a started scenario' );
		const handle = typeof actor === 'string' ? this.runtime.context.actors.resolve( actor ) : actor;
		this.runtime.actor( handle );
		if ( this.runtime.commands?.claims.has( handle ) ) return this.rejected( 'CONTROL_BUSY' );
		check( handle.kind !== 'vehicle', 'movement.actor', 'use vehicles.drive for road vehicles' );
		const record = this.runtime.actors.get( handle.id );
		check( record.backend !== null, 'movement.actor', 'has not been allocated' );
		const target = this.runtime.location( at );
		const radius = options.radius ?? 8;
		check( Number.isFinite( radius ) && radius > 0 && radius <= 100, 'movement.radius', 'must be positive and at most 100 meters' );
		const line = options.line === undefined ? null : point( options.line, 'movement.line' );
		check( ! line || handle.kind === 'squad', 'movement.line', 'requires a squad actor' );
		const destination = line ? point( [ ( line[ 0 ] + target[ 0 ] ) / 2, ( line[ 1 ] + target[ 1 ] ) / 2 ], 'movement.destination' ) : target;
		const previous = this.orders.get( handle.id );
		if ( previous && previous.owner !== owner ) {

			if ( owner !== this.player ) return this.rejected( previous.owner === this.player ? 'PLAYER_CONTROL' : 'CONTROL_BUSY' );
			this.remove( previous, 'player override' );

		} else if ( previous ) this.remove( previous, 'superseded' );
		const controller = new AbortController();
		let resolve, done = false, timer;
		const order = { actor: handle, owner, target: destination, radius, line, generation: ++ this.generation,
			installed: false, installedStep: null, backend: record.backend, operation: null };
		const valid = () => this.orders.get( handle.id ) === order && ! controller.signal.aborted
			&& [ 'starting', 'running', 'paused' ].includes( this.runtime.state );
		const operation = {
			id: `${this.runtime.run}:${this.runtime.nextOperation ++}`, state: 'preparing', signal: controller.signal,
			settled: new Promise( ( settle ) => { resolve = settle; } ),
			cancel: ( reason = 'cancelled' ) => {

				if ( done ) return Object.freeze( { status: 'already-settled' } );
				if ( operation.state === 'applied' ) return Object.freeze( { status: 'too-late' } );
				controller.abort( reason );
				if ( this.orders.get( handle.id ) === order ) this.orders.delete( handle.id );
				settle( { status: 'cancelled', reason } );
				return Object.freeze( { status: 'requested' } );

			},
		};
		const settle = ( outcome ) => {

			if ( done ) return;
			done = true; clearTimeout( timer );
			operation.state = outcome.status;
			this.runtime.operations.delete( operation ); owner.operations.delete( operation );
			resolve( Object.freeze( outcome ) );

		};
		order.operation = operation;
		this.orders.set( handle.id, order );
		this.runtime.operations.add( operation ); owner.operations.add( operation );
		timer = setTimeout( () => {

			if ( done ) return;
			const error = new Error( `movement.${handle.id}: timed out` );
			controller.abort( error );
			settle( { status: 'failed', error } );
			this.runtime.fail( error );

		}, this.runtime.timeout );
		const request = Object.freeze( { at: target, radius, line, actor: handle } );
		Promise.resolve().then( async () => {

			if ( ! valid() ) return;
			let prepared;
			try {

				prepared = await this.runtime.adapter.prepareMove( record.backend, request, controller.signal );
				if ( ! valid() ) return;
				operation.state = 'applied';
				const applied = await this.runtime.adapter.applyMove( record.backend, prepared, request, valid );
				if ( applied === false || ! valid() ) { settle( { status: 'cancelled', reason: 'superseded' } ); return; }
				order.installed = true;
				order.installedStep = this.runtime.step;
				settle( { status: 'completed', value: Object.freeze( {
					actor: handle, destination, generation: order.generation, installedAt: this.runtime.time,
				} ) } );
				this.runtime.event( 'movement.applied', { actor: handle, at: destination, owner: owner.id, source: owner === this.player ? 'player' : 'behavior' } );

			} catch ( error ) {

				if ( ! done ) {

					settle( { status: 'failed', error } );
					this.runtime.fail( new Error( `movement.${handle.id}: ${error.message}`, { cause: error } ) );

				}

			} finally {

				if ( prepared !== undefined ) {

					try { this.runtime.adapter.releaseMove( prepared ); } catch ( error ) { this.runtime.fail( error ); }

				}

			}

		} ).catch( ( error ) => this.runtime.fail( error ) );
		if ( owner === this.player ) this.runtime.event( 'player.move', { actor: handle, at: destination, line } );
		return Object.freeze( { id: operation.id, signal: operation.signal, settled: operation.settled,
			get state() { return operation.state; }, cancel: operation.cancel } );

	}

	rejected( code ) {

		const controller = new AbortController();
		return Object.freeze( { id: `${this.runtime.run}:${this.runtime.nextOperation ++}`, state: 'rejected',
			signal: controller.signal, settled: Promise.resolve( Object.freeze( { status: 'rejected', code } ) ),
			cancel: () => Object.freeze( { status: 'already-settled' } ) } );

	}

	remove( order, reason, { preserveState = false } = {} ) {

		if ( this.orders.get( order.actor.id ) !== order ) return;
		this.orders.delete( order.actor.id );
		order.operation.cancel( reason );
		if ( ! preserveState && ( order.installed || order.operation.state === 'applied' ) ) this.runtime.adapter.stopMove( order.backend );

	}

	stopOwner( owner ) {

		for ( const order of [ ...this.orders.values() ] ) if ( order.owner === owner ) this.remove( order, 'owner stopped' );

	}

	stopActor( owner, value ) {

		const actor = typeof value === 'string' ? this.runtime.context.actors.resolve( value ) : value;
		this.runtime.actor( actor );
		const order = this.orders.get( actor.id );
		if ( ! order || order.owner !== owner ) return Object.freeze( { status: 'rejected', code: 'CONTROL_BUSY' } );
		this.remove( order, 'owner stopped actor' );
		return Object.freeze( { status: 'completed' } );

	}

	stopAll() {

		for ( const order of [ ...this.orders.values() ] ) this.remove( order, 'scenario stopped' );

	}

	observe( sample ) {

		for ( const order of [ ...this.orders.values() ] ) {

			if ( ! order.installed || sample.step <= order.installedStep ) continue;
			const actor = sample.actors.find( ( entry ) => entry.handle === order.actor );
			if ( ! actor?.center || Math.hypot( actor.center[ 0 ] - order.target[ 0 ], actor.center[ 1 ] - order.target[ 1 ] ) > order.radius ) continue;
			this.orders.delete( order.actor.id );
			this.runtime.event( 'movement.arrived', { actor: order.actor, at: order.target, owner: order.owner.id,
				source: order.owner === this.player ? 'player' : 'behavior' } );

		}

	}

}