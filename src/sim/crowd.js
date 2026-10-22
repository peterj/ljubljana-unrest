// GPU crowd simulation (WebGPU compute via TSL).
//
// Per step (all on GPU, no readback):
//   edits    – (only when queued) spawn / remove / nudge agents written by the CPU
//   clear    – zero the spatial-hash cell counters and the stats counters
//   clearDens– zero the coarse density grid
//   insert   – each agent atomically claims a slot in its hashed 1.25 m cell, and adds itself to
//              the 4 m density grid (per-faction counts, agitation, injured) used for long-range sensing
//   update   – steering (flow field / formation / leader cohesion / flee / riot / gas / convoy),
//              elastic contacts with 3×3 neighbouring cells, walls, vehicles, agitation, resolve,
//              damage and arrests → next buffers
//   commit   – integrate positions, hard-project out of walls, copy next → current, gather stats
//
// Agent state:
//   st = (faction, group, agitation, health)
//   ex = (hitTimer, resolve, contacts | arrestProgress, role)
//     contacts for police (render glow), arrest progress (0..1) for protesters / counter-protesters.
//     resolve < 0 → the agent gives up and walks to the nearest exit, then disappears.
// Factions: 0 protester, 1 police, 2 bystander, 3 counter-protester.
//   10+f injured by police, 20+f injured by anyone else, 30+f killed (gunfire), -1 unused, -2 arrested, -3 arrested sitter,
//   -4 went home.
// Roles: 0 member, 1 leader, 2 sitter; +4 = on a bike (ROLE.BIKE), dropped for good when the rider dismounts.
// Groups (CPU-owned): gA = (flowLayer, leaderIndex, speedMul, mode)
//                     gB = (anchorX, anchorY, formationScale, aggression [police] | morale [civilians])
//                     civilians' anchor = the group's centre (World.refreshIntel), so leaders can wait for it
import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Return, instancedArray, instanceIndex, uniform, uniformArray, texture,
	float, int, uint, vec2, vec3, ivec2, vec4,
	atomicAdd, atomicStore, atomicLoad,
	min, max, clamp, floor, sqrt, abs, dot, length, normalize, select, mix, smoothstep, uv, fract, sin, cos, mod,
} from 'three/tsl';
import { PAL } from '../palette.js';

const rgb = ( c ) => vec3( c.r, c.g, c.b );

export const FACTION = { PROTESTER: 0, POLICE: 1, BYSTANDER: 2, COUNTER: 3, ARRESTED: - 2, ARRESTED_SITTER: - 3, GONE: - 4 };
export const ROLE = { MEMBER: 0, LEADER: 1, SITTER: 2, BIKE: 4 };
export const MODE = {
	MARCH: 0, HOLD: 1, RIOT: 2, DISPERSE: 3, SIT: 4, SHIELD: 5, PUSH: 6, STORM: 7, PANIC: 9, // protesters / counter-protesters
	// SHIELD: a march behind locked arms and banners · PUSH / STORM: fired-up marches that lean on / break police lines
	// PANIC: civilians or bystanders running for their lives (their flow field + away from u.panicAt), nobody fights
	MOVE: 0, FORMATION: 1, CHARGE: 2, ARREST: 3, SHOVE: 8, // police
	// SHOVE: a cordon advancing shields up (World.shieldPush): a formation that pushes crowds back hard and takes fewer blows
};
const SHOVE_K = 2.2, SHOVE_HOLD = 0.5, SHOVE_ARMOUR = 0.5; // shield push: × push on civilians · × push back on officers · × blows taken
// stats buffer layout (uint counters, recomputed every step)
export const STAT = {
	PROT: 0, PROT_AG: 1, POLICE: 2, COUNTER: 3, BYSTANDER: 4, SITTERS: 5,
	INJ_BY_POLICE: 6, INJ_OTHER: 7, INJ_POLICE: 8, ARRESTED: 9, ARRESTED_SITTERS: 10, GONE: 11, CLASH: 12, KILLED: 13, KILLED_POLICE: 14,
	VEH_BLOCK: 16, VEH_ATTACK: 24, ZONE: 32, // + vehicle index / zone index
};
const NSTAT = 48;
export const MAX_VEHICLES = 8, MAX_ZONES = 16, MAX_GAS = 8, MAX_JETS = 4, MAX_EDITS = 2048, MAX_SHELTER = 8;
export const ZONE = { PROT: 1, PROT_FACADE: 2, COUNTER: 3, POLICE: 4, CIVIL: 5, PROT_STAY: 6 }; // PROT_STAY: protesters not on their way home

const CELL = 1.25; // spatial hash cell (≥ interaction radius)
const TABLE = 1 << 18; // hash buckets
const K = 16; // max agents per bucket (overflow agents are simply not seen as neighbours)
const DENS_RES = 4; // coarse density grid, same as the cost/flow grid
const DCH = 6; // density channels: prot, police, bystander, counter, agitation×100, injured
const R_SAME = 0.62, R_OTHER = 0.7, R_ENEMY = 0.85; // rest distances (m) — springs, so they compress
const K_REP = 38, C_DAMP = 3.0, K_WALL = 60, WALL_R = 0.35, TAU = 0.45;
const CONTACT = 1.05;
const VEH_HALF = [ 1.2, 2.8 ]; // vehicle half width / half length (m)
const BIKE_SPEED = 2.6, BIKE_GAP = 0.45; // riders: speed multiplier, extra personal space (m)

export class Crowd {

	constructor( renderer, city, flow, { maxAgents = 98304, maxGroups = 4096 } = {} ) {

		this.renderer = renderer;
		this.N = maxAgents;
		this.G = maxGroups;
		this.count = 0;

		const [ x0, y0, x1, y1 ] = city.bounds;
		this.bounds = city.bounds;
		this.dw = Math.ceil( ( x1 - x0 ) / DENS_RES );
		this.dh = Math.ceil( ( y1 - y0 ) / DENS_RES );

		// Packed so the update kernel stays within WebGPU's default 8 storage buffers per stage.
		const N = this.N;
		this.DENS0 = TABLE + TABLE * K;
		this.pv = instancedArray( N, 'vec4' ); // pos.xy, vel.xy
		this.st = instancedArray( N, 'vec4' );
		this.ex = instancedArray( N, 'vec4' );
		this.nx = instancedArray( N * 3, 'vec4' ); // next: st [0,N) · ex [N,2N) · vel [2N,3N)
		this.off = instancedArray( N, 'vec2' ); // formation offset (police)
		this.groups = instancedArray( this.G * 2, 'vec4' ); // gA [0,G) · gB [G,2G)
		// atomic grid: hash counts [0,T) · hash items [T, T+T·K) · density [DENS0, +dw·dh·DCH)
		this.grid = instancedArray( this.DENS0 + this.dw * this.dh * DCH, 'uint' ).toAtomic();
		this.stats = instancedArray( NSTAT, 'uint' ).toAtomic();
		this.edits = instancedArray( MAX_EDITS * 3, 'vec4' );
		this.pendingEdits = [];

		const dataTex = ( data, w, h, type ) => {

			const t = new THREE.DataTexture( data, w, h, THREE.RedFormat, type );
			t.minFilter = t.magFilter = THREE.LinearFilter;
			t.needsUpdate = true;
			return t;

		};

		// signed distance field → r8snorm texture, metres = sample * 12.7
		this.sdfTex = dataTex( city.sdfData, city.sdf.w, city.sdf.h, THREE.ByteType );
		this.cctvTex = dataTex( city.cctvData, city.cctv.w, city.cctv.h, THREE.UnsignedByteType );
		this.cctvTex.minFilter = this.cctvTex.magFilter = THREE.NearestFilter;
		this.flow = flow;

		this.u = {
			dt: uniform( 1 / 60 ),
			active: uniform( 0, 'uint' ),
			editCount: uniform( 0, 'uint' ),
			min: uniform( new THREE.Vector2( x0, y0 ) ),
			size: uniform( new THREE.Vector2( x1 - x0, y1 - y0 ) ),
			// contact injuries: ~45 s of sustained blows down a protester, ~60 s an officer (shields, helmets), so
			// lines break under pressure rather than melting away (was 0.05 / 0.03: ~10 s / ~8 s)
			policeForce: uniform( 0.012 ), // health/s a protester loses in contact with a baseline officer
			riotForce: uniform( 0.004 ), // health/s an officer loses per fully agitated attacker
			attackCap: uniform( 2 ), // at most this many attackers' worth of blows land on one officer at a time
			holdRestraint: uniform( 0.3 ), // officers holding a formation hit calm people this much (agitated ones in full)
			recover: uniform( 0.01 ), // health/s regained by anyone not being hit (bruises, a breather behind the line)
			policeMass: uniform( 2.5 ), // how much harder protesters are pushed by police than vice versa
			arrestRate: uniform( 0.35 ), // arrest progress/s per arresting officer in contact
			exitLayer: uniform( 0, 'float' ), // flow layer toward the map exits (people going home)
			resolveDecay: uniform( 0.0015 ), // baseline loss of commitment per second
			vehicleCount: uniform( 0, 'int' ),
			provokeCount: uniform( 0, 'int' ), // the first n vehicles (the VIP convoy) draw agitated protesters
			vehicles: uniformArray( Array.from( { length: MAX_VEHICLES }, () => new THREE.Vector4() ), 'vec4' ), // x, y, cos, sin
			gas: uniformArray( Array.from( { length: MAX_GAS }, () => new THREE.Vector4() ), 'vec4' ), // x, y, r, strength
			jets: uniformArray( Array.from( { length: MAX_JETS }, () => new THREE.Vector4() ), 'vec4' ), // water cannon: x, y, angle, range
			zones: uniformArray( Array.from( { length: MAX_ZONES }, () => new THREE.Vector4() ), 'vec4' ), // x, y, r, type
			mpp: uniform( 1 ),
			selA: uniform( - 1, 'float' ),
			selB: uniform( - 1, 'float' ),
			revealLeaders: uniform( 0, 'float' ),
			shelter: uniformArray( new Array( MAX_SHELTER ).fill( - 1 ), 'float' ), // groups under umbrellas: tear gas barely reaches them
			parting: uniform( - 1, 'float' ), // a group its own side makes way for (the banner): they are shoved aside, it barely feels them
			panicAt: uniform( new THREE.Vector4() ), // x, y, radius, strength: what panicking people run from (gunfire)
		};

		this._buildKernels();

	}

	// ---------------------------------------------------------------- CPU-side setup

	// Fill agent slots before the first upload(). After that use spawn().
	addAgents( list ) {

		const P = this.pv.value.array, S = this.st.value.array, E = this.ex.value.array, O = this.off.value.array;
		for ( const a of list ) {

			const i = this.count ++;
			if ( i >= this.N ) throw new Error( 'agent capacity exceeded' );
			P[ i * 4 ] = a.x; P[ i * 4 + 1 ] = a.y;
			S[ i * 4 ] = a.faction; S[ i * 4 + 1 ] = a.group; S[ i * 4 + 2 ] = a.agitation ?? 0; S[ i * 4 + 3 ] = 1;
			E[ i * 4 + 1 ] = a.resolve ?? 1; E[ i * 4 + 3 ] = a.role ?? ( a.leader ? ROLE.LEADER : ROLE.MEMBER );
			O[ i * 2 ] = a.ox ?? 0; O[ i * 2 + 1 ] = a.oy ?? 0;
			a.index = i;

		}

		return list;

	}

	upload() {

		for ( const b of [ this.pv, this.st, this.ex, this.off ] ) b.value.needsUpdate = true;
		this.u.active.value = this.count;
		this.mesh.count = this.count;
		this.uploaded = true;

	}

	// Runtime spawn through the edit queue (GPU owns the agent buffers after upload()).
	spawn( list ) {

		for ( const a of list ) {

			const i = this.count ++;
			if ( i >= this.N ) { this.count --; return list.filter( ( b ) => b.index !== undefined ); }
			a.index = i;
			this.pendingEdits.push( [ i, 1, a.x, a.y, a.faction, a.group, a.agitation ?? 0, 1, 0, a.resolve ?? 1, 0, a.role ?? ( a.leader ? ROLE.LEADER : ROLE.MEMBER ) ] );

		}

		this.u.active.value = this.count;
		this.mesh.count = this.count;
		return list;

	}

	// put an existing agent slot back on the map (police crews getting out of a car)
	place( i, { x, y, faction, group, role = ROLE.MEMBER } ) {

		this.pendingEdits.push( [ i, 1, x, y, faction, group, 0, 1, 0, 1, 0, role ] );

	}

	setFaction( i, faction ) {

		this.pendingEdits.push( [ i, 2, 0, 0, faction, 0, 0, 0, 0, 0, 0, 0 ] );

	}

	compareFaction( member, expected, faction, group ) {

		this.pendingEdits.push( [ member, 6, 0, 0, faction, expected, 0, 0, group, 0, 0, 0 ] );

	}

	// add to agitation / resolve of one agent
	nudge( i, dAgitation, dResolve ) {

		this.pendingEdits.push( [ i, 3, 0, 0, 0, 0, dAgitation, 0, 0, dResolve, 0, 0 ] );

	}

	// move an agent to another group (split / merge) with a new role (member / leader); riders keep their bikes
	regroup( i, group, role = ROLE.MEMBER ) {

		this.pendingEdits.push( [ i, 4, 0, 0, 0, group, 0, 0, 0, 0, 0, role ] );

	}

	// raise an agent's resolve to at least `floor` (an order from their leader brings waverers back)
	recall( i, floor ) {

		this.pendingEdits.push( [ i, 5, 0, 0, 0, 0, 0, 0, 0, floor, 0, 0 ] );

	}

	_flushEdits() {

		const n = Math.min( this.pendingEdits.length, MAX_EDITS );
		if ( n === 0 ) return false;
		const A = this.edits.value.array;
		for ( let k = 0; k < n; k ++ ) A.set( this.pendingEdits[ k ], k * 12 );
		this.pendingEdits.splice( 0, n );
		this.edits.value.needsUpdate = true;
		this.u.editCount.value = n;
		return true;

	}

	setGroup( g, { layer, leader, speed, mode, ax, ay, scale, aggression, morale } ) {

		const A = this.groups.value.array, B = A.subarray( this.G * 4 );
		if ( layer !== undefined ) A[ g * 4 ] = layer;
		if ( leader !== undefined ) A[ g * 4 + 1 ] = leader;
		if ( speed !== undefined ) A[ g * 4 + 2 ] = speed;
		if ( mode !== undefined ) A[ g * 4 + 3 ] = mode;
		if ( ax !== undefined ) B[ g * 4 ] = ax;
		if ( ay !== undefined ) B[ g * 4 + 1 ] = ay;
		if ( scale !== undefined ) B[ g * 4 + 2 ] = scale;
		if ( aggression !== undefined ) B[ g * 4 + 3 ] = aggression;
		if ( morale !== undefined ) B[ g * 4 + 3 ] = morale;
		this.groups.value.needsUpdate = true;

	}

	getGroup( g ) {

		const A = this.groups.value.array, B = A.subarray( this.G * 4 );
		return { layer: A[ g * 4 ], leader: A[ g * 4 + 1 ], speed: A[ g * 4 + 2 ], mode: A[ g * 4 + 3 ],
			ax: B[ g * 4 ], ay: B[ g * 4 + 1 ], scale: B[ g * 4 + 2 ], aggression: B[ g * 4 + 3 ] };

	}

	setOffsets( indices, offsets ) {

		const O = this.off.value.array;
		indices.forEach( ( i, k ) => { O[ i * 2 ] = offsets[ k * 2 ]; O[ i * 2 + 1 ] = offsets[ k * 2 + 1 ]; } );
		this.off.value.needsUpdate = true;

	}

	setVehicles( list, provoking = list.length ) { // [{x, y, heading}]; the first `provoking` attract rioters

		const V = this.u.vehicles.array;
		list.slice( 0, MAX_VEHICLES ).forEach( ( v, k ) => V[ k ].set( v.x, v.y, Math.cos( v.heading ), Math.sin( v.heading ) ) );
		this.u.vehicleCount.value = Math.min( list.length, MAX_VEHICLES );
		this.u.provokeCount.value = Math.min( provoking, MAX_VEHICLES );

	}

	setGas( list ) { // [{x, y, r, strength}]

		const A = this.u.gas.array;
		for ( let k = 0; k < MAX_GAS; k ++ ) {

			const g = list[ k ];
			A[ k ].set( g ? g.x : 0, g ? g.y : 0, g ? g.r : 0, g ? g.strength : 0 );

		}

	}

	setJets( list ) { // [{x, y, angle, range}]

		const A = this.u.jets.array;
		for ( let k = 0; k < MAX_JETS; k ++ ) {

			const j = list[ k ];
			A[ k ].set( j ? j.x : 0, j ? j.y : 0, j ? j.angle : 0, j ? j.range : 0 );

		}

	}

	setShelter( ids ) { // group ids under umbrellas

		const A = this.u.shelter.array;
		for ( let k = 0; k < MAX_SHELTER; k ++ ) A[ k ] = ids[ k ] ?? - 1;

	}

	setZones( list ) { // [{x, y, r, type}]

		const A = this.u.zones.array;
		for ( let k = 0; k < MAX_ZONES; k ++ ) {

			const z = list[ k ];
			A[ k ].set( z ? z.x : 0, z ? z.y : 0, z ? z.r : 0, z ? z.type : 0 );

		}

	}

	async readBuffer( node, n = node.value.count * node.value.itemSize ) {

		return new Float32Array( await this.renderer.getArrayBufferAsync( node.value ), 0, n );

	}

	async readPositions() {

		const pv = await this.readBuffer( this.pv, this.count * 4 );
		const out = new Float32Array( this.count * 2 );
		for ( let i = 0; i < this.count; i ++ ) { out[ i * 2 ] = pv[ i * 4 ]; out[ i * 2 + 1 ] = pv[ i * 4 + 1 ]; }
		return out;

	}

	async readState() {

		return this.readBuffer( this.st, this.count * 4 );

	}

	async readStats() {

		return new Uint32Array( await this.renderer.getArrayBufferAsync( this.stats.value ) );

	}

	step() {

		const k = this._flushEdits() ? [ this.editKernel, ...this.kernels ] : this.kernels;
		if ( ! this._dbg && location.search.includes( 'debug' ) ) {

			this._dbg = true;
			k.forEach( ( kn, n ) => { console.log( 'kernel', n ); this.renderer.compute( kn ); } );
			return;

		}

		this.renderer.compute( k );

	}

	// ---------------------------------------------------------------- GPU kernels

	_buildKernels() {

		const { pv, st, ex, nx, off, groups, grid, stats, edits, u } = this;
		const N = this.N, G = this.G;
		// views into the packed buffers
		const at = ( buf, base, swz ) => ( { element: ( i ) => {

			const e = buf.element( base ? uint( i ).add( uint( base ) ) : i );
			return swz ? e[ swz ] : e;

		} } );
		const pos = at( pv, 0, 'xy' ), vel = at( pv, 0, 'zw' );
		const stN = at( nx, 0 ), exN = at( nx, N ), velN = at( nx, 2 * N );
		const gA = at( groups, 0 ), gB = at( groups, G );
		const cellCount = at( grid, 0 ), cellItems = at( grid, TABLE ), dens = at( grid, this.DENS0 );
		const sdfTex = this.sdfTex, flowTex = this.flow.texture;
		const DW = this.dw, DH = this.dh;

		const cellOf = ( p ) => ivec2( floor( p.sub( u.min ).div( CELL ) ) );
		const hashCell = ( cx, cy ) => uint( cx ).mul( uint( 73856093 ) ).bitXor( uint( cy ).mul( uint( 19349663 ) ) ).bitAnd( uint( TABLE - 1 ) );
		const sdfAt = ( p ) => texture( sdfTex, p.sub( u.min ).div( u.size ), 0 ).x.mul( 12.7 );
		const sdfGrad = ( p ) => {

			const e = 0.5;
			const gx = sdfAt( p.add( vec2( e, 0 ) ) ).sub( sdfAt( p.sub( vec2( e, 0 ) ) ) );
			const gy = sdfAt( p.add( vec2( 0, e ) ) ).sub( sdfAt( p.sub( vec2( 0, e ) ) ) );
			return vec2( gx, gy ).div( max( length( vec2( gx, gy ) ), 1e-4 ) );

		};
		const flowAt = ( p, layer ) => texture( flowTex, p.sub( u.min ).div( u.size ), 0 ).depth( int( layer ) ).xy;

		const densIndex = ( p ) => {

			const c = ivec2( floor( p.sub( u.min ).div( DENS_RES ) ) );
			const cx = clamp( c.x, int( 0 ), int( DW - 1 ) ), cy = clamp( c.y, int( 0 ), int( DH - 1 ) );
			return uint( cy.mul( DW ).add( cx ) ).mul( uint( DCH ) );

		};

		// channel must be a JS number: a runtime (node) channel index miscompiled to f32 in the index expression
		const densAt = ( p, ch ) => float( atomicLoad( dens.element( densIndex( p ).add( uint( ch ) ) ) ).toVar() );
		// gradient of a density channel over ±2 cells (8 m): points toward "more of it"
		const densGrad = ( p, ch ) => {

			const e = DENS_RES * 2;
			return vec2(
				densAt( p.add( vec2( e, 0 ) ), ch ).sub( densAt( p.sub( vec2( e, 0 ) ), ch ) ),
				densAt( p.add( vec2( 0, e ) ), ch ).sub( densAt( p.sub( vec2( 0, e ) ), ch ) )
			);

		};

		// vehicle-local coordinates: x across, y along heading
		const vehLocal = ( p, vv ) => {

			const d = p.sub( vv.xy );
			return vec2( d.x.mul( vv.w ).sub( d.y.mul( vv.z ) ), d.x.mul( vv.z ).add( d.y.mul( vv.w ) ) );

		};

		// --- edits (spawn / set faction / nudge)
		this.editKernel = Fn( () => {

			const k = instanceIndex;
			If( k.greaterThanEqual( u.editCount ), () => { Return(); } );
			const a = edits.element( k.mul( uint( 3 ) ) );
			const b = edits.element( k.mul( uint( 3 ) ).add( uint( 1 ) ) );
			const c = edits.element( k.mul( uint( 3 ) ).add( uint( 2 ) ) );
			const i = uint( a.x );
			const op = a.y;
			If( op.equal( 1 ), () => {

				pv.element( i ).assign( vec4( a.z, a.w, 0, 0 ) );
				st.element( i ).assign( b );
				ex.element( i ).assign( c );

			} );
			If( op.equal( 2 ), () => { st.element( i ).x.assign( b.x ); } );
			If( op.equal( 6 ), () => {

				If( st.element( i ).x.equal( b.y ).and( st.element( i ).y.equal( c.x ) ), () => { st.element( i ).x.assign( b.x ); } );

			} );
			If( op.equal( 4 ), () => {

				st.element( i ).y.assign( b.y );
				ex.element( i ).w.assign( c.w.add( select( ex.element( i ).w.greaterThan( 3.5 ), 4.0, 0.0 ) ) );

			} );
			If( op.equal( 5 ), () => { ex.element( i ).y.assign( max( ex.element( i ).y, c.y ) ); } );
			If( op.equal( 3 ), () => {

				st.element( i ).z.assign( clamp( st.element( i ).z.add( b.z ), 0, 1 ) );
				ex.element( i ).y.assign( min( ex.element( i ).y.add( c.y ), 1.5 ) );

			} );

		} )().compute( MAX_EDITS, [ 64 ] );

		// --- clear
		const clear = Fn( () => {

			const i = instanceIndex;
			atomicStore( cellCount.element( i ), uint( 0 ) );
			If( i.lessThan( uint( NSTAT ) ), () => { atomicStore( stats.element( i ), uint( 0 ) ); } );

		} )().compute( TABLE, [ 64 ] );

		const clearDens = Fn( () => {

			atomicStore( dens.element( instanceIndex ), uint( 0 ) );

		} )().compute( DW * DH * DCH, [ 64 ] );

		// --- insert
		const insert = Fn( () => {

			const i = instanceIndex;
			If( i.greaterThanEqual( u.active ), () => { Return(); } );
			const s = st.element( i );
			If( s.x.lessThan( 0 ), () => { Return(); } );
			const p = pos.element( i );
			const c = cellOf( p );
			const h = hashCell( c.x, c.y );
			const slot = atomicAdd( cellCount.element( h ), uint( 1 ) ).toVar();
			If( slot.lessThan( uint( K ) ), () => {

				atomicStore( cellItems.element( h.mul( uint( K ) ).add( slot ) ), i );

			} );
			const di = densIndex( p );
			If( s.x.lessThan( 3.5 ), () => {

				atomicAdd( dens.element( di.add( uint( s.x ) ) ), uint( 1 ) );
				atomicAdd( dens.element( di.add( uint( 4 ) ) ), uint( s.z.mul( 100 ) ) );

			} ).Else( () => {

				atomicAdd( dens.element( di.add( uint( 5 ) ) ), uint( 1 ) );

			} );

		} )().compute( this.N, [ 64 ] );

		// --- update
		const update = Fn( () => {

			const i = instanceIndex;
			If( i.greaterThanEqual( u.active ), () => { Return(); } );
			const s = st.element( i ).toVar();
			const e = ex.element( i ).toVar();
			const fac = s.x;

			If( fac.lessThan( 0 ).or( fac.greaterThan( 3.5 ) ), () => {

				velN.element( i ).assign( vec4( 0 ) );
				stN.element( i ).assign( s );
				exN.element( i ).assign( e );
				Return();

			} );

			const p = pos.element( i ).toVar();
			const v = vel.element( i ).toVar();
			const dt = u.dt;
			const isProt = fac.lessThan( 0.5 );
			const isPol = fac.greaterThan( 0.5 ).and( fac.lessThan( 1.5 ) );
			const isBy = fac.greaterThan( 1.5 ).and( fac.lessThan( 2.5 ) );
			const isCtr = fac.greaterThan( 2.5 );
			const isCiv = isProt.or( isCtr ); // politically engaged civilians: protesters and counter-protesters
			const bike = e.w.greaterThan( 3.5 );
			const role = e.w.sub( select( bike, 4.0, 0.0 ) );
			const isLeader = role.greaterThan( 0.5 ).and( role.lessThan( 1.5 ) );
			const resolve = e.y;

			const gi = uint( s.y );
			const ga = gA.element( gi ).toVar();
			const gb = gB.element( gi ).toVar();
			const mode = ga.w;
			const ag = s.z;
			// sitting: per agent (the sitter role) or a whole group that sat down
			const isSitter = role.greaterThan( 1.5 ).or( isCiv.and( mode.equal( MODE.SIT ) ) );
			const shield = isCiv.and( mode.equal( MODE.SHIELD ) );
			// fired up: PUSH leans on police lines, STORM goes through them whatever it costs (both keep marching to their goal)
			const push = isCiv.and( mode.equal( MODE.PUSH ) );
			const storm = isCiv.and( mode.equal( MODE.STORM ) );
			const leaving = isCiv.and( resolve.lessThan( 0 ) ).and( isSitter.not() );
			// police holding (or advancing in) a formation: officers seek their own slot round the group anchor
			const shove = isPol.and( mode.equal( MODE.SHOVE ) );
			const formation = isPol.and( mode.equal( MODE.FORMATION ) ).or( shove );
			const panic = isPol.not().and( mode.equal( MODE.PANIC ) );

			// ---- hierarchy: read own leader's state
			const li = uint( ga.y );
			const ls = st.element( li );
			const le = ex.element( li );
			const lp = pos.element( li );
			const leaderDown = ls.x.lessThan( - 1.5 ).or( ls.x.greaterThan( 9.5 ) ); // injured or arrested
			const leaderHit = le.x.greaterThan( 0 ).and( isLeader.not() );

			// ---- desired direction
			const flow = flowAt( p, select( leaving, u.exitLayer, ga.x ) ).toVar();
			const dir = vec2( 0 ).toVar();
			If( length( flow ).greaterThan( 0.05 ), () => { dir.assign( normalize( flow ) ); } );

			// police formations: seek own anchor once close enough, otherwise follow the flow field to it
			If( formation, () => {

				const o = off.element( i ).mul( gb.z );
				const anchor = gb.xy.add( o );
				const toA = anchor.sub( p );
				const dA = length( toA );
				// close to the formation (its own extent + margin) or flow exhausted → walk to own slot
				const nearFormation = length( p.sub( gb.xy ) ).lessThan( length( o ).add( 30 ) );
				If( dA.lessThan( 25 ).or( nearFormation ).or( length( flow ).lessThan( 0.05 ) ), () => {

					dir.assign( toA.div( max( dA, 1e-3 ) ).mul( min( dA.mul( 0.8 ), 1.0 ) ) );

				} );

			} );
			// arrest / charge squads close in on their target point (gB.xy) once the flow field runs out
			If( isPol.and( mode.greaterThan( 1.5 ) ).and( mode.lessThan( 3.5 ) ).and( length( flow ).lessThan( 0.05 ) ), () => {

				const toT = gb.xy.sub( p );
				dir.assign( toT.div( max( length( toT ), 1 ) ) );

			} );

			// cohesion: members drift back toward their leader when strung out (unless leader is down)
			If( isLeader.not().and( isSitter.not() ).and( leaderDown.not() ).and( isBy.not() ).and( leaving.not() )
				.and( formation.not() ).and( panic.not() ), () => {

				const toL = lp.sub( p );
				const dL = length( toL );
				If( dL.greaterThan( 10 ), () => {

					// civilians: strung out past ~12 m they follow the leader rather than their own branch of the flow
					// field (where two routes are equally short a group would otherwise split round a block)
					If( isCiv, () => { dir.assign( mix( dir, toL.div( dL ), smoothstep( 12, 35, dL ) ) ); } )
						.Else( () => { dir.addAssign( toL.div( dL ).mul( min( dL.sub( 10 ).mul( 0.04 ), 0.9 ) ) ); } );

				} );

			} );

			// riot mode or high agitation → move toward the enemy: police, and the other camp
			If( isCiv.and( leaving.not() ).and( isSitter.not() ).and( storm.not() ).and( panic.not() ).and( mode.equal( MODE.RIOT ).or( ag.greaterThan( 0.85 ) ) ), () => {

				const rival = select( isProt, densGrad( p, 3 ), densGrad( p, 0 ) );
				const gp = densGrad( p, 1 ).add( rival.mul( 1.5 ) );
				If( length( gp ).greaterThan( 0.5 ), () => {

					dir.assign( mix( dir, normalize( gp ), 0.75 ) );

				} );

			} );

			// convoy: agitated protesters converge on vehicles they can see
			const vehDir = vec2( 0 ).toVar();
			Loop( { start: int( 0 ), end: u.provokeCount, type: 'int', name: 'vi' }, ( { vi } ) => {

				const vv = u.vehicles.element( vi );
				const toV = vv.xy.sub( p );
				const dV = length( toV );
				If( dV.lessThan( 70 ), () => { vehDir.addAssign( toV.div( max( dV, 1 ) ).mul( float( 70 ).sub( dV ) ) ); } );

			} );
			const nearVehicle = length( vehDir ).greaterThan( 0 );
			If( isProt.and( nearVehicle ).and( ag.greaterThan( 0.45 ) ).and( leaving.not() ).and( isSitter.not() ).and( panic.not() ), () => {

				dir.assign( mix( dir, normalize( vehDir ), 0.8 ) );

			} );

			// panic: away from the guns as well as along the group's escape field, harder the closer they are
			If( panic.and( u.panicAt.w.greaterThan( 0 ) ), () => {

				const away = p.sub( u.panicAt.xy );
				const dP = length( away );
				dir.assign( normalize( mix( dir, away.div( max( dP, 1 ) ), clamp( float( 1 ).sub( dP.div( u.panicAt.z ) ), 0, 0.7 ).mul( u.panicAt.w ) ).add( vec2( 1e-4, 0 ) ) ) );

			} );

			// fleeing: bystanders always, protesters dispersing / going home, anyone in a panic
			const flee = isBy.or( isCiv.and( mode.equal( MODE.DISPERSE ) ) ).or( leaving ).or( panic );
			If( isCiv.and( mode.equal( MODE.DISPERSE ) ).and( leaving.not() ), () => { dir.assign( dir.negate() ); } );
			If( flee, () => {

				// panicking people ignore the crowd's agitation: they all carry it, so it pushed them apart onto the 4 m grid's cells
				const threat = densGrad( p, 4 ).mul( select( panic, 0.0, 0.02 ) ).add( densGrad( p, 1 ).mul( 0.6 ) ).add( densGrad( p, 5 ).mul( 0.5 ) );
				const tl = length( threat );
				If( tl.greaterThan( 0.3 ), () => {

					dir.assign( mix( dir, threat.div( tl ).negate(), min( tl.mul( 0.4 ), 0.9 ) ) );

				} );

			} );

			// tear gas: civilians bolt out of the cloud
			const gassed = float( 0 ).toVar();
			Loop( { start: int( 0 ), end: int( MAX_GAS ), type: 'int', name: 'gi2' }, ( { gi2 } ) => {

				const gz = u.gas.element( gi2 );
				const toG = p.sub( gz.xy );
				const dG = length( toG );
				If( gz.z.greaterThan( 0 ).and( dG.lessThan( gz.z ) ), () => {

					const k = gz.w.mul( float( 1 ).sub( dG.div( gz.z ).mul( 0.6 ) ) );
					gassed.addAssign( k );
					If( isPol.not(), () => { dir.assign( mix( dir, toG.div( max( dG, 0.5 ) ), min( k, 0.95 ) ) ); } );

				} );

			} );
			// umbrellas: a sheltered group takes a quarter of the gas
			const sheltered = float( 1 ).toVar();
			Loop( { start: int( 0 ), end: int( MAX_SHELTER ), type: 'int', name: 'sh' }, ( { sh } ) => {

				If( abs( u.shelter.element( sh ).sub( s.y ) ).lessThan( 0.5 ), () => { sheltered.assign( 0.25 ); } );

			} );
			const gasK = select( isPol, float( 0 ), min( gassed, 1 ).mul( sheltered ) );

			// water cannon: a cone that shoves civilians back hard and saps their resolve
			const soaked = float( 0 ).toVar();
			const jetPush = vec2( 0 ).toVar();
			Loop( { start: int( 0 ), end: int( MAX_JETS ), type: 'int', name: 'wj' }, ( { wj } ) => {

				const jz = u.jets.element( wj );
				const jd = vec2( cos( jz.z ), sin( jz.z ) );
				const rel = p.sub( jz.xy );
				const along = dot( rel, jd );
				const across = abs( dot( rel, vec2( jd.y.negate(), jd.x ) ) );
				If( jz.w.greaterThan( 0 ).and( along.greaterThan( 0 ) ).and( along.lessThan( jz.w ) ).and( across.lessThan( along.mul( 0.28 ).add( 1.0 ) ) ), () => {

					const k = float( 1 ).sub( along.div( jz.w ) );
					soaked.addAssign( k );
					jetPush.addAssign( jd.mul( k.mul( 30 ) ) );

				} );

			} );
			If( isPol, () => { soaked.assign( 0 ); jetPush.assign( vec2( 0 ) ); } );

			// personal heading bias (±~17°, fixed per agent) so blocs spread across a street instead of lining up
			const bias = fract( sin( float( i ).mul( 12.9898 ) ).mul( 43758.5453 ) ).sub( 0.5 ).mul( 0.6 ).mul( select( formation, 0.0, 1.0 ) );
			const cb = cos( bias ), sb = sin( bias );
			dir.assign( vec2( dir.x.mul( cb ).sub( dir.y.mul( sb ) ), dir.x.mul( sb ).add( dir.y.mul( cb ) ) ) );

			const base = select( isPol, 1.45, select( isBy, 1.15, 1.25 ) ).mul( ga.z );
			// police charge doubles speed; holding protesters only shuffle; sitters stay put
			const modeK = select( isPol.and( mode.equal( MODE.CHARGE ) ), 2.0,
				select( isPol.and( mode.equal( MODE.ARREST ) ), 1.2, select( panic, 1.35,
					select( isCiv.and( mode.equal( MODE.HOLD ) ).and( leaving.not() ), 0.12, select( shield, 0.55, 1.0 ) ) ) ) );
			// civilian leaders wait for their group (gB.xy holds the group's centre, written by the CPU each readback) —
			// only when it is behind them: a leader that has fallen behind its group must catch up, not slow down
			const toC = gb.xy.sub( p );
			const behind = dot( toC, dir ).lessThan( 0 );
			const wait = select( isLeader.and( isCiv ).and( leaving.not() ).and( panic.not() ).and( behind ), clamp( float( 1 ).sub( length( toC ).sub( 10 ).div( 15 ) ), 0.15, 1.0 ), float( 1 ) );
			const speed = base.mul( ag.mul( 1.1 ).add( 1 ) ).mul( modeK ).mul( gasK.mul( 0.6 ).add( 1 ) ).mul( select( isSitter, 0.0, 1.0 ) ).mul( select( bike, BIKE_SPEED, 1.0 ) ).mul( wait );
			const vDes = dir.mul( speed ).toVar();

			// ---- walls: slide along, and push out when inside the margin
			const sd = sdfAt( p );
			const grad = sdfGrad( p );
			const force = vec2( 0 ).toVar();
			If( sd.lessThan( 1.5 ), () => {

				const into = dot( vDes, grad );
				If( into.lessThan( 0 ), () => { vDes.subAssign( grad.mul( into ).mul( smoothstep( 1.5, 0.3, sd ) ) ); } );
				If( sd.lessThan( WALL_R ), () => { force.addAssign( grad.mul( float( WALL_R ).sub( sd ) ).mul( K_WALL ) ); } );

			} );

			// ---- vehicles are moving walls
			Loop( { start: int( 0 ), end: u.vehicleCount, type: 'int', name: 'vj' }, ( { vj } ) => {

				const vv = u.vehicles.element( vj );
				const l = vehLocal( p, vv );
				const px = float( VEH_HALF[ 0 ] + 0.4 ).sub( abs( l.x ) );
				const py = float( VEH_HALF[ 1 ] + 0.4 ).sub( abs( l.y ) );
				If( px.greaterThan( 0 ).and( py.greaterThan( 0 ) ), () => {

					// push out along the axis of least penetration, rotated back to world space
					const lx = select( px.lessThan( py ), sign( l.x ).mul( px ), float( 0 ) );
					const ly = select( px.lessThan( py ), float( 0 ), sign( l.y ).mul( py ) );
					force.addAssign( vec2( lx.mul( vv.w ).add( ly.mul( vv.z ) ), ly.mul( vv.w ).sub( lx.mul( vv.z ) ) ).mul( K_WALL ) );

				} );

			} );

			force.addAssign( jetPush );

			// ---- neighbours
			const pressure = float( 0 ).toVar();
			const nAg = float( 0 ).toVar();
			const nCnt = float( 0 ).toVar();
			const contact = float( 0 ).toVar();
			const arresting = float( 0 ).toVar();
			const dmgPolice = float( 0 ).toVar();
			const dmgOther = float( 0 ).toVar();
			const c = cellOf( p );

			Loop( { start: int( - 1 ), end: int( 2 ), type: 'int', name: 'oy' }, ( { oy } ) => {

				Loop( { start: int( - 1 ), end: int( 2 ), type: 'int', name: 'ox' }, ( { ox } ) => {

					const cx = c.x.add( ox ), cy = c.y.add( oy );
					const h = hashCell( cx, cy );
					const cnt = min( atomicLoad( cellCount.element( h ) ).toVar(), uint( K ) ).toVar();

					Loop( { start: uint( 0 ), end: cnt, type: 'uint', name: 'k' }, ( { k } ) => {

						const j = atomicLoad( cellItems.element( h.mul( uint( K ) ).add( k ) ) ).toVar();
						If( j.notEqual( i ), () => {

							const q = pos.element( j );
							const qc = cellOf( q );
							// skip hash collisions (agent belongs to a different cell in the same bucket)
							If( qc.x.equal( cx ).and( qc.y.equal( cy ) ), () => {

								const d = p.sub( q );
								const d2 = dot( d, d );
								If( d2.lessThan( 1.6 ).and( d2.greaterThan( 1e-8 ) ), () => {

									const sj = st.element( j );
									const fj = sj.x;
									const dist = sqrt( d2 );
									const n = d.div( dist );
									const same = abs( fj.sub( fac ) ).lessThan( 0.5 );
									const jProt = fj.lessThan( 0.5 ), jPol = fj.greaterThan( 0.5 ).and( fj.lessThan( 1.5 ) );
									const jCtr = fj.greaterThan( 2.5 ).and( fj.lessThan( 3.5 ) );
									const jCiv = jProt.or( jCtr );
									const enemy = isCiv.and( jPol ).or( isPol.and( jCiv ) ).or( isProt.and( jCtr ) ).or( isCtr.and( jProt ) );
									const jBike = ex.element( j ).w.greaterThan( 3.5 );
									const r0 = select( same, float( R_SAME ), select( enemy, float( R_ENEMY ), float( R_OTHER ) ) )
										.add( select( bike.or( jBike ), float( BIKE_GAP ), float( 0 ) ) );
									const overlap = r0.sub( dist );

									If( overlap.greaterThan( 0 ), () => {

										// the crowd makes way for the banner: within the same faction, the parting group pushes hard and is barely pushed
										const iPart = abs( s.y.sub( u.parting ) ).lessThan( 0.5 ), jPart = abs( sj.y.sub( u.parting ) ).lessThan( 0.5 );
										const part = select( same.and( iPart ).and( jPart.not() ), 0.25, select( same.and( jPart ).and( iPart.not() ), 2.5, 1.0 ) );
										// police push fired-up crowds back less, and a storming crowd shoves officers out of its way
										const jMode = gA.element( uint( sj.y ) ).w;
										const lean = select( shield, 0.4, select( push, 0.55, select( storm, 0.2, 1.0 ) ) );
										// a shield push drives the crowd back and leans into it
										const shoveBy = select( jMode.equal( MODE.STORM ), 3.0, select( jMode.equal( MODE.PUSH ), 1.6, 1.0 ) ).mul( select( shove, SHOVE_HOLD, 1.0 ) );
										const mass = select( isCiv.and( jPol ), u.policeMass.mul( lean ).mul( select( jMode.equal( MODE.SHOVE ), SHOVE_K, 1.0 ) ), select( isPol.and( jCiv ), shoveBy.div( u.policeMass ), part ) )
											.mul( select( isSitter, 0.35, 1.0 ) );
										force.addAssign( n.mul( overlap.mul( K_REP ).mul( mass ) ) );
										const rv = dot( v.sub( vel.element( j ) ), n );
										If( rv.lessThan( 0 ), () => { force.subAssign( n.mul( rv.mul( C_DAMP ) ) ); } );
										pressure.addAssign( overlap.mul( select( same.and( iPart.or( jPart ) ), 0.0, 1.0 ) ) ); // making way for the banner is not a crush

									} );

									If( same, () => {

										nAg.addAssign( sj.z );
										nCnt.addAssign( 1 );

									} );

									If( enemy.and( dist.lessThan( CONTACT ) ), () => {

										contact.addAssign( 1 );
										If( isCiv.and( jPol ), () => {

											// officer aggression: squad stance + own stress; arresting officers restrain rather than strike
											const jga = gA.element( uint( sj.y ) );
											const isArr = jga.w.equal( MODE.ARREST );
											const pAgg = gB.element( uint( sj.y ) ).w.add( sj.z );
											// a line that is holding pushes with shields and strikes those who fight it
											const restraint = select( jga.w.equal( MODE.FORMATION ).or( jga.w.equal( MODE.SHOVE ) ), mix( u.holdRestraint, float( 1 ), smoothstep( 0.5, 0.9, ag ) ), float( 1 ) );
											dmgPolice.addAssign( u.policeForce.mul( pAgg ).mul( select( isArr, 0.25, 1.0 ) ).mul( restraint ).mul( select( shield, 0.6, 1.0 ) ) );
											// only arrest squads detain anyone they hold; other officers in contact only grab those who fight
											arresting.addAssign( select( isArr, 1.0, smoothstep( 0.6, 0.9, ag ).mul( select( panic, 0.0, 0.25 ) ) ) );

										} ).ElseIf( isPol, () => {

											// people running for their lives do not fight
											const jPanic = gA.element( uint( sj.y ) ).w.equal( MODE.PANIC );
											dmgOther.addAssign( u.riotForce.mul( smoothstep( 0.55, 1.0, sj.z ) ).mul( select( jPanic, 0.0, 2.0 ) ) );

										} ).Else( () => {

											// protesters vs counter-protesters brawl
											dmgOther.addAssign( u.riotForce.mul( smoothstep( 0.4, 1.0, sj.z ) ).mul( 2.5 ) );

										} );

									} );

								} );

							} );

						} );

					} );

				} );

			} );

			// ---- velocity
			const acc = vDes.sub( v ).div( TAU ).add( force );
			const vNew = v.add( acc.mul( dt ) ).toVar();
			const vmax = speed.mul( 1.6 ).add( 0.6 );
			const vl = length( vNew );
			If( vl.greaterThan( vmax ), () => { vNew.mulAssign( vmax.div( vl ) ); } );
			velN.element( i ).assign( vec4( vNew, 0, 0 ) );

			// ---- agitation (civilians: anger, police: stress, bystanders: fear)
			const avgAg = select( nCnt.greaterThan( 0 ), nAg.div( max( nCnt, 1 ) ), ag );
			// crush raises agitation — kettles boil — but only past normal dense-crowd compression
			const dAg = max( pressure.sub( 0.3 ), 0 ).mul( 0.6 )
				.add( contact.mul( 0.25 ) )
				.add( select( push, max( float( 0.6 ).sub( ag ), 0 ).mul( 2 ), select( storm, max( float( 0.95 ).sub( ag ), 0 ).mul( 4 ), float( 0 ) ) ) ) // fired up stays fired up
				.add( select( panic, max( float( 0.9 ).sub( ag ), 0 ).mul( 2 ), float( 0 ) ) ) // terror
				.add( avgAg.sub( ag ).mul( 0.35 ) ) // contagion
				.add( select( leaderHit, float( 0.9 ), float( 0 ) ) ) // leader attacked → group reacts hard
				.add( select( leaderDown.and( isLeader.not() ), float( 0.25 ), float( 0 ) ) )
				.add( ls.z.sub( ag ).mul( select( isLeader.or( isBy ), 0.0, 0.12 ) ) ) // leader sets the mood
				.add( select( isBy, densAt( p, 4 ).mul( 0.002 ), float( 0 ) ) )
				.add( select( isProt.and( nearVehicle ), float( 0.04 ), float( 0 ) ) ) // the VIP convoy provokes
				.add( gasK.mul( 0.08 ) )
				.add( min( soaked, 1 ).mul( 0.05 ) )
				.sub( ag.mul( select( isSitter, 0.3, 0.06 ) ) ) // sitters stay calm, it is a peaceful protest
				.add( select( isPol, gb.w.sub( ag ).mul( 0.05 ), float( 0 ) ) );
			const agN = clamp( ag.add( dAg.mul( dt ) ), 0, 1 );

			// ---- resolve (commitment): crowds give up under gas, blows, isolation and time
			const dRes = select( isCiv,
				gb.w.sub( 0.5 ).mul( 0.01 ) // group morale (coordinator messages, leader charisma)
					.add( min( select( isProt, densAt( p, 0 ), densAt( p, 3 ) ), 30 ).mul( 0.0003 ) ) // strength in numbers
					.sub( gasK.mul( 0.12 ) )
					.sub( min( soaked, 1 ).mul( 0.15 ) )
					.sub( select( e.x.greaterThan( 0 ), 0.04, 0.0 ) )
					.sub( select( leaderDown, 0.01, 0.0 ) )
					.sub( u.resolveDecay )
					.sub( select( leaving, 0.1, 0.0 ) ), // once leaving, keep going
				float( 0 ) );
			// floor −0.6: someone on the way home can still be called back (Mission.recall) until they are off the map
			const resN = select( isSitter, max( resolve, 0.5 ), clamp( resolve.add( dRes.mul( dt ) ), - 0.6, 1.5 ) );

			// ---- damage, injury (by whom), arrest
			// only so many people can land blows on one officer at once, however many press against the line
			If( isPol, () => { dmgOther.assign( min( dmgOther, u.riotForce.mul( 2 ).mul( u.attackCap ) ).mul( select( shove, SHOVE_ARMOUR, 1.0 ) ) ); } );
			const dmg = dmgPolice.add( dmgOther );
			const health = select( dmg.greaterThan( 0 ), s.w.sub( dmg.mul( dt ) ), min( s.w.add( u.recover.mul( dt ) ), 1 ) );
			const facN = fac.toVar();
			If( health.lessThanEqual( 0 ), () => { facN.assign( fac.add( select( dmgPolice.greaterThan( dmgOther ), 10, 20 ) ) ); } );
			// arrest: officers in arrest mode in contact accumulate progress; defenders packed around slow it
			const prog = select( isCiv, e.z, float( 0 ) ).toVar();
			If( isCiv, () => {

				const rate = arresting.mul( u.arrestRate ).mul( select( shield, 0.33, 1.0 ) ).sub( nCnt.mul( 0.04 ) ).div( ag.mul( 0.8 ).add( 1 ) );
				prog.assign( select( arresting.greaterThan( 0 ), clamp( prog.add( rate.mul( dt ) ), 0, 1 ), max( prog.sub( dt.mul( 0.1 ) ), 0 ) ) );
				If( prog.greaterThanEqual( 1 ), () => { facN.assign( select( isSitter, float( FACTION.ARRESTED_SITTER ), float( FACTION.ARRESTED ) ) ); } );

			} );
			// gone home: leaving and arrived at an exit (exit flow exhausted) after a while
			If( leaving.and( length( flow ).lessThan( 0.05 ) ).and( resolve.lessThan( - 0.3 ) ), () => { facN.assign( float( FACTION.GONE ) ); } );

			stN.element( i ).assign( vec4( facN, s.y, agN, max( health, 0 ) ) );
			const hit = select( dmg.greaterThan( 0 ), float( 1.5 ), max( e.x.sub( dt ), 0 ) );
			// riders get off for good on contact with police or the other camp, gas, water or a real crush
			// (ordinary bunching in a moving bloc does not count)
			const dismount = bike.and( contact.greaterThan( 0 ).or( dmg.greaterThan( 0 ) ).or( gasK.greaterThan( 0.2 ) ).or( soaked.greaterThan( 0.1 ) ).or( pressure.greaterThan( 1.2 ) ) );
			exN.element( i ).assign( vec4( hit, resN, select( isCiv, prog, contact ), select( dismount, role, e.w ) ) );

		} )().compute( this.N, [ 64 ] );

		// --- commit
		const commit = Fn( () => {

			const i = instanceIndex;
			If( i.greaterThanEqual( u.active ), () => { Return(); } );
			const s = stN.element( i );
			const e = exN.element( i );
			st.element( i ).assign( s );
			ex.element( i ).assign( e );
			const fac = s.x;
			If( fac.lessThan( - 1.5 ), () => {

				If( fac.equal( FACTION.ARRESTED ), () => { atomicAdd( stats.element( uint( STAT.ARRESTED ) ), uint( 1 ) ); } );
				If( fac.equal( FACTION.ARRESTED_SITTER ), () => { atomicAdd( stats.element( uint( STAT.ARRESTED_SITTERS ) ), uint( 1 ) ); } );
				If( fac.equal( FACTION.GONE ), () => { atomicAdd( stats.element( uint( STAT.GONE ) ), uint( 1 ) ); } );
				Return();

			} );
			If( fac.lessThan( 0 ), () => { Return(); } );

			const v = velN.element( i ).xy;
			const p = pos.element( i ).add( v.mul( u.dt ) ).toVar();
			const sd = sdfAt( p );
			If( sd.lessThan( 0.05 ), () => { p.addAssign( sdfGrad( p ).mul( float( 0.05 ).sub( sd ) ) ); } );
			p.assign( clamp( p, u.min.add( 1 ), u.min.add( u.size ).sub( 1 ) ) );
			pv.element( i ).assign( vec4( p, v ) );

			// killed: 30+f
			If( fac.greaterThan( 29.5 ), () => {

				atomicAdd( stats.element( uint( STAT.KILLED ) ), uint( 1 ) );
				If( mod( fac, 10 ).equal( 1 ), () => { atomicAdd( stats.element( uint( STAT.KILLED_POLICE ) ), uint( 1 ) ); } );
				Return();

			} );

			// injured: 10+f by police, 20+f by others
			If( fac.greaterThan( 9.5 ), () => {

				const orig = mod( fac, 10 );
				If( orig.equal( 1 ), () => { atomicAdd( stats.element( uint( STAT.INJ_POLICE ) ), uint( 1 ) ); } )
					.ElseIf( fac.lessThan( 19.5 ), () => { atomicAdd( stats.element( uint( STAT.INJ_BY_POLICE ) ), uint( 1 ) ); } )
					.Else( () => { atomicAdd( stats.element( uint( STAT.INJ_OTHER ) ), uint( 1 ) ); } );
				Return();

			} );

			const isProt = fac.lessThan( 0.5 );
			If( isProt, () => {

				atomicAdd( stats.element( uint( STAT.PROT ) ), uint( 1 ) );
				atomicAdd( stats.element( uint( STAT.PROT_AG ) ), uint( s.z.mul( 1000 ) ) );
				If( e.w.greaterThan( 1.5 ), () => { atomicAdd( stats.element( uint( STAT.SITTERS ) ), uint( 1 ) ); } );

			} );
			If( fac.equal( 1 ), () => { atomicAdd( stats.element( uint( STAT.POLICE ) ), uint( 1 ) ); } );
			If( fac.equal( 2 ), () => { atomicAdd( stats.element( uint( STAT.BYSTANDER ) ), uint( 1 ) ); } );
			If( fac.equal( 3 ), () => {

				atomicAdd( stats.element( uint( STAT.COUNTER ) ), uint( 1 ) );
				// clash proxy: counter-protesters sharing a 4 m cell with protesters
				If( densAt( p, 0 ).greaterThan( 0 ), () => { atomicAdd( stats.element( uint( STAT.CLASH ) ), uint( 1 ) ); } );

			} );

			// vehicles: who blocks the road ahead, who attacks the car
			Loop( { start: int( 0 ), end: u.vehicleCount, type: 'int', name: 'vk' }, ( { vk } ) => {

				const l = vehLocal( p, u.vehicles.element( vk ) );
				If( abs( l.x ).lessThan( VEH_HALF[ 0 ] + 1.5 ).and( l.y.greaterThan( VEH_HALF[ 1 ] ) ).and( l.y.lessThan( VEH_HALF[ 1 ] + 9 ) ).and( fac.notEqual( 1 ) ), () => {

					atomicAdd( stats.element( uint( STAT.VEH_BLOCK ).add( uint( vk ) ) ), uint( 1 ) );

				} );
				If( isProt.and( s.z.greaterThan( 0.6 ) ).and( abs( l.x ).lessThan( VEH_HALF[ 0 ] + 1.2 ) ).and( abs( l.y ).lessThan( VEH_HALF[ 1 ] + 1.2 ) ), () => {

					atomicAdd( stats.element( uint( STAT.VEH_ATTACK ).add( uint( vk ) ) ), uint( 1 ) );

				} );

			} );

			// objective zones
			Loop( { start: int( 0 ), end: int( MAX_ZONES ), type: 'int', name: 'zi' }, ( { zi } ) => {

				const z = u.zones.element( zi );
				If( z.z.greaterThan( 0 ).and( length( p.sub( z.xy ) ).lessThan( z.z ) ), () => {

					const t = z.w;
					const hit = t.equal( ZONE.PROT ).and( isProt )
						.or( t.equal( ZONE.PROT_FACADE ).and( isProt ).and( sd.lessThan( 2.5 ) ).and( s.z.greaterThan( 0.5 ) ) )
						.or( t.equal( ZONE.COUNTER ).and( fac.equal( 3 ) ) )
						.or( t.equal( ZONE.POLICE ).and( fac.equal( 1 ) ) )
						.or( t.equal( ZONE.CIVIL ).and( isProt.or( fac.equal( 3 ) ) ) )
						.or( t.equal( ZONE.PROT_STAY ).and( isProt ).and( e.y.greaterThanEqual( 0 ) ) );
					If( hit, () => { atomicAdd( stats.element( uint( STAT.ZONE ).add( uint( zi ) ) ), uint( 1 ) ); } );

				} );

			} );

		} )().compute( this.N, [ 64 ] );

		this.kernels = [ clear, clearDens, insert, update, commit ];
		this.mesh = this._buildMesh();

	}

	_buildMesh() {

		const { pv, st, ex, u } = this;
		const material = new THREE.SpriteNodeMaterial( { transparent: true, depthWrite: false } );
		const s = st.toAttribute();
		const e = ex.toAttribute();
		const P = pv.toAttribute();
		const fac = s.x, ag = s.z;
		const bike = e.w.greaterThan( 3.5 ).and( fac.greaterThanEqual( 0 ) ).and( fac.lessThan( 9.5 ) );
		const role = e.w.sub( select( e.w.greaterThan( 3.5 ), 4.0, 0.0 ) );
		const isSitter = role.greaterThan( 1.5 );

		// leaders are only recognisable under CCTV coverage (or always, for the protest side)
		const cctv = texture( this.cctvTex, P.xy.sub( u.min ).div( u.size ) ).x;
		const showLeader = role.greaterThan( 0.5 ).and( role.lessThan( 1.5 ) ).and( cctv.greaterThan( 0 ).or( u.revealLeaders.greaterThan( 0.5 ) ) );

		const prot = mix( rgb( PAL.protester ), rgb( PAL.protesterHot ), smoothstep( 0.2, 1.0, ag ) );
		const sit = rgb( PAL.sitter );
		const pol = mix( rgb( PAL.police ), rgb( PAL.policeHot ), min( e.z.mul( 0.5 ).add( ag.mul( 0.5 ) ), 1 ) );
		const by = mix( rgb( PAL.bystander ), vec3( 1.0, 0.95, 0.85 ), ag.mul( 0.6 ) );
		const ctr = mix( rgb( PAL.counter ), rgb( PAL.counterHot ), smoothstep( 0.2, 1.0, ag ) );
		// blend by faction weights (nested select() on vec3 miscompiled for some factions)
		const w = ( cond ) => cond.select( 1, 0 );
		const col = prot.mul( w( fac.lessThan( 0.5 ).and( isSitter.not() ) ) )
			.add( sit.mul( w( fac.lessThan( 0.5 ).and( isSitter ) ) ) )
			.add( pol.mul( w( fac.equal( 1 ) ) ) )
			.add( by.mul( w( fac.equal( 2 ) ) ) )
			.add( ctr.mul( w( fac.equal( 3 ) ) ) )
			.add( rgb( PAL.injured ).mul( w( fac.greaterThan( 9.5 ).and( fac.lessThan( 29.5 ) ) ) ) )
			.add( rgb( PAL.dead ).mul( w( fac.greaterThan( 29.5 ) ) ) );
		const sel = abs( s.y.sub( u.selA ) ).lessThan( 0.5 ).or( abs( s.y.sub( u.selB ) ).lessThan( 0.5 ) );
		const going = fac.lessThan( 3.5 ).and( fac.notEqual( 1 ) ).and( e.y.lessThan( 0 ) ); // heading home: dimmed
		material.colorNode = mix( col.mul( showLeader.select( 2.2, 1.0 ) ).mul( going.select( 0.35, 1.0 ) ), vec3( 2.2, 2.1, 1.9 ), w( sel ).mul( 0.7 ) );

		// world-size disc with a minimum on-screen size so crowds stay legible zoomed out
		const r = select( showLeader, 1.1, select( bike, 1.9, 0.55 ) );
		const size = max( r, u.mpp.mul( select( showLeader, 5.0, select( bike, 4.0, 2.2 ) ) ) );
		material.scaleNode = select( fac.lessThan( 0 ), float( 0 ), size );
		material.positionNode = vec3( P.xy, 2.0 );
		const q = uv().sub( 0.5 );
		const d = length( q );
		// leaders get a ring, riders a short stroke along their heading, everyone else a disc
		const disc = smoothstep( 0.5, 0.36, d );
		const vl = length( P.zw );
		const hd = select( vl.greaterThan( 0.05 ), P.zw.div( max( vl, 1e-3 ) ), vec2( 0, 1 ) );
		const along = abs( dot( q, hd ) ), across = abs( dot( q, vec2( hd.y.negate(), hd.x ) ) );
		const stroke = smoothstep( 0.5, 0.4, along ).mul( smoothstep( 0.16, 0.1, across ) );
		material.opacityNode = select( showLeader, disc.mul( smoothstep( 0.18, 0.3, d ).max( 0.35 ) ), select( bike, stroke, disc ) );

		const mesh = new THREE.InstancedMesh( new THREE.PlaneGeometry( 1, 1 ), material, this.N );
		mesh.frustumCulled = false;
		mesh.count = 0;
		return mesh;

	}

}

const sign = ( x ) => select( x.lessThan( 0 ), float( - 1 ), float( 1 ) );
