export const sdkVersion = 1;

export default ( { defineScenario, followRoute, place, survive } ) => defineScenario( {
	id: 'route-escort', menu: false,
	title: 'Route Escort: SDK Preview',
	subtitle: 'An autonomous escort with player detours',
	brief: 'The escort follows a circuit of Trg republike. Select it and give a move order to take a detour; it resumes the route after reaching your destination.',
	goals: [ 'Keep the escort on the square for 2:00' ],
	locations: { square: place( 'Trg republike' ) },
	setup( ctx ) {

		ctx.presentation.focus( 'square', 0.5 );
		ctx.spawn.squad( { id: 'escort', at: 'square', people: 24 } );

	},
	behaviors: [ followRoute( { id: 'escort-route', actor: 'escort', relativeTo: 'square',
		waypoints: [ [ 30, 0 ], [ 30, 30 ], [ 0, 30 ], [ 0, 0 ] ], radius: 8 } ) ],
	objectives: [ survive( { id: 'hold', seconds: 120, label: 'Escort on the square', reason: 'Escort exercise complete.' } ) ],
} );