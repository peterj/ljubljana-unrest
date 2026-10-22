export const sdkVersion = 1;

export default ( { defineScenario, defineBehavior, followRoute, place, protect } ) => {

	const recover = defineBehavior( {
		id: 'recover-person',
		create() {

			return { observe( ctx, sample ) {

				const handle = ctx.protected.resolve( 'speaker' ), current = ctx.protected.get( handle );
				if ( current.state !== 'down' || ! current.position ) return;
				const distance = ( person ) => Math.hypot( person.position[ 0 ] - current.position[ 0 ], person.position[ 1 ] - current.position[ 1 ] );
				const candidates = ctx.people.members( 'support' ).filter( ( person ) => person.status === 'active' && distance( person ) <= 20 );
				candidates.sort( ( first, second ) => distance( first ) - distance( second ) );
				if ( candidates.length ) ctx.protected.transfer( handle, { carrier: candidates[ 0 ].handle, promote: true, radius: 20,
					expectedRevision: current.revision, expectedSample: sample.sequence } );

			} };

		},
	} );
	return defineScenario( {
		id: 'protect-person', menu: false,
		title: 'Protected Person: SDK Preview',
		subtitle: 'Keep the Speaker safe on Trg republike',
		brief: 'The Speaker crosses the square with a support squad nearby. Pursuers wait to the north-east. Keep supporters close: a downed Speaker can be carried, but sustained hostile pressure means capture.',
		goals: [ 'Protect the Speaker for 1:30', 'Prevent capture or death' ],
		locations: { square: place( 'Trg republike' ) },
		setup( ctx ) {

			const [ squareX, squareY ] = ctx.locations.get( 'square' );
			ctx.presentation.focus( 'square', 0.5 );
			ctx.spawn.squad( { id: 'speaker-group', at: 'square', people: 1 } );
			ctx.spawn.squad( { id: 'support', at: [ squareX + 8, squareY + 4 ], people: 8 } );
			ctx.spawn.crowd( { id: 'pursuers', at: [ squareX + 100, squareY + 80 ], people: 6, spread: 4 } );
			ctx.protected.create( { id: 'speaker', label: 'SPEAKER', kind: 'person', carrier: 'speaker-group',
				protection: { friendly: [ 'speaker-group', 'support' ], hostile: [ 'pursuers' ], radius: 20, recoveryMinimum: 2 } } );

		},
		behaviors: [ followRoute( { id: 'speaker-route', protected: 'speaker', relativeTo: 'square',
			waypoints: [ [ 20, 0 ], [ 20, 20 ], [ 0, 20 ], [ 0, 0 ] ], radius: 8 } ), recover( { id: 'recovery' } ) ],
		objectives: [ protect( { id: 'save', protected: 'speaker', seconds: 90, label: 'Protect the Speaker', reason: 'The Speaker is safe.' } ) ],
	} );

};