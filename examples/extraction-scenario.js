export const sdkVersion = 1;

export default ( { defineScenario, defineBehavior, extract, place } ) => {

	const escape = defineBehavior( {
		id: 'pickup-and-extract',
		create() {

			let subject, car, phase = 'pickup', movement;
			return {
				start( ctx ) {

					subject = ctx.protected.resolve( 'speaker' ); car = ctx.vehicles.resolve( 'rescue-car' );
					const [ squareX, squareY ] = ctx.locations.get( 'square' );
					const drive = ctx.vehicles.drive( car, [ squareX - 20, squareY - 45 ], { expectedRevision: ctx.vehicles.get( car ).revision } );
					if ( drive.status !== 'completed' ) throw new Error( `Pickup route unavailable: ${drive.code}` );
					movement = ctx.vehicles.get( car ).position;
					return ctx.movement.move( ctx.protected.get( subject ).actor, movement, { radius: 4 } ).settled.then( () => {} );

				},
				observe( ctx, sample ) {

					const person = ctx.protected.get( subject ), vehicle = ctx.vehicles.get( car );
					if ( person.state === 'aboard' && phase !== 'exit' ) {

						const drive = ctx.vehicles.drive( car, 'exit', { expectedRevision: vehicle.revision } );
						if ( drive.status === 'completed' ) phase = 'exit';
						return;

					}
					if ( phase === 'exit' ) {

						if ( ! vehicle.moving && person.state === 'aboard' ) ctx.vehicles.exit( subject, { expectedRevision: person.revision, at: 'exit', radius: 50 } );
						return;

					}
					if ( ! [ 'active', 'carried' ].includes( person.state ) ) return;
					if ( ! vehicle.moving && person.position && Math.hypot( person.position[ 0 ] - vehicle.position[ 0 ], person.position[ 1 ] - vehicle.position[ 1 ] ) <= 7 ) {

						ctx.vehicles.board( subject, car, { expectedRevision: person.revision,
							expectedVehicleRevision: vehicle.revision, expectedSample: sample.sequence } );
						return;

					}
					if ( ! movement || Math.hypot( movement[ 0 ] - vehicle.position[ 0 ], movement[ 1 ] - vehicle.position[ 1 ] ) > 5 ) {

						const result = ctx.movement.move( person.actor, vehicle.position, { radius: 4 } );
						if ( result.state !== 'rejected' ) movement = vehicle.position;

					}

				},
				onEvent( ctx, event ) {

					if ( event.type === 'transport.boarding' && event.entity === subject ) {

						const actor = ctx.people.state( ctx.protected.get( subject ).subject ).actor;
						ctx.movement.stop( actor );

					}
					if ( event.type === 'player.move' ) movement = null;

				},
			};

		},
	} );
	return defineScenario( {
		id: 'vehicle-extraction', menu: false, title: 'Vehicle Extraction: SDK Preview', subtitle: 'A moving pickup and confirmed escape',
		brief: 'The pickup moves south of Trg republike. The Speaker follows it, boards when it parks, and escapes to Kongresni trg. A moving car cannot board passengers.',
		goals: [ 'Get the Speaker into the rescue car', 'Reach the exit within 3:00' ],
		locations: { square: place( 'Trg republike' ), exit: place( 'Kongresni trg' ) },
		setup( ctx ) {

			const [ squareX, squareY ] = ctx.locations.get( 'square' );
			ctx.presentation.focus( 'square', 0.65 );
			ctx.spawn.squad( { id: 'speaker-group', at: 'square', people: 1 } );
			ctx.spawn.squad( { id: 'support', at: [ squareX + 10, squareY ], people: 6 } );
			ctx.spawn.crowd( { id: 'hostile', at: [ squareX + 150, squareY + 150 ], people: 4, spread: 5 } );
			ctx.spawn.vehicle( { id: 'rescue-car', label: 'Rescue car', at: [ squareX - 20, squareY ], capacity: 2 } );
			ctx.protected.create( { id: 'speaker', kind: 'person', label: 'SPEAKER', carrier: 'speaker-group',
				protection: { friendly: [ 'speaker-group', 'support' ], hostile: [ 'hostile' ] } } );

		}, behaviors: [ escape( { id: 'escape' } ) ],
		objectives: [ extract( { id: 'escape', protected: 'speaker', at: 'exit', radius: 50, seconds: 180 } ) ],
	} );

};