// Builds static city meshes from public/data/city.json. Everything lives in the XY plane
// (x east, y north, metres, origin at Prešernov trg area); z is only used for layer order.
import * as THREE from 'three/webgpu';
import { PAL } from './palette.ts';

const Z = { park: 0.0, water: 0.1, road: 0.2, ped: 0.25, rail: 0.3, building: 0.5, poi: 0.8 };

export async function loadCity( base = './data/' ) {

	const city = await ( await fetch( base + 'city.json' ) ).json();
	const [ sdf, cost, cctv ] = await Promise.all( [ city.sdf, city.cost, city.cctv ].map(
		( m ) => fetch( base + m.file ).then( ( r ) => r.arrayBuffer() ) ) );
	city.sdfData = new Int8Array( sdf );
	city.costData = new Uint8Array( cost );
	city.cctvData = new Uint8Array( cctv );
	return city;

}

// Accumulates triangles + colours into one geometry so each layer is a single draw call.
class FillBuilder {

	declare pos: any[];
	declare col: any[];

	constructor() {

		this.pos = [];
		this.col = [];

	}

	addPoly( rings, z, color ) {

		const toV = ( r ) => {

			const pts = [];
			for ( let i = 0; i < r.length; i += 2 ) pts.push( new THREE.Vector2( r[ i ], r[ i + 1 ] ) );
			return pts;

		};

		const contour = toV( rings[ 0 ] );
		const holes = rings.slice( 1 ).map( toV );
		if ( contour.length < 3 ) return;
		const tris = THREE.ShapeUtils.triangulateShape( contour, holes );
		const all = contour.concat( ...holes );
		for ( const t of tris ) {

			for ( const k of t ) {

				this.pos.push( all[ k ].x, all[ k ].y, z );
				this.col.push( color.r, color.g, color.b );

			}

		}

	}

	build() {

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.pos, 3 ) );
		g.setAttribute( 'color', new THREE.Float32BufferAttribute( this.col, 3 ) );
		return new THREE.Mesh( g, new THREE.MeshBasicNodeMaterial( { vertexColors: true } ) );

	}

}

class LineBuilder {

	declare pos: any[];
	declare col: any[];

	constructor() {

		this.pos = [];
		this.col = [];

	}

	addLine( flat, z, color, closed = false ) {

		const n = flat.length / 2;
		const segs = closed ? n : n - 1;
		for ( let i = 0; i < segs; i ++ ) {

			const j = ( i + 1 ) % n;
			this.pos.push( flat[ i * 2 ], flat[ i * 2 + 1 ], z, flat[ j * 2 ], flat[ j * 2 + 1 ], z );
			this.col.push( color.r, color.g, color.b, color.r, color.g, color.b );

		}

	}

	build() {

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.pos, 3 ) );
		g.setAttribute( 'color', new THREE.Float32BufferAttribute( this.col, 3 ) );
		return new THREE.LineSegments( g, new THREE.LineBasicNodeMaterial( { vertexColors: true } ) );

	}

}

export function buildCityMeshes( city ) {

	const group = new THREE.Group();
	const fills = new FillBuilder();
	const lines = new LineBuilder();

	for ( const p of city.parks ) {

		fills.addPoly( p, Z.park, PAL.park );
		lines.addLine( p[ 0 ], Z.park, PAL.parkEdge, true );

	}

	for ( const p of city.water ) {

		fills.addPoly( p, Z.water, PAL.water );
		for ( const r of p ) lines.addLine( r, Z.water, PAL.waterEdge, true );

	}

	for ( const w of city.waterways ) if ( w.cls === 'stream' ) lines.addLine( w.line, Z.water, PAL.waterway );

	for ( const p of city.roads.minor ) fills.addPoly( p, Z.road, PAL.roadMinor );
	for ( const p of city.roads.major ) fills.addPoly( p, Z.road + 0.01, PAL.roadMajor );
	for ( const p of city.roads.ped ) fills.addPoly( p, Z.ped, PAL.roadPed );
	for ( const l of city.roadLines.major || [] ) lines.addLine( l, Z.ped, PAL.roadLine );
	for ( const l of city.roadLines.path || [] ) lines.addLine( l, Z.road, PAL.pathLine );
	for ( const l of city.roadLines.service || [] ) lines.addLine( l, Z.road, PAL.pathLine );
	for ( const l of city.rail ) lines.addLine( l, Z.rail, PAL.rail );

	for ( const b of city.buildings ) {

		const [ fill, edge ] = b.k ? PAL.kinds[ b.k ] : [ PAL.building, PAL.buildingEdge ];
		const z = Z.building + ( b.k ? 0.05 : 0 );
		fills.addPoly( b.p, z, fill );
		for ( const r of b.p ) lines.addLine( r, z + 0.01, edge, true );

	}

	group.add( fills.build(), lines.build() );
	group.add( buildPoiMarkers( city ) );
	return group;

}

// Small vector glyphs for point features. Built as line segments so they stay crisp at any zoom
// (sized in world metres, so they shrink when zoomed out — that is intended, cameras are detail).
function buildPoiMarkers( city ) {

	const lines = new LineBuilder();
	const z = Z.poi;
	const ring = ( x, y, r, col, n = 10 ) => {

		const pts = [];
		for ( let i = 0; i < n; i ++ ) pts.push( x + r * Math.cos( i / n * Math.PI * 2 ), y + r * Math.sin( i / n * Math.PI * 2 ) );
		lines.addLine( pts, z, col, true );

	};

	for ( const p of city.pois ) {

		const [ x, y ] = p.pos;
		if ( p.kind === 'camera' ) {

			ring( x, y, 1.6, PAL.camera, 6 );

		} else if ( p.kind === 'bus' ) {

			lines.addLine( [ x - 2, y - 2, x + 2, y - 2, x + 2, y + 2, x - 2, y + 2 ], z, PAL.bus, true );

		} else if ( p.kind === 'police' ) {

			ring( x, y, 9, PAL.kinds.police[ 1 ], 4 );
			ring( x, y, 6, PAL.kinds.police[ 1 ], 4 );

		} else if ( p.kind === 'hospital' ) {

			const a = 6, b = 2;
			lines.addLine( [ x - b, y - a, x + b, y - a, x + b, y - b, x + a, y - b, x + a, y + b, x + b, y + b, x + b, y + a,
				x - b, y + a, x - b, y + b, x - a, y + b, x - a, y - b, x - b, y - b ], z, PAL.kinds.hospital[ 1 ], true );

		}

	}

	return lines.build();

}
