// real-time run with long-task logging and a CPU profile: node rt.mjs <mission> <strategy> <realSeconds> <speed>
import puppeteer from 'puppeteer-core';
const [ ,, id, strat, secs = '240', speed = '3' ] = process.argv;
const plan = ( await import( new URL( strat, 'file://' + process.cwd() + '/' ) ) ).default;
const b = await puppeteer.connect( { browserURL: 'http://localhost:9333', protocolTimeout: 0 } );
const p = await b.newPage();
await p.setViewport( { width: 1400, height: 900 } );
p.on( 'pageerror', ( e ) => console.log( '[pageerror]', e.message ) );
await p.goto( `http://localhost:5199/?m=${id}` );
await p.waitForSelector( '#bStart', { timeout: 120000 } );
await p.evaluate( ( sp ) => {
	window.__long = [];
	new PerformanceObserver( ( l ) => { for ( const e of l.getEntries() ) window.__long.push( [ Math.round( game.mission?.t ?? 0 ), Math.round( e.duration ) ] ); } ).observe( { entryTypes: [ 'longtask' ] } );
	document.getElementById( 'bStart' ).click();
	game.speed = sp;
}, +speed );
const cdp = await p.target().createCDPSession();
await cdp.send( 'Profiler.enable' );
await cdp.send( 'Profiler.setSamplingInterval', { interval: 500 } );
await cdp.send( 'Profiler.start' );
const steps = [ ...plan.steps ];
const t0 = Date.now();
while ( Date.now() - t0 < secs * 1000 ) {
	const t = await p.evaluate( () => game.mission.t );
	while ( steps.length && steps[ 0 ][ 0 ] <= t ) { const [ , src ] = steps.shift(); await p.evaluate( `(async()=>{const game=window.game,M=game.mission,W=game.world;${src}})()` ); }
	if ( plan.every ) await p.evaluate( `(async()=>{const game=window.game,M=game.mission,W=game.world;try{${plan.every}}catch(e){}})()` );
	const r = await p.evaluate( () => { const L = window.__long.splice( 0 ); const M = game.mission; return { t: Math.round( M.t ), long: L, max: Math.max( 0, ...L.map( ( x ) => x[ 1 ] ) ), sum: L.reduce( ( a, x ) => a + x[ 1 ], 0 ), n: game.crowd.count, edits: game.crowd.pendingEdits.length, T: M.tension?.toFixed( 2 ), res: !! M.result }; } );
	console.log( JSON.stringify( { ...r, long: r.long.length } ) );
	if ( r.res ) break;
	await new Promise( ( res ) => setTimeout( res, 5000 ) );
}
const { profile } = await cdp.send( 'Profiler.stop' );
const self = new Map(), dt = profile.timeDeltas, byId = new Map( profile.nodes.map( ( n ) => [ n.id, n ] ) );
profile.samples.forEach( ( id, k ) => { const n = byId.get( id ); const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split( '/' ).pop()}:${n.callFrame.lineNumber + 1}`; self.set( key, ( self.get( key ) ?? 0 ) + ( dt[ k ] ?? 0 ) ); } );
console.log( [ ...self ].sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).slice( 0, 25 ).map( ( [ k, v ] ) => `${( v / 1000 ).toFixed( 0 ).padStart( 7 )} ms  ${k}` ).join( '\n' ) );
await p.close();
