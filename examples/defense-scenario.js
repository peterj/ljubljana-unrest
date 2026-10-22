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

export default ( { defineScenario, defineBehavior, holdBuilding, landmark, place, policeCommands, target } ) => {

	const waves = [
		{ id: 'students', at: 8, people: 2200, from: 'kongresni', label: 'Students', agitation: [ 0.1, 0.35 ] },
		{ id: 'metelkova', at: 120, people: 1800, from: 'preseren', label: 'Metelkova bloc', agitation: [ 0.1, 0.35 ] },
		{ id: 'cyclists', at: 190, people: 450, from: 'preseren', label: 'Friday cyclists', bikes: 1, agitation: [ 0.1, 0.35 ] },
		{ id: 'radicals', at: 250, people: 1100, from: 'station', label: 'Radicals', agitation: [ 0.5, 0.8 ], morale: 0.8 },
		{ id: 'unions', at: 400, people: 2600, from: 'kongresni', label: 'Trade unions', agitation: [ 0.1, 0.35 ] },
		{ id: 'late', at: 560, people: 1500, from: 'finance', label: 'Late arrivals', agitation: [ 0.1, 0.35 ] },
	];
	const arrivals = defineBehavior( {
		id: 'defense-arrivals',
		create() {

			let rally, approach;
			return { start( ctx ) {

				const building = ctx.targets.get( 'assembly' );
				rally = ctx.locations.get( 'square' );
				approach = ctx.spatial.walkable( building.exits[ 0 ], 30 );
				if ( ! approach ) throw new Error( 'No connected street near the Assembly entrance' );
				for ( const wave of waves ) {

					ctx.timeline.after( Math.max( 0, wave.at - 30 ), () => ctx.presentation.notice( `${wave.label}: ${wave.people} people arriving`, 'warn', wave.from ) );
					ctx.timeline.after( wave.at, () => ctx.spawn.crowd( { id: wave.id, label: wave.label, at: wave.from,
						people: wave.people, groupSize: 100, spread: 50, agitation: wave.agitation, morale: wave.morale ?? 0.55,
						bikes: wave.bikes ?? 0, goal: wave.id === 'radicals' ? approach : rally, goalRadius: wave.id === 'radicals' ? 5 : 35 } ) );

				}

			} };

		},
	} );
	return defineScenario( {
		id: 'assembly-rules', menu: false, title: 'Assembly Rules Preview', subtitle: 'Hold the building and exits',
		brief: 'Students, cyclists, unions and radicals arrive near the National Assembly. Hold the building for twelve minutes and keep an evacuation exit open.',
		goals: [ 'Hold for 12:00', 'Prevent a facade breach', 'Keep an exit open' ],
		score: ( { win, metrics } ) => {

			const second = win && metrics.opinion >= 45, third = win && metrics.counters.injuriesByPolice <= 25;
			return { stars: Number( win ) + Number( second ) + Number( third ), lines: [
				[ 'Public opinion', Math.round( metrics.opinion ) ], [ 'Injuries caused by police', metrics.counters.injuriesByPolice ],
				[ 'Officers injured', metrics.counters.officersInjured ], [ 'Arrests', metrics.counters.arrests ], [ 'Tear gas used', metrics.counters.gasUsed ],
			] };

		},
		resources: { gas: { capacity: 4 }, water: { capacity: 4 }, reinforce: { capacity: 3, cooldown: 15 } },
		commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true } ),
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

		}, behaviors: [ arrivals( { id: 'arrivals' } ) ],
		objectives: [ holdBuilding( { id: 'hold', target: 'assembly', seconds: 720, exitAt: { 1: [ - 404, - 55 ] }, reason: 'The Assembly held.' } ) ],
	} );

};