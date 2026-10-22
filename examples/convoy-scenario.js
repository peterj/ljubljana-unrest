export const sdkVersion = 1;

function formatTime( seconds ) {

	const value = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( value / 60 )}:${String( value % 60 ).padStart( 2, '0' )}`;

}

export default ( { defineBehavior, defineOutcome, defineScenario, escortConvoy, landmark, place, policeCommands, target } ) => {

	const convoyState = { handle: null, departedAt: null, last: null, result: null };
	const hotspots = [
		{ id: 'celovska', fraction: 0.3, name: 'Celovška', people: 520 },
		{ id: 'bavarski', fraction: 0.6, name: 'Bavarski dvor', people: 800 },
		{ id: 'zupanciceva', fraction: 0.86, name: 'Župančičeva', people: 1000 },
	];
	const arrivals = [
		{ id: 'station-counter', at: 200, people: 600, label: 'Counter-protesters from the station', from: 'station' },
		{ id: 'tivoli-counter', at: 420, people: 500, label: 'Counter-protesters from Tivoli', from: 'tivoli' },
	];
	const director = defineBehavior( {
		id: 'convoy-director',
		create() {

			let lastHalted = - 99, lastAttack = - 99, warnedIntegrity = new Set();
			let departureTimer;
			const depart = ( ctx ) => {

				const result = ctx.convoys.depart( convoyState.handle );
				if ( result.status !== 'completed' ) return false;
				convoyState.departedAt = ctx.time;
				ctx.presentation.notice( 'Convoy is moving', 'good', ctx.convoys.at( convoyState.handle, 0 ).position );
				return true;

			};
			return {
				start( ctx ) {

					departureTimer = ctx.timeline.after( 75, () => depart( ctx ) );
					for ( const wave of arrivals ) {

						const at = ctx.locations.get( wave.from );
						ctx.timeline.after( wave.at - 30, () => ctx.presentation.notice( `${wave.label} in 0:30`, 'warn', at ) );
						ctx.timeline.after( wave.at, () => {

							for ( let offset = 0, index = 0; offset < wave.people; offset += 60, index ++ ) ctx.spawn.crowd( {
								id: `${wave.id}-${String( index + 1 ).padStart( 2, '0' )}`, label: wave.label, at, people: Math.min( 60, wave.people - offset ),
								groupSize: 60, spread: 30, faction: 'counter', agitation: [ 0.4, 0.65 ], morale: 0.8, goal: at, goalRadius: 20,
							} );
							ctx.presentation.notice( `${wave.label} have arrived`, 'bad', at );

						} );

					}

				},
				onAction( ctx, action ) {

					if ( action.type === 'key' && action.key === 'v' && convoyState.departedAt === null && depart( ctx ) ) departureTimer?.cancel();

				},
				update( ctx ) {

					const convoy = ctx.convoys.get( convoyState.handle );
					convoyState.last = convoy;
					for ( const hotspot of convoyState.hotspots ) {

						if ( hotspot.active || convoy.distance <= hotspot.distance - 320 ) continue;
						hotspot.active = true;
						for ( const actor of hotspot.actors ) {

							ctx.crowd.setMode( actor, 'march' );
							ctx.crowd.nudge( actor, { agitation: 0.2 } );

						}
						ctx.presentation.notice( `${hotspot.name}: the crowd is surging onto the road!`, 'bad', hotspot.position );

					}
					if ( convoy.moving && convoy.speed < 0.5 && ctx.time - lastHalted > 8 ) {

						lastHalted = ctx.time;
						if ( convoy.blockedFor > 0 && lastHalted === ctx.time ) ctx.presentation.notice( 'Convoy HALTED - road blocked ahead', 'bad', ctx.convoys.at( convoyState.handle, convoy.distance ).position );

					}
					if ( convoy.attackers > 0.5 && ctx.time - lastAttack > 8 ) {

						lastAttack = ctx.time;
						ctx.presentation.notice( 'VIP car under attack!', 'bad', ctx.convoys.at( convoyState.handle, convoy.distance ).position );

					}
					for ( const threshold of [ 0.75, 0.5, 0.25 ] ) if ( convoy.integrity < threshold && ! warnedIntegrity.has( threshold ) ) {

						warnedIntegrity.add( threshold );
						ctx.presentation.notice( `VIP car integrity ${threshold * 100}%`, 'bad' );

					}
					if ( convoy.integrity <= 0 ) convoyState.result = { win: false, reason: 'The VIP car was overrun.' };
					else if ( convoy.blockedFor > 75 ) convoyState.result = { win: false, reason: 'The convoy was stuck too long - the VIP was evacuated by helicopter.' };
					else if ( convoy.arrived ) convoyState.result = { win: true, reason: 'The VIP arrived at the National Assembly.' };

				},
			};

		},
	} );
	return defineScenario( {
		id: 'convoy-rules', menu: false, title: 'Convoy Rules Preview', subtitle: 'Escort the VIP to the National Assembly',
		brief: 'A foreign head of state is being driven from Brnik to the Assembly. Protesters are gathering along the route; keep the road clear and the VIP car intact.',
		goals: [ 'Get the convoy to the Assembly', 'Keep the VIP car intact', 'Avoid injuring people' ],
		tips: [ 'Position squads along the route before the scheduled departure', 'Cordon lines keep crowds off the road',
			'Patrol crews can get out and form roadblocks', 'Snatch identified leaders before they organize an attack' ],
		phase: ( { time } ) => {

			if ( convoyState.departedAt === null ) return `Convoy departs in ${formatTime( 75 - time )} - position your squads`;
			const convoy = convoyState.last;
			if ( ! convoy ) return 'Convoy preparing';
			if ( convoy.speed < 0.5 && convoy.moving ) return `CONVOY HALTED · ${formatTime( convoy.blockedFor)} / 1:15`;
			return `Convoy moving · ${Math.round( convoy.speed * 3.6 )} km/h · ${convoy.blockers} on the road ahead`;

		},
		indicators: [ { id: 'police-injuries', label: '★ Injuries caused by police ≤ 15', counter: 'injuriesByPolice', maximum: 15, warnAt: 10 } ],
		outcomes: [ defineOutcome( { id: 'convoy-result', evaluate: () => convoyState.result } ) ],
		score: ( { win, time, metrics } ) => {

			const convoy = convoyState.last, travel = convoyState.departedAt === null ? 0 : Math.max( 0, time - convoyState.departedAt );
			const second = win && convoy.integrity >= 0.6 && travel <= 360, third = win && metrics.counters.injuriesByPolice <= 15;
			return { stars: Number( win ) + Number( second ) + Number( third ), lines: [
				[ 'VIP car integrity', `${Math.round( convoy.integrity * 100 )}%` ], [ 'Travel time', formatTime( travel ) ],
				[ 'Injuries caused by police', metrics.counters.injuriesByPolice ], [ 'Officers injured', metrics.counters.officersInjured ],
				[ 'Arrests', metrics.counters.arrests ], [ 'Public opinion', Math.round( metrics.opinion ) ],
			] };

		},
		resources: { gas: { capacity: 3 }, water: { capacity: 3 }, reinforce: { capacity: 2 } },
		commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true } ),
		locations: { square: place( 'Trg republike' ), station: landmark( 'Železniška postaja' ), tivoli: place( 'Park Tivoli' ),
			police: landmark( 'PU Ljubljana' ), assembly: target( 'Državni zbor' ) },
		setup( ctx ) {

			convoyState.handle = ctx.convoys.create( { id: 'vip-convoy', vehicles: 3, vipIndex: 1 } );
			const convoy = ctx.convoys.get( 'vip-convoy' ), at = ( distance ) => ctx.convoys.at( 'vip-convoy', distance );
			ctx.presentation.focus( at( convoy.routeLength * 0.3 ).position, 1.1 );
			convoyState.departedAt = null; convoyState.last = convoy; convoyState.result = null; convoyState.hotspots = [];
			for ( const hotspot of hotspots ) {

				const point = at( convoy.routeLength * hotspot.fraction ), side = ctx.random() < 0.5 ? 1 : - 1;
				const position = ctx.spatial.walkable( [ point.position[ 0 ] + Math.cos( point.heading + side * Math.PI / 2 ) * 30,
					point.position[ 1 ] + Math.sin( point.heading + side * Math.PI / 2 ) * 30 ], 60 )
					?? [ point.position[ 0 ], point.position[ 1 ] ];
				const actors = [];
				for ( let offset = 0, index = 0; offset < hotspot.people; offset += 80, index ++ ) {

					const operation = ctx.spawn.crowd( { id: `${hotspot.id}-${String( index + 1 ).padStart( 2, '0' )}`, label: hotspot.name,
						at: position, people: Math.min( 80, hotspot.people - offset ), groupSize: 80, spread: 25, agitation: [ 0.15, 0.4 ], mode: 'hold' } );
					operation.settled.then( ( outcome ) => { if ( outcome.status === 'completed' ) actors.push( outcome.value ); } );

				}
				if ( hotspot.id === 'celovska' ) for ( let index = 0; index < 4; index ++ ) ctx.spawn.crowd( { id: `cyclists-${index + 1}`,
					label: 'Cyclists', at: position, people: 55, groupSize: 55, spread: 15, agitation: [ 0.2, 0.45 ], bikes: 1, mode: 'hold' } );
				convoyState.hotspots.push( { id: hotspot.id, name: hotspot.name, distance: convoy.routeLength * hotspot.fraction, position: point.position, actors, active: false } );

			}
			const radical = at( convoy.routeLength * 0.45 );
			ctx.spawn.crowd( { id: 'radical-cell', label: 'Radical cell', at: [ radical.position[ 0 ] - 60, radical.position[ 1 ] - 30 ],
				people: 120, groupSize: 40, spread: 15, agitation: [ 0.55, 0.8 ], morale: 0.9, mode: 'hold' } );
			ctx.spawn.crowd( { id: 'destination-crowd', label: 'Trg republike crowd', at: 'square', people: 1400, groupSize: 100, spread: 45,
				goal: 'square', goalRadius: 40, agitation: [ 0.1, 0.35 ], mode: 'hold' } );
			for ( const [ index, distance ] of [ 30, 0.55 * convoy.routeLength, convoy.routeLength - 40 ].entries() ) {

				const point = at( distance ).position;
				for ( const [ offset, delta ] of [ [ 12, 0 ], [ - 12, 0 ], [ 0, 15 ] ].entries() ) ctx.spawn.squad( { id: `escort-${index + 1}-${offset + 1}`,
					at: [ point[ 0 ] + delta[ 0 ], point[ 1 ] + delta[ 1 ] ] } );

			}
			for ( const [ index, distance ] of [ 70, 0.55 * convoy.routeLength, 0.75 * convoy.routeLength ].entries() ) {

				const point = at( distance ).position;
				ctx.spawn.vehicle( { id: `patrol-${index + 1}`, type: 'police-patrol', at: point } );

			}
			ctx.spawn.vehicle( { id: 'water-cannon', type: 'water-cannon', at: at( convoy.routeLength * 0.5 ).position } );
			ctx.spawn.bystanders( { id: 'onlookers', people: 2200, destinations: [ 'square', 'station', 'tivoli' ] } );

		},
		behaviors: [ director( { id: 'director' } ) ],
		objectives: [ escortConvoy( { id: 'vip-arrives', convoy: 'vip-convoy', seconds: 900, maxBlocked: 75 } ) ],
	} );

};