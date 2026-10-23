import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export const sdkVersion = 1;

function formatTime( seconds ) {

	const value = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( value / 60 )}:${String( value % 60 ).padStart( 2, '0' )}`;

}

const LEGS = [ [ - 225, 65, 15 ], [ - 314, 100, 15 ], [ - 450, - 80, 30 ] ];
const LINES = [
	{ id: 'wolfova', a: [ - 80, - 109 ], b: [ - 89, - 104 ], squads: 3 },
	{ id: 'embankment', a: [ - 59, - 112 ], b: [ - 64, - 109 ], squads: 1 },
	{ id: 'juzni-passage', a: [ - 193, - 96 ], b: [ - 183, - 95 ], squads: 1 },
	{ id: 'slovenska', a: [ - 286, - 86 ], b: [ - 252, - 86 ], squads: 3 },
	{ id: 'subiceva', a: [ - 309, - 107 ], b: [ - 302, - 83 ], squads: 2 },
];

export default ( { defineBehavior, defineScenario, landmark, place, policeCommands, preventClash }: typeof Sdk ) => {

	const state: { march: any, marchState: any, counters: any[], cordons: any[], lastAI: number, waves?: { id: string, at: number, people: number, from: string, label: string }[] } =
		{ march: null, marchState: null, counters: [], cordons: [], lastAI: 0 };
	const director = defineBehavior( {
		id: 'clash-director',
		create() {

			let lastC30 = false, lastC70 = false, marchStarted = false;
			const installMove = ( ctx, route, at, radius ) => {

				route.pending = true;
				const operation = ctx.movement.move( route.actor, at, { radius } );
				route.operation = operation;
				operation.settled.then( ( outcome ) => {

					if ( route.operation !== operation ) return;
					route.pending = false;
					if ( outcome.status !== 'completed' || ctx.signal.aborted ) return;
					route.destination = at;
					route.radius = radius;
					route.moving = true;

				} );

			};
			return {
				async start( ctx ) {

					const cordons = await Promise.all( state.cordons.map( async ( line ) => {

						const result = await ctx.movement.move( line.actor, line.b, { line: line.a } ).settled;
						if ( result.status !== 'completed' ) throw new Error( `clash.cordon.${line.id}: ${result.status}` );
						return result;

					} ) );
					void cordons;
					ctx.timeline.after( 2, () => ctx.presentation.notice( 'The march starts in 0:40 - hold the cordons', 'info', 'square' ) );
					ctx.timeline.after( 40, () => {

						marchStarted = true;
						state.marchState.leg = 0;
						installMove( ctx, state.marchState, LEGS[ 0 ].slice( 0, 2 ), LEGS[ 0 ][ 2 ] );
						ctx.presentation.notice( 'The march sets off for Trg republike by Čopova', 'info', 'preseren' );

					} );
					for ( const wave of state.waves ) {

						ctx.timeline.after( wave.at - 30, () => ctx.presentation.notice( `${wave.label} in 0:30`, 'warn', wave.from ) );
						ctx.timeline.after( wave.at, () => {

							for ( let offset = 0, index = 0; offset < wave.people; offset += 60, index ++ ) {

								const people = Math.min( 60, wave.people - offset );
								const operation = ctx.spawn.crowd( { id: `${wave.id}-${String( index + 1 ).padStart( 2, '0' )}`,
									label: wave.label, at: wave.from, people, groupSize: 60, spread: 30, faction: 'counter',
									agitation: [ 0.4, 0.65 ], morale: 0.8, goal: wave.from, goalRadius: 20, mode: 'march' } );
								operation.settled.then( ( outcome ) => {

									if ( outcome.status === 'completed' && ! ctx.signal.aborted ) state.counters.push( { actor: outcome.value } );

								} );

							}
							ctx.presentation.notice( `${wave.label} have arrived`, 'bad', wave.from );

						} );

					}

				},
				update( ctx ) {

					const pressure = ctx.metrics.clashPressure;
					if ( pressure > 0.3 && ! lastC30 ) { lastC30 = true; ctx.presentation.notice( 'Fighting has broken out!', 'bad' ); }
					if ( pressure < 0.15 ) lastC30 = false;
					if ( pressure > 0.7 && ! lastC70 ) { lastC70 = true; ctx.presentation.notice( 'The brawl is spreading - separate them now!', 'bad' ); }
					if ( pressure < 0.15 ) lastC70 = false;

					if ( marchStarted && ! state.marchState.pending && state.marchState.moving ) {

						const march = ctx.actors.get( state.march );
						if ( march?.center && Math.hypot( march.center[ 0 ] - state.marchState.destination[ 0 ], march.center[ 1 ] - state.marchState.destination[ 1 ] ) <= 30 ) {

							state.marchState.moving = false;
							if ( state.marchState.leg < LEGS.length - 1 ) {

								state.marchState.leg ++;
								installMove( ctx, state.marchState, LEGS[ state.marchState.leg ].slice( 0, 2 ), LEGS[ state.marchState.leg ][ 2 ] );

							}

						}

					}

					if ( ctx.time > 30 && ctx.time - state.lastAI > 6 ) {

						state.lastAI = ctx.time;
						const march = ctx.actors.get( state.march );
						for ( const counter of state.counters ) {

							if ( ! march?.center || ! ctx.actors.get( counter.actor )?.center || ctx.random() < 0.4 ) continue;
							const at: Sdk.Point = [ Math.round( march.center[ 0 ] / 12 ) * 12, Math.round( march.center[ 1 ] / 12 ) * 12 ];
							counter.lastOrder = ctx.movement.move( counter.actor, at, { radius: 8 } );

						}

					}

				},
			};

		},
	} );

	const waves = [
		{ id: 'station-counter', at: 200, people: 600, from: 'station', label: 'Counter-protesters from the station' },
		{ id: 'tivoli-counter', at: 420, people: 500, from: 'tivoli', label: 'Counter-protesters from Tivoli' },
	];
	state.waves = waves;
	return defineScenario( {
		id: 'clash-rules', menu: false, title: 'Clash Rules Preview', subtitle: 'Keep the march and counter-protest apart',
		brief: 'A 2,600-person march sets off from Prešernov trg toward Trg republike. A 900-person counter-protest occupies Kongresni trg, between the two. Keep the crowds apart.',
		goals: [ 'Keep the clash meter from filling for 12:00', 'Injure as few people as possible' ],
		tips: [ 'The long way round by Vegova and Gosposka is open', 'Counter-protesters chase the march; watch for flanking through side streets',
			'Reserves wait on Tomšičeva, Trg republike and at PU Ljubljana', 'Kettling the counter-protest works, but it boils', 'Gas affects both sides equally' ],
		phase: ( { time } ) => {

			const wave = waves.find( ( entry ) => entry.at > time );
			return wave ? `Next: ${wave.label} in ${formatTime( wave.at - time )}` : `${formatTime( 720 - time )} left`;

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
		locations: { preseren: place( 'Prešernov trg' ), square: place( 'Kongresni trg' ), republic: place( 'Trg republike' ),
			station: landmark( 'Železniška postaja' ), police: landmark( 'PU Ljubljana' ), tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ) },
		async setup( ctx ) {

			const operations = [], capture = ( operation, accept ) => operations.push( operation.settled.then( ( outcome ) => {

				if ( outcome.status !== 'completed' ) throw new Error( `clash setup: ${outcome.status}` );
				accept( outcome.value );

			} ) );
			ctx.presentation.focus( 'square', 0.55 );
			capture( ctx.spawn.crowd( { id: 'march', label: 'March', at: 'preseren', people: 2600, groupSize: 100, spread: 40,
				agitation: [ 0.05, 0.2 ], morale: 0.7, goal: 'preseren', goalRadius: 25, mode: 'hold' } ), ( actor ) => {
				state.march = actor; state.marchState = { actor, leg: 0, destination: null, moving: false, pending: false };
			} );
			for ( let index = 0; index < 15; index ++ ) capture( ctx.spawn.crowd( { id: `counter-${String( index + 1 ).padStart( 2, '0' )}`,
				label: 'Counter-protest', at: 'square', people: 60, groupSize: 60, spread: 30, faction: 'counter',
				agitation: [ 0.3, 0.55 ], morale: 0.7, goal: 'square', goalRadius: 25, mode: 'hold' } ), ( actor ) => state.counters.push( { actor } ) );

			for ( const line of LINES ) {

				const at: Sdk.Point = [ ( line.a[ 0 ] + line.b[ 0 ] ) / 2, ( line.a[ 1 ] + line.b[ 1 ] ) / 2 ];
				capture( ctx.spawn.squad( { id: `cordon-${line.id}`, at, people: line.squads * 24 } ), ( actor ) => state.cordons.push( { ...line, actor } ) );

			}
			for ( const [ id, at ] of [ [ 'reserve-chopova', [ - 285, 12 ] ], [ 'reserve-republic', 'republic' ],
				[ 'reserve-slovenska', [ - 251, - 50 ] ], [ 'reserve-police-1', 'police' ], [ 'reserve-police-2', 'police' ] ] as [ string, string | Sdk.Point ][] ) {

				capture( ctx.spawn.squad( { id, at, people: 24 } ), () => {} );

			}
			capture( ctx.spawn.vehicle( { id: 'patrol-chopova', type: 'police-patrol', at: [ - 251, - 45 ] } ), () => {} );
			capture( ctx.spawn.vehicle( { id: 'patrol-police', type: 'police-patrol', at: 'police' } ), () => {} );
			capture( ctx.spawn.vehicle( { id: 'water-cannon', type: 'water-cannon', at: [ - 410, 37 ] } ), () => {} );
			capture( ctx.spawn.bystanders( { id: 'onlookers', people: 2000, destinations: [ 'preseren', 'square', 'republic', 'tivoli', 'mestni' ] } ), () => {} );
			await Promise.all( operations );

		},
		behaviors: [ director( { id: 'clash-director' } ) ],
		objectives: [ preventClash( { id: 'keep-apart', seconds: 720 } ) ],
	} );

};