import assert from 'node:assert/strict';
import test from 'node:test';
import { defineScenario, place, survive } from '../src/game/scenarios/definition.js';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.js';

function scenario( overrides = {} ) {

	return defineScenario( { id: 'hello-scenario', title: 'Hello', subtitle: 'A scenario', brief: 'Hold.',
		locations: { square: place( 'Square' ) }, objectives: [ survive( { id: 'hold', seconds: 60 } ) ], ...overrides } );

}

function fixture( definition = scenario(), overrides = {} ) {

	const released = [], finished = [], failures = [], spawns = [];
	const adapter = {
		place: () => [ 10, 20 ], focus() {},
		spawn: async ( kind, options ) => { const backend = { kind, options }; spawns.push( backend ); return backend; },
		readActor: () => ( { alive: 10, center: [ 10, 20 ] } ),
		release: ( backend ) => released.push( backend ), ...overrides,
	};
	const runtime = new ScenarioRuntime( definition, adapter, { onFinish: ( result ) => finished.push( result ), onFailure: ( error ) => failures.push( error ) } );
	return { runtime, released, finished, failures, spawns };

}

test( 'definitions detach configuration and reject unsupported or malformed values', () => {

	const goals = [ 'Hold' ], location = [ 1, 2 ];
	const definition = scenario( { goals, locations: { square: location } } );
	goals.push( 'Changed' ); location[ 0 ] = 99;
	assert.deepEqual( definition.goals, [ 'Hold' ] );
	assert.deepEqual( definition.locations.square, [ 1, 2 ] );
	assert.throws( () => scenario( { goals: new Array( 1 ) } ), /dense array/ );
	assert.throws( () => scenario( { side: 'protest' } ), /police/ );
	assert.throws( () => scenario( { behaviors: [] } ), /unsupported field/ );
	assert.throws( () => survive( { id: 'hold', seconds: NaN } ), /finite/ );
	assert.throws( () => scenario( { locations: { square: [ Infinity, 0 ] } } ), /finite/ );

} );

test( 'all locations preflight before setup can spawn', async () => {

	const { runtime, spawns } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.crowd( { id: 'crowd', at: 'square' } ) } ), { place: () => undefined } );
	await assert.rejects( runtime.setup(), /scenario.locations.square/ );
	assert.equal( runtime.state, 'failed' );
	assert.equal( spawns.length, 0 );

} );

test( 'setup awaits owned work and actors expose immutable observations, not backend state', async () => {

	let operation, context;
	const { runtime } = fixture( scenario( { setup: ( ctx ) => { context = ctx; operation = ctx.spawn.crowd( { id: 'crowd', at: 'square', people: 300 } ); } } ) );
	await runtime.setup();
	const outcome = await operation.settled;
	assert.equal( outcome.status, 'completed' );
	assert.equal( operation.state, 'completed' );
	assert.equal( context.actors.get( outcome.value ), null );
	const sample = {};
	runtime.observe( sample );
	const actor = context.actors.get( outcome.value );
	assert.equal( actor.alive, 10 );
	assert.equal( 'backend' in actor, false );
	assert.throws( () => { actor.center[ 0 ] = 99; }, TypeError );
	runtime.observe( sample );
	assert.equal( runtime.observation.sequence, 1 );
	assert.throws( () => context.actors.get( { ...outcome.value } ), /foreign/ );

} );

test( 'clock starts after briefing and only advances while running; result seals once', async () => {

	const { runtime, finished } = fixture();
	await runtime.setup();
	runtime.update( 100 );
	assert.equal( runtime.time, 0 );
	assert.throws( () => runtime.start(), /initial observation/ );
	runtime.observe( {} ); runtime.start();
	runtime.update( 20 ); runtime.pause( true ); runtime.update( 100 );
	assert.equal( runtime.time, 20 );
	runtime.pause( false ); runtime.update( 40 ); runtime.update( 100 );
	assert.equal( runtime.time, 60 );
	assert.equal( finished.length, 1 );
	assert.equal( runtime.objectives()[ 0 ].state, 'done' );
	assert.throws( () => { runtime.result.lines[ 0 ][ 0 ] = 'changed'; }, TypeError );
	assert.throws( () => runtime.context.spawn.squad( { id: 'late', at: 'square' } ), /cannot mutate/ );

} );

test( 'setup failure releases applied actors and reports failure rather than a scored defeat', async () => {

	const { runtime, released, finished, failures } = fixture( scenario( { setup: async ( ctx ) => {

		await ctx.spawn.squad( { id: 'squad', at: 'square' } ).settled;
		throw new Error( 'setup broke' );

	} } ) );
	await assert.rejects( runtime.setup(), /setup broke/ );
	assert.equal( released.length, 1 );
	assert.equal( failures.length, 1 );
	assert.equal( finished.length, 0 );
	runtime.dispose(); runtime.dispose();
	assert.equal( released.length, 1 );

} );

test( 'unawaited spawn failure still fails setup', async () => {

	const { runtime } = fixture( scenario( { setup: ( ctx ) => { ctx.spawn.crowd( { id: 'crowd', at: 'square' } ); } } ),
		{ spawn: async () => { throw new Error( 'capacity exhausted' ); } } );
	await assert.rejects( runtime.setup(), /capacity exhausted/ );
	assert.equal( runtime.result, null );

} );

test( 'dispose cancels owned work and releases late allocations without resurrecting actors', async () => {

	let resolveSpawn, operation;
	const { runtime, released } = fixture( scenario( { setup: ( ctx ) => { operation = ctx.spawn.crowd( { id: 'crowd', at: 'square' } ); } } ),
		{ spawn: () => new Promise( ( resolve ) => { resolveSpawn = resolve; } ) } );
	const setup = runtime.setup();
	await Promise.resolve(); await Promise.resolve();
	runtime.dispose();
	assert.equal( ( await operation.settled ).status, 'cancelled' );
	resolveSpawn( { allocation: 1 } );
	await assert.rejects( setup, /interrupted/ );
	await Promise.resolve();
	assert.equal( runtime.state, 'disposed' );
	assert.equal( runtime.actors.size, 0 );
	assert.equal( released.length, 1 );

} );

test( 'instances do not share clocks, actor identities or disposal', async () => {

	const definition = scenario( { setup: ( ctx ) => ctx.spawn.squad( { id: 'squad', at: 'square' } ) } );
	const first = fixture( definition ), second = fixture( definition );
	await Promise.all( [ first.runtime.setup(), second.runtime.setup() ] );
	first.runtime.observe( {} ); second.runtime.observe( {} );
	first.runtime.start(); first.runtime.update( 15 ); first.runtime.dispose();
	assert.equal( second.runtime.state, 'briefing' );
	assert.equal( second.runtime.time, 0 );
	assert.equal( second.released.length, 0 );
	second.runtime.dispose();

} );

test( 'cancel before adapter work starts does not allocate; completed work cannot be cancelled', async () => {

	let cancelled, completed;
	const { runtime, spawns } = fixture( scenario( { setup: ( ctx ) => {

		cancelled = ctx.spawn.crowd( { id: 'cancelled', at: 'square' } );
		assert.equal( cancelled.cancel().status, 'requested' );
		completed = ctx.spawn.squad( { id: 'completed', at: 'square' } );

	} } ) );
	await runtime.setup();
	assert.equal( ( await cancelled.settled ).status, 'cancelled' );
	assert.equal( ( await completed.settled ).status, 'completed' );
	assert.equal( completed.cancel().status, 'already-settled' );
	assert.equal( spawns.length, 1 );
	runtime.dispose();

} );

test( 'missing adapter allocations fail rather than publishing false actor handles', async () => {

	const { runtime } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.crowd( { id: 'crowd', at: 'square' } ) } ), { spawn: async () => undefined } );
	await assert.rejects( runtime.setup(), /no actor allocation/ );
	assert.equal( runtime.actors.size, 0 );

} );

test( 'fixed-step accumulation reports the complete minute, not 0:59', async () => {

	const { runtime } = fixture();
	await runtime.setup(); runtime.observe( {} ); runtime.start();
	for ( let step = 0; step < 3600; step ++ ) runtime.update( 1 / 60 );
	assert.equal( runtime.time, 60 );
	assert.deepEqual( runtime.result.lines[ 0 ], [ 'Time held', '1:00' ] );

} );