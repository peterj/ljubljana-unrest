import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceBuilding } from '../src/game/scenarios/building.js';
import { DefendMission } from '../src/game/sdk/templates/defend.js';
import { SpatialHost, mapTarget } from '../src/game/scenarios/spatial.js';
import { defineOutcome, defineScenario, holdBuilding, target } from '../src/game/scenarios/definition.js';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.js';

test( 'building pressure and exit hysteresis match the existing defense template over a full timeline', () => {

	let input = { facade: 0, exits: [ 0, 0 ] };
	const reference = { constructor: {}, world: { groupsOf: () => [], intel: null }, T: { exits: [ [], [] ] },
		t: 0, duration: 720, breach: 0, evac: 0, flags: {}, event() {}, end() {},
		facadeCount: () => input.facade, zone: ( index ) => input.exits[ index - 1 ] };
	let current = { breach: 0, evacuation: 0, blocked: [ false, false ] };
	for ( let step = 0; step < 720 * 4; step ++ ) {

		const phase = Math.floor( step / 80 ) % 6;
		input = [ { facade: 21, exits: [ 20, 20 ] }, { facade: 200, exits: [ 15, 12 ] },
			{ facade: 0, exits: [ 11, 19 ] }, { facade: 20, exits: [ 20, 0 ] },
			{ facade: 40, exits: [ 30, 30 ] }, { facade: 0, exits: [ 0, 0 ] } ][ phase ];
		reference.t += 0.25; DefendMission.prototype.tick.call( reference, 0.25 );
		current = advanceBuilding( current, input, 0.25 );
		assert.equal( current.breach, reference.breach ); assert.equal( current.evacuation, reference.evac );
		assert.deepEqual( current.blocked, reference.blocked );

	}

} );

test( 'building pressure enforces capped breach, asymmetric decay and exact exit thresholds', () => {

	let state = { breach: 0, evacuation: 0, blocked: [ false, false ] };
	state = advanceBuilding( state, { facade: 10000, exits: [ 20, 20 ] }, 1 );
	assert.equal( state.breach, 0.025 ); assert.equal( state.evacuation, 1 / 45 );
	state = advanceBuilding( state, { facade: 0, exits: [ 12, 12 ] }, 1 );
	assert.deepEqual( state.blocked, [ true, true ] );
	state = advanceBuilding( state, { facade: 0, exits: [ 11, 19 ] }, 1 );
	assert.deepEqual( state.blocked, [ false, true ] );
	assert.throws( () => advanceBuilding( state, { facade: 0, exits: new Array( 2 ) }, 1 ), /dense/ );

} );

test( 'spatial defense measurements use outer footprints, agitation and prepared exits', () => {

	const building = mapTarget( { name: 'Building', position: [ 0, 0 ], radius: 15,
		footprints: [ [ - 10, - 10, 10, - 10, 10, 10, - 10, 10 ] ], exits: [ [ 0, 10 ], [ 0, - 10 ] ] }, 'test.target' );
	const handle = {};
	const person = ( position, agitation = 0.5, faction = 'protester', status = 'active' ) => ( { position, agitation, faction, status } );
	const runtime = { actors: new Map( [ [ 'crowd', { handle, backend: {} } ] ] ), adapter: { snapRoad: ( at ) => at }, location: ( at ) => at,
		observation: { actors: [ { handle } ], people: [ person( [ 0, 11 ] ), person( [ 0, 11 ], 0.2 ),
			person( [ 0, 11 ], 0.8, 'police' ), person( [ 0, 11 ], 0.8, 'protester', 'injured' ), person( [ 0, 30 ] ) ] } };
	const spatial = new SpatialHost( runtime ); spatial.targets.set( 'building', building );
	assert.deepEqual( spatial.prepareBuilding( 'building' ).exits, [ [ 0, 30 ], [ 0, - 30 ] ] );
	assert.deepEqual( spatial.buildingGeometry( 'building', { 1: [ 4, - 5 ] } ).exits, [ [ 0, 30 ], [ 4, - 5 ] ] );
	const measured = spatial.measureBuilding( 'building' );
	assert.deepEqual( measured, { facade: 1, exits: [ 1, 0 ] } );
	assert.equal( spatial.measureBuilding( 'building' ), measured );
	assert.equal( spatial.count( { at: [ 0, 11 ], radius: 3, faction: 'protester' } ), 2 );
	assert.equal( spatial.count( { at: [ 0, 11 ], radius: 3, faction: 'protester', minimumAgitation: 0.4 } ), 1 );
	runtime.observation.actors = [];
	assert.equal( spatial.measureBuilding( 'building' ), null );
	assert.equal( spatial.count( { at: [ 0, 0 ], radius: 20 } ), null );
	assert.throws( () => spatial.prepareBuilding( 'building', { 2: [ 0, 0 ] } ), /does not exist/ );
	assert.throws( () => { building.footprints[ 0 ][ 0 ] = 9; }, TypeError );

} );

function buildingRuntime( mode, seconds = 720, outcomes = [] ) {

	return new ScenarioRuntime( defineScenario( { id: 'building-proof', title: 'Building', subtitle: 'Proof', brief: 'Proof.', outcomes,
		locations: { building: target( 'Building' ) }, setup: ( ctx ) => ctx.spawn.crowd( { id: 'crowd', at: 'building', people: 100 } ),
		objectives: [ holdBuilding( { id: 'hold', target: 'building', seconds } ) ] } ), {
		target: () => ( { name: 'Building', position: [ 0, 0 ], radius: 15, footprints: [ [ - 10, - 10, 10, - 10, 10, 10, - 10, 10 ] ], exits: [ [ 0, 10 ], [ 0, - 10 ] ] } ),
		snapRoad: ( at ) => at, spawn: async () => ( {} ), release() {},
		readActor: () => mode === 'unavailable' ? null : ( { alive: 100, center: [ 0, 0 ] } ),
		readPeople: () => Array.from( { length: 100 }, ( _, index ) => ( { key: index, backend: index, leader: index === 0,
			status: 'active', faction: 'protester', agitation: 0.5,
			position: mode === 'breach' ? [ 0, 11 ] : mode === 'exits' ? [ 0, index < 50 ? 30 : - 30 ] : [ 100, 100 ],
		} ) ),
	} );

}

test( 'building objective loses on breach or blocked exits, wins only for a safe full hold', async () => {

	for ( const [ mode, seconds, win, reason ] of [ [ 'breach', 40, false, /forced/ ], [ 'exits', 45, false, /Every exit/ ], [ 'calm', 720, true, /held/ ] ] ) {

		const runtime = buildingRuntime( mode, seconds );
		await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( seconds );
		assert.equal( runtime.result.win, win ); assert.match( runtime.result.reason, reason );
		assert.equal( runtime.objectives().length, 3 ); runtime.dispose();

	}

} );

test( 'ordered outcome rules prioritize a facade breach over simultaneous exit failure', async () => {

	const outcomes = [
		defineOutcome( { id: 'breach-first', evaluate: ( { building } ) => building?.breach >= 1 ? { win: false, reason: 'Breach priority.' } : null } ),
		defineOutcome( { id: 'exit-second', evaluate: ( { building } ) => building?.evacuation >= 1 ? { win: false, reason: 'Exit priority.' } : null } ),
	];
	const runtime = buildingRuntime( 'calm', 60, outcomes );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	runtime.spatial.measureBuilding = () => ( { facade: 200, exits: [ 40, 40 ] } );
	runtime.update( 60 );
	assert.equal( runtime.result.win, false ); assert.equal( runtime.result.reason, 'Breach priority.' );
	runtime.dispose();

} );

test( 'unavailable building observations freeze pressure and cannot award timeout victory', async () => {

	const runtime = buildingRuntime( 'unavailable' );
	await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( 10 );
	assert.equal( runtime.buildingState.breach, 0 ); assert.equal( runtime.result, null );
	runtime.update( 710 ); assert.equal( runtime.state, 'failed' ); assert.equal( runtime.result, null );
	assert.match( runtime.error.message, /observation unavailable/ ); runtime.dispose();

} );

test( 'missing targets fail preflight without running setup', async () => {

	const runtime = buildingRuntime( 'calm' );
	let spawns = 0;
	runtime.adapter.target = () => null; runtime.adapter.spawn = () => { spawns ++; };
	await assert.rejects( runtime.setup(), /scenario.locations.building/ ); assert.equal( spawns, 0 );

} );