// node run.mjs <missionId> [strategy.js] [maxSeconds]
// strategy.js exports default an array of [ t, 'js source run in page with (game, M, W, F, MODE)' ] or a per-tick function source
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const [ ,, id, strat = '', max = '1300' ] = process.argv;
const plan = strat ? ( await import( new URL( strat, 'file://' + process.cwd() + '/' ) ) ).default : { steps: [] };
const b = await puppeteer.connect( { browserURL: 'http://localhost:9333', protocolTimeout: 0 } );
const p = await b.newPage();
await p.setViewport( { width: 1400, height: 900 } );
p.on( 'pageerror', ( e ) => console.log( '[pageerror]', e.message ) );
p.on( 'console', ( m ) => { if ( m.type() === 'error' ) console.log( '[console.error]', m.text().slice( 0, 400 ) ); } );
await p.goto( `http://localhost:5199/?m=${id}` );
await p.waitForSelector( '#bStart', { timeout: 120000 } );
await p.evaluate( () => {
	const M = game.mission; window.__log = [];
	const ev = M.event.bind( M );
	M.event = ( text, kind, at ) => { window.__log.push( `${Math.round( M.t )}s ${kind}: ${text}` ); ev( text, kind, at ); };
	document.getElementById( 'bStart' ).click();
} );
await new Promise( ( r ) => setTimeout( r, 1500 ) );
const steps = [ ...( plan.steps ?? [] ) ].sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
let t = 0;
const CH = 10;
while ( t < +max ) {

	while ( steps.length && steps[ 0 ][ 0 ] <= t ) {

		const [ , src ] = steps.shift();
		const r = await p.evaluate( `(async()=>{const game=window.game,M=game.mission,W=game.world;try{return await (async()=>{${src}})()}catch(e){return 'ERR '+e.message}})()` );
		if ( r !== undefined ) console.log( `  [step@${t}]`, JSON.stringify( r ).slice( 0, 300 ) );

	}

	if ( plan.every ) { const r = await p.evaluate( `(async()=>{const game=window.game,M=game.mission,W=game.world;try{return await (async()=>{${plan.every}})()}catch(e){return 'ERR '+e.message}})()` ); if ( r ) console.log( '  [every]', JSON.stringify( r ).slice( 0, 300 ) ); }
	const r = await p.evaluate( ( s ) => game.advance( s ), CH );
	t = r.t;
	const log = await p.evaluate( () => window.__log.splice( 0 ) );
	for ( const l of log ) console.log( '   ·', l );
	if ( Math.round( t ) % 30 < CH || r.result ) {

		const extra = await p.evaluate( () => { const M = game.mission, s = M.stats; return { ...M.counters, op: Math.round( M.opinion ), esc: M.escalation }; } );
		console.log( `t=${Math.round( t )} op=${Math.round( r.opinion )} | ${r.objectives.join( ' | ' )} | ${JSON.stringify( extra )}` );

	}

	if ( r.result ) { console.log( 'RESULT', JSON.stringify( r.result ) ); break; }

}

await p.close(); await b.disconnect();
