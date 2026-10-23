import assert from 'node:assert/strict';
import test from 'node:test';
import rallyScenario from '../examples/rally-scenario.ts';

function buildRally() {

	let behavior;
	const definition = ( rallyScenario as any )( {
		defineScenario: ( value ) => value,
		defineBehavior: ( value ) => { behavior = value; return ( options ) => ( { kind: 'behavior', id: options.id, create: value.create } ); },
		holdCrowd: ( value ) => ( { ...value, kind: 'hold-crowd' } ),
		landmark: ( name ) => ( { kind: 'landmark', name } ), place: ( name ) => ( { kind: 'place', name } ),
	} );
	return { definition, behavior };

}

test( 'Rally preview starts with source-sized groups, onlookers and police units', async () => {

	const { definition } = buildRally(), crowd = [], squads = [], bystanders = [];
	const locations = new Map( [ [ 'square', [ 0, 0 ] ], [ 'preseren', [ 100, 0 ] ], [ 'tivoli', [ 0, 100 ] ],
		[ 'station', [ - 100, 0 ] ], [ 'kongresni', [ 0, - 100 ] ], [ 'metelkova', [ 100, 100 ] ] ] );
	const context = { locations: { get: ( id ) => locations.get( id ) ?? id },
		spatial: { walkable: ( at ) => at }, presentation: { focus() {} },
		spawn: { crowd: ( options ) => crowd.push( options ), squad: ( options ) => squads.push( options ),
			bystanders: ( options ) => bystanders.push( options ) } };
	await definition.setup( context );
	assert.equal( definition.side, 'protest' ); assert.equal( definition.objectives[ 0 ].kind, 'hold-crowd' );
	assert.equal( definition.opinion.initial, 50 );
	assert.deepEqual( definition.opinion.weights, { injuriesByPolice: 0.4, officersInjured: - 0.6, arrests: 0.05, sitterArrests: 0.1, otherInjuries: - 0.1 } );
	assert.deepEqual( crowd.map( ( group ) => group.people ), [ 900, 700, 600, 300 ] );
	assert.equal( crowd.reduce( ( total, group ) => total + group.people, 0 ), 2500 );
	assert.equal( bystanders[ 0 ].people, 2000 ); assert.equal( squads.length, 14 );
	assert.equal( squads.filter( ( squad ) => squad.id.startsWith( 'cordon-' ) ).length, 8 );
	assert.equal( squads.filter( ( squad ) => squad.id.startsWith( 'reserve-' ) ).length, 6 );

} );

test( 'Rally key calls spawn momentum-scaled arrivals and respect the 30-second cooldown', async () => {

	const { behavior } = buildRally(), hook = behavior.create(), calls = [], notices = [];
	let time = 0;
	const context = { time, signal: new AbortController().signal, metrics: { opinion: 50 }, locations: { get: () => [ 0, 0 ] },
		spatial: { entries: () => [ { position: [ 100, 0 ] }, { position: [ 0, 100 ] } ], count: () => 2500 },
		presentation: { notice: ( message ) => notices.push( message ) }, random: () => 0,
		spawn: { crowd: ( options ) => { calls.push( options ); return { settled: Promise.resolve( { status: 'completed', value: {} } ) }; } } };
	hook.onAction( context, { type: 'key', key: 'r' } );
	await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( calls.reduce( ( total, group ) => total + group.people, 0 ), 650 );
	assert.ok( calls.every( ( group ) => group.goalRadius === 20 && group.spread === 4 ) );
	time = 20; context.time = time; hook.onAction( context, { type: 'key', key: 'r' } );
	assert.match( notices.at( - 1 ), /ready in 10 s/ );
	time = 30; context.time = time; hook.onAction( context, { type: 'key', key: 'R' } );
	await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( calls.reduce( ( total, group ) => total + group.people, 0 ), 1300 );

} );