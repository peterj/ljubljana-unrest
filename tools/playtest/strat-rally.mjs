const go = `const [x,y]=M.target; const gs=W.groupsOf(0).filter(g=>g.kind==='bloc'); await W.march(gs,x,y,40); return gs.length;`;
const steps = [ [ 2, go ] ];
for ( let t = 3; t < 1200; t += 31 ) steps.push( [ t, `await M.rally(...M.target); return 'rally'` ] );
for ( let t = 60; t < 1200; t += 60 ) steps.push( [ t, go ] );
export default { steps, every: `if(Math.round(M.t)%30<10){const pol=W.groupsOf(1).reduce((a,g)=>a+(g.alive??0),0);return {t:Math.round(M.t),hc:M.headcount,pol,clr:M.ai.clearing,gas:M.ai.gassing,extra:M.ai.extra,outer:M.ai.outer.length,usedOuter:M.ai.outer.filter(o=>o.used).length,groups:W.groups.length}}` };
export const dump = 1;
