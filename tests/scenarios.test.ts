import assert from 'node:assert/strict';
import test from 'node:test';
import defenseScenario from '../examples/defense-scenario.ts';
import governmentScenario from '../examples/government-scenario.ts';
import clashScenario from '../examples/clash-scenario.ts';
import trainingScenario from '../examples/training-scenario.ts';
import { ClashMission } from '../src/game/missions/clash.ts';
import { STAT } from '../src/sim/crowd.ts';
import { advanceClash } from '../src/game/scenarios/clash.ts';
import { ScenarioEngine } from '../src/game/scenarios/engine.ts';
import { defineBehavior, defineOutcome, defineScenario, escortConvoy, place, preventClash, survive } from '../src/game/scenarios/definition.ts';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.ts';
import { followRoute } from '../src/game/scenarios/route.ts';

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

function assemblyReactionHooks() {

	let reactions;
	const defineBehavior = ( definition ) => {
		if ( definition.id === 'assembly-force-and-injury-reactions' ) reactions = definition.create();
		return ( options ) => ( { kind: 'behavior', id: options.id } );
	};
	( defenseScenario as any )( { defineScenario: ( options ) => options, defineBehavior, defineOutcome: ( rule ) => rule,
		holdBuilding: ( options ) => options, landmark: ( name ) => name, place: ( name ) => name,
		policeCommands: () => [], target: ( name ) => name } );
	return reactions;

}

function governmentRouteHooks() {

	let routes;
	const defineBehavior = ( definition ) => {
		if ( definition.id === 'government-route-columns' ) routes = definition.create();
		return ( options ) => ( { kind: 'behavior', id: options.id } );
	};
	( governmentScenario as any )( { defineScenario: ( options ) => options, defineBehavior, defineOutcome: ( rule ) => rule,
		holdBuilding: ( options ) => options, landmark: ( name ) => name, place: ( name ) => name,
		policeCommands: () => [], target: ( name ) => name } );
	return routes;

}

function clashCandidate() {

	let director, definition;
	const defineBehavior = ( value ) => {
		if ( value.id === 'clash-director' ) director = value.create();
		return ( options ) => ( { kind: 'behavior', id: options.id } );
	};
	definition = ( clashScenario as any )( { defineBehavior, defineScenario: ( options ) => options, landmark: ( name ) => name,
		place: ( name ) => name, policeCommands: () => [], preventClash: ( options ) => ( { ...options, kind: 'prevent-clash' } ) } );
	return { definition, director };

}

function trainingCurriculum() {

	let curriculum;
	const definition = ( trainingScenario as any )( { defineBehavior: ( value ) => {
		if ( value.id === 'training-curriculum' ) curriculum = value.create();
		return ( options ) => ( { kind: 'behavior', id: options.id } );
	}, defineOutcome: ( rule ) => rule, defineScenario: ( options ) => options, landmark: ( name ) => name,
		place: ( name ) => name, policeCommands: () => [ 'arrest', 'charge', 'snatch', 'kettle', 'shield-push', 'crew', 'gas', 'reinforce', 'water' ]
			.map( ( id ) => ( { id } ) ), survive: ( options ) => ( { ...options, kind: 'survive' } ), target: ( name ) => name } );
	return { definition, curriculum };

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
	assert.throws( () => scenario( { seed: - 1 } ), /unsigned 32-bit/ );
	assert.throws( () => scenario( { locations: { square: [ Infinity, 0 ] } } ), /finite/ );
	const charge = { kind: 'police-command', id: 'charge', resource: null };
	assert.throws( () => scenario( { commands: [ charge ], initiallyLockedCommands: [ 'gas' ] } ), /declared command IDs/ );
	assert.throws( () => scenario( { commands: [ charge ], initiallyLockedCommands: [ 'charge', 'charge' ] } ), /IDs must be unique/ );

} );

test( 'per-step clash pressure matches the unchanged native mission formula', () => {

	const native = { march: [], t: 0, stats: new Uint32Array( 48 ), clash: 0, duration: 720, flags: {},
		world: { groupsOf: () => [], intel: null }, event() {}, end() {} };
	let pressure = 0;
	for ( const [ contacts, dt ] of [ [ 1, 0.25 ], [ 600, 0.25 ], [ 2400, 0.5 ], [ 0, 1 ], [ 0, 2 ], [ 4000, 0.25 ] ] ) {

		native.t += dt; native.stats[ STAT.CLASH ] = contacts;
		ClashMission.prototype.tick.call( native, dt );
		pressure = advanceClash( pressure, contacts, dt );
		assert.equal( pressure, native.clash );

	}

} );

test( 'clash objective exposes semantic GPU contacts and resolves brawl loss before timeout', async () => {

	let contacts = 2400;
	const objective = preventClash( { id: 'separate-crowds', seconds: 60 } );
	const { runtime } = fixture( scenario( { objectives: [ objective ] } ), { readMetrics: () => ( { opinion: 60, clashContacts: contacts, counters: {} } ) } );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 20 );
	assert.equal( runtime.metrics().clashContacts, 2400 );
	assert.equal( runtime.metrics().clashPressure, 0.56 );
	assert.equal( runtime.objectives()[ 1 ].text, '56%' );
	runtime.update( 20 );
	assert.equal( runtime.result.win, false );
	assert.equal( runtime.result.reason, objective.failureReason );
	runtime.dispose();

	contacts = 0;
	const win = fixture( scenario( { objectives: [ preventClash( { id: 'separate-crowds', seconds: 2 } ) ] } ),
		{ readMetrics: () => ( { opinion: 60, clashContacts: contacts, counters: {} } ) } ).runtime;
	await win.setup(); win.observe( {} ); win.start(); win.update( 2 );
	assert.equal( win.result.win, true ); win.dispose();

} );

test( 'escort convoy objective exposes immutable route state and wins on arrival or loses on integrity/blockage', async () => {

	let state = { distance: 10, progress: 0.1, speed: 5, integrity: 1, blockedFor: 0, blockers: 0, attackers: 0, moving: false, arrived: false }, released = 0, moving = false;
	const create = ( seconds = 900, maxBlocked = 75 ) => {
		let handle;
		const definition = scenario( { setup: ( ctx ) => { handle = ctx.convoys.create( { id: 'vip' } ); },
			objectives: [ escortConvoy( { id: 'escort', convoy: 'vip', seconds, maxBlocked } ) ] } );
		const runtime = new ScenarioRuntime( definition, { place: () => [ 10, 20 ], createConvoy: () => ( { length: 100 } ),
			readConvoy: () => ( { ...state, moving } ), convoyPoint: ( _convoy, distance ) => ( { x: distance, y: 0, heading: 0 } ),
			departConvoy() { moving = true; }, updateConvoy() {}, updateConvoyWalls() {}, releaseConvoy: () => { released ++; } } );
		return { runtime, get handle() { return handle; } };
	};
	const arrival = create(), runtime = arrival.runtime;
	await runtime.setup(); runtime.observe( {} ); runtime.start();
	assert.equal( runtime.context.convoys.get( arrival.handle ).progress, 0.1 );
	assert.deepEqual( runtime.context.convoys.at( arrival.handle, 15 ), { position: [ 15, 0 ], heading: 0 } );
	assert.throws( () => runtime.context.convoys.at( arrival.handle, 101 ), /within the route length/ );
	assert.deepEqual( runtime.context.convoys.depart( arrival.handle ), { status: 'completed' } );
	assert.deepEqual( runtime.context.convoys.depart( arrival.handle ), { status: 'rejected', code: 'ALREADY_MOVING' } );
	state = { ...state, arrived: true, progress: 1, distance: 100 };
	runtime.update( 1 );
	assert.equal( runtime.result.win, true ); runtime.dispose();

	state = { distance: 10, progress: 0.1, speed: 0, integrity: 0.5, blockedFor: 3, blockers: 12, attackers: 0, moving: true, arrived: false };
	const blocked = create( 900, 2 );
	await blocked.runtime.setup(); blocked.runtime.observe( {} ); blocked.runtime.start(); blocked.runtime.update( 1 );
	assert.equal( blocked.runtime.result.win, false ); assert.match( blocked.runtime.result.reason, /stuck too long/ );
	blocked.runtime.dispose();

	state = { distance: 10, progress: 0.1, speed: 0, integrity: 0, blockedFor: 0, blockers: 0, attackers: 30, moving: true, arrived: false };
	const destroyed = create();
	await destroyed.runtime.setup(); destroyed.runtime.observe( {} ); destroyed.runtime.start(); destroyed.runtime.update( 1 );
	assert.equal( destroyed.runtime.result.win, false ); assert.match( destroyed.runtime.result.reason, /overrun/ );
	destroyed.runtime.dispose(); assert.equal( released, 3 );

} );

test( 'private engine maps only the semantic per-step clash count from aggregate stats', () => {

	const stats = new Uint32Array( 48 ); stats[ STAT.CLASH ] = 7;
	const engine = new ScenarioEngine( { opinion: 60, escalation: 0, counters: { injByPolice: 0, injOther: 0, injPolice: 0,
		arrested: 0, arrestedSitters: 0, gone: 0, gas: 0 }, stats } );
	assert.equal( engine.readMetrics().clashContacts, 7 );

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

test( 'scenario-owned random streams are repeatable for a seed and remain bounded', () => {

	const draw = ( seed ) => {
		const runtime = new ScenarioRuntime( scenario( { seed } ), {} );
		return Array.from( { length: 8 }, () => runtime.context.random() );
	};
	const first = draw( 42 ), repeated = draw( 42 ), other = draw( 43 );
	assert.deepEqual( first, repeated ); assert.notDeepEqual( first, other );
	assert.ok( first.every( ( value ) => value >= 0 && value < 1 ) );

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
	assert.equal( ( await player.settled as any ).status, 'completed' );
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
	const destinations: any[] = [ 'square', [ 30, 40 ] ];
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

test( 'metric indicators apply warning and failure thresholds and phase policies receive semantic state', () => {

	let phaseContext;
	const definition = scenario( { indicators: [ { id: 'injury-limit', label: 'Police injuries', counter: 'injuriesByPolice', maximum: 25, warnAt: 15 } ],
		phase: ( context ) => { phaseContext = context; return `At ${context.time}`; } } );
	const metrics = ( injuriesByPolice ) => ( { opinion: 60, counters: { injuriesByPolice } } );
	const states = [ 15, 16, 25, 26 ].map( ( injuriesByPolice ) => fixture( definition, { readMetrics: () => metrics( injuriesByPolice ) } ).runtime.objectives().at( - 1 ).state );
	assert.deepEqual( states, [ 'ok', 'warn', 'warn', 'bad' ] );
	const runtime = fixture( definition ).runtime;
	assert.equal( runtime.phase(), 'At 0' );
	assert.equal( phaseContext.objective, 'survive' );
	assert.equal( phaseContext.metrics.opinion, 60 );
	assert.throws( () => scenario( { indicators: [ { id: 'bad-limit', label: 'Bad', counter: 'injuriesByPolice', maximum: 10, warnAt: 11 } ] } ), /between zero and maximum/ );
	assert.throws( () => scenario( { indicators: [ { id: 'unknown', label: 'Unknown', counter: 'privateValue', maximum: 10 } ] } ), /unknown semantic counter/ );

} );

test( 'invalid phase policy output fails the runtime instead of escaping into the HUD', () => {

	const { runtime, failures } = fixture( scenario( { phase: () => Promise.resolve( 'too late' ) } ) );
	assert.equal( runtime.phase(), '1:00 left' );
	assert.equal( runtime.state, 'failed' );
	assert.match( failures[ 0 ].message, /scenario\.phase: must return synchronous non-empty text/ );

} );

test( 'Assembly force reactions match the source thresholds and only follow applied commands', () => {

	const reactions = assemblyReactionHooks(), near = { handle: { id: 'near', kind: 'crowd', run: 1 }, center: [ 44, 0 ] };
	const outside = { handle: { id: 'outside', kind: 'crowd', run: 1 }, center: [ 46, 0 ] };
	const person = ( actor, id ) => ( { handle: { id, kind: 'person', run: 1 }, actor: actor.handle, faction: 'protester', status: 'active' } );
	const members = new Map( [ [ near.handle.id, Array.from( { length: 60 }, ( _, index ) => person( near, `near-${index}` ) ) ],
		[ outside.handle.id, [ person( outside, 'outside-1' ) ] ] ] );
	const changes = [], notices = [];
	const context = { time: 0, observation: { actors: [ near, outside ] }, people: { members: ( actor ) => members.get( actor.id ) ?? [] },
		crowd: { nudge: ( actor, options ) => { changes.push( [ actor.id, options ] ); return { status: 'completed', value: { actor, people: members.get( actor.id ).length + 15 } }; },
			setMode: ( actor, mode ) => changes.push( [ actor.id, mode ] ) },
		presentation: { notice: ( text ) => notices.push( text ) } };
	reactions.onEvent( context, { type: 'command.applied', command: 'charge', at: [ 0, 0 ] } );
	assert.deepEqual( changes, [ [ 'near', { agitation: 0.2 } ], [ 'near', 'riot' ] ] );
	assert.match( notices[ 0 ], /Baton charge: ~75 people/ );
	changes.length = 0;
	reactions.onEvent( context, { type: 'command.rejected', command: 'charge', at: [ 0, 0 ] } );
	assert.deepEqual( changes, [] );
	for ( const [ command, radius, agitation ] of [ [ 'kettle', 50, 0.25 ], [ 'gas', 60, 0.25 ], [ 'water', 50, 0.2 ],
		[ 'arrest', 35, 0.12 ], [ 'snatch', 35, 0.12 ], [ 'shield-push', 40, 0.15 ] ] as [ string, number, number ][] ) {
		near.center = [ radius - 0.1, 0 ]; outside.center = [ radius + 0.1, 0 ]; context.time ++;
		changes.length = 0;
		reactions.onEvent( context, { type: 'command.applied', command, at: [ 0, 0 ] } );
		const expected = [ [ 'near', { agitation } ] ];
		if ( agitation >= 0.2 ) expected.push( [ 'near', 'riot' ] );
		assert.deepEqual( changes, expected, `${command} should react inside ${radius}m only` );
	}

} );

test( 'Assembly injury reactions nudge the injured group and nearby protesters once per new sample delta', () => {

	const reactions = assemblyReactionHooks(), group = ( id, x ) => ( { handle: { id, kind: 'crowd', run: 1 }, center: [ x, 0 ] } );
	const first = group( 'hurt', 0 ), neighbor = group( 'neighbor', 40 ), distant = group( 'distant', 60 );
	const people = [ ...Array.from( { length: 4 }, ( _, index ) => ( { handle: { id: `injured-${index}` }, actor: first.handle, faction: 'protester', status: 'active' } ) ),
		{ handle: { id: 'neighbor-1' }, actor: neighbor.handle, faction: 'protester', status: 'active' },
		{ handle: { id: 'distant-1' }, actor: distant.handle, faction: 'protester', status: 'active' } ];
	const makeObservation = ( sequence, injured ) => ( { sequence, actors: [ first, neighbor, distant ], people: people.map( ( person ) => person.actor === first.handle
		? { ...person, status: injured ? 'injured' : 'active' } : person ) } );
	const changes = [], context = { people: { members: ( actor ) => people.filter( ( person ) => person.actor === actor ) },
		crowd: { nudge: ( actor, options ) => { changes.push( [ actor.id, options ] ); return { status: 'completed', value: { actor, people: 1 } }; } } };
	reactions.start( { ...context, observation: makeObservation( 1, false ) } );
	reactions.observe( context, makeObservation( 2, true ) );
	reactions.observe( context, makeObservation( 3, true ) );
	assert.deepEqual( changes, [ [ 'hurt', { agitation: 0.35, resolve: 0.05 } ], [ 'neighbor', { agitation: 0.175 } ] ] );

} );

test( 'Government Palace waves split across exact route columns and advance through both legs to rally', async () => {

	const behavior = governmentRouteHooks(), timers = [], spawned = [], centers = new Map<any, any>(), orders = [], nudges = [], modes = [];
	const context = { time: 0, signal: new AbortController().signal, observation: null,
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {} },
		people: { members: () => [ { faction: 'protester', status: 'active' } ] },
		crowd: { nudge: ( actor, options ) => { nudges.push( [ actor.id, options ] ); return { status: 'completed', value: { actor, people: 1 } }; },
			setMode: ( actor, mode ) => { modes.push( [ actor.id, mode ] ); return { status: 'completed', value: { actor, mode } }; } },
		spawn: { crowd: ( options ) => {
			const actor = { id: options.id, kind: 'crowd', run: 1 };
			centers.set( actor.id, [ - 545, - 243 ] ); spawned.push( { actor, options } );
			return { settled: Promise.resolve( { status: 'completed', value: actor } ) };
		} },
		actors: { get: ( actor ) => ( { handle: actor, alive: 100, center: centers.get( actor.id ) ?? null } ) },
		movement: { move: ( actor, at, options ) => {
			orders.push( { actor, at, options } );
			return { settled: Promise.resolve( { status: 'completed', value: {} } ) };
		} },
	};
	behavior.start( context );
	timers.find( ( timer ) => timer.seconds === 8 ).callback( context );
	await Promise.resolve();
	assert.equal( spawned.length, 20 );
	assert.equal( spawned.filter( ( entry ) => entry.options.goal[ 0 ] === - 668 ).length, 10 );
	assert.equal( spawned.filter( ( entry ) => entry.options.goal[ 0 ] === - 410 ).length, 10 );
	assert.ok( spawned.every( ( entry ) => entry.options.spread === 35 && entry.options.goalRadius === 12 ) );
	context.observation = { actors: spawned.map( ( entry ) => ( { handle: entry.actor, center: [ - 545, - 243 ] } ) ), people: [] };
	behavior.onEvent( context, { type: 'command.applied', command: 'charge', at: [ - 545, - 243 ] } );
	assert.equal( nudges.length, 20 );
	assert.deepEqual( modes, [], 'route-bound groups should not be forced into riot mode' );

	const first = spawned[ 0 ], waypoints = [ [ - 668, - 216 ], [ - 700, - 300 ], [ - 682, - 308 ] ];
	centers.set( first.actor.id, waypoints[ 0 ] );
	behavior.update( context, 1 / 60 ); await Promise.resolve();
	assert.deepEqual( orders[ 0 ], { actor: first.actor, at: waypoints[ 1 ], options: { radius: 12 } } );
	centers.set( first.actor.id, waypoints[ 1 ] );
	behavior.update( context, 1 / 60 ); await Promise.resolve();
	assert.deepEqual( orders[ 1 ], { actor: first.actor, at: waypoints[ 2 ], options: { radius: 25 } } );
	context.observation = { actors: spawned.map( ( entry ) => ( { handle: entry.actor,
		center: entry.actor.id === first.actor.id ? waypoints[ 2 ] : [ 500, 500 ] } ) ), people: [] };
	behavior.onEvent( context, { type: 'command.applied', command: 'charge', at: waypoints[ 2 ] } );
	assert.deepEqual( modes, [ [ first.actor.id, 'riot' ] ], 'a group may enter riot mode after reaching its rally' );

} );

test( 'Government injury reactions apply capped same-group and half-strength neighbor deltas once per sample increase', () => {

	const behavior = governmentRouteHooks(), nudge = [], notices = [];
	const actors = [ [ 'hurt', 0 ], [ 'neighbor', 40 ], [ 'distant', 51 ] ].map( ( [ id, x ] ) => ( { handle: { id, kind: 'crowd', run: 1 }, center: [ x, 0 ] } ) );
	const people = [ ...Array.from( { length: 4 }, ( _, index ) => ( { handle: { id: `hurt-${index}` }, actor: actors[ 0 ].handle, faction: 'protester', status: 'active' } ) ),
		{ handle: { id: 'neighbor-person' }, actor: actors[ 1 ].handle, faction: 'protester', status: 'active' },
		{ handle: { id: 'distant-person' }, actor: actors[ 2 ].handle, faction: 'protester', status: 'active' } ];
	const observation = ( injured ) => ( { actors, people: people.map( ( person ) => person.actor === actors[ 0 ].handle
		? { ...person, status: injured ? 'injured' : 'active' } : person ) } );
	const context = { time: 20, observation: observation( false ), signal: new AbortController().signal,
		timeline: { after() { return { state: 'pending', cancel() {} }; } }, presentation: { notice: ( ...args ) => notices.push( args ) },
		crowd: { nudge: ( actor, options ) => { nudge.push( [ actor.id, options ] ); return { status: 'completed', value: { actor, people: 1 } }; }, setMode() { return { status: 'completed' }; } },
	};
	behavior.start( context );
	const first = { ...observation( true ), sequence: 2 };
	behavior.observe( context, first ); behavior.observe( context, { ...first, sequence: 3 } );
	assert.deepEqual( nudge, [ [ 'hurt', { agitation: 0.35, resolve: 0.05 } ], [ 'neighbor', { agitation: 0.175 } ] ] );
	assert.equal( notices.length, 1 );

} );

test( 'Clash candidate preserves source setup, timed waves, cordons and three-leg march route', async () => {

	const { definition, director } = clashCandidate(), spawns = [], orders = [], timers = [], centers = new Map<any, any>();
	const context = { time: 0, signal: new AbortController().signal, random: () => 0.5, metrics: { clashPressure: 0 },
		presentation: { focus() {}, notice() {} }, timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		spawn: Object.fromEntries( [ 'crowd', 'squad', 'vehicle', 'bystanders' ].map( ( kind ) => [ kind, ( options ) => {
			const actor = { id: options.id, kind: kind === 'bystanders' || kind === 'crowd' ? 'crowd' : kind, run: 1 };
			spawns.push( { kind, options, actor } ); centers.set( actor.id, [ 0, 0 ] );
			return { settled: Promise.resolve( { status: 'completed', value: actor } ) };
		} ] ) ),
		movement: { move: ( actor, at, options ) => {
			orders.push( { actor, at, options } );
			return { settled: Promise.resolve( { status: 'completed', value: {} } ) };
		} },
		actors: { get: ( actor ) => ( { handle: actor, alive: 100, center: centers.get( actor.id ) ?? null } ) },
	};
	await definition.setup( context );
	assert.equal( spawns.filter( ( spawn ) => spawn.kind === 'crowd' && spawn.options.id === 'march' )[ 0 ].options.people, 2600 );
	assert.equal( spawns.filter( ( spawn ) => spawn.kind === 'crowd' && spawn.options.id.startsWith( 'counter-' ) ).length, 15 );
	assert.equal( spawns.filter( ( spawn ) => spawn.kind === 'squad' ).length, 10 );
	assert.equal( spawns.filter( ( spawn ) => spawn.kind === 'vehicle' ).length, 3 );
	assert.equal( spawns.find( ( spawn ) => spawn.kind === 'bystanders' ).options.people, 2000 );
	assert.equal( definition.objectives[ 0 ].kind, 'prevent-clash' );
	await director.start( context );
	assert.deepEqual( timers.map( ( timer ) => timer.seconds ), [ 2, 40, 170, 200, 390, 420 ] );
	timers.find( ( timer ) => timer.seconds === 40 ).callback( context );
	await Promise.resolve();
	let marchOrders = orders.filter( ( order ) => order.actor.id === 'march' );
	assert.deepEqual( marchOrders[ 0 ], { actor: spawns.find( ( spawn ) => spawn.options.id === 'march' ).actor,
		at: [ - 225, 65 ], options: { radius: 15 } } );
	centers.set( 'march', [ - 225, 65 ] ); context.time = 41;
	director.update( context, 1 / 60 ); await Promise.resolve();
	marchOrders = orders.filter( ( order ) => order.actor.id === 'march' );
	assert.deepEqual( marchOrders[ 1 ], { actor: marchOrders[ 0 ].actor, at: [ - 314, 100 ], options: { radius: 15 } } );
	centers.set( 'march', [ - 314, 100 ] );
	director.update( context, 1 / 60 ); await Promise.resolve();
	marchOrders = orders.filter( ( order ) => order.actor.id === 'march' );
	assert.deepEqual( marchOrders[ 2 ], { actor: marchOrders[ 0 ].actor, at: [ - 450, - 80 ], options: { radius: 30 } } );

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

test( 'ordered outcome rules use first-match precedence and preserve default objective outcomes', async () => {

	const order = [];
	const first = defineOutcome( { id: 'breach', evaluate: ( context ) => {

		order.push( 'breach' );
		return context.time >= 1 ? { win: false, reason: 'Breached.' } : null;

	} } );
	const second = defineOutcome( { id: 'evacuation', evaluate: () => {

		order.push( 'evacuation' ); return { win: false, reason: 'Blocked.' };

	} } );
	const { runtime, finished } = fixture( scenario( { outcomes: [ first, second ], objectives: [ survive( { id: 'hold', seconds: 10 } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 1 );
	assert.deepEqual( order, [ 'breach' ] ); assert.equal( runtime.result.reason, 'Breached.' );
	assert.equal( finished.length, 1 );

} );

test( 'behavior crowd controls are owner-scoped and stop with their lifetime', async () => {

	let crowdContext, actor;
	const attachment = defineBehavior( { id: 'crowd-control', create: () => ( { start( ctx ) { crowdContext = ctx; actor = ctx.actors.resolve( 'march' ); } } ) } )( { id: 'controller' } );
	const { runtime } = fixture( scenario( { setup( ctx ) { ctx.spawn.crowd( { id: 'march', at: 'square' } ); },
		behaviors: [ attachment ] } ), { spawn: async () => [], setCrowdMode: () => ( { status: 'completed' } ),
		nudgeCrowd: () => ( { status: 'completed', people: 1 } ) } );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	assert.equal( crowdContext.crowd.setMode( actor, 'riot' ).status, 'completed' );
	crowdContext.complete();
	assert.throws( () => crowdContext.crowd.setMode( actor, 'hold' ), /cannot mutate while completed/ );
	assert.throws( () => crowdContext.crowd.nudge( actor, { agitation: 0.1 } ), /cannot mutate while completed/ );
	runtime.dispose();

} );

test( 'behavior player actions carry semantic selections and owned coach cards clear on stop', async () => {

	let received, card;
	const training = defineBehavior( { id: 'action-card', create: () => ( {
		start( ctx ) { ctx.presentation.coach( { chapter: '1. Controls', text: 'Select a squad.', step: 1, total: 2, onNext: () => ctx.complete() } ); },
		onAction: ( ctx, action ) => { received = action; },
	} ) } )( { id: 'training' } );
	const displayed = [];
	const { runtime } = fixture( scenario( { behaviors: [ training ] } ), { coach: ( value ) => displayed.push( value ) } );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const actor = Object.freeze( { id: 'squad-1', kind: 'squad', run: runtime.run } );
	runtime.playerAction( Object.freeze( { type: 'select', how: 'click', selection: Object.freeze( [ actor ] ) } ) );
	assert.equal( received.type, 'select' ); assert.equal( received.selection[ 0 ], actor );
	runtime.playerAction( Object.freeze( { type: 'key', key: 'v', selection: Object.freeze( [] ) } ) );
	assert.equal( received.type, 'key' ); assert.equal( received.key, 'v' );
	card = displayed[ 0 ]; assert.equal( card.chapter, '1. Controls' ); card.onNext();
	assert.equal( runtime.behaviors.instances.get( 'training' ).state, 'completed' );
	assert.deepEqual( displayed.slice( 1 ), [ null ] ); runtime.dispose();

} );

test( 'Training preview advances the coach from semantic pan and selection actions', () => {

	const { definition, curriculum } = trainingCurriculum(), cards = [], locks = new Set( definition.initiallyLockedCommands ), actors = new Map( [
		[ 'squad-1', { id: 'squad-1', kind: 'squad', run: 1 } ], [ 'squad-2', { id: 'squad-2', kind: 'squad', run: 1 } ],
	] );
	let completed = false;
	const context = { actors: { resolve: ( id ) => actors.get( id ) }, locations: { get: () => [ - 20, - 20 ] },
		commands: { list: () => [ 'arrest', 'charge', 'gas', 'crew', 'water' ].filter( ( id ) => ! locks.has( id ) ).map( ( id ) => ( { id } ) ),
			lock: ( id ) => locks.add( id ), unlock: ( id ) => locks.delete( id ) },
		presentation: { coach: ( card ) => cards.push( card ) }, complete: () => { completed = true; }, signal: new AbortController().signal };
	curriculum.start( context );
	assert.deepEqual( [ ...locks ], definition.initiallyLockedCommands );
	assert.match( cards.at( - 1 ).chapter, /Camera/ );
	for ( let count = 0; count < 25; count ++ ) curriculum.onAction( context, { type: 'pan', selection: [] } );
	assert.match( cards.at( - 1 ).chapter, /Camera/ );
	assert.match( cards.at( - 1 ).text, /Scroll to zoom/ );
	curriculum.onAction( context, { type: 'zoom', selection: [] } ); curriculum.onAction( context, { type: 'zoom', selection: [] } );
	curriculum.onAction( context, { type: 'zoom', selection: [] } ); curriculum.onAction( context, { type: 'zoom', selection: [] } );
	assert.match( cards.at( - 1 ).chapter, /Selection/ );
	curriculum.onAction( context, { type: 'select', how: 'click', selection: [ actors.get( 'squad-1' ) ] } );
	assert.match( cards.at( - 1 ).text, /Shift-click Squad 2/ );
	cards.at( - 1 ).onSkip();
	assert.match( cards.at( - 1 ).text, /Escape/ );
	assert.equal( completed, false );

} );

test( 'Training final door test wins after the source hold duration with no sampled pressure', async () => {

	const { definition, curriculum } = trainingCurriculum(), cards = [], actors = new Map<any, any>(), unlocked = new Set( definition.initiallyLockedCommands );
	const operation = ( id, kind ) => {
		const actor = Object.freeze( { id, kind, run: 1 } ); actors.set( id, actor );
		return { settled: Promise.resolve( { status: 'completed', value: actor } ) };
	};
	const setupContext = { locations: { get: ( id ) => id === 'square' ? [ - 40, - 10 ] : [ 0, 0 ] }, spatial: { walkable: ( at ) => at },
		presentation: { focus() {} }, spawn: { squad: ( options ) => operation( options.id, 'squad' ),
			vehicle: ( options ) => operation( options.id, 'vehicle' ), crowd: ( options ) => operation( options.id, 'crowd' ),
			bystanders: ( options ) => operation( options.id, 'crowd' ) } };
	await definition.setup( setupContext );
	let time = 0;
	const context = { get time() { return time; }, get metrics() { return { counters: { injuriesByPolice: 0 } }; }, signal: new AbortController().signal,
		actors: { resolve: ( id ) => actors.get( id ) }, commands: { list: () => [], lock: ( id ) => unlocked.add( id ), unlock: ( id ) => unlocked.delete( id ) },
		locations: { get: () => [ 0, 0 ] }, spatial: { count: () => 0, walkable: ( at ) => at },
		presentation: { coach: ( card ) => cards.push( card ), notice() {} },
		spawn: { squad: ( options ) => operation( options.id, 'squad' ), crowd: ( options ) => operation( options.id, 'crowd' ) }, complete() {} };
	curriculum.start( context );
	for ( let index = 0; index < 30 && ! cards.at( - 1 ).chapter.includes( 'Final Test' ); index ++ ) {
		const card = cards.at( - 1 ); ( card.onSkip ?? card.onNext )();
	}
	assert.match( cards.at( - 1 ).chapter, /Final Test/ );
	time = 30; curriculum.update( context, 30 );
	time = 240; curriculum.update( context, 210 );
	assert.match( cards.at( - 1 ).text, /Training complete/ );
	assert.deepEqual( definition.outcomes[ 0 ].evaluate( { time } ), { win: true, reason: 'The door held. Training complete.' } );
	cards.at( - 1 ).onNext();
	assert.equal( unlocked.size, 0 );

} );

test( 'Training final door test holds for 210 seconds and wins with three stars', async () => {

	const { definition, curriculum } = trainingCurriculum(), cards = [], actors = new Map<any, any>(), unlocked = new Set( definition.initiallyLockedCommands );
	const operation = ( id, kind ) => {
		const actor = Object.freeze( { id, kind, run: 1 } ); actors.set( id, actor );
		return { settled: Promise.resolve( { status: 'completed', value: actor } ) };
	};
	await definition.setup( { locations: { get: () => [ - 40, - 10 ] }, spatial: { walkable: ( at ) => at }, presentation: { focus() {} },
		spawn: { squad: ( options ) => operation( options.id, 'squad' ), vehicle: ( options ) => operation( options.id, 'vehicle' ),
			crowd: ( options ) => operation( options.id, 'crowd' ), bystanders: ( options ) => operation( options.id, 'crowd' ) } } );
	let time = 0, completed = false;
	const context = { get time() { return time; }, get metrics() { return { opinion: 60, counters: { injuriesByPolice: 0 } }; }, signal: new AbortController().signal,
		actors: { resolve: ( id ) => actors.get( id ) }, commands: { list: () => [], lock: ( id ) => unlocked.add( id ), unlock: ( id ) => unlocked.delete( id ) },
		locations: { get: () => [ 0, 0 ] }, spatial: { count: () => 0, walkable: ( at ) => at },
		presentation: { coach: ( card ) => cards.push( card ), notice() {} },
		spawn: { squad: ( options ) => operation( options.id, 'squad' ), crowd: ( options ) => operation( options.id, 'crowd' ) }, complete: () => { completed = true; } };
	curriculum.start( context );
	for ( let index = 0; index < 30 && ! cards.at( - 1 ).chapter.includes( 'Final Test' ); index ++ ) {
		const card = cards.at( - 1 ); ( card.onSkip ?? card.onNext )();
	}
	time = 30; curriculum.update( context, 30 );
	time = 239.99; curriculum.update( context, 209.99 );
	assert.equal( definition.outcomes[ 0 ].evaluate( { time } ), null );
	time = 240; curriculum.update( context, 0.01 );
	assert.deepEqual( definition.outcomes[ 0 ].evaluate( { time } ), { win: true, reason: 'The door held. Training complete.' } );
	const scoring = definition.score( { win: true, metrics: { opinion: 60, counters: { injuriesByPolice: 0, arrests: 0 } } } );
	assert.equal( scoring.stars, 3 );
	cards.at( - 1 ).onNext();
	assert.equal( completed, true );
	assert.equal( cards.at( - 1 ), null );

} );
test( 'scenario opinion policy defaults to the base mission model and maps overrides onto the host weights', async () => {

	const { Mission } = await import( '../src/game/mission.ts' );
	const { SitInMission } = await import( '../src/game/missions/sitin.ts' );
	const { scenarioMission } = await import( '../src/game/scenarios/mission.ts' );
	const base = scenario();
	assert.deepEqual( { initial: base.opinion.initial, gas: base.opinion.gas, water: base.opinion.water }, { initial: 60, gas: - 2, water: - 2 } );
	assert.deepEqual( scenarioMission( base ).prototype.opinionWeights(), Mission.prototype.opinionWeights() );
	const sitin = scenario( { opinion: { initial: 55, gas: - 6, water: - 3.5,
		weights: { injuriesByPolice: - 0.7, officersInjured: 0.2, arrests: - 0.03, sitterArrests: - 0.1, otherInjuries: - 0.05 } } } );
	assert.deepEqual( scenarioMission( sitin ).prototype.opinionWeights(), SitInMission.prototype.opinionWeights() );
	assert.equal( scenario( { opinion: { weights: { arrests: - 1 } } } ).opinion.weights.injuriesByPolice, - 0.5 );
	assert.ok( Object.isFrozen( sitin.opinion ) && Object.isFrozen( sitin.opinion.weights ) );
	assert.throws( () => scenario( { opinion: { initial: 101 } } ), /opinion\.initial/ );
	assert.throws( () => scenario( { opinion: { gas: 1 } } ), /opinion\.gas/ );
	assert.throws( () => scenario( { opinion: { weights: { tension: 1 } } } ), /unsupported field/ );

} );

test( 'scenario HUD rows replace the default objective rows, clamp bars and fail the run on malformed rows', async () => {

	const good = fixture( scenario( { hud: ( { time } ) => [ { label: 'Handed over', value: 1.5, text: `${time}`, state: 'ok' }, { label: 'Tension', value: - 1, text: 'calm', state: 'warn', invert: true } ] } ) );
	await good.runtime.setup(); good.runtime.observe( {} ); await good.runtime.start(); good.runtime.update( 2 );
	assert.deepEqual( good.runtime.objectives(), [ { label: 'Handed over', value: 1, text: '2', state: 'ok', invert: false }, { label: 'Tension', value: 0, text: 'calm', state: 'warn', invert: true } ] );
	const bad = fixture( scenario( { hud: () => [ { label: 'Oops', value: 0.5, text: 'x', state: 'great' } ] } ) );
	await bad.runtime.setup(); bad.runtime.observe( {} ); await bad.runtime.start();
	assert.equal( bad.runtime.objectives()[ 0 ].label, 'Hold position' );
	assert.equal( bad.runtime.state, 'failed' ); assert.match( bad.failures[ 0 ].message, /scenario\.hud: scenario\.hud\.0\.state/ );
	assert.throws( () => scenario( { hud: 'rows' } ), /scenario\.hud/ );

} );
