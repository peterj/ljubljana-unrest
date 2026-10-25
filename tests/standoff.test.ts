import assert from 'node:assert/strict';
import test from 'node:test';
import { Standoff, HEAT, WAIT, COOL, PROVOKE_GAP, PROBE_MIN, PROBE_MAX, THROW_FLIGHT, FLINCH, ceilingOf, levelOf } from '../src/sim/standoff.ts';
import { FACTION, MODE, ROLE } from '../src/sim/crowd.ts';

// a cordon from ( -10, 0 ) to ( 10, 0 ) and a crowd group of n south of it (front row at y = -front), marching north
// past it to ( 0, 50 ). Agents: 0..n-1 the crowd (0 its leader, at the back), n.. the officers.
function fixture( { n = 40, front = 30, kind = 'march', faction = FACTION.PROTESTER, agitation = 0.1 } = {} ) {

	const officers = 20, N = n + officers;
	const pos = new Float32Array( N * 2 ), st = new Float32Array( N * 4 );
	const place = ( y0 ) => {

		for ( let i = 0; i < n; i ++ ) { pos[ i * 2 ] = - 5 + ( i % 10 ); pos[ i * 2 + 1 ] = - y0 - ( n - 1 - i ) / 10 * 1.2; }

	};
	place( front );
	for ( let i = 0; i < n; i ++ ) { st[ i * 4 ] = faction; st[ i * 4 + 2 ] = agitation; }
	for ( let k = 0; k < officers; k ++ ) { const i = n + k; pos[ i * 2 ] = - 10 + k; st[ i * 4 ] = FACTION.POLICE; }
	const log: any = { modes: [], regroups: [], nudges: [], fx: [], layers: [], released: [], retained: [], blasts: [] };
	const world: any = {
		groups: [], intel: { pos, st },
		crowd: { count: N, nudge: ( i, a ) => log.nudges.push( [ i, a ] ), regroup: ( i, g, role ) => { st[ i * 4 + 1 ] = g; log.regroups.push( [ i, g, role ] ); },
			setGroup() {}, getGroup: () => ( { speed: 1 } ), setBlasts: ( b ) => { log.blasts = b; } },
		flow: { retain: ( L ) => log.retained.push( L ), release: ( L ) => log.released.push( L ) },
		setMode( gs, mode ) { for ( const g of gs ) { g.mode = mode; log.modes.push( [ g.id, mode ] ); } },
		setLayer( g, L ) { g.layer = L; log.layers.push( [ g.id, L ] ); },
		fieldTo: async () => 9,
		newGroup( f, kind, label ) { const g = { id: this.groups.length, faction: f, kind, label, members: [], leader: - 1 }; this.groups.push( g ); return g; },
		onFx: ( ...a ) => log.fx.push( a ),
	};
	const crowd: any = { id: 0, faction, kind, label: 'March', members: Array.from( { length: n }, ( _, i ) => i ), leader: 0,
		mode: MODE.MARCH, layer: 3, goal: [ 0, 50 ], alive: n, agitation };
	const squad: any = { id: 1, faction: FACTION.POLICE, kind: 'squad', label: 'Squad 1', members: Array.from( { length: officers }, ( _, k ) => n + k ), alive: officers };
	squad.cordon = { a: [ - 10, 0 ], b: [ 10, 0 ], squads: [ squad ] };
	world.groups.push( crowd, squad );
	const S = new Standoff( world, { random: () => 0.5 } );
	world.standoff = S;
	// one readback: the group's centre from its members on their feet
	const tick = ( dt = 0.5 ) => {

		S.step( dt );
		let sx = 0, sy = 0, k = 0;
		for ( const i of crowd.members ) if ( st[ i * 4 ] === faction ) { sx += pos[ i * 2 ]; sy += pos[ i * 2 + 1 ]; k ++; }
		crowd.center = k ? [ sx / k, sy / k ] : crowd.center;
		return S.update();

	};
	const run = ( seconds ) => { const out = []; for ( let t = 0; t < seconds; t += 0.5 ) out.push( ...tick() ); return out; };
	return { world, S, crowd, squad, pos, st, log, place, tick, run, n };

}

test( 'levels start from agitation, under the ceiling of the kind', () => {

	assert.equal( levelOf( 0.1 ), 1 );
	assert.equal( levelOf( 0.4 ), 2 );
	assert.equal( levelOf( 0.9 ), 4 );
	assert.equal( ceilingOf( 'march' ), 3 );
	assert.equal( ceilingOf( 'bloc' ), 4 );
	assert.equal( ceilingOf( 'supporters' ), 2 );
	const { crowd, tick } = fixture( { agitation: 0.9 } );
	tick();
	assert.equal( crowd.heat, 3 ); // a fired-up march still stops at 3

} );

test( 'a calm march heading through a line stands off and gets restless a minute after its front got there', () => {

	const { crowd, tick, run, place } = fixture( { front: 40 } );
	const out = tick();
	assert.equal( crowd.mode, MODE.STANDOFF );
	assert.equal( crowd.heat, HEAT.CALM );
	assert.deepEqual( out.map( ( e ) => e.type ), [ 'standoff' ] );
	run( WAIT + 5 ); // still walking up: no clock yet
	assert.equal( crowd.heat, HEAT.CALM );
	place( 10 ); // the front stands at the line
	run( WAIT - 2 );
	assert.equal( crowd.heat, HEAT.CALM );
	const up = run( 3 );
	assert.equal( crowd.heat, HEAT.PROBE );
	assert.equal( crowd.mode, MODE.STANDOFF );
	assert.ok( up.some( ( e ) => e.type === 'up' && e.level === 2 ) );

} );

test( 'a group not heading through the line is left alone', () => {

	const { crowd, tick } = fixture( { front: 30 } );
	crowd.goal = [ - 80, - 30 ]; // along the street, away from the line
	tick();
	assert.equal( crowd.standoff ?? null, null );
	assert.equal( crowd.mode, MODE.MARCH );

} );

test( 'police action close by steps the level up once per PROVOKE_GAP, up to the ceiling', () => {

	const { crowd, world, S, tick, run } = fixture( { front: 10 } );
	tick();
	world.provoke = ( k, x, y ) => S.provoke( k, x, y );
	world.provoke( 'gas', 0, - 15 );
	tick();
	assert.equal( crowd.heat, 2 );
	world.provoke( 'gas', 0, - 15 );
	tick();
	assert.equal( crowd.heat, 2 ); // too soon
	run( PROVOKE_GAP );
	world.provoke( 'charge', 0, - 15 );
	tick();
	assert.equal( crowd.heat, 3 );
	assert.equal( crowd.mode, MODE.PUSH );
	run( PROVOKE_GAP );
	world.provoke( 'charge', 0, - 15 );
	tick();
	assert.equal( crowd.heat, 3 ); // a peaceful march never gets past 3
	// far away: nothing
	run( PROVOKE_GAP );
	S.provoke( 'gas', 300, 300 );
	assert.equal( crowd.heat, 3 );

} );

test( 'its own people hurt or arrested by police provoke a group', () => {

	const { crowd, st, tick } = fixture( { front: 10 } );
	tick();
	st[ 5 * 4 ] = 10 + FACTION.PROTESTER; // injured by police
	tick();
	assert.equal( crowd.heat, 2 );

} );

test( 'without provocation a group calms down a level every COOL s, back to standing off', () => {

	const { crowd, S, tick, run } = fixture( { front: 10 } );
	tick();
	for ( let k = 0; k < 2; k ++ ) { S.provoke( 'gas', 0, - 15 ); tick(); run( PROVOKE_GAP ); }
	assert.equal( crowd.heat, 3 );
	assert.equal( crowd.mode, MODE.PUSH );
	run( COOL - PROVOKE_GAP + 1 );
	assert.equal( crowd.heat, 2 );
	assert.equal( crowd.mode, MODE.STANDOFF );

} );

test( 'probes: a knot from the front leans on the line, then comes back into the group', () => {

	const { crowd, world, tick, run, place, n } = fixture( { front: 10 } );
	place( 10 );
	tick();
	run( WAIT + 1 );
	assert.equal( crowd.heat, HEAT.PROBE );
	run( 20 );
	const p = world.groups.find( ( g ) => g.probeOf === crowd );
	assert.ok( p, 'a probe group' );
	assert.ok( crowd.standoff.probe );
	assert.equal( p.mode, MODE.PUSH );
	assert.ok( p.members.length >= PROBE_MIN && p.members.length <= PROBE_MAX );
	assert.ok( ! p.members.includes( crowd.leader ) );
	assert.equal( crowd.members.length + p.members.length, n );
	assert.equal( p.layer, crowd.layer );
	run( 21 );
	assert.equal( crowd.members.length + p.members.length, n );
	assert.ok( crowd.standoff.probe || p.members.length === 0 ); // back, or out again on the next probe

} );

test( 'militants at level 4 storm one point and their leader throws firecrackers that flash and fade', async () => {

	const { crowd, S, log, pos, tick, run, n } = fixture( { front: 10, kind: 'bloc', agitation: 0.9 } );
	// the leader near the line
	pos[ 0 ] = 0; pos[ 1 ] = - 12;
	tick();
	assert.equal( crowd.heat, HEAT.PYRO );
	assert.equal( crowd.mode, MODE.STORM );
	await Promise.resolve();
	await Promise.resolve();
	assert.equal( crowd.layer, 9 ); // the field toward the breach
	assert.deepEqual( log.retained, [ 3 ] ); // the march's own field is kept for later
	run( 5 );
	assert.ok( S.flights.length || S.blasts.length, 'a firecracker' );
	run( THROW_FLIGHT + 0.5 );
	assert.ok( S.blasts.length );
	const b = S.blasts[ 0 ];
	assert.ok( Math.abs( b.y ) < 1e-6 && Math.abs( b.x ) <= 10 ); // on the line
	assert.ok( log.fx.some( ( a ) => a[ 0 ] === 'firecracker' ) );
	assert.equal( S.flashed, true );
	assert.ok( log.blasts.length && log.blasts[ 0 ].r > 0 );
	// leader down: no more throws
	S.flights = []; S.blasts = [];
	crowd.members.forEach( ( i ) => i === 0 && ( ( S.world.intel.st[ 0 ] = FACTION.ARRESTED ) ) );
	run( FLINCH + 10 );
	assert.equal( S.flights.length + S.blasts.length, 0 );
	assert.ok( n > 0 );

} );

test( 'the mission takes a group over with another mode; its own push raises the floor', () => {

	const a = fixture( { front: 10 } );
	a.tick();
	a.world.setMode( [ a.crowd ], MODE.RIOT );
	a.tick();
	assert.equal( a.crowd.standoff, null );
	assert.equal( a.crowd.mode, MODE.RIOT );
	const b = fixture( { front: 10 } );
	b.crowd.mode = MODE.PUSH;
	b.tick();
	assert.equal( b.crowd.heat, HEAT.BREACH );
	assert.equal( b.crowd.mode, MODE.PUSH );
	b.run( COOL + 5 );
	assert.equal( b.crowd.heat, HEAT.BREACH ); // no calming below the mission's order

} );

test( 'the line goes: the group marches on', () => {

	const { crowd, squad, tick } = fixture( { front: 10 } );
	tick();
	assert.equal( crowd.mode, MODE.STANDOFF );
	squad.cordon = null;
	tick();
	assert.equal( crowd.standoff, null );
	assert.equal( crowd.mode, MODE.MARCH );

} );

test( 'a group that got through the line marches on', () => {

	const { crowd, place, tick } = fixture( { front: 10 } );
	tick();
	assert.equal( crowd.mode, MODE.STANDOFF );
	place( - 20 ); // most of it past the line
	tick();
	assert.equal( crowd.standoff, null );
	assert.equal( crowd.mode, MODE.MARCH );

} );

test( 'a group pressing up behind one standing off queues too, however far back', () => {

	// a long first group: 400 people in 40 rows, front 30 m from the line, back ~77 m
	const { world, crowd, st, pos, tick } = fixture( { n: 400, front: 30 } );
	tick();
	assert.ok( crowd.standoff );
	const N = st.length / 4, M = 20;
	const st2 = new Float32Array( ( N + M ) * 4 ), pos2 = new Float32Array( ( N + M ) * 2 );
	st2.set( st ); pos2.set( pos );
	const back: any = { id: world.groups.length, faction: FACTION.PROTESTER, kind: 'march', label: 'March', members: [], leader: N, mode: MODE.MARCH, layer: 3, goal: [ 0, 50 ], alive: M, agitation: 0.1 };
	const row = ( y0 ) => { for ( let k = 0; k < M; k ++ ) { const i = N + k; pos2[ i * 2 ] = - 5 + k % 10; pos2[ i * 2 + 1 ] = - y0 - Math.floor( k / 10 ); st2[ i * 4 ] = FACTION.PROTESTER; st2[ i * 4 + 1 ] = back.id; } back.center = [ - 0.5, - y0 - 0.5 ]; };
	for ( let k = 0; k < M; k ++ ) back.members.push( N + k );
	world.groups.push( back );
	world.intel = { pos: pos2, st: st2 };
	row( 150 );
	tick();
	assert.equal( back.standoff ?? null, null ); // far behind: walks on
	row( 80 ); // right at the first group's back, its front 80 m from the line (beyond BLOCK_REACH)
	tick();
	assert.ok( back.standoff, 'queued' );
	assert.equal( back.mode, MODE.STANDOFF );

} );

test( 'a mission sets the starting level; a touchy group is provoked by blows next to an officer', () => {

	const { crowd, st, pos, n, tick } = fixture( { front: 10 } );
	crowd.heatStart = 2;
	crowd.touchy = true;
	for ( let i = 0; i < n; i ++ ) st[ i * 4 + 3 ] = 1;
	tick();
	assert.equal( crowd.heat, 2 );
	// a blow far from any officer: nothing
	st[ 5 * 4 + 3 ] = 0.9;
	tick();
	assert.equal( crowd.heat, 2 );
	// a blow right at the line
	const i = n - 1; pos[ i * 2 ] = 0; pos[ i * 2 + 1 ] = - 1;
	st[ i * 4 + 3 ] = 0.95;
	tick();
	assert.equal( crowd.heat, 3 );

} );

test( "the player's own groups are not touched", () => {

	const { crowd, S, tick } = fixture( { front: 10 } );
	S.exempt = [ FACTION.PROTESTER ];
	tick();
	assert.equal( crowd.mode, MODE.MARCH );
	assert.equal( crowd.heat, undefined );

} );

test( 'probe members regroup with leader and member roles', () => {

	const { crowd, log, tick, run, place } = fixture( { front: 10 } );
	place( 10 );
	tick();
	run( WAIT + 21 );
	const out = log.regroups.filter( ( r ) => r[ 1 ] !== crowd.id );
	const next = out.findIndex( ( r, k ) => k > 0 && r[ 2 ] === ROLE.LEADER ); // the next probe, if any
	assert.equal( out[ 0 ][ 2 ], ROLE.LEADER );
	assert.ok( out.slice( 1, next < 0 ? undefined : next ).every( ( r ) => r[ 2 ] === ROLE.MEMBER ) );
	assert.ok( log.regroups.filter( ( r ) => r[ 1 ] === crowd.id ).every( ( r ) => r[ 2 ] === ROLE.MEMBER ) ); // back as members

} );
