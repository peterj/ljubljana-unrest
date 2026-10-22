import { check, fields } from './definition.js';

export function resourceDefinitions( definitions = {} ) {

	check( definitions !== null && typeof definitions === 'object' && ! Array.isArray( definitions ), 'resources', 'must be an object' );
	return Object.freeze( Object.fromEntries( Object.entries( definitions ).map( ( [ id, options ] ) => {

		check( /^[a-z0-9][a-z0-9-]{0,39}$/.test( id ), `resources.${id}`, 'must be a lowercase slug' );
		fields( options, [ 'capacity', 'initial', 'cooldown' ], `resources.${id}` );
		const initial = options.initial ?? options.capacity, cooldown = options.cooldown ?? 0;
		check( Number.isInteger( options.capacity ) && options.capacity > 0 && options.capacity <= 100000, `resources.${id}.capacity`, 'must be an integer from 1 to 100000' );
		check( Number.isInteger( initial ) && initial >= 0 && initial <= options.capacity, `resources.${id}.initial`, 'must be between zero and capacity' );
		check( Number.isFinite( cooldown ) && cooldown >= 0 && cooldown <= 86400, `resources.${id}.cooldown`, 'must be non-negative finite game seconds' );
		return [ id, Object.freeze( { capacity: options.capacity, initial, cooldown } ) ];

	} ) ) );

}

export class ResourceHost {

	constructor( runtime, definitions ) {

		this.runtime = runtime;
		this.records = new Map( Object.entries( resourceDefinitions( definitions ) ).map( ( [ id, definition ] ) => [ id,
			{ ...definition, left: definition.initial, readyAt: 0, reservations: new Set() } ] ) );
		this.tokens = new Map();
		this.nextId = 1;

	}

	get( id ) {

		const resource = this.records.get( id );
		check( resource, 'resources.get', `unknown resource '${id}'` );
		return Object.freeze( { id, capacity: resource.capacity, left: resource.left, reserved: resource.reservations.size,
			available: resource.left - resource.reservations.size, readyIn: Math.max( 0, resource.readyAt - this.runtime.time ) } );

	}

	reserve( id ) {

		const state = this.get( id ), resource = this.records.get( id );
		if ( state.readyIn > 0 ) return Object.freeze( { status: 'rejected', code: 'COOLDOWN' } );
		if ( state.available <= 0 ) return Object.freeze( { status: 'rejected', code: 'RESOURCE_EMPTY' } );
		if ( resource.cooldown > 0 && state.reserved > 0 ) return Object.freeze( { status: 'rejected', code: 'RESOURCE_BUSY' } );
		const token = Object.freeze( { id: this.nextId ++, resource: id } );
		resource.reservations.add( token ); this.tokens.set( token, resource );
		return Object.freeze( { status: 'reserved', token } );

	}

	commit( token ) {

		const resource = this.tokens.get( token );
		check( resource?.reservations.has( token ), 'resources.commit', 'unknown or released reservation' );
		resource.reservations.delete( token ); this.tokens.delete( token );
		resource.left --; resource.readyAt = this.runtime.time + resource.cooldown;

	}

	release( token ) {

		const resource = this.tokens.get( token );
		if ( ! resource ) return;
		resource.reservations.delete( token ); this.tokens.delete( token );

	}

	dispose() {

		for ( const token of [ ...this.tokens.keys() ] ) this.release( token );

	}

}