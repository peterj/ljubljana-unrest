import { check, fields, normalizeScenario, point } from './definition.ts';
import { BehaviorHost } from './behaviors.ts';
import { MovementHost } from './movement.ts';
import { IdentityHost } from './identity.ts';
import { TransportHost } from './transport.ts';
import { mapTarget, SpatialHost } from './spatial.ts';
import { advanceBuilding } from './building.ts';
import { ResourceHost } from './resources.ts';
import { CommandHost } from './commands.ts';
import { advanceClash } from './clash.ts';
import { ConvoyHost } from './convoys.ts';
import { CustodyHost } from './custody.ts';

let nextRun = 1;
const terminal = new Set( [ 'finished', 'failed', 'disposed' ] );
const randomSeed = () => {

	const value = new Uint32Array( 1 );
	if ( globalThis.crypto?.getRandomValues ) globalThis.crypto.getRandomValues( value );
	else value[ 0 ] = Date.now() >>> 0;
	return value[ 0 ] || 0x6d2b79f5;

};

export function formatTime( seconds ) {

	const whole = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( whole / 60 )}:${String( whole % 60 ).padStart( 2, '0' )}`;

}

export class ScenarioRuntime {

	declare definition: any;
	declare adapter: any;
	declare onFinish: any;
	declare onFailure: any;
	declare timeout: number;
	declare state: string;
	declare time: number;
	declare step: number;
	declare clashPressure: number;
	declare result: any;
	declare error: any;
	declare run: number;
	declare randomState: any;
	declare locations: Map<any, any>;
	declare actors: Map<any, any>;
	declare operations: Set<any>;
	declare nextOperation: number;
	declare observation: any;
	declare lastSample: any;
	declare setupFailure: any;
	declare cleanupErrors: any[];
	declare behaviors: BehaviorHost;
	declare movement: MovementHost;
	declare identity: IdentityHost;
	declare transport: TransportHost;
	declare spatial: SpatialHost;
	declare buildingState: any;
	declare resources: ResourceHost;
	declare commands: CommandHost;
	declare convoys: ConvoyHost;
	declare custody: CustodyHost;
	declare events: any[];
	declare dispatching: boolean;
	declare nextEvent: number;
	declare context: any;
	declare coachOwner: any;

	constructor( definition, adapter, { onFinish = () => {}, onFailure = () => {}, timeout = 15000 }: { onFinish?: ( result: any ) => void, onFailure?: ( error: any ) => void, timeout?: number } = {} ) {

		this.definition = normalizeScenario( definition );
		check( Number.isFinite( timeout ) && timeout > 0, 'runtime.timeout', 'must be positive and finite' );
		this.adapter = adapter;
		this.onFinish = onFinish;
		this.onFailure = onFailure;
		this.timeout = timeout;
		this.state = 'created';
		this.time = 0;
		this.step = 0;
		this.clashPressure = 0;
		this.result = null;
		this.error = null;
		this.run = nextRun ++;
		this.randomState = this.definition.seed ?? randomSeed();
		if ( ! this.randomState ) this.randomState = 0x6d2b79f5;
		this.locations = new Map<any, any>();
		this.actors = new Map<any, any>();
		this.operations = new Set<any>();
		this.nextOperation = 1;
		this.observation = null;
		this.lastSample = null;
		this.setupFailure = null;
		this.cleanupErrors = [];
		this.behaviors = new BehaviorHost( this );
		this.movement = new MovementHost( this );
		this.identity = new IdentityHost( this );
		this.transport = new TransportHost( this );
		this.spatial = new SpatialHost( this );
		this.buildingState = null;
		this.resources = new ResourceHost( this, this.definition.resources );
		this.commands = new CommandHost( this );
		this.convoys = new ConvoyHost( this );
		this.custody = new CustodyHost( this );
		this.events = [];
		this.dispatching = false;
		this.nextEvent = 1;
		const runtime = this;
		this.context = Object.freeze( {
			resources: Object.freeze( { get: ( id ) => this.resources.get( id ),
				list: () => Object.freeze( [ ...this.resources.records.keys() ].map( ( id ) => this.resources.get( id ) ) ) } ),
			crowd: Object.freeze( {
				setMode: ( actor, mode ) => this.setCrowdMode( actor, mode ),
				nudge: ( actor, options ) => this.nudgeCrowd( actor, options ),
				setMorale: ( actor, morale ) => this.setCrowdMorale( actor, morale ),
			} ),
			commands: this.commands.context(),
			convoys: this.convoys.context(),
			custody: this.custody.context(),
			people: this.identity.peopleContext(),
			protected: this.identity.context(),
			vehicles: this.transport.context(),
			targets: Object.freeze( { get: ( alias ) => this.spatial.target( alias ) } ),
			spatial: Object.freeze( {
				count: ( options ) => this.spatial.count( options ),
				buildingGeometry: ( alias, exitAt ) => this.spatial.buildingGeometry( alias, exitAt ),
				building: ( alias, exitAt ) => this.spatial.measureBuilding( alias, exitAt ),
				walkable: ( at, radius = 60 ) => {

					check( Number.isFinite( radius ) && radius > 0 && radius <= 1000, 'spatial.walkable.radius', 'must be positive and at most 1000 meters' );
					const value = this.adapter.walkable( this.location( at ), radius );
					return value ? point( value, 'spatial.walkable' ) : null;

				},
				clearance: ( at ) => {

					const value = this.adapter.clearance( this.location( at ) );
					return Number.isFinite( value ) ? value : null;

				},
				entries: () => Object.freeze( this.adapter.entries().map( ( entry, index ) => Object.freeze( {
					name: typeof entry.name === 'string' ? entry.name : null, position: point( entry.position, `spatial.entries.${index}` ) } ) ) ),
			} ),
			spawn: Object.freeze( {
				crowd: ( options ) => this.spawn( 'crowd', options ),
				bystanders: ( options ) => this.spawn( 'bystanders', options ),
				squad: ( options ) => this.spawn( 'squad', options ),
				vehicle: ( options ) => this.spawn( 'vehicle', options ),
			} ),
			locations: Object.freeze( { get: ( id ) => this.location( id ) } ),
			actors: Object.freeze( { get: ( handle ) => this.actor( handle ), resolve: ( id ) => {

				check( this.actors.has( id ), 'actors.resolve', `unknown actor '${id}'` );
				return this.actors.get( id ).handle;

			} } ),
			presentation: Object.freeze( {
				notice: ( text, kind = 'info', at = null ) => {

					this.writable();
					check( typeof text === 'string' && text.trim() !== '', 'presentation.notice.text', 'must be non-empty text' );
					check( [ 'info', 'good', 'warn', 'bad' ].includes( kind ), 'presentation.notice.kind', 'invalid notice kind' );
					this.adapter.notice( text, kind, at === null ? null : this.location( at ) );

				},
				focus: ( at, zoom = 0.5 ) => {

					this.writable();
					check( Number.isFinite( zoom ) && zoom > 0, 'presentation.focus.zoom', 'must be positive and finite' );
					this.adapter.focus( this.location( at ), zoom );

				},
			} ),
			get time() { return runtime.time; },
			random: () => this.random(),
			get metrics() { return runtime.metrics(); },
			get observation() { return runtime.observation; },
		} );

	}

	writable() {

		check( [ 'setting-up', 'briefing', 'starting', 'running', 'paused' ].includes( this.state ), 'runtime', `cannot mutate while ${this.state}` );

	}

	location( reference ) {

		if ( Array.isArray( reference ) ) return point( reference, 'location' );
		check( typeof reference === 'string' && this.locations.has( reference ), 'location', `unknown location '${reference}'` );
		return this.locations.get( reference );

	}

	random() {

		let value = this.randomState;
		value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
		this.randomState = value >>> 0;
		return this.randomState / 0x100000000;

	}

	crowdRecord( value ) {

		const handle = typeof value === 'string' ? this.context.actors.resolve( value ) : value;
		const record = this.actors.get( handle?.id );
		check( record?.handle === handle && handle.kind === 'crowd' && Array.isArray( record.backend ), 'crowd.actor', 'must be an allocated crowd actor' );
		return record;

	}

	setCrowdMode( value, mode ) {

		this.writable();
		check( [ 'hold', 'march', 'riot', 'sit', 'shield', 'push' ].includes( mode ), 'crowd.mode', 'must be hold, march, riot, sit, shield or push' );
		const actor = this.crowdRecord( value ), result = this.adapter.setCrowdMode( actor.backend, mode );
		if ( result.status === 'rejected' ) return Object.freeze( result );
		this.event( 'crowd.mode-changed', { actor: actor.handle, mode } );
		return Object.freeze( { status: 'completed', value: Object.freeze( { actor: actor.handle, mode } ) } );

	}

	setCrowdMorale( value, morale ) {

		this.writable();
		check( Number.isFinite( morale ) && morale >= 0 && morale <= 1, 'crowd.morale', 'must be between 0 and 1' );
		const actor = this.crowdRecord( value ), result = this.adapter.setCrowdMorale( actor.backend, morale );
		return Object.freeze( result.status === 'rejected' ? result : { status: 'completed', value: Object.freeze( { actor: actor.handle, morale } ) } );

	}

	nudgeCrowd( value, options ) {

		this.writable();
		fields( options, [ 'agitation', 'resolve', 'share', 'leaders' ], 'crowd.nudge' );
		const agitation = options.agitation ?? 0, resolve = options.resolve ?? 0, share = options.share ?? 1, leaders = options.leaders ?? false;
		check( Number.isFinite( agitation ) && agitation >= - 1 && agitation <= 1, 'crowd.nudge.agitation', 'must be from -1 to 1' );
		check( Number.isFinite( resolve ) && resolve >= - 2 && resolve <= 2, 'crowd.nudge.resolve', 'must be from -2 to 2' );
		check( agitation !== 0 || resolve !== 0, 'crowd.nudge', 'must change agitation or resolve' );
		check( Number.isFinite( share ) && share > 0 && share <= 1, 'crowd.nudge.share', 'must be above 0 and at most 1' );
		check( typeof leaders === 'boolean', 'crowd.nudge.leaders', 'must be a boolean' );
		const actor = this.crowdRecord( value ), result = this.adapter.nudgeCrowd( actor.backend, { agitation, resolve, share, leaders, random: () => this.random() } );
		if ( result.status === 'rejected' ) return Object.freeze( result );
		this.event( 'crowd.nudged', { actor: actor.handle, people: result.people, agitation, resolve } );
		return Object.freeze( { status: 'completed', value: Object.freeze( { actor: actor.handle, people: result.people } ) } );

	}

	async setup() {

		check( this.state === 'created', 'runtime.setup', 'may only run once' );
		this.state = 'setting-up';
		try {

			for ( const [ id, reference ] of Object.entries<any>( this.definition.locations ) ) {

				if ( reference.kind === 'target' ) {

					const target = mapTarget( this.adapter.target( reference.name ), `scenario.locations.${id}` );
					this.spatial.targets.set( id, target ); this.locations.set( id, target.position );
					continue;

				}
				const value = Array.isArray( reference ) ? reference : reference.kind === 'landmark' ? this.adapter.landmark( reference.name ) : this.adapter.place( reference.name );
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
			if ( [ 'protect', 'extract' ].includes( this.definition.objectives[ 0 ].kind ) ) {

				const objective = this.definition.objectives[ 0 ];
				check( this.identity.entities.get( objective.protected )?.rules, 'objective.protected', 'must refer to a declared protected person' );
				if ( objective.kind === 'extract' ) this.location( objective.at );

			}
			if ( this.definition.objectives[ 0 ].kind === 'hold-building' ) {

				const objective = this.definition.objectives[ 0 ];
				const target = this.spatial.prepareBuilding( objective.target, objective.exitAt );
				this.buildingState = Object.freeze( { breach: 0, evacuation: 0,
					blocked: Object.freeze( target.exits.map( () => false ) ), facade: 0 } );

			}
			if ( this.definition.objectives[ 0 ].kind === 'escort-convoy' ) this.convoys.resolve( this.definition.objectives[ 0 ].convoy );
			this.behaviors.setup();
			this.state = 'briefing';

		} catch ( error ) {

			this.fail( error );
			throw error;

		}

	}

	spawn( kind, options, owner = null ) {

		this.writable();
		fields( options, kind === 'vehicle' ? [ 'id', 'at', 'capacity', 'label', 'type', 'crew' ] : kind === 'crowd'
			? [ 'id', 'at', 'people', 'spread', 'label', 'groupSize', 'agitation', 'resolve', 'morale', 'bikes', 'goal', 'goalRadius', 'mode', 'faction', 'points' ]
			: kind === 'bystanders' ? [ 'id', 'people', 'destinations', 'groupSize', 'spread' ] : [ 'id', 'at', 'people', 'spread' ], `spawn.${kind}` );
		check( typeof options.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test( options.id ), 'spawn.id', 'must be a lowercase slug' );
		check( ! this.actors.has( options.id ), 'spawn.id', `'${options.id}' is already allocated` );
		const people = options.people ?? ( kind === 'squad' ? 24 : 100 );
		check( Number.isInteger( people ) && people > 0 && people <= 10000, 'spawn.people', 'must be an integer from 1 to 10000' );
		const spread = options.spread ?? ( kind === 'squad' ? 5 : kind === 'bystanders' ? 60 : 20 );
		check( Number.isFinite( spread ) && spread >= 0 && spread <= 1000, 'spawn.spread', 'must be between 0 and 1000 meters' );
		const capacity = kind === 'vehicle' ? options.capacity ?? 1 : null;
		const vehicleType = kind === 'vehicle' ? options.type ?? 'transport' : null;
		const vehicleCrew = vehicleType === 'police-patrol' ? options.crew ?? 8 : 0;
		if ( kind === 'vehicle' ) {

			check( Number.isInteger( capacity ) && capacity > 0 && capacity <= 8, 'spawn.capacity', 'must be an integer from 1 to 8' );
			check( options.label === undefined || ( typeof options.label === 'string' && options.label.trim() !== '' ), 'spawn.label', 'must be non-empty text' );
			check( [ 'transport', 'water-cannon', 'police-patrol', 'prisoner-van' ].includes( vehicleType ), 'spawn.type', 'must be transport, water-cannon, police-patrol or prisoner-van' );
			check( vehicleType === 'police-patrol' ? Number.isInteger( vehicleCrew ) && vehicleCrew > 0 && vehicleCrew <= 16 : options.crew === undefined,
				'spawn.crew', 'is available only for police-patrol vehicles and must be from 1 to 16' );

		}
		const at = kind === 'bystanders' ? null : this.location( options.at );
		let crowdOptions: Record<string, any> = {};
		if ( kind === 'crowd' ) {

			const groupSize = options.groupSize ?? 60, agitation = options.agitation ?? [ 0.05, 0.25 ], resolve = options.resolve ?? [ 0.6, 1.0 ], morale = options.morale ?? 0.5;
			const bikes = options.bikes ?? 0, goalRadius = options.goalRadius ?? 25, faction = options.faction ?? 'protester';
			const goal = options.goal === undefined ? null : this.location( options.goal );
			const mode = options.mode ?? ( goal ? 'march' : 'hold' );
			check( Number.isInteger( groupSize ) && groupSize > 0 && groupSize <= 500, 'spawn.groupSize', 'must be an integer from 1 to 500' );
			check( Array.isArray( agitation ) && agitation.length === 2 && Array.from( agitation ).every( ( value ) => Number.isFinite( value ) && value >= 0 && value <= 1 ) && agitation[ 0 ] <= agitation[ 1 ], 'spawn.agitation', 'must be an ordered finite range from 0 to 1' );
			check( Array.isArray( resolve ) && resolve.length === 2 && Array.from( resolve ).every( ( value ) => Number.isFinite( value ) && value >= 0 && value <= 2 ) && resolve[ 0 ] <= resolve[ 1 ], 'spawn.resolve', 'must be an ordered finite range from 0 to 2' );
			check( options.points === undefined || ( Array.isArray( options.points ) && options.points.length === people && Array.from( options.points ).every( Array.isArray ) ),
				'spawn.points', 'must list exactly one coordinate pair per person' );
			const points = options.points === undefined ? null : Object.freeze( options.points.map( ( value, index ) => point( value, `spawn.points.${index}` ) ) );
			for ( const [ key, value ] of [ [ 'morale', morale ], [ 'bikes', bikes ] ] ) check( Number.isFinite( value ) && value >= 0 && value <= 1, `spawn.${key}`, 'must be between 0 and 1' );
			check( Number.isFinite( goalRadius ) && goalRadius > 0 && goalRadius <= 1000, 'spawn.goalRadius', 'must be positive and at most 1000 meters' );
			check( [ 'hold', 'march', 'riot', 'sit' ].includes( mode ), 'spawn.mode', 'must be hold, march, riot or sit' );
			check( mode !== 'sit' || points !== null, 'spawn.mode', 'sit mode requires points' );
			check( points === null || bikes === 0, 'spawn.bikes', 'placed crowds walk' );
			check( mode !== 'march' || goal !== null, 'spawn.goal', 'march mode requires a destination' );
			check( [ 'protester', 'bystander', 'counter' ].includes( faction ), 'spawn.faction', 'must be a civilian faction' );
			check( options.label === undefined || ( typeof options.label === 'string' && options.label.trim() !== '' ), 'spawn.label', 'must be non-empty text' );
			crowdOptions = { groupSize, agitation: Object.freeze( [ ...agitation ] ), resolve: Object.freeze( [ ...resolve ] ), morale, bikes, goal, goalRadius, mode, faction, points };

		} else if ( kind === 'bystanders' ) {

			const groupSize = options.groupSize ?? 12, destinations = options.destinations;
			check( Number.isInteger( groupSize ) && groupSize > 0 && groupSize <= 500, 'spawn.groupSize', 'must be an integer from 1 to 500' );
			check( Array.isArray( destinations ) && destinations.length > 0 && destinations.length <= 32
				&& Array.from( destinations ).every( ( destination ) => typeof destination === 'string' || Array.isArray( destination ) ),
			'spawn.destinations', 'must be a dense non-empty list of locations' );
			crowdOptions = { groupSize, destinations: Object.freeze( destinations.map( ( destination ) => this.location( destination ) ) ) };

		}
		const actorKind = kind === 'bystanders' ? 'crowd' : kind;
		const handle = Object.freeze( { id: options.id, kind: actorKind, run: this.run } );
		const crewId = kind === 'vehicle' && vehicleCrew ? `${options.id}-crew` : null;
		check( ! crewId || ! this.actors.has( crewId ), 'spawn.id', `crew actor '${crewId}' is already allocated` );
		const record = { handle, backend: null, owner, capacity, type: vehicleType, crewHandle: null,
			requestedPeople: kind === 'vehicle' ? vehicleCrew : people,
			requestedGroups: kind === 'vehicle' ? Number( vehicleCrew > 0 ) : kind === 'squad' ? 1 : Math.ceil( people / crowdOptions.groupSize ) };
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
			owner?.operations.delete( operation );
			if ( outcome.status !== 'completed' ) this.actors.delete( handle.id );
			resolve( Object.freeze( outcome ) );

		};
		this.operations.add( operation );
		owner?.operations.add( operation );
		timer = setTimeout( () => {

			const error = new Error( `spawn.${options.id}: timed out` );
			controller.abort( error );
			settle( { status: 'failed', error } );
			this.operationFailed( error );

		}, this.timeout );
		Promise.resolve().then( () => {

			if ( done ) return;
			return this.adapter.spawn( kind, Object.freeze( { id: options.id, at, people, spread, capacity, type: vehicleType, crew: vehicleCrew, label: options.label, ...crowdOptions } ), controller.signal );

		} ).then( ( backend ) => {

			if ( done ) { if ( backend !== undefined ) this.release( backend ); return; }
			if ( backend === undefined || backend === null ) {

				const error = new Error( `spawn.${options.id}: adapter returned no actor allocation` );
				settle( { status: 'failed', error } );
				this.operationFailed( error );
				return;

			}
			record.backend = backend;
			if ( crewId && backend.crew ) {

				record.crewHandle = Object.freeze( { id: crewId, kind: 'squad', run: this.run } );
				this.actors.set( crewId, { handle: record.crewHandle, backend: [ backend.crew ], owner, capacity: null, type: null,
					crewHandle: null, requestedPeople: vehicleCrew, requestedGroups: 1 } );

			}
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

	releaseOwnerActors( owner ) {

		for ( const [ id, record ] of this.actors ) if ( record.owner === owner ) {

			this.removeActor( record.handle );

		}

	}

	removeActor( handle ) {

		const record = this.actors.get( handle.id );
		if ( record?.handle !== handle ) return;
		this.commands.claims.get( handle )?.cancel( 'actor removed' );
		if ( record.crewHandle ) {

			const crew = this.actors.get( record.crewHandle.id );
			if ( crew ) {

				this.commands.claims.get( crew.handle )?.cancel( 'vehicle removed' );
				const crewMovement = this.movement.orders.get( crew.handle.id );
				if ( crewMovement ) this.movement.remove( crewMovement, 'vehicle removed' );
				this.identity.releaseActor( crew.handle );
				this.actors.delete( crew.handle.id );

			}

		}
		const movement = this.movement.orders.get( handle.id );
		if ( movement ) this.movement.remove( movement, 'actor removed' );
		this.transport.releaseActor( handle ); this.identity.releaseActor( handle );
		if ( record.backend !== null ) this.release( record.backend );
		this.actors.delete( handle.id );

	}

	move( owner, actor, at, options ) { return this.movement.order( owner, actor, at, options ); }
	stopOwnerMovement( owner ) { this.movement.stopOwner( owner ); }

	playerMove( actor, at, options? ) {

		const handle = typeof actor === 'string' ? this.context.actors.resolve( actor ) : actor;
		this.commands.playerOverride( [ handle ] );
		return this.movement.order( this.movement.player, handle, at, options );

	}

	event( type, payload ) {

		if ( terminal.has( this.state ) ) return;
		this.events.push( Object.freeze( { type, sequence: this.nextEvent ++, time: this.time, ...payload } ) );
		if ( this.dispatching ) return;
		this.dispatching = true;
		try {

			let count = 0;
			while ( this.events.length ) {

				check( ++ count <= 1000, 'events', 'dispatch limit exceeded' );
				this.behaviors.dispatch( 'onEvent', this.events.shift() );

			}

		} catch ( error ) { this.events = []; this.fail( error ); }
		finally { this.dispatching = false; }

	}

	playerAction( action ) {

		if ( ! [ 'running', 'paused' ].includes( this.state ) ) return;
		check( action && typeof action === 'object' && typeof action.type === 'string' && Array.isArray( action.selection ), 'action', 'must be a semantic player action' );
		this.behaviors.dispatch( 'onAction', action );

	}

	showCoach( owner, card ) {

		check( owner.state === 'starting' || owner.state === 'active', `behavior.${owner.id}.coach`, 'owner is stopped' );
		if ( card === null ) { this.clearCoach( owner ); return; }
		fields( card, [ 'chapter', 'text', 'step', 'total', 'spot', 'next', 'onNext', 'onSkip' ], 'coach' );
		check( typeof card.chapter === 'string' && card.chapter.trim() !== '' && card.chapter.length <= 80, 'coach.chapter', 'must be non-empty text up to 80 characters' );
		check( typeof card.text === 'string' && card.text.trim() !== '' && card.text.length <= 500, 'coach.text', 'must be non-empty text up to 500 characters' );
		check( Number.isInteger( card.step ) && card.step > 0 && Number.isInteger( card.total ) && card.total >= card.step,
			'coach.step', 'must be a positive step within the total' );
		check( card.spot === undefined || ( typeof card.spot === 'string' && /^[a-z][a-zA-Z0-9_-]{0,39}$/.test( card.spot ) ), 'coach.spot', 'must be a HUD element ID' );
		check( card.next === undefined || typeof card.next === 'boolean', 'coach.next', 'must be a boolean' );
		check( typeof card.onNext === 'function', 'coach.onNext', 'must be a function' );
		check( card.onSkip === undefined || typeof card.onSkip === 'function', 'coach.onSkip', 'must be a function' );
		this.coachOwner = owner;
		this.adapter.coach( Object.freeze( { ...card } ) );

	}

	clearCoach( owner ) {

		if ( this.coachOwner !== owner ) return;
		this.coachOwner = null;
		this.adapter.coach( null );

	}

	actor( handle ) {

		check( handle?.run === this.run && this.actors.get( handle.id )?.handle === handle, 'actors.get', 'unknown or foreign actor handle' );
		return this.observation?.actors.find( ( actor ) => actor.handle === handle ) ?? null;

	}

	metrics() {

		const raw = this.adapter.readMetrics?.() ?? { opinion: 60, counters: {} };
		const escalation = raw.escalation ?? 0;
		check( raw && typeof raw === 'object' && Number.isFinite( raw.opinion ) && raw.opinion >= 0 && raw.opinion <= 100
			&& Number.isInteger( escalation ) && escalation >= 0 && escalation <= 4
			&& raw.counters && typeof raw.counters === 'object', 'metrics', 'adapter returned invalid semantic metrics' );
		const counters = Object.fromEntries( [ 'injuriesByPolice', 'otherInjuries', 'officersInjured', 'arrests', 'sitterArrests', 'peopleGone', 'gasUsed', 'shotsFired' ].map( ( key ) => {

			const value = raw.counters[ key ] ?? 0;
			check( Number.isFinite( value ) && value >= 0, `metrics.counters.${key}`, 'must be a non-negative finite number' );
			return [ key, value ];

		} ) );
		const clashContacts = raw.clashContacts ?? 0;
		check( Number.isInteger( clashContacts ) && clashContacts >= 0, 'metrics.clashContacts', 'must be a non-negative integer' );
		return Object.freeze( { opinion: raw.opinion, escalation, clashContacts, clashPressure: this.clashPressure, counters: Object.freeze( counters ) } );

	}

	phase() {

		const objective = this.definition.objectives[ 0 ];
		const fallback = `${formatTime( objective.seconds - this.time )} left`;
		if ( ! this.definition.phase ) return fallback;
		try {

			const value = this.definition.phase( Object.freeze( { time: this.time, metrics: this.metrics(), objective: objective.kind } ) );
			check( typeof value === 'string' && value.trim() !== '' && value.length <= 160 && ! ( value as any ).then,
				'scenario.phase', 'must return synchronous non-empty text of at most 160 characters' );
			return value;

		} catch ( error ) { this.fail( new Error( `scenario.phase: ${error.message}`, { cause: error } ) ); return fallback; }

	}

	indicatorObjectives() {

		const { counters } = this.metrics();
		return this.definition.indicators.map( ( indicator ) => {

			const value = counters[ indicator.counter ], bad = value > indicator.maximum;
			return { label: indicator.label, value: Math.min( 1, value / indicator.maximum ), text: `${Math.round( value )}`,
				state: bad ? 'bad' : indicator.warnAt !== undefined && value > indicator.warnAt ? 'warn' : 'ok', invert: true };

		} );

	}

	observe( sample, { sampledAt = this.time, step = this.step } = {} ) {

		if ( terminal.has( this.state ) || this.state === 'setting-up' || sample === this.lastSample ) return;
		check( sample !== null && typeof sample === 'object', 'observation', 'must be a sample token' );
		check( Number.isFinite( sampledAt ) && sampledAt >= 0 && sampledAt <= this.time + 1e-9, 'observation.sampledAt', 'must be a represented game time' );
		check( Number.isInteger( step ) && step >= 0 && step <= this.step, 'observation.step', 'must be a represented simulation step' );
		if ( this.observation && ( sampledAt < this.observation.sampledAt || step < this.observation.step ) ) return;
		const actors = [];
		for ( const record of this.actors.values() ) {

			if ( record.backend === null ) continue;
			const state = this.adapter.readActor( record.backend, sample );
			if ( ! state ) continue;
			check( Number.isInteger( state.alive ) && state.alive >= 0, 'observation.alive', 'must be a non-negative integer' );
			actors.push( Object.freeze( { handle: record.handle, alive: state.alive,
				center: state.center ? point( state.center, 'observation.center' ) : null } ) );

		}
		const vehicleEvents = this.transport.collect( sample, { step } );
		const people = this.identity.collect( sample, { step } );
		const identityEvents = this.identity.reconcile( { elapsed: this.observation ? sampledAt - this.observation.sampledAt : 0 } );

		this.lastSample = sample;
		this.observation = Object.freeze( { sequence: ( this.observation?.sequence ?? 0 ) + 1,
			sampledAt, step, elapsed: this.observation ? sampledAt - this.observation.sampledAt : 0,
			receivedAt: this.time, actors: Object.freeze( actors ), people, protected: this.identity.snapshots, vehicles: this.transport.snapshots } );
		if ( [ 'running', 'paused' ].includes( this.state ) ) {

			try {

				for ( const { type, ...event } of vehicleEvents ) this.event( type, event );
				for ( const { type, ...event } of identityEvents ) this.event( type, event );
				this.movement.observe( this.observation ); this.behaviors.dispatch( 'observe', this.observation );

			} catch ( error ) { this.fail( error ); }

		}

	}

	start() {

		check( this.state === 'briefing', 'runtime.start', 'must be awaiting briefing confirmation' );
		check( this.observation !== null, 'runtime.start', 'requires an initial observation' );
		if ( this.behaviors.instances.size === 0 ) { this.state = 'running'; return Promise.resolve(); }
		this.state = 'starting';
		return this.behaviors.start().then( () => {

			check( this.state === 'starting', 'runtime.start', 'interrupted' );
			this.state = 'running';
			this.behaviors.dispatch( 'observe', this.observation );

		} ).catch( ( error ) => { this.fail( error ); throw error; } );

	}

	pause( paused ) {

		if ( this.state === 'running' && paused ) this.state = 'paused';
		else if ( this.state === 'paused' && ! paused ) this.state = 'running';

	}

	update( dt ) {

		check( Number.isFinite( dt ) && dt >= 0, 'runtime.update.dt', 'must be non-negative and finite' );
		if ( this.state !== 'running' ) return;
		this.time += dt;
		this.step ++;
		try { this.convoys.update( dt ); this.custody.update(); } catch ( error ) { this.fail( error ); return; }
		const objective = this.definition.objectives[ 0 ];
		if ( objective.kind === 'prevent-clash' ) this.clashPressure = advanceClash( this.clashPressure, this.metrics().clashContacts, dt );
		try { this.behaviors.update( dt ); } catch ( error ) { this.fail( error ); return; }
		if ( this.state !== 'running' ) return;
		if ( objective.kind === 'hold-building' ) {

			const measured = this.spatial.measureBuilding( objective.target, objective.exitAt );
			if ( measured ) this.buildingState = advanceBuilding( this.buildingState, measured, dt );
			const outcome = this.evaluateOutcomes();
			if ( this.state !== 'running' ) return;
			if ( outcome ) { this.finish( outcome.win, outcome.reason ); return; }
			const failure = this.buildingState.breach >= 1 || this.buildingState.evacuation >= 1;
			if ( ! failure && this.time + 1e-9 < objective.seconds ) return;
			if ( ! measured ) { this.fail( new Error( 'objective.target: complete building observation unavailable at deadline' ) ); return; }
			if ( ! failure ) this.time = Math.max( this.time, objective.seconds );
			const target = this.spatial.target( objective.target );
			this.finish( ! failure, failure ? this.buildingState.breach >= 1 ? `Protesters forced their way into ${target.name}.`
				: 'Every exit was blocked - the evacuation could not proceed.' : objective.reason );
			return;

		}
		const outcome = this.evaluateOutcomes();
		if ( this.state !== 'running' ) return;
		if ( outcome ) { this.finish( outcome.win, outcome.reason ); return; }
		if ( objective.kind === 'escort-convoy' ) {

			const convoy = this.convoys.get( objective.convoy );
			if ( convoy.integrity <= 0 ) { this.finish( false, objective.integrityReason ); return; }
			if ( convoy.blockedFor > objective.maxBlocked ) { this.finish( false, objective.blockedReason ); return; }
			if ( convoy.arrived ) { this.finish( true, objective.reason ); return; }
			if ( this.time + 1e-9 >= objective.seconds ) { this.time = Math.max( this.time, objective.seconds ); this.finish( false, objective.timeoutReason ); }
			return;

		}
		if ( objective.kind === 'prevent-clash' ) {

			if ( this.clashPressure >= 1 ) { this.finish( false, objective.failureReason ); return; }
			if ( this.time + 1e-9 < objective.seconds ) return;
			this.time = Math.max( this.time, objective.seconds );
			this.finish( true, objective.reason );
			return;

		}
		const protectedObjective = [ 'protect', 'extract' ].includes( objective.kind );
		const entity = protectedObjective ? this.identity.entities.get( objective.protected ) : null;
		const terminalFailure = protectedObjective && ( ! entity || [ 'captured', 'dead' ].includes( entity.state ) );
		const destination = objective.kind === 'extract' ? this.location( objective.at ) : null;
		const extracted = objective.kind === 'extract' && entity?.state === 'exited' && entity.position
			&& Math.hypot( entity.position[ 0 ] - destination[ 0 ], entity.position[ 1 ] - destination[ 1 ] ) <= objective.radius;
		if ( ! terminalFailure && ! extracted && this.time + 1e-9 < objective.seconds ) return;
		if ( objective.kind === 'protect' && ! terminalFailure && ! [ 'aboard', 'exited' ].includes( entity.state ) && ! entity.capture?.available ) {

			this.fail( new Error( 'objective.protected: complete observation unavailable at deadline' ) );
			return;

		}
		if ( ! terminalFailure && ! extracted ) this.time = Math.max( this.time, objective.seconds );
		const win = objective.kind === 'extract' ? Boolean( extracted ) : ! protectedObjective || ( entity && [ 'active', 'carried', 'aboard', 'exited' ].includes( entity.state ) );
		const reason = win ? objective.reason : entity?.state === 'captured' ? 'The protected person was captured.'
			: entity?.state === 'dead' ? 'The protected person died.' : objective.kind === 'extract' ? 'The protected person did not reach the exit in time.'
				: 'The protected person was not safe when time expired.';
		this.finish( Boolean( win ), reason );

	}

	evaluateOutcomes() {

		if ( ! this.definition.outcomes.length ) return null;
		const objective = this.definition.objectives[ 0 ];
		const context = Object.freeze( { time: this.time, metrics: this.metrics(), objective,
			building: this.buildingState ? Object.freeze( { ...this.buildingState, blocked: Object.freeze( [ ...this.buildingState.blocked ] ) } ) : null,
			observation: this.observation } );
		for ( const rule of this.definition.outcomes ) try {

			const outcome = rule.evaluate( context );
			if ( outcome == null ) continue;
			fields( outcome, [ 'win', 'reason' ], `scenario.outcomes.${rule.id}` );
			check( typeof outcome.win === 'boolean' && typeof outcome.reason === 'string' && outcome.reason.trim() !== '',
				`scenario.outcomes.${rule.id}`, 'must return win and a non-empty reason' );
			return Object.freeze( { win: outcome.win, reason: outcome.reason } );

		} catch ( error ) {

			this.fail( new Error( `scenario.outcomes.${rule.id}: ${error.message}`, { cause: error } ) );
			return null;

		}
		return null;

	}

	finish( win, reason ) {

		if ( terminal.has( this.state ) ) return;
		let score = { stars: win ? 3 : 0, lines: [ Object.freeze( [ 'Time held', formatTime( this.time ) ] ) ] };
		if ( this.definition.score ) try {

			const input = Object.freeze( { win: Boolean( win ), reason, time: this.time, metrics: this.metrics() } );
			score = this.definition.score( input );
			check( score && typeof score === 'object' && typeof ( score as any ).then !== 'function', 'scenario.score', 'must return a synchronous score' );
			fields( score, [ 'stars', 'lines' ], 'scenario.score.result' );
			check( Number.isInteger( score.stars ) && score.stars >= 0 && score.stars <= 3, 'scenario.score.stars', 'must be an integer from 0 to 3' );
			check( Array.isArray( score.lines ) && score.lines.length <= 20 && Array.from( score.lines ).every( ( line ) => Array.isArray( line )
				&& line.length === 2 && typeof line[ 0 ] === 'string' && line[ 0 ].trim() !== ''
				&& ( typeof line[ 1 ] === 'string' && line[ 1 ].length <= 300 || Number.isFinite( line[ 1 ] ) ) ), 'scenario.score.lines', 'must be at most 20 label/value rows' );
			score = { stars: score.stars, lines: score.lines.map( ( line ) => Object.freeze( [ line[ 0 ], line[ 1 ] ] ) ) };

		} catch ( error ) { this.fail( new Error( `scenario.score: ${error.message}`, { cause: error } ) ); return; }
		this.state = 'finished';
		this.commands.stopAll(); this.resources.dispose();
		this.convoys.dispose();
		this.result = Object.freeze( { win: Boolean( win ), reason, stars: score.stars, lines: Object.freeze( score.lines ) } );
		this.behaviors.stopAll( 'finished' );
		this.movement.stopAll();
		this.transport.stopAll();
		for ( const operation of [ ...this.operations ] ) operation.cancel( 'scenario finished' );
		this.onFinish( this.result );

	}

	objectives() {

		const objective = this.definition.objectives[ 0 ];
		if ( this.definition.hud && this.state !== 'failed' ) try {

			const rows = this.definition.hud( Object.freeze( { time: this.time, metrics: this.metrics(), objective: objective.kind } ) );
			check( Array.isArray( rows ) && rows.length >= 1 && rows.length <= 8, 'scenario.hud', 'must return 1 to 8 rows' );
			return rows.map( ( row, index ) => {

				fields( row, [ 'label', 'value', 'text', 'state', 'invert' ], `scenario.hud.${index}` );
				check( typeof row.label === 'string' && row.label.trim() !== '' && row.label.length <= 80, `scenario.hud.${index}.label`, 'must be non-empty text of at most 80 characters' );
				check( typeof row.text === 'string' && row.text.length <= 40, `scenario.hud.${index}.text`, 'must be text of at most 40 characters' );
				check( Number.isFinite( row.value ), `scenario.hud.${index}.value`, 'must be finite' );
				check( [ 'ok', 'warn', 'bad', 'done' ].includes( row.state ), `scenario.hud.${index}.state`, 'must be ok, warn, bad or done' );
				check( row.invert === undefined || typeof row.invert === 'boolean', `scenario.hud.${index}.invert`, 'must be a boolean' );
				return Object.freeze( { label: row.label, value: Math.max( 0, Math.min( 1, row.value ) ), text: row.text, state: row.state, invert: row.invert ?? false } );

			} );

		} catch ( error ) { this.fail( new Error( `scenario.hud: ${error.message}`, { cause: error } ) ); }
		if ( objective.kind === 'hold-building' ) {

			const state = this.buildingState ?? { breach: 0, evacuation: 0, facade: 0, blocked: [] };
			const clear = state.blocked.filter( ( blocked ) => ! blocked ).length;
			return [
				{ label: objective.label, value: Math.min( 1, this.time / objective.seconds ), text: formatTime( objective.seconds - this.time ), state: this.result ? this.result.win ? 'done' : 'bad' : 'ok' },
				{ label: 'Facade breach', value: state.breach, text: `${state.facade} at the doors`, state: state.breach > 0.6 ? 'bad' : state.breach > 0.25 ? 'warn' : 'ok', invert: true },
				{ label: `Exits clear ${clear}/${state.blocked.length}`, value: state.evacuation, text: state.evacuation > 0 ? `evac ${Math.round( state.evacuation * 100 )}%` : 'open',
					state: state.evacuation > 0.5 ? 'bad' : clear < state.blocked.length ? 'warn' : 'ok', invert: true },
				...this.indicatorObjectives(),
			];

		}
		if ( objective.kind === 'prevent-clash' ) return [
			{ label: objective.label, value: Math.min( 1, this.time / objective.seconds ), text: formatTime( objective.seconds - this.time ), state: this.result ? this.result.win ? 'done' : 'bad' : 'ok' },
			{ label: 'Clash', value: this.clashPressure, text: `${Math.round( this.clashPressure * 100 )}%`,
				state: this.clashPressure > 0.6 ? 'bad' : this.clashPressure > 0.2 ? 'warn' : 'ok', invert: true },
			...this.indicatorObjectives(),
		];
		if ( objective.kind === 'escort-convoy' ) {

			const convoy = this.convoys.get( objective.convoy );
			return [
				{ label: 'Convoy reaches the Assembly', value: convoy.progress, text: `${Math.round( convoy.progress * 100 )}%`, state: convoy.arrived ? 'done' : convoy.speed < 0.5 && convoy.moving ? 'warn' : 'ok' },
				{ label: 'VIP car integrity', value: convoy.integrity, text: `${Math.round( convoy.integrity * 100 )}%`, state: convoy.integrity < 0.35 ? 'bad' : convoy.integrity < 0.7 ? 'warn' : 'ok' },
				{ label: `★ Arrive within ${formatTime( 360 )} of departure`, value: Math.min( 1, this.time / 360 ), text: formatTime( this.time ), state: this.time > 360 ? 'bad' : 'ok', invert: true },
				...this.indicatorObjectives(),
			];

		}
		const entity = [ 'protect', 'extract' ].includes( objective.kind ) ? this.identity.entities.get( objective.protected ) : null;
		const bad = entity && [ 'down', 'captured', 'dead' ].includes( entity.state );
		return [ { label: objective.label, value: Math.min( 1, this.time / objective.seconds ),
			text: entity ? `${entity.state.toUpperCase()} · ${formatTime( objective.seconds - this.time )}` : formatTime( objective.seconds - this.time ),
			state: this.result ? ( this.result.win ? 'done' : 'bad' ) : bad ? 'bad' : 'ok' }, ...this.indicatorObjectives() ];

	}

	fail( error ) {

		if ( terminal.has( this.state ) ) return;
		this.state = 'failed';
		this.error = error;
		this.commands.stopAll(); this.resources.dispose();
		this.convoys.dispose();
		this.behaviors.stopAll( 'failed' );
		this.movement.stopAll();
		this.transport.dispose();
		for ( const operation of [ ...this.operations ] ) operation.cancel( 'scenario failed' );
		for ( const record of this.actors.values() ) if ( record.backend !== null ) this.release( record.backend );
		this.actors.clear();
		this.identity.dispose();
		this.onFailure( error );

	}

	dispose() {

		if ( this.state === 'disposed' ) return;
		this.state = 'disposed';
		this.commands.stopAll(); this.resources.dispose();
		this.convoys.dispose();
		this.behaviors.stopAll( 'disposed' );
		this.movement.stopAll();
		this.transport.dispose();
		for ( const operation of [ ...this.operations ] ) operation.cancel( 'scenario disposed' );
		for ( const record of this.actors.values() ) if ( record.backend !== null ) this.release( record.backend );
		this.actors.clear();
		this.identity.dispose();
		this.observation = null;
		this.lastSample = null;

	}

}