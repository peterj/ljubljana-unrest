export const sdkVersion = 1;

export default ( { defineScenario, place, survive } ) => defineScenario( {
	id: 'hello-scenario',
	title: 'Hello Square: SDK Preview',
	subtitle: 'A definition-based scenario',
	brief: 'Keep Trg republike calm for one minute.',
	goals: [ 'Hold the square for 1:00' ],
	tips: [ 'Select a squad and right-click to move it' ],
	locations: { square: place( 'Trg republike' ) },
	setup( ctx ) {

		const [ squareX, squareY ] = ctx.locations.get( 'square' );
		ctx.presentation.focus( 'square', 0.5 );
		ctx.spawn.crowd( { id: 'demonstrators', at: 'square', people: 300, spread: 20 } );
		ctx.spawn.squad( { id: 'squad-east', at: [ squareX + 25, squareY ] } );
		ctx.spawn.squad( { id: 'squad-west', at: [ squareX - 25, squareY ] } );

	},
	objectives: [ survive( { id: 'hold', seconds: 60, label: 'Hold the square', reason: 'The square stayed calm.' } ) ],
} );