import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export const sdkVersion = 1;

export default ( { defineScenario, defineBehavior, followRoute, place, survive }: typeof Sdk ) => {

	const handoff = defineBehavior( {
		id: 'banner-handoff',
		create() {

			let banner;
			return {
				start( ctx ) {

					banner = ctx.protected.resolve( 'banner' );
					ctx.timeline.after( 10, () => {

						const current = ctx.protected.get( banner );
						if ( current.state === 'carried' ) ctx.protected.drop( banner, {
							expectedRevision: current.revision, expectedSample: ctx.observation.sequence,
						} );

					} );

				},
				observe( ctx, sample ) {

					const current = ctx.protected.get( banner );
					if ( sample.sampledAt < 18 || current.state !== 'dropped' || ! current.position ) return;
					const distance = ( person ) => Math.hypot( person.position[ 0 ] - current.position[ 0 ], person.position[ 1 ] - current.position[ 1 ] );
					const people = ctx.people.members( 'relief' ).filter( ( person ) => person.status === 'active' && ! person.leader && distance( person ) <= 25 );
					people.sort( ( first, second ) => distance( first ) - distance( second ) );
					if ( ! people.length ) return;
					ctx.protected.transfer( banner, { carrier: people[ 0 ].handle, promote: true, radius: 25,
						expectedRevision: current.revision, expectedSample: sample.sequence } );

				},
			};

		},
	} );
	return defineScenario( {
		id: 'carrier-handoff', menu: false,
		title: 'Carrier Handoff: SDK Preview',
		subtitle: 'One banner, changing bearers',
		brief: 'The escort carries the banner across Trg republike. After ten seconds it drops; a nearby member of the relief squad picks it up and continues its route.',
		goals: [ 'Keep the banner on the square for 2:00' ],
		locations: { square: place( 'Trg republike' ) },
		setup( ctx ) {

			const [ squareX, squareY ] = ctx.locations.get( 'square' );
			ctx.presentation.focus( 'square', 0.45 );
			ctx.spawn.squad( { id: 'escort', at: 'square', people: 8 } );
			ctx.spawn.squad( { id: 'relief', at: [ squareX + 10, squareY + 6 ], people: 12 } );
			ctx.protected.create( { id: 'banner', label: 'BANNER', carrier: 'escort' } );

		},
		behaviors: [ followRoute( { id: 'banner-route', protected: 'banner', relativeTo: 'square',
			waypoints: [ [ 20, 0 ], [ 20, 20 ], [ 0, 20 ], [ 0, 0 ] ], radius: 8 } ), handoff( { id: 'handoff' } ) ],
		objectives: [ survive( { id: 'hold', seconds: 120, label: 'Banner on the square', reason: 'Banner exercise complete.' } ) ],
	} );

};