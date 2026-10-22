import { MODE } from '../../sim/crowd.js';
import { check } from './definition.js';

export class ScenarioEngine {

	constructor( mission ) {

		this.mission = mission;
		this.queue = Promise.resolve();

	}

	place( name ) { return this.mission.world.places[ name ]; }

	focus( at, zoom ) {

		this.mission.focus = [ ...at ];
		this.mission.zoom = zoom;

	}

	spawn( kind, options, signal ) {

		const work = this.queue.then( () => this.allocate( kind, options, signal ) );
		this.queue = work.catch( () => {} );
		return work;

	}

	async allocate( kind, options, signal ) {

		const world = this.mission.world, crowd = this.mission.crowd;
		signal.throwIfAborted();
		const groupCount = kind === 'squad' ? 1 : Math.ceil( options.people / 60 );
		check( crowd.count + options.people <= crowd.N, 'spawn.people', 'agent capacity exceeded' );
		check( world.groups.length + groupCount <= crowd.G, 'spawn.people', 'group capacity exceeded' );
		const before = world.groups.length;
		try {

			const layer = await world.fieldTo( ...options.at, 30 );
			signal.throwIfAborted();
			const groups = kind === 'squad'
				? [ await world.squad( { label: options.id, at: options.at, n: options.people } ) ]
				: await world.bloc( { kind: 'crowd', label: options.id, at: options.at, n: options.people,
					groupSize: 60, spread: options.spread, layer, mode: MODE.HOLD } );
			signal.throwIfAborted();
			return groups;

		} catch ( error ) {

			this.release( world.groups.slice( before ) );
			throw error;

		}

	}

	readActor( groups, sample ) {

		let alive = 0, sumX = 0, sumY = 0;
		for ( const group of groups ) for ( const member of group.members ) {

			const faction = sample.faction( member );
			if ( faction < 0 || faction > 9.5 ) continue;
			alive ++;
			sumX += sample.x( member ); sumY += sample.y( member );

		}

		return { alive, center: alive ? [ sumX / alive, sumY / alive ] : null };

	}

	release( groups ) {

		const { world, crowd, game } = this.mission;
		for ( const group of groups ) {

			for ( const member of group.members ) crowd.setFaction( member, - 1 );
			group.members = [];
			group.alive = 0;
			if ( group.layer !== undefined ) { world.flow.release( group.layer ); group.layer = undefined; }
			game.selected = game.selected.filter( ( selected ) => selected !== group );

		}

	}

}