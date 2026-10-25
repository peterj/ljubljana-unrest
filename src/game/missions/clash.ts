import type * as Sdk from '../scenarios/sdk.d.ts';
import * as sdk from '../scenarios/index.ts';
import { scenarioMission } from '../scenarios/mission.ts';

// ======================================================================================= CLASH
// A peaceful rally holds Trg republike; a fired-up counter-protest on Kongresni trg sets off for it. Its shortest ways
// west leave the square's north-west corner along Šubičeva; the opening cordons seal those and the next three
// (shortest-route cuts on the cost grid), leaving the long way round south of the old town open.
// Built on the Scenario SDK: only its public builders, like a plugin.

function formatTime( seconds ) {

	const value = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( value / 60 )}:${String( value % 60 ).padStart( 2, '0' )}`;

}

const DURATION = 12 * 60, SET_OFF = 30;
const LINES = [
	{ id: 'subiceva', a: [ - 281, - 116 ], b: [ - 262, - 105 ], squads: 3 }, // Šubičeva, east end
	{ id: 'republic-south', a: [ - 352, - 110 ], b: [ - 363, - 106 ], squads: 2 }, // south of Šubičeva, by Trg republike
	{ id: 'passage', a: [ - 338, - 236 ], b: [ - 335, - 233 ], squads: 1 },
	{ id: 'south-west', a: [ - 364, - 144 ], b: [ - 373, - 138 ], squads: 1 },
] as const;
// the counter-protest: already fired up (probing on arrival), escalating at blows from the police, firecrackers at worst
const COUNTER = { faction: 'counter', agitation: [ 0.3, 0.55 ], morale: 0.7, standoff: { level: 2, ceiling: 4, blows: true } } as const;
const WAVES = [
	{ id: 'station-counter', at: 200, people: 600, from: 'station', label: 'Counter-protesters from the station' },
	{ id: 'tivoli-counter', at: 420, people: 500, from: 'tivoli', label: 'Counter-protesters from Tivoli' },
];

export function clashScenario( { defineBehavior, defineScenario, landmark, place, policeCommands, preventClash }: typeof Sdk ) {

	// the actors setup spawns, for the director (both run once per page: each mission is a fresh page load)
	const state = { counters: [], cordons: [] };
	const director = defineBehavior( {
		id: 'clash-director',
		create() {

			let lastC30 = false, lastC70 = false;
			return {
				async start( ctx ) {

					await Promise.all( state.cordons.map( async ( line ) => {

						const result = await ctx.movement.move( line.actor, line.b, { line: line.a } ).settled;
						if ( result.status !== 'completed' ) throw new Error( `clash.cordon.${line.id}: ${result.status}` );

					} ) );
					ctx.timeline.after( 2, () => ctx.presentation.notice( `The counter-protest sets off for Trg republike in ${formatTime( SET_OFF - 2 )}: hold the cordons`, 'info', 'square' ) );
					ctx.timeline.after( SET_OFF, () => {

						for ( const actor of state.counters ) ctx.movement.move( actor, 'republic', { radius: 40 } );
						ctx.presentation.notice( 'The counter-protest sets off for the rally', 'warn', 'square' );

					} );
					for ( const wave of WAVES ) {

						ctx.timeline.after( wave.at - 30, () => ctx.presentation.notice( `${wave.label} in 0:30`, 'warn', wave.from ) );
						ctx.timeline.after( wave.at, () => {

							for ( let offset = 0, index = 0; offset < wave.people; offset += 60, index ++ ) {

								ctx.spawn.crowd( { id: `${wave.id}-${String( index + 1 ).padStart( 2, '0' )}`, label: wave.label, at: wave.from,
									people: Math.min( 60, wave.people - offset ), groupSize: 60, spread: 30, ...COUNTER,
									agitation: [ 0.4, 0.65 ], morale: 0.8, goal: 'republic', goalRadius: 40, mode: 'march' } );

							}
							ctx.presentation.notice( `${wave.label} have arrived, heading for the rally`, 'bad', wave.from );

						} );

					}

				},
				update( ctx ) {

					const pressure = ctx.metrics.clashPressure;
					if ( pressure > 0.3 && ! lastC30 ) { lastC30 = true; ctx.presentation.notice( 'Fighting has broken out!', 'bad' ); }
					if ( pressure > 0.7 && ! lastC70 ) { lastC70 = true; ctx.presentation.notice( 'The brawl is spreading - separate them now!', 'bad' ); }
					if ( pressure < 0.15 ) lastC30 = lastC70 = false;

				},
			};

		},
	} );

	return defineScenario( {
		id: 'clash', title: 'Clash', subtitle: 'Keep the counter-protest away from the rally',
		brief: `A peaceful rally holds <b>Trg republike</b>. A counter-protest on <b>Kongresni trg</b> is already fired up, and in half a
			minute it sets off for the rally. Your squads hold cordons across Šubičeva and the streets south of it. Angry crowds
			probe the lines, and every blow your officers land makes them angrier; quiet lines calm them down. More
			counter-protesters are coming. If the two crowds meet, there will be a brawl, and every injury your officers cause
			will be on the evening news.`,
		goals: [ 'Keep the clash meter from filling for 12:00', 'Injure as few people as possible' ],
		tips: [ 'Probes test your lines: a line that hits back escalates the crowd, one that holds quietly calms it down',
			'A crowd left alone for 1:30 calms down a level', 'Snatch the leaders throwing firecrackers (X)',
			'The long way round, south of the old town, is open: reserves wait on Tomšičeva, Slovenska and at PU Ljubljana',
			'The waves from the station and Tivoli do not pass your cordons', 'Gas affects both sides equally' ],
		phase: ( { time } ) => {

			const wave = WAVES.find( ( entry ) => entry.at > time );
			return wave ? `Next: ${wave.label} in ${formatTime( wave.at - time )}` : `${formatTime( DURATION - time )} left`;

		},
		indicators: [
			{ id: 'police-injuries', label: '★ Injuries caused by police ≤ 20', counter: 'injuriesByPolice', maximum: 20, warnAt: 12 },
			{ id: 'brawl-injuries', label: '★ Brawl injuries ≤ 10', counter: 'otherInjuries', maximum: 10 },
		],
		score: ( { win, metrics } ) => {

			const second = win && metrics.counters.injuriesByPolice <= 20, third = win && metrics.counters.otherInjuries <= 10;
			return { stars: Number( win ) + Number( second ) + Number( third ), lines: [
				[ 'Injuries caused by police', metrics.counters.injuriesByPolice ], [ 'Brawl injuries', metrics.counters.otherInjuries ],
				[ 'Officers injured', metrics.counters.officersInjured ], [ 'Arrests', metrics.counters.arrests ], [ 'Public opinion', Math.round( metrics.opinion ) ],
			] };

		},
		resources: { gas: { capacity: 4 }, water: { capacity: 4 }, reinforce: { capacity: 2, cooldown: 15 } },
		commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true } ),
		opinion: { water: - 2 },
		locations: { square: place( 'Kongresni trg' ), republic: place( 'Trg republike' ), preseren: place( 'Prešernov trg' ),
			station: landmark( 'Železniška postaja' ), police: landmark( 'PU Ljubljana' ), tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ) },
		async setup( ctx ) {

			state.counters = []; state.cordons = [];
			const operations = [];
			const capture = ( operation, accept = ( _actor ) => {} ) => operations.push( operation.settled.then( ( outcome ) => {

				if ( outcome.status !== 'completed' ) throw new Error( `clash setup: ${outcome.status}` );
				accept( outcome.value );

			} ) );
			ctx.presentation.focus( 'square', 0.55 );
			capture( ctx.spawn.crowd( { id: 'rally', label: 'Rally', at: 'republic', people: 2000, groupSize: 100, spread: 35,
				agitation: [ 0.02, 0.12 ], resolve: [ 0.9, 1.3 ], morale: 0.7, mode: 'hold' } ) );
			for ( let index = 0; index < 15; index ++ ) capture( ctx.spawn.crowd( { id: `counter-${String( index + 1 ).padStart( 2, '0' )}`,
				label: 'Counter-protest', at: 'square', people: 60, groupSize: 60, spread: 30, ...COUNTER, mode: 'hold' } ),
			( actor ) => state.counters.push( actor ) );
			// cordons: squads wait on each line's midpoint and form it when the scenario starts
			for ( const line of LINES ) {

				const at: Sdk.Point = [ ( line.a[ 0 ] + line.b[ 0 ] ) / 2, ( line.a[ 1 ] + line.b[ 1 ] ) / 2 ];
				capture( ctx.spawn.squad( { id: `cordon-${line.id}`, at, people: line.squads * 24 } ),
					( actor ) => state.cordons.push( { id: line.id, a: [ ...line.a ], b: [ ...line.b ], actor } ) );

			}
			for ( const [ id, at ] of [ [ 'reserve-tomsiceva', [ - 285, 12 ] ], [ 'reserve-slovenska', [ - 251, - 50 ] ],
				[ 'reserve-police-1', 'police' ], [ 'reserve-police-2', 'police' ] ] as [ string, string | Sdk.Point ][] ) capture( ctx.spawn.squad( { id, at, people: 24 } ) );
			capture( ctx.spawn.vehicle( { id: 'patrol-slovenska', type: 'police-patrol', at: [ - 251, - 45 ] } ) );
			capture( ctx.spawn.vehicle( { id: 'patrol-police', type: 'police-patrol', at: 'police' } ) );
			capture( ctx.spawn.vehicle( { id: 'water-cannon', type: 'water-cannon', at: [ - 410, 37 ] } ) );
			capture( ctx.spawn.bystanders( { id: 'onlookers', people: 2000, destinations: [ 'preseren', 'square', 'republic', 'tivoli', 'mestni' ] } ) );
			await Promise.all( operations );

		},
		behaviors: [ director( { id: 'clash-director' } ) ],
		objectives: [ preventClash( { id: 'keep-apart', seconds: DURATION } ) ],
	} );

}

export const ClashMission = scenarioMission( clashScenario( sdk as unknown as typeof Sdk ) );
