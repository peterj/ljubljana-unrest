import assert from 'node:assert/strict';
import test from 'node:test';
import { defineBehavior, defineScenario, place, survive } from '../src/game/scenarios/definition.js';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.js';
import { followRoute } from '../src/game/scenarios/route.js';

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
	assert.equal( definition.menu, true );
	goals.push( 'Changed' ); location[ 0 ] = 99;
	assert.deepEqual( definition.goals, [ 'Hold' ] );
	assert.deepEqual( definition.locations.square, [ 1, 2 ] );
	assert.throws( () => scenario( { goals: new Array( 1 ) } ), /dense array/ );
	assert.throws( () => scenario( { side: 'protest' } ), /police/ );
	assert.throws( () => scenario( { unsupported: [] } ), /unsupported field/ );
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

test( 'behavior attachments validate and detach per-instance configuration', () => {

	const behavior = defineBehavior( { id: 'custom', create: () => ( {} ), validate: ( options ) => {

		assert.equal( typeof options.actor, 'string' );

	} } );
	const options = { id: 'first', actor: 'escort', route: [ [ 1, 2 ] ] };
	const attachment = behavior( options );
	options.route[ 0 ][ 0 ] = 99;
	assert.deepEqual( attachment.options.route, [ [ 1, 2 ] ] );
	assert.throws( () => { attachment.options.route.push( [ 3, 4 ] ); }, TypeError );
	assert.throws( () => behavior( { id: 'invalid', actor: 'escort', route: new Array( 1 ) } ), /dense/ );
	assert.throws( () => behavior( { id: 'invalid', actor: 'escort', callback: () => {} } ), /configuration/ );
	assert.throws( () => scenario( { behaviors: [ attachment, attachment ] } ), /unique/ );
	assert.throws( () => defineBehavior( { id: 'invalid', create: {} } ), /fresh hooks/ );
	assert.equal( scenario( { behaviors: [ attachment ] } ).behaviors[ 0 ].type, 'custom' );

} );

test( 'behavior instances have private state, owned timers, and exactly-once stop', async () => {

	const events = [], contexts = [];
	const behavior = defineBehavior( { id: 'counter', create: ( options ) => {

		let count = 0;
		return {
			start( ctx ) { contexts.push( ctx ); ctx.timeline.after( 2, () => events.push( `${options.id}:timer` ) ); },
			update() { events.push( `${options.id}:${++ count}` ); },
			stop( ctx, reason ) { events.push( `${options.id}:stop:${reason}` ); assert.equal( ctx.signal.aborted, true ); },
		};

	} } );
	const { runtime } = fixture( scenario( { behaviors: [ behavior( { id: 'first' } ), behavior( { id: 'second' } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	runtime.update( 1 ); runtime.pause( true ); runtime.update( 100 );
	assert.deepEqual( events, [ 'first:1', 'second:1' ] );
	contexts[ 0 ].complete();
	assert.throws( () => contexts[ 0 ].timeline.after( 0, () => {} ), /cannot mutate/ );
	runtime.pause( false ); runtime.update( 1 ); runtime.dispose(); runtime.dispose();
	assert.deepEqual( events, [ 'first:1', 'second:1', 'first:stop:completed', 'second:timer', 'second:2', 'second:stop:disposed' ] );

} );

test( 'fresh observations report sampled elapsed time, not receipt or frame duration', async () => {

	const samples = [];
	const observer = defineBehavior( { id: 'observer', create: () => ( { observe( ctx, sample ) { samples.push( sample ); } } ) } );
	const { runtime } = fixture( scenario( { behaviors: [ observer( { id: 'observer' } ) ] } ) );
	await runtime.setup(); runtime.observe( {}, { sampledAt: 0, step: 0 } ); await runtime.start();
	runtime.update( 1 ); runtime.update( 1 );
	const sample = {};
	runtime.observe( sample, { sampledAt: 1, step: 1 } );
	runtime.observe( sample, { sampledAt: 1, step: 1 } );
	runtime.observe( {}, { sampledAt: 0.5, step: 0 } );
	assert.equal( samples.length, 2 );
	assert.equal( samples[ 1 ].sampledAt, 1 );
	assert.equal( samples[ 1 ].receivedAt, 2 );
	assert.equal( samples[ 1 ].elapsed, 1 );
	runtime.pause( true ); runtime.observe( {}, { sampledAt: 2, step: 2 } );
	assert.equal( samples[ 2 ].elapsed, 1 );
	runtime.observe( {}, { sampledAt: 2, step: 2 } );
	assert.equal( samples[ 3 ].elapsed, 0 );
	runtime.dispose();

} );

test( 'behavior hook failure is attributed and stops peers without scoring a defeat', async () => {

	const stops = [];
	const broken = defineBehavior( { id: 'broken', create: () => ( {
		update() { throw new Error( 'broken rule' ); }, stop( ctx, reason ) { stops.push( reason ); },
	} ) } );
	const { runtime, failures } = fixture( scenario( { behaviors: [ broken( { id: 'rule' } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( 1 );
	assert.equal( runtime.state, 'failed' );
	assert.match( failures[ 0 ].message, /behavior.rule.update: broken rule/ );
	assert.deepEqual( stops, [ 'failed' ] );
	assert.equal( runtime.result, null );

} );

test( 'delayed autonomous movement cannot overwrite a newer player order', async () => {

	const pending = [], applied = [], freed = [], events = [];
	let context, autonomous;
	const follower = defineBehavior( { id: 'follower', create: () => ( {
		start( ctx ) { context = ctx; autonomous = ctx.movement.move( 'escort', [ 50, 0 ] ); },
		onEvent( ctx, event ) { events.push( event ); },
	} ) } );
	const { runtime } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ follower( { id: 'follower' } ) ] } ), {
		prepareMove: ( backend, request ) => new Promise( ( resolve ) => pending.push( { request, resolve } ) ),
		applyMove: ( backend, prepared, request, valid ) => { if ( ! valid() ) return false; applied.push( request.at ); return true; },
		releaseMove: ( prepared ) => freed.push( prepared ), stopMove() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const player = runtime.playerMove( 'escort', [ 10, 20 ] );
	await Promise.resolve();
	assert.equal( ( await autonomous.settled ).status, 'cancelled' );
	assert.equal( ( await context.movement.move( 'escort', [ 80, 0 ] ).settled ).code, 'PLAYER_CONTROL' );
	pending[ 1 ].resolve( { id: 'player-route' } );
	assert.equal( ( await player.settled ).status, 'completed' );
	pending[ 0 ].resolve( { id: 'stale-route' } );
	await Promise.resolve(); await Promise.resolve();
	assert.deepEqual( applied, [ [ 10, 20 ] ] );
	assert.equal( freed.length, 2 );
	assert.equal( events.filter( ( event ) => event.type === 'movement.arrived' ).length, 0 );
	runtime.update( 1 ); runtime.observe( {}, { sampledAt: 1, step: 1 } );
	assert.equal( events.filter( ( event ) => event.type === 'movement.arrived' ).length, 1 );
	assert.equal( events.find( ( event ) => event.type === 'movement.arrived' ).source, 'player' );
	runtime.dispose();

} );

test( 'stopping a behavior cancels prepared navigation and releases a late route', async () => {

	let context, resolveRoute, operation, released = 0, applied = 0;
	const behavior = defineBehavior( { id: 'mover', create: () => ( { start( ctx ) {

		context = ctx; operation = ctx.movement.move( 'escort', [ 50, 0 ] );

	} } ) } );
	const { runtime } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ behavior( { id: 'mover' } ) ] } ), {
		prepareMove: () => new Promise( ( resolve ) => { resolveRoute = resolve; } ),
		applyMove: () => { applied ++; }, releaseMove: () => released ++, stopMove() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	context.complete();
	assert.equal( ( await operation.settled ).status, 'cancelled' );
	resolveRoute( {} ); await Promise.resolve(); await Promise.resolve();
	assert.equal( applied, 0 ); assert.equal( released, 1 );
	assert.equal( runtime.movement.orders.size, 0 );
	runtime.dispose();

} );

test( 'async startup waits before play and disposal interrupts a pending start', async () => {

	let resolveStart, context;
	const behavior = defineBehavior( { id: 'async-start', create: () => ( {
		start( ctx ) { context = ctx; return new Promise( ( resolve ) => { resolveStart = resolve; } ); },
	} ) } );
	const { runtime } = fixture( scenario( { behaviors: [ behavior( { id: 'starting' } ) ] } ) );
	await runtime.setup(); runtime.observe( {} );
	const started = runtime.start(); runtime.update( 10 );
	assert.equal( runtime.state, 'starting' ); assert.equal( runtime.time, 0 );
	runtime.dispose();
	await assert.rejects( started, /behavior.starting.start.*interrupted/ );
	resolveStart(); await Promise.resolve();
	assert.equal( context.signal.aborted, true );
	assert.throws( () => context.presentation.focus( 'square' ), /cannot mutate/ );
	assert.equal( runtime.state, 'disposed' );

} );

test( 'stopping during the apply phase holds the actor and prevents late arrival', async () => {

	let context, operation, resolveApply, stopped = 0;
	const behavior = defineBehavior( { id: 'mover', create: () => ( { start( ctx ) {

		context = ctx; operation = ctx.movement.move( 'escort', [ 50, 0 ] );

	} } ) } );
	const { runtime } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ behavior( { id: 'mover' } ) ] } ), {
		prepareMove: async () => ( {} ),
		applyMove: () => new Promise( ( resolve ) => { resolveApply = resolve; } ),
		releaseMove() {}, stopMove() { stopped ++; },
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	assert.equal( operation.state, 'applied' );
	context.complete(); resolveApply( true );
	assert.equal( ( await operation.settled ).status, 'cancelled' );
	assert.equal( stopped, 1 ); assert.equal( runtime.movement.orders.size, 0 );
	runtime.dispose();

} );

test( 'route following resumes at a forward waypoint after a player detour', async () => {

	let center = [ 0, 0 ];
	const applied = [];
	const { runtime } = fixture( scenario( {
		setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ followRoute( { id: 'route', actor: 'escort', waypoints: [ [ 10, 0 ], [ 20, 0 ], [ 30, 0 ] ], radius: 2 } ) ],
	} ), {
		readActor: () => ( { alive: 24, center } ), prepareMove: async () => ( {} ),
		applyMove: ( backend, prepared, request ) => { applied.push( request.at ); }, releaseMove() {}, stopMove() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	await runtime.movement.orders.get( 'escort' ).operation.settled;
	center = [ 10, 0 ]; runtime.update( 1 ); runtime.observe( {} );
	await runtime.movement.orders.get( 'escort' ).operation.settled;
	assert.deepEqual( applied, [ [ 10, 0 ], [ 20, 0 ] ] );
	const detour = runtime.playerMove( 'escort', [ 29, 4 ] );
	await detour.settled;
	center = [ 29, 4 ]; runtime.update( 1 ); runtime.observe( {} );
	await runtime.movement.orders.get( 'escort' ).operation.settled;
	assert.deepEqual( applied, [ [ 10, 0 ], [ 20, 0 ], [ 29, 4 ], [ 30, 0 ] ] );
	center = [ 30, 0 ]; runtime.update( 1 ); runtime.observe( {} );
	assert.equal( runtime.behaviors.instances.get( 'route' ).state, 'completed' );
	assert.equal( runtime.result, null );
	runtime.dispose();

} );

test( 'completion from a timer cancels other due timers without changing completed status', async () => {

	let first, second, calls = 0;
	const behavior = defineBehavior( { id: 'timers', create: () => ( { start( ctx ) {

		first = ctx.timeline.after( 1, () => { calls ++; ctx.complete(); } );
		second = ctx.timeline.after( 1, () => { calls ++; } );

	} } ) } );
	const { runtime } = fixture( scenario( { behaviors: [ behavior( { id: 'timers' } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( 1 );
	assert.equal( calls, 1 ); assert.equal( first.state, 'completed' ); assert.equal( second.state, 'cancelled' );
	runtime.dispose();

} );

test( 'asynchronous behavior creation fails setup instead of creating an empty behavior', async () => {

	const behavior = defineBehavior( { id: 'invalid', create: async () => ( {} ) } );
	const { runtime } = fixture( scenario( { behaviors: [ behavior( { id: 'invalid' } ) ] } ) );
	await assert.rejects( runtime.setup(), /must synchronously return fresh hooks/ );
	assert.equal( runtime.state, 'failed' );

} );

test( 'relative routes resolve coordinates from a declared place before play begins', async () => {

	const applied = [];
	const { runtime } = fixture( scenario( {
		setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ followRoute( { id: 'route', actor: 'escort', relativeTo: 'square', waypoints: [ [ 30, 0 ] ] } ) ],
	} ), {
		prepareMove: async () => ( {} ), applyMove: ( backend, prepared, request ) => applied.push( request.at ),
		releaseMove() {}, stopMove() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	assert.deepEqual( applied, [ [ 40, 20 ] ] );
	assert.equal( runtime.state, 'running' ); assert.equal( runtime.time, 0 );
	runtime.dispose();

} );

test( 'crowd spawning validates and detaches explicit wave attributes without changing defaults', async () => {

	const agitation = [ 0.5, 0.8 ];
	const { runtime, spawns } = fixture( scenario( { setup( ctx ) {

		ctx.spawn.crowd( { id: 'wave', at: 'square', goal: [ 40, 20 ], people: 200, label: 'Arrivals',
			groupSize: 100, agitation, morale: 0.8, bikes: 0.25 } );
		agitation[ 0 ] = 0;
		assert.throws( () => ctx.spawn.crowd( { id: 'invalid', at: 'square', agitation: [ 0.9, 0.2 ] } ), /ordered/ );
		assert.throws( () => ctx.spawn.crowd( { id: 'invalid', at: 'square', mode: 'march' } ), /requires a destination/ );

	} } ) );
	await runtime.setup();
	assert.equal( spawns[ 0 ].options.mode, 'march' ); assert.equal( spawns[ 0 ].options.groupSize, 100 );
	assert.deepEqual( spawns[ 0 ].options.agitation, [ 0.5, 0.8 ] ); assert.equal( spawns[ 0 ].options.label, 'Arrivals' );
	runtime.dispose();

} );

test( 'vehicle spawning exposes only transport and water-cannon capabilities', async () => {

	let handles;
	const { runtime, spawns } = fixture( scenario( { setup( ctx ) {

		ctx.spawn.vehicle( { id: 'truck', at: 'square', type: 'water-cannon' } );
		assert.throws( () => ctx.spawn.vehicle( { id: 'invalid', at: 'square', type: 'combat' } ), /transport, water-cannon/ );
		handles = ctx.actors;

	} } ) );
	await runtime.setup();
	assert.equal( spawns[ 0 ].options.type, 'water-cannon' );
	assert.equal( runtime.actors.get( 'truck' ).type, 'water-cannon' );
	assert.equal( handles.resolve( 'truck' ).kind, 'vehicle' );
	runtime.dispose();

} );

test( 'bystander spawns validate and detach wander destinations as a crowd actor', async () => {

	let operation, actors;
	const destinations = [ 'square', [ 30, 40 ] ];
	const { runtime, spawns } = fixture( scenario( { setup( ctx ) {

		operation = ctx.spawn.bystanders( { id: 'onlookers', people: 2200, destinations } );
		destinations[ 1 ][ 0 ] = 999;
		assert.throws( () => ctx.spawn.bystanders( { id: 'invalid', people: 12, destinations: [] } ), /non-empty/ );
		actors = ctx.actors;

	} } ) );
	await runtime.setup();
	const outcome = await operation.settled;
	assert.equal( outcome.status, 'completed' ); assert.equal( outcome.value.kind, 'crowd' );
	assert.equal( spawns[ 0 ].kind, 'bystanders' ); assert.equal( spawns[ 0 ].options.people, 2200 );
	assert.deepEqual( spawns[ 0 ].options.destinations, [ [ 10, 20 ], [ 30, 40 ] ] );
	assert.equal( actors.resolve( 'onlookers' ), outcome.value );
	runtime.dispose();

} );

test( 'custom scoring receives frozen semantic metrics and validates score rows', async () => {

	let seen, context;
	const scoring = ( { win, metrics } ) => {
		seen = { win, metrics };
		const second = win && metrics.opinion >= 45, third = win && metrics.counters.injuriesByPolice <= 25;
		return { stars: Number( win ) + Number( second ) + Number( third ), lines: [ [ 'Public opinion', Math.round( metrics.opinion ) ],
			[ 'Injuries caused by police', metrics.counters.injuriesByPolice ], [ 'Arrests', metrics.counters.arrests ], [ 'Tear gas used', metrics.counters.gasUsed ] ] };
	};
	const { runtime, finished } = fixture( scenario( { score: scoring, setup( ctx ) { context = ctx; },
		objectives: [ survive( { id: 'hold', seconds: 1 } ) ] } ), { readMetrics: () => ( { opinion: 44.8,
		counters: { injuriesByPolice: 26, arrests: 4, gasUsed: 1 } } ) } );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 1 );
	assert.equal( context.metrics.opinion, 44.8 ); assert.equal( context.metrics.counters.arrests, 4 );
	assert.equal( Object.isFrozen( context.metrics.counters ), true );
	assert.equal( seen.win, true ); assert.equal( Object.isFrozen( seen.metrics.counters ), true );
	assert.equal( finished[ 0 ].stars, 1 ); assert.deepEqual( finished[ 0 ].lines, [ [ 'Public opinion', 45 ],
		[ 'Injuries caused by police', 26 ], [ 'Arrests', 4 ], [ 'Tear gas used', 1 ] ] );
	assert.throws( () => scenario( { score: 42 } ), /synchronous scoring/ );

} );

test( 'invalid score output fails without publishing or saving a malformed result', async () => {

	const { runtime, finished, failures } = fixture( scenario( { score: () => ( { stars: 4, lines: [] } ),
		objectives: [ survive( { id: 'hold', seconds: 1 } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 1 );
	assert.equal( runtime.state, 'failed' ); assert.equal( finished.length, 0 );
	assert.match( failures[ 0 ].message, /stars/ );

} );

test( 'a scoring callback exception fails the run before publishing a result', async () => {

	const { runtime, finished, failures } = fixture( scenario( { score: () => { throw new Error( 'score unavailable' ); },
		objectives: [ survive( { id: 'hold', seconds: 1 } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 1 );
	assert.equal( runtime.state, 'failed' ); assert.equal( finished.length, 0 );
	assert.match( failures[ 0 ].message, /scenario\.score: score unavailable/ );

} );