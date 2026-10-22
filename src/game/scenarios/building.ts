import { check } from './definition.ts';

export function advanceBuilding( previous, measurement, dt ) {

	check( Number.isFinite( dt ) && dt >= 0, 'building.dt', 'must be non-negative and finite' );
	check( Number.isInteger( measurement.facade ) && measurement.facade >= 0, 'building.facade', 'must be a non-negative count' );
	check( Array.isArray( measurement.exits ) && measurement.exits.length > 0
		&& Array.from( measurement.exits as number[] ).every( ( count ) => Number.isInteger( count ) && count >= 0 ), 'building.exits', 'must be a dense non-empty array of counts' );
	const blocked = measurement.exits.map( ( count, index ) => count >= ( previous.blocked[ index ] ? 12 : 20 ) );
	const allBlocked = blocked.every( Boolean );
	return Object.freeze( {
		breach: Math.max( 0, Math.min( 1, previous.breach + ( measurement.facade > 20 ? Math.min( 0.025, ( measurement.facade - 20 ) / 2500 ) : - 0.015 ) * dt ) ),
		evacuation: Math.max( 0, Math.min( 1, previous.evacuation + ( allBlocked ? dt / 45 : - dt / 90 ) ) ),
		blocked: Object.freeze( blocked ), facade: measurement.facade,
	} );

}