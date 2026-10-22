import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export const sdkVersion = 1;

export default ( { defineScenario, defineBehavior, followRoute, place, survive }: typeof Sdk ) => {

	const changeEscort = defineBehavior( {
		id: 'change-escort',
		create() {

			return { start( ctx ) {

				const person = ctx.people.members( 'escort' ).find( ( member ) => member.leader && member.status === 'active' ).handle;
				ctx.timeline.after( 10, () => {

					const state = ctx.people.state( person );
					const result = ctx.people.transfer( person, { to: 'relief', promote: true,
						expectedRevision: state.revision, expectedSample: ctx.observation.sequence } );
					if ( result.status === 'completed' ) ctx.complete();

				} );

			} };

		},
	} );
	return defineScenario( {
		id: 'person-transfer', menu: false,
		title: 'Person Transfer: SDK Preview',
		subtitle: 'The same person, a new escort group',
		brief: 'The leader carrying the VIP credential changes escort groups after ten seconds. The original group chooses a replacement leader, the new group follows the same person, and the route continues.',
		goals: [ 'Keep the VIP credential on the square for 2:00' ],
		locations: { square: place( 'Trg republike' ) },
		setup( ctx ) {

			const [ squareX, squareY ] = ctx.locations.get( 'square' );
			ctx.presentation.focus( 'square', 0.45 );
			ctx.spawn.squad( { id: 'escort', at: 'square', people: 8 } );
			ctx.spawn.squad( { id: 'relief', at: [ squareX + 10, squareY + 6 ], people: 12 } );
			ctx.protected.create( { id: 'credential', label: 'VIP', carrier: 'escort' } );

		},
		behaviors: [ followRoute( { id: 'vip-route', protected: 'credential', relativeTo: 'square',
			waypoints: [ [ 20, 0 ], [ 20, 20 ], [ 0, 20 ], [ 0, 0 ] ], radius: 8 } ), changeEscort( { id: 'handoff' } ) ],
		objectives: [ survive( { id: 'hold', seconds: 120, label: 'VIP on the square', reason: 'Escort transfer complete.' } ) ],
	} );

};