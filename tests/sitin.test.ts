import assert from 'node:assert/strict';
import test from 'node:test';
import sitinScenario from '../examples/sitin-scenario.ts';

// the Sit-in rules candidate run against recorded host calls: setup, then the supporter director and pull-free policy
async function candidate() {

	let behavior, outcomes;
	const definition = ( sitinScenario as any )( {
		defineBehavior: ( value ) => { behavior = value; return ( options ) => ( { kind: 'behavior', ...options } ); },
		defineOutcome: ( rule ) => rule, defineScenario: ( options ) => { outcomes = options.outcomes; return options; },
		landmark: ( name ) => name, place: ( name ) => name, policeCommands: () => [], survive: ( options ) => options } );
	const calls = [], centers = new Map<string, number[]>(), spawned = [], held = [], handles = new Map<string, any>();
	const handle = ( id ) => handles.get( id ) ?? handles.set( id, { id, kind: id.startsWith( 'squad' ) ? 'squad' : 'crowd' } ).get( id );
	let time = 0, random = 0.5, peopleNear = 0;
	const ctx: any = {
		get time() { return time; }, random: () => random,
		observation: { actors: [ { handle: null, center: [ 0, 2 ] } ] },
		metrics: { opinion: 60, counters: { injuriesByPolice: 0, sitterArrests: 0 } },
		locations: { get: ( id ) => ( { square: [ 0, 0 ], station: [ 200, 0 ], cankarjev: [ - 200, 0 ] } )[ id ] ?? [ 50, 50 ] },
		spatial: { clearance: () => 1, walkable: () => null, entries: () => [], count: () => peopleNear },
		presentation: { focus() {}, notice: ( text ) => calls.push( [ 'notice', text ] ) },
		timeline: { after() {} },
		spawn: { crowd: ( options ) => spawned.push( options ), squad() {}, vehicle() {}, bystanders() {} },
		actors: { resolve: handle, get: ( handle ) => centers.has( handle.id ) ? { handle, center: centers.get( handle.id ), alive: 80 } : null },
		people: { members: () => [] },
		crowd: { setMorale: ( handle, morale ) => calls.push( [ 'morale', handle.id, morale ] ), setMode: ( handle, mode ) => calls.push( [ 'mode', handle.id, mode ] ),
			nudge: ( handle, options ) => calls.push( [ 'nudge', handle.id, options ] ) },
		movement: { move: ( handle, at, options ) => { calls.push( [ 'move', handle.id, at, options.radius ] ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		custody: {
			addDropoff() {},
			state: () => ( { carried: 0, handedOver: {}, unescorted: {}, released: {}, dropoffs: [ { id: 'van-station', position: [ 85, 0 ], blocked: false } ],
				squads: [ { squad: handle( 'squad-1' ), state: 'arrest', held: 3, at: [ 0, 0 ] } ] } ),
			release: ( squad ) => { held.push( squad.id ); return { status: 'completed' }; },
		},
	};
	ctx.observation.actors[ 0 ].handle = ctx.actors.resolve( 'squad-1' );
	await definition.setup( ctx );
	const hooks = behavior.create();
	const step = async ( seconds ) => { time += seconds; hooks.update( ctx, seconds ); await Promise.resolve(); await Promise.resolve(); };
	return { definition, outcomes, hooks, ctx, calls, centers, spawned, held, step, setRandom: ( value ) => { random = value; }, setPeopleNear: ( value ) => { peopleNear = value; } };

}

test( 'Sit-in candidate sets up the built-in sit-in: a 160-seat grid of sitters, a 2,200-person ring in groups of 80', async () => {

	const { spawned } = await candidate();
	const sitters = spawned.filter( ( options ) => options.id.startsWith( 'sitters-' ) ), ring = spawned.filter( ( options ) => options.id.startsWith( 'supporters-' ) );
	assert.equal( sitters.length, 10 ); assert.equal( sitters.reduce( ( n, options ) => n + options.people, 0 ), 160 );
	assert.ok( sitters.every( ( options ) => options.mode === 'sit' && options.points.length === 16 && options.goalRadius === 18 ) );
	assert.equal( ring.reduce( ( n, options ) => n + options.people, 0 ), 2200 );
	assert.ok( ring.every( ( options ) => options.people <= 80 && options.mode === 'hold' && options.goalRadius === 35 ) );

} );

test( 'Sit-in supporters protect arrest spots, blockade vans, sit down there and go home when tension falls', async () => {

	const { hooks, ctx, calls, centers, step } = await candidate();
	centers.set( 'supporters-1', [ 10, 0 ] ); centers.set( 'supporters-2', [ 20, 0 ] ); centers.set( 'supporters-3', [ 30, 0 ] ); centers.set( 'supporters-4', [ 0, 300 ] );
	hooks.onEvent( ctx, { type: 'command.applied', command: 'gas' } );
	await step( 0 );
	assert.ok( calls.some( ( call ) => call[ 0 ] === 'notice' && call[ 1 ] === 'The crowd closes in to protect the sitters' ) );
	assert.deepEqual( calls.filter( ( call ) => call[ 0 ] === 'move' ), [ [ 'move', 'supporters-1', [ 0, 0 ], 4 ], [ 'move', 'supporters-2', [ 0, 0 ], 4 ] ] );
	assert.deepEqual( calls.filter( ( call ) => call[ 0 ] === 'mode' ), [ [ 'mode', 'supporters-1', 'march' ], [ 'mode', 'supporters-2', 'march' ] ] );
	assert.ok( calls.some( ( call ) => call[ 0 ] === 'morale' && call[ 1 ] === 'supporters-4' && Math.abs( call[ 2 ] - ( 0.7 + 0.3 * 0.25 ) ) < 0.01 ) );

	calls.length = 0;
	hooks.onEvent( ctx, { type: 'command.applied', command: 'water' } );
	await step( 4 );
	assert.ok( calls.some( ( call ) => call[ 0 ] === 'notice' && /blockading the vans/.test( call[ 1 ] ) ) );
	assert.deepEqual( calls.filter( ( call ) => call[ 0 ] === 'move' ), [ [ 'move', 'supporters-3', [ 85, 0 ], 8 ] ] );
	centers.set( 'supporters-3', [ 80, 0 ] );
	calls.length = 0;
	await step( 4 );
	assert.deepEqual( calls.filter( ( call ) => call[ 0 ] === 'mode' ), [ [ 'mode', 'supporters-3', 'sit' ] ] );

	// ~0.5 tension cools 0.004/s: below the blockade stage after a minute, then the van task expires and the group goes back
	calls.length = 0;
	for ( let k = 0; k < 40; k ++ ) await step( 4 );
	assert.ok( calls.some( ( call ) => call[ 0 ] === 'move' && call[ 1 ] === 'supporters-3' && call[ 2 ] === 'square' && call[ 3 ] === 35 ) );
	assert.ok( calls.some( ( call ) => call[ 0 ] === 'mode' && call[ 1 ] === 'supporters-3' && call[ 2 ] === 'hold' ) );

} );

test( 'Sit-in arrests wind up nearby supporter leaders and a tenth of the rest; packed crowds pull detainees free', async () => {

	const { hooks, ctx, calls, centers, held, step, setRandom, setPeopleNear, definition } = await candidate();
	centers.set( 'supporters-1', [ 10, 0 ] ); centers.set( 'supporters-2', [ 0, 300 ] );
	hooks.onEvent( ctx, { type: 'custody.detained', actor: { id: 'sitters-1' }, position: [ 0, 0 ] } );
	assert.deepEqual( calls.filter( ( call ) => call[ 0 ] === 'nudge' ), [
		[ 'nudge', 'supporters-1', { agitation: 0.15, resolve: 0.05, leaders: true } ], [ 'nudge', 'supporters-1', { agitation: 0.1, resolve: 0.02, share: 0.1 } ] ] );

	hooks.observe( ctx, ctx.observation );
	assert.deepEqual( held, [], 'no pulling free below the blockade stage' );
	hooks.onEvent( ctx, { type: 'command.applied', command: 'gas' } ); hooks.onEvent( ctx, { type: 'command.applied', command: 'water' } );
	await step( 0 );
	setPeopleNear( 40 ); setRandom( 0.01 );
	hooks.observe( ctx, ctx.observation );
	assert.deepEqual( held, [ 'squad-1' ] );
	setRandom( 0.99 );
	hooks.observe( ctx, ctx.observation );
	assert.deepEqual( held, [ 'squad-1' ] );
	assert.deepEqual( definition.score( { win: true, time: 500, metrics: ctx.metrics } ).lines[ 2 ], [ 'Pulled free by the crowd', 1 ] );

} );
