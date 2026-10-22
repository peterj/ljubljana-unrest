import { Mission } from '../mission.ts';
import { normalizeScenario } from './definition.ts';
import { ScenarioEngine } from './engine.ts';
import { ScenarioRuntime, formatTime } from './runtime.ts';

export function scenarioMission( value ) {

	const definition = normalizeScenario( value );
	return class ScenarioMission extends Mission {

		declare runtime: ScenarioRuntime;
		declare leave: any;
		declare started: Promise<void>;

		static id = definition.id;
		static title = definition.title;
		static subtitle = definition.subtitle;
		static brief = definition.brief;
		static side = definition.side;
		static city = definition.city;
		static goals = definition.goals;
		static tips = definition.tips;
		static menu = definition.menu;
		static sdkScenario = true;

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

		executeCommand( id, x, y, source = 'player' ) {

			if ( ! [ 'running', 'paused' ].includes( this.runtime.state ) ) return;
			const command = this.runtime.commands.list().find( ( entry ) => entry.id === id );
			const operation = this.runtime.commands.execute( null, id, { at: [ x, y ],
				selection: command.needsSelection ? this.selectionHandles( command.forCars ? this.game.cars : this.game.squads, command.forCars ? 'vehicle' : 'squad' ) : [] }, source );
			operation.settled.then( ( outcome: any ) => {

				this.escalation = this.runtime.commands.escalation;
				if ( outcome.status === 'completed' && id === 'gas' ) { this.counters.gas ++; this.nudgeOpinion( this.gasOpinion ?? - 2, 'tear gas' ); }
				if ( outcome.status === 'completed' && id === 'water' ) this.nudgeOpinion( this.waterOpinion ?? - 2, 'water cannon' );
				if ( outcome.status === 'rejected' ) this.event( `${command.label}: ${outcome.code.toLowerCase().replaceAll( '_', ' ' )}`, 'warn', [ x, y ] );

			} );
			return operation;

		}

		onCommandBlocked( key ) {

			const command = this.runtime.commands.list().find( ( entry ) => entry.key === key );
			if ( command && ! command.danger ) return this.executeCommand( command.id, this.game.mouse.x, this.game.mouse.y );

		}

		openFire() {

			return this.executeCommand( 'firearms', this.game.mouse.x, this.game.mouse.y, 'confirmed-player' );

		}

		onSnatchOutcome( group, target, result ) {

			const event = this.runtime.adapter.snatchOutcome( group, target, result );
			if ( event ) this.runtime.event( event.type, event );

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
			const rawSelection = action.units ?? this.game.selected;
			const selection = [ ...this.selectionHandles( rawSelection ), ...this.selectionHandles( rawSelection, 'vehicle' ) ];
			const safe: Record<string, any> = { type: action.type, selection: Object.freeze( selection ) };
			for ( const key of [ 'how', 'key', 'paused', 'speed', 'muted' ] ) if ( action[ key ] !== undefined ) safe[ key ] = action[ key ];
			for ( const key of [ 'at', 'a' ] ) if ( action[ key ] ) safe[ key === 'a' ? 'line' : key ] = Object.freeze( [ ...action[ key ] ] );
			if ( action.car ) {

				const vehicle = [ ...this.runtime.actors.values() ].find( ( record ) => record.handle.kind === 'vehicle' && record.backend === action.car );
				if ( vehicle ) safe.vehicle = vehicle.handle;

			}
			this.runtime.playerAction( Object.freeze( safe ) );

		}

		commands() {

			return [ { key: 'rmb', label: 'Move', hint: 'right-click', needsSel: true },
				{ key: 'l', label: 'Cordon line', needsSel: true, run: () => this.game.drawLine() },
				...this.runtime.commands.list().map( ( command ) => ( { key: command.key, label: command.label,
					needsSel: command.needsSelection, resource: command.resource, forCars: command.forCars, forCordon: command.id === 'shield-push', aim: command.aim,
					danger: command.danger,
					desc: command.id === 'reinforce' ? 'Dispatch a fresh squad from the nearest police station to this point'
						: command.id === 'gas' ? 'Deploy a tear gas cloud at this point' : undefined,
					run: command.id === 'firearms' ? () => this.game.confirmFirearms()
						: command.immediate ? () => this.executeCommand( command.id, this.game.mouse.x, this.game.mouse.y )
						: ( x, y ) => this.executeCommand( command.id, x, y ),
				} ) ),
			];

		}

		phase() { return this.runtime.phase(); }
		objectives() { return this.runtime.objectives(); }

		draw( overlay ) {

			if ( definition.objectives[ 0 ].kind === 'hold-building' && this.runtime.buildingState ) {

				const objective = definition.objectives[ 0 ], state = this.runtime.buildingState;
				const target = this.runtime.spatial.prepareBuilding( objective.target, objective.exitAt );
				this.drawZone( overlay, ...( target.position as [ number, number ] ), target.radius + 10, state.breach > 0.3 ? 'rgb(255,45,85)' : 'rgb(255,176,32)', target.name, 0.05 + state.breach * 0.2 );
				target.exits.forEach( ( at, index ) => this.drawZone( overlay, ...( at as [ number, number ] ), 12, state.blocked[ index ] ? 'rgb(255,45,85)' : 'rgb(233,228,216)', `EXIT ${index + 1}` ) );

			}
			for ( const entity of this.runtime.identity.snapshots ) {

				if ( ! entity.position ) continue;
				const danger = [ 'dropped', 'down', 'captured', 'dead' ].includes( entity.state );
				const label = entity.handle.kind === 'protected-person' ? `${entity.label} · ${entity.state.toUpperCase()}` : entity.label;
				this.drawZone( overlay, ...( entity.position as [ number, number ] ), 5, danger ? 'rgb(255,45,85)' : 'rgb(255,176,32)', label );

			}

		}

	};

}