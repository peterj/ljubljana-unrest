export function advanceClash( pressure, contacts, dt ) {

	return Math.max( 0, Math.min( 1, pressure + ( contacts > 0 ? Math.min( 0.028, contacts / 2400 ) : - 0.012 ) * dt ) );

}