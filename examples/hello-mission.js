// A minimal mission plugin. Serve this file and open the game with ?plugin=<its URL>&m=hello-square
// A plugin is an ES module that imports nothing: it declares the SDK version it targets and default-exports a function
// that receives the SDK and returns a mission class (or an array of them).
export const sdkVersion = 1;

export default ( { Mission, MODE, ORANGE, fmt, squads } ) => class HelloSquare extends Mission {

	static id = 'hello-square';
	static title = 'Hello Square';
	static subtitle = 'The smallest mission that plays';
	static side = 'police';
	static brief = 'Keep <b>Trg republike</b> calm for one minute. Nothing is going to attack you: this mission only shows the shape of a plugin.';
	static goals = [ 'Hold the square for 1:00' ];
	static tips = [ 'Copy this file, change the id, and edit setup() and tick()' ];

	async setup() {

		const W = this.world, [ x, y ] = this.square = W.places[ 'Trg republike' ];
		await W.exits();
		this.focus = this.square;
		this.zoom = 0.5;
		await W.bloc( { kind: 'crowd', label: 'Crowd', at: this.square, n: 300, groupSize: 60, spread: 20, goal: this.square, goalR: 30, mode: MODE.HOLD } );
		await squads( W, [ [ x + 25, y ], [ x - 25, y ] ] );
		await this.bystanders( 200 );

	}

	tick() {

		if ( this.t >= 60 ) this.end( true, 'The square stayed calm.' );

	}

	phase() { return `${fmt( 60 - this.t )} left`; }

	objectives() { return [ { label: 'Hold the square', value: this.t / 60, text: fmt( 60 - this.t ), state: 'ok' } ]; }

	score( win ) { return { stars: win ? 3 : 0, lines: [ [ 'Time held', fmt( this.t ) ] ] }; }

	draw( o ) { this.drawZone( o, ...this.square, 40, ORANGE, 'SQUARE' ); }

};
