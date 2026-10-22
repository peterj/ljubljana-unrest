import { resourceDefinitions } from './resources.js';
import { commandDefinitions } from './commands.js';

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

export function target( name ) {

	check( text( name ), 'target.name', 'must be a non-empty string' );
	return Object.freeze( { kind: 'target', name } );

}

export function landmark( name ) {

	check( text( name ), 'landmark.name', 'must be a non-empty string' );
	return Object.freeze( { kind: 'landmark', name } );

}

export function holdBuilding( options ) {

	fields( options, [ 'id', 'target', 'seconds', 'label', 'reason', 'exitAt' ], 'objective' );
	check( typeof options.target === 'string' && ID.test( options.target ), 'objective.target', 'must be a target alias' );
	const { target: alias, exitAt = {}, ...timed } = options;
	fields( exitAt, Object.keys( exitAt ), 'objective.exitAt' );
	const exits = Object.fromEntries( Object.entries( exitAt ).map( ( [ index, at ] ) => {

		check( /^(0|[1-9][0-9]*)$/.test( index ), 'objective.exitAt', 'keys must be zero-based exit indices' );
		return [ index, point( at, `objective.exitAt.${index}` ) ];

	} ) );
	return Object.freeze( { ...survive( { seconds: 720, label: 'Hold the building', reason: 'The building held.', ...timed } ),
		kind: 'hold-building', target: alias, exitAt: Object.freeze( exits ) } );

}

export function survive( options ) {

	fields( options, [ 'id', 'seconds', 'label', 'reason' ], 'objective' );
	check( typeof options.id === 'string' && ID.test( options.id ), 'objective.id', 'must be a lowercase slug' );
	check( Number.isFinite( options.seconds ) && options.seconds > 0, 'objective.seconds', 'must be positive and finite' );
	for ( const key of [ 'label', 'reason' ] ) if ( options[ key ] !== undefined ) check( text( options[ key ] ), `objective.${key}`, 'must be a non-empty string' );
	return Object.freeze( { kind: 'survive', id: options.id, seconds: options.seconds,
		label: options.label ?? 'Hold position', reason: options.reason ?? 'Objective complete.' } );

}

export function protect( options ) {

	fields( options, [ 'id', 'seconds', 'label', 'reason', 'protected' ], 'objective' );
	check( typeof options.protected === 'string' && ID.test( options.protected ), 'objective.protected', 'must be a protected identity ID' );
	const { protected: entity, ...timed } = options;
	return Object.freeze( { ...survive( { label: 'Protect the person', reason: 'The protected person is safe.', ...timed } ),
		kind: 'protect', protected: entity } );

}

export function extract( options ) {

	fields( options, [ 'id', 'seconds', 'label', 'reason', 'protected', 'at', 'radius' ], 'objective' );
	const { at, radius = 10, ...protectedOptions } = options;
	check( Number.isFinite( radius ) && radius > 0 && radius <= 100, 'objective.radius', 'must be positive and at most 100 meters' );
	check( typeof at === 'string' || Array.isArray( at ), 'objective.at', 'must be a location alias or coordinates' );
	return Object.freeze( { ...protect( { label: 'Extract the person', reason: 'The protected person escaped.', ...protectedOptions } ),
		kind: 'extract', at: Array.isArray( at ) ? point( at, 'objective.at' ) : at, radius } );

}

function configuration( value, path ) {

	if ( value === null || typeof value === 'string' || typeof value === 'boolean' ) return value;
	if ( typeof value === 'number' ) { check( Number.isFinite( value ), path, 'must be finite' ); return value; }
	if ( Array.isArray( value ) ) {

		check( Array.from( value ).every( ( entry ) => entry !== undefined ), path, 'must be a dense configuration array' );
		return Object.freeze( value.map( ( entry, index ) => configuration( entry, `${path}[${index}]` ) ) );

	}
	check( value !== undefined && typeof value === 'object' && [ Object.prototype, null ].includes( Object.getPrototypeOf( value ) ),
		path, 'must contain only plain configuration data' );
	return Object.freeze( Object.fromEntries( Object.entries( value ).map( ( [ key, entry ] ) => [ key, configuration( entry, `${path}.${key}` ) ] ) ) );

}

export function defineBehavior( definition ) {

	fields( definition, [ 'id', 'create', 'validate' ], 'behavior' );
	check( typeof definition.id === 'string' && ID.test( definition.id ), 'behavior.id', 'must be a lowercase slug' );
	check( typeof definition.create === 'function', 'behavior.create', 'must be a function returning fresh hooks' );
	check( definition.validate === undefined || typeof definition.validate === 'function', 'behavior.validate', 'must be a function' );
	const { id: type, create, validate } = definition;
	return ( options ) => {

		check( typeof options?.id === 'string' && ID.test( options.id ), 'behavior.instance.id', 'must be a lowercase slug' );
		const detached = configuration( options, `behavior.${options.id}.options` );
		validate?.( detached );
		return Object.freeze( { kind: 'behavior', id: options.id, type, options: detached, create } );

	};

}

function behaviorAttachment( value ) {

	fields( value, [ 'kind', 'id', 'type', 'options', 'create' ], 'scenario.behavior' );
	check( value.kind === 'behavior', 'scenario.behavior', 'must be a behavior attachment' );
	return defineBehavior( { id: value.type, create: value.create } )( { ...value.options, id: value.id } );

}

export function defineScenario( options ) {

	fields( options, [ 'id', 'title', 'subtitle', 'brief', 'side', 'city', 'goals', 'tips', 'locations', 'setup', 'objectives', 'behaviors', 'resources', 'commands', 'score', 'menu' ], 'scenario' );
	check( typeof options.id === 'string' && ID.test( options.id ), 'scenario.id', 'must be a lowercase slug' );
	for ( const key of [ 'title', 'subtitle', 'brief' ] ) check( text( options[ key ] ), `scenario.${key}`, 'must be a non-empty string' );
	check( options.side === undefined || options.side === 'police', 'scenario.side', 'this SDK preview supports police scenarios only' );
	check( options.city == null || ( typeof options.city === 'string' && /^[a-z0-9_-]+$/.test( options.city ) ), 'scenario.city', 'must be a map folder name' );
	for ( const key of [ 'goals', 'tips' ] ) check( dense( options[ key ] ?? [], text ), `scenario.${key}`, 'must be a dense array of non-empty strings' );
	check( options.setup === undefined || typeof options.setup === 'function', 'scenario.setup', 'must be a function' );
	check( options.score == null || typeof options.score === 'function', 'scenario.score', 'must be a synchronous scoring function' );
	check( options.menu === undefined || typeof options.menu === 'boolean', 'scenario.menu', 'must be a boolean' );
	const locations = Object.create( null );
	fields( options.locations ?? {}, Object.keys( options.locations ?? {} ), 'scenario.locations' );
	for ( const [ id, reference ] of Object.entries( options.locations ?? {} ) ) {

		check( ID.test( id ), `scenario.locations.${id}`, 'must be a lowercase slug' );
		if ( Array.isArray( reference ) ) locations[ id ] = point( reference, `scenario.locations.${id}` );
		else {

			fields( reference, [ 'kind', 'name' ], `scenario.locations.${id}` );
			check( [ 'place', 'target', 'landmark' ].includes( reference.kind ), `scenario.locations.${id}`, 'must be a place, landmark, target reference or coordinates' );
			locations[ id ] = reference.kind === 'target' ? target( reference.name ) : reference.kind === 'landmark' ? landmark( reference.name ) : place( reference.name );

		}

	}

	check( Array.isArray( options.objectives ) && options.objectives.length === 1 && [ 'survive', 'protect', 'extract', 'hold-building' ].includes( options.objectives[ 0 ]?.kind ),
		'scenario.objectives', 'this SDK preview requires exactly one supported objective' );
	check( dense( options.behaviors ?? [], ( entry ) => entry?.kind === 'behavior' ), 'scenario.behaviors', 'must be a dense array of behavior attachments' );
	const behaviors = ( options.behaviors ?? [] ).map( behaviorAttachment );
	check( new Set( behaviors.map( ( entry ) => entry.id ) ).size === behaviors.length, 'scenario.behaviors', 'instance IDs must be unique' );
	const { kind, ...objective } = options.objectives[ 0 ];
	const resources = resourceDefinitions( options.resources ), commands = commandDefinitions( options.commands, resources );
	return Object.freeze( { kind: 'scenario', sdkVersion: SDK_VERSION, id: options.id, title: options.title,
		subtitle: options.subtitle, brief: options.brief, side: 'police', city: options.city ?? null,
		goals: Object.freeze( [ ...( options.goals ?? [] ) ] ), tips: Object.freeze( [ ...( options.tips ?? [] ) ] ), menu: options.menu ?? true,
		locations: Object.freeze( locations ), setup: options.setup, score: options.score ?? null, behaviors: Object.freeze( behaviors ), resources, commands,
		objectives: Object.freeze( [ kind === 'hold-building' ? holdBuilding( objective ) : kind === 'extract' ? extract( objective ) : kind === 'protect' ? protect( objective ) : survive( objective ) ] ) } );

}

export function normalizeScenario( value ) {

	check( value?.kind === 'scenario' && value.sdkVersion === SDK_VERSION, 'scenario', 'expected an SDK v1 scenario definition' );
	const { kind, sdkVersion, ...options } = value;
	return defineScenario( options );

}