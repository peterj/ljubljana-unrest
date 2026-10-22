import assert from 'node:assert/strict';
import test from 'node:test';
import { TransportHost } from '../src/game/scenarios/transport.js';
import { defineScenario, extract, survive } from '../src/game/scenarios/definition.js';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.js';

function fixture( type = 'transport' ) {

	const handle = Object.freeze( { id: 'pickup', kind: 'vehicle', run: 1 } );
	const backend = { position: [ 0, 0 ], speed: 0, moving: false };
	const events = [], drives = [];
	const runtime = { step: 0, actors: new Map( [ [ handle.id, { handle, backend, capacity: 1, type } ] ] ),
		context: { actors: { resolve: () => handle } }, writable() {}, location: ( value ) => value,
		event: ( type, payload ) => events.push( { type, ...payload } ),
		adapter: { readVehicle: ( value ) => value,
			driveVehicle( value, destination ) { drives.push( destination ); value.moving = true; return { status: 'completed', destination }; },
			stopVehicle( value ) { value.moving = false; value.speed = 0; },
		} };
	return { runtime, handle, backend, events, drives, host: new TransportHost( runtime ) };

}

test( 'vehicle driving validates revisions, ownership and immutable snapshots', () => {

	const { host, handle, drives } = fixture();
	const first = {}, second = {};
	assert.equal( host.drive( first, handle, [ 20, 0 ], { expectedRevision: 0 } ).status, 'completed' );
	assert.equal( host.drive( first, handle, [ 30, 0 ], { expectedRevision: 0 } ).code, 'STALE_REVISION' );
	assert.equal( host.drive( second, handle, [ 30, 0 ], { expectedRevision: 1 } ).code, 'CONTROL_BUSY' );
	assert.equal( drives.length, 1 );
	const state = host.context().get( handle );
	assert.equal( state.capacity, 1 ); assert.equal( state.revision, 1 );
	assert.throws( () => { state.position[ 0 ] = 99; }, TypeError );
	assert.throws( () => host.record( { ...handle } ), /foreign/ );

} );

test( 'patrol crew can be boarded/deployed through revisioned vehicle control', () => {

	const { host, runtime, handle, backend, events } = fixture( 'police-patrol' );
	backend.aboard = [];
	backend.crew = { members: [ 1, 2, 3, 4 ], alive: 4 };
	const crewHandle = Object.freeze( { id: 'pickup-crew', kind: 'squad', run: 1 } );
	const crewRecord = { handle: crewHandle, backend: [ backend.crew ] };
	runtime.actors.get( handle.id ).crewHandle = crewHandle;
	runtime.actors.set( crewHandle.id, crewRecord );
	runtime.adapter.toggleCrewVehicle = ( car ) => {

		car.aboard = car.aboard.length ? [] : car.crew.members.slice();
		return { status: 'completed' };

	};
	assert.equal( host.context().get( handle ).crew.handle, crewHandle );
	assert.equal( host.toggleCrew( null, handle, { expectedRevision: 0 } ).status, 'completed' );
	assert.equal( host.snapshot( host.record( handle ) ).crew.state, 'aboard' );
	assert.equal( host.toggleCrew( null, handle, { expectedRevision: 0 } ).code, 'STALE_REVISION' );
	backend.moving = true;
	assert.equal( host.toggleCrew( null, handle, { expectedRevision: 1 } ).code, 'VEHICLE_MOVING' );
	backend.moving = false;
	assert.equal( host.toggleCrew( null, handle, { expectedRevision: 1 } ).status, 'completed' );
	assert.equal( host.snapshot( host.record( handle ) ).crew.state, 'deployed' );
	assert.deepEqual( events.filter( ( event ) => event.type === 'vehicle.crew-changed' ).map( ( event ) => event.state ), [ 'aboard', 'deployed' ] );

} );

test( 'arrival is separate from driving acceptance and emitted once after a later step', () => {

	const { host, runtime, handle, backend } = fixture();
	host.drive( null, handle, [ 20, 0 ], { expectedRevision: 0 } );
	assert.deepEqual( host.collect(), [] );
	backend.position = [ 20, 0 ]; backend.moving = false;
	assert.deepEqual( host.collect(), [] );
	runtime.step = 1;
	assert.equal( host.collect()[ 0 ].type, 'vehicle.arrived' );
	assert.deepEqual( host.collect(), [] );

} );

test( 'owner stop and disposal stop owned driving without taking another owner control', () => {

	const { host, handle, backend } = fixture();
	const owner = {};
	host.drive( owner, handle, [ 20, 0 ], { expectedRevision: 0 } );
	assert.equal( host.stop( {}, handle ).code, 'CONTROL_BUSY' );
	host.stopOwner( owner ); assert.equal( backend.moving, false );
	host.dispose(); host.dispose(); assert.equal( host.vehicles.size, 0 );

} );

test( 'runtime tracks vehicle spawns, observations and cleanup without exposing backend objects', async () => {

	let context;
	const released = [];
	const runtime = new ScenarioRuntime( defineScenario( { id: 'vehicle-proof', title: 'Vehicle', subtitle: 'Proof', brief: 'Proof.',
		locations: { start: [ 0, 0 ] }, setup( ctx ) { context = ctx; ctx.spawn.vehicle( { id: 'pickup', at: 'start', capacity: 2 } ); },
		objectives: [ survive( { id: 'hold', seconds: 20 } ) ] } ), {
		spawn: async () => ( { position: [ 0, 0 ], moving: false, speed: 0 } ),
		readActor: () => ( { alive: 1, center: [ 0, 0 ] } ), readVehicle: ( backend ) => backend,
		readPeople: () => [], release: ( backend ) => released.push( backend ), stopVehicle() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const handle = context.vehicles.resolve( 'pickup' );
	assert.equal( handle.kind, 'vehicle' ); assert.equal( context.vehicles.get( handle ).capacity, 2 );
	assert.equal( context.vehicles.get( handle ).type, 'transport' );
	assert.equal( runtime.observation.vehicles.length, 1 ); assert.equal( runtime.observation.vehicles[ 0 ].type, 'transport' );
	assert.throws( () => runtime.playerMove( handle, [ 10, 0 ] ), /vehicles.drive/ );
	runtime.dispose(); runtime.dispose(); assert.equal( released.length, 1 );

} );

function passengerFixture( type ) {

	const result = fixture( type );
	const subject = { handle: { id: 'person' }, backend: {}, actor: { id: 'escort' }, sample: { status: 'active' } };
	const entity = { handle: Object.freeze( { id: 'subject' } ), rules: {}, state: 'active', subject: subject.handle,
		carrier: subject.handle, actor: subject.actor, revision: 1, position: [ 0, 0 ] };
	result.runtime.observation = { sequence: 1 }; result.runtime.lastSample = {};
	result.runtime.identity = { entityRecord: ( handle ) => { assert.equal( handle, entity.handle ); return entity; },
		personRecord: () => subject, snapshot: ( value ) => ( { ...value } ), refresh() {} };
	let confirmed = true, restored = true, queued = 0, rolledBack = 0;
	Object.assign( result.runtime.adapter, { prepareBoarding: () => ( { status: 'completed' } ),
		commitBoarding: () => queued ++, boardingConfirmed: () => confirmed,
		rollbackBoarding: () => rolledBack ++, boardingRestored: () => restored } );
	return { ...result, subject, entity, counts: () => ( { queued, rolledBack } ),
		setConfirmed: ( value ) => { confirmed = value; }, setRestored: ( value ) => { restored = value; },
		options: { expectedRevision: 1, expectedVehicleRevision: 0, expectedSample: 1 } };

}

test( 'boarding reserves seats, is duplicate-safe and waits for later sample confirmation', () => {

	const { host, runtime, handle, entity, subject, options, counts } = passengerFixture();
	assert.equal( host.board( entity.handle, handle, options ).status, 'completed' );
	assert.equal( entity.state, 'boarding' ); assert.equal( subject.transport.state, 'boarding' );
	assert.equal( host.snapshot( host.record( handle ) ).seatsUsed, 1 );
	assert.equal( host.board( entity.handle, handle, options ).code, 'STALE_REVISION' );
	assert.equal( host.drive( null, handle, [ 20, 0 ], { expectedRevision: 1 } ).code, 'BOARDING_PENDING' );
	host.collect( {}, { step: 0 } ); assert.equal( entity.state, 'boarding' );
	runtime.step = 1; host.collect( {}, { step: 1 } ); assert.equal( entity.state, 'aboard' );
	assert.equal( counts().queued, 1 );

} );

test( 'moving, full, distant and stale boarding requests mutate nothing', () => {

	for ( const failure of [ 'moving', 'full', 'far', 'sample' ] ) {

		const { host, handle, backend, entity, options, counts } = passengerFixture();
		if ( failure === 'moving' ) backend.moving = true;
		if ( failure === 'full' ) host.record( handle ).capacity = 0;
		if ( failure === 'far' ) backend.position = [ 100, 0 ];
		const result = host.board( entity.handle, handle, { ...options, expectedSample: failure === 'sample' ? 2 : 1 } );
		assert.equal( result.status, 'rejected' ); assert.equal( entity.state, 'active' ); assert.equal( counts().queued, 0 );

	}

} );

test( 'water-cannon vehicles cannot board protected passengers', () => {

	const { host, handle, entity, options, counts } = passengerFixture( 'water-cannon' );
	assert.equal( host.board( entity.handle, handle, options ).code, 'VEHICLE_TYPE' );
	assert.equal( entity.state, 'active' ); assert.equal( counts().queued, 0 );

} );

test( 'a failed conditional boarding rolls back before releasing reservation', () => {

	const { host, runtime, handle, entity, subject, options, counts, setConfirmed } = passengerFixture();
	host.board( entity.handle, handle, options ); setConfirmed( false );
	runtime.step = 1; host.collect( {}, { step: 1 } );
	assert.equal( subject.transport.state, 'rolling-back' ); assert.equal( counts().rolledBack, 1 );
	assert.equal( host.snapshot( host.record( handle ) ).seatsUsed, 1 );
	runtime.step = 2; host.collect( {}, { step: 2 } );
	assert.equal( entity.state, 'active' ); assert.equal( subject.transport, null );
	assert.equal( host.snapshot( host.record( handle ) ).seatsUsed, 0 );

} );

test( 'extraction requires confirmed boarding and stopped arrival near the declared exit', () => {

	const { host, runtime, handle, backend, entity, options } = passengerFixture();
	host.board( entity.handle, handle, options );
	assert.equal( host.exit( entity.handle, { expectedRevision: entity.revision, at: [ 20, 0 ] } ).code, 'NOT_ABOARD' );
	runtime.step = 1; host.collect( {}, { step: 1 } );
	assert.equal( host.exit( entity.handle, { expectedRevision: entity.revision, at: [ 20, 0 ] } ).code, 'EXIT_NOT_REACHED' );
	backend.position = [ 20, 0 ];
	assert.equal( host.exit( entity.handle, { expectedRevision: entity.revision, at: [ 20, 0 ] } ).status, 'completed' );
	assert.equal( entity.state, 'exited' ); assert.equal( host.snapshot( host.record( handle ) ).seatsUsed, 0 );
	assert.equal( host.exit( entity.handle, { expectedRevision: entity.revision, at: [ 20, 0 ] } ).code, 'NOT_ABOARD' );

} );

test( 'removing an occupied vehicle restores passengers before releasing the ride', () => {

	const { host, runtime, handle, entity, subject, options } = passengerFixture();
	host.board( entity.handle, handle, options ); runtime.step = 1; host.collect( {}, { step: 1 } );
	host.releaseActor( handle );
	assert.equal( host.vehicles.size, 0 ); assert.equal( subject.transport.state, 'rolling-back' );
	runtime.step = 2; host.collect( {}, { step: 2 } );
	assert.equal( subject.transport, null ); assert.equal( host.rides.size, 0 ); assert.equal( entity.state, 'active' );

} );

test( 'extraction cannot win just because a protected identity was marked exited elsewhere', async () => {

	const runtime = new ScenarioRuntime( defineScenario( { id: 'exit-proof', title: 'Exit', subtitle: 'Proof', brief: 'Proof.',
		locations: { start: [ 0, 0 ], exit: [ 100, 0 ] }, setup( ctx ) {

			ctx.spawn.squad( { id: 'escort', at: 'start' } ); ctx.spawn.crowd( { id: 'hostile', at: 'start' } );
			ctx.protected.create( { id: 'subject', kind: 'person', carrier: 'escort', protection: { friendly: [ 'escort' ], hostile: [ 'hostile' ] } } );

		}, objectives: [ extract( { id: 'exit', protected: 'subject', at: 'exit', radius: 5, seconds: 60 } ) ] } ), {
		spawn: async () => ( {} ), readActor: () => ( { alive: 1, center: [ 0, 0 ] } ), release() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const entity = runtime.identity.entities.get( 'subject' );
	entity.state = 'exited'; entity.position = [ 0, 0 ]; runtime.update( 1 );
	assert.equal( runtime.result, null );
	entity.position = [ 100, 0 ]; runtime.update( 1 );
	assert.equal( runtime.result.win, true ); assert.equal( runtime.time, 2 ); runtime.dispose();

} );

test( 'an injured subject plus a separate carrier reserves two seats', () => {

	const { host, runtime, handle, entity, subject, options, counts } = passengerFixture();
	const helper = { handle: { id: 'helper' }, backend: {}, actor: subject.actor, sample: { status: 'active' } };
	entity.carrier = helper.handle; entity.state = 'carried'; subject.sample.status = 'injured';
	runtime.identity.personRecord = ( person ) => person === subject.handle ? subject : helper;
	assert.equal( host.board( entity.handle, handle, options ).code, 'VEHICLE_FULL' );
	assert.equal( counts().queued, 0 );
	host.record( handle ).capacity = 2;
	assert.equal( host.board( entity.handle, handle, options ).status, 'completed' );
	assert.equal( host.snapshot( host.record( handle ) ).seatsUsed, 2 );

} );

test( 'passenger actor removal releases seats and excludes deleted people from restoration', () => {

	const { host, runtime, handle, entity, subject, options } = passengerFixture();
	const discarded = [], removed = [];
	runtime.adapter.rollbackBoarding = ( plan, people ) => discarded.push( ...people );
	runtime.identity.remove = ( value ) => removed.push( value );
	host.board( entity.handle, handle, options );
	host.releaseActor( subject.actor );
	assert.deepEqual( discarded, [ subject.backend ] ); assert.deepEqual( removed, [ entity ] );
	assert.equal( subject.transport, null ); assert.equal( host.rides.size, 0 );
	assert.equal( host.snapshot( host.record( handle ) ).seatsUsed, 0 );

} );