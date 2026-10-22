import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { loadPlugin } from '../src/game/plugins.ts';
import { findMission } from '../src/game/registry.ts';

const examples = readdirSync( new URL( '../examples/', import.meta.url ) ).filter( ( name ) => name.endsWith( '-scenario.ts' ) );

test( 'every TypeScript example plugin loads through the plugin loader as a hidden SDK v1 scenario', async () => {

	assert.ok( examples.length >= 11 );
	for ( const name of examples ) {

		const ids = await loadPlugin( `./examples/${name}`, { base: 'http://localhost/', importer: () => import( `../examples/${name}` ) } );
		assert.ok( ids.length > 0, name );
		for ( const id of ids ) assert.equal( findMission( id ).menu, false, `${name}: ${id} stays out of the mission picker` );

	}

} );
