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
	const run = { sitters: 0, others: 0, carried: 0, freed: 0, sittersLeft: 160, tension: 0, peak: 0, stage: 0,
		supporters: new Map<string, { mode: Sdk.CrowdMode, task: any }>() };
	const sitterActors = ( id: string ) => id.startsWith( 'sitters-' );
	const heat = ( amount: number ) => { run.tension = Math.min( 1.2, run.tension + amount ); run.peak = Math.max( run.peak, run.tension ); };

	const crowd = defineBehavior( {
		id: 'sitin-crowd',
		create() {

			let nextArrival = ARRIVAL_EVERY, arrivals = 0, lastInjuries = 0, lastDirector = - 99, lastFreedNotice = - 99;
			const dist = ( p: Sdk.Point, q: Sdk.Point ) => Math.hypot( p[ 0 ] - q[ 0 ], p[ 1 ] - q[ 1 ] );
			const setMode = ( ctx, entry, mode: Sdk.CrowdMode ) => { ctx.crowd.setMode( entry.handle, mode ); entry.state.mode = mode; };
			// a new navigation goal for the group, then the mode the built-in sets alongside it
			const send = ( ctx, entry, at, radius: number, mode: Sdk.CrowdMode ) => ctx.movement.move( entry.handle, at, { radius } ).settled
				.then( ( outcome ) => { if ( outcome.status === 'completed' ) setMode( ctx, entry, mode ); } );
			const agitation = ( ctx, handle ) => {

				const people = ctx.people.members( handle ).filter( ( person ) => person.status === 'active' );
				return people.length ? people.reduce( ( total, person ) => total + person.agitation, 0 ) / people.length : 0;

			};

			// every 4 s: the supporters react to the tension stage
			const director = ( ctx ) => {

				const T = run.tension, st = run.stage, now = ctx.time, custody = ctx.custody.state();
				const sup = [ ...run.supporters ].map( ( [ id, state ] ) => {

					const handle = ctx.actors.resolve( id ), actor = ctx.actors.get( handle );
					return { handle, state, center: actor?.center, alive: actor?.alive ?? 0 };

				} ).filter( ( entry ) => entry.center && entry.alive > 5 );
				for ( const entry of sup ) ctx.crowd.setMorale( entry.handle, 0.7 + 0.3 * Math.min( 1, T ) );
				const nearest = ( at, r ) => sup.filter( ( entry ) => ! entry.state.task && dist( entry.center, at ) < r )
					.sort( ( p, q ) => dist( p.center, at ) - dist( q.center, at ) );

				// 1 protective: two groups crowd into every arrest spot, arm in arm from 0.3
				if ( st >= 1 ) for ( const squad of custody.squads ) {

					if ( ! [ 'approach', 'arrest' ].includes( squad.state ) || ! squad.at || sup.filter( ( entry ) => entry.state.task?.squad === squad.squad.id ).length >= 2 ) continue;
					for ( const entry of nearest( squad.at, 70 ).slice( 0, 2 ) ) {

						entry.state.task = { type: 'block', squad: squad.squad.id, stage: 1, until: now + 45 };
						send( ctx, entry, squad.at, 4, T >= 0.3 ? 'shield' : 'march' );

					}

				}

				// 2 blockade: up to two groups per van walk there and sit down in front of it
				if ( st >= 2 ) for ( const van of custody.dropoffs ) {

					if ( sup.filter( ( entry ) => entry.state.task?.van === van.id ).length >= 2 ) continue;
					const entry = nearest( van.position, 160 )[ 0 ];
					if ( ! entry ) continue;
					entry.state.task = { type: 'van', van: van.id, stage: 2, until: now + 60 };
					send( ctx, entry, van.position, 8, 'march' );
					ctx.presentation.notice( 'Supporters head for the prisoner van to block it', 'warn', van.position );

				}

				// blockaders sit down at the van, or wherever they meet police on the way: they block, they do not shove
				const cops = ( ctx.observation?.actors ?? [] ).filter( ( actor ) => actor.handle.kind === 'squad' && actor.center ).map( ( actor ) => actor.center );
				for ( const entry of sup ) {

					const van = entry.state.task?.type === 'van' && custody.dropoffs.find( ( dropoff ) => dropoff.id === entry.state.task.van );
					if ( van && entry.state.mode !== 'sit' && ( dist( entry.center, van.position ) < 12 || cops.some( ( at ) => dist( at, entry.center ) < 12 ) ) ) setMode( ctx, entry, 'sit' );

				}

				// 3 anger: agitated groups near police push at them; the angriest fight (at most two groups at a time)
				if ( st >= 3 ) {

					const rioting = sup.filter( ( entry ) => entry.state.task?.type === 'riot' ).length;
					for ( const entry of sup ) {

						if ( entry.state.task && entry.state.task.type !== 'block' ) continue;
						const level = agitation( ctx, entry.handle );
						if ( level < 0.5 || ! cops.some( ( at ) => dist( at, entry.center ) < 50 ) ) continue;
						if ( level > 0.8 && rioting < 2 && ctx.random() < 0.15 ) {

							entry.state.task = { type: 'riot', stage: 3, until: now + 40 };
							setMode( ctx, entry, 'riot' );

						} else if ( entry.state.mode !== 'push' ) {

							entry.state.task = { ...( entry.state.task ?? { type: 'push', until: now + 40 } ), stage: 3 };
							setMode( ctx, entry, 'push' );

						}

					}

				}

				// tasks run out once the tension has dropped below their stage: back to the ring
				for ( const entry of sup ) {

					if ( ! entry.state.task || now < entry.state.task.until || st >= entry.state.task.stage ) continue;
					entry.state.task = null;
					send( ctx, entry, 'square', 35, 'hold' );

				}

			};

			return {
				start( ctx ) {

					ctx.timeline.after( 2, () => ctx.presentation.notice( 'Select squads and press A over the sitters: they arrest and cart people off by themselves', 'info', 'square' ) );

				},
				update( ctx, dt ) {

					const state = ctx.custody.state(), total = ( record, sitters ) => Object.entries( { ...record } )
						.filter( ( [ id ] ) => sitterActors( id ) === sitters ).reduce( ( n, [ , count ] ) => n + ( count as number ), 0 );
					run.carried = state.carried;
					run.sitters = total( state.handedOver, true ) + total( state.unescorted, true );
					run.others = total( state.handedOver, false );
					// injuries by police wind the crowd up; it cools ~0.24 a minute, never below what the arrests so far built up
					const injuries = ctx.metrics.counters.injuriesByPolice;
					if ( injuries > lastInjuries ) heat( ( injuries - lastInjuries ) * 0.008 );
					lastInjuries = injuries;
					run.tension = Math.max( ctx.metrics.counters.sitterArrests * 0.007, run.tension - 0.004 * dt );
					if ( ctx.observation && ctx.time - lastDirector >= 4 ) {

						lastDirector = ctx.time;
						run.sittersLeft = ctx.observation.actors.filter( ( actor ) => sitterActors( actor.handle.id ) ).reduce( ( n, actor ) => n + actor.alive, 0 );
						const stage = TENSION.reduce( ( n, entry, k ) => ( run.tension >= entry.at || ( run.stage > k && run.tension >= entry.at - 0.08 ) ? k + 1 : n ), 0 );
						if ( stage !== run.stage ) {

							if ( stage > run.stage || stage === 0 ) ctx.presentation.notice( STAGE_NOTICE[ stage ], stage >= 2 ? 'bad' : stage ? 'warn' : 'good', 'square' );
							run.stage = stage;

						}
						director( ctx );

					}
					if ( ctx.time >= nextArrival ) {

						nextArrival += ARRIVAL_EVERY;
						const entries = ctx.spatial.entries();
						if ( ! entries.length ) return;
						const entry = entries[ Math.floor( ctx.random() * entries.length ) ];
						const people = Math.round( Math.max( 100, 150 + ( 60 - ctx.metrics.opinion ) * 14 ) * ( 1 + run.tension ) ), bikes = ctx.random() < 0.35 ? 1 : 0;
						arrivals ++;
						// one actor per group of 80, as the built-in director steers each group on its own
						for ( let offset = 0, part = 1; offset < people; offset += 80, part ++ ) {

							const id = `arrivals-${arrivals}-${part}`;
							ctx.spawn.crowd( { id, label: bikes ? 'Cyclists' : 'Supporters', at: entry.position, people: Math.min( 80, people - offset ), groupSize: 80, spread: 20,
								goal: 'square', goalRadius: 35, agitation: [ 0.1, 0.35 ], morale: 0.7, bikes } );
							run.supporters.set( id, { mode: 'march', task: null } );

						}
						ctx.presentation.notice( `${people} more supporters arriving ${bikes ? 'by bike ' : ''}from ${entry.name ?? 'the edge of town'}`, 'warn', entry.position );

					}

				},
				// a packed, angry crowd round a squad holding detainees pulls one free now and then
				observe( ctx, sample ) {

					if ( run.stage < 2 ) return;
					for ( const squad of ctx.custody.state().squads ) {

						const center = squad.held && sample.actors.find( ( actor ) => actor.handle === squad.squad )?.center;
						if ( ! center ) continue;
						const n = ctx.spatial.count( { at: center, radius: 6, faction: 'protester' } ) ?? 0;
						if ( n < 20 || ctx.random() >= 0.025 * run.tension * Math.min( 2, n / 20 ) ) continue;
						if ( ctx.custody.release( squad.squad ).status !== 'completed' ) continue;
						run.freed ++;
						heat( 0.02 );
						if ( ctx.time - lastFreedNotice > 6 ) { lastFreedNotice = ctx.time; ctx.presentation.notice( 'The crowd pulls a detainee away from a squad!', 'bad', center ); }

					}

				},
				onEvent( ctx, event ) {

					if ( event.type === 'command.applied' && FORCE_HEAT[ event.command ] ) heat( FORCE_HEAT[ event.command ] );
					if ( event.type === 'custody.detained' ) {

						const sitter = Boolean( event.actor && sitterActors( event.actor.id ) );
						heat( sitter ? 0.018 : 0.012 );
						// every arrest winds up the supporters nearby: their leaders and a tenth of the rest
						for ( const id of run.supporters.keys() ) {

							const actor = ctx.actors.get( ctx.actors.resolve( id ) );
							if ( ! actor?.center || dist( actor.center, event.position ) >= 80 ) continue;
							ctx.crowd.nudge( actor.handle, { agitation: sitter ? 0.15 : 0.06, resolve: 0.05, leaders: true } );
							ctx.crowd.nudge( actor.handle, { agitation: sitter ? 0.1 : 0.04, resolve: 0.02, share: 0.1 } );

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
		hud: ( { time, metrics } ) => [
			{ label: 'Sitters handed over at the vans', value: run.sitters / GOAL, text: `${run.sitters} / ${GOAL}`, state: run.sitters >= GOAL ? 'done' : 'ok' },
			{ label: 'Time left', value: time / DURATION, text: formatTime( DURATION - time ), state: time > DURATION * 0.8 ? 'warn' : 'ok', invert: true },
			{ label: 'Crowd tension', value: Math.min( 1, run.tension ), text: [ 'calm', 'protective', 'blockade', 'angry' ][ run.stage ],
				state: run.stage >= 2 ? 'bad' : run.stage ? 'warn' : 'ok', invert: true },
			{ label: `★ Opinion ≥ 40 · sitters left ${run.sittersLeft}`, value: metrics.opinion / 100, text: `${Math.round( metrics.opinion )}`,
				state: metrics.opinion < 25 ? 'bad' : metrics.opinion < 40 ? 'warn' : 'ok' },
		],
		outcomes: [
			defineOutcome( { id: 'cleared', evaluate: () => run.sitters >= GOAL ? { win: true, reason: 'The square is clear. The Constitution will be read elsewhere.' } : null } ),
			defineOutcome( { id: 'outcry', evaluate: ( { metrics } ) => metrics.opinion < 15 ? { win: false, reason: 'Public outcry — the government ordered the police to withdraw.' } : null } ),
			defineOutcome( { id: 'timeout', evaluate: ( { time } ) => time >= DURATION ? { win: false, reason: 'Time ran out; the sit-in continues.' } : null } ),
		],
		score: ( { win, time, metrics } ) => ( {
			stars: Number( win ) + Number( win && metrics.opinion >= 40 ) + Number( win && time <= 10 * 60 ),
			lines: [ [ 'Sitters handed over', run.sitters ], [ 'Other detainees', run.others ], [ 'Pulled free by the crowd', run.freed ], [ 'Time', formatTime( time ) ],
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

			Object.assign( run, { sitters: 0, others: 0, carried: 0, freed: 0, sittersLeft: 160, tension: 0, peak: 0, stage: 0, supporters: new Map() } );
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
				run.supporters.set( id, { mode: 'hold', task: null } );

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
