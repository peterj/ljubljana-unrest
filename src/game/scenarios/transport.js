import { check, fields, point } from './definition.js';

export class TransportHost {

	constructor( runtime ) {

		this.runtime = runtime;
		this.vehicles = new Map();
		this.rides = new Map();
		this.snapshots = Object.freeze( [] );

	}

	record( value ) {

		const handle = typeof value === 'string' ? this.runtime.context.actors.resolve( value ) : value;
		const actor = this.runtime.actors.get( handle?.id );
		check( actor?.handle === handle && handle.kind === 'vehicle' && actor.backend !== null, 'vehicles', 'unknown, foreign or unallocated vehicle' );
		let vehicle = this.vehicles.get( handle.id );
		if ( ! vehicle ) {

			vehicle = { actor, revision: 0, capacity: actor.capacity, type: actor.type, passengers: new Map(), order: null };
			this.vehicles.set( handle.id, vehicle );

		}
		return vehicle;

	}

	snapshot( vehicle ) {

		const state = this.runtime.adapter.readVehicle( vehicle.actor.backend );
		const crew = vehicle.actor.crewHandle ? this.runtime.actors.get( vehicle.actor.crewHandle.id ) : null;
		return Object.freeze( { handle: vehicle.actor.handle, type: vehicle.type, revision: vehicle.revision,
			position: point( state.position, 'vehicle.position' ), speed: state.speed, moving: state.moving,
			crew: crew ? Object.freeze( { handle: crew.handle, state: vehicle.actor.backend.aboard.length ? 'aboard' : 'deployed',
				people: vehicle.actor.backend.crew?.members.length ?? 0, aboard: vehicle.actor.backend.aboard.length } ) : null,
			capacity: vehicle.capacity, seatsUsed: [ ...vehicle.passengers.values() ].reduce( ( count, ride ) => count + ride.people.length, 0 ),
			passengers: Object.freeze( [ ...vehicle.passengers.keys() ] ) } );

	}

	context( owner = null ) {

		const writable = () => { if ( owner ) this.runtime.behaviors.writable( owner ); this.runtime.writable(); };
		return Object.freeze( {
			get: ( value ) => this.snapshot( this.record( value ) ),
			resolve: ( id ) => this.record( id ).actor.handle,
			drive: ( value, at, options ) => { writable(); return this.drive( owner, value, at, options ); },
			stop: ( value ) => { writable(); return this.stop( owner, value ); },
			toggleCrew: ( value, options ) => { writable(); return this.toggleCrew( owner, value, options ); },
			board: ( entity, value, options ) => { writable(); return this.board( entity, value, options ); },
			exit: ( entity, options ) => { writable(); return this.exit( entity, options ); },
		} );

	}

	drive( owner, value, at, options ) {

		fields( options, [ 'expectedRevision' ], 'vehicles.drive' );
		check( Number.isInteger( options.expectedRevision ) && options.expectedRevision >= 0, 'vehicles.expectedRevision', 'must be a non-negative revision' );
		const vehicle = this.record( value );
		if ( vehicle.revision !== options.expectedRevision ) return Object.freeze( { status: 'rejected', code: 'STALE_REVISION' } );
		if ( vehicle.order && vehicle.order.owner !== owner ) return Object.freeze( { status: 'rejected', code: 'CONTROL_BUSY' } );
		if ( [ ...vehicle.passengers.values() ].some( ( ride ) => [ 'boarding', 'rolling-back' ].includes( ride.state ) ) ) return Object.freeze( { status: 'rejected', code: 'BOARDING_PENDING' } );
		const target = this.runtime.location( at );
		const result = this.runtime.adapter.driveVehicle( vehicle.actor.backend, target );
		if ( result.status !== 'completed' ) return Object.freeze( result );
		vehicle.revision ++;
		vehicle.order = { owner, at: point( result.destination, 'vehicle.destination' ), installedStep: this.runtime.step };
		this.runtime.event( 'vehicle.driving', { vehicle: vehicle.actor.handle, at: vehicle.order.at, revision: vehicle.revision } );
		return Object.freeze( { status: 'completed', value: this.snapshot( vehicle ) } );

	}

	stop( owner, value ) {

		const vehicle = this.record( value );
		if ( vehicle.order && vehicle.order.owner !== owner ) return Object.freeze( { status: 'rejected', code: 'CONTROL_BUSY' } );
		this.runtime.adapter.stopVehicle( vehicle.actor.backend );
		vehicle.order = null; vehicle.revision ++;
		return Object.freeze( { status: 'completed', value: this.snapshot( vehicle ) } );

	}

	toggleCrew( owner, value, options ) {

		fields( options, [ 'expectedRevision' ], 'vehicles.toggleCrew' );
		check( Number.isInteger( options.expectedRevision ) && options.expectedRevision >= 0, 'vehicles.expectedRevision', 'must be a non-negative revision' );
		const vehicle = this.record( value );
		const reject = ( code ) => Object.freeze( { status: 'rejected', code } );
		if ( vehicle.type !== 'police-patrol' || ! vehicle.actor.crewHandle ) return reject( 'VEHICLE_TYPE' );
		if ( vehicle.revision !== options.expectedRevision ) return reject( 'STALE_REVISION' );
		if ( vehicle.order && vehicle.order.owner !== owner ) return reject( 'CONTROL_BUSY' );
		const state = this.snapshot( vehicle );
		if ( state.moving ) return reject( 'VEHICLE_MOVING' );
		const result = this.runtime.adapter.toggleCrewVehicle( vehicle.actor.backend );
		if ( result.status !== 'completed' ) return Object.freeze( result );
		vehicle.revision ++;
		const crewState = vehicle.actor.backend.aboard.length ? 'aboard' : 'deployed';
		this.runtime.event( 'vehicle.crew-changed', { vehicle: vehicle.actor.handle, crew: vehicle.actor.crewHandle,
			state: crewState, at: state.position, revision: vehicle.revision } );
		return Object.freeze( { status: 'completed', value: this.snapshot( vehicle ) } );

	}

	board( handle, value, options ) {

		fields( options, [ 'expectedRevision', 'expectedVehicleRevision', 'expectedSample', 'radius' ], 'vehicles.board' );
		for ( const key of [ 'expectedRevision', 'expectedVehicleRevision', 'expectedSample' ] ) check( Number.isInteger( options[ key ] ) && options[ key ] >= ( key === 'expectedSample' ? 1 : 0 ), `vehicles.board.${key}`, 'must be a valid revision or sample' );
		const radius = options.radius ?? 7;
		check( Number.isFinite( radius ) && radius > 0 && radius <= 30, 'vehicles.board.radius', 'must be positive and at most 30 meters' );
		const entity = this.runtime.identity.entityRecord( handle ), vehicle = this.record( value );
		const reject = ( code ) => Object.freeze( { status: 'rejected', code } );
		if ( vehicle.type !== 'transport' ) return reject( 'VEHICLE_TYPE' );
		if ( entity.revision !== options.expectedRevision || vehicle.revision !== options.expectedVehicleRevision ) return reject( 'STALE_REVISION' );
		if ( this.runtime.observation?.sequence !== options.expectedSample ) return reject( 'STALE_OBSERVATION' );
		if ( ! entity.rules || ! [ 'active', 'carried' ].includes( entity.state ) || entity.transport ) return reject( 'PERSON_UNAVAILABLE' );
		const state = this.snapshot( vehicle );
		if ( state.moving || state.speed >= 0.5 ) return reject( 'VEHICLE_MOVING' );
		const people = [ ...new Set( [ entity.subject, entity.carrier ] ) ].map( ( person ) => this.runtime.identity.personRecord( person ) );
		if ( people.some( ( person ) => person.pending || person.transport || ! person.sample || ! [ 'active', 'injured' ].includes( person.sample.status ) ) ) return reject( 'PERSON_UNAVAILABLE' );
		if ( state.seatsUsed + people.length > vehicle.capacity ) return reject( 'VEHICLE_FULL' );
		if ( ! entity.position || Math.hypot( entity.position[ 0 ] - state.position[ 0 ], entity.position[ 1 ] - state.position[ 1 ] ) > radius ) return reject( 'OUT_OF_RANGE' );
		const plan = this.runtime.adapter.prepareBoarding( people.map( ( person ) => person.backend ), this.runtime.lastSample );
		if ( plan.status === 'rejected' ) return reject( plan.code );
		this.runtime.adapter.commitBoarding( plan );
		const ride = { entity, vehicle, people, plan, state: 'boarding', step: this.runtime.step, startedAt: this.runtime.time,
			previous: { state: entity.state, carrier: entity.carrier, actor: entity.actor, position: entity.position } };
		this.rides.set( entity.handle.id, ride ); vehicle.passengers.set( entity.handle, ride ); vehicle.revision ++;
		for ( const person of people ) person.transport = ride;
		entity.transport = ride; entity.state = 'boarding'; entity.actor = null; entity.carrier = null; entity.revision ++;
		entity.position = state.position;
		this.runtime.identity.refresh();
		this.runtime.event( 'transport.boarding', { entity: entity.handle, vehicle: vehicle.actor.handle, revision: entity.revision } );
		return Object.freeze( { status: 'completed', value: this.runtime.identity.snapshot( entity ) } );

	}

	exit( handle, options ) {

		fields( options, [ 'expectedRevision', 'at', 'radius' ], 'vehicles.exit' );
		check( Number.isInteger( options.expectedRevision ) && options.expectedRevision >= 0, 'vehicles.exit.expectedRevision', 'must be a non-negative revision' );
		const radius = options.radius ?? 10;
		check( Number.isFinite( radius ) && radius > 0 && radius <= 100, 'vehicles.exit.radius', 'must be positive and at most 100 meters' );
		const entity = this.runtime.identity.entityRecord( handle ), ride = this.rides.get( handle.id );
		const at = this.runtime.location( options.at );
		if ( entity.revision !== options.expectedRevision ) return Object.freeze( { status: 'rejected', code: 'STALE_REVISION' } );
		if ( ! ride || ride.state !== 'aboard' ) return Object.freeze( { status: 'rejected', code: 'NOT_ABOARD' } );
		const state = this.snapshot( ride.vehicle );
		if ( state.moving || state.speed >= 0.5 || Math.hypot( state.position[ 0 ] - at[ 0 ], state.position[ 1 ] - at[ 1 ] ) > radius ) return Object.freeze( { status: 'rejected', code: 'EXIT_NOT_REACHED' } );
		ride.state = 'exited'; entity.state = 'exited'; entity.position = state.position; entity.revision ++;
		ride.vehicle.passengers.delete( handle ); ride.vehicle.revision ++;
		this.runtime.identity.refresh();
		this.runtime.event( 'transport.exited', { entity: handle, vehicle: ride.vehicle.actor.handle, at: state.position, revision: entity.revision } );
		return Object.freeze( { status: 'completed', value: this.runtime.identity.snapshot( entity ) } );

	}

	locked( actor ) {

		return [ ...this.rides.values() ].some( ( ride ) => [ 'boarding', 'rolling-back' ].includes( ride.state ) && ride.people.some( ( person ) => person.actor === actor ) );

	}

	collect( sample, stamp = { step: this.runtime.step } ) {

		const events = [];
		for ( const actor of this.runtime.actors.values() ) {

			if ( actor.handle.kind !== 'vehicle' || actor.backend === null ) continue;
			const vehicle = this.record( actor.handle ), state = this.runtime.adapter.readVehicle( actor.backend );
			if ( vehicle.order && ! state.moving && this.runtime.step > vehicle.order.installedStep ) {

				const order = vehicle.order;
				vehicle.order = null;
				const arrived = Math.hypot( state.position[ 0 ] - order.at[ 0 ], state.position[ 1 ] - order.at[ 1 ] ) <= 5;
				events.push( { type: arrived ? 'vehicle.arrived' : 'vehicle.stopped', vehicle: actor.handle,
					at: point( state.position, 'vehicle.position' ), revision: vehicle.revision } );

			}

		}
		for ( const ride of this.rides.values() ) {

			const { entity, vehicle } = ride;
			if ( [ 'boarding', 'rolling-back' ].includes( ride.state ) && this.runtime.time - ride.startedAt > 30 ) throw new Error( 'transport: passenger reconciliation timed out' );
			if ( [ 'boarding', 'aboard' ].includes( ride.state ) ) entity.position = this.snapshot( vehicle ).position;
			if ( stamp.step <= ride.step ) continue;
			if ( ride.state === 'boarding' ) {

				if ( this.runtime.adapter.boardingConfirmed( ride.plan, sample ) ) {

					ride.state = 'aboard'; entity.state = 'aboard'; entity.revision ++;
					events.push( { type: 'transport.aboard', entity: entity.handle, vehicle: vehicle.actor.handle, revision: entity.revision } );

				} else {

					this.runtime.adapter.rollbackBoarding( ride.plan );
					ride.state = 'rolling-back'; ride.step = this.runtime.step;

				}

			} else if ( ride.state === 'rolling-back' && this.runtime.adapter.boardingRestored( ride.plan, sample ) ) {

				for ( const person of ride.people ) person.transport = null;
				vehicle.passengers.delete( entity.handle ); vehicle.revision ++;
				this.rides.delete( entity.handle.id ); entity.transport = null;
				Object.assign( entity, ride.previous ); entity.revision ++;
				events.push( { type: 'transport.rejected', entity: entity.handle, vehicle: vehicle.actor.handle, reason: ride.reason ?? 'boarding preconditions changed' } );

			}

		}
		this.snapshots = Object.freeze( [ ...this.vehicles.values() ].map( ( vehicle ) => this.snapshot( vehicle ) ) );
		return events;

	}

	stopOwner( owner ) {

		for ( const vehicle of this.vehicles.values() ) if ( vehicle.order?.owner === owner ) this.stop( owner, vehicle.actor.handle );

	}

	stopAll() {

		for ( const vehicle of this.vehicles.values() ) if ( vehicle.order ) this.stop( vehicle.order.owner, vehicle.actor.handle );

	}

	releaseActor( handle ) {

		for ( const ride of [ ...this.rides.values() ] ) if ( ride.people.some( ( person ) => person.actor === handle ) ) {

			this.releaseEntity( ride.entity, ride.people.filter( ( person ) => person.actor === handle ).map( ( person ) => person.backend ) );
			this.runtime.identity.remove( ride.entity );

		}
		const vehicle = this.vehicles.get( handle.id );
		if ( ! vehicle ) return;
		for ( const ride of [ ...vehicle.passengers.values() ] ) {

			if ( ride.state !== 'exited' ) {

				this.runtime.adapter.rollbackBoarding( ride.plan );
				ride.state = 'rolling-back'; ride.step = this.runtime.step; ride.startedAt = this.runtime.time;
				ride.reason = 'vehicle removed'; ride.entity.state = 'boarding';

			}

		}
		this.runtime.identity.refresh();
		this.runtime.adapter.stopVehicle( vehicle.actor.backend );
		this.vehicles.delete( handle.id );

	}

	releaseEntity( entity, discarded = [] ) {

		const ride = this.rides.get( entity.handle.id );
		if ( ! ride ) return;
		if ( ride.state !== 'exited' ) this.runtime.adapter.rollbackBoarding( ride.plan, discarded );
		for ( const person of ride.people ) person.transport = null;
		ride.vehicle.passengers.delete( entity.handle ); ride.vehicle.revision ++;
		entity.transport = null; this.rides.delete( entity.handle.id );

	}

	dispose() {

		for ( const vehicle of this.vehicles.values() ) this.runtime.adapter.stopVehicle( vehicle.actor.backend );
		for ( const ride of this.rides.values() ) {

			this.runtime.adapter.abandonBoarding?.( ride.plan );
			for ( const person of ride.people ) person.transport = null;

		}
		this.vehicles.clear(); this.rides.clear(); this.snapshots = Object.freeze( [] );

	}

}