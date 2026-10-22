// Police patrol cars: selectable units that drive along the street grid, carry a small crew squad
// and act as moving walls (a parked car is a roadblock). Paths are A* on the 4 m cost grid limited
// to cells a car fits through, then string-pulled against the SDF. Rotating blue beacons bloom.
import * as THREE from 'three/webgpu';
import { uv, time, vec3, float, atan, cos, max, pow, length, smoothstep, fract, step } from 'three/tsl';
import { PAL } from '../palette.js';
import { FACTION, STAT, MAX_VEHICLES, ROLE } from '../sim/crowd.js';

const VMAX = 11; // m/s ≈ 40 km/h with lights on
const ACCEL = 3, BRAKE = 7;
const BOARD_R = 22; // crew within this distance of the car get in when it drives off
const CREW = 8;

export class Patrols {

	constructor( world ) {

		this.world = world;
		this.crowd = world.crowd;
		this.city = world.city;
		this.cars = [];
		this.group = new THREE.Group();
		this._mask = null;

	}

	// ---------------------------------------------------------------- units

	// civil: an unmarked car (no beacon, no siren), e.g. the protesters' rescue car; water: a water cannon truck (no crew,
	// aimed with W, see Mission.spray)
	async add( { at, heading, label, crew = CREW, selectable = true, civil = false, water = false, random = Math.random } ) {

		if ( this.world.convoyVehicles.length + this.cars.length >= MAX_VEHICLES ) throw new Error( 'vehicle capacity exceeded' );
		const n = this.cars.filter( ( c ) => ! c.water === ! water ).length + 1;
		if ( water ) crew = 0;
		const p = this.snap( at[ 0 ], at[ 1 ] ) ?? at;
		heading ??= this.alongStreet( p[ 0 ], p[ 1 ] );
		const car = {
			isCar: true, faction: FACTION.POLICE, label: label ?? `Patrol ${n}`, id: - 1, members: [], alive: 1,
			x: p[ 0 ], y: p[ 1 ], heading, speed: 0, path: null, s: 0, blockers: 0, selectable,
			aboard: [], crew: null, center: [ p[ 0 ], p[ 1 ] ], civil, water, aim: heading,
		};
		if ( water ) car.label = label ?? `Water cannon ${n}`;
		if ( crew ) {

			const side = [ p[ 0 ] + Math.cos( heading + Math.PI / 2 ) * 5, p[ 1 ] + Math.sin( heading + Math.PI / 2 ) * 5 ];
			car.crew = await this.world.squad( { kind: 'crew', label: `${car.label} crew`, at: side, n: crew, random } );
			car.crew.car = car;

		}

		car.mesh = civil ? this._civilMesh() : water ? this._truckMesh( car ) : this._mesh();
		this.group.add( car.mesh );
		this.cars.push( car );
		this._pose( car );
		return car;

	}

	// heading that lines a parked car up with the street: the direction with the most clearance
	alongStreet( x, y ) {

		let best = 0, bc = - Infinity;
		for ( let k = 0; k < 16; k ++ ) {

			const a = k / 16 * Math.PI, c = Math.cos( a ), s = Math.sin( a );
			let clear = Infinity;
			for ( const d of [ - 6, - 3, 3, 6 ] ) clear = Math.min( clear, this.world.sdf( x + c * d, y + s * d ) );
			if ( clear > bc ) { bc = clear; best = a; }

		}

		return best;

	}

	pick( x, y, r ) {

		let best = null, bd = r * r;
		for ( const c of this.cars ) {

			if ( ! c.selectable ) continue;
			const d = ( c.x - x ) ** 2 + ( c.y - y ) ** 2;
			if ( d < bd ) { bd = d; best = c; }

		}

		return best;

	}

	// ---------------------------------------------------------------- orders

	driveTo( car, x, y ) {

		const goal = this.snap( x, y );
		if ( ! goal ) return false;
		const path = this.route( [ car.x, car.y ], goal );
		if ( ! path ) return false;
		this.board( car );
		car.path = path;
		car.cum = [ 0 ];
		for ( let k = 1; k < path.length; k ++ ) car.cum.push( car.cum[ k - 1 ] + Math.hypot( path[ k ][ 0 ] - path[ k - 1 ][ 0 ], path[ k ][ 1 ] - path[ k - 1 ][ 1 ] ) );
		car.s = 0;
		return true;

	}

	// crew within reach get in (they leave the map until the car parks)
	board( car ) {

		const g = car.crew, I = this.world.intel;
		if ( ! g || ! I ) return 0;
		let n = 0;
		for ( const i of g.members ) {

			if ( car.aboard.includes( i ) || I.st[ i * 4 ] !== FACTION.POLICE ) continue;
			if ( Math.hypot( I.pos[ i * 2 ] - car.x, I.pos[ i * 2 + 1 ] - car.y ) > BOARD_R ) continue;
			this.crowd.setFaction( i, - 1 );
			car.aboard.push( i );
			n ++;

		}

		return n;

	}

	// crew get out beside the car and form up there
	unload( car ) {

		const g = car.crew;
		if ( ! g || ! car.aboard.length ) return 0;
		const a = car.heading + Math.PI / 2;
		const side = this.world.spot( car.x + Math.cos( a ) * 4.5, car.y + Math.sin( a ) * 4.5, 3, false );
		for ( const i of car.aboard ) {

			const [ x, y ] = this.world.spot( side[ 0 ], side[ 1 ], 2.5, false );
			this.crowd.place( i, { x, y, faction: FACTION.POLICE, group: g.id, role: i === g.leader ? ROLE.LEADER : ROLE.MEMBER } );

		}

		const n = car.aboard.length;
		car.aboard = [];
		this.world.moveSquads( [ g ], ...side );
		return n;

	}

	toggleCrew( cars ) {

		for ( const c of cars ) {

			if ( c.path ) continue; // only when parked
			if ( c.aboard.length ) this.unload( c );
			else this.board( c );

		}

	}

	// ---------------------------------------------------------------- per frame

	update( dt, stats, base ) {

		this.cars.forEach( ( c, k ) => {

			if ( stats ) c.blockers = stats[ STAT.VEH_BLOCK + base + k ];
			if ( c.path ) {

				const left = c.cum[ c.cum.length - 1 ] - c.s;
				// brake for people in front, for the next corner and for the end of the route
				const corner = this._cornerAhead( c );
				const target = Math.min( VMAX * Math.max( 0, 1 - c.blockers / 6 ), Math.sqrt( 2 * BRAKE * 0.6 * Math.max( 0, left ) ) + 0.5, corner );
				c.speed += Math.sign( target - c.speed ) * Math.min( Math.abs( target - c.speed ), ( target > c.speed ? ACCEL : BRAKE ) * dt );
				c.s = Math.min( c.cum[ c.cum.length - 1 ], c.s + c.speed * dt );
				const p = this._at( c, c.s );
				c.x = p.x; c.y = p.y;
				let dh = p.heading - c.heading;
				dh = Math.atan2( Math.sin( dh ), Math.cos( dh ) );
				c.heading += dh * Math.min( 1, dt * 6 );
				if ( left < 0.5 ) {

					c.path = null;
					c.speed = 0;
					this.unload( c );

				}

			}

			c.center = [ c.x, c.y ];
			c.info = c.path ? `driving · ${Math.round( c.speed * 3.6 )} km/h${c.blockers > 2 ? ' · road blocked' : ''}` : 'parked · roadblock';
			if ( c.water ) c.info += this.world.jets.some( ( j ) => j.truck === c ) ? ' · SPRAYING' : ' · W to aim';
			c.info += c.crew ? ` · crew ${c.aboard.length ? c.aboard.length + ' aboard' : 'out'}` : '';
			this._pose( c );

		} );

	}

	vehicles() {

		// the crowd shader's vehicle-local y axis is the direction of travel
		return this.cars.map( ( c ) => ( { x: c.x, y: c.y, heading: c.heading } ) );

	}

	draw( o, game ) {

		const ctx = o.ctx;
		for ( const c of game.selected ) {

			if ( ! c.isCar || ! c.path ) continue;
			ctx.strokeStyle = 'rgba(43,140,255,0.7)';
			ctx.setLineDash( [ 6, 6 ] );
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			const ahead = [ [ c.x, c.y ], ...c.path.filter( ( _, k ) => c.cum[ k ] > c.s ) ];
			ahead.forEach( ( p, k ) => { const [ x, y ] = o.toScreen( ...p ); k ? ctx.lineTo( x, y ) : ctx.moveTo( x, y ); } );
			ctx.stroke();
			ctx.setLineDash( [] );

		}

	}

	// ---------------------------------------------------------------- road network (CPU)

	// cells a car can use: streets (cost ≤ 12) with at least 1.6 m to the nearest obstacle
	get mask() {

		if ( this._mask ) return this._mask;
		const { w, h, res } = this.city.cost, [ x0, y0 ] = this.city.bounds;
		const m = new Uint8Array( w * h );
		for ( let r = 0; r < h; r ++ ) for ( let q = 0; q < w; q ++ ) {

			const c = this.city.costData[ r * w + q ];
			if ( c <= 12 && this.world.sdf( x0 + ( q + 0.5 ) * res, y0 + ( r + 0.5 ) * res ) >= 1.6 ) m[ r * w + q ] = c;

		}

		this._mask = m;
		return m;

	}

	// nearest drivable point within ~40 m
	snap( x, y ) {

		const { w, h, res } = this.city.cost, [ x0, y0 ] = this.city.bounds, M = this.mask;
		const q0 = Math.floor( ( x - x0 ) / res ), r0 = Math.floor( ( y - y0 ) / res );
		for ( let d = 0; d <= 10; d ++ ) {

			let best = null, bd = Infinity;
			for ( let r = r0 - d; r <= r0 + d; r ++ ) for ( let q = q0 - d; q <= q0 + d; q ++ ) {

				if ( Math.max( Math.abs( r - r0 ), Math.abs( q - q0 ) ) !== d || q < 0 || r < 0 || q >= w || r >= h || ! M[ r * w + q ] ) continue;
				const cx = x0 + ( q + 0.5 ) * res, cy = y0 + ( r + 0.5 ) * res, dd = ( cx - x ) ** 2 + ( cy - y ) ** 2;
				if ( dd < bd ) { bd = dd; best = [ cx, cy ]; }

			}

			if ( best ) return d === 0 ? [ x, y ] : best;

		}

		return null;

	}

	route( a, b ) {

		const { w, h, res } = this.city.cost, [ x0, y0 ] = this.city.bounds, M = this.mask;
		const cell = ( p ) => Math.floor( ( p[ 1 ] - y0 ) / res ) * w + Math.floor( ( p[ 0 ] - x0 ) / res );
		const start = cell( a ), goal = cell( b );
		const gq = goal % w, gr = Math.floor( goal / w );
		const G = new Float32Array( w * h ).fill( Infinity ), from = new Int32Array( w * h ).fill( - 1 );
		const heap = new MinHeap();
		G[ start ] = 0;
		heap.push( start, 0 );
		const nb = [ [ 1, 0, 1 ], [ - 1, 0, 1 ], [ 0, 1, 1 ], [ 0, - 1, 1 ], [ 1, 1, 1.414 ], [ 1, - 1, 1.414 ], [ - 1, 1, 1.414 ], [ - 1, - 1, 1.414 ] ];
		let found = false;
		while ( heap.size ) {

			const cur = heap.pop();
			if ( cur === goal ) { found = true; break; }
			const cq = cur % w, cr = Math.floor( cur / w );
			for ( const [ dq, dr, len ] of nb ) {

				const q = cq + dq, r = cr + dr;
				if ( q < 0 || r < 0 || q >= w || r >= h ) continue;
				const n = r * w + q, c = M[ n ];
				if ( ! c && n !== goal ) continue;
				const g = G[ cur ] + len * ( c ? c / 10 : 1 ) * ( c > 10 ? 1.5 : 1 ); // footpaths only when there is no road
				if ( g < G[ n ] ) {

					G[ n ] = g;
					from[ n ] = cur;
					heap.push( n, g + Math.hypot( q - gq, r - gr ) );

				}

			}

		}

		if ( ! found ) return null;
		const cells = [];
		for ( let c = goal; c !== - 1; c = from[ c ] ) cells.push( [ x0 + ( c % w + 0.5 ) * res, y0 + ( Math.floor( c / w ) + 0.5 ) * res ] );
		cells.reverse();
		cells[ 0 ] = a;
		cells[ cells.length - 1 ] = b;
		return this._pull( cells );

	}

	// string pulling: skip waypoints while the straight line keeps a car's width off the walls
	_pull( pts ) {

		const clear = ( p, q ) => {

			const d = Math.hypot( q[ 0 ] - p[ 0 ], q[ 1 ] - p[ 1 ] );
			for ( let t = 0; t <= d; t += 1 ) {

				const x = p[ 0 ] + ( q[ 0 ] - p[ 0 ] ) * t / d, y = p[ 1 ] + ( q[ 1 ] - p[ 1 ] ) * t / d;
				if ( this.world.sdf( x, y ) < 1.4 ) return false;

			}

			return true;

		};

		const out = [ pts[ 0 ] ];
		let k = 0;
		while ( k < pts.length - 1 ) {

			let j = Math.min( pts.length - 1, k + 40 );
			while ( j > k + 1 && ! clear( pts[ k ], pts[ j ] ) ) j --;
			out.push( pts[ j ] );
			k = j;

		}

		return out;

	}

	_at( c, s ) {

		let k = 1;
		while ( k < c.cum.length - 1 && c.cum[ k ] < s ) k ++;
		const a = c.path[ k - 1 ], b = c.path[ k ];
		const t = Math.min( 1, ( s - c.cum[ k - 1 ] ) / ( ( c.cum[ k ] - c.cum[ k - 1 ] ) || 1 ) );
		return { x: a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, y: a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, heading: Math.atan2( b[ 1 ] - a[ 1 ], b[ 0 ] - a[ 0 ] ) };

	}

	// speed limit for the next bend within 25 m: sharp corners are taken at walking pace
	_cornerAhead( c ) {

		let k = 1;
		while ( k < c.cum.length - 1 && c.cum[ k ] < c.s ) k ++;
		if ( k >= c.path.length - 1 || c.cum[ k ] - c.s > 25 ) return VMAX;
		const [ a, b, d ] = [ c.path[ k - 1 ], c.path[ k ], c.path[ k + 1 ] ];
		const h1 = Math.atan2( b[ 1 ] - a[ 1 ], b[ 0 ] - a[ 0 ] ), h2 = Math.atan2( d[ 1 ] - b[ 1 ], d[ 0 ] - b[ 0 ] );
		const turn = Math.abs( Math.atan2( Math.sin( h2 - h1 ), Math.cos( h2 - h1 ) ) );
		return VMAX * Math.max( 0.25, 1 - turn / 1.6 );

	}

	// ---------------------------------------------------------------- meshes

	_pose( c ) {

		c.mesh.position.set( c.x, c.y, 3 );
		c.mesh.rotation.z = c.heading - Math.PI / 2;
		if ( c.turret ) c.turret.rotation.z = c.aim - c.heading; // the nozzle points along the turret's local +y
		// a little larger than life when zoomed out so cars stay readable next to the crowd discs
		c.mesh.scale.setScalar( Math.max( 1, ( this.crowd.u.mpp.value ?? 1 ) * 0.9 ) );

	}

	// water cannon truck: a longer dark body, cab in front, a turret with a nozzle on the roof
	_truckMesh( car ) {

		const m = new THREE.Group();
		m.add( new THREE.Mesh( new THREE.PlaneGeometry( 2.5, 6.2 ), new THREE.MeshBasicNodeMaterial( { color: PAL.patrol } ) ) );
		const pts = [ [ - 1.25, - 3.1 ], [ 1.25, - 3.1 ], [ 1.25, 3.1 ], [ - 1.25, 3.1 ], [ - 1.25, - 3.1 ] ].map( ( p ) => new THREE.Vector3( p[ 0 ], p[ 1 ], 0.1 ) );
		m.add( new THREE.Line( new THREE.BufferGeometry().setFromPoints( pts ), new THREE.LineBasicNodeMaterial( { color: PAL.kinds.police[ 1 ] } ) ) );
		const cab = new THREE.Mesh( new THREE.PlaneGeometry( 2.5, 1.6 ), new THREE.MeshBasicNodeMaterial( { color: PAL.kinds.police[ 1 ] } ) );
		cab.position.set( 0, 2.3, 0.05 );
		m.add( cab );
		const tank = new THREE.Mesh( new THREE.PlaneGeometry( 1.9, 3.6 ), new THREE.MeshBasicNodeMaterial( { color: 0x16335e } ) );
		tank.position.set( 0, - 0.9, 0.05 );
		m.add( tank );
		const turret = new THREE.Group();
		turret.position.set( 0, 1.0, 0.2 );
		turret.add( new THREE.Mesh( new THREE.CircleGeometry( 0.6, 16 ), new THREE.MeshBasicNodeMaterial( { color: PAL.cannon } ) ) );
		const nozzle = new THREE.Mesh( new THREE.PlaneGeometry( 0.3, 2.2 ), new THREE.MeshBasicNodeMaterial( { color: PAL.cannon } ) );
		nozzle.position.set( 0, 1.1, 0 );
		turret.add( nozzle );
		m.add( turret );
		car.turret = turret;
		return m;

	}

	_civilMesh() {

		const m = new THREE.Group();
		m.add( new THREE.Mesh( new THREE.PlaneGeometry( 2.1, 4.6 ), new THREE.MeshBasicNodeMaterial( { color: PAL.civilCar } ) ) );
		const pts = [ [ - 1.05, - 2.3 ], [ 1.05, - 2.3 ], [ 1.05, 2.3 ], [ - 1.05, 2.3 ], [ - 1.05, - 2.3 ] ].map( ( p ) => new THREE.Vector3( p[ 0 ], p[ 1 ], 0.1 ) );
		m.add( new THREE.Line( new THREE.BufferGeometry().setFromPoints( pts ), new THREE.LineBasicNodeMaterial( { color: PAL.civilCarEdge } ) ) );
		const windscreen = new THREE.Mesh( new THREE.PlaneGeometry( 1.7, 0.7 ), new THREE.MeshBasicNodeMaterial( { color: 0x101010 } ) );
		windscreen.position.set( 0, 1.1, 0.05 );
		m.add( windscreen );
		return m;

	}

	_mesh() {

		const m = new THREE.Group();
		const blue = PAL.siren;
		m.add( new THREE.Mesh( new THREE.PlaneGeometry( 2.3, 5.0 ), new THREE.MeshBasicNodeMaterial( { color: PAL.patrol } ) ) );
		const stripe = new THREE.Mesh( new THREE.PlaneGeometry( 2.3, 0.5 ), new THREE.MeshBasicNodeMaterial( { color: PAL.kinds.police[ 1 ] } ) );
		stripe.position.set( 0, - 0.6, 0.05 );
		m.add( stripe );
		const pts = [ [ - 1.15, - 2.5 ], [ 1.15, - 2.5 ], [ 1.15, 2.5 ], [ - 1.15, 2.5 ], [ - 1.15, - 2.5 ] ].map( ( p ) => new THREE.Vector3( p[ 0 ], p[ 1 ], 0.1 ) );
		m.add( new THREE.Line( new THREE.BufferGeometry().setFromPoints( pts ), new THREE.LineBasicNodeMaterial( { color: PAL.kinds.police[ 1 ] } ) ) );
		const windscreen = new THREE.Mesh( new THREE.PlaneGeometry( 1.9, 0.7 ), new THREE.MeshBasicNodeMaterial( { color: 0x0c1830 } ) );
		windscreen.position.set( 0, 1.2, 0.05 );
		m.add( windscreen );

		// light bar: two halves flashing alternately
		const flash = ( phase ) => {

			const mat = new THREE.MeshBasicNodeMaterial();
			mat.colorNode = vec3( blue.r, blue.g, blue.b ).mul( step( 0.5, fract( time.mul( 2.2 ).add( phase ) ) ).mul( 0.9 ).add( 0.1 ) );
			return mat;

		};

		for ( const [ x, ph ] of [ [ - 0.5, 0 ], [ 0.5, 0.5 ] ] ) {

			const lb = new THREE.Mesh( new THREE.PlaneGeometry( 0.85, 0.35 ), flash( ph ) );
			lb.position.set( x, 0.2, 0.15 );
			m.add( lb );

		}

		// rotating beacon: two opposed beams sweeping the street around the car
		const beam = new THREE.MeshBasicNodeMaterial( { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } );
		const q = uv().sub( 0.5 );
		const r = length( q ).mul( 2 );
		const a = atan( q.y, q.x ).sub( time.mul( 5.5 ) );
		const sweep = pow( max( cos( a ), 0 ), float( 10 ) ).add( pow( max( cos( a ).negate(), 0 ), float( 10 ) ) );
		beam.colorNode = vec3( blue.r, blue.g, blue.b ).mul( 0.6 );
		beam.opacityNode = sweep.mul( smoothstep( 1.0, 0.15, r ) ).mul( smoothstep( 0.0, 0.12, r ) ).mul( 0.55 ).add( smoothstep( 0.35, 0.0, r ).mul( 0.12 ) );
		const glow = new THREE.Mesh( new THREE.PlaneGeometry( 22, 22 ), beam );
		glow.position.z = - 0.5;
		m.add( glow );
		return m;

	}

}

class MinHeap {

	constructor() { this.k = []; this.v = []; }

	get size() { return this.k.length; }

	push( key, val ) {

		const K = this.k, V = this.v;
		let i = K.length;
		K.push( key ); V.push( val );
		while ( i > 0 ) {

			const p = ( i - 1 ) >> 1;
			if ( V[ p ] <= val ) break;
			K[ i ] = K[ p ]; V[ i ] = V[ p ];
			i = p;

		}

		K[ i ] = key; V[ i ] = val;

	}

	pop() {

		const K = this.k, V = this.v, top = K[ 0 ];
		const key = K.pop(), val = V.pop();
		if ( K.length ) {

			let i = 0;
			const n = K.length;
			for ( ;; ) {

				let c = i * 2 + 1;
				if ( c >= n ) break;
				if ( c + 1 < n && V[ c + 1 ] < V[ c ] ) c ++;
				if ( V[ c ] >= val ) break;
				K[ i ] = K[ c ]; V[ i ] = V[ c ];
				i = c;

			}

			K[ i ] = key; V[ i ] = val;

		}

		return top;

	}

}
