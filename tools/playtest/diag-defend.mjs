export default { steps: [ [ 0, `return { targets: M.targets.map( ( p ) => p.map( Math.round ) ), rally: M.rallyPoint.map( Math.round ) };` ] ], every: `
if ( Math.round( M.t ) % 60 > 9 ) return;
const T = M.T, gs = W.groupsOf( 0 ).filter( ( g ) => g.center );
const tgt = gs.filter( ( g ) => g.goalKind === 'target' );
const I = W.intel; let agHi = 0;
for ( let i = 0; i < game.crowd.count; i ++ ) if ( I.st[ i * 4 ] === 0 && Math.hypot( I.pos[ i * 2 ] - T.pos[ 0 ], I.pos[ i * 2 + 1 ] - T.pos[ 1 ] ) < 60 && I.st[ i * 4 + 2 ] >= 0.4 ) agHi ++;
return { t: Math.round( M.t ), groups: gs.length, toTarget: tgt.length, near60: W.countNear( ...T.pos, 60, 0 ), agitatedNear60: agHi, facade: M.facade, breach: +M.breach.toFixed( 2 ), pol: W.countNear( ...T.pos, 60, 1 ), meanAg: +( gs.reduce( ( s, g ) => s + g.agitation, 0 ) / ( gs.length || 1 ) ).toFixed( 2 ) };
` };
