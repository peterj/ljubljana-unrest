// The cities on the landing page, in order. Every mission plays in Ljubljana for now (its own map folder,
// static city, is a part of Ljubljana); the others are announced but not playable yet.
export const CITIES = [
	{ id: 'ljubljana', name: 'Ljubljana', country: 'Slovenia', open: true },
	{ id: 'belgrade', name: 'Belgrade', country: 'Serbia', open: false },
	{ id: 'paris', name: 'Paris', country: 'France', open: false },
];

export const findCity = ( id ) => CITIES.find( ( c ) => c.id === id && c.open );

// the city a mission belongs to; the training mission belongs to none (it is on the landing page)
export const cityOf = ( M ) => M?.tutorial ? null : 'ljubljana';
