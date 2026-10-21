// defend-*: cordon lines 8 m off the four longest façades, gas the hottest door when pressure builds,
// reinforcements to the busiest door, snatch identified leaders close to the building.
const lines = `
const T = M.T, outer = T.poly[ 0 ][ 0 ], E = [];
for ( let k = 0; k < outer.length; k += 2 ) {
	const a = [ outer[ k ], outer[ k + 1 ] ], b = [ outer[ ( k + 2 ) % outer.length ], outer[ ( k + 3 ) % outer.length ] ];
	E.push( { a, b, len: Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) } );
}
const top = E.sort( ( p, q ) => q.len - p.len ).slice( 0, 4 );
const keep = new Set( T.exits.map( ( e ) => W.groupsOf( 1 ).filter( ( g ) => g.kind === 'squad' && g.center ).sort( ( p, q ) => Math.hypot( p.center[ 0 ] - e[ 0 ], p.center[ 1 ] - e[ 1 ] ) - Math.hypot( q.center[ 0 ] - e[ 0 ], q.center[ 1 ] - e[ 1 ] ) )[ 0 ] ) );
const sq = W.groupsOf( 1 ).filter( ( g ) => ! keep.has( g ) && ( g.kind !== 'crew' || ! g.car?.aboard.length ) );
const per = top.map( () => [] ); sq.forEach( ( g, k ) => per[ k % 4 ].push( g ) );
top.forEach( ( e, k ) => {
	const mx = ( e.a[ 0 ] + e.b[ 0 ] ) / 2, my = ( e.a[ 1 ] + e.b[ 1 ] ) / 2;
	let ox = mx - T.pos[ 0 ], oy = my - T.pos[ 1 ]; const ol = Math.hypot( ox, oy ); ox /= ol; oy /= ol;
	const dx = ( e.b[ 0 ] - e.a[ 0 ] ) / e.len, dy = ( e.b[ 1 ] - e.a[ 1 ] ) / e.len, ext = 6;
	W.lineSquads( per[ k ], [ e.a[ 0 ] + ox * 8 - dx * ext, e.a[ 1 ] + oy * 8 - dy * ext ], [ e.b[ 0 ] + ox * 8 + dx * ext, e.b[ 1 ] + oy * 8 + dy * ext ], W.intel?.pos );
} );
return top.map( ( e ) => Math.round( e.len ) ).join( ',' ) + ' m façades, ' + sq.length + ' squads';`;
export default {
	steps: [ [ 1, lines ] ],
	every: `
if ( Math.round( M.t ) % 10 > 9 ) return;
const T = M.T, out = [];
const busy = M.targets.map( ( p ) => [ p, W.countNear( p[ 0 ], p[ 1 ], 15, 0 ) ] ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] )[ 0 ];
if ( ( M.facade > 30 || M.breach > 0.2 || busy[ 1 ] > 150 ) && M.resources.gas.left > 0 && M.t - ( window.__gas ?? -99 ) > 30 ) { window.__gas = M.t; M.useGas( ...busy[ 0 ] ); out.push( 'gas' ); }
const ex = T.exits.map( ( e, k ) => [ e, M.zone( 1 + k ) ] ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] )[ 0 ];
if ( ( ex[ 1 ] > 25 || M.breach > 0.4 ) && M.resources.water.left > 0 && M.t - ( window.__wc ?? -99 ) > 25 ) { window.__wc = M.t; M.useWater( ...( M.breach > 0.4 ? busy[ 0 ] : ex[ 0 ] ) ); out.push( 'water' ); }
if ( busy[ 1 ] > 120 && M.resources.reinforce.left > 0 && M.t - ( window.__rf ?? -99 ) > 60 ) { window.__rf = M.t; await M.reinforce( ...busy[ 0 ] ); out.push( 'reinforce' ); }
const leader = W.groups.find( ( g ) => g.faction === 0 && g.identified && g.leaderState === 'active' && Math.hypot( g.leaderPos[ 0 ] - T.pos[ 0 ], g.leaderPos[ 1 ] - T.pos[ 1 ] ) < T.radius + 60 );
const free = W.groupsOf( 1 ).filter( ( g ) => g.label === 'Reinforcements' && ! g.snatch )[ 0 ];
if ( leader && free ) { game.selected = [ free ]; M.snatch( ...leader.leaderPos ); out.push( 'snatch' ); }
return out.length ? out.join( '+' ) + ' @' + Math.round( M.t ) : null;` };
