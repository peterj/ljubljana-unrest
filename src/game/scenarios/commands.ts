import { check, fields } from './definition.ts';

const catalog = Object.freeze( {
	charge: Object.freeze( { key: 'c', label: 'Charge', needsSelection: true, escalation: 1 } ),
	arrest: Object.freeze( { key: 'a', label: 'Arrest', needsSelection: true, escalation: 0 } ),
	snatch: Object.freeze( { key: 'x', label: 'Snatch leader', needsSelection: true, escalation: 0 } ),
	kettle: Object.freeze( { key: 'k', label: 'Kettle', needsSelection: true, escalation: 1 } ),
	'shield-push': Object.freeze( { key: 's', label: 'Shield push', needsSelection: true, escalation: 1, aim: true } ),
	crew: Object.freeze( { key: 'u', label: 'Crew in / out', needsSelection: true, escalation: 0, forCars: true, immediate: true } ),
	firearms: Object.freeze( { key: 'o', label: 'Open fire', needsSelection: true, escalation: 4, danger: true, immediate: true } ),
	water: Object.freeze( { key: 'w', label: 'Water cannon', needsSelection: true, escalation: 3, aim: true, forCars: true } ),
	gas: Object.freeze( { key: 'g', label: 'Tear gas', needsSelection: false, escalation: 2 } ),
	reinforce: Object.freeze( { key: 'f', label: 'Reinforce', needsSelection: false, escalation: 0 } ),
} );

export function policeCommands( options = {} ) {

	fields( options, [ 'gas', 'reinforce', 'water', 'crew', 'firearms' ], 'policeCommands' );
	check( options.crew === undefined || typeof options.crew === 'boolean', 'policeCommands.crew', 'must be a boolean' );
	check( options.firearms === undefined || typeof options.firearms === 'boolean', 'policeCommands.firearms', 'must be a boolean' );
	const values = [ 'charge', 'arrest', 'snatch', 'kettle', 'shield-push' ].map( ( id ) => Object.freeze( { kind: 'police-command', id, resource: null } ) );
	if ( options.crew ) values.push( Object.freeze( { kind: 'police-command', id: 'crew', resource: null } ) );
	if ( options.firearms ) values.push( Object.freeze( { kind: 'police-command', id: 'firearms', resource: null } ) );
	for ( const id of [ 'gas', 'reinforce', 'water' ] ) if ( options[ id ] !== undefined ) {

		check( typeof options[ id ] === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test( options[ id ] ), `policeCommands.${id}`, 'must be a resource ID' );
		values.push( Object.freeze( { kind: 'police-command', id, resource: options[ id ] } ) );

	}
	return Object.freeze( values );

}

export function commandDefinitions( values: readonly any[] = [], resources ) {

	check( Array.isArray( values ) && Array.from( values ).every( ( value ) => value?.kind === 'police-command' ), 'commands', 'must be a dense array of supported command definitions' );
	const commands = values.map( ( value ) => {

		fields( value, [ 'kind', 'id', 'resource' ], 'command' );
		check( Object.hasOwn( catalog, value.id ), 'command.id', 'unknown police command' );
		if ( [ 'gas', 'reinforce', 'water' ].includes( value.id ) ) check( typeof value.resource === 'string' && Object.hasOwn( resources, value.resource ), `command.${value.id}.resource`, 'must refer to a declared resource' );
		else check( value.resource === null, `command.${value.id}.resource`, 'this standard command has no resource cost' );
		return Object.freeze( { kind: 'police-command', id: value.id, resource: value.resource } );

	} );
	check( new Set( commands.map( ( value ) => value.id ) ).size === commands.length, 'commands', 'command IDs must be unique' );
	return Object.freeze( commands );

}

export class CommandHost {

	declare runtime: any;
	declare definitions: Map<any, any>;
	declare active: Set<any>;
	declare claims: Map<any, any>;
	declare locks: Map<any, any>;
	declare initialOwner: any;
	declare escalation: number;

	constructor( runtime ) {

		this.runtime = runtime;
		this.definitions = new Map( runtime.definition.commands.map( ( definition ) => [ definition.id, definition ] ) );
		this.active = new Set<any>();
		this.claims = new Map<any, any>();
		this.locks = new Map<any, any>();
		this.initialOwner = Object.freeze( { id: 'scenario-initial-command-locks' } );
		for ( const id of runtime.definition.initiallyLockedCommands ?? [] ) this.locks.set( id, new Set( [ this.initialOwner ] ) );
		this.escalation = 0;

	}

	list() {

		return Object.freeze( [ ...this.definitions.values() ].filter( ( definition ) => ! this.locks.get( definition.id )?.size )
			.map( ( definition ) => Object.freeze( { ...definition, ...catalog[ definition.id ] } ) ) );

	}

	context( owner = null ) {

		const context: Record<string, any> = { list: () => this.list(), execute: ( id, options ) => {

			if ( owner ) this.runtime.behaviors.writable( owner );
			return this.execute( owner, id, options, 'behavior' );

		} };
		if ( owner ) {

			context.lock = ( id ) => this.lock( owner, id );
			context.unlock = ( id ) => this.unlock( owner, id );

		}
		return Object.freeze( context );

	}

	lock( owner, id ) {

		this.runtime.behaviors.writable( owner );
		check( this.definitions.has( id ), 'commands.lock.id', `unknown command '${id}'` );
		const owners = this.locks.get( id ) ?? new Set<any>();
		owners.add( owner ); this.locks.set( id, owners );

	}

	unlock( owner, id ) {

		this.runtime.behaviors.writable( owner );
		check( this.definitions.has( id ), 'commands.unlock.id', `unknown command '${id}'` );
		const owners = this.locks.get( id );
		owners?.delete( owner );
		owners?.delete( this.initialOwner );
		if ( ! owners?.size ) this.locks.delete( id );

	}

	releaseOwner( owner ) {

		for ( const [ id, owners ] of this.locks ) {

			owners.delete( owner );
			if ( ! owners.size ) this.locks.delete( id );

		}

	}

	execute( owner, id, options, source = 'behavior' ) {

		this.runtime.writable();
		fields( options, [ 'at', 'selection' ], 'commands.execute' );
		const definition = this.definitions.get( id );
		check( definition, 'commands.execute.id', `unknown command '${id}'` );
		check( [ 'starting', 'running', 'paused' ].includes( this.runtime.state ), 'commands.execute', 'scenario has not started' );
		const at = this.runtime.location( options.at ), selected = options.selection ?? [];
		check( Array.isArray( selected ) && Array.from( selected ).every( ( handle ) => handle && typeof handle === 'object' ), 'commands.selection', 'must be a dense array of actor handles' );
		const selection = Object.freeze( [ ...selected ] ), info = catalog[ id ];
		const operationId = `${this.runtime.run}:${this.runtime.nextOperation ++}`;
		let target = null;
		const event = ( type, payload = {} ) => this.runtime.event( type, { command: id, operation: operationId, at, selection, source, ...( target ? { target: target.person } : {} ), ...payload } );
		event( 'command.attempted' );
		const reject = ( code ) => {

			event( 'command.rejected', { code } );
			return Object.freeze( { id: operationId, state: 'rejected', signal: new AbortController().signal,
				settled: Promise.resolve( Object.freeze( { status: 'rejected', code } ) ), cancel: () => Object.freeze( { status: 'already-settled' } ) } );

		};
		if ( this.locks.get( id )?.size ) return reject( 'COMMAND_LOCKED' );
		if ( owner && ! [ 'starting', 'active' ].includes( owner.state ) ) return reject( 'OWNER_STOPPED' );
		if ( ! [ 'starting', 'running', 'paused' ].includes( this.runtime.state ) ) return reject( 'SCENARIO_STOPPED' );
		if ( id === 'firearms' && source !== 'confirmed-player' ) return reject( 'CONFIRMATION_REQUIRED' );
		if ( info.needsSelection && ! selection.length ) return reject( 'SELECTION_REQUIRED' );
		if ( new Set( selection ).size !== selection.length ) return reject( 'INVALID_SELECTION' );
		const actors = [];
		for ( const handle of selection ) {

			const actor = this.runtime.actors.get( handle.id );
			const vehicleSelection = handle.kind === 'vehicle' && ( id === 'water' && actor?.backend?.water === true
				|| id === 'crew' && Boolean( actor?.backend?.crew ) );
			if ( actor?.handle !== handle || ( [ 'water', 'crew' ].includes( id ) ? ! vehicleSelection : handle.kind !== 'squad' )
				|| ! actor.backend || ! ( this.runtime.actor( handle )?.alive > 0 ) ) return reject( 'INVALID_SELECTION' );
			if ( this.runtime.transport.locked( handle ) ) return reject( 'BOARDING_PENDING' );
			if ( this.claims.has( handle ) ) return reject( 'CONTROL_BUSY' );
			const autonomous = this.runtime.movement.orders.get( handle.id );
			if ( source !== 'player' && autonomous && autonomous.owner !== owner ) return reject( autonomous.owner === this.runtime.movement.player ? 'PLAYER_CONTROL' : 'CONTROL_BUSY' );
			actors.push( actor );

		}
		if ( [ 'water', 'crew' ].includes( id ) && selection.length !== 1 ) return reject( 'INVALID_SELECTION' );
		if ( id === 'snatch' ) {

			const candidates = [ ...this.runtime.actors.values() ].flatMap( ( actor ) => this.runtime.identity.members( actor.handle ) )
				.filter( ( person ) => person.leader && person.identified && person.status === 'active'
					&& [ 'protester', 'counter' ].includes( person.faction ) )
				.map( ( person ) => ( { person: person.handle, actor: person.actor, position: person.position,
					distance: Math.hypot( person.position[ 0 ] - at[ 0 ], person.position[ 1 ] - at[ 1 ] ) } ) )
				.filter( ( candidate ) => candidate.distance < 60 )
				.sort( ( first, second ) => first.distance - second.distance || first.person.id.localeCompare( second.person.id ) );
			if ( ! candidates.length ) return reject( 'TARGET_NOT_FOUND' );
			target = Object.freeze( { person: candidates[ 0 ].person, actor: candidates[ 0 ].actor, position: Object.freeze( [ ...candidates[ 0 ].position ] ) } );

		}
		if ( id === 'shield-push' && ! actors.some( ( actor ) => this.runtime.adapter.commandEligible( id, actor.backend ) ) ) return reject( 'CORDON_REQUIRED' );
		let reservation;
		if ( definition.resource ) {

			const reserved = this.runtime.resources.reserve( definition.resource );
			if ( reserved.status === 'rejected' ) return reject( reserved.code );
			reservation = reserved.token;

		}
		const controller = new AbortController();
		let resolve, done = false, timer;
		const request = Object.freeze( { id, at, selection, source, operation: operationId, ...( target ? { target } : {} ) } );
		const current = () => ! controller.signal.aborted && ( ! owner || [ 'starting', 'active' ].includes( owner.state ) ) && [ 'starting', 'running', 'paused' ].includes( this.runtime.state )
			&& actors.every( ( actor ) => this.runtime.actors.get( actor.handle.id ) === actor && this.claims.get( actor.handle ) === operation );
		const settle = ( outcome ) => {

			if ( done ) return;
			done = true; clearTimeout( timer ); operation.state = outcome.status;
			if ( reservation ) this.runtime.resources.release( reservation );
			for ( const actor of actors ) if ( this.claims.get( actor.handle ) === operation ) this.claims.delete( actor.handle );
			this.active.delete( operation ); this.runtime.operations.delete( operation ); owner?.operations.delete( operation );
			resolve( Object.freeze( outcome ) );

		};
		const operation = {
			id: operationId, state: 'preparing', signal: controller.signal,
			settled: new Promise( ( settlePromise ) => { resolve = settlePromise; } ),
			cancel: ( reason = 'cancelled' ) => {

				if ( done ) return Object.freeze( { status: 'already-settled' } );
				if ( operation.state === 'applied' ) return Object.freeze( { status: 'too-late' } );
				controller.abort( reason ); settle( { status: 'cancelled', reason } ); event( 'command.cancelled', { reason } );
				return Object.freeze( { status: 'requested' } );

			},
		};
		for ( const actor of actors ) {

			const movement = this.runtime.movement.orders.get( actor.handle.id );
			if ( movement ) this.runtime.movement.remove( movement, 'command accepted', { preserveState: id === 'shield-push' } );
			this.claims.set( actor.handle, operation );

		}
		this.active.add( operation ); this.runtime.operations.add( operation ); owner?.operations.add( operation );
		timer = setTimeout( () => {

			if ( done ) return;
			const error = new Error( `command.${id}: timed out` );
			controller.abort( error ); settle( { status: 'failed', error } ); event( 'command.failed', { reason: error.message } ); this.runtime.fail( error );

		}, this.runtime.timeout );
		event( 'command.accepted' );
		Promise.resolve().then( async () => {

			if ( ! current() ) return;
			let prepared;
			try {

				prepared = await this.runtime.adapter.prepareCommand( request, actors.map( ( actor ) => actor.backend ), controller.signal );
				if ( ! current() ) return;
				if ( prepared?.status === 'rejected' ) { event( 'command.rejected', { code: prepared.code } ); settle( { status: 'rejected', code: prepared.code } ); return; }
				const applied = this.runtime.adapter.applyCommand( request, actors.map( ( actor ) => actor.backend ), prepared, current );
				check( applied && typeof applied.then !== 'function' && [ 'completed', 'rejected' ].includes( applied.status ), `command.${id}.apply`, 'adapter must return a synchronous application receipt' );
				if ( applied.status === 'rejected' ) { event( 'command.rejected', { code: applied.code } ); settle( applied ); return; }
				if ( ! current() ) return;
				operation.state = 'applied';
				if ( reservation ) { this.runtime.resources.commit( reservation ); reservation = null; }
				this.escalation = Math.max( this.escalation, info.escalation );
				const value = Object.freeze( { command: id, at, selection, resource: definition.resource,
					appliedAt: this.runtime.time, affected: Object.freeze( [ ...( applied.value?.affected ?? selection ) ] ),
					...( target ? { target: target.person } : {} ), ...( applied.value ?? {} ) } );
				event( 'command.applied', { receipt: value } ); settle( { status: 'completed', value } );
				event( 'command.completed', { receipt: value } );

			} catch ( error ) {

				if ( ! done ) { settle( { status: 'failed', error } ); event( 'command.failed', { reason: error.message } ); this.runtime.fail( new Error( `command.${id}: ${error.message}`, { cause: error } ) ); }

			} finally {

				if ( prepared !== undefined ) this.runtime.adapter.releaseCommand( prepared );

			}

		} ).catch( ( error ) => this.runtime.fail( error ) );
		return Object.freeze( { id: operation.id, signal: operation.signal, settled: operation.settled,
			get state() { return operation.state; }, cancel: operation.cancel } );

	}

	playerOverride( actors ) {

		for ( const actor of actors ) this.claims.get( actor )?.cancel( 'player movement' );

	}

	stopAll() { for ( const operation of [ ...this.active ] ) operation.cancel( 'scenario stopped' ); }

}