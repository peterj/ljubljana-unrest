export const sdkVersion = 1;

function inRing( ring, x, y ) {

	let inside = false;
	const count = ring.length / 2;
	for ( let current = 0, previous = count - 1; current < count; previous = current ++ ) {

		const x0 = ring[ current * 2 ], y0 = ring[ current * 2 + 1 ], x1 = ring[ previous * 2 ], y1 = ring[ previous * 2 + 1 ];
		if ( ( y0 > y ) !== ( y1 > y ) && x < ( x1 - x0 ) * ( y - y0 ) / ( y1 - y0 ) + x0 ) inside = ! inside;

	}
	return inside;

}

function formatTime( seconds ) {

	const value = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( value / 60 )}:${String( value % 60 ).padStart( 2, '0' )}`;

}

const FORCE_REACTIONS = Object.freeze( {
	charge: Object.freeze( { radius: 45, agitation: 0.2, label: 'Baton charge' } ),
	kettle: Object.freeze( { radius: 50, agitation: 0.25, label: 'Kettle' } ),
	gas: Object.freeze( { radius: 60, agitation: 0.25, label: 'Tear gas' } ),
	water: Object.freeze( { radius: 50, agitation: 0.2, label: 'Water cannon' } ),
	arrest: Object.freeze( { radius: 35, agitation: 0.12, label: 'Arrests' } ),
	snatch: Object.freeze( { radius: 35, agitation: 0.12, label: 'Snatch squad' } ),
	'shield-push': Object.freeze( { radius: 40, agitation: 0.15, label: 'Shield push' } ),
} );

function injuryCounts( observation ) {

	const counts = new Map();
	for ( const person of observation?.people ?? [] ) if ( person.faction === 'protester' && [ 'injured', 'detained' ].includes( person.status ) ) {
		counts.set( person.actor.id, ( counts.get( person.actor.id ) ?? 0 ) + 1 );
	}
	return counts;

}

export default ( { defineScenario, defineBehavior, defineOutcome, holdBuilding, landmark, place, policeCommands, target } ) => {

	const waves = [
		{ id: 'students', at: 8, people: 2200, from: 'kongresni', label: 'Students', agitation: [ 0.1, 0.35 ] },
		{ id: 'metelkova', at: 120, people: 1800, from: 'preseren', label: 'Metelkova bloc', agitation: [ 0.1, 0.35 ] },
		{ id: 'cyclists', at: 190, people: 450, from: 'preseren', label: 'Friday cyclists', bikes: 1, agitation: [ 0.1, 0.35 ] },
		{ id: 'radicals', at: 250, people: 1100, from: 'station', label: 'Radicals', agitation: [ 0.5, 0.8 ], morale: 0.8 },
		{ id: 'unions', at: 400, people: 2600, from: 'kongresni', label: 'Trade unions', agitation: [ 0.1, 0.35 ] },
		{ id: 'late', at: 560, people: 1500, from: 'finance', label: 'Late arrivals', agitation: [ 0.1, 0.35 ] },
	];
	const arrivals = defineBehavior( {
		id: 'assembly-director',
		create() {

			const groups = new Map();
			let rally, targets, nextDirectorAt = 20;
			const move = ( ctx, state, at, radius ) => {

				state.goalKind = at === state.rally ? 'rally' : 'target';
				return ctx.movement.move( state.actor, at, { radius } );

			};
			return {
				start( ctx ) {

				const building = ctx.spatial.buildingGeometry( 'assembly', { 1: [ - 404, - 55 ] } ), outer = building.footprints[ 0 ];
				rally = ctx.locations.get( 'square' );
				const edges = [];
				for ( let index = 0; index < outer.length; index += 2 ) {

					const ax = outer[ index ], ay = outer[ index + 1 ], bx = outer[ ( index + 2 ) % outer.length ], by = outer[ ( index + 3 ) % outer.length ];
					edges.push( { length: Math.hypot( bx - ax, by - ay ), x: ( ax + bx ) / 2, y: ( ay + by ) / 2 } );

				}
				targets = edges.sort( ( first, second ) => second.length - first.length ).slice( 0, 4 ).map( ( edge ) => {

					const dx = edge.x - building.position[ 0 ], dy = edge.y - building.position[ 1 ], distance = Math.hypot( dx, dy ) || 1;
					const at = [ edge.x + dx / distance * 5, edge.y + dy / distance * 5 ];
					return ctx.spatial.walkable( at, 8 ) ?? at;

				} ).concat( building.exits );
				for ( const wave of waves ) {

					const from = ctx.locations.get( wave.from ), agitation = wave.agitation ?? [ 0.1, 0.35 ], angry = agitation[ 0 ] > 0.45;
					ctx.timeline.after( Math.max( 0, wave.at - 30 ), () => ctx.presentation.notice( `${wave.label}: ${wave.people} people arriving`, 'warn', from ) );
					ctx.timeline.after( wave.at, () => {

						for ( let offset = 0, index = 0; offset < wave.people; offset += 100, index ++ ) {

							const people = Math.min( 100, wave.people - offset ), at = angry ? targets[ Math.floor( ctx.random() * targets.length ) ] : rally;
							const operation = ctx.spawn.crowd( { id: `${wave.id}-${String( index + 1 ).padStart( 2, '0' )}`, label: wave.label,
								at: from, people, groupSize: 100, spread: 50, agitation, morale: wave.morale ?? 0.55, bikes: wave.bikes ?? 0,
								goal: at, goalRadius: angry ? 12 : 35 } );
							operation.settled.then( ( outcome ) => {

								if ( outcome.status === 'completed' ) groups.set( outcome.value, { actor: outcome.value, label: wave.label,
									rally, target: angry ? at : null, goalKind: angry ? 'target' : 'rally', committedAt: angry ? ctx.time : 0 } );

							} );

						}
						ctx.presentation.notice( `${wave.label} set off from ${wave.from}`, angry ? 'bad' : 'warn', from );

					} );

				}

			},
				update( ctx ) {

					if ( ctx.time < nextDirectorAt ) return;
					nextDirectorAt += 20;
					for ( const state of groups.values() ) {

						const actor = ctx.actors.get( state.actor ), people = ctx.people.members( state.actor ).filter( ( person ) => person.status === 'active' );
						if ( ! actor?.center || ! people.length || ctx.random() < 0.5 ) continue;
						const agitation = people.reduce( ( total, person ) => total + person.agitation, 0 ) / people.length;
						const committed = state.goalKind === 'target', sticky = committed && ctx.time - state.committedAt < 120;
						if ( ! sticky && agitation < ( committed ? 0.25 : 0.45 ) ) {

							if ( state.goalKind !== 'rally' ) move( ctx, state, state.rally, 35 );
							continue;

						}
						const riot = agitation > 0.65;
						if ( committed && ctx.random() < 0.7 ) {

							if ( riot ) ctx.crowd.setMode( state.actor, 'riot' );
							continue;

						}
						if ( ! committed ) {

							state.committedAt = ctx.time;
							ctx.presentation.notice( `${state.label}: an angry group is heading for the building`, 'warn', actor.center );

						}
						let best = targets[ 0 ], bestScore = Infinity;
						for ( const candidate of targets ) {

							const guards = ctx.spatial.count( { at: candidate, radius: 25, faction: 'police' } ) ?? 0;
							const score = guards + Math.hypot( candidate[ 0 ] - actor.center[ 0 ], candidate[ 1 ] - actor.center[ 1 ] ) / 3 + ctx.random() * 25;
							if ( score < bestScore ) { best = candidate; bestScore = score; }

						}
						state.target = best;
						const order = move( ctx, state, best, 10 );
						if ( riot ) order.settled.then( ( outcome ) => {

							if ( outcome.status === 'completed' && ! ctx.signal.aborted ) ctx.crowd.setMode( state.actor, 'riot' );

						} ).catch( () => {} );

					}

				},
			};

		},
	} );
	const reactions = defineBehavior( {
		id: 'assembly-force-and-injury-reactions',
		create() {

			let previousHurt = new Map(), lastNotice = - 99;
			return {
				start( ctx ) {

					const counts = injuryCounts( ctx.observation );
					previousHurt = new Map( ( ctx.observation?.actors ?? [] ).filter( ( actor ) => actor.handle.kind === 'crowd' )
						.map( ( actor ) => [ actor.handle.id, counts.get( actor.handle.id ) ?? 0 ] ) );

				},
				onEvent( ctx, event ) {

					const reaction = FORCE_REACTIONS[ event.command ];
					if ( event.type !== 'command.applied' || ! reaction || ! event.at ) return;
					let affected = 0;
					for ( const actor of ctx.observation?.actors ?? [] ) {

						if ( actor.handle.kind !== 'crowd' || ! actor.center || Math.hypot( actor.center[ 0 ] - event.at[ 0 ], actor.center[ 1 ] - event.at[ 1 ] ) >= reaction.radius ) continue;
						const active = ctx.people.members( actor.handle ).filter( ( person ) => person.faction === 'protester' && person.status === 'active' );
						if ( ! active.length ) continue;
						const result = ctx.crowd.nudge( actor.handle, { agitation: reaction.agitation } );
						if ( result.status !== 'completed' ) continue;
						if ( reaction.agitation >= 0.2 ) ctx.crowd.setMode( actor.handle, 'riot' );
						affected += result.people ?? active.length;

					}
					if ( affected > 50 && ctx.time - lastNotice > 10 ) {

						lastNotice = ctx.time;
						ctx.presentation.notice( `${reaction.label}: ~${affected} people around it turn on the police`, 'bad', event.at );

					}

				},
				observe( ctx, sample ) {

					const counts = injuryCounts( sample ), protesters = new Set( sample.people.filter( ( person ) => person.faction === 'protester' ).map( ( person ) => person.actor.id ) );
					for ( const actor of sample.actors ) {

						if ( actor.handle.kind !== 'crowd' || ! protesters.has( actor.handle.id ) ) continue;
						const current = counts.get( actor.handle.id ) ?? 0, previous = previousHurt.get( actor.handle.id ) ?? 0;
						previousHurt.set( actor.handle.id, current );
						const fresh = current - previous;
						if ( fresh <= 0 || ! actor.center ) continue;
						const agitation = Math.min( 0.35, 0.1 * fresh );
						ctx.crowd.nudge( actor.handle, { agitation, resolve: 0.05 } );
						for ( const neighbor of sample.actors ) {

							if ( neighbor.handle.id === actor.handle.id || neighbor.handle.kind !== 'crowd' || ! protesters.has( neighbor.handle.id ) || ! neighbor.center
								|| Math.hypot( neighbor.center[ 0 ] - actor.center[ 0 ], neighbor.center[ 1 ] - actor.center[ 1 ] ) >= 50 ) continue;
							ctx.crowd.nudge( neighbor.handle, { agitation: agitation / 2 } );

						}

					}

				},
			};

		},
	} );
	return defineScenario( {
		id: 'assembly-rules', menu: false, title: 'Assembly Rules Preview', subtitle: 'Hold the building and exits',
		brief: 'Students, cyclists, unions and radicals arrive near the National Assembly. Hold the building for twelve minutes and keep an evacuation exit open.',
		goals: [ 'Hold for 12:00', 'Prevent a facade breach', 'Keep an exit open' ],
		phase: ( { time } ) => {

			const wave = waves.find( ( entry ) => entry.at > time );
			if ( ! wave ) return `Hold out · ${formatTime( 720 - time )} left`;
			const from = { kongresni: 'Kongresni trg', preseren: 'Prešernov trg', station: 'PU Ljubljana', finance: 'Ministrstvo za finance' }[ wave.from ];
			return `Next: ${wave.label} from ${from} in ${formatTime( wave.at - time )}`;

		},
		indicators: [ { id: 'police-injuries', label: '★ Injuries caused by police ≤ 25', counter: 'injuriesByPolice', maximum: 25, warnAt: 15 } ],
		outcomes: [
			defineOutcome( { id: 'facade-breach', evaluate: ( { building } ) => building?.breach >= 1
				? { win: false, reason: 'Protesters forced their way into Državni zbor.' } : null } ),
			defineOutcome( { id: 'evacuation-blocked', evaluate: ( { building } ) => building?.evacuation >= 1
				? { win: false, reason: 'Every exit was blocked - the evacuation could not proceed.' } : null } ),
		],
		score: ( { win, metrics } ) => {

			const second = win && metrics.opinion >= 45, third = win && metrics.counters.injuriesByPolice <= 25;
			const lines = [
				[ 'Public opinion', Math.round( metrics.opinion ) ], [ 'Injuries caused by police', metrics.counters.injuriesByPolice ],
				[ 'Officers injured', metrics.counters.officersInjured ], [ 'Arrests', metrics.counters.arrests ], [ 'Tear gas used', metrics.counters.gasUsed ],
			];
			let stars = Number( win ) + Number( second ) + Number( third );
			if ( metrics.escalation >= 4 ) { stars = Math.min( stars, 1 ); lines.push( [ 'Firearms used', 'yes - maximum star cap' ] ); }
			return { stars, lines };

		},
		resources: { gas: { capacity: 4 }, water: { capacity: 4 }, reinforce: { capacity: 3, cooldown: 15 } },
		commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true, firearms: true } ),
		locations: { assembly: target( 'Državni zbor' ), square: place( 'Trg republike' ), kongresni: place( 'Kongresni trg' ),
			preseren: place( 'Prešernov trg' ), metelkova: place( 'Metelkova' ), railway: landmark( 'Železniška postaja' ),
			tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ),
			station: landmark( 'PU Ljubljana' ), finance: landmark( 'Ministrstvo za finance' ) },
		setup( ctx ) {

			const building = ctx.spatial.buildingGeometry( 'assembly', { 1: [ - 404, - 55 ] } ), outer = building.footprints[ 0 ];
			ctx.presentation.focus( 'assembly', 0.55 );
			ctx.spawn.vehicle( { id: 'water-cannon', label: 'Water cannon', type: 'water-cannon', at: ctx.spatial.walkable( building.exits[ 0 ], 30 ) } );
			ctx.spawn.vehicle( { id: 'patrol-1', type: 'police-patrol', at: building.exits[ 1 ] } );
			ctx.spawn.vehicle( { id: 'patrol-2', type: 'police-patrol', at: building.exits[ 2 ] } );
			const ring = Array.from( { length: 6 }, ( _, index ) => {

				const angle = index / 6 * Math.PI * 2, x = Math.cos( angle ), y = Math.sin( angle );
				let distance = 0;
				while ( distance < building.radius * 2 && inRing( outer, building.position[ 0 ] + x * distance, building.position[ 1 ] + y * distance ) ) distance ++;
				const at = [ building.position[ 0 ] + x * ( distance + 14 ), building.position[ 1 ] + y * ( distance + 14 ) ];
				return ctx.spatial.walkable( at, 30 ) ?? at;

			} );
			for ( const [ index, at ] of [ ...ring, ...building.exits, ...ring.slice( 0, 3 ) ].entries() ) {

				ctx.spawn.squad( { id: `guard-${index + 1}`, at, people: 30 } );

			}
			ctx.spawn.bystanders( { id: 'onlookers', people: 2200,
				destinations: [ 'preseren', 'kongresni', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		}, behaviors: [ arrivals( { id: 'arrivals' } ), reactions( { id: 'force-and-injuries' } ) ],
		objectives: [ holdBuilding( { id: 'hold', target: 'assembly', seconds: 720, exitAt: { 1: [ - 404, - 55 ] }, reason: 'The Assembly held.' } ) ],
	} );

};