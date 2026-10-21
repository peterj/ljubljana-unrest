// Computes a navigation flow field on the 4 m cost grid: Dijkstra from the goal cells outward
// (8-connected, edge weight = mean cell cost × step length), then each cell points toward its
// cheapest neighbour, smoothed over 3×3. Output is half-float RG (dir.x, dir.y) per cell.
//
// Messages in:  { type: 'init', cost: Uint8Array, w, h }
//               { type: 'field', id, goals: [[cx, cy, radiusCells], ...] }   (cell coordinates)
// Messages out: { type: 'field', id, dirs: Uint16Array (half floats, 2 per cell) }

let W = 0, H = 0, cost = null;
let dist = null, heapIdx = null, heapKey = null;

const toHalf = ( () => {

	const f = new Float32Array( 1 ), u = new Uint32Array( f.buffer );
	return ( v ) => {

		f[ 0 ] = v;
		const x = u[ 0 ];
		const sign = ( x >> 16 ) & 0x8000;
		const e = ( ( x >> 23 ) & 0xff ) - 112;
		if ( e <= 0 ) return sign;
		return sign | ( e << 10 ) | ( ( x >> 13 ) & 0x3ff );

	};

} )();

const NB = [ [ 1, 0, 1 ], [ - 1, 0, 1 ], [ 0, 1, 1 ], [ 0, - 1, 1 ],
	[ 1, 1, Math.SQRT2 ], [ 1, - 1, Math.SQRT2 ], [ - 1, 1, Math.SQRT2 ], [ - 1, - 1, Math.SQRT2 ] ];

function compute( goals ) {

	const N = W * H;
	dist.fill( Infinity );
	let hs = 0;

	const push = ( i, d ) => {

		let k = hs ++;
		while ( k > 0 ) {

			const p = ( k - 1 ) >> 1;
			if ( heapKey[ p ] <= d ) break;
			heapKey[ k ] = heapKey[ p ]; heapIdx[ k ] = heapIdx[ p ]; k = p;

		}

		heapKey[ k ] = d; heapIdx[ k ] = i;

	};

	const pop = () => {

		const top = heapIdx[ 0 ];
		const lk = heapKey[ -- hs ], li = heapIdx[ hs ];
		let k = 0;
		for ( ;; ) {

			let c = 2 * k + 1;
			if ( c >= hs ) break;
			if ( c + 1 < hs && heapKey[ c + 1 ] < heapKey[ c ] ) c ++;
			if ( heapKey[ c ] >= lk ) break;
			heapKey[ k ] = heapKey[ c ]; heapIdx[ k ] = heapIdx[ c ]; k = c;

		}

		heapKey[ k ] = lk; heapIdx[ k ] = li;
		return top;

	};

	const isGoal = new Uint8Array( N );
	for ( const [ gx, gy, r ] of goals ) {

		const R = Math.ceil( r );
		for ( let y = Math.max( 0, gy - R ); y <= Math.min( H - 1, gy + R ); y ++ ) {

			for ( let x = Math.max( 0, gx - R ); x <= Math.min( W - 1, gx + R ); x ++ ) {

				const i = y * W + x;
				if ( cost[ i ] === 255 || ( x - gx ) ** 2 + ( y - gy ) ** 2 > r * r ) continue;
				isGoal[ i ] = 1;
				dist[ i ] = 0;
				push( i, 0 );

			}

		}

	}

	while ( hs > 0 ) {

		const d0 = heapKey[ 0 ];
		const i = pop();
		if ( d0 > dist[ i ] ) continue;
		const x = i % W, y = ( i / W ) | 0;
		const ci = cost[ i ];
		for ( const [ dx, dy, len ] of NB ) {

			const nx = x + dx, ny = y + dy;
			if ( nx < 0 || ny < 0 || nx >= W || ny >= H ) continue;
			const j = ny * W + nx;
			const cj = cost[ j ];
			if ( cj === 255 ) continue;
			// no diagonal corner-cutting through blocked cells
			if ( dx && dy && ( cost[ y * W + nx ] === 255 || cost[ ny * W + x ] === 255 ) ) continue;
			const nd = d0 + ( ci + cj ) * 0.5 * len;
			if ( nd < dist[ j ] ) {

				dist[ j ] = nd;
				push( j, nd );

			}

		}

	}

	// raw direction: toward steepest descent, weighted over all lower neighbours
	const raw = new Float32Array( N * 2 );
	for ( let y = 0; y < H; y ++ ) {

		for ( let x = 0; x < W; x ++ ) {

			const i = y * W + x;
			if ( isGoal[ i ] || dist[ i ] === Infinity ) continue;
			let vx = 0, vy = 0;
			for ( const [ dx, dy, len ] of NB ) {

				const nx = x + dx, ny = y + dy;
				if ( nx < 0 || ny < 0 || nx >= W || ny >= H ) continue;
				const dd = dist[ i ] - dist[ ny * W + nx ];
				if ( ! ( dd > 0 ) ) continue;
				const s = dd / len / len;
				vx += dx * s; vy += dy * s;

			}

			const l = Math.hypot( vx, vy );
			if ( l > 0 ) { raw[ i * 2 ] = vx / l; raw[ i * 2 + 1 ] = vy / l; }

		}

	}

	const out = new Uint16Array( N * 2 );
	for ( let y = 0; y < H; y ++ ) {

		for ( let x = 0; x < W; x ++ ) {

			const i = y * W + x;
			if ( isGoal[ i ] || dist[ i ] === Infinity ) continue;
			let vx = raw[ i * 2 ] * 2, vy = raw[ i * 2 + 1 ] * 2;
			for ( const [ dx, dy ] of NB ) {

				const nx = x + dx, ny = y + dy;
				if ( nx < 0 || ny < 0 || nx >= W || ny >= H ) continue;
				const j = ny * W + nx;
				vx += raw[ j * 2 ]; vy += raw[ j * 2 + 1 ];

			}

			const l = Math.hypot( vx, vy );
			if ( l > 1e-4 ) { out[ i * 2 ] = toHalf( vx / l ); out[ i * 2 + 1 ] = toHalf( vy / l ); }

		}

	}

	return out;

}

self.onmessage = ( e ) => {

	const m = e.data;
	if ( m.type === 'init' ) {

		W = m.w; H = m.h; cost = m.cost;
		dist = new Float32Array( W * H );
		heapIdx = new Int32Array( W * H * 4 );
		heapKey = new Float32Array( W * H * 4 );

	} else if ( m.type === 'field' ) {

		const dirs = compute( m.goals );
		self.postMessage( { type: 'field', id: m.id, dirs }, [ dirs.buffer ] );

	}

};
