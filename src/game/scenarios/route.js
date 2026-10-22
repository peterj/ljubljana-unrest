import { check, defineBehavior, fields } from './definition.js';

export const followRoute = defineBehavior( {
	id: 'follow-route',
	validate( options ) {

		fields( options, [ 'id', 'actor', 'protected', 'waypoints', 'radius', 'relativeTo' ], 'followRoute' );
		check( ( typeof options.actor === 'string' && options.actor.length > 0 && options.protected === undefined )
			|| ( typeof options.protected === 'string' && options.protected.length > 0 && options.actor === undefined ), 'followRoute.actor', 'must select exactly one actor or protected identity ID' );
		check( Array.isArray( options.waypoints ) && options.waypoints.length > 0, 'followRoute.waypoints', 'must be a non-empty route' );
		check( options.radius === undefined || ( Number.isFinite( options.radius ) && options.radius > 0 && options.radius <= 100 ), 'followRoute.radius', 'must be positive and at most 100 meters' );
		check( options.relativeTo === undefined || typeof options.relativeTo === 'string', 'followRoute.relativeTo', 'must be a location alias' );

	},
	create( options ) {

		let actor, entity, waypoints, index = 0, detouring = false, operation;
		const radius = options.radius ?? 8;
		const issue = ( ctx ) => {

			if ( ! actor ) return;
			if ( index >= waypoints.length ) { ctx.complete(); return; }
			operation = ctx.movement.move( actor, waypoints[ index ], { radius } );
			return operation;

		};
		return {
			start( ctx ) {

				entity = options.protected === undefined ? null : ctx.protected.resolve( options.protected );
				const current = entity ? ctx.protected.get( entity ) : null;
				actor = entity ? ( [ 'active', 'carried' ].includes( current.state ) ? current.actor : null ) : ctx.actors.resolve( options.actor );
				const origin = options.relativeTo === undefined ? [ 0, 0 ] : ctx.locations.get( options.relativeTo );
				waypoints = options.waypoints.map( ( reference ) => {

					const at = ctx.locations.get( reference );
					return typeof reference === 'string' ? at : [ at[ 0 ] + origin[ 0 ], at[ 1 ] + origin[ 1 ] ];

				} );
				return issue( ctx )?.settled.then( () => {} );

			},
			observe( ctx ) {

				if ( ! detouring && operation?.state === 'rejected' ) issue( ctx );

			},
			onEvent( ctx, event ) {

				if ( entity && event.entity === entity ) {

					if ( actor ) ctx.movement.stop( actor );
					if ( event.type === 'protected.removed' ) { ctx.complete(); return; }
					const current = ctx.protected.get( entity );
					if ( [ 'captured', 'dead', 'exited' ].includes( current.state ) ) { ctx.complete(); return; }
					actor = current.actor;
					detouring = false; operation = null;
					issue( ctx );
					return;

				}
				if ( event.actor !== actor ) return;
				if ( event.type === 'player.move' ) { detouring = true; return; }
				if ( event.type !== 'movement.arrived' ) return;
				if ( event.source !== 'player' && event.owner !== ctx.id ) return;
				if ( event.source === 'player' ) {

					detouring = false;
					const center = ctx.actors.get( actor )?.center;
					if ( ! center ) return;
					let nearest = index, distance = Infinity;
					for ( let candidate = index; candidate < waypoints.length; candidate ++ ) {

						const gap = Math.hypot( waypoints[ candidate ][ 0 ] - center[ 0 ], waypoints[ candidate ][ 1 ] - center[ 1 ] );
						if ( gap < distance ) { nearest = candidate; distance = gap; }

					}
					index = distance <= radius ? nearest + 1 : nearest;

				} else if ( ! detouring ) index ++;
				issue( ctx );

			},
		};

	},
} );