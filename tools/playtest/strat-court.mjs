// march the banner up Miklošičeva with the students as a screen; unions round the south square; bikes via the park
const G = `const by = ( l ) => W.groupsOf( 0 ).filter( ( g ) => g.label === l );`;
export default {
	steps: [
		[ 0, `${G} const S = M.steps; await W.march( [ ...by( 'Banner bloc' ), ...by( 'Medics' ) ], -60, 160, 15 ); await W.march( by( 'Students' ), ...S, 25 );
			await W.march( by( 'Unions' ), 20, 285, 25 ); await W.march( by( 'Kolesarji' ), 160, 330, 20 ); return [ M.steps.map( Math.round ), M.facade.open, W.wind.map( ( v ) => v.toFixed( 2 ) ) ];` ],
		[ 20, `${G} const s = by( 'Students' ); const n = s.map( ( g ) => M.world.split( g ) ).filter( Boolean ); return 'split ' + n.length + ' groups ' + W.groupsOf( 0 ).length;` ],
		[ 40, `${G} const s = by( 'Students' ); const into = W.merge( s.slice( 0, 4 ) ); return 'merged into ' + into?.id + ' alive ' + into?.alive;` ],
		[ 60, `${G} M.shieldWall( by( 'Banner bloc' ) ); return by( 'Banner bloc' ).map( ( g ) => g.mode );` ],
		[ 200, `${G} M.shieldWall( by( 'Banner bloc' ) ); await W.march( [ ...by( 'Banner bloc' ), ...by( 'Medics' ) ], -10, 275, 15 ); return 'banner to the south square';` ],
		[ 150, `${G} await W.march( by( 'Unions' ), ...M.steps, 25 ); M.rally( ...M.steps ); return 'unions to steps, rally';` ],
		[ 380, `${G} M.shieldWall( by( 'Banner bloc' ) ); await W.march( [ ...by( 'Banner bloc' ), ...by( 'Medics' ) ], ...M.steps, 12 ); return 'banner to the steps';` ],
		[ 240, `${G} M.beWater( by( 'Kolesarji' ), ...M.steps ); return 'bikes be water';` ],
	],
	every: `const B = M.banner; const by = ( l ) => W.groupsOf( 0 ).filter( ( g ) => g.label === l );
		if ( M.ai.pending.some( ( p ) => p.label === 'tear gas' ) && M.resources.umbrella.left > 0 && B.group ) M.umbrellas( [ B.group ] );
		if ( B.group && M.t > 380 && B.group.mode !== 0 && B.group.mode !== 5 ) W.march( [ B.group ], ...M.steps, 12 );
		if ( ! B.group && Math.round( M.t ) % 10 < 3 ) W.march( W.groupsOf( 0 ).filter( ( g ) => g.center && Math.hypot( g.center[ 0 ] - B.pos[ 0 ], g.center[ 1 ] - B.pos[ 1 ] ) < 80 ), ...B.pos, 5 );
		if ( Math.round( M.t ) % 30 > 9 ) return;
		return { t: Math.round( M.t ), banner: B.group ? Math.round( Math.hypot( B.pos[ 0 ] - M.steps[ 0 ], B.pos[ 1 ] - M.steps[ 1 ] ) ) : 'DOWN', steps: M.zone( 0 ), held: Math.round( M.held ), op: Math.round( M.opinion ), inj: M.counters.injByPolice, offi: M.counters.injPolice, arr: M.counters.arrested, gas: M.ai.gasUsed, treated: M.counters.treated ?? 0, shel: M.shelters.length };`,
};
