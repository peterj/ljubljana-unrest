// Pride: a plain police plan. Fill every unscreened pavement group with a line (staging squads first, then
// reinforcements called to the gaps), send two free squads after each announced attack group (arrest while they are
// clear of the march, else stand on them), the two squads staged south of the blockade onto it as soon as it is announced (standing on it carries the sitters off). No leapfrogging.
export default { steps: [
	// the two squads staged at Cankarjeva (south of where the blockade will be) are kept for it
	[ 1, `const S = window.__S = { lineOf: new Map(), busy: new Set() };
		const st = W.groupsOf( 1 ).filter( ( s ) => s.kind === 'squad' && ! s.cordon ).sort( ( a, b ) => Math.hypot( a.center[ 0 ] + 330, a.center[ 1 ] - 30 ) - Math.hypot( b.center[ 0 ] + 330, b.center[ 1 ] - 30 ) );
		M.block.team = st.slice( 0, 2 ); M.block.team.forEach( ( s ) => S.busy.add( s ) ); return M.clusters.length` ],
], every: `
	if ( ! window.__S ) return;
	const S = window.__S, F = W.groupsOf( 1 ).filter( ( s ) => s.kind === 'squad' && s.center && s.alive > 8 );
	const near = ( a, b ) => Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ] );
	for ( const s of F ) if ( s.cordon && ! S.busy.has( s ) ) { const c = M.clusters.find( ( c ) => near( c.front, s.anchor ) < 6 ); if ( c ) S.lineOf.set( c, s ); }
	const free = () => F.filter( ( s ) => ! s.cordon && ! S.busy.has( s ) && ! [ ...S.lineOf.values() ].includes( s ) );
	const out = [];
	for ( const c of M.clusters ) {
		const s0 = S.lineOf.get( c );
		if ( s0 && s0.alive > 8 && s0.cordon && ( ( c.cover ?? 1 ) > 0.4 || W.countNear( ...c.front, 30, 0 ) > 5 ) ) continue;
		if ( s0 && s0.alive > 8 && s0.cordon ) { await W.lineSquads( [ s0 ], c.lineA, c.lineB, W.intel.pos ); continue; }
		const f = free().sort( ( a, b ) => near( a.center, c.front ) - near( b.center, c.front ) )[ 0 ];
		if ( f ) { S.lineOf.set( c, f ); await W.lineSquads( [ f ], c.lineA, c.lineB, W.intel.pos ); out.push( 'line ' + Math.round( c.s ) + c.side ); }
		else if ( M.resources.reinforce.left > 0 && M.resources.reinforce.ready <= 0 ) { await M.reinforce( ...c.front ); out.push( 'reinforce' ); break; }
	}
	for ( const a of M.attacks ) {
		if ( ! a.g?.center || ! [ 'gather', 'strike' ].includes( a.state ) ) continue;
		a.team = ( a.team ?? [] ).filter( ( s ) => s.alive > 8 );
		while ( a.team.length < 2 ) { const f = free().sort( ( p, q ) => near( p.center, a.g.center ) - near( q.center, a.g.center ) )[ 0 ]; if ( ! f ) break; a.team.push( f ); S.busy.add( f ); }
		if ( ! a.team.length ) continue;
		if ( W.countNear( ...a.g.center, 15, 0 ) < 10 ) { await W.arrest( a.team, ...a.g.center ); out.push( 'arrest ' + a.name ); }
		else { await W.moveSquads( a.team, ...a.g.center ); out.push( 'block ' + a.name ); }
	}
	for ( const a of M.attacks ) if ( [ 'gone', 'broken' ].includes( a.state ) && a.team ) { for ( const s of a.team ) { S.busy.delete( s ); W.moveSquads( [ s ], ...s.center ); } a.team = null; }
	const K = M.block;
	if ( K.state === 'announced' || K.state === 'sitting' ) {
		K.team = ( K.team ?? [] ).filter( ( s ) => s.alive > 8 );
		while ( K.team.length < 2 ) { const f = free().sort( ( p, q ) => near( p.center, K.at ) - near( q.center, K.at ) )[ 0 ]; if ( ! f ) break; K.team.push( f ); S.busy.add( f ); }
		if ( K.team.length && K.state === 'sitting' && M.t - ( K.moved ?? 0 ) > 30 ) { K.moved = M.t; await W.moveSquads( K.team, ...K.at ); out.push( 'clear blockade' ); }
		else if ( K.team.length && ! K.sent ) { K.sent = true; await W.moveSquads( K.team, ...K.at ); out.push( 'to the blockade' ); }
	} else if ( K.team && K.state === 'cleared' ) { for ( const s of K.team ) { S.busy.delete( s ); if ( s.center ) W.moveSquads( [ s ], K.at[ 0 ] - 25, K.at[ 1 ] + 5 ); } K.team = null; }
	if ( Math.round( M.t ) % 60 < 10 ) out.push( { bs: Math.round( M.bannerS ), tens: M.clusters.map( ( q ) => Math.round( q.tension * 9 ) ).join( '' ), cover: M.clusters.map( ( q ) => Math.round( ( q.cover ?? 0 ) * 9 ) ).join( '' ), march: M.marchers(), halted: M.halted } );
	return out.length ? out : undefined;
` };
