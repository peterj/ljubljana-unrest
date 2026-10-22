// The playable missions, in menu order. Built-ins and plugins both register here.
import { Mission } from './mission.ts';

export const MISSIONS = [];

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/; // it goes into the URL (?m=) and the saved-stars key
const CITY = /^[a-z0-9_-]+$/; // a folder under public/data/
const text = ( v ) => typeof v === 'string' && v.trim() !== '';

// why a mission class cannot be registered, or null
export function problem( M ) {

	if ( typeof M !== 'function' || ! ( M.prototype instanceof Mission ) ) return 'not a class extending Mission';
	if ( typeof M.id !== 'string' || ! ID.test( M.id ) || M.id === Mission.id ) return `static id must be a lowercase slug such as 'my-mission' (got ${JSON.stringify( M.id )})`;
	if ( MISSIONS.some( ( q ) => q.id === M.id ) ) return `id '${M.id}' is already registered`;
	for ( const k of [ 'title', 'subtitle', 'brief' ] ) if ( ! text( M[ k ] ) ) return `static ${k} must be a non-empty string`;
	if ( M.side !== 'police' && M.side !== 'protest' ) return "static side must be 'police' or 'protest'";
	for ( const k of [ 'goals', 'tips' ] ) if ( ! Array.isArray( M[ k ] ) || ! M[ k ].every( text ) ) return `static ${k} must be an array of non-empty strings`;
	if ( M.city != null && ( typeof M.city !== 'string' || ! CITY.test( M.city ) ) ) return 'static city must be a folder name under public/data/';
	return null;

}

export function registerMission( M ) {

	const why = problem( M );
	if ( why ) throw new Error( `${M?.name || 'mission'}: ${why}` );
	MISSIONS.push( M );
	return M;

}

export const findMission = ( id ) => MISSIONS.find( ( q ) => q.id === id );
