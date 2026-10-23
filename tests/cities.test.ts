import assert from 'node:assert/strict';
import test from 'node:test';
import { citiesFor, cityOf, mapOf } from '../src/game/cities.ts';

test( 'missions find their maps by city and map, and the older Ljubljana folder form still works', () => {

	assert.deepEqual( mapOf( {} ), { city: 'ljubljana', map: 'centre', base: './data/' } );
	assert.deepEqual( mapOf( { city: 'north' } ), { city: 'ljubljana', map: 'north', base: './data/north/' } );
	assert.deepEqual( mapOf( { city: 'ljubljana', map: 'north' } ), { city: 'ljubljana', map: 'north', base: './data/north/' } );
	assert.deepEqual( mapOf( { city: 'belgrade' } ), { city: 'belgrade', map: 'centre', base: './data/belgrade/centre/' } );
	assert.deepEqual( mapOf( { city: 'paris', map: 'bastille' } ), { city: 'paris', map: 'bastille', base: './data/paris/bastille/' } );
	assert.equal( cityOf( { tutorial: true, city: 'belgrade' } ), null );

} );

test( 'a city opens once a listed mission plays there; a plugin may bring its own city', () => {

	const cities = citiesFor( [ { city: 'north' }, { city: 'belgrade', map: 'test' }, { city: 'sarajevo', map: 'centre' } ] );
	const byId = Object.fromEntries( cities.map( ( c ) => [ c.id, c ] ) );
	assert.deepEqual( cities.map( ( c ) => c.id ), [ 'ljubljana', 'belgrade', 'paris', 'sarajevo' ] );
	assert.equal( byId.ljubljana.missions, 1 );
	assert.equal( byId.belgrade.open, true );
	assert.equal( byId.paris.open, false );
	assert.equal( byId.sarajevo.name, 'Sarajevo' );
	assert.equal( citiesFor( [] ).find( ( c ) => c.id === 'ljubljana' ).open, true );

} );
