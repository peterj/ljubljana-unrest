import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export const sdkVersion = 1;

const POSTS = [ 'preseren', 'tivoli', 'station', 'kongresni' ];
const STARTING_GROUPS: Sdk.CrowdSpawnOptions[] = [
	{ id: 'preseren-bloc', label: 'Prešernov trg', at: 'preseren', people: 900, groupSize: 100, spread: 40, goal: 'preseren', goalRadius: 30,
		mode: 'hold', morale: 0.6, resolve: [ 0.7, 1 ], bikes: 0 },
	{ id: 'metelkova-bloc', label: 'Metelkova', at: 'metelkova', people: 700, groupSize: 100, spread: 40, goal: 'metelkova', goalRadius: 30,
		mode: 'hold', morale: 0.6, resolve: [ 0.7, 1 ], bikes: 0 },
	{ id: 'tivoli-bloc', label: 'Park Tivoli', at: 'tivoli', people: 600, groupSize: 100, spread: 40, goal: 'tivoli', goalRadius: 30,
		mode: 'hold', morale: 0.6, resolve: [ 0.7, 1 ], bikes: 0 },
	{ id: 'cyclists', label: 'Kolesarji', at: 'kongresni', people: 300, groupSize: 60, spread: 25, goal: 'kongresni', goalRadius: 25,
		mode: 'hold', morale: 0.7, resolve: [ 0.8, 1.1 ], bikes: 1 },
];

function approaches( ctx: Pick<Sdk.ScenarioContext, 'locations' | 'spatial'> ): { id: string; center: Sdk.Point; left: Sdk.Point; right: Sdk.Point }[] {

	const square = ctx.locations.get( 'square' );
	return POSTS.map( ( id ) => {

		const origin = ctx.locations.get( id ), dx = origin[ 0 ] - square[ 0 ], dy = origin[ 1 ] - square[ 1 ];
		const length = Math.hypot( dx, dy ) || 1, ux = dx / length, uy = dy / length;
		const raw: Sdk.Point = [ square[ 0 ] + ux * 85, square[ 1 ] + uy * 85 ];
		const center = ctx.spatial.walkable( raw, 30 ) ?? raw;
		const tx = - uy * 22, ty = ux * 22;
		const left: Sdk.Point = [ center[ 0 ] - tx, center[ 1 ] - ty ], right: Sdk.Point = [ center[ 0 ] + tx, center[ 1 ] + ty ];
		return { id, center, left, right };

	} );

}

export default ( { defineScenario, defineBehavior, holdCrowd, landmark, place }: typeof Sdk ) => {

	const director = defineBehavior( {
		id: 'rally-crowd-and-police',
		create() {

			let nextCallAt = 0, calls = 0, nextDirectorAt = 5, clearing = false, gassing = false;
			return {
				start( ctx ) {

					for ( const post of approaches( ctx ) ) {

						ctx.movement.move( `cordon-${post.id}-1`, post.center, { line: post.left } );
						ctx.movement.move( `cordon-${post.id}-2`, post.right, { line: post.center } );

					}

				},
				onAction( ctx, action ) {

					if ( action.type !== 'key' || action.key?.toLowerCase() !== 'r' ) return;
					if ( ctx.time < nextCallAt ) { ctx.presentation.notice( `Rally call ready in ${Math.ceil( nextCallAt - ctx.time )} s`, 'warn' ); return; }
					if ( calls >= 99 ) { ctx.presentation.notice( 'No rally calls remain', 'bad' ); return; }
					const entries = ctx.spatial.entries();
					if ( ! entries.length ) { ctx.presentation.notice( 'No street entries are available for arrivals', 'bad' ); return; }
					const square = ctx.locations.get( 'square' ), headcount = ctx.spatial.count( { at: square, radius: 60, faction: 'protester' } ) ?? 0;
					const momentum = Math.min( 1, headcount / 5000 ) * 0.5 + ctx.metrics.opinion / 200;
					const people = Math.round( 200 + 900 * momentum ), call = ++ calls;
					nextCallAt = ctx.time + 30;
					ctx.presentation.notice( `Rally call: ${people.toLocaleString()} people are setting off`, 'good', square );
					void ( async () => {

						let remaining = people, index = 0;
						while ( remaining > 0 && ! ctx.signal.aborted ) {

							const size = Math.min( remaining, Math.round( 20 + ctx.random() * 25 ) );
							const origin = entries[ Math.floor( ctx.random() * entries.length ) ].position;
							const operation = ctx.spawn.crowd( { id: `rally-${call}-${String( ++ index ).padStart( 2, '0' )}`, label: 'Arrivals',
								at: origin, people: size, groupSize: size, spread: 4, goal: square, goalRadius: 20, morale: 0.6, resolve: [ 0.7, 1 ] } );
							const outcome = await operation.settled;
							if ( outcome.status !== 'completed' ) break;
							remaining -= size;

						}

					} )().catch( () => {} );

				},
				update( ctx ) {

					if ( ctx.time < nextDirectorAt ) return;
					nextDirectorAt += 5;
					const headcount = ctx.spatial.count( { at: 'square', radius: 60, faction: 'protester' } );
					if ( headcount === null ) return;
					const fraction = headcount / 5000;
					if ( ! clearing && fraction >= 2 / 3 ) {

						clearing = true;
						ctx.presentation.notice( 'Police are beginning to clear the square', 'bad', 'square' );
						for ( const id of [ 'reserve-01', 'reserve-02' ] ) ctx.movement.move( id, 'square', { radius: 20 } );

					} else if ( clearing && fraction < 0.5 ) {

						clearing = false;
						ctx.presentation.notice( 'Police stop advancing and hold their lines', 'info', 'square' );

					}
					if ( ! gassing && fraction >= 1 ) { gassing = true; ctx.presentation.notice( 'Police prepare to clear the packed square', 'bad', 'square' ); }
					else if ( gassing && fraction < 0.85 ) gassing = false;

				},
			};

		},
	} );

	return defineScenario( {
		id: 'rally-rules', menu: false, side: 'protest', title: 'Rally Preview', subtitle: 'Hold the square',
		brief: 'Coordinate the protest. Bring 5,000 people onto Trg republike and hold the square for three minutes. Rally calls bring more people in from across town.',
		goals: [ 'Get 5,000 protesters onto Trg republike', 'Hold the square for 3:00 in total', 'Keep the protest alive' ],
		tips: [ 'Select a group and right-click to move it', 'Rally call (R) brings 200 to 1,100 people toward the square; calls recharge after 30 seconds' ],
		locations: { square: place( 'Trg republike' ), preseren: place( 'Prešernov trg' ), kongresni: place( 'Kongresni trg' ),
			metelkova: place( 'Metelkova' ), tivoli: place( 'Park Tivoli' ), railway: landmark( 'Železniška postaja' ),
			station: landmark( 'PU Ljubljana' ), 'police-center': landmark( 'PP Ljubljana Center' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ) },
		setup( ctx ) {

			ctx.presentation.focus( 'square', 0.95 );
			for ( const group of STARTING_GROUPS ) ctx.spawn.crowd( group );
			for ( const post of approaches( ctx ) ) for ( const side of [ 1, 2 ] ) {

				ctx.spawn.squad( { id: `cordon-${post.id}-${side}`, at: post.center, people: 24 } );

			}
		const square = ctx.locations.get( 'square' ), offset: Sdk.Point = [ square[ 0 ] + 10, square[ 1 ] ];
		const reserves: ( string | Sdk.Point )[] = [ 'station', 'station', 'police-center', 'police-center', 'square', offset ];
		for ( const [ index, at ] of reserves.entries() ) {

				ctx.spawn.squad( { id: `reserve-${String( index + 1 ).padStart( 2, '0' )}`, at, people: 26 } );

			}
			ctx.spawn.bystanders( { id: 'onlookers', people: 2000,
				destinations: [ 'preseren', 'kongresni', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		},
		behaviors: [ director( { id: 'rally-director' } ) ],
		objectives: [ holdCrowd( { id: 'hold-square', at: 'square', radius: 60, minimumPeople: 5000, holdSeconds: 180, timeoutSeconds: 1200,
			minimumAlive: 500, minimumAliveAfter: 60, label: 'Square held', reason: 'Trg republike belongs to the people tonight.',
			populationFailureReason: 'The protest fizzled out.', timeoutReason: 'The night is over - the square was never held long enough.' } ) ],
		opinion: { initial: 50, weights: { injuriesByPolice: 0.4, officersInjured: - 0.6, arrests: 0.05, sitterArrests: 0.1, otherInjuries: - 0.1 } },
		score: ( { win, time, metrics } ) => {

			const stars = Number( win ) + Number( win && time <= 720 ) + Number( win && metrics.counters.officersInjured <= 10 );
			return { stars, lines: [ [ 'Time', Math.floor( time ) ], [ 'Public sympathy', Math.round( metrics.opinion ) ],
				[ 'Protesters injured', metrics.counters.injuriesByPolice ], [ 'Officers injured', metrics.counters.officersInjured ],
				[ 'Arrested', metrics.counters.arrests ], [ 'Went home', metrics.counters.peopleGone ] ] };

		},
	} );

};