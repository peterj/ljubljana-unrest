export const SDK_VERSION = 1;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const text = ( value ) => typeof value === 'string' && value.trim() !== '';
const dense = ( value, check ) => Array.isArray( value ) && Array.from( value ).every( check );

export function check( condition, path, message ) {

	if ( ! condition ) throw new Error( `${path}: ${message}` );

}

export function fields( value, allowed, path ) {

	check( value !== null && typeof value === 'object' && ! Array.isArray( value ), path, 'must be an object' );
	for ( const key of Object.keys( value ) ) check( allowed.includes( key ), `${path}.${key}`, 'unsupported field in this SDK preview' );

}

export function point( value, path ) {

	check( dense( value, Number.isFinite ) && value.length === 2, path, 'must be two finite coordinates in meters' );
	return Object.freeze( [ ...value ] );

}

export function place( name ) {

	check( text( name ), 'place.name', 'must be a non-empty string' );
	return Object.freeze( { kind: 'place', name } );

}

export function survive( options ) {

	fields( options, [ 'id', 'seconds', 'label', 'reason' ], 'objective' );
	check( typeof options.id === 'string' && ID.test( options.id ), 'objective.id', 'must be a lowercase slug' );
	check( Number.isFinite( options.seconds ) && options.seconds > 0, 'objective.seconds', 'must be positive and finite' );
	for ( const key of [ 'label', 'reason' ] ) if ( options[ key ] !== undefined ) check( text( options[ key ] ), `objective.${key}`, 'must be a non-empty string' );
	return Object.freeze( { kind: 'survive', id: options.id, seconds: options.seconds,
		label: options.label ?? 'Hold position', reason: options.reason ?? 'Objective complete.' } );

}

export function defineScenario( options ) {

	fields( options, [ 'id', 'title', 'subtitle', 'brief', 'side', 'city', 'goals', 'tips', 'locations', 'setup', 'objectives' ], 'scenario' );
	check( typeof options.id === 'string' && ID.test( options.id ), 'scenario.id', 'must be a lowercase slug' );
	for ( const key of [ 'title', 'subtitle', 'brief' ] ) check( text( options[ key ] ), `scenario.${key}`, 'must be a non-empty string' );
	check( options.side === undefined || options.side === 'police', 'scenario.side', 'this SDK preview supports police scenarios only' );
	check( options.city == null || ( typeof options.city === 'string' && /^[a-z0-9_-]+$/.test( options.city ) ), 'scenario.city', 'must be a map folder name' );
	for ( const key of [ 'goals', 'tips' ] ) check( dense( options[ key ] ?? [], text ), `scenario.${key}`, 'must be a dense array of non-empty strings' );
	check( options.setup === undefined || typeof options.setup === 'function', 'scenario.setup', 'must be a function' );
	const locations = Object.create( null );
	fields( options.locations ?? {}, Object.keys( options.locations ?? {} ), 'scenario.locations' );
	for ( const [ id, reference ] of Object.entries( options.locations ?? {} ) ) {

		check( ID.test( id ), `scenario.locations.${id}`, 'must be a lowercase slug' );
		if ( Array.isArray( reference ) ) locations[ id ] = point( reference, `scenario.locations.${id}` );
		else {

			fields( reference, [ 'kind', 'name' ], `scenario.locations.${id}` );
			check( reference.kind === 'place', `scenario.locations.${id}`, 'must be a place reference or coordinates' );
			locations[ id ] = place( reference.name );

		}

	}

	check( Array.isArray( options.objectives ) && options.objectives.length === 1 && options.objectives[ 0 ]?.kind === 'survive',
		'scenario.objectives', 'this SDK preview requires exactly one survive objective' );
	const { kind, ...objective } = options.objectives[ 0 ];
	return Object.freeze( { kind: 'scenario', sdkVersion: SDK_VERSION, id: options.id, title: options.title,
		subtitle: options.subtitle, brief: options.brief, side: 'police', city: options.city ?? null,
		goals: Object.freeze( [ ...( options.goals ?? [] ) ] ), tips: Object.freeze( [ ...( options.tips ?? [] ) ] ),
		locations: Object.freeze( locations ), setup: options.setup,
		objectives: Object.freeze( [ survive( objective ) ] ) } );

}

export function normalizeScenario( value ) {

	check( value?.kind === 'scenario' && value.sdkVersion === SDK_VERSION, 'scenario', 'expected an SDK v1 scenario definition' );
	const { kind, sdkVersion, ...options } = value;
	return defineScenario( options );

}