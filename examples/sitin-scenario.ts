import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export const sdkVersion = 1;

function formatTime( seconds ) {

	const value = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( value / 60 )}:${String( value % 60 ).padStart( 2, '0' )}`;

}

const GOAL = 120, DURATION = 15 * 60, ARRIVAL_EVERY = 75;
const TENSION = [ { at: 0.12, name: 'protective' }, { at: 0.4, name: 'blockade' }, { at: 0.8, name: 'anger' } ];
const STAGE_NOTICE = [ 'The crowd calms down', 'The crowd closes in to protect the sitters', 'Supporters are blockading the vans and grabbing detainees', 'The crowd turns on the police!' ];
const FORCE_HEAT = { charge: 0.12, kettle: 0.12, 'shield-push': 0.08, gas: 0.25, water: 0.25, firearms: 1 };

export default ( { defineBehavior, defineOutcome, defineScenario, landmark, place, policeCommands, survive }: typeof Sdk ) => {

	// shared with the outcome and score policies, which only see the frozen run context
	const run = { sitters: 0, others: 0, carried: 0, tension: 0, peak: 0, stage: 0, supporters: [] as string[] };
	const sitterActors = ( id: string ) => id.startsWith( 'sitters-' );
	const heat = ( amount: number ) => { run.tension = Math.min( 1.2, run.tension + amount ); run.peak = Math.max( run.peak, run.tension ); };

	const crowd = defineBehavior( {
		id: 'sitin-crowd',
		create() {

			let nextArrival = ARRIVAL_EVERY, arrivals = 0, lastInjuries = 0;
			return {
				start( ctx ) {

					ctx.timeline.after( 2, () => ctx.presentation.notice( 'Select squads and press A over the sitters: they arrest and cart people off by themselves', 'info', 'square' ) );

				},
				update( ctx, dt ) {

					const state = ctx.custody.state();
					run.carried = state.carried;
					run.sitters = Object.entries( { ...state.handedOver } ).filter( ( [ id ] ) => sitterActors( id ) ).reduce( ( n, [ , count ] ) => n + count, 0 )
						+ Object.entries( { ...state.unescorted } ).filter( ( [ id ] ) => sitterActors( id ) ).reduce( ( n, [ , count ] ) => n + count, 0 );
					run.others = Object.entries( { ...state.handedOver } ).filter( ( [ id ] ) => ! sitterActors( id ) ).reduce( ( n, [ , count ] ) => n + count, 0 );
					// injuries by police wind the crowd up; it cools ~0.24 a minute, never below what the arrests so far built up
					const injuries = ctx.metrics.counters.injuriesByPolice;
					if ( injuries > lastInjuries ) heat( ( injuries - lastInjuries ) * 0.008 );
					lastInjuries = injuries;
					run.tension = Math.max( ctx.metrics.counters.sitterArrests * 0.007, run.tension - 0.004 * dt );
					const stage = TENSION.reduce( ( n, entry, k ) => ( run.tension >= entry.at || ( run.stage > k && run.tension >= entry.at - 0.08 ) ? k + 1 : n ), 0 );
					if ( stage !== run.stage ) {

						if ( stage > run.stage || stage === 0 ) ctx.presentation.notice( STAGE_NOTICE[ stage ], stage >= 2 ? 'bad' : stage ? 'warn' : 'good', 'square' );
						run.stage = stage;

					}
					if ( ctx.time >= nextArrival ) {

						nextArrival += ARRIVAL_EVERY;
						const entries = ctx.spatial.entries();
						if ( ! entries.length ) return;
						const entry = entries[ Math.floor( ctx.random() * entries.length ) ];
						const people = Math.round( Math.max( 100, 150 + ( 60 - ctx.metrics.opinion ) * 14 ) * ( 1 + run.tension ) ), bikes = ctx.random() < 0.35 ? 1 : 0;
						const id = `arrivals-${++ arrivals}`;
						ctx.spawn.crowd( { id, label: bikes ? 'Cyclists' : 'Supporters', at: entry.position, people, groupSize: 80, spread: 20,
							goal: 'square', goalRadius: 35, agitation: [ 0.1, 0.35 ], morale: 0.7, bikes } );
						run.supporters.push( id );
						ctx.presentation.notice( `${people} more supporters arriving ${bikes ? 'by bike ' : ''}from ${entry.name ?? 'the edge of town'}`, 'warn', entry.position );

					}

				},
				onEvent( ctx, event ) {

					if ( event.type === 'command.applied' && FORCE_HEAT[ event.command ] ) heat( FORCE_HEAT[ event.command ] );
					if ( event.type === 'custody.detained' ) {

						const sitter = Boolean( event.actor && sitterActors( event.actor.id ) );
						heat( sitter ? 0.018 : 0.012 );
						// every arrest winds up the supporters standing within 80 m
						for ( const id of run.supporters ) {

							const actor = ctx.actors.get( ctx.actors.resolve( id ) );
							if ( ! actor?.center || Math.hypot( actor.center[ 0 ] - event.position[ 0 ], actor.center[ 1 ] - event.position[ 1 ] ) >= 80 ) continue;
							ctx.crowd.nudge( actor.handle, { agitation: sitter ? 0.015 : 0.006, resolve: 0.002 } );

						}

					}
					if ( event.type === 'custody.handed-over' ) ctx.presentation.notice( `Squad hands ${event.people} detainee${event.people > 1 ? 's' : ''} over at the van`, 'good',
						ctx.custody.state().dropoffs.find( ( entry ) => entry.id === event.dropoff ).position );
					if ( event.type === 'custody.blockaded' ) ctx.presentation.notice( 'The prisoner van is blockaded: no hand-overs until it is cleared', 'bad',
						ctx.custody.state().dropoffs.find( ( entry ) => entry.id === event.dropoff ).position );
					if ( event.type === 'custody.idle' && event.reason === 'nobody-left' ) ctx.presentation.notice( 'Nobody left to arrest there', 'info', event.at );

				},
			};

		},
	} );

	return defineScenario( {
		id: 'sitin-rules', menu: false, title: 'Constitution Rules Preview', subtitle: 'Clear the sit-in on Trg republike',
		brief: 'Since dawn, 160 people have been sitting in rows on Trg republike, reading the Constitution aloud, inside a ring of supporters. Arrest the sitters and get them into the prisoner vans. Every arrest makes the crowd angrier.',
		goals: [ `Hand ${GOAL} sitters over at the prisoner vans`, 'Within 15:00', 'Keep public opinion above 15' ],
		tips: [ 'A: the squad arrests at that spot by itself, carries every 8 detainees to the nearest van and comes back',
			'Tension rises with every arrest and falls slowly: pause the arrests to let the crowd cool down',
			'Blockades at the vans stop the hand-over: clear them, or use the other van', 'Gas and charges are a disaster for opinion and tension here' ],
		opinion: { initial: 55, gas: - 6, water: - 3.5, weights: { injuriesByPolice: - 0.7, officersInjured: 0.2, arrests: - 0.03, sitterArrests: - 0.1, otherInjuries: - 0.05 } },
		phase: ( { time } ) => `In custody, not yet at a van: ${run.carried} · supporters arriving in ${formatTime( ARRIVAL_EVERY - time % ARRIVAL_EVERY )} · ${formatTime( DURATION - time )} left`,
		outcomes: [
			defineOutcome( { id: 'cleared', evaluate: () => run.sitters >= GOAL ? { win: true, reason: 'The square is clear. The Constitution will be read elsewhere.' } : null } ),
			defineOutcome( { id: 'outcry', evaluate: ( { metrics } ) => metrics.opinion < 15 ? { win: false, reason: 'Public outcry — the government ordered the police to withdraw.' } : null } ),
			defineOutcome( { id: 'timeout', evaluate: ( { time } ) => time >= DURATION ? { win: false, reason: 'Time ran out; the sit-in continues.' } : null } ),
		],
		score: ( { win, time, metrics } ) => ( {
			stars: Number( win ) + Number( win && metrics.opinion >= 40 ) + Number( win && time <= 10 * 60 ),
			lines: [ [ 'Sitters handed over', run.sitters ], [ 'Other detainees', run.others ], [ 'Time', formatTime( time ) ],
				[ 'Peak crowd tension', `${Math.round( run.peak * 100 )}%` ], [ 'Injuries caused by police', metrics.counters.injuriesByPolice ],
				[ 'Public opinion', Math.round( metrics.opinion ) ] ],
		} ),
		resources: { gas: { capacity: 2 }, water: { capacity: 2 }, reinforce: { capacity: 3 } },
		commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true, custody: true } ),
		locations: { square: place( 'Trg republike' ), assembly: landmark( 'Državni zbor' ), station: landmark( 'PU Ljubljana' ),
			cankarjev: landmark( 'Cankarjev dom' ), foreign: landmark( 'Ministrstvo za zunanje zadeve' ), kongresni: place( 'Kongresni trg' ),
			president: landmark( 'Predsedniška palača' ), preseren: place( 'Prešernov trg' ), metelkova: place( 'Metelkova' ),
			railway: landmark( 'Železniška postaja' ), tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ) },
		setup( ctx ) {

			Object.assign( run, { sitters: 0, others: 0, carried: 0, tension: 0, peak: 0, stage: 0, supporters: [] } );
			const s = ctx.locations.get( 'square' ), open = ( x: number, y: number ) => ( ctx.spatial.clearance( [ x, y ] ) ?? 0 ) > 0.7;
			ctx.presentation.focus( 'square', 0.4 );
			// sitters: 10 rows of 16, 1.8 m apart, one group per row
			const grid: Sdk.Point[] = [];
			for ( let r = 0; r < 10; r ++ ) for ( let c = 0; c < 16; c ++ ) {

				const x = s[ 0 ] + ( c - 7.5 ) * 1.8, y = s[ 1 ] + ( r - 4.5 ) * 1.8;
				if ( open( x, y ) ) grid.push( [ x, y ] );

			}
			for ( let k = 0; k < grid.length; k += 16 ) {

				const points = grid.slice( k, k + 16 );
				ctx.spawn.crowd( { id: `sitters-${k / 16 + 1}`, label: 'Constitution readers', at: 'square', people: points.length, groupSize: 16, points, mode: 'sit',
					goal: 'square', goalRadius: 18, agitation: [ 0, 0.05 ], resolve: [ 1, 1.2 ], morale: 0.9 } );

			}
			// supporters: a ring round the grid, groups of 80 each holding an arc of it
			const hw = 7.5 * 1.8 + 1, hh = 4.5 * 1.8 + 1, r0 = Math.hypot( hw, hh ) + 2, r1 = Math.sqrt( 2200 / ( 1.3 * Math.PI ) + r0 * r0 ), ring = [];
			while ( ring.length < 2200 ) {

				const a = ctx.random() * Math.PI * 2, r = Math.sqrt( r0 * r0 + ctx.random() * ( r1 * r1 - r0 * r0 ) );
				const x = s[ 0 ] + Math.cos( a ) * r, y = s[ 1 ] + Math.sin( a ) * r;
				if ( open( x, y ) ) ring.push( [ x, y, a ] );

			}
			ring.sort( ( p, q ) => p[ 2 ] - q[ 2 ] );
			for ( let k = 0; k < ring.length; k += 80 ) {

				const id = `supporters-${k / 80 + 1}`, points = ring.slice( k, k + 80 ).map( ( [ x, y ] ): Sdk.Point => [ x, y ] );
				ctx.spawn.crowd( { id, label: 'Supporters', at: 'square', people: points.length, groupSize: 80, points, mode: 'hold',
					goal: 'square', goalRadius: 35, agitation: [ 0.05, 0.2 ], morale: 0.7 } );
				run.supporters.push( id );

			}
			for ( const [ index, at ] of [ 'assembly', 'assembly', 'station', 'station', 'station', 'cankarjev', 'cankarjev', 'foreign', 'foreign', 'kongresni', 'kongresni', 'president' ].entries() ) {

				ctx.spawn.squad( { id: `squad-${index + 1}`, at, people: 26 } );

			}
			// prisoner vans ~85 m out toward PU Ljubljana and Cankarjev dom
			for ( const towards of [ 'station', 'cankarjev' ] ) {

				const m = ctx.locations.get( towards ), dx = m[ 0 ] - s[ 0 ], dy = m[ 1 ] - s[ 1 ], l = Math.hypot( dx, dy );
				const raw: Sdk.Point = [ s[ 0 ] + dx / l * 85, s[ 1 ] + dy / l * 85 ], at = ctx.spatial.walkable( raw, 40 ) ?? raw;
				ctx.spawn.vehicle( { id: `van-${towards}`, label: 'Prisoner van', type: 'prisoner-van', at } );
				ctx.custody.addDropoff( { id: `van-${towards}`, at } );

			}
			ctx.spawn.vehicle( { id: 'patrol-station', type: 'police-patrol', at: 'station' } );
			ctx.spawn.vehicle( { id: 'patrol-cankarjev', type: 'police-patrol', at: 'cankarjev' } );
			const station = ctx.locations.get( 'station' );
			ctx.spawn.vehicle( { id: 'water-cannon', label: 'Water cannon', type: 'water-cannon', at: [ station[ 0 ] + 15, station[ 1 ] ] } );
			ctx.spawn.bystanders( { id: 'onlookers', people: 1800, destinations: [ 'preseren', 'kongresni', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		},
		behaviors: [ crowd( { id: 'crowd' } ) ],
		objectives: [ survive( { id: 'clear', seconds: DURATION, label: 'Time left' } ) ],
	} );

};
