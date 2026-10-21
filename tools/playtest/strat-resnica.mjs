export default { steps: [
	[ 5, `const sq = W.groupsOf( 1 ).filter( q => q.kind === 'squad' ); const use = [ sq[0], sq[3], sq[4], sq[5], sq[6], sq[7] ];
	const s = M.R.len - 150, a = M.R.pts.length && (() => { const f = ( d ) => { let k = 1; while ( k < M.R.pts.length - 1 && M.R.cum[k] < d ) k++; const t = ( d - M.R.cum[k-1] ) / ( M.R.cum[k] - M.R.cum[k-1] ); return [ M.R.pts[k-1][0] + ( M.R.pts[k][0] - M.R.pts[k-1][0] ) * t, M.R.pts[k-1][1] + ( M.R.pts[k][1] - M.R.pts[k-1][1] ) * t ]; }; return [ f( s - 5 ), f( s + 5 ) ]; })();
	const dx = a[1][0] - a[0][0], dy = a[1][1] - a[0][1], l = Math.hypot( dx, dy ), nx = -dy / l, ny = dx / l, c = [ ( a[0][0] + a[1][0] ) / 2, ( a[0][1] + a[1][1] ) / 2 ];
	window.__line = c; await W.lineSquads( use, [ c[0] + nx * 22, c[1] + ny * 22 ], [ c[0] - nx * 22, c[1] - ny * 22 ], W.intel.pos ); return c` ],
], every: `if ( !window.__line ) return; const head = M.march.find( g => g.center && !g.split && !g.home );
if ( head && !window.__ordered && Math.hypot( head.center[0] - window.__line[0], head.center[1] - window.__line[1] ) < 50 ) { window.__ordered = 1; M.resources.order.ready = 0; M.order( ...head.center ); }
const blocked = M.ring.filter( L => L.n >= 12 && isFinite( L.block ) );
if ( blocked.length && M.resources.water.left > 0 && M.t - ( window.__wt ?? 0 ) > 25 ) { window.__wt = M.t; const L = blocked[0]; let k = 1; while ( k < L.pts.length - 1 && L.cum[k] < L.block + 10 ) k++; M.useWater( ...L.pts[k] ); }
if ( Math.round( M.t ) % 30 >= 10 ) return;
return { t: Math.round( M.t ), clock: M.clock, ring: M.ring.map( L => L.n ).join(','), closed: Math.round( M.closed ), tail: Math.round( M.tailback ), op: Math.round( M.opinion ), injP: M.counters.injByPolice, water: M.resources.water.left, prot: M.stats?.[0] }` };
