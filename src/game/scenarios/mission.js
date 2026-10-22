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
			this.leave = () => this.runtime.dispose();
			window.addEventListener( 'pagehide', this.leave, { once: true } );

		}

		async setup() {

			await this.world.exits();
			await this.runtime.setup();

		}

		start() {

			this.runtime.observe( this.world.intel );
			this.runtime.start();

		}

		update( dt, stats ) {

			this.stats = stats;
			try {

				this.runtime.pause( false );
				this.runtime.observe( this.world.intel );
				this.runtime.update( dt );
				this.t = this.runtime.time;

			} catch ( error ) { this.runtime.fail( error ); }

		}

		onAction( action ) {

			if ( action.type === 'pause' ) this.runtime.pause( action.paused );

		}

		commands() {

			return [ { key: 'rmb', label: 'Move', hint: 'right-click', needsSel: true },
				{ key: 'l', label: 'Cordon line', needsSel: true, run: () => this.game.drawLine() } ];

		}

		phase() { return `${formatTime( definition.objectives[ 0 ].seconds - this.runtime.time )} left`; }
		objectives() { return this.runtime.objectives(); }

	};

}