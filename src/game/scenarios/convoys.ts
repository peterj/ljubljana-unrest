import { check, fields, point } from './definition.ts';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class ConvoyHost {

	declare runtime: any;
	declare records: Map<any, any>;

	constructor( runtime ) {

		this.runtime = runtime;
		this.records = new Map<any, any>();

	}

	context( owner = null ) {

		const mutate = ( callback ) => { if ( owner ) this.runtime.behaviors.writable( owner ); return callback(); };
		return Object.freeze( {
			create: ( options ) => mutate( () => this.create( options ) ),
			get: ( handle ) => this.get( handle ),
			at: ( handle, distance ) => this.at( handle, distance ),
			depart: ( handle ) => mutate( () => this.depart( handle ) ),
		} );

	}

	create( options ) {

		this.runtime.writable();
		check( this.runtime.state === 'setting-up', 'convoys.create', 'convoys must be created during setup' );
		fields( options, [ 'id', 'vehicles', 'vipIndex' ], 'convoy' );
		check( typeof options.id === 'string' && ID.test( options.id ), 'convoy.id', 'must be a lowercase slug' );
		check( ! this.records.has( options.id ), 'convoy.id', 'must be unique in this run' );
		const vehicles = options.vehicles ?? 3, vipIndex = options.vipIndex ?? 1;
		check( Number.isInteger( vehicles ) && vehicles >= 1 && vehicles <= 8, 'convoy.vehicles', 'must be from one through eight' );
		check( Number.isInteger( vipIndex ) && vipIndex >= 0 && vipIndex < vehicles, 'convoy.vipIndex', 'must identify a convoy vehicle' );
		const backend = this.runtime.adapter.createConvoy( { vehicles, vipIndex } );
		check( backend && Number.isFinite( backend.length ) && backend.length > 0, 'convoy', 'host returned an invalid route convoy' );
		const handle = Object.freeze( { id: options.id, kind: 'convoy', run: this.runtime.run } );
		this.records.set( handle.id, { handle, backend } );
		return handle;

	}

	resolve( id ) {

		check( typeof id === 'string' && this.records.has( id ), 'convoys.resolve', `unknown convoy '${id}'` );
		return this.records.get( id ).handle;

	}

	record( handle ) {

		const record = this.records.get( typeof handle === 'string' ? handle : handle?.id );
		check( typeof handle === 'string' ? Boolean( record ) : handle?.run === this.runtime.run && record?.handle === handle,
			'convoys.get', 'unknown or foreign convoy handle' );
		return record;

	}

	get( handle ) {

		const record = this.record( handle ), state = this.runtime.adapter.readConvoy( record.backend );
		return Object.freeze( { handle, routeLength: record.backend.length, distance: state.distance, progress: state.progress,
			speed: state.speed, integrity: state.integrity, blockedFor: state.blockedFor, blockers: state.blockers,
			attackers: state.attackers, moving: state.moving, arrived: state.arrived } );

	}

	at( handle, distance ) {

		const record = this.record( handle );
		check( Number.isFinite( distance ) && distance >= 0 && distance <= record.backend.length, 'convoys.at.distance', 'must be within the route length' );
		const value = this.runtime.adapter.convoyPoint( record.backend, distance );
		return Object.freeze( { position: point( [ value.x, value.y ], 'convoys.at.position' ), heading: value.heading } );

	}

	depart( handle ) {

		this.runtime.writable();
		const record = this.record( handle ), state = this.runtime.adapter.readConvoy( record.backend );
		if ( state.moving || state.arrived ) return Object.freeze( { status: 'rejected', code: 'ALREADY_MOVING' } );
		this.runtime.adapter.departConvoy( record.backend );
		return Object.freeze( { status: 'completed' } );

	}

	update( dt ) {

		if ( ! this.records.size ) return;
		for ( const record of this.records.values() ) this.runtime.adapter.updateConvoy( record.backend, dt );
		this.runtime.adapter.updateConvoyWalls( [ ...this.records.values() ].map( ( record ) => record.backend ) );

	}

	dispose() {

		for ( const record of this.records.values() ) this.runtime.adapter.releaseConvoy?.( record.backend );
		this.records.clear();

	}

}