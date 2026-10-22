import { Mission, FACTION, MODE, fmt, near, squads, cars, BLUE, ORANGE, LIME, WHITE } from '../sdk/index.js';

// ======================================================================================= TUTORIAL
// One step at a time on Trg republike: each step says what to do, unlocks the orders it needs, and waits for the
// player to do it (Game.emit → onAction, or polled in tick). It ends with a short test: hold the Assembly's side door,
// which sits on a narrow street, against groups coming from both ends.
const CHAPTERS = [ 'Camera', 'Selection', 'Movement', 'Time', 'The crowd', 'Calm tools', 'Force', 'Vehicles', 'Final test' ];
const FINAL_WAIT = 30, FINAL_HOLD = 210, DOOR_R = 9;

export class TutorialMission extends Mission {

	static id = 'tutorial';
	static title = 'Training';
	static subtitle = 'Learn the controls step by step on Trg republike';
	static side = 'police';
	static tutorial = true;
	static brief = `A quiet evening on <b>Trg republike</b>. Two squads, a patrol car and a water cannon are yours to practise with.
		A card at the top of the screen tells you what to do next; each step unlocks the orders it needs. It ends with a short test in front of the National Assembly.`;
	static goals = [ 'Follow the steps on the card at the top', 'Final test: hold the Assembly side door for 3:30' ];
	static tips = [ 'Every step can be skipped', 'Space pauses at any time; orders still work while paused', 'Hover an order in the panel to see what it does' ];

	async setup() {

		const W = this.world, T = W.places[ 'Trg republike' ];
		const road = ( x, y ) => W.roadSpot( x, y ) ?? [ x, y ];
		await W.exits();
		this.focus = T;
		this.zoom = 0.45;
		this.resources = { gas: { left: 3, max: 3 }, water: { left: 3, max: 3 }, reinforce: { left: 2, max: 2 } };
		this.waterOpinion = - 2;
		this.unlocked = new Set();
		[ this.A, this.B ] = await squads( W, [ road( T[ 0 ] - 10, T[ 1 ] + 38 ), road( T[ 0 ] + 15, T[ 1 ] - 5 ) ] );
		[ this.car ] = await cars( W, [ [ T[ 0 ] - 20, T[ 1 ] + 40 ] ] );
		this.truck = await W.patrols.add( { at: [ T[ 0 ] + 30, T[ 1 ] - 30 ], water: true } );
		this.marker = road( T[ 0 ] - 20, T[ 1 ] - 20 );
		this.demoAt = W.spot( T[ 0 ] - 30, T[ 1 ] - 25, 10 );
		this.door = [ - 346.6, - 1.8 ]; // the Assembly's east exit, on a street a few metres wide
		this.northAt = road( - 323, 72 );
		this.waveAt = road( - 268, - 60 ); // Slovenska
		this.steps = this.script();
		this.k = - 1;
		await this.bystanders( 300 );

	}

	start() { this.next(); }

	// ---------------------------------------------------------------- the steps
	script() {

		const g = this.game, sel = () => g.selected;
		const at = ( q, label, color = BLUE ) => () => q.center ? [ { at: q.center, r: 14, label, color } ] : [];
		const count = ( type, n ) => ( a ) => a.type === type && ++ this.n >= n;
		const order = ( key ) => ( a ) => a.type === 'order' && a.key === key;
		const police = () => this.world.groups.filter( ( q ) => q.faction === FACTION.POLICE );
		return [
			// camera
			{ ch: 0, text: 'Drag the map with the left mouse button to look around.', done: count( 'pan', 25 ) },
			{ ch: 0, text: 'Scroll to zoom in and out (pinch on a trackpad).', done: count( 'zoom', 4 ) },
			// selection
			{ ch: 1, enter: () => this.look( this.focus, 0.4 ), text: 'Click <b>Squad 1</b> to select it. What you select shows in the orders panel, bottom right.',
				mark: at( this.A, 'SQUAD 1' ), spot: 'commands', done: () => sel().includes( this.A ) },
			{ ch: 1, text: '<b>Shift-click</b> Squad 2 to add it to the selection.', mark: at( this.B, 'SQUAD 2' ),
				done: () => sel().includes( this.A ) && sel().includes( this.B ) },
			{ ch: 1, text: 'Press <b>Esc</b> to clear the selection.', done: ( a ) => a.type === 'deselect' },
			{ ch: 1, text: 'Hold <b>Shift</b> and drag a box around both squads.', done: ( a ) => a.type === 'select' && a.how === 'box' && sel().includes( this.A ) && sel().includes( this.B ) },
			{ ch: 1, text: 'Press <b>Tab</b> a few times: it jumps to each of your units in turn.', done: ( a ) => a.type === 'select' && a.how === 'tab' && ++ this.n >= 3 },
			// movement
			{ ch: 2, enter: () => this.look( this.focus, 0.4 ), text: 'Select a squad and <b>right-click</b> inside the ring to send it there. No right button? <b>Ctrl-click</b>.',
				mark: () => [ { at: this.marker, r: 12, label: 'MOVE HERE', color: WHITE } ], done: ( a ) => a.type === 'move' && near( a.at, this.marker, 16 ) },
			{ ch: 2, text: 'Select both squads and <b>right-drag</b> across the square: they form a cordon line, 2–3 deep. Lines hold far better than loose blocks.',
				done: ( a ) => a.type === 'line' },
			{ ch: 2, unlock: [ 'l' ], keys: [ 'l' ], text: 'On a trackpad, press <b>L</b> and then drag with the left button. Try it: select a squad, press L, drag a line.',
				done: ( a ) => a.type === 'line' && a.how !== 'right' },
			// time
			{ ch: 3, text: 'Press <b>Space</b> to pause. Orders still work while paused: plan, then resume.', spot: 'pauseBtn', done: ( a ) => a.type === 'pause' && a.paused },
			{ ch: 3, text: 'Press <b>Space</b> again to resume.', spot: 'pauseBtn', done: ( a ) => a.type === 'pause' && ! a.paused },
			{ ch: 3, text: 'Press <b>+</b> to speed up to 2× or 3×, then <b>−</b> back to 1×. <b>N</b> turns the sound on and off.', spot: 'speedBtn',
				done: ( a ) => { if ( a.type !== 'speed' ) return false; if ( a.speed > 1 ) this.n = 1; return this.n === 1 && a.speed === 1; } },
			// the crowd
			{ ch: 4, enter: () => this.ensureDemo(), next: true, text: 'Protesters are gathering on the square, in orange. Each group follows its leader. The brighter the orange, the angrier they are: agitated groups turn to rioting, calm ones stay calm.',
				mark: () => this.demoCenter() ? [ { at: this.demoCenter(), r: 22, label: 'PROTESTERS', color: ORANGE } ] : [] },
			{ ch: 4, next: true, spot: 'opinion', text: 'Top right: <b>public opinion</b>. Injuries, arrests and force lower it. The <b>escalation</b> bar records the hardest force you have used.' },
			{ ch: 4, next: true, spot: 'objectives', text: 'Top left: the <b>objectives</b>. In a mission they show what you must do and how close you are to failing.' },
			{ ch: 4, next: true, spot: 'commands', text: 'Bottom right: your <b>orders</b>. Hover one to see what it does and why it is greyed out. A key fires the order at the <b>mouse cursor</b>; a button waits for your next click on the map.' },
			// calm tools
			{ ch: 5, enter: () => this.ensureDemo(), unlock: [ 'a' ], keys: [ 'a' ], text: 'Select a squad, point at the protesters and press <b>A</b>: officers wade in and arrest people there. Slow, but low force.', done: order( 'a' ) },
			{ ch: 5, enter: () => this.identify(), unlock: [ 'x' ], keys: [ 'x' ], mark: () => this.target?.leaderPos ? [ { at: this.target.leaderPos, r: 6, label: 'LEADER', color: ORANGE } ] : [],
				text: 'CCTV has identified a group leader (ringed); leaders under camera coverage are found automatically. Select a squad, point near the leader and press <b>X</b> to snatch them. A group without its leader loses heart.',
				done: () => ! this.target || this.target.leaderState === 'arrested' || police().some( ( q ) => q.snatch === this.target ) },
			{ ch: 5, unlock: [ 's' ], keys: [ 's' ], text: 'A cordon line can push. Form a line facing the crowd, select it and press <b>S</b>, then hold the left button ahead of the line and release: it advances shields up.',
				done: () => police().some( ( q ) => q.cordon?.push ) },
			{ ch: 5, keys: [ 's' ], text: 'A line can also push at an angle. Press <b>S</b> again and aim off to one side: the dashed line shows where it turns. Release, and it turns to face that way before it advances.',
				done: () => police().some( ( q ) => q.cordon?.push?.turn ) },
			// force
			{ ch: 6, enter: () => this.ensureDemo(), unlock: [ 'k' ], keys: [ 'k' ], text: 'Force. With squads selected, press <b>K</b> over the crowd: they surround it and close in. Watch the escalation bar.', done: order( 'k' ) },
			{ ch: 6, unlock: [ 'c' ], keys: [ 'c' ], spot: 'opinion', text: 'Press <b>C</b> to charge the crowd at the cursor. It works fast, but people get hurt, and every injury lowers public opinion.', done: order( 'c' ) },
			{ ch: 6, enter: () => { this.n = this.resources.gas.left; }, unlock: [ 'g' ], keys: [ 'g' ], text: 'Press <b>G</b> for tear gas at the cursor (no selection needed). It clears a crowd quickly, costs opinion, and the button shows how many you have left.',
				done: () => this.resources.gas.left < this.n },
			// vehicles
			{ ch: 7, enter: () => this.look( [ this.car.x, this.car.y ], 0.4 ), text: 'Click the <b>patrol car</b>, then right-click a street: cars drive by road. One parked across a street is a quick roadblock.',
				mark: () => [ { at: [ this.car.x, this.car.y ], r: 8, label: 'PATROL CAR' } ], done: ( a ) => a.type === 'drive' && ! a.car.water },
			{ ch: 7, unlock: [ 'u' ], keys: [ 'u' ], text: 'Once the car has parked, press <b>U</b> with it selected: the crew gets in or out. Cars also pick up their crew when they drive off.', done: order( 'u' ) },
			{ ch: 7, unlock: [ 'w' ], keys: [ 'w' ], text: 'Click the <b>water cannon</b> and press <b>W</b> to see its reach. Hold the left button to aim, release to spray. Right-click drives it; Esc puts the cannon away.',
				mark: () => [ { at: [ this.truck.x, this.truck.y ], r: 9, label: 'WATER CANNON' } ], done: () => this.truck.sprayUntil > this.t },
			{ ch: 7, unlock: [ 'f' ], keys: [ 'f' ], spot: 'commands', text: 'Out of squads? Press <b>F</b>: a fresh squad leaves the nearest police station for the cursor. Reinforcements are limited.', done: order( 'f' ) },
			// final test
			{ ch: 8, final: true, enter: () => this.startFinal(),
				text: `Final test. In ${fmt( FINAL_WAIT )} radicals set off for the Assembly's <b>side door</b> (ringed) from the north, and a bloc from Slovenska comes up the same street from the south. Cordon the street on both sides of the door and hold for ${fmt( FINAL_HOLD )}. Lines only slow a determined crowd: snatch the leaders (<b>X</b>, CCTV has them) and use gas if the door is giving way. Squads 3 and 4 wait north of the door; bring the others round from Trg republike. Opinion starts again at 60.` },
		];

	}

	commands() { return this.policeCommands().filter( ( c ) => c.key === 'rmb' || this.unlocked.has( c.key ) ); }

	get coachKeys() { return this.steps[ this.k ]?.keys; }

	// ---------------------------------------------------------------- the step runner
	onAction( a ) { this.check( a ); }

	check( a ) {

		const s = this.steps[ this.k ];
		if ( ! s || this.busy || ! s.done?.( a ) ) return;
		this.next();

	}

	async next() {

		if ( this.busy || this.k >= this.steps.length - 1 ) return;
		this.busy = true;
		const s = this.steps[ ++ this.k ];
		this.n = 0;
		for ( const key of s.unlock ?? [] ) this.unlocked.add( key );
		await s.enter?.();
		this.busy = false;
		const total = this.steps.length;
		this.game.hud.coach( { chapter: `${s.ch + 1}. ${CHAPTERS[ s.ch ]}`, text: s.text, step: this.k + 1, total, spot: s.spot,
			next: s.next, onNext: () => this.next(), onSkip: s.next || s.final ? null : () => this.next() } );

	}

	look( at, mpp ) {

		const C = this.game.controls;
		C.center.set( ...at );
		C.mpp = mpp;
		C.update();

	}

	async ensureDemo() {

		if ( this.demo?.some( ( q ) => ( q.alive ?? q.members.length ) > 10 && ! q.home ) ) return;
		this.demo = await this.world.bloc( { kind: 'demo', label: 'Students', at: this.demoAt, n: 240, groupSize: 80, spread: 12,
			goal: this.demoAt, goalR: 18, mode: MODE.HOLD, agitation: [ 0.1, 0.3 ], morale: 0.6 } );

	}

	demoCenter() { return this.demo?.find( ( q ) => q.center && q.alive > 0 )?.center; }

	// the snatch step needs a leader under CCTV: name one if the cameras have not
	async identify() {

		await this.ensureDemo();
		const free = ( q ) => ( q.alive ?? q.members.length ) > 10 && ( ! q.leaderState || q.leaderState === 'active' );
		if ( ! this.demo.some( free ) ) this.demo.push( ...await this.world.bloc( { kind: 'demo', label: 'Students', at: this.demoAt, n: 80, groupSize: 80, spread: 8,
			goal: this.demoAt, goalR: 18, mode: MODE.HOLD, agitation: [ 0.1, 0.3 ], morale: 0.6 } ) );
		this.target = this.demo.find( free );
		this.target.identified = true;

	}

	// ---------------------------------------------------------------- final test
	async startFinal() {

		for ( const c of this.policeCommands() ) if ( c.key !== 'o' ) this.unlocked.add( c.key );
		this.look( [ - 370, - 20 ], 0.45 );
		const W = this.world, road = ( x, y ) => W.roadSpot( x, y ) ?? [ x, y ];
		await W.squad( { kind: 'squad', label: 'Squad 3', at: road( - 338, 30 ) } );
		await W.squad( { kind: 'squad', label: 'Squad 4', at: road( - 333, 46 ) } );
		this.opinion = 60;
		this.injBase = this.counters.injByPolice;
		const F = this.final = { setOff: this.t + FINAL_WAIT, end: this.t + FINAL_WAIT + FINAL_HOLD, breach: 0 };
		this.after( FINAL_WAIT, async () => {

			F.groups = [
				...await W.bloc( { kind: 'wave', label: 'Radicals', at: this.northAt, n: 60, groupSize: 60, spread: 8,
					goal: this.door, goalR: 8, agitation: [ 0.4, 0.65 ], morale: 0.8 } ),
				...await W.bloc( { kind: 'wave', label: 'Bloc', at: this.waveAt, n: 120, groupSize: 60, spread: 15,
					goal: this.door, goalR: 8, agitation: [ 0.2, 0.45 ], morale: 0.7 } ),
			];
			for ( const g of F.groups ) g.identified = true;
			this.event( 'Radicals from the north and a bloc from Slovenska are heading for the side door', 'bad', this.door );

		} );

	}

	tick( dt ) {

		this.check( { type: 'tick' } );
		const F = this.final;
		if ( ! F || this.t < F.setOff ) return;
		const n = this.world.countNear( ...this.door, DOOR_R, FACTION.PROTESTER );
		// as in the defend missions: a few at the door do not count, and a full breach takes at least 40 s
		F.breach = Math.max( 0, Math.min( 1, F.breach + ( n > 20 ? Math.min( 0.025, ( n - 20 ) / 2500 ) : - 0.015 ) * dt ) );
		if ( F.breach > 0.5 && ! this.flags.b50 ) { this.flags.b50 = true; this.event( 'They are at the door!', 'bad', this.door ); }
		if ( F.breach >= 1 ) this.end( false, 'The protesters forced the Assembly side door.' );
		else if ( this.t >= F.end ) this.end( true, 'The door held. Training complete.' );

	}

	end( win, reason ) {

		this.game.hud.coach( null );
		super.end( win, reason );

	}

	// ---------------------------------------------------------------- HUD
	phase() {

		const F = this.final;
		if ( ! F ) return 'Training';
		return this.t < F.setOff ? `They set off in ${fmt( F.setOff - this.t )}` : `Hold for ${fmt( F.end - this.t )}`;

	}

	objectives() {

		const F = this.final;
		if ( F ) {

			const inj = this.counters.injByPolice - this.injBase;
			return [
				{ label: 'Hold the side door', value: 1 - ( F.end - this.t ) / ( FINAL_WAIT + FINAL_HOLD ), text: fmt( F.end - this.t ), state: 'ok' },
				{ label: 'Pressure on the door', value: F.breach, text: `${Math.round( F.breach * 100 )}%`, state: F.breach > 0.6 ? 'bad' : F.breach > 0.2 ? 'warn' : 'ok', invert: true },
				{ label: '★ Public opinion ≥ 50', value: this.opinion / 100, text: `${Math.round( this.opinion )}`, state: this.opinion >= 50 ? 'ok' : 'bad' },
				{ label: '★ Injuries caused by police ≤ 10', value: Math.min( 1, inj / 10 ), text: `${inj}`, state: inj > 10 ? 'bad' : inj > 6 ? 'warn' : 'ok', invert: true },
			];

		}

		const ch = this.steps[ this.k ]?.ch ?? 0, inCh = this.steps.filter( ( s ) => s.ch === ch ), done = Math.max( 0, inCh.indexOf( this.steps[ this.k ] ) );
		return [
			{ label: `Chapter ${ch + 1} of ${CHAPTERS.length}: ${CHAPTERS[ ch ]}`, value: done / inCh.length, text: `${done} / ${inCh.length}`, state: 'ok' },
			{ label: 'Training', value: Math.max( 0, this.k ) / this.steps.length, text: `${Math.round( Math.max( 0, this.k ) / this.steps.length * 100 )}%`, state: 'done' },
		];

	}

	score( win ) {

		const inj = this.counters.injByPolice - ( this.injBase ?? 0 );
		return { stars: win + ( win && this.opinion >= 50 ) + ( win && inj <= 10 ), lines: [
			[ 'Public opinion', Math.round( this.opinion ) ], [ 'Injuries caused by police (final test)', inj ], [ 'Arrests', this.counters.arrested ] ] };

	}

	draw( o ) {

		for ( const m of this.steps[ this.k ]?.mark?.() ?? [] ) this.drawZone( o, ...m.at, m.r, m.color ?? BLUE, m.label, 0.1 );
		const F = this.final;
		if ( ! F ) return;
		this.drawZone( o, ...this.door, DOOR_R, ORANGE, 'SIDE DOOR' );
		if ( this.t < F.setOff ) for ( const at of [ this.northAt, this.waveAt ] ) this.drawZone( o, ...at, 15, LIME, fmt( F.setOff - this.t ) );

	}

}
