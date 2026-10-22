import assert from 'node:assert/strict';
import test from 'node:test';
import { World, SHIELD_SPEED } from '../src/sim/world.js';
import { FACTION, MODE } from '../src/sim/crowd.js';

// a 20 m cordon from ( -10, 0 ) to ( 10, 0 ) of 20 officers standing on it, one squad
function cordonFixture() {

	const n = 20, pos = new Float32Array( n * 2 ), st = new Float32Array( n * 4 );
	for ( let i = 0; i < n; i ++ ) { pos[ i * 2 ] = - 10 + i * 20 / ( n - 1 ); st[ i * 4 ] = FACTION.POLICE; }
	const world = Object.create( World.prototype );
	Object.assign( world, { groups: [], pushEvents: [], intel: { pos, st }, crowd: { count: n, setGroup() {}, setOffsets() {} } } );
	const squad = { id: 0, label: 'Squad 1', members: Array.from( { length: n }, ( _, i ) => i ), mode: MODE.FORMATION, alive: n, center: [ 0, 0 ] };
	world.groups.push( squad );
	const cordon = { a: [ - 10, 0 ], b: [ 10, 0 ], squads: [ squad ], n0: n, len0: 20, closed: 0, retreatAt: - 1e9 };
	squad.cordon = cordon;
	// officers stand on the line a → b
	const stand = ( a, b ) => { for ( let i = 0; i < n; i ++ ) { const t = i / ( n - 1 ); pos[ i * 2 ] = a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t; pos[ i * 2 + 1 ] = a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t; } };
	return { world, squad, cordon, stand };

}

const close = ( actual, expected, eps = 1e-6 ) => assert.ok( Math.abs( actual - expected ) < eps, `${actual} ≉ ${expected}` );

test( 'a push aimed nearly straight ahead advances along the line normal without turning', () => {

	const { world, squad } = cordonFixture();
	const P = world.pushAim( [ squad ], 1, 20 );
	assert.equal( P.turn, null );
	close( P.n[ 0 ], 0 ); close( P.n[ 1 ], 1 );
	close( P.d, 20 );
	close( world.pushAim( [ squad ], - 1, - 20 ).n[ 1 ], - 1 );

} );

test( 'a push aimed off the normal turns the line about its centre to face the aim', () => {

	const { world, squad } = cordonFixture();
	const P = world.pushAim( [ squad ], 20, 20 );
	close( P.turn.angle, Math.PI / 4 );
	close( P.n[ 0 ], Math.SQRT1_2 ); close( P.n[ 1 ], Math.SQRT1_2 );
	const [ a, b ] = [ P.turn.a, P.turn.b ], dx = b[ 0 ] - a[ 0 ], dy = b[ 1 ] - a[ 1 ];
	close( ( a[ 0 ] + b[ 0 ] ) / 2, 0 ); close( ( a[ 1 ] + b[ 1 ] ) / 2, 0 ); // same centre
	close( Math.hypot( dx, dy ), 20 ); // same length
	close( dx * P.n[ 0 ] + dy * P.n[ 1 ], 0 ); // perpendicular to the push
	close( - dy / 20, P.n[ 0 ] ); close( dx / 20, P.n[ 1 ] ); // and facing it
	close( P.d, Math.min( 40, Math.hypot( 20, 20 ) ) );
	// the line stops where the turned line ends up after the advance
	close( P.a[ 0 ], a[ 0 ] + P.n[ 0 ] * P.d ); close( P.b[ 1 ], b[ 1 ] + P.n[ 1 ] * P.d );

} );

test( 'a turned push re-forms the line first and advances only once the officers stand on it', () => {

	const { world, squad, cordon, stand } = cordonFixture();
	world.shieldPush( [ squad ], 0, 20 ); // straight: no turn
	assert.equal( cordon.push.turn, null );
	cordon.push = null;

	world.shieldPush( [ squad ], - 15, 15 );
	const turned = [ [ ...cordon.a ], [ ...cordon.b ] ];
	assert.ok( cordon.push.turn, 'turning' );
	assert.equal( squad.mode, MODE.SHOVE, 'shields up while turning' );
	close( cordon.a[ 0 ] + cordon.b[ 0 ], 0 ); close( cordon.a[ 1 ] + cordon.b[ 1 ], 0 );
	assert.notDeepEqual( turned, [ [ - 10, 0 ], [ 10, 0 ] ] );

	// officers still on the old line: the anchor waits
	for ( let k = 0; k < 10; k ++ ) world._pushStep( cordon, 0.5 );
	assert.equal( cordon.push.done, 0 );
	assert.deepEqual( [ cordon.a, cordon.b ], turned );

	// they have swung round: the line advances along the push
	stand( ...turned );
	world._pushStep( cordon, 1 );
	assert.equal( cordon.push.turn, null );
	close( cordon.push.done, SHIELD_SPEED );
	close( cordon.a[ 0 ], turned[ 0 ][ 0 ] - Math.SQRT1_2 * SHIELD_SPEED );
	close( cordon.a[ 1 ], turned[ 0 ][ 1 ] + Math.SQRT1_2 * SHIELD_SPEED );

} );

test( 'a turn that never forms gives up waiting and advances anyway', () => {

	const { world, squad, cordon } = cordonFixture();
	world.shieldPush( [ squad ], 20, 0.5 );
	const max = cordon.push.turn.max;
	assert.ok( max > 6 && max <= 30, `turn time ${max}` );
	for ( let t = 0; t < max; t += 0.5 ) { assert.ok( cordon.push.turn ); assert.equal( cordon.push.done, 0 ); world._pushStep( cordon, 0.5 ); }
	world._pushStep( cordon, 0.5 );
	assert.equal( cordon.push.turn, null );
	assert.ok( cordon.push.done > 0 );

} );

test( 'a line raises shields once most officers stand on it, and only where the player commands the police', () => {

	const { world, squad, cordon } = cordonFixture();
	assert.deepEqual( world.cordonCheck( 1 ), [], 'no bracing unless asked' );
	assert.equal( squad.mode, MODE.FORMATION );
	const [ e ] = world.cordonCheck( 1, { brace: true } );
	assert.equal( e.type, 'brace' );
	assert.equal( cordon.braced, true );
	assert.equal( squad.mode, MODE.BRACE );
	assert.deepEqual( world.cordonCheck( 2, { brace: true } ), [], 'once' );

} );

test( 'a line still forming, re-formed or pushing is not braced', async () => {

	const { world, squad, cordon, stand } = cordonFixture();
	stand( [ - 10, 10 ], [ 10, 10 ] ); // 10 m off the line
	assert.deepEqual( world.cordonCheck( 1, { brace: true } ), [] );
	stand( cordon.a, cordon.b );
	world.cordonCheck( 2, { brace: true } );
	assert.equal( squad.mode, MODE.BRACE );
	await world.lineSquads( cordon.squads, [ - 10, 5 ], [ 10, 5 ], world.intel.pos, cordon, { keepField: true } );
	assert.equal( cordon.braced, false );
	assert.equal( squad.mode, MODE.FORMATION );
	stand( cordon.a, cordon.b );
	world.cordonCheck( 3, { brace: true } );
	assert.equal( squad.mode, MODE.BRACE );
	world.shieldPush( [ squad ], 0, 30 );
	assert.equal( cordon.braced, false );
	assert.equal( squad.mode, MODE.SHOVE );
	assert.deepEqual( world.cordonCheck( 4, { brace: true } ), [] );

} );

test( 'the rows of a line are staggered so the second covers the gaps of the first', async () => {

	const { world, squad } = cordonFixture();
	let offsets;
	world.crowd.setOffsets = ( indices, offs ) => { offsets = offs; };
	await world.lineSquads( [ squad ], [ - 5, 0 ], [ 5, 0 ], world.intel.pos, undefined, { keepField: true } ); // 20 officers on 10 m: 2 rows
	const front = [], back = [];
	for ( let k = 0; k < offsets.length / 2; k ++ ) ( Math.abs( offsets[ k * 2 + 1 ] ) < 0.1 ? front : back ).push( offsets[ k * 2 ] );
	assert.equal( front.length, 10 ); assert.equal( back.length, 10 );
	const gap = front[ 1 ] - front[ 0 ];
	for ( let k = 0; k < 10; k ++ ) close( back[ k ] - front[ k ], gap / 2, 1e-5 );

} );
