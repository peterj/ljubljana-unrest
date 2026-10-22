import type { Vec2 } from '../../sim/world.ts';

// a polyline with cumulative segment lengths (see polyline)
export interface Polyline { pts: Vec2[], cum: number[], len: number }

// rings are flat [ x0, y0, x1, y1, … ] footprints
export function ringDist( r: ArrayLike<number>, x: number, y: number ): number {

	let best = Infinity;
	for ( let k = 0; k < r.length; k += 2 ) {

		const ax = r[ k ], ay = r[ k + 1 ], bx = r[ ( k + 2 ) % r.length ], by = r[ ( k + 3 ) % r.length ];
		const dx = bx - ax, dy = by - ay;
		const t = Math.max( 0, Math.min( 1, ( ( x - ax ) * dx + ( y - ay ) * dy ) / ( dx * dx + dy * dy || 1 ) ) );
		best = Math.min( best, Math.hypot( x - ax - t * dx, y - ay - t * dy ) );

	}

	return best;

}

export function inPoly( r: ArrayLike<number>, x: number, y: number ): boolean {

	let inside = false;
	for ( let k = 0, j = r.length - 2; k < r.length; j = k, k += 2 ) {

		const ax = r[ k ], ay = r[ k + 1 ], bx = r[ j ], by = r[ j + 1 ];
		if ( ( ay > y ) !== ( by > y ) && x < ( bx - ax ) * ( y - ay ) / ( by - ay ) + ax ) inside = ! inside;

	}

	return inside;

}

export const near = ( a: ArrayLike<number>, b: ArrayLike<number>, r: number ): boolean => ( a[ 0 ] - b[ 0 ] ) ** 2 + ( a[ 1 ] - b[ 1 ] ) ** 2 < r * r;


// point at distance s along a polyline of [ x, y ] pairs with cumulative lengths cum
export function along( pts: ArrayLike<number>[], cum: number[], s: number ): Vec2 {

	s = Math.max( 0, Math.min( cum.at( - 1 ), s ) );
	let k = 1;
	while ( k < pts.length - 1 && cum[ k ] < s ) k ++;
	const t = ( s - cum[ k - 1 ] ) / ( cum[ k ] - cum[ k - 1 ] || 1 );
	return [ pts[ k - 1 ][ 0 ] + ( pts[ k ][ 0 ] - pts[ k - 1 ][ 0 ] ) * t, pts[ k - 1 ][ 1 ] + ( pts[ k ][ 1 ] - pts[ k - 1 ][ 1 ] ) * t ];

}

export function polyline( pts: Vec2[] ): Polyline {

	const cum = [ 0 ];
	for ( let k = 1; k < pts.length; k ++ ) cum.push( cum[ k - 1 ] + Math.hypot( pts[ k ][ 0 ] - pts[ k - 1 ][ 0 ], pts[ k ][ 1 ] - pts[ k - 1 ][ 1 ] ) );
	return { pts, cum, len: cum.at( - 1 ) };

}

// distance along a polyline of the point nearest to (x, y)
export function project( L: Polyline, x: number, y: number ): number {

	let best = Infinity, bs = 0;
	for ( let k = 1; k < L.pts.length; k ++ ) {

		const [ ax, ay ] = L.pts[ k - 1 ], [ bx, by ] = L.pts[ k ];
		const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
		const t = Math.max( 0, Math.min( 1, ( ( x - ax ) * dx + ( y - ay ) * dy ) / l2 ) );
		const d = ( x - ax - t * dx ) ** 2 + ( y - ay - t * dy ) ** 2;
		if ( d < best ) { best = d; bs = L.cum[ k - 1 ] + t * Math.sqrt( l2 ); }

	}

	return bs;

}
