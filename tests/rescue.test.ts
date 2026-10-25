import assert from 'node:assert/strict';
import test from 'node:test';
import rescueScenario from '../examples/rescue-scenario.ts';
import { RescueMission } from '../src/game/missions/rescue.ts';
import { FACTION } from '../src/sim/crowd.ts';
import * as sdk from '../src/game/scenarios/index.ts';

function nativeSetup() {

	const crowds = [], squads = [], vehicles = [], groups = [], bystanderCounts = [];
	const world = {
		groups, wind: [ 0, 0 ], exits: async () => {}, field: async () => ( {} ),
		bloc: async ( options ) => {

			crowds.push( options );
			return Array.from( { length: Math.ceil( options.n / options.groupSize ) }, ( _, index ) => ( { id: `crowd-${crowds.length}-${index}`, members: [] } ) );

		},
		squad: async ( options ) => {

			squads.push( options );
			const group = { id: `squad-${squads.length}`, faction: FACTION.POLICE, members: [], anchor: options.at };
			groups.push( group ); return group;

		},
		crowd: { setGroup() {} },
		patrols: { snap: ( x, y ) => [ x, y ], add: async ( options ) => { vehicles.push( options ); return { x: options.at[ 0 ], y: options.at[ 1 ], crew: null }; } },
	};
	const mission = Object.assign( Object.create( RescueMission.prototype ), {
		world, crowd: { u: { revealLeaders: { value: 0 }, parting: { value: - 1 } } }, counters: {}, t: 0,
		bystanders: async ( people ) => { bystanderCounts.push( people ); },
	} );
	return { mission, crowds, squads, vehicles, bystanderCounts };

}

test( 'Rescue SDK setup matches native crowd, squad, vehicle, bystander, resource and opinion setup', async () => {

	const native = nativeSetup(), definition = ( rescueScenario as any )( sdk ), sdkCrowds = [], sdkSquads = [], sdkVehicles = [], sdkBystanders = [], configured = [];
	await RescueMission.prototype.setup.call( native.mission );
	const vehicle = Object.freeze( { id: 'rescue-car', kind: 'vehicle', run: 1 } );
	await definition.setup( {
		presentation: { focus() {} },
		spawn: {
			crowd: ( options ) => { sdkCrowds.push( options ); return { settled: Promise.resolve( { status: 'completed', value: { id: options.id, kind: 'crowd', run: 1 } } ) }; },
			squad: ( options ) => sdkSquads.push( options ),
			vehicle: ( options ) => { sdkVehicles.push( options ); return { settled: Promise.resolve( { status: 'completed', value: vehicle } ) }; },
			bystanders: ( options ) => sdkBystanders.push( options.people ),
		},
		protected: { create: () => Object.freeze( { id: 'speaker-person', run: 1 } ) },
		actors: { configure: ( actor, options ) => { configured.push( [ actor.id, options ] ); return { status: 'completed' }; } },
	} );

	const normalizeCrowd = ( options, candidate ) => ( {
		label: options.label, at: options.at, people: candidate ? options.people : options.n, groupSize: options.groupSize,
		spread: options.spread, agitation: options.agitation, resolve: options.resolve, morale: options.morale, speed: options.speed,
		medic: candidate ? options.medic === true : options.kind === 'medics',
	} );
	assert.deepEqual( sdkCrowds.map( ( options ) => normalizeCrowd( options, true ) ), native.crowds.map( ( options ) => normalizeCrowd( options, false ) ) );
	assert.deepEqual( sdkSquads.map( ( squad ) => [ squad.at, squad.people ] ), native.squads.map( ( squad ) => [ squad.at, squad.n ] ) );
	assert.deepEqual( sdkVehicles.map( ( item ) => item.at ), native.vehicles.map( ( item ) => item.at ) );
	assert.deepEqual( sdkBystanders, native.bystanderCounts );
	assert.deepEqual( configured, [ [ 'speaker', { closed: true, parting: true } ], [ 'antifa-1', { closed: true } ], [ 'antifa-2', { closed: true } ], [ 'antifa-3', { closed: true } ] ] );
	assert.equal( native.mission.sp.group.closed, true );
	assert.equal( native.mission.opinion, definition.opinion.initial );
	assert.equal( native.mission.crowd.u.revealLeaders.value, 1 );
	assert.deepEqual( [ native.mission.resources.umbrella.max ], [ definition.resources.umbrella.capacity ] );

} );

test( 'Rescue SDK briefing announcements retain native offsets', () => {

	const native = Object.assign( Object.create( RescueMission.prototype ), { t: 0, timers: [] } );
	RescueMission.prototype.start.call( native );
	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), timers = [];
	behavior.start( { timeline: { after: ( seconds, callback ) => timers.push( { seconds, callback } ) }, presentation: { notice() {} } } );
	assert.deepEqual( timers.map( ( timer ) => timer.seconds ), native.timers.map( ( timer ) => timer.at ) );
	assert.deepEqual( timers.map( ( timer ) => timer.seconds ), [ 2, 14, 45 ] );

} );

test( 'Rescue charge phase follows native three-second cadence and kettles 14 seconds after landing', () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), timers = [], commands = [];
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), center = [ - 195, - 178 ];
	const context = { time: 0, signal: new AbortController().signal,
		observation: { people: Array.from( { length: 2500 }, () => ( { faction: 'protester', status: 'active', position: center } ) ) },
		protected: { get: () => ( { actor: speaker, state: 'active', position: [ - 205, - 178 ] } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {}, markers() {} },
		commands: { execute: ( id, request ) => { commands.push( { id, request } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		actors: { resolve: ( id ) => Object.freeze( { id, kind: 'squad', run: 1 } ), get: ( handle ) => ( { handle, alive: 24, center: [ - 205, - 178 ] } ) },
		movement: { move: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		resources: { get: () => ( { available: false } ) },
	};
	behavior.start( context );
	const existingKettleTimers = timers.filter( ( timer ) => timer.seconds === 14 ).length;
	for ( context.time = 3; context.time < 67; context.time += 3 ) behavior.update( context );
	assert.equal( timers.filter( ( timer ) => timer.seconds === 8 ).length, 0 );
	context.time = 69; behavior.update( context );
	assert.equal( timers.filter( ( timer ) => timer.seconds === 8 ).length, 3 );
	assert.equal( timers.filter( ( timer ) => timer.seconds === 14 ).length, existingKettleTimers );
	const force = [ - 325, - 275 ], delta = [ force[ 0 ] - center[ 0 ], force[ 1 ] - center[ 1 ] ], distance = Math.hypot( ...delta );
	context.time = 77; timers.find( ( timer ) => timer.seconds === 8 ).callback();
	assert.deepEqual( commands.find( ( command ) => command.id === 'charge' ).request.at,
		[ center[ 0 ] + delta[ 0 ] / distance * 25, center[ 1 ] + delta[ 1 ] / distance * 25 ] );
	const kettleTimer = timers.filter( ( timer ) => timer.seconds === 14 ).at( - 1 );
	assert.ok( kettleTimer ); kettleTimer.callback();
	const kettle = commands.find( ( command ) => command.id === 'kettle' );
	assert.deepEqual( kettle.request.at, center ); assert.equal( kettle.request.radius, Math.sqrt( 2500 / 1.6 / Math.PI ) );
	context.time = 77; behavior.update( context ); assert.equal( timers.filter( ( timer ) => timer.seconds === 5 ).length, 0 );
	context.time = 96; behavior.update( context ); assert.equal( timers.filter( ( timer ) => timer.seconds === 5 ).length, 1 );

} );

test( 'Rescue SDK scoring rows and star thresholds match the native mission', () => {

	const definition = ( rescueScenario as any )( sdk );
	for ( const win of [ false, true ] ) for ( const time of [ 599.9, 600, 900 ] ) for ( const opinion of [ 49, 50 ] ) {

		const counters = { injuriesByPolice: 3, treatedByMedics: 2, arrests: 4, officersInjured: 5 };
		const native = RescueMission.prototype.score.call( { t: time, opinion, sp: { carriers: 0 },
			counters: { injByPolice: counters.injuriesByPolice, treated: counters.treatedByMedics, arrested: counters.arrests, injPolice: counters.officersInjured, broken: 0 }, ai: { gasUsed: 1 } }, win );
		const actual = definition.score( { win, time, metrics: { opinion, counters: { ...counters, gasUsed: 1 } } } );
		assert.deepEqual( actual, native );

	}

} );

test( 'Rescue SDK outcome reasons preserve native captured, escaped and timeout results', () => {

	const definition = ( rescueScenario as any )( sdk ), outcome = definition.outcomes[ 0 ].evaluate;
	const protectedObservation = ( state ) => ( { handle: { id: 'speaker-person' }, state } );
	assert.deepEqual( outcome( { time: 100, observation: { protected: [ protectedObservation( 'captured' ) ] }, metrics: {} } ),
		{ win: false, reason: 'The police took the Speaker.' } );
	assert.deepEqual( outcome( { time: 239.9, observation: { protected: [ protectedObservation( 'exited' ) ] }, metrics: {} } ),
		{ win: true, reason: 'The Speaker got away at 3:59.' } );
	assert.deepEqual( outcome( { time: 900, observation: { protected: [ protectedObservation( 'active' ) ] }, metrics: {} } ),
		{ win: false, reason: 'The police sealed off the district. The Speaker is trapped.' } );

} );

test( 'Rescue selects its exit by road distance and police along the route, not straight-line distance', () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), drives = [], countCalls = [];
	const car = { handle: { id: 'rescue-car', kind: 'vehicle', run: 1 }, position: [ 0, 0 ], speed: 0, moving: true, revision: 0 };
	const routePoints = new Map( [
		[ '-330,-948', [ [ 0, 0 ], [ 0, - 900 ], [ - 330, - 948 ] ] ],
		[ '-60,-657', [ [ 0, 0 ], [ 500, 0 ], [ 500, - 657 ], [ - 60, - 657 ] ] ],
		[ '-75,-903', [ [ 0, 0 ], [ - 75, - 903 ] ] ],
	] );
	const length = ( points ) => points.slice( 1 ).reduce( ( total, point, index ) => total + Math.hypot( point[ 0 ] - points[ index ][ 0 ], point[ 1 ] - points[ index ][ 1 ] ), 0 );
	const context = {
		time: 0, protected: { get: () => ( { state: 'aboard', position: [ 0, 0 ], revision: 1 } ) },
		vehicles: { get: () => car, drive: ( handle, at ) => { drives.push( at ); return { status: 'completed' }; }, exit() {} },
		spatial: {
			roadRoute: ( from, to ) => { const points = routePoints.get( `${to[ 0 ]},${to[ 1 ]}` ); return points ? { points, length: length( points ) } : null; },
			count: ( options ) => { countCalls.push( options ); return 0; },
		},
	};
	behavior.observe( context, { sequence: 1, elapsed: 0, people: [] } );
	assert.deepEqual( drives, [ [ - 75, - 903 ] ] );
	assert.ok( countCalls.length > 3 );

} );