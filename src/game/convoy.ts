// VIP convoy: kinematic vehicles along a fixed polyline. The GPU treats them as moving walls and
// reports, per vehicle, how many people block the road ahead and how many are attacking it.
import * as THREE from 'three/webgpu';
import { PAL } from '../palette.ts';
import { STAT } from '../sim/crowd.ts';

const SPACING = 11; // metres between vehicles
const VMAX = 9; // m/s ≈ 32 km/h through town

export class Convoy {

	declare route: any;
	declare cum: number[];
	declare length: number;
	declare n: number;
	declare vip: number;
	declare s: number;
	declare speed: number;
	declare moving: boolean;
	declare integrity: number;
	declare blockedFor: number;
	declare attackers: number;
	declare blockers: number;
	declare group: THREE.Group<THREE.Object3DEventMap>;
	declare poses: any[];
	declare meshes: any[];

	constructor( route, { vehicles = 3, vipIndex = 1 } = {} ) {

		this.route = route;
		this.cum = [ 0 ];
		for ( let k = 1; k < route.length; k ++ ) {

			this.cum.push( this.cum[ k - 1 ] + Math.hypot( route[ k ][ 0 ] - route[ k - 1 ][ 0 ], route[ k ][ 1 ] - route[ k - 1 ][ 1 ] ) );

		}

		this.length = this.cum[ this.cum.length - 1 ];
		this.n = vehicles;
		this.vip = vipIndex;
		this.s = SPACING * ( vehicles - 1 ); // arc position of the lead vehicle
		this.speed = 0;
		this.moving = false;
		this.integrity = 1; // VIP vehicle
		this.blockedFor = 0;
		this.attackers = 0;
		this.blockers = 0;
		this.group = this._buildMeshes();
		this.update( 0, null );

	}

	at( s ) {

		s = Math.max( 0, Math.min( this.length - 0.01, s ) );
		let k = 1;
		while ( this.cum[ k ] < s ) k ++;
		const a = this.route[ k - 1 ], b = this.route[ k ];
		const t = ( s - this.cum[ k - 1 ] ) / ( this.cum[ k ] - this.cum[ k - 1 ] );
		return { x: a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, y: a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, heading: Math.atan2( b[ 1 ] - a[ 1 ], b[ 0 ] - a[ 0 ] ) };

	}

	get progress() { return Math.min( 1, this.s / this.length ); }

	get arrived() { return this.s >= this.length - 1; }

	// stats: last GPU stats snapshot (Uint32Array) or null
	update( dt, stats ) {

		if ( stats ) {

			this.blockers = stats[ STAT.VEH_BLOCK ];
			let att = 0;
			for ( let v = 0; v < this.n; v ++ ) att += stats[ STAT.VEH_ATTACK + v ] * ( v === this.vip ? 1 : 0.35 );
			this.attackers = att;

		}

		if ( this.moving && ! this.arrived ) {

			// people in front of the lead car slow it; a dozen stop it dead
			const target = VMAX * Math.max( 0, 1 - this.blockers / 10 );
			const a = target > this.speed ? 2.5 : 6;
			this.speed += Math.sign( target - this.speed ) * Math.min( Math.abs( target - this.speed ), a * dt );
			this.s = Math.min( this.length, this.s + this.speed * dt );
			this.blockedFor = this.speed < 0.5 ? this.blockedFor + dt : 0;

		} else {

			this.speed = 0;

		}

		// capped so a mobbed car survives ~1 min: enough time to react with escorts, gas or water
		this.integrity = Math.max( 0, this.integrity - Math.min( this.attackers, 30 ) * 0.0006 * dt );

		this.poses = [];
		for ( let v = 0; v < this.n; v ++ ) this.poses.push( this.at( this.s - v * SPACING ) );
		this.poses.forEach( ( p, v ) => {

			const m = this.meshes[ v ];
			m.position.set( p.x, p.y, 3 );
			m.rotation.z = p.heading - Math.PI / 2;

		} );

	}

	vehicles() {

		// the crowd shader's vehicle-local y axis is the direction of travel
		return this.poses.map( ( p ) => ( { x: p.x, y: p.y, heading: p.heading } ) );

	}

	_buildMeshes() {

		const group = new THREE.Group();
		this.meshes = [];
		for ( let v = 0; v < this.n; v ++ ) {

			const isVip = v === this.vip;
			const body = new THREE.Mesh( new THREE.PlaneGeometry( 2.4, 5.6 ), new THREE.MeshBasicNodeMaterial( { color: isVip ? 0x202020 : 0x0a1a33 } ) );
			const pts = [ [ - 1.2, - 2.8 ], [ 1.2, - 2.8 ], [ 1.2, 2.8 ], [ - 1.2, 2.8 ], [ - 1.2, - 2.8 ] ].map( ( p ) => new THREE.Vector3( p[ 0 ], p[ 1 ], 0.1 ) );
			const edge = new THREE.Line( new THREE.BufferGeometry().setFromPoints( pts ), new THREE.LineBasicNodeMaterial( { color: isVip ? PAL.vip : PAL.kinds.police[ 1 ] } ) );
			const nose = new THREE.Mesh( new THREE.PlaneGeometry( 2.0, 0.6 ), new THREE.MeshBasicNodeMaterial( { color: isVip ? PAL.vip : PAL.kinds.police[ 1 ] } ) );
			nose.position.set( 0, 2.3, 0.1 );
			const m = new THREE.Group();
			m.add( body, edge, nose );
			m.scale.setScalar( 1 );
			group.add( m );
			this.meshes.push( m );

		}

		return group;

	}

}
