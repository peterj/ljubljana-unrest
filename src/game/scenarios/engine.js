import { FACTION, MODE, ROLE, MAX_EDITS } from '../../sim/crowd.js';
import { rand, WATER_JET, World } from '../../sim/world.js';
import { check } from './definition.js';

export class ScenarioEngine {

	constructor( mission ) {

		this.mission = mission;
		this.queue = Promise.resolve();
		this.nextReinforcement = 1;

	}

	place( name ) { return this.mission.world.places[ name ]; }
	landmark( name ) { return this.mission.world.marks[ name ]; }
	walkable( at, radius ) { return this.mission.world.roadSpot( ...at, radius ); }
	notice( text, kind, at ) { this.mission.event( text, kind, at ); }

	target( name ) {

		const target = this.mission.city.targets?.[ name ];
		return target ? { name, position: target.pos, radius: target.radius, footprints: target.poly.map( ( polygon ) => polygon[ 0 ] ), exits: target.exits } : null;

	}

	snapRoad( at ) { return this.mission.world.patrols.snap( ...at ); }

	focus( at, zoom ) {

		this.mission.focus = [ ...at ];
		this.mission.zoom = zoom;

	}

	readMetrics() {

		const { opinion, counters } = this.mission;
		return Object.freeze( { opinion, counters: Object.freeze( { injuriesByPolice: counters.injByPolice,
			otherInjuries: counters.injOther, officersInjured: counters.injPolice, arrests: counters.arrested,
			sitterArrests: counters.arrestedSitters, peopleGone: counters.gone, gasUsed: counters.gas,
			shotsFired: counters.shot ?? 0 } ) } );

	}

	spawn( kind, options, signal ) {

		const work = this.queue.then( () => this.allocate( kind, options, signal ) );
		this.queue = work.catch( () => {} );
		return work;

	}

	async allocate( kind, options, signal ) {

		const world = this.mission.world, crowd = this.mission.crowd;
		signal.throwIfAborted();
		if ( kind === 'vehicle' ) {

			const at = world.patrols.snap( ...options.at );
			check( at !== null, 'spawn.vehicle.at', 'no drivable road near this position' );
			const water = options.type === 'water-cannon';
			const patrol = options.type === 'police-patrol', crew = patrol ? options.crew : 0;
			check( crowd.count + crew <= crowd.N && world.groups.length + Number( crew > 0 ) <= crowd.G, 'spawn.vehicle.crew', 'crew capacity exceeded' );
			return world.patrols.add( { at, label: options.label ?? options.id, crew, selectable: water || patrol, civil: ! water && ! patrol, water } );

		}
		if ( kind === 'bystanders' ) return this.allocateBystanders( options, signal );
		const groupCount = kind === 'squad' ? 1 : Math.ceil( options.people / options.groupSize );
		check( crowd.count + options.people <= crowd.N, 'spawn.people', 'agent capacity exceeded' );
		check( world.groups.length + groupCount <= crowd.G, 'spawn.people', 'group capacity exceeded' );
		const before = world.groups.length;
		try {

			const layer = await world.fieldTo( ...( options.goal ?? options.at ), options.goal ? options.goalRadius : 30 );
			signal.throwIfAborted();
			const groups = kind === 'squad'
				? [ await world.squad( { label: options.id, at: options.at, n: options.people } ) ]
				: await world.bloc( { kind: 'crowd', label: options.label ?? options.id, at: options.at, n: options.people,
					groupSize: options.groupSize, spread: options.spread, layer, goal: options.goal, goalR: options.goalRadius,
					mode: { hold: MODE.HOLD, march: MODE.MARCH, riot: MODE.RIOT }[ options.mode ], agitation: options.agitation,
					morale: options.morale, bikes: options.bikes, faction: { protester: FACTION.PROTESTER, bystander: FACTION.BYSTANDER, counter: FACTION.COUNTER }[ options.faction ] } );
			signal.throwIfAborted();
			return groups;

		} catch ( error ) {

			this.release( world.groups.slice( before ) );
			throw error;

		}

	}

	async allocateBystanders( options, signal ) {

		const { world, crowd, runtime } = this.mission, before = world.groups.length, groups = [];
		check( crowd.count + options.people <= crowd.N, 'spawn.people', 'agent capacity exceeded' );
		check( world.groups.length + Math.ceil( options.people / options.groupSize ) <= crowd.G, 'spawn.people', 'group capacity exceeded' );
		try {

			const layers = await Promise.all( options.destinations.map( ( at, index ) => world.field( `scenario:${runtime.run}:${options.id}:wander:${index}`,
				at[ 0 ], at[ 1 ], 25 ) ) );
			signal.throwIfAborted();
			const [ minX, minY, maxX, maxY ] = this.mission.city.bounds;
			for ( let offset = 0; offset < options.people; offset += options.groupSize ) {

				signal.throwIfAborted();
				const at = [ rand( minX + 80, maxX - 80 ), rand( minY + 80, maxY - 80 ) ];
				const size = Math.min( options.groupSize, options.people - offset );
				const layer = layers[ Math.floor( Math.random() * layers.length ) ];
				groups.push( ...await world.bloc( { faction: FACTION.BYSTANDER, kind: 'bystanders', label: 'Onlookers', at,
					n: size, groupSize: size, spread: options.spread, layer, speed: [ 0.7, 1.1 ] } ) );

			}
			return groups;

		} catch ( error ) {

			this.release( world.groups.slice( before ) );
			throw error;

		}

	}

	readActor( groups, sample ) {

		if ( groups.isCar ) return { alive: groups.alive, center: [ groups.x, groups.y ] };
		let alive = 0, sumX = 0, sumY = 0;
		for ( const group of groups ) for ( const member of group.members ) {

			const faction = sample.faction( member );
			if ( ! Number.isFinite( faction ) ) return null;
			if ( typeof sample.group === 'function' && sample.group( member ) !== group.id ) return null;
			if ( faction < 0 || faction > 9.5 ) continue;
			const positionX = sample.x( member ), positionY = sample.y( member );
			if ( ! Number.isFinite( positionX ) || ! Number.isFinite( positionY ) ) return null;
			alive ++;
			sumX += positionX; sumY += positionY;

		}

		return { alive, center: alive ? [ sumX / alive, sumY / alive ] : null };

	}

	async prepareMove( groups, request, signal ) {

		signal.throwIfAborted();
		const world = this.mission.world;
		const at = request.line ? [ ( request.line[ 0 ] + request.at[ 0 ] ) / 2, ( request.line[ 1 ] + request.at[ 1 ] ) / 2 ] : request.at;
		const radius = request.line ? Math.min( Math.max( 4, Math.hypot( request.at[ 0 ] - request.line[ 0 ], request.at[ 1 ] - request.line[ 1 ] ) ) / 2, 25 )
			: groups[ 0 ].faction === FACTION.POLICE ? 12 : request.radius;
		const layer = await world.fieldTo( ...at, radius );
		signal.throwIfAborted();
		world.flow.retain( layer );
		return { layer };

	}

	readPeople( groups, sample ) {

		if ( groups.isCar ) return [];
		const people = [];
		for ( const group of groups ) for ( const member of group.members ) {

			const faction = sample.faction( member ), positionX = sample.x( member ), positionY = sample.y( member );
			if ( ! [ faction, positionX, positionY ].every( Number.isFinite ) ) return null;
			const status = faction === FACTION.ARRESTED || faction === FACTION.ARRESTED_SITTER ? 'detained'
				: faction < 0 ? 'gone' : faction > 29.5 ? 'dead' : faction > 9.5 ? 'injured' : 'active';
			people.push( { key: member, backend: Object.freeze( { member, group } ), leader: group.leader === member,
				status, position: [ positionX, positionY ], faction: [ 'protester', 'police', 'bystander', 'counter' ][ faction >= 0 ? Math.floor( faction ) % 10 : group.faction ],
				identified: group.identified === true, agitation: typeof sample.agitation === 'function' ? sample.agitation( member ) : 0,
				membershipMatches: typeof sample.group !== 'function' || sample.group( member ) === group.id } );

		}
		return people;

	}

	promoteLeader( backend, position ) {

		const { group, member } = backend, { crowd } = this.mission;
		check( group.members.includes( member ), 'people.promote', 'person no longer belongs to this group' );
		if ( group.leader === member ) return;
		const previous = group.leader;
		if ( group.members.includes( previous ) ) crowd.regroup( previous, group.id, ROLE.MEMBER );
		crowd.regroup( member, group.id, ROLE.LEADER );
		crowd.setGroup( group.id, { leader: member } );
		group.leader = member; group.leaderState = 'active'; group.leaderPos = [ ...position ]; group.leaderReported = false;

	}

	transferPerson( backend, targets, { promote, sample } ) {

		const source = backend.group, member = backend.member, { world, crowd, game } = this.mission;
		const reject = ( code ) => Object.freeze( { status: 'rejected', code } );
		if ( ! source.members.includes( member ) || ( typeof sample.group === 'function' && sample.group( member ) !== source.id ) ) return reject( 'STALE_MEMBERSHIP' );
		if ( new Set( source.members ).size !== source.members.length ) return reject( 'DUPLICATE_MEMBER' );
		if ( sample.faction( member ) !== source.faction ) return reject( 'PERSON_UNAVAILABLE' );
		const target = targets.find( ( group ) => group !== source && group.faction === source.faction );
		if ( ! target ) return reject( 'INCOMPATIBLE_FACTION' );
		if ( target.members.includes( member ) ) return reject( 'DUPLICATE_MEMBER' );
		const sourceMembers = source.members.filter( ( candidate ) => candidate !== member ), targetMembers = [ ...target.members, member ];
		if ( new Set( sourceMembers ).size !== sourceMembers.length || new Set( targetMembers ).size !== targetMembers.length ) return reject( 'DUPLICATE_MEMBER' );
		const sourceLeader = source.leader === member
			? sourceMembers.find( ( candidate ) => sample.faction( candidate ) === source.faction ) ?? - 1 : source.leader;
		const targetLeader = promote || target.members.length === 0 ? member : target.leader;
		if ( targetLeader !== member && ( ! target.members.includes( targetLeader ) || sample.faction( targetLeader ) !== target.faction ) ) return reject( 'TARGET_LEADER_UNAVAILABLE' );
		const changes = [ [ member, target.id, targetLeader === member ? ROLE.LEADER : ROLE.MEMBER ] ];
		if ( source.leader === member && sourceLeader >= 0 ) changes.push( [ sourceLeader, source.id, ROLE.LEADER ] );
		if ( targetLeader === member && target.members.includes( target.leader ) ) changes.push( [ target.leader, target.id, ROLE.MEMBER ] );
		if ( crowd.pendingEdits.length + changes.length > MAX_EDITS ) return reject( 'EDIT_CAPACITY' );
		const sourcePosition = sourceLeader >= 0 ? [ sample.x( sourceLeader ), sample.y( sourceLeader ) ] : null;
		const targetPosition = [ sample.x( targetLeader ), sample.y( targetLeader ) ];
		const sourceFaction = sourceLeader >= 0 ? sample.faction( sourceLeader ) : - 1;
		if ( ! targetPosition.every( Number.isFinite ) || ( sourcePosition && ( ! sourcePosition.every( Number.isFinite ) || ! Number.isFinite( sourceFaction ) ) ) ) return reject( 'PERSON_UNAVAILABLE' );
		const sourceState = sourceFaction === FACTION.ARRESTED || sourceFaction === FACTION.ARRESTED_SITTER ? 'arrested'
			: sourceFaction < 0 ? 'gone' : sourceFaction > 9.5 ? 'injured' : 'active';
		const sourceOffsets = source.faction === FACTION.POLICE ? World.block( sourceMembers.length ) : null;
		const targetOffsets = target.faction === FACTION.POLICE ? World.block( targetMembers.length ) : null;
		world.uncordon( [ source, target ] );
		source.members = sourceMembers; target.members = targetMembers;
		source.leader = sourceLeader; target.leader = targetLeader;
		source.leaderState = sourceState; source.leaderPos = sourcePosition; source.leaderReported = false;
		target.leaderState = 'active'; target.leaderPos = targetPosition; target.leaderReported = false;
		for ( const change of changes ) crowd.regroup( ...change );
		crowd.setGroup( source.id, { leader: sourceLeader } ); crowd.setGroup( target.id, { leader: targetLeader } );
		if ( sourceOffsets ) crowd.setOffsets( sourceMembers, sourceOffsets );
		if ( targetOffsets ) crowd.setOffsets( targetMembers, targetOffsets );
		source.alive = sourceMembers.filter( ( candidate ) => sample.faction( candidate ) === source.faction ).length;
		target.alive = targetMembers.filter( ( candidate ) => sample.faction( candidate ) === target.faction ).length;
		if ( ! sourceMembers.length ) source.center = null;
		game.selected = game.selected.filter( ( selected ) => selected !== source || source.alive > 0 );
		return Object.freeze( { status: 'completed', backend: Object.freeze( { member, group: target } ) } );

	}

	applyMove( groups, prepared, request, valid ) {

		const world = this.mission.world;
		if ( request.line ) return world.lineSquads( groups, request.line, request.at, world.intel?.pos, undefined, { layer: prepared.layer, valid } );
		if ( groups[ 0 ].faction === FACTION.POLICE ) return world.moveSquads( groups, ...request.at, { layer: prepared.layer, valid } );
		return world.march( groups, ...request.at, request.radius, { layer: prepared.layer, valid } );

	}

	releaseMove( prepared ) { this.mission.world.flow.release( prepared.layer ); }

	stopMove( groups ) {

		const { world, crowd } = this.mission;
		world.uncordon( groups );
		for ( const group of groups ) {

			if ( ! group.center?.every( Number.isFinite ) || ! group.members.length ) continue;
			group.goal = [ ...group.center ];
			if ( group.faction === FACTION.POLICE ) {

				group.anchor = [ ...group.center ];
				group.mode = MODE.FORMATION;
				crowd.setOffsets( group.members, World.block( group.members.length ) );
				crowd.setGroup( group.id, { mode: MODE.FORMATION, ax: group.center[ 0 ], ay: group.center[ 1 ], scale: 1 } );

			} else world.setMode( [ group ], MODE.HOLD );

		}

	}

	release( groups ) {

		const { world, crowd, game } = this.mission;
		if ( groups.isCar ) {

			this.stopVehicle( groups );
			if ( groups.crew ) this.release( [ groups.crew ] );
			world.patrols.cars = world.patrols.cars.filter( ( car ) => car !== groups );
			world.patrols.group.remove( groups.mesh );
			const resources = new Set();
			groups.mesh.traverse( ( object ) => {

				if ( object.geometry ) resources.add( object.geometry );
				for ( const material of Array.isArray( object.material ) ? object.material : object.material ? [ object.material ] : [] ) resources.add( material );

			} );
			for ( const resource of resources ) resource.dispose();
			game.selected = game.selected.filter( ( selected ) => selected !== groups );
			return;

		}
		for ( const group of groups ) {

			for ( const member of group.members ) crowd.setFaction( member, - 1 );
			group.members = [];
			group.alive = 0;
			if ( group.layer !== undefined ) { world.flow.release( group.layer ); group.layer = undefined; }
			game.selected = game.selected.filter( ( selected ) => selected !== group );

		}

	}

	readVehicle( car ) { return { position: [ car.x, car.y ], speed: car.speed, moving: car.path !== null }; }

	driveVehicle( car, at ) {

		const patrols = this.mission.world.patrols;
		const destination = patrols.snap( ...at );
		if ( ! destination || ! patrols.driveTo( car, ...destination ) ) return { status: 'rejected', code: 'NO_ROUTE' };
		return { status: 'completed', destination };

	}

	stopVehicle( car ) { car.path = null; car.speed = 0; }

	toggleCrewVehicle( car ) {

		if ( ! car.crew ) return { status: 'rejected', code: 'NO_CREW' };
		if ( car.path ) return { status: 'rejected', code: 'VEHICLE_MOVING' };
		this.mission.world.patrols.toggleCrew( [ car ] );
		return { status: 'completed' };

	}

	prepareBoarding( backends, sample ) {

		const { crowd } = this.mission;
		const unique = [ ...new Map( backends.map( ( backend ) => [ backend.member, backend ] ) ).values() ];
		const members = [], groups = new Map();
		for ( const backend of unique ) {

			const { member, group } = backend, faction = sample.faction( member );
			if ( ! group.members.includes( member ) || sample.group( member ) !== group.id ) return { status: 'rejected', code: 'STALE_MEMBERSHIP' };
			if ( ! Number.isFinite( faction ) || faction < 0 || faction > 29.5 ) return { status: 'rejected', code: 'PERSON_UNAVAILABLE' };
			if ( crowd.pendingEdits.some( ( edit ) => group.members.includes( edit[ 0 ] ) && [ 1, 2, 4, 6 ].includes( edit[ 1 ] ) ) ) return { status: 'rejected', code: 'PERSON_PENDING' };
			members.push( { ...backend, faction } );
			if ( ! groups.has( group.id ) ) groups.set( group.id, { group, leader: group.leader, leaderState: group.leaderState, leaderPos: group.leaderPos,
				replacement: group.members.find( ( candidate ) => ! unique.some( ( entry ) => entry.member === candidate ) && sample.faction( candidate ) === group.faction ) ?? - 1 } );

		}
		if ( crowd.pendingEdits.length + members.length + groups.size * 2 > MAX_EDITS ) return { status: 'rejected', code: 'EDIT_CAPACITY' };
		return { status: 'completed', members, groups: [ ...groups.values() ], edits: [] };

	}

	commitBoarding( plan ) {

		const { crowd } = this.mission;
		for ( const entry of plan.members ) {

			crowd.compareFaction( entry.member, entry.faction, - 1, entry.group.id );
			plan.edits.push( crowd.pendingEdits.at( - 1 ) );

		}
		for ( const entry of plan.groups ) {

			if ( ! plan.members.some( ( member ) => member.member === entry.leader ) ) continue;
			entry.group.leader = entry.replacement;
			entry.group.leaderState = entry.replacement >= 0 ? 'active' : 'gone';
			crowd.setGroup( entry.group.id, { leader: entry.replacement } );
			if ( entry.replacement >= 0 ) {

				crowd.regroup( entry.replacement, entry.group.id, ROLE.LEADER );
				plan.edits.push( crowd.pendingEdits.at( - 1 ) );

			}

		}

	}

	boardingConfirmed( plan, sample ) { return plan.members.every( ( entry ) => sample.faction( entry.member ) === - 1 && sample.group( entry.member ) === entry.group.id ); }
	boardingRestored( plan, sample ) { return plan.members.every( ( entry ) => Number.isFinite( sample.faction( entry.member ) ) && sample.faction( entry.member ) !== - 1 ); }

	abandonBoarding( plan ) {

		const owned = new Set( plan.edits );
		const pending = this.mission.crowd.pendingEdits;
		for ( let index = pending.length - 1; index >= 0; index -- ) if ( owned.has( pending[ index ] ) ) pending.splice( index, 1 );
		plan.edits = [];

	}

	commandEligible( id, groups ) {

		return id !== 'shield-push' || groups.some( ( group ) => group.cordon );

	}

	async prepareCommand( request, selected, signal ) {

		const { world, crowd, runtime } = this.mission;
		signal.throwIfAborted();
		if ( request.id === 'gas' || request.id === 'shield-push' ) return {};
		let actor = null, groups = selected.flat();
		if ( request.id === 'water' ) {

			const truck = groups[ 0 ];
			if ( ! truck?.water ) return { status: 'rejected', code: 'INVALID_SELECTION' };
			if ( truck.sprayUntil > this.mission.t ) return { status: 'rejected', code: 'WATER_BUSY' };
			return { truck, applied: false };

		}
		if ( request.id === 'crew' ) {

			const truck = groups[ 0 ];
			if ( ! truck?.crew ) return { status: 'rejected', code: 'NO_CREW' };
			if ( truck.path ) return { status: 'rejected', code: 'VEHICLE_MOVING' };
			return { truck, applied: false };

		}
		if ( request.id === 'snatch' ) {

			if ( ! request.target ) return { status: 'rejected', code: 'TARGET_NOT_FOUND' };
			let layer;
			try {

				layer = await world.fieldTo( ...request.target.position, 5 );
				signal.throwIfAborted(); world.flow.retain( layer );
				return { layer, groups, target: request.target, applied: false };

			} catch ( error ) {

				if ( layer !== undefined ) world.flow.release( layer );
				throw error;

			}

		}
		if ( request.id === 'reinforce' ) {

			const pending = [ ...runtime.actors.values() ].filter( ( record ) => record.backend === null );
			if ( crowd.count + pending.reduce( ( count, record ) => count + record.requestedPeople, 0 ) + 30 > crowd.N
				|| world.groups.length + pending.reduce( ( count, record ) => count + record.requestedGroups, 0 ) + 1 > crowd.G ) return { status: 'rejected', code: 'CAPACITY' };
			const stations = this.mission.city.landmarks.filter( ( entry ) => entry.kind === 'police' && entry.name !== 'Policija' );
			stations.sort( ( first, second ) => Math.hypot( first.pos[ 0 ] - request.at[ 0 ], first.pos[ 1 ] - request.at[ 1 ] )
				- Math.hypot( second.pos[ 0 ] - request.at[ 0 ], second.pos[ 1 ] - request.at[ 1 ] ) );
			if ( ! stations.length ) return { status: 'rejected', code: 'NO_STATION' };
			let id;
			do { id = `reinforcement-${this.nextReinforcement ++}`; } while ( runtime.actors.has( id ) );
			const spawn = runtime.spawn( 'squad', { id, at: stations[ 0 ].pos, people: 30 } );
			const abort = () => spawn.cancel( 'command cancelled' );
			signal.addEventListener( 'abort', abort, { once: true } );
			let outcome;
			try { outcome = await spawn.settled; }
			finally { signal.removeEventListener( 'abort', abort ); }
			if ( outcome.status !== 'completed' ) return { status: 'rejected', code: 'CAPACITY' };
			actor = outcome.value; groups = runtime.actors.get( actor.id ).backend;
			for ( const group of groups ) group.label = 'Reinforcements';

		}
		let layer;
		try {

			signal.throwIfAborted();
			const radius = request.id === 'kettle' ? Math.max( 14, Math.sqrt( groups.reduce( ( count, group ) => count + group.members.length, 0 ) ) * 2.6 ) : null;
			layer = await world.fieldTo( ...request.at, request.id === 'kettle' ? radius + 10 : request.id === 'charge' ? 6 : request.id === 'arrest' ? 5 : 12 );
			signal.throwIfAborted(); world.flow.retain( layer );
			return { layer, radius, actor, groups, applied: false };

		} catch ( error ) {

			if ( actor ) runtime.removeActor( actor );
			throw error;

		}

	}

	applyCommand( request, selected, prepared, current ) {

		const { world, runtime, game } = this.mission;
		if ( ! current() ) return { status: 'rejected', code: 'SUPERSEDED' };
		const groups = prepared.groups ?? selected.flat();
		let affected = groups;
		if ( ! [ 'gas', 'reinforce', 'water', 'crew' ].includes( request.id ) && groups.some( ( group ) => ! group.members.some( ( member ) => world.intel?.faction( member ) === FACTION.POLICE ) ) ) return { status: 'rejected', code: 'INVALID_SELECTION' };
		let work;
		let crewHandle = null;
		if ( request.id === 'gas' ) { world.gas( ...request.at ); affected = []; }
		else if ( request.id === 'crew' ) {

			const vehicle = runtime.transport.record( request.selection[ 0 ] ), toggled = runtime.transport.toggleCrew( null,
				request.selection[ 0 ], { expectedRevision: vehicle.revision } );
			if ( toggled.status !== 'completed' ) return toggled;
			crewHandle = vehicle.actor.crewHandle;
			affected = [];

		}
		else if ( request.id === 'water' ) {

			const truck = prepared.truck;
			if ( ! truck?.water || truck.sprayUntil > this.mission.t ) return { status: 'rejected', code: truck?.water ? 'WATER_BUSY' : 'INVALID_SELECTION' };
			world.spray( truck, Math.atan2( request.at[ 1 ] - truck.y, request.at[ 0 ] - truck.x ) );
			truck.sprayUntil = this.mission.t + WATER_JET;
			affected = [];

		}
		else if ( request.id === 'snatch' ) {

			const person = runtime.identity.personRecord( prepared.target.person );
			if ( person.actor !== prepared.target.actor || person.sample?.status !== 'active' || ! person.sample.leader || ! person.sample.identified ) return { status: 'rejected', code: 'TARGET_UNAVAILABLE' };
			const targetGroup = person.backend.group;
			for ( const group of groups ) group.snatch = targetGroup;
			work = world.arrest( groups, ...prepared.target.position, 5, prepared.target.position, { layer: prepared.layer, valid: current } );
		}
		else if ( request.id === 'shield-push' ) {

			const lines = [ ...new Set( groups.filter( ( group ) => group.cordon ).map( ( group ) => group.cordon ) ) ];
			if ( lines.some( ( line ) => line.squads.some( ( group ) => ! groups.includes( group ) ) ) ) return { status: 'rejected', code: 'SELECT_ENTIRE_CORDON' };
			const line = world.shieldPush( groups, ...request.at );
			if ( ! line ) return { status: 'rejected', code: 'INVALID_PUSH' };
			affected = line.squads;

		} else if ( request.id === 'charge' ) work = world.charge( groups, ...request.at, { layer: prepared.layer, valid: current } );
		else if ( request.id === 'arrest' ) work = world.arrest( groups, ...request.at, 5, null, { layer: prepared.layer, valid: current } );
		else if ( request.id === 'kettle' ) work = world.kettle( groups, ...request.at, prepared.radius, world.intel.pos, { layer: prepared.layer, valid: current } );
		else if ( request.id === 'reinforce' ) work = world.moveSquads( groups, ...request.at, { layer: prepared.layer, valid: current } );
		if ( work ) work.catch( ( error ) => runtime.fail( error ) );
		prepared.applied = true;
		if ( game?.sound ) {

			if ( request.id === 'reinforce' ) game.sound.reinforce( groups[ 0 ].anchor );
			else if ( request.source !== 'player' ) game.sound.order( { gas: 'g', charge: 'c', arrest: 'a', snatch: 'x', kettle: 'k', 'shield-push': 's' }[ request.id ], request.at );

		}
		const handles = [ ...runtime.actors.values() ].filter( ( record ) => record.backend === prepared.truck
			|| ( Array.isArray( record.backend ) && record.backend.some( ( group ) => affected.includes( group ) ) ) ).map( ( record ) => record.handle );
		if ( crewHandle ) handles.push( crewHandle );
		return { status: 'completed', value: { affected: Object.freeze( handles ), ...( prepared.target ? { target: prepared.target.person } : {} ), ...( prepared.actor ? { actor: prepared.actor } : {} ) } };

	}

	releaseCommand( prepared ) {

		if ( prepared.layer !== undefined ) this.mission.world.flow.release( prepared.layer );
		if ( prepared.actor && ! prepared.applied ) this.mission.runtime.removeActor( prepared.actor );

	}

	rollbackBoarding( plan, discarded = [] ) {

		const { crowd } = this.mission;
		this.abandonBoarding( plan );
		const ignored = new Set( discarded.map( ( backend ) => backend.member ) );
		for ( const entry of plan.members ) if ( ! ignored.has( entry.member ) ) {

			crowd.compareFaction( entry.member, - 1, entry.faction, entry.group.id );
			plan.edits.push( crowd.pendingEdits.at( - 1 ) );

		}
		for ( const entry of plan.groups ) {

			if ( ! plan.members.some( ( member ) => member.member === entry.leader ) ) continue;
			if ( plan.members.filter( ( member ) => member.group === entry.group ).every( ( member ) => ignored.has( member.member ) ) ) continue;
			if ( entry.group.leader !== entry.replacement && entry.group.leader !== entry.leader ) {

				crowd.regroup( entry.leader, entry.group.id, ROLE.MEMBER );
				plan.edits.push( crowd.pendingEdits.at( - 1 ) );
				continue;

			}
			entry.group.leader = entry.leader; entry.group.leaderState = entry.leaderState; entry.group.leaderPos = entry.leaderPos;
			crowd.setGroup( entry.group.id, { leader: entry.leader } );
			if ( entry.replacement >= 0 ) {

				crowd.regroup( entry.replacement, entry.group.id, ROLE.MEMBER );
				plan.edits.push( crowd.pendingEdits.at( - 1 ) );

			}
			if ( entry.leader >= 0 ) {

				crowd.regroup( entry.leader, entry.group.id, ROLE.LEADER );
				plan.edits.push( crowd.pendingEdits.at( - 1 ) );

			}

		}

	}

}