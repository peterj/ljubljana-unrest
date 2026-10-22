import { Mission } from '../mission.js';
import { normalizeScenario } from './definition.js';
import { ScenarioEngine } from './engine.js';
import { ScenarioRuntime, formatTime } from './runtime.js';

export function scenarioMission( value ) {

	const definition = normalizeScenario( value );
	return class ScenarioMission extends Mission {

		static id = definition.id;
		static title = definition.title;
		static subtitle = definition.subtitle;
		static brief = definition.brief;
		static side = definition.side;
		static city = definition.city;
		static goals = definition.goals;
		static tips = definition.tips;
		static menu = definition.menu;

		constructor( game ) {

			super( game );
			this.runtime = new ScenarioRuntime( definition, new ScenarioEngine( this ), {
				onFinish: ( result ) => { this.result = result; game.finish( result ); },
				onFailure: ( error ) => {

					game.paused = true;
					console.error( `Scenario ${definition.id}:`, error );
					game.hud.modal( '' );
					const panel = document.createElement( 'div' );
					panel.className = 'card';
					const title = document.createElement( 'h1' ), message = document.createElement( 'p' ), button = document.createElement( 'button' );
					title.textContent = 'Scenario failed';
					message.textContent = error.message;
					button.textContent = 'Back to missions';
					button.onclick = () => game.toMenu();
					panel.append( title, message, button );
					const modal = game.hud.modal( '' );
					modal.appendChild( panel );
					modal.hidden = false;

				},
			} );
			const runtime = this.runtime;
			this.resources = Object.fromEntries( Object.keys( definition.resources ).map( ( id ) => [ id, Object.freeze( {
				max: definition.resources[ id ].capacity,
				get left() { return runtime.resources.get( id ).available; },
				get ready() { return runtime.resources.get( id ).readyIn; },
			} ) ] ) );
			this.leave = () => this.runtime.dispose();
			window.addEventListener( 'pagehide', this.leave, { once: true } );

		}

		async setup() {

			await this.world.exits();
			await this.runtime.setup();

		}

		start() {

			this.runtime.observe( this.world.intel );
			this.game.paused = true;
			this.started = this.runtime.start();
			this.started.then( () => {

				if ( this.runtime.state === 'running' ) this.game.paused = false;

			}, () => {} );

		}

		observationStamp() { return { sampledAt: this.runtime.time, step: this.runtime.step }; }

		onObservation( sample, stamp ) {

			try { this.runtime.observe( sample, stamp ); } catch ( error ) { this.runtime.fail( error ); }

		}

		onPlayerMovement( action ) {

			if ( ! [ 'running', 'paused' ].includes( this.runtime.state ) ) return true;
			try {

				for ( const handle of this.selectionHandles( action.units ) ) this.runtime.playerMove( handle, action.at, action.type === 'line' ? { line: action.a } : {} );

			} catch ( error ) { this.runtime.fail( error ); }
			return true;

		}

		onPlayerVehicleDrive( action ) {

			if ( ! [ 'running', 'paused' ].includes( this.runtime.state ) ) return true;
			const record = [ ...this.runtime.actors.values() ].find( ( actor ) => actor.backend === action.vehicle );
			if ( ! record ) return false;
			try {

				const vehicle = this.runtime.context.vehicles.get( record.handle );
				const result = this.runtime.transport.drive( null, record.handle, action.at, { expectedRevision: vehicle.revision } );
				if ( result.status === 'rejected' ) this.event( `${action.vehicle.label}: ${result.code.toLowerCase().replaceAll( '_', ' ' )}`, 'warn', action.at );

			} catch ( error ) { this.runtime.fail( error ); }
			return true;

		}

		selectionHandles( groups, kind = 'squad' ) {

			return [ ...this.runtime.actors.values() ].filter( ( record ) => record.handle.kind === kind && ( kind === 'vehicle'
				? groups.includes( record.backend ) : Array.isArray( record.backend ) && record.backend.some( ( group ) => groups.includes( group ) ) ) ).map( ( record ) => record.handle );

		}

		executeCommand( id, x, y ) {

			if ( ! [ 'running', 'paused' ].includes( this.runtime.state ) ) return;
			const command = this.runtime.commands.list().find( ( entry ) => entry.id === id );
			const operation = this.runtime.commands.execute( null, id, { at: [ x, y ],
				selection: command.needsSelection ? this.selectionHandles( command.forCars ? this.game.cars : this.game.squads, command.forCars ? 'vehicle' : 'squad' ) : [] }, 'player' );
			operation.settled.then( ( outcome ) => {

				this.escalation = this.runtime.commands.escalation;
				if ( outcome.status === 'completed' && id === 'gas' ) { this.counters.gas ++; this.nudgeOpinion( this.gasOpinion ?? - 2, 'tear gas' ); }
				if ( outcome.status === 'completed' && id === 'water' ) this.nudgeOpinion( this.waterOpinion ?? - 2, 'water cannon' );
				if ( outcome.status === 'rejected' ) this.event( `${command.label}: ${outcome.code.toLowerCase().replaceAll( '_', ' ' )}`, 'warn', [ x, y ] );

			} );
			return operation;

		}

		onCommandBlocked( key ) {

			const command = this.runtime.commands.list().find( ( entry ) => entry.key === key );
			if ( command ) return this.executeCommand( command.id, this.game.mouse.x, this.game.mouse.y );

		}

		update( dt, stats ) {

			this.stats = stats;
			try {

				if ( stats ) this._trackOpinion( stats );
				this.runtime.pause( false );
				this.runtime.update( dt );
				this.t = this.runtime.time;
				this.escalation = this.runtime.commands.escalation;

			} catch ( error ) { this.runtime.fail( error ); }

		}

		onAction( action ) {

			if ( action.type === 'pause' ) this.runtime.pause( action.paused );

		}

		commands() {

			return [ { key: 'rmb', label: 'Move', hint: 'right-click', needsSel: true },
				{ key: 'l', label: 'Cordon line', needsSel: true, run: () => this.game.drawLine() },
				...this.runtime.commands.list().map( ( command ) => ( { key: command.key, label: command.label,
					needsSel: command.needsSelection, resource: command.resource, forCars: command.forCars, forCordon: command.id === 'shield-push', aim: command.aim,
					desc: command.id === 'reinforce' ? 'Dispatch a fresh squad from the nearest police station to this point'
						: command.id === 'gas' ? 'Deploy a tear gas cloud at this point' : undefined,
					run: command.immediate ? () => this.executeCommand( command.id, this.game.mouse.x, this.game.mouse.y )
						: ( x, y ) => this.executeCommand( command.id, x, y ),
				} ) ),
			];

		}

		phase() { return `${formatTime( definition.objectives[ 0 ].seconds - this.runtime.time )} left`; }
		objectives() { return this.runtime.objectives(); }

		draw( overlay ) {

			if ( definition.objectives[ 0 ].kind === 'hold-building' && this.runtime.buildingState ) {

				const objective = definition.objectives[ 0 ], state = this.runtime.buildingState;
				const target = this.runtime.spatial.prepareBuilding( objective.target, objective.exitAt );
				this.drawZone( overlay, ...target.position, target.radius + 10, state.breach > 0.3 ? 'rgb(255,45,85)' : 'rgb(255,176,32)', target.name, 0.05 + state.breach * 0.2 );
				target.exits.forEach( ( at, index ) => this.drawZone( overlay, ...at, 12, state.blocked[ index ] ? 'rgb(255,45,85)' : 'rgb(233,228,216)', `EXIT ${index + 1}` ) );

			}
			for ( const entity of this.runtime.identity.snapshots ) {

				if ( ! entity.position ) continue;
				const danger = [ 'dropped', 'down', 'captured', 'dead' ].includes( entity.state );
				const label = entity.handle.kind === 'protected-person' ? `${entity.label} · ${entity.state.toUpperCase()}` : entity.label;
				this.drawZone( overlay, ...entity.position, 5, danger ? 'rgb(255,45,85)' : 'rgb(255,176,32)', label );

			}

		}

	};

}