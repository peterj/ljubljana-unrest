// Map editor: places a play area on OpenStreetMap and edits its settings (maps/<city>/<area>.json, see
// maps/README.md), builds it with tools/mapbuild through the dev server (plugin.ts) and shows what the build made.
// Run it with `npm run editor`.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './editor.css';

const KINDS = [ 'gov', 'police', 'hospital', 'embassy', 'media', 'transit', 'landmark' ];
const COLOR = { gov: '#ff6a10', police: '#2b8cff', hospital: '#e9e4d8', embassy: '#9a7cff', media: '#ffb020',
	transit: '#9fb0c4', landmark: '#b4aa96', target: '#ff2d55', none: '#7c8290' };
const DEFAULT_SIZE = [ 3200, 2900 ]; // about the Ljubljana centre map
const SNAP = 20; // m; sizes must be multiples of the 4 m cost grid
const MIN_SIDE = 200, MAX_SIDE = 8192;
const ID = /^[a-z0-9_-]+$/;
const TRANSLIT = [ 'sr' ];

// metres per degree around a latitude (WGS84). The build projects with a transverse Mercator centred on the map; over
// a few kilometres this local approximation differs from it by well under a metre.
function perDegree( lat ) {

	const p = lat * Math.PI / 180;
	return {
		lat: 111132.954 - 559.822 * Math.cos( 2 * p ) + 1.175 * Math.cos( 4 * p ),
		lon: 111412.84 * Math.cos( p ) - 93.5 * Math.cos( 3 * p ) + 0.118 * Math.cos( 5 * p ),
	};

}

const toLatLng = ( center, x, y ) => {

	const k = perDegree( center[ 1 ] );
	return L.latLng( center[ 1 ] + y / k.lat, center[ 0 ] + x / k.lon );

};
const toXY = ( center, ll ) => {

	const k = perDegree( center[ 1 ] );
	return [ ( ll.lng - center[ 0 ] ) * k.lon, ( ll.lat - center[ 1 ] ) * k.lat ];

};
const lonlat = ( ll ) => [ + ll.lng.toFixed( 6 ), + ll.lat.toFixed( 6 ) ];
const latlng = ( p ) => L.latLng( p[ 1 ], p[ 0 ] );
const flatLatLngs = ( f ) => {

	const out = [];
	for ( let i = 0; i < f.length; i += 2 ) out.push( L.latLng( f[ i + 1 ], f[ i ] ) );
	return out;

};
const esc = ( s ) => String( s ?? '' ).replace( /[&<>"]/g, ( c ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } )[ c ] );
const osmLink = ( id ) => `<a class="osm" href="https://www.openstreetmap.org/${ esc( id ) }" target="_blank" rel="noopener">${ esc( id ) }</a>`;
const snap = ( v ) => Math.min( MAX_SIDE, Math.max( MIN_SIDE, Math.round( v / SNAP ) * SNAP ) );

// ---------------------------------------------------------------- state

const state = {
	maps: [], // [ { id, name, center, size } ] from maps/
	id: null, // '<city>/<area>' being edited
	S: null, // its settings
	dirty: false,
	view: null, // the last build, from the dev server (.cache/maps/<city>-<area>.editor.json)
	mode: 'select', // select | center | place | from | to
	creating: false,
	pendingSwitch: null,
	building: false,
	log: [],
	status: '',
	layers: { buildings: true, candidates: true, built: true, dim: true },
	raster: 'none',
};

function normalise( d ) {

	d.places ??= [];
	d.targets ??= [];
	d.route ??= null;
	const lm = d.landmarks ?? {};
	d.landmarks = { auto: lm.auto ?? true, add: lm.add ?? [], drop: lm.drop ?? [], rename: lm.rename ?? {} };
	return d;

}

// the settings file as it is saved: defaults and empty lists left out
function serialise( S ) {

	const d: any = { name: S.name, center: S.center, size: S.size };
	if ( S.names && ! ( S.names.length === 1 && S.names[ 0 ] === 'name' ) ) d.names = S.names;
	if ( S.transliterate ) d.transliterate = S.transliterate;
	if ( S.places.length ) d.places = S.places;
	if ( S.route ) d.route = S.route;
	if ( S.targets.length ) d.targets = S.targets;
	const lm = S.landmarks, lmOut: any = {};
	if ( ! lm.auto ) lmOut.auto = false;
	if ( lm.add.length ) lmOut.add = lm.add;
	if ( lm.drop.length ) lmOut.drop = lm.drop;
	if ( Object.keys( lm.rename ).length ) lmOut.rename = lm.rename;
	if ( Object.keys( lmOut ).length ) d.landmarks = lmOut;
	return d;

}

function changed( { marks = true, buildings = false } = {} ) {

	state.dirty = true;
	renderPanel();
	if ( marks ) drawMarks();
	if ( buildings ) styleBuildings();

}

// ---------------------------------------------------------------- map

const mapEl = document.getElementById( 'map' );
const map = L.map( mapEl, { preferCanvas: true, zoomSnap: 0.5 } ).setView( [ 44.8125, 20.463 ], 14 );
L.tileLayer( 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
	maxZoom: 19,
	attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
} ).addTo( map );
for ( const [ name, z ] of [ [ 'raster', 350 ], [ 'buildings', 400 ], [ 'mask', 420 ], [ 'built', 430 ], [ 'marks', 610 ] ] as const ) {

	map.createPane( name ).style.zIndex = String( z );

}

map.getPane( 'mask' ).style.pointerEvents = 'none';

const groups = {
	raster: L.layerGroup().addTo( map ),
	buildings: L.layerGroup().addTo( map ),
	built: L.layerGroup().addTo( map ),
	candidates: L.layerGroup().addTo( map ),
	marks: L.layerGroup().addTo( map ),
};

// the play area: a dimmed outside, its outline, a centre handle (move) and a corner handle (resize about the centre)
const WORLD: [ number, number ][] = [ [ - 85, - 180 ], [ - 85, 180 ], [ 85, 180 ], [ 85, - 180 ] ];
const mask = L.polygon( [ WORLD ], { pane: 'mask', stroke: false, fillColor: '#05070b', fillOpacity: 0.55, interactive: false } );
const outline = L.rectangle( [ [ 0, 0 ], [ 0, 0 ] ], { pane: 'mask', color: '#ff6a10', weight: 2, fill: false, interactive: false } );
const handle = ( cls ) => L.divIcon( { className: '', html: `<div class="handle ${ cls }"></div>`, iconSize: [ 0, 0 ] } );
const centerHandle = L.marker( [ 0, 0 ], { draggable: true, icon: handle( 'center' ), pane: 'marks', title: 'Drag to move the play area' } );
const cornerHandle = L.marker( [ 0, 0 ], { draggable: true, icon: handle( 'corner' ), pane: 'marks', title: 'Drag to resize the play area' } );

function areaCorners( S ) {

	const [ w, h ] = S.size;
	return [ toLatLng( S.center, - w / 2, - h / 2 ), toLatLng( S.center, w / 2, h / 2 ) ];

}

function updateArea( { corner = true } = {} ) {

	const S = state.S;
	if ( ! S ) {

		for ( const l of [ mask, outline, centerHandle, cornerHandle ] ) l.remove();
		return;

	}

	const [ sw, ne ] = areaCorners( S );
	const box = [ sw, L.latLng( sw.lat, ne.lng ), ne, L.latLng( ne.lat, sw.lng ) ];
	mask.setLatLngs( [ WORLD.map( ( p ) => L.latLng( p[ 0 ], p[ 1 ] ) ), box ] ).addTo( map );
	outline.setBounds( L.latLngBounds( sw, ne ) ).addTo( map );
	centerHandle.setLatLng( latlng( S.center ) ).addTo( map );
	if ( corner ) cornerHandle.setLatLng( ne ).addTo( map );

}

centerHandle.on( 'drag', ( e: any ) => {

	state.S.center = lonlat( e.latlng );
	updateArea();
	renderArea();

} );
centerHandle.on( 'dragend', () => changed( { marks: false } ) );
cornerHandle.on( 'drag', ( e: any ) => {

	const [ x, y ] = toXY( state.S.center, e.latlng );
	state.S.size = [ snap( 2 * Math.abs( x ) ), snap( 2 * Math.abs( y ) ) ];
	updateArea( { corner: false } );
	renderArea();

} );
cornerHandle.on( 'dragend', () => {

	updateArea();
	changed( { marks: false } );

} );

// places and the route ends
function tag( text, cls = '' ) {

	return L.divIcon( { className: '', html: `<span class="tag ${ cls }">${ esc( text ) }</span>`, iconSize: [ 0, 0 ] } );

}

function drawMarks() {

	groups.marks.clearLayers();
	const S = state.S;
	if ( ! S ) return;
	S.places.forEach( ( p, i ) => {

		L.marker( latlng( p.at ), { draggable: true, icon: tag( p.name ), pane: 'marks', title: 'Drag to move' } )
			.on( 'dragend', ( e: any ) => {

				p.at = lonlat( e.target.getLatLng() );
				changed( { marks: false } );

			} )
			.on( 'click', () => document.getElementById( `place-${ i }` )?.focus() )
			.addTo( groups.marks );

	} );
	for ( const end of [ 'from', 'to' ] ) {

		if ( ! S.route?.[ end ] ) continue;
		L.marker( latlng( S.route[ end ] ), { draggable: true, icon: tag( end === 'from' ? 'A' : 'B', 'end' ), pane: 'marks',
			title: end === 'from' ? 'Route start' : 'Route end' } )
			.on( 'dragend', ( e: any ) => {

				S.route[ end ] = lonlat( e.target.getLatLng() );
				changed( { marks: false } );

			} )
			.addTo( groups.marks );

	}

}

map.on( 'click', ( e: any ) => {

	const S = state.S;
	if ( ! S ) return;
	if ( state.mode === 'select' ) {

		const b = state.view && state.layers.buildings && buildingAt( e.latlng );
		if ( b ) L.popup().setLatLng( e.latlng ).setContent( buildingPopup( b ) ).openOn( map );
		return;

	}

	const at = lonlat( e.latlng );
	if ( state.mode === 'center' ) {

		S.center = at;
		state.mode = 'select';
		updateArea();
		changed( { marks: false } );
		return;

	}

	if ( state.mode === 'place' ) {

		S.places.push( { name: `Place ${ S.places.length + 1 }`, at } );
		state.mode = 'select';
		changed();
		const input = document.getElementById( `place-${ S.places.length - 1 }` ) as HTMLInputElement;
		input?.focus();
		input?.select();
		return;

	}

	S.route ??= { from: null, to: null };
	S.route[ state.mode ] = at;
	if ( state.mode === 'from' && ! S.route.to ) {

		state.mode = 'to';

	} else {

		state.mode = 'select';

	}

	if ( ! S.route.from || ! S.route.to ) {

		// a route needs both ends before it can be saved; keep the half-set one only in the editor
		renderPanel();
		drawMarks();
		return;

	}

	changed();

} );

// ---------------------------------------------------------------- what the last build made

// Buildings are drawn as one multipolygon per style: thousands of separate Leaflet polygons take seconds to redraw.
// Clicks find their building through a grid of bounding boxes instead.
const CELL = 0.002; // degrees
let buildingGrid = new Map();

const cellKey = ( x, y ) => `${ Math.floor( x / CELL ) },${ Math.floor( y / CELL ) }`;

function indexBuildings( v ) {

	buildingGrid = new Map();
	for ( const b of v.buildings ) {

		let x0 = Infinity, y0 = Infinity, x1 = - Infinity, y1 = - Infinity;
		for ( let i = 0; i < b.p.length; i += 2 ) {

			x0 = Math.min( x0, b.p[ i ] ); x1 = Math.max( x1, b.p[ i ] );
			y0 = Math.min( y0, b.p[ i + 1 ] ); y1 = Math.max( y1, b.p[ i + 1 ] );

		}

		for ( let cx = Math.floor( x0 / CELL ); cx <= Math.floor( x1 / CELL ); cx ++ ) {

			for ( let cy = Math.floor( y0 / CELL ); cy <= Math.floor( y1 / CELL ); cy ++ ) {

				const k = `${ cx },${ cy }`;
				if ( ! buildingGrid.has( k ) ) buildingGrid.set( k, [] );
				buildingGrid.get( k ).push( b );

			}

		}

	}

}

function buildingAt( ll ) {

	const x = ll.lng, y = ll.lat;
	for ( const b of buildingGrid.get( cellKey( x, y ) ) ?? [] ) {

		let inside = false;
		const p = b.p, n = p.length;
		for ( let i = 0, j = n - 2; i < n; j = i, i += 2 ) {

			if ( ( p[ i + 1 ] > y ) !== ( p[ j + 1 ] > y ) && x < ( p[ j ] - p[ i ] ) * ( y - p[ i + 1 ] ) / ( p[ j + 1 ] - p[ i + 1 ] ) + p[ i ] ) inside = ! inside;

		}

		if ( inside ) return b;

	}

	return null;

}

function landmarkOf( osm ) {

	const S = state.S;
	if ( S.targets.some( ( t ) => t.osm === osm ) ) return 'target';
	const added = S.landmarks.add.find( ( a ) => a.osm === osm );
	if ( added ) return added.kind;
	return null;

}

function buildingStyle( b ) {

	const pending = landmarkOf( b.osm );
	const kind = pending ?? b.k;
	if ( ! kind ) return { color: '#c8c2b4', weight: 0.8, opacity: 0.6, fillColor: '#c8c2b4', fillOpacity: 0.18 };
	return { color: COLOR[ kind ], weight: pending ? 2 : 1, opacity: 1, fillColor: COLOR[ kind ], fillOpacity: pending ? 0.5 : 0.35,
		dashArray: pending && ! b.k ? '4 3' : null };

}

function styleBuildings() {

	groups.buildings.clearLayers();
	if ( ! state.view || ! state.layers.buildings ) return;
	const byStyle = new Map();
	for ( const b of state.view.buildings ) {

		const style = buildingStyle( b ), key = JSON.stringify( style );
		if ( ! byStyle.has( key ) ) byStyle.set( key, { style, rings: [] } );
		byStyle.get( key ).rings.push( [ flatLatLngs( b.p ) ] );

	}

	for ( const { style, rings } of byStyle.values() ) {

		L.polygon( rings, { pane: 'buildings', interactive: false, ...style } ).addTo( groups.buildings );

	}

}

function drawView() {

	groups.built.clearLayers();
	groups.candidates.clearLayers();
	styleBuildings();
	const v = state.view;
	if ( ! v ) return;

	if ( state.layers.built ) {

		if ( v.route.length ) {

			L.polyline( flatLatLngs( v.route ), { pane: 'built', color: '#4fd18b', weight: 4, opacity: 0.85, interactive: false } ).addTo( groups.built );

		}

		for ( const e of v.entries ) {

			L.circleMarker( latlng( e.at ), { pane: 'built', radius: 5, color: '#ffb020', weight: 2, fillOpacity: 0 } )
				.bindTooltip( `Entry: ${ esc( e.name ?? 'unnamed street' ) }` ).addTo( groups.built );

		}

		for ( const [ label, t ] of Object.entries( v.targets ) as any ) {

			for ( const x of t.exits ) {

				L.circleMarker( latlng( x ), { pane: 'built', radius: 4, color: '#ff2d55', weight: 2, fillOpacity: 0.6 } )
					.bindTooltip( `Exit of ${ esc( label ) }` ).addTo( groups.built );

			}

		}

	}

	if ( state.layers.candidates ) {

		for ( const c of v.candidates ) {

			const st = candidateState( c );
			L.circleMarker( latlng( c.at ), {
				pane: 'built', radius: st === 'suggestion' ? 4 : 6, weight: 2, bubblingMouseEvents: false,
				color: st === 'dropped' ? COLOR.none : COLOR[ c.kind ], dashArray: st === 'dropped' ? '2 2' : null,
				fillColor: COLOR[ c.kind ], fillOpacity: st === 'used' || st === 'added' ? 0.8 : 0,
			} ).bindTooltip( `${ esc( shownName( c ) ?? '(no name)' ) } · ${ c.kind } · ${ st }` )
				.on( 'click', ( e: any ) => {

					if ( state.mode !== 'select' ) return map.fire( 'click', e ); // a click tool is on: the map takes it
					L.popup().setLatLng( e.latlng ).setContent( candidatePopup( c ) ).openOn( map );

				} ).addTo( groups.candidates );

		}

	}

}

// used: an auto landmark the settings keep; dropped: one they drop; suggestion: a weaker match the build left out;
// added: one the settings add; unnamed: an auto match without a name (left out until renamed)
function candidateState( c ) {

	const lm = state.S.landmarks;
	if ( lm.add.some( ( a ) => a.osm === c.osm ) ) return 'added';
	if ( lm.drop.includes( c.osm ) ) return 'dropped';
	if ( ! c.auto || ! lm.auto ) return 'suggestion';
	return shownName( c ) ? 'used' : 'unnamed';

}

const shownName = ( c ) => state.S.landmarks.rename[ c.osm ] ?? c.name;

// ---------------------------------------------------------------- popups (built as DOM so buttons can act directly)

function popup( html, actions ) {

	const el = document.createElement( 'div' );
	el.innerHTML = html;
	el.addEventListener( 'click', ( e ) => {

		const act = ( e.target as HTMLElement ).closest( '[data-act]' )?.getAttribute( 'data-act' );
		if ( ! act || ! actions[ act ] ) return;
		actions[ act ]( el );
		map.closePopup();

	} );
	return el;

}

const kindSelect = ( sel = 'gov' ) => `<select data-kind>${ KINDS.map( ( k ) => `<option${ k === sel ? ' selected' : '' }>${ k }</option>` ).join( '' ) }</select>`;
const val = ( el, sel ) => ( el.querySelector( sel ) as HTMLInputElement )?.value.trim() ?? '';

function buildingPopup( b ) {

	const S = state.S, lm = S.landmarks;
	const target = S.targets.find( ( t ) => t.osm === b.osm );
	const added = lm.add.find( ( a ) => a.osm === b.osm );
	const name = b.n ?? '';
	let html = `<b>${ esc( name || 'Building' ) }</b><br>${ osmLink( b.osm ) }${ b.k ? ` · built as ${ b.k }` : '' }<br><br>`;
	html += target ? `<div class="row">Target “${ esc( target.label ) }” <button data-act="untarget">Remove</button></div>`
		: `<div class="row"><input data-label class="grow" placeholder="label" value="${ esc( name ) }"><button data-act="target">Make target</button></div>`;
	html += added ? `<div class="row">Landmark (${ added.kind }) <button data-act="unadd">Remove</button></div>`
		: `<div class="row">${ kindSelect( b.k ?? 'gov' ) }<button data-act="add">Add as landmark</button></div>`;
	return popup( html, {
		target: ( el ) => {

			S.targets.push( { label: val( el, '[data-label]' ) || b.osm, osm: b.osm } );
			changed( { buildings: true } );

		},
		untarget: () => {

			S.targets = S.targets.filter( ( t ) => t !== target );
			changed( { buildings: true } );

		},
		add: ( el ) => {

			const label = val( el, '[data-label]' ) || name;
			lm.add.push( { kind: val( el, '[data-kind]' ), label: label || b.osm, osm: b.osm } );
			changed( { buildings: true } );
			drawView();

		},
		unadd: () => {

			lm.add = lm.add.filter( ( a ) => a !== added );
			changed( { buildings: true } );
			drawView();

		},
	} );

}

function candidatePopup( c ) {

	const lm = state.S.landmarks;
	const st = candidateState( c );
	let html = `<b>${ esc( shownName( c ) ?? '(no name)' ) }</b><br>${ osmLink( c.osm ) } · ${ c.kind } · ${ st }<br><br>`;
	if ( st === 'used' || st === 'unnamed' ) {

		html += `<div class="row"><input data-label class="grow" value="${ esc( shownName( c ) ) }" placeholder="label"><button data-act="rename">Rename</button></div>`;
		html += '<div class="row"><button data-act="drop">Drop this landmark</button></div>';

	} else if ( st === 'dropped' ) {

		html += '<div class="row"><button data-act="undrop">Keep it after all</button></div>';

	} else if ( st === 'added' ) {

		html += '<div class="row"><button data-act="unadd">Remove</button></div>';

	} else {

		html += `<div class="row">${ kindSelect( c.kind ) }<input data-label class="grow" value="${ esc( c.name ) }" placeholder="label"></div>`;
		html += '<div class="row"><button data-act="add">Add as landmark</button></div>';

	}

	return popup( html, {
		rename: ( el ) => {

			const label = val( el, '[data-label]' );
			if ( label && label !== c.name ) lm.rename[ c.osm ] = label; else delete lm.rename[ c.osm ];
			changed();
			drawView();

		},
		drop: () => {

			lm.drop.push( c.osm );
			delete lm.rename[ c.osm ];
			changed();
			drawView();

		},
		undrop: () => {

			lm.drop = lm.drop.filter( ( d ) => d !== c.osm );
			changed();
			drawView();

		},
		add: ( el ) => {

			lm.add.push( { kind: val( el, '[data-kind]' ), label: val( el, '[data-label]' ) || c.osm, osm: c.osm } );
			changed( { buildings: true } );
			drawView();

		},
		unadd: () => {

			lm.add = lm.add.filter( ( a ) => a.osm !== c.osm );
			changed( { buildings: true } );
			drawView();

		},
	} );

}

// ---------------------------------------------------------------- raster overlays (from public/data/<city>/<area>/)

const rasterCache = new Map();

async function drawRaster() {

	groups.raster.clearLayers();
	const v = state.view;
	if ( state.raster === 'none' || ! v ) return;
	const key = `${ state.id }/${ state.raster }/${ v.built }`;
	if ( ! rasterCache.has( key ) ) rasterCache.set( key, await rasterImage( state.raster, v ) );
	const [ sw, ne ] = areaCorners( v );
	L.imageOverlay( rasterCache.get( key ), L.latLngBounds( sw, ne ), { pane: 'raster', opacity: 0.75 } ).addTo( groups.raster );

}

async function rasterImage( name, v ) {

	const base = `/data/${ state.id }/`;
	const city = await ( await fetch( base + 'city.json?t=' + v.built ) ).json();
	const meta = city[ name ];
	const buf = await ( await fetch( base + meta.file + '?t=' + v.built ) ).arrayBuffer();
	const data = name === 'sdf' ? new Int8Array( buf ) : new Uint8Array( buf );
	const canvas = document.createElement( 'canvas' );
	canvas.width = meta.w;
	canvas.height = meta.h;
	const ctx = canvas.getContext( '2d' );
	const img = ctx.createImageData( meta.w, meta.h );
	for ( let iy = 0; iy < meta.h; iy ++ ) {

		for ( let ix = 0; ix < meta.w; ix ++ ) {

			const d = data[ iy * meta.w + ix ]; // row 0 is the south edge
			const o = ( ( meta.h - 1 - iy ) * meta.w + ix ) * 4;
			let r = 0, g = 0, b = 0, a = 0;
			if ( name === 'cost' ) {

				if ( d === 255 ) [ r, g, b, a ] = [ 255, 45, 85, 150 ];
				else [ r, g, b, a ] = [ 255, 176, 32, Math.min( 200, Math.max( 0, ( d - 10 ) * 4 ) ) ];

			} else if ( name === 'sdf' ) {

				if ( d < 0 ) [ r, g, b, a ] = [ 43, 140, 255, 150 ];
				else [ r, g, b, a ] = [ 255, 106, 16, Math.max( 0, 180 - d * 2 ) ];

			} else if ( d > 0 ) {

				[ r, g, b, a ] = [ 255, 0, 200, Math.min( 220, 70 + d * 40 ) ];

			}

			img.data[ o ] = r;
			img.data[ o + 1 ] = g;
			img.data[ o + 2 ] = b;
			img.data[ o + 3 ] = a;

		}

	}

	ctx.putImageData( img, 0, 0 );
	return canvas.toDataURL();

}

// ---------------------------------------------------------------- panel

const panel = document.getElementById( 'panel' );

function sizeInfo( S ) {

	const [ w, h ] = S.size;
	const sdf = w * h / 1e6;
	let s = `${ ( w / 1000 ).toFixed( 2 ) } × ${ ( h / 1000 ).toFixed( 2 ) } km · SDF ${ sdf.toFixed( 1 ) } MB`;
	if ( w * h > 16e6 ) s += ' <span class="warn">· large: slower loads and flow fields</span>';
	return s;

}

function renderArea() {

	const S = state.S;
	const el = document.getElementById( 'area-info' );
	if ( ! S || ! el ) return;
	el.innerHTML = sizeInfo( S );
	( document.getElementById( 'w' ) as HTMLInputElement ).value = S.size[ 0 ];
	( document.getElementById( 'h' ) as HTMLInputElement ).value = S.size[ 1 ];
	document.getElementById( 'center' ).textContent = `${ S.center[ 0 ].toFixed( 5 ) }, ${ S.center[ 1 ].toFixed( 5 ) }`;

}

const MODE_HINT = {
	center: 'Click the map where the centre of the play area should be.',
	select: 'Click a building or a landmark pin to make it a target or a landmark. Drag the orange handles to move or resize the play area.',
	place: 'Click the map where the place is.',
	from: 'Click where the convoy route starts.',
	to: 'Click where the convoy route ends.',
};

function renderPanel() {

	mapEl.classList.toggle( 'pick', state.mode !== 'select' );
	const S = state.S, v = state.view;
	let html = '<header><b>CORDON BLEU</b><span>map editor</span></header>';

	html += '<section><div class="row"><select id="pick" class="grow"><option value="">— choose a map —</option>';
	for ( const m of state.maps ) html += `<option value="${ m.id }"${ m.id === state.id ? ' selected' : '' }>${ esc( m.id ) } · ${ esc( m.name ) }</option>`;
	html += '</select><button data-act="new">New</button></div>';
	if ( state.pendingSwitch ) {

		html += `<p class="hint warn">${ esc( state.id ) } has unsaved changes.</p><div class="row"><button data-act="save">Save</button><button data-act="discard">Discard them</button><button data-act="stay">Stay</button></div>`;

	}

	if ( state.creating ) {

		html += `<p class="hint">A new map at the centre of the view. City and area are folder names: lower case, digits, - and _.</p>
			<div class="row"><label>City</label><input id="new-city" class="grow" placeholder="belgrade"></div>
			<div class="row"><label>Area</label><input id="new-area" class="grow" placeholder="centre"></div>
			<div class="row"><label>Name</label><input id="new-name" class="grow" placeholder="Centre"></div>
			<div class="row"><button data-act="create" class="primary">Create</button><button data-act="cancel">Cancel</button><span id="new-error" class="bad"></span></div>`;

	}

	html += '</section>';

	if ( ! S ) {

		html += `<section><p class="hint">Choose a map, or create a new one: pan the map to the district first. Settings are saved to maps/&lt;city&gt;/&lt;area&gt;.json (see maps/README.md).</p>${ state.status ? `<p class="hint">${ state.status }</p>` : '' }</section>`;
		panel.innerHTML = html;
		return;

	}

	// play area
	html += `<section><h2>Play area</h2>
		<div class="row"><label>Name</label><input id="name" class="grow" value="${ esc( S.name ) }"></div>
		<div class="row"><label>Centre</label><span id="center" class="grow"></span>
			<button data-act="mode" data-mode="center"${ state.mode === 'center' ? ' class="on"' : '' } title="Set the centre by clicking the map">⌖ Set</button></div>
		<div class="row"><label>Size (m)</label><input id="w" type="number" step="${ SNAP }" min="${ MIN_SIDE }" max="${ MAX_SIDE }"> ×
			<input id="h" type="number" step="${ SNAP }" min="${ MIN_SIDE }" max="${ MAX_SIDE }"></div>
		<p class="hint" id="area-info"></p>
		<div class="row"><label>Name tags</label><input id="names" class="grow" value="${ esc( ( S.names ?? [ 'name' ] ).join( ', ' ) ) }" title="OSM tags to take names from, first present wins"></div>
		<div class="row"><label>Cyrillic</label><select id="translit" class="grow"><option value="">keep as it is</option>
			${ TRANSLIT.map( ( t ) => `<option value="${ t }"${ S.transliterate === t ? ' selected' : '' }>to Latin (${ t })</option>` ).join( '' ) }</select></div>
		</section>`;

	// tools
	const tool = ( m, label ) => `<button data-act="mode" data-mode="${ m }"${ state.mode === m ? ' class="on"' : '' }>${ label }</button>`;
	html += `<section><h2>Tools</h2><div class="tools">${ tool( 'select', 'Select' ) }${ tool( 'place', 'Add place' ) }${ tool( 'from', 'Route start (A)' ) }${ tool( 'to', 'Route end (B)' ) }</div>
		<p class="hint">${ MODE_HINT[ state.mode ] }</p></section>`;

	// places
	html += `<section><h2>Places<small>${ S.places.length }</small></h2>`;
	if ( ! S.places.length ) html += '<p class="hint empty">Named squares and open spaces missions use as anchors.</p>';
	S.places.forEach( ( p, i ) => {

		html += `<div class="row"><input id="place-${ i }" data-place="${ i }" class="grow" value="${ esc( p.name ) }">
			<button class="x" data-act="goto" data-at="${ p.at }" title="Show">⌖</button><button class="x" data-act="unplace" data-i="${ i }" title="Remove">×</button></div>`;

	} );
	html += '</section>';

	// route
	const end = ( k ) => S.route?.[ k ] ? `${ S.route[ k ][ 0 ].toFixed( 5 ) }, ${ S.route[ k ][ 1 ].toFixed( 5 ) }` : '<span class="empty">not set</span>';
	html += `<section><h2>Convoy route</h2><div class="row"><label>A (start)</label><span class="grow">${ end( 'from' ) }</span></div>
		<div class="row"><label>B (end)</label><span class="grow">${ end( 'to' ) }</span>${ S.route ? '<button class="x" data-act="unroute" title="Remove the route">×</button>' : '' }</div>
		${ S.route && ( ! S.route.from || ! S.route.to ) ? '<p class="hint warn">Set both ends; a half-set route is not saved.</p>' : '' }</section>`;

	// targets
	html += `<section><h2>Targets<small>${ S.targets.length }</small></h2>`;
	if ( ! S.targets.length ) html += `<p class="hint empty">${ v ? 'Click a building and “Make target”.' : 'Build the map first, then click a building.' }</p>`;
	S.targets.forEach( ( t, i ) => {

		html += `<div class="row"><span class="swatch" style="background:${ COLOR.target }"></span><input data-target="${ i }" class="grow" value="${ esc( t.label ) }">
			${ osmLink( t.osm ) }<button class="x" data-act="untarget" data-i="${ i }" title="Remove">×</button></div>`;

	} );
	html += '</section>';

	// landmarks
	const lm = S.landmarks;
	const cname = ( osm ) => v?.candidates.find( ( c ) => c.osm === osm )?.name;
	const counts = v ? v.candidates.reduce( ( n, c ) => ( n[ candidateState( c ) ] = ( n[ candidateState( c ) ] ?? 0 ) + 1, n ), {} ) : null;
	html += `<section><h2>Landmarks</h2>
		<div class="row"><label><input type="checkbox" id="auto"${ lm.auto ? ' checked' : '' }> find them by OSM tags</label></div>`;
	if ( counts ) {

		html += `<p class="hint">${ counts.used ?? 0 } found · ${ counts.dropped ?? 0 } dropped · ${ counts.added ?? 0 } added · ${ counts.suggestion ?? 0 } suggestions${ counts.unnamed ? ` · ${ counts.unnamed } without a name` : '' }. Filled pins are in, hollow ones are suggestions: click to change.</p>`;

	} else {

		html += '<p class="hint empty">Build the map to see what is found.</p>';

	}

	lm.add.forEach( ( a, i ) => {

		html += `<div class="row"><span class="swatch" style="background:${ COLOR[ a.kind ] }"></span><input data-add="${ i }" class="grow" value="${ esc( a.label ) }">
			${ osmLink( a.osm ) }<button class="x" data-act="unadd" data-i="${ i }" title="Remove">×</button></div>`;

	} );
	Object.entries( lm.rename ).forEach( ( [ osm, label ] ) => {

		html += `<div class="row"><span class="grow">${ esc( cname( osm ) ?? osm ) } → <b>${ esc( label ) }</b></span><button class="x" data-act="unrename" data-osm="${ osm }" title="Undo">×</button></div>`;

	} );
	lm.drop.forEach( ( osm ) => {

		html += `<div class="row"><span class="grow"><s>${ esc( cname( osm ) ?? osm ) }</s></span>${ osmLink( osm ) }<button class="x" data-act="undrop" data-osm="${ osm }" title="Keep it">×</button></div>`;

	} );
	html += '</section>';

	// layers
	const check = ( k, label ) => `<label><input type="checkbox" data-layer="${ k }"${ state.layers[ k ] ? ' checked' : '' }> ${ label }</label>`;
	html += `<section><h2>Show</h2><div class="row">${ check( 'buildings', 'buildings' ) } ${ check( 'candidates', 'landmark pins' ) }</div>
		<div class="row">${ check( 'built', 'route, entries, exits' ) } ${ check( 'dim', 'dim basemap' ) }</div>
		<div class="row"><label>Raster</label><select id="raster" class="grow"${ v ? '' : ' disabled' }>
			${ [ [ 'none', 'none' ], [ 'cost', 'walking cost (red: blocked)' ], [ 'sdf', 'distance to obstacles' ], [ 'cctv', 'CCTV coverage' ] ]
		.map( ( [ k, l ] ) => `<option value="${ k }"${ state.raster === k ? ' selected' : '' }>${ l }</option>` ).join( '' ) }</select></div></section>`;

	// save and build
	const built = v ? `Built ${ new Date( v.built ).toLocaleString() } from ${ esc( v.source.extract ) } (${ esc( v.source.timestamp?.slice( 0, 10 ) ?? '?' ) }).`
		: 'Not built yet. The first build of a city downloads its OSM extract, which takes a few minutes.';
	const moved = v && ( v.center[ 0 ] !== S.center[ 0 ] || v.center[ 1 ] !== S.center[ 1 ] || v.size[ 0 ] !== S.size[ 0 ] || v.size[ 1 ] !== S.size[ 1 ] );
	html += `<section><div class="row"><button data-act="save" class="primary"${ state.dirty ? '' : ' disabled' }>Save</button>
		<button data-act="build"${ state.building ? ' disabled' : '' }>${ state.building ? 'Building…' : state.dirty ? 'Save and build' : 'Build' }</button>
		<span class="grow ${ state.dirty ? 'warn' : 'ok' }">${ state.dirty ? 'unsaved changes' : 'saved' }</span></div>
		<p class="hint">${ built }${ moved ? ' <span class="warn">The play area changed since: build again.</span>' : '' }</p>
		${ state.status ? `<p class="hint">${ state.status }</p>` : '' }
		<pre id="log">${ esc( state.log.join( '\n' ) ) }</pre></section>`;

	panel.innerHTML = html;
	renderArea();
	const log = document.getElementById( 'log' );
	log.scrollTop = log.scrollHeight;

}

panel.addEventListener( 'click', async ( e ) => {

	const btn = ( e.target as HTMLElement ).closest( '[data-act]' ) as HTMLElement;
	if ( ! btn || ( btn as HTMLButtonElement ).disabled ) return;
	const S = state.S, act = btn.dataset.act, i = Number( btn.dataset.i );
	switch ( act ) {

		case 'new': if ( state.dirty ) { state.pendingSwitch = NEW; renderPanel(); } else startNew(); break;
		case 'cancel': state.creating = false; renderPanel(); break;
		case 'create': createMap(); break;
		case 'save': await save(); if ( state.pendingSwitch && ! state.dirty ) await proceed(); break;
		case 'discard': state.dirty = false; await proceed(); break;
		case 'stay': state.pendingSwitch = null; renderPanel(); break;
		case 'build': await build(); break;
		case 'mode': state.mode = state.mode === btn.dataset.mode ? 'select' : btn.dataset.mode; renderPanel(); break;
		case 'goto': map.panTo( latlng( btn.dataset.at.split( ',' ).map( Number ) ) ); break;
		case 'unplace': S.places.splice( i, 1 ); changed(); break;
		case 'unroute': S.route = null; changed(); break;
		case 'untarget': S.targets.splice( i, 1 ); changed( { buildings: true } ); break;
		case 'unadd': S.landmarks.add.splice( i, 1 ); changed( { buildings: true } ); drawView(); break;
		case 'unrename': delete S.landmarks.rename[ btn.dataset.osm ]; changed(); drawView(); break;
		case 'undrop': S.landmarks.drop = S.landmarks.drop.filter( ( d ) => d !== btn.dataset.osm ); changed(); drawView(); break;

	}

} );

panel.addEventListener( 'change', async ( e ) => {

	const el = e.target as HTMLInputElement, S = state.S;
	if ( el.id === 'pick' ) return el.value && open( el.value );
	if ( el.dataset.layer ) {

		state.layers[ el.dataset.layer ] = el.checked;
		mapEl.classList.toggle( 'dim', state.layers.dim );
		return drawView();

	}

	if ( el.id === 'raster' ) {

		state.raster = el.value;
		return drawRaster();

	}

	if ( ! S ) return;
	if ( el.id === 'name' ) S.name = el.value.trim() || S.name;
	else if ( el.id === 'w' || el.id === 'h' ) {

		S.size[ el.id === 'w' ? 0 : 1 ] = snap( Number( el.value ) || DEFAULT_SIZE[ 0 ] );
		updateArea();

	} else if ( el.id === 'names' ) {

		const names = el.value.split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
		S.names = names.length ? names : [ 'name' ];

	} else if ( el.id === 'translit' ) S.transliterate = el.value || null;
	else if ( el.id === 'auto' ) S.landmarks.auto = el.checked;
	else if ( el.dataset.place ) S.places[ Number( el.dataset.place ) ].name = el.value.trim() || 'Place';
	else if ( el.dataset.target ) S.targets[ Number( el.dataset.target ) ].label = el.value.trim() || S.targets[ Number( el.dataset.target ) ].osm;
	else if ( el.dataset.add ) S.landmarks.add[ Number( el.dataset.add ) ].label = el.value.trim() || S.landmarks.add[ Number( el.dataset.add ) ].osm;
	else return;
	changed( { buildings: el.id === 'auto' } );
	if ( el.id === 'auto' ) drawView();

} );

panel.addEventListener( 'keydown', ( e ) => {

	if ( e.key === 'Enter' && ( e.target as HTMLElement ).id?.startsWith( 'new-' ) ) createMap();

} );

addEventListener( 'keydown', ( e ) => {

	if ( e.key === 'Escape' && state.mode !== 'select' ) {

		state.mode = 'select';
		renderPanel();

	}

} );

// ---------------------------------------------------------------- loading, saving, building

async function api( url, opts = {} ) {

	const r = await fetch( url, opts );
	if ( ! r.ok ) throw new Error( ( await r.json().catch( () => ( {} ) ) ).error ?? r.statusText );
	return r.json();

}

// "New" or another map while there are unsaved changes waits for Save or Discard
const NEW = '\0new';

async function proceed() {

	const next = state.pendingSwitch;
	state.pendingSwitch = null;
	if ( next === NEW ) startNew(); else await open( next );

}

function startNew() {

	state.creating = true;
	renderPanel();
	document.getElementById( 'new-city' )?.focus();

}

async function listMaps() {

	state.maps = await api( '/__maps' );

}

function createMap() {

	const v = ( id ) => ( document.getElementById( id ) as HTMLInputElement ).value.trim();
	const city = v( 'new-city' ), area = v( 'new-area' ), name = v( 'new-name' ) || area;
	const err = document.getElementById( 'new-error' );
	if ( ! ID.test( city ) || ! ID.test( area ) ) return void ( err.textContent = 'city and area: a-z, 0-9, - and _' );
	if ( city === 'ljubljana' ) return void ( err.textContent = 'Ljubljana is built by build_city.py' );
	const id = `${ city }/${ area }`;
	if ( state.maps.some( ( m ) => m.id === id ) ) return void ( err.textContent = `${ id } exists` );
	state.creating = false;
	state.id = id;
	state.S = normalise( { name, center: lonlat( map.getCenter() ), size: [ ...DEFAULT_SIZE ] } );
	state.view = null;
	state.log = [];
	state.status = '';
	state.maps.push( { id, name, center: state.S.center, size: state.S.size } );
	history.replaceState( null, '', `?map=${ id }` );
	updateArea();
	map.fitBounds( L.latLngBounds( areaCorners( state.S ) ).pad( 0.15 ) );
	drawView();
	drawRaster();
	changed();

}

async function open( id ) {

	if ( state.dirty && state.id !== id ) {

		state.pendingSwitch = id;
		return renderPanel();

	}

	state.pendingSwitch = null;
	state.creating = false;
	state.id = id;
	state.S = normalise( await api( `/__maps/${ id }` ) );
	state.dirty = false;
	state.log = [];
	state.status = '';
	state.mode = 'select';
	history.replaceState( null, '', `?map=${ id }` );
	await loadView();
	updateArea();
	map.fitBounds( L.latLngBounds( areaCorners( state.S ) ).pad( 0.1 ) );
	drawMarks();
	renderPanel();

}

async function loadView() {

	const view = await api( `/__maps/${ state.id }/view` ).catch( () => null );
	state.view = view?.center ? view : null; // older sidecars lack the built area: build again
	if ( state.view ) indexBuildings( state.view );
	drawView();
	await drawRaster();

}

async function save() {

	const S = state.S;
	if ( S.route && ( ! S.route.from || ! S.route.to ) ) S.route = null;
	try {

		await api( `/__maps/${ state.id }`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( serialise( S ) ) } );
		state.dirty = false;
		state.status = `Saved maps/${ state.id }.json.`;
		await listMaps();

	} catch ( e ) {

		state.status = `<span class="bad">Could not save: ${ esc( e.message ) }</span>`;

	}

	renderPanel();
	drawMarks();

}

async function build() {

	if ( state.dirty ) await save();
	if ( state.dirty ) return;
	state.building = true;
	state.log = [];
	state.status = '';
	renderPanel();
	let code = null;
	try {

		const r = await fetch( `/__maps/${ state.id }/build`, { method: 'POST' } );
		if ( ! r.ok ) throw new Error( ( await r.json().catch( () => ( {} ) ) ).error ?? r.statusText );
		const reader = r.body.getReader(), dec = new TextDecoder();
		let rest = '';
		for ( ;; ) {

			const { done, value } = await reader.read();
			if ( done ) break;
			const lines = ( rest + dec.decode( value, { stream: true } ) ).split( '\n' );
			rest = lines.pop();
			for ( const line of lines ) {

				const m = /^exit (-?\d+)$/.exec( line );
				if ( m ) {

					code = Number( m[ 1 ] );
					continue;

				}

				// download progress overwrites its previous line
				const progress = / \d+ \/ \d+ MB$/;
				if ( progress.test( line ) && progress.test( state.log.at( - 1 ) ?? '' ) ) state.log[ state.log.length - 1 ] = line;
				else state.log.push( line );

			}

			const log = document.getElementById( 'log' );
			if ( log ) {

				log.textContent = state.log.join( '\n' );
				log.scrollTop = log.scrollHeight;

			}

		}

	} catch ( e ) {

		state.log.push( `could not build: ${ e.message }` );

	}

	state.building = false;
	state.status = code === 0 ? '<span class="ok">Build finished.</span>' : `<span class="bad">Build failed${ code === null ? '' : ` (exit ${ code })` }: see the log.</span>`;
	if ( code === 0 ) {

		rasterCache.clear();
		await loadView();

	}

	renderPanel();

}

// ---------------------------------------------------------------- start

mapEl.classList.toggle( 'dim', state.layers.dim );
addEventListener( 'beforeunload', ( e ) => {

	if ( state.dirty ) e.preventDefault();

} );

await listMaps().catch( () => {

	state.status = '<span class="bad">The editor needs the dev server: run npm run editor.</span>';

} );
const wanted = new URLSearchParams( location.search ).get( 'map' );
if ( wanted && state.maps.some( ( m ) => m.id === wanted ) ) await open( wanted );
else renderPanel();
