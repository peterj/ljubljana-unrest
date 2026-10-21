// stewards escort the Speaker in a shield wall; three listener groups hold Vegova, Hieronimova and Emonska ahead;
// AntiFa go for whichever chasing squad or car crew is nearest the Speaker
const G = `const by = ( l ) => W.groupsOf( 0 ).filter( ( g ) => g.label === l ); const d = ( a, b ) => Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ] );`;
export default {
	steps: [
		[ 5, `${G} const L = by( 'Listeners' ).sort( ( a, b ) => d( a.center, [ -191, -247 ] ) - d( b.center, [ -191, -247 ] ) );
			await W.march( [ L[ 0 ] ], -228, -385, 15 ); await W.march( [ L[ 1 ] ], -298, -575, 15 ); await W.march( [ L[ 2 ] ], -305, -715, 15 );
			await W.march( by( 'Stewards' ), -200, -215, 10 ); M.shieldWall( by( 'Stewards' ) ); return 'screens out'; ` ],
	],
	every: `${G} await new Promise( ( r ) => setTimeout( r, 2000 ) ); const P = M.sp; // pace: flow fields take ~0.4 s each in 3 workers
		if ( P.escaping && ! P.aboard && Math.round( M.t ) % 20 < 10 ) W.march( by( 'Stewards' ), ...P.pos, 8 );
		const ants = M.antifa.filter( ( q ) => q.alive > 5 && ! q.assault );
		const tg = [ ...M.ai.busy ].filter( ( s ) => s.alive >= 4 && s.center ).concat( M.ai.cars.filter( ( c ) => c.deployed && c.crew.alive >= 4 && c.crew.center ).map( ( c ) => c.crew ) )
			.filter( ( s ) => d( s.center, P.pos ) < 200 ).sort( ( a, b ) => d( a.center, P.pos ) - d( b.center, P.pos ) );
		if ( ants.length && tg.length ) { game.selected = ants.slice( 0, 2 ); M.assault( ...tg[ 0 ].center ); game.selected = []; }
		if ( Math.round( M.t ) % 30 > 9 ) return;
		const br = W.groupsOf( 1 ).filter( ( g ) => g.broken ).map( ( g ) => [ g.label, g.alive, g.center.map( Math.round ) ] ); return { br, t: Math.round( M.t ), s: Math.round( P.s ), leg: P.leg, down: !! P.down, aboard: !! P.aboard, pol: W.countNear( ...P.pos, 15, 1 ), op: Math.round( M.opinion ), broken: M.counters.broken, offi: M.counters.injPolice,
			ants: M.antifa.map( ( q ) => [ q.alive, q.assault?.label ?? '-', q.center.map( Math.round ), q.assault?.center?.map( Math.round ), q.assault?.alive, q.assault?.mode ] ), car: [ Math.round( M.car.x ), Math.round( M.car.y ) ] };`,
};
