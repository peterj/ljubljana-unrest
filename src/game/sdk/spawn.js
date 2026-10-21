import { FACTION } from '../mission.js';

// shared: spawn a numbered set of police squads at positions
export async function squads( world, list, n = 24 ) {

	const out = [];
	for ( const [ x, y ] of list ) out.push( await world.squad( { kind: 'squad', label: `Squad ${world.groups.filter( ( g ) => g.faction === FACTION.POLICE ).length + 1}`, at: [ x, y ], n } ) );
	return out;

}

// shared: patrol cars (each with a small crew squad) parked at positions
export async function cars( world, list, opts = {} ) {

	const out = [];
	for ( const at of list ) out.push( await world.patrols.add( { at, ...opts } ) );
	return out;

}
