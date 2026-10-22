export const sdkVersion = 1;

function near( first, second, radius ) {

	return first && Math.hypot( first[ 0 ] - second[ 0 ], first[ 1 ] - second[ 1 ] ) <= radius;

}

function formatTime( seconds ) {

	const value = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( value / 60 )}:${String( value % 60 ).padStart( 2, '0' )}`;

}

export default ( { defineBehavior, defineOutcome, defineScenario, landmark, place, policeCommands, survive, target } ) => {

	const run = { completed: false, steps: 0, finalStarted: null, finalSpawned: false, finalPressure: 0, finalResult: null };
	const commandDefinitions = policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true } );
	const curriculum = defineBehavior( {
		id: 'training-curriculum',
		create() {

			let index = - 1, actionCount = 0, spedUp = false, squadOne, squadTwo, marker, steps, ctx;
			const beginFinal = ( behavior ) => {

				run.finalStarted = behavior.time;
				run.finalSpawned = false;
				run.finalSampled = false;
				run.finalWarned = false;
				run.finalPressure = 0;
				run.finalResult = null;
				run.finalInjuries = behavior.metrics.counters.injuriesByPolice;
				for ( const [ id, at ] of [ [ 'squad-3', run.northAt ], [ 'squad-4', run.northAt.map( ( value, axis ) => value + ( axis === 0 ? - 10 : 12 ) ) ] ] ) {

					behavior.spawn.squad( { id, at, people: 24 } );

				}

			};
			const advance = () => {

				const previous = steps[ index ];
				if ( previous?.command ) ctx.commands.lock( previous.command );
				index ++;
				actionCount = 0;
				const step = steps[ index ];
				if ( ! step ) {

					run.completed = true;
					ctx.presentation.coach( null );
					ctx.complete();
					return;

				}
				for ( const id of step.unlock ?? [] ) ctx.commands.unlock( id );
				if ( step.final ) for ( const command of commandDefinitions ) ctx.commands.unlock( command.id );
				ctx.presentation.coach( { chapter: step.chapter, text: typeof step.text === 'function' ? step.text() : step.text, step: index + 1, total: steps.length,
					spot: step.spot, next: step.next, onNext: advance, onSkip: step.next || step.final ? undefined : advance } );
				if ( step.final ) beginFinal( ctx );

			};
			return {
				start( behavior ) {

					ctx = behavior;
					squadOne = ctx.actors.resolve( 'squad-1' ); squadTwo = ctx.actors.resolve( 'squad-2' );
					marker = run.marker;
					steps = [
						{ chapter: '1. Camera', text: 'Drag the map with the left mouse button to look around.', done: ( action ) => action.type === 'pan' && ++ actionCount >= 25 },
						{ chapter: '1. Camera', text: 'Scroll to zoom in and out.', done: ( action ) => action.type === 'zoom' && ++ actionCount >= 4 },
						{ chapter: '2. Selection', text: 'Click Squad 1 to select it.', spot: 'commands', done: ( action ) => action.type === 'select' && action.selection.includes( squadOne ) },
						{ chapter: '2. Selection', text: 'Shift-click Squad 2 to add it to the selection.', done: ( action ) => action.type === 'select' && action.how === 'add' && action.selection.includes( squadOne ) && action.selection.includes( squadTwo ) },
						{ chapter: '2. Selection', text: 'Press Escape to clear the selection.', done: ( action ) => action.type === 'deselect' },
						{ chapter: '2. Selection', text: 'Hold Shift and drag a box around both squads.', done: ( action ) => action.type === 'select' && action.how === 'box' && action.selection.includes( squadOne ) && action.selection.includes( squadTwo ) },
						{ chapter: '2. Selection', text: 'Press Tab a few times to cycle through your units.', done: ( action ) => action.type === 'select' && action.how === 'tab' && ++ actionCount >= 3 },
						{ chapter: '3. Movement', text: 'Select a squad and right-click near the southwest edge of the square.', spot: 'commands', done: ( action ) => action.type === 'move' && near( action.at, marker, 16 ) },
						{ chapter: '3. Movement', text: 'Right-drag across the square to form a cordon line.', done: ( action ) => action.type === 'line' && action.how === 'right' },
						{ chapter: '3. Movement', text: 'Press L, then left-drag to draw a cordon line on a trackpad.', done: ( action ) => action.type === 'line' && action.how !== 'right' },
						{ chapter: '4. Time', text: 'Press Space to pause. Orders still work while paused.', spot: 'pauseBtn', done: ( action ) => action.type === 'pause' && action.paused },
						{ chapter: '4. Time', text: 'Press Space again to resume.', spot: 'pauseBtn', done: ( action ) => action.type === 'pause' && ! action.paused },
						{ chapter: '4. Time', text: 'Speed up with +, then return to normal speed with -.', spot: 'speedBtn', done: ( action ) => {

							if ( action.type !== 'speed' ) return false;
							if ( action.speed > 1 ) spedUp = true;
							return spedUp && action.speed === 1;

						} },
						{ chapter: '4. Time', text: 'Press N to toggle sound.', spot: 'soundBtn', done: ( action ) => action.type === 'sound' },
						{ chapter: '5. Crowd', text: 'Orange groups are protesters. Brighter color means greater agitation.', next: true, spot: 'objectives' },
						{ chapter: '6. Orders', unlock: [ 'arrest' ], command: 'arrest', text: 'Select a squad, point at the protesters and press A to arrest.', spot: 'commands', done: ( action ) => action.type === 'order' && action.key === 'a' },
						{ chapter: '6. Orders', unlock: [ 'charge' ], command: 'charge', text: 'Press C to charge at the cursor. Force can injure people and lower public opinion.', spot: 'opinion', done: ( action ) => action.type === 'order' && action.key === 'c' },
						{ chapter: '6. Orders', unlock: [ 'gas' ], command: 'gas', text: 'Press G to deploy tear gas at the cursor.', spot: 'commands', done: ( action ) => action.type === 'order' && action.key === 'g' },
						{ chapter: '7. Vehicles', text: 'Click the patrol car, then right-click a street to drive it.', done: ( action ) => action.type === 'drive' && action.vehicle?.id === 'patrol-car' },
						{ chapter: '7. Vehicles', unlock: [ 'crew' ], command: 'crew', text: 'With the patrol selected, press U to deploy or recover its crew.', spot: 'commands', done: ( action ) => action.type === 'order' && action.key === 'u' },
						{ chapter: '7. Vehicles', unlock: [ 'water' ], command: 'water', text: 'Select the water cannon and press W to aim and spray.', spot: 'commands', done: ( action ) => action.type === 'order' && action.key === 'w' },
						{ chapter: '8. Final Test', final: true,
							text: 'The side-door test begins now. In 0:30, groups approach from north and south. Hold the Assembly side door for 3:30; keep cordons across the street, snatch leaders and use gas if pressure builds.',
							done: () => Boolean( run.finalResult ) },
						{ chapter: 'Training', text: () => run.finalResult?.reason ?? 'Training complete.', next: true },
					];
					advance();

				},
				onAction( behavior, action ) {

					const step = steps[ index ];
					if ( step?.done?.( action ) ) advance();

				},
				update( behavior, dt ) {

					if ( run.finalStarted === null || run.finalResult ) return;
					const elapsed = behavior.time - run.finalStarted;
					if ( elapsed >= 30 && ! run.finalSpawned ) {

						run.finalSpawned = true;
						behavior.spawn.crowd( { id: 'final-radicals', label: 'Radicals', at: run.northAt, people: 60, groupSize: 60, spread: 8,
							agitation: [ 0.4, 0.65 ], morale: 0.8, goal: run.door, goalRadius: 8 } );
						behavior.spawn.crowd( { id: 'final-bloc', label: 'Bloc', at: run.waveAt, people: 120, groupSize: 60, spread: 15,
							agitation: [ 0.2, 0.45 ], morale: 0.7, goal: run.door, goalRadius: 8 } );
						behavior.presentation.notice( 'Radicals from the north and a bloc from Slovenska are heading for the side door', 'bad', run.door );

					}
					if ( run.finalSpawned ) {

						const people = behavior.spatial.count( { at: run.door, radius: 9, faction: 'protester' } );
						if ( people !== null ) {

							run.finalSampled = true;
						const rate = people > 20 ? Math.min( 0.025, ( people - 20 ) / 2500 ) : - 0.015;
							run.finalPressure = Math.max( 0, Math.min( 1, run.finalPressure + rate * dt ) );

						}
						if ( run.finalPressure >= 1 ) run.finalResult = { win: false, reason: 'The protesters forced the Assembly side door.' };
						else if ( elapsed >= 240 ) run.finalResult = run.finalSampled
							? { win: true, reason: 'The door held. Training complete.' }
							: { win: false, reason: 'Training could not confirm side-door pressure before the deadline.' };
						if ( run.finalPressure > 0.5 && ! run.finalWarned ) {

							run.finalWarned = true;
							behavior.presentation.notice( 'They are at the door!', 'bad', run.door );

						}
						if ( run.finalResult && steps[ index ]?.final ) advance();

					}

				},
			};

		},
	} );

	return defineScenario( {
		id: 'training-rules', menu: false, title: 'Training Controls Preview', subtitle: 'Learn the basics on Trg republike',
		brief: 'Two squads, a patrol car, and a water cannon are ready on the square. Follow the coach card to practise selection, movement, time controls, orders, and vehicles.',
		goals: [ 'Follow the coach card', 'Practise the controls and orders' ],
		locations: { square: place( 'Trg republike' ), police: landmark( 'PU Ljubljana' ), assembly: target( 'Državni zbor' ) },
		resources: { gas: { capacity: 3 }, water: { capacity: 3 }, reinforce: { capacity: 2 } },
		commands: commandDefinitions,
		initiallyLockedCommands: commandDefinitions.map( ( command ) => command.id ),
		outcomes: [ defineOutcome( { id: 'curriculum-complete', evaluate: ( { time } ) => run.finalResult
			?? ( time >= 900 ? { win: false, reason: 'Training timed out.' } : null ) } ) ],
		phase: ( { time } ) => run.finalStarted === null ? 'Training' : time < run.finalStarted + 30
			? `They set off in ${formatTime( run.finalStarted + 30 - time )}`
			: `Hold for ${formatTime( run.finalStarted + 240 - time )}`,
		score: ( { win, metrics } ) => {

			const injuries = Math.max( 0, metrics.counters.injuriesByPolice - ( run.finalInjuries ?? metrics.counters.injuriesByPolice ) );
			return { stars: Number( win ) + Number( win && metrics.opinion >= 50 ) + Number( win && injuries <= 10 ), lines: [
				[ 'Public opinion', Math.round( metrics.opinion ) ], [ 'Injuries caused by police (final test)', injuries ], [ 'Arrests', metrics.counters.arrests ],
			] };

		},
		setup: async ( ctx ) => {

			const square = ctx.locations.get( 'square' ), at = ( x, y ) => ctx.spatial.walkable( [ square[ 0 ] + x, square[ 1 ] + y ], 30 ) ?? [ square[ 0 ] + x, square[ 1 ] + y ];
			ctx.presentation.focus( square, 0.45 );
			run.marker = ctx.spatial.walkable( [ square[ 0 ] - 20, square[ 1 ] - 20 ], 15 ) ?? [ square[ 0 ] - 20, square[ 1 ] - 20 ];
			run.door = [ - 346.6, - 1.8 ];
			run.northAt = ctx.spatial.walkable( [ - 323, 72 ], 30 ) ?? [ - 323, 72 ];
			run.waveAt = ctx.spatial.walkable( [ - 268, - 60 ], 30 ) ?? [ - 268, - 60 ];
			const work = [
				ctx.spawn.squad( { id: 'squad-1', at: at( - 10, 38 ) } ),
				ctx.spawn.squad( { id: 'squad-2', at: at( 15, - 5 ) } ),
				ctx.spawn.vehicle( { id: 'patrol-car', type: 'police-patrol', at: at( - 20, 40 ) } ),
				ctx.spawn.vehicle( { id: 'water-cannon', type: 'water-cannon', at: at( 30, - 30 ) } ),
				ctx.spawn.crowd( { id: 'demo-protesters', label: 'Students', at: at( - 30, - 25 ), people: 240, groupSize: 80, spread: 12,
					agitation: [ 0.1, 0.3 ], morale: 0.6, goal: at( - 30, - 25 ), goalRadius: 18, mode: 'hold' } ),
				ctx.spawn.bystanders( { id: 'onlookers', people: 300, destinations: [ 'square', 'police' ] } ),
			];
			const outcomes = await Promise.all( work.map( ( operation ) => operation.settled ) );
			if ( outcomes.some( ( outcome ) => outcome.status !== 'completed' ) ) throw new Error( 'training setup: an actor could not be allocated' );

		},
		behaviors: [ curriculum( { id: 'training' } ) ],
		objectives: [ survive( { id: 'training-timeout', seconds: 900, label: 'Training', reason: 'Training preview complete.' } ) ],
	} );

};