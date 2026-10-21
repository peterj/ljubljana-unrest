// measured: two arrest squads at a time, two squads guarding each van, re-sent to a new grid spot when idle
const spots = [ [ -12, -6 ], [ -12, 6 ], [ 12, -6 ], [ 12, 6 ], [ 0, -6 ], [ 0, 6 ], [ -6, 0 ], [ 6, 0 ] ];
const guard = `const sq=W.groupsOf(1).filter(q=>q.kind==='squad'); for(let v=0;v<2;v++){const at=M.vans[v].at; const d=[M.square[0]-at[0],M.square[1]-at[1]], l=Math.hypot(...d); await W.moveSquads(sq.slice(4+v*2,6+v*2), at[0]+d[0]/l*8, at[1]+d[1]/l*8);} return 1`;
export default { steps: [ [ 3, guard ] ],
	every: `const sq=W.groupsOf(1).filter(q=>q.kind==='squad').slice(0,4); window.__k=window.__k??0; const sp=${JSON.stringify( spots )};
		for(const s of sq.slice(0,2)) if(!s.job||(s.job.state==='idle'&&!s.job.held)){const p=sp[window.__k++%sp.length]; await M.startArrests([s],M.square[0]+p[0],M.square[1]+p[1]);}
		if(Math.round(M.t)%30<10){const P=W.groupsOf(1).filter(q=>q.job);return {t:Math.round(M.t),handed:M.handed,other:M.handedOther,carried:M.carried,freed:M.freed,T:+M.tension.toFixed(2),stage:M.stage,vans:M.vans.map(v=>v.blocked),jobs:P.map(q=>q.job.state.slice(0,2)+q.job.held).join(' '),tasks:W.groupsOf(0,'supporters').filter(g=>g.task).map(g=>g.task.type[0]).join(''),op:Math.round(M.opinion),inj:M.counters.injByPolice+'/'+M.counters.injPolice}}` };
