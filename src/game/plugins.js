import * as sdk from './scenarios/index.js';
import { problem, registerMission } from './registry.js';

const TRUST = 'lu-plugin-trust'; // sessionStorage: remote URLs the player already confirmed in this tab
const LOCAL = new Set( [ 'localhost', '127.0.0.1', '[::1]' ] );
const TIMEOUT = 15000; // ms a plugin may take to load and build its missions

const sameSite = ( url, base ) => url.protocol === base.protocol && url.host === base.host;

export function pluginUrl( raw, base ) {

	let url, here;
	if ( typeof raw !== 'string' || raw.trim() === '' ) throw new Error( 'empty URL' );
	try { here = new URL( base ); url = new URL( raw, here ); } catch { throw new Error( 'not a valid URL' ); }
	if ( url.protocol !== 'https:' && url.protocol !== 'http:' ) throw new Error( `unsupported protocol ${url.protocol}` );
	if ( url.protocol === 'http:' && ! sameSite( url, here ) && ! LOCAL.has( url.hostname ) ) throw new Error( 'plain http is only allowed for localhost' );
	return url;

}

function trusted( href, storage ) {

	try { return JSON.parse( ( storage ?? globalThis.sessionStorage ).getItem( TRUST ) || '[]' ).includes( href ); } catch { return false; }

}

function remember( href, storage ) {

	try {

		const s = storage ?? globalThis.sessionStorage;
		s.setItem( TRUST, JSON.stringify( [ ...new Set( [ ...JSON.parse( s.getItem( TRUST ) || '[]' ), href ] ) ] ) );

	} catch { /* not remembered: asked again next time */ }

}

async function within( promise, ms ) {

	let timer;
	try {

		return await Promise.race( [ promise, new Promise( ( _, fail ) => { timer = setTimeout( () => fail( new Error( `no answer after ${ms / 1000} s` ) ), ms ); } ) ] );

	} finally { clearTimeout( timer ); }

}

// -> the ids of the missions the plugin registered; throws (and registers nothing) if anything is wrong with it
export async function loadPlugin( raw, {
	base = globalThis.location?.href, allowRemote = false, storage, timeout = TIMEOUT,
	confirm = ( m ) => globalThis.confirm( m ), importer = ( href ) => import( /* @vite-ignore */ href ),
} = {} ) {

	const url = pluginUrl( raw, base );
	if ( ! sameSite( url, new URL( base ) ) ) {

		if ( ! allowRemote ) throw new Error( `${url.origin} is not this site, and remote plugins are switched off here` );
		if ( ! trusted( url.href, storage ) ) {

			if ( ! confirm( `Load mission code from ${url.origin}?\n\n${url.href}\n\nIt runs with full access to this page. Only continue if you trust its author.` ) ) throw new Error( 'not confirmed' );
			remember( url.href, storage );

		}

	}

	const list = await within( ( async () => {

		const mod = await importer( url.href );
		if ( mod.sdkVersion !== sdk.SDK_VERSION ) throw new Error( `written for SDK ${mod.sdkVersion ?? '(undeclared)'}, this game offers ${sdk.SDK_VERSION}` );
		if ( typeof mod.default !== 'function' ) throw new Error( 'SDK v1 requires a scenario factory' );
		const made = await mod.default( sdk );
		const { scenarioMission } = await import( './scenarios/mission.js' );
		return [ made ].flat().map( scenarioMission );

	} )(), timeout );

	if ( ! list.length || list.some( ( M ) => M == null ) ) throw new Error( 'exports no missions' );
	const ids = new Set();
	for ( const M of list ) {

		const why = problem( M ) ?? ( ids.has( M.id ) ? `id '${M.id}' appears twice` : null );
		if ( why ) throw new Error( `${M?.name || 'mission'}: ${why}` );
		ids.add( M.id );

	}

	return list.map( registerMission ).map( ( M ) => M.id );

}

// one failing plugin does not stop the others -> { loaded: ids, failed: [ 'url: reason' ] }
export async function loadPlugins( urls, opts ) {

	const loaded = [], failed = [];
	for ( const raw of urls ) {

		try { loaded.push( ...await loadPlugin( raw, opts ) ); } catch ( e ) {

			failed.push( `${raw}: ${e.message}` );
			console.warn( `plugin ${raw} not loaded:`, e );

		}

	}

	return { loaded, failed };

}
