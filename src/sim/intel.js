// One readback of the crowd (World.refreshIntel): flat arrays with 2 floats (pos) and 4 floats (st) per agent.
// Read agents through the accessors so the layout stays an implementation detail.
export class Intel {

	constructor( pos, st ) {

		this.pos = pos; // x, y
		this.st = st; // faction code, group id, agitation, health
		this.t = performance.now();

	}

	// a FACTION; +10 injured by police, +20 injured by anyone else, +30 killed; negative: arrested, gone (see crowd.js)
	faction( i ) { return this.st[ i * 4 ]; }
	group( i ) { return this.st[ i * 4 + 1 ]; } // index into world.groups
	agitation( i ) { return this.st[ i * 4 + 2 ]; }
	x( i ) { return this.pos[ i * 2 ]; }
	y( i ) { return this.pos[ i * 2 + 1 ]; }

}
