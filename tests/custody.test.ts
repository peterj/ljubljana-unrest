import assert from 'node:assert/strict';
import test from 'node:test';
import { FACTION, MODE } from '../src/sim/crowd.ts';
import { Intel } from '../src/sim/intel.ts';
import { World } from '../src/sim/world.ts';
import { SitInMission } from '../src/game/missions/sitin.ts';
import { CustodyJobs, custodyOptions, CUSTODY_DEFAULTS } from '../src/game/scenarios/custody.ts';
import { commandDefinitions, policeCommands } from '../src/game/scenarios/commands.ts';
import { defineBehavior, defineScenario, place, survive } from '../src/game/scenarios/definition.ts';
import { ScenarioEngine } from '../src/game/scenarios/engine.ts';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.ts';

const SITTERS = 20, SUPPORTERS = 10, BLOCKERS = 15, VAN = [ 80, 0 ];

// a tiny world: one squad, sitters on the spot, supporters around it, a crowd that can blockade the van
function fixture() {

	const n = SITTERS + SUPPORTERS + BLOCKERS, pos = new Float32Array( n * 2 ), st = new Float32Array( n * 4 );
	for ( let i = 0; i < n; i ++ ) {

		const [ x, y ] = i < SITTERS ? [ ( i % 5 ) * 1.8 - 3.6, Math.floor( i / 5 ) * 1.8 - 2.7 ] : i < SITTERS + SUPPORTERS ? [ 4 + ( i % 3 ), - 1 + ( i % 2 ) ] : [ 300, 300 ];
		pos[ i * 2 ] = x; pos[ i * 2 + 1 ] = y;
		st[ i * 4 ] = FACTION.PROTESTER;

	}
	const squad: any = { id: 0, faction: FACTION.POLICE, kind: 'squad', label: 'Squad 1', members: [], center: [ 30, 0 ], mode: MODE.FORMATION, anchor: [ 30, 0 ], arrestAt: null };
	const world: any = { groups: [ squad ], crowd: { count: n }, intel: null,
		groupsOf: World.prototype.groupsOf, countNear: World.prototype.countNear,
		moveSquads( groups, x, y ) { for ( const g of groups ) { g.mode = MODE.FORMATION; g.anchor = [ x, y ]; } return Promise.resolve(); },
		arrest( groups, x, y ) { for ( const g of groups ) { g.mode = MODE.ARREST; g.arrestAt = [ x, y ]; } return Promise.resolve(); } };
	return { world, squad, pos, st, n };

}

// physics stand-in: squads reach their anchor at once; an arresting squad detains whoever stands on its target
function physics( { world, squad, pos, st, n }, step ) {

	if ( squad.mode === MODE.FORMATION && squad.anchor ) squad.center = [ ...squad.anchor ];
	if ( squad.mode === MODE.ARREST && squad.arrestAt ) {

		squad.center = [ ...squad.arrestAt ];
		for ( let i = 0; i < n; i ++ ) if ( st[ i * 4 ] === FACTION.PROTESTER && Math.hypot( pos[ i * 2 ] - squad.arrestAt[ 0 ], pos[ i * 2 + 1 ] - squad.arrestAt[ 1 ] ) < 1.5 ) {

			st[ i * 4 ] = i < SITTERS ? FACTION.ARRESTED_SITTER : FACTION.ARRESTED;
			break;

		}

	}
	// blockers stand at the van between steps 60 and 90
	const blocking = step >= 60 && step < 90;
	for ( let i = SITTERS + SUPPORTERS; i < n; i ++ ) { pos[ i * 2 ] = blocking ? VAN[ 0 ] + ( i % 4 ) : 300; pos[ i * 2 + 1 ] = blocking ? VAN[ 1 ] + ( i % 3 ) : 300; }
	world.intel = new Intel( pos.slice(), st.slice() );
	return world.intel;

}

async function runBuiltIn( steps ) {

	const f = fixture(), log = [];
	const mission: any = Object.create( SitInMission.prototype );
	Object.assign( mission, { world: f.world, crowd: { count: f.n, N: f.n, setGroup() {} }, t: 0, stage: 0, tension: 0,
		handed: 0, handedOther: 0, sitterSet: new Set( Array.from( { length: SITTERS }, ( _, i ) => i ) ), prevFac: new Float32Array( f.n ).fill( - 1 ),
		vans: [ { at: VAN, blocked: false } ], event() {}, onArrest() {} } );
	mission.jobs( physics( f, 0 ) );
	mission.startArrests( [ f.squad ], 0, 0 );
	for ( let step = 1; step < steps; step ++ ) {

		await Promise.resolve();
		mission.t = step * 0.5;
		mission.jobs( physics( f, step ) );
		log.push( [ f.squad.job?.state, f.squad.job?.held ?? 0, mission.handed, mission.handedOther, mission.vans[ 0 ].blocked ] );

	}
	return log;

}

async function runPort( steps ) {

	const f = fixture(), log = [], events = [];
	let time = 0;
	const jobs = new CustodyJobs( {
		time: () => time, intel: () => f.world.intel, count: () => f.n, capacity: () => f.n,
		police: () => f.world.groupsOf( FACTION.POLICE ).filter( ( group ) => group.center && group.kind !== 'crew' ),
		moveSquads: ( groups, x, y ) => f.world.moveSquads( groups, x, y ), arrest: ( groups, x, y ) => f.world.arrest( groups, x, y ),
		setGroup() {}, countNear: ( x, y, r ) => f.world.countNear( x, y, r, FACTION.PROTESTER ),
		sitter: ( i ) => i < SITTERS, actorOf: ( i ) => i < SITTERS ? 'sitters' : i < SITTERS + SUPPORTERS ? 'supporters' : 'blockers',
		emit: ( type, payload ) => events.push( [ type, payload ] ), fail: ( error ) => { throw error; },
	}, CUSTODY_DEFAULTS, [ { id: 'van', at: VAN, blocked: false } ] );
	jobs.update( physics( f, 0 ) );
	jobs.start( [ f.squad ], [ 0, 0 ] );
	for ( let step = 1; step < steps; step ++ ) {

		await Promise.resolve();
		time = step * 0.5;
		jobs.update( physics( f, step ) );
		const job = jobs.jobs.get( f.squad );
		log.push( [ job?.state, job?.held ?? 0, ( jobs.handedOver.get( 'sitters' ) ?? 0 ) + ( jobs.unescorted.get( 'sitters' ) ?? 0 ),
			jobs.handedOver.get( 'supporters' ) ?? 0, jobs.dropoffs[ 0 ].blocked ] );

	}
	// sent back to an empty spot, the squad reports that nobody is left
	jobs.start( [ f.squad ], [ 0, 0 ] );
	for ( let step = steps; step < steps + 10; step ++ ) { await Promise.resolve(); time = step * 0.5; jobs.update( physics( f, step ) ); }
	return { log, events, jobs };

}

test( 'custody jobs reproduce the built-in Sit-in arrest, cart, blockade and hand-over timeline step by step', async () => {

	const steps = 800, reference = await runBuiltIn( steps ), { log, events, jobs } = await runPort( steps );
	assert.deepEqual( log, reference );
	// the timeline exercises every state, a blockaded van and both kinds of detainee
	assert.deepEqual( new Set( reference.map( ( entry ) => entry[ 0 ] ) ), new Set( [ 'approach', 'arrest', 'process', 'cart', 'unload', 'idle' ] ) );
	assert.ok( reference.some( ( entry ) => entry[ 4 ] ) );
	assert.equal( reference.at( - 1 )[ 2 ], SITTERS );
	assert.equal( jobs.handedOver.get( 'sitters' ), SITTERS );
	assert.deepEqual( [ ...new Set( events.map( ( [ type ] ) => type ) ) ].sort(),
		[ 'custody.blockaded', 'custody.cleared', 'custody.detained', 'custody.handed-over', 'custody.idle' ] );
	const handed = events.filter( ( [ type ] ) => type === 'custody.handed-over' );
	assert.equal( handed.reduce( ( n, [ , payload ] ) => n + payload.people, 0 ), jobs.handedOver.get( 'sitters' ) + ( jobs.handedOver.get( 'supporters' ) ?? 0 ) );
	assert.ok( handed.every( ( [ , payload ] ) => payload.people <= CUSTODY_DEFAULTS.capacity && payload.dropoff === 'van' ) );

} );

test( 'custody options validate, default to the Sit-in tuning and only attach to the arrest order', () => {

	const arrest = policeCommands( { custody: true } ).find( ( command ) => command.id === 'arrest' );
	assert.deepEqual( arrest.custody, CUSTODY_DEFAULTS );
	assert.equal( custodyOptions( { capacity: 4 } ).capacity, 4 );
	assert.equal( policeCommands().find( ( command ) => command.id === 'arrest' ).custody, undefined );
	assert.throws( () => policeCommands( { custody: { capacity: 0 } } ), /custody\.capacity/ );
	assert.throws( () => policeCommands( { custody: { extra: 1 } } as any ), /unsupported field/ );
	assert.throws( () => commandDefinitions( [ { kind: 'police-command', id: 'charge', resource: null, custody: true } ], {} ), /only the arrest command/ );
	assert.deepEqual( commandDefinitions( policeCommands( { custody: { unloadSeconds: 2 } } ), {} ).find( ( command ) => command.id === 'arrest' ).custody,
		{ ...CUSTODY_DEFAULTS, unloadSeconds: 2 } );

} );

function custodyRuntime( { commands = policeCommands( { custody: true } ), setup = ( ctx ) => {} } = {} ) {

	const seen = [], spawned = [], groups = { squad: { id: 1, faction: FACTION.POLICE }, sitters: { id: 2, faction: FACTION.PROTESTER } };
	const capture = defineBehavior( { id: 'capture', create: () => ( { onEvent: ( ctx, event ) => { if ( event.type.startsWith( 'custody.' ) ) seen.push( event ); } } ) } );
	const definition = defineScenario( { id: 'custody-test', title: 'Custody', subtitle: 'Custody', brief: 'Custody.', locations: { square: place( 'Square' ) },
		commands, behaviors: [ capture( { id: 'capture' } ) ], setup, objectives: [ survive( { id: 'hold', seconds: 60 } ) ] } );
	const env = { time: () => 0, intel: () => null, count: () => 0, capacity: () => 0, police: () => [], moveSquads: async () => {}, arrest: async () => {},
		setGroup() {}, countNear: () => 0, sitter: () => false, actorOf: () => null };
	const runtime = new ScenarioRuntime( definition, { place: () => [ 10, 20 ], focus() {}, readActor: () => ( { alive: 10, center: [ 10, 20 ] } ), release() {},
		spawn: async ( kind, options ) => { spawned.push( options ); return [ groups[ options.id ] ?? { id: 9 } ]; }, custodyEnvironment: () => env } );
	return { runtime, seen, spawned, groups };

}

test( 'custody drop-offs, handle-mapped events and immutable state are exposed through the scenario context', async () => {

	const { runtime, seen, spawned, groups } = custodyRuntime( { setup: ( ctx ) => {

		ctx.custody.addDropoff( { id: 'van', at: [ 80, 0 ] } );
		assert.throws( () => ctx.custody.addDropoff( { id: 'van', at: 'square' } ), /already registered/ );
		ctx.spawn.squad( { id: 'squad', at: 'square' } );
		ctx.spawn.crowd( { id: 'sitters', at: 'square', people: 2, groupSize: 2, points: [ [ 0, 0 ], [ 1.8, 0 ] ], mode: 'sit', resolve: [ 1, 1.2 ] } );

	} } );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	assert.equal( runtime.commands.list().find( ( command ) => command.id === 'arrest' ).label, 'Arrest & cart off' );
	assert.deepEqual( spawned[ 1 ].points, [ [ 0, 0 ], [ 1.8, 0 ] ] ); assert.ok( Object.isFrozen( spawned[ 1 ].points[ 0 ] ) );
	assert.equal( spawned[ 1 ].mode, 'sit' ); assert.deepEqual( spawned[ 1 ].resolve, [ 1, 1.2 ] );

	const jobs = runtime.custody.driver(), squad = runtime.context.actors.resolve( 'squad' ), sitters = runtime.context.actors.resolve( 'sitters' );
	jobs.env.emit( 'custody.detained', { squad: groups.squad, actor: 'sitters', position: [ 1, 2 ] } );
	jobs.env.emit( 'custody.detained', { squad: null, actor: null, position: [ 3, 4 ] } );
	jobs.env.emit( 'custody.handed-over', { squad: groups.squad, dropoff: 'van', people: 2, byActor: { sitters: 2 } } );
	assert.equal( seen[ 0 ].squad, squad ); assert.equal( seen[ 0 ].actor, sitters ); assert.deepEqual( seen[ 0 ].position, [ 1, 2 ] );
	assert.equal( seen[ 1 ].squad, null ); assert.equal( seen[ 1 ].actor, null );
	assert.deepEqual( seen[ 2 ].byActor, { sitters: 2 } ); assert.ok( Object.isFrozen( seen[ 2 ].byActor ) );

	jobs.handedOver.set( 'sitters', 3 ); jobs.handedOver.set( null, 1 ); jobs.unescorted.set( 'sitters', 1 );
	jobs.jobs.set( groups.squad, { state: 'cart', held: 4, at: [ 5, 6 ] } );
	jobs.released.set( 'sitters', 2 );
	const state = runtime.context.custody.state();
	assert.deepEqual( state, { carried: 4, handedOver: { sitters: 3 }, unescorted: { sitters: 1 }, released: { sitters: 2 },
		dropoffs: [ { id: 'van', position: [ 80, 0 ], blocked: false } ], squads: [ { squad, state: 'cart', held: 4, at: [ 5, 6 ] } ] } );
	assert.ok( Object.isFrozen( state ) && Object.isFrozen( state.handedOver ) && Object.isFrozen( state.dropoffs[ 0 ] ) );

} );

test( 'custody setup rejects missing configuration, unplaced sitters and mismatched points', async () => {

	await assert.rejects( custodyRuntime( { commands: policeCommands(), setup: ( ctx ) => { ctx.custody.addDropoff( { id: 'van', at: [ 0, 0 ] } ); } } ).runtime.setup(),
		/requires policeCommands\(\{ custody \}\)/ );
	await assert.rejects( custodyRuntime( { setup: ( ctx ) => { ctx.spawn.crowd( { id: 'sitters', at: 'square', people: 2, mode: 'sit' } ); } } ).runtime.setup(),
		/sit mode requires points/ );
	await assert.rejects( custodyRuntime( { setup: ( ctx ) => { ctx.spawn.crowd( { id: 'sitters', at: 'square', people: 3, points: [ [ 0, 0 ] ] } ); } } ).runtime.setup(),
		/spawn\.points/ );

} );

test( 'the engine rejects custody arrests until a drop-off exists', async () => {

	const mission = { runtime: { custody: { options: CUSTODY_DEFAULTS, dropoffs: new Map() } } };
	const engine = new ScenarioEngine( mission );
	const group = { id: 1, faction: FACTION.POLICE, members: [] };
	assert.deepEqual( await engine.prepareCommand( { id: 'arrest', at: [ 0, 0 ] }, [ [ group ] ], new AbortController().signal ), { status: 'rejected', code: 'NO_DROPOFF' } );
	mission.runtime.custody.dropoffs.set( 'van', { id: 'van', at: [ 80, 0 ], blocked: false } );
	assert.deepEqual( await engine.prepareCommand( { id: 'arrest', at: [ 0, 0 ] }, [ [ group ] ], new AbortController().signal ), { groups: [ group ], custody: true, applied: false } );

} );

test( 'released detainees leave the squad sitters first and rejoin their own crowd beside it', () => {

	const respawned = [], events = [];
	let respawnWorks = true;
	const jobs = new CustodyJobs( { sittingActor: ( id ) => id === 'sitters', respawn: ( ...args ) => { if ( respawnWorks ) respawned.push( args ); return respawnWorks; },
		emit: ( type, payload ) => events.push( [ type, payload ] ) }, CUSTODY_DEFAULTS, [] );
	const squad = { center: [ 3, 4 ] };
	jobs.jobs.set( squad, { state: 'cart', held: 3, at: [ 0, 0 ], byActor: new Map<any, number>( [ [ 'supporters', 1 ], [ 'sitters', 2 ] ] ) } );
	assert.equal( jobs.release( squad ), 'sitters' );
	assert.equal( jobs.release( squad ), 'sitters' );
	assert.equal( jobs.release( squad ), 'supporters' );
	assert.deepEqual( respawned, [ [ 'sitters', true, [ 3, 4 ] ], [ 'sitters', true, [ 3, 4 ] ], [ 'supporters', false, [ 3, 4 ] ] ] );
	assert.equal( jobs.release( squad ), null );
	assert.deepEqual( Object.fromEntries( jobs.released ), { sitters: 2, supporters: 1 } );
	assert.deepEqual( events.map( ( [ type, payload ] ) => [ type, payload.actor ] ), [ [ 'custody.released', 'sitters' ], [ 'custody.released', 'sitters' ], [ 'custody.released', 'supporters' ] ] );
	jobs.jobs.get( squad ).held = 1; jobs.jobs.get( squad ).byActor.set( 'sitters', 1 ); respawnWorks = false;
	assert.equal( jobs.release( squad ), null );
	assert.equal( jobs.jobs.get( squad ).held, 1 );

} );

test( 'custody.release maps squads to their held detainees and rejects other actors', async () => {

	const { runtime, groups } = custodyRuntime( { setup: ( ctx ) => {

		ctx.custody.addDropoff( { id: 'van', at: [ 80, 0 ] } );
		ctx.spawn.squad( { id: 'squad', at: 'square' } );
		ctx.spawn.crowd( { id: 'sitters', at: 'square', people: 1, points: [ [ 0, 0 ] ], mode: 'sit' } );

	} } );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const squad = runtime.context.actors.resolve( 'squad' ), sitters = runtime.context.actors.resolve( 'sitters' );
	assert.deepEqual( runtime.context.custody.release( squad ), { status: 'rejected', code: 'NOTHING_HELD' } );
	const jobs = runtime.custody.driver();
	jobs.env.respawn = () => true; jobs.env.sittingActor = ( id ) => id === 'sitters';
	jobs.jobs.set( groups.squad, { state: 'arrest', held: 1, at: [ 0, 0 ], byActor: new Map( [ [ 'sitters', 1 ] ] ) } );
	assert.deepEqual( runtime.context.custody.release( squad ), { status: 'completed', value: { squad, actor: sitters } } );
	assert.throws( () => runtime.context.custody.release( sitters ), /must be an allocated squad actor/ );

} );

test( 'crowd nudges can target leaders or a random share; shield, push and morale reach the groups', () => {

	const nudged = [], patches = [], world = { intel: { faction: () => FACTION.PROTESTER }, setMode: World.prototype.setMode, crowd: null };
	const crowd = { nudge: ( i, a, r ) => nudged.push( [ i, a, r ] ), setGroup: ( id, patch ) => patches.push( [ id, patch ] ) };
	world.crowd = crowd;
	const engine = new ScenarioEngine( { world, crowd } );
	const group: any = { id: 3, faction: FACTION.PROTESTER, leader: 10, members: [ 10, 11, 12, 13 ] };
	const coins = [ 0.05, 0.5, 0.09, 0.95 ];
	assert.deepEqual( engine.nudgeCrowd( [ group ], { agitation: 0.1, resolve: 0.02, share: 0.1, random: () => coins.shift() } ), { status: 'completed', people: 2 } );
	assert.deepEqual( nudged, [ [ 10, 0.1, 0.02 ], [ 12, 0.1, 0.02 ] ] );
	nudged.length = 0;
	assert.deepEqual( engine.nudgeCrowd( [ group ], { agitation: 0.15, resolve: 0.05, leaders: true } ), { status: 'completed', people: 1 } );
	assert.deepEqual( nudged, [ [ 10, 0.15, 0.05 ] ] );
	engine.setCrowdMode( [ group ], 'shield' ); assert.equal( group.mode, MODE.SHIELD );
	engine.setCrowdMode( [ group ], 'push' ); assert.equal( group.mode, MODE.PUSH );
	assert.deepEqual( engine.setCrowdMorale( [ group ], 0.85 ), { status: 'completed' } );
	assert.deepEqual( patches.at( - 1 ), [ 3, { morale: 0.85 } ] );
	assert.deepEqual( engine.setCrowdMorale( [ { ...group, faction: FACTION.POLICE } ], 0.5 ), { status: 'rejected', code: 'FACTION' } );

} );
