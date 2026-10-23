// The cities on the landing page, in order. A city opens once a listed mission plays there; Ljubljana is always open.
export const CITIES = [
	{ id: 'ljubljana', name: 'Ljubljana', country: 'Slovenia' },
	{ id: 'belgrade', name: 'Belgrade', country: 'Serbia' },
	{ id: 'paris', name: 'Paris', country: 'France' },
];

const CITY_IDS = new Set( CITIES.map( ( c ) => c.id ) );

// A mission's map: static city (a city id) and static map (an area of it, default 'centre').
//   Ljubljana's maps come from tools/build_city.py: public/data/ (centre) and public/data/<map>/.
//   Every other city's come from tools/mapbuild: public/data/<city>/<map>/ (maps/<city>/<map>.json).
// Before cities had maps, static city named a Ljubljana map folder ('north'); without static map that still works.
export function mapOf( M ) {

	let city = M?.city ?? 'ljubljana', map = M?.map ?? 'centre';
	if ( M?.map == null && ! CITY_IDS.has( city ) ) [ city, map ] = [ 'ljubljana', city ];
	const base = city !== 'ljubljana' ? `./data/${ city }/${ map }/` : map === 'centre' ? './data/' : `./data/${ map }/`;
	return { city, map, base };

}

// the city a mission belongs to; the training mission belongs to none (it is on the landing page)
export const cityOf = ( M ) => M?.tutorial ? null : mapOf( M ).city;

// the landing page's cities, each with its listed missions; a plugin's own city is added after the others
export function citiesFor( missions ) {

	const ids = [ ...CITIES.map( ( c ) => c.id ) ];
	for ( const M of missions ) {

		const c = cityOf( M );
		if ( c && ! ids.includes( c ) ) ids.push( c );

	}

	return ids.map( ( id ) => {

		const known = CITIES.find( ( c ) => c.id === id ) ?? { id, name: id[ 0 ].toUpperCase() + id.slice( 1 ), country: '' };
		const count = missions.filter( ( M ) => cityOf( M ) === id ).length;
		return { ...known, missions: count, open: id === 'ljubljana' || count > 0 };

	} );

}

export const findCity = ( id, missions ) => citiesFor( missions ).find( ( c ) => c.id === id && c.open );
