import { Mission, FACTION, MODE, STAT, fmt, LIME, ORANGE, near, cars, squads } from '../sdk/index.js';

// ======================================================================================= CLASH
// ======================================================================================= CLASH
// The march goes round the north (its shortest way, Wolfova and the north edge of Kongresni trg, runs through the
// counter-protest); the opening cordons seal the short ways out of the square toward that route: [ a, b, squads ].
const CLASH_LEGS = [ [ - 225, 65, 15 ], [ - 314, 100, 15 ], [ - 450, - 80, 30 ] ]; // Čopova → Cankarjeva → Beethovnova / Šubičeva → Trg republike
const CLASH_LINES = [
	[ [ - 80, - 109 ], [ - 89, - 104 ], 3 ], // Wolfova
	[ [ - 59, - 112 ], [ - 64, - 109 ], 1 ], // Hribarjevo nabrežje
	[ [ - 193, - 96 ], [ - 183, - 95 ], 1 ], // Južni trg → Knafljev prehod
	[ [ - 286, - 86 ], [ - 252, - 86 ], 3 ], // Slovenska, north of Šubičeva
	[ [ - 309, - 107 ], [ - 302, - 83 ], 2 ], // Šubičeva
];

export class ClashMission extends Mission {

	static id = 'clash';
	static title = 'Clash';
	static subtitle = 'Keep the march and the counter-protest apart';
	static side = 'police';
	static brief = `A Pride-style march sets off from <b>Prešernov trg</b> to <b>Trg republike</b> by Čopova, Cankarjeva and Beethovnova.
		A counter-protest has gathered on <b>Kongresni trg</b>, between the two, and more are coming. Your squads already hold
		cordons across the streets out of the square: Wolfova and the embankment, the Južni trg passage, Slovenska and Šubičeva.
		If the two crowds meet, there will be a brawl. Every injury your officers cause will be on the evening news.`;
	static goals = [ 'Keep the clash meter from filling for 12:00', 'Injure as few people as possible' ];
	static tips = [ 'The cordons seal the short ways out of Kongresni trg — the long way round (Vegova, Gosposka) is open',
		'Counter-protesters chase the march — watch for flanking through side streets', 'Reserves wait on Tomšičeva, Trg republike and at PU Ljubljana',
		'Kettling the counter-protest works, but it boils', 'Gas affects both sides equally' ];

	async setup() {

		const W = this.world, P = W.places;
		await W.exits();
		this.duration = 12 * 60;
		this.clash = 0;
		this.focus = P[ 'Kongresni trg' ];
		this.zoom = 0.55;
		this.resources = { gas: { left: 4, max: 4 }, water: { left: 4, max: 4 }, reinforce: { left: 2, max: 2 } };
		this.waterOpinion = - 2;
		this.march = await W.bloc( { kind: 'march', label: 'March', at: P[ 'Prešernov trg' ], n: 2600, groupSize: 100, spread: 40, goal: P[ 'Prešernov trg' ], goalR: 25, mode: MODE.HOLD, agitation: [ 0.05, 0.2 ], morale: 0.7 } );
		await W.bloc( { faction: FACTION.COUNTER, kind: 'counter', label: 'Counter-protest', at: P[ 'Kongresni trg' ], n: 900, groupSize: 60, spread: 30, goal: P[ 'Kongresni trg' ], goalR: 25, mode: MODE.HOLD, agitation: [ 0.3, 0.55 ], morale: 0.7 } );
		const s = P[ 'Trg republike' ];
		// cordons already formed across the short ways out of Kongresni trg toward the march's route (well clear of
		// both crowds: spawning on the squares injured dozens before the player could act)
		for ( const [ a, b, n ] of CLASH_LINES ) {

			const at = [ ( a[ 0 ] + b[ 0 ] ) / 2, ( a[ 1 ] + b[ 1 ] ) / 2 ];
			await W.lineSquads( await squads( W, Array( n ).fill( at ) ), a, b, null );

		}

		await squads( W, [ [ - 285, 12 ], s, [ s[ 0 ] + 15, s[ 1 ] ], W.marks[ 'PU Ljubljana' ], W.marks[ 'PU Ljubljana' ] ] );
		await cars( W, [ [ - 251, - 45 ], W.marks[ 'PU Ljubljana' ] ] );
		await W.patrols.add( { at: [ s[ 0 ] + 10, s[ 1 ] + 25 ], water: true } ); // Slovenska by Trg republike, behind the lines
		this.waves = [
			{ t: 200, n: 600, at: W.marks[ 'Železniška postaja' ], label: 'Counter-protesters from the station' },
			{ t: 420, n: 500, at: P[ 'Park Tivoli' ], label: 'Counter-protesters from Tivoli' },
		];
		await this.bystanders( 2000 );

	}

	start() {

		this.after( 40, () => {

			for ( const g of this.march ) { g.leg = 0; this.world.march( [ g ], ...CLASH_LEGS[ 0 ] ); }
			this.event( 'The march sets off for Trg republike by Čopova', 'info', this.world.places[ 'Prešernov trg' ] );

		} );
		this.after( 2, () => this.event( 'The march starts in 0:40 — hold the cordons', 'info', this.world.places[ 'Kongresni trg' ] ) );
		for ( const w of this.waves ) {

			this.after( w.t - 30, () => this.event( `${w.label} in 0:30`, 'warn', w.at ) );
			this.after( w.t, async () => {

				await this.world.bloc( { faction: FACTION.COUNTER, kind: 'counter', label: w.label, at: w.at, n: w.n, groupSize: 60, spread: 30, goal: w.at, goalR: 20, agitation: [ 0.4, 0.65 ], morale: 0.8 } );
				w.spawned = true;
				this.event( `${w.label} have arrived`, 'bad', w.at );

			} );

		}

	}

	commands() { return this.policeCommands(); }

	tick( dt ) {

		// the march: a group moves on to its next leg when its centre is within 30 m of this one's goal
		for ( const g of this.march ) {

			if ( g.leg === undefined || g.leg >= CLASH_LEGS.length - 1 || ! g.center || g.mode !== MODE.MARCH ) continue;
			const [ x, y ] = CLASH_LEGS[ g.leg ];
			if ( near( g.center, [ x, y ], 30 ) ) this.world.march( [ g ], ...CLASH_LEGS[ ++ g.leg ] );

		}

		// counter-protest AI: go after the nearest part of the march
		if ( this.t > 30 && this.t - ( this.flags.ai ?? 0 ) > 6 && this.world.intel ) {

			this.flags.ai = this.t;
			const marchers = this.world.groupsOf( FACTION.PROTESTER ).filter( ( g ) => g.center );
			for ( const g of this.world.groupsOf( FACTION.COUNTER ) ) {

				if ( ! g.center || Math.random() < 0.4 ) continue;
				let best = null, bd = 450 * 450;
				for ( const q of marchers ) {

					const d = ( q.center[ 0 ] - g.center[ 0 ] ) ** 2 + ( q.center[ 1 ] - g.center[ 1 ] ) ** 2;
					if ( d < bd ) { bd = d; best = q; }

				}

				if ( best ) this.world.march( [ g ], ...best.center.map( ( v ) => Math.round( v / 12 ) * 12 ), 8 ); // 12 m grid: chasers share fields

			}

		}

		const c = this.stats ? this.stats[ STAT.CLASH ] : 0;
		// capped like the façade breach: a full-on brawl still takes ~35 s to lose, time to react
		this.clash = Math.max( 0, Math.min( 1, this.clash + ( c > 0 ? Math.min( 0.028, c / 2400 ) : - 0.012 ) * dt ) );
		if ( this.clash > 0.3 && ! this.flags.c30 ) { this.flags.c30 = true; this.event( 'Fighting has broken out!', 'bad' ); }
		if ( this.clash > 0.7 && ! this.flags.c70 ) { this.flags.c70 = true; this.event( 'The brawl is spreading — separate them now!', 'bad' ); }
		if ( this.clash < 0.15 ) this.flags.c30 = this.flags.c70 = false;

		if ( this.clash >= 1 ) this.end( false, 'A full street brawl erupted between the two crowds.' );
		else if ( this.t >= this.duration ) this.end( true, 'The march ended without a brawl.' );

	}

	phase() {

		const w = this.waves.find( ( q ) => ! q.spawned );
		return w ? `Next: ${w.label} in ${fmt( w.t - this.t )}` : `${fmt( this.duration - this.t )} left`;

	}

	objectives() {

		const inj = this.counters.injByPolice;
		return [
			{ label: 'Keep them apart for 12:00', value: this.t / this.duration, text: fmt( this.duration - this.t ), state: 'ok' },
			{ label: 'Clash', value: this.clash, text: `${Math.round( this.clash * 100 )}%`, state: this.clash > 0.6 ? 'bad' : this.clash > 0.2 ? 'warn' : 'ok', invert: true },
			{ label: '★ Injuries caused by police ≤ 20', value: Math.min( 1, inj / 20 ), text: `${inj}`, state: inj > 20 ? 'bad' : inj > 12 ? 'warn' : 'ok', invert: true },
			{ label: '★ Brawl injuries ≤ 10', value: Math.min( 1, this.counters.injOther / 10 ), text: `${this.counters.injOther}`, state: this.counters.injOther > 10 ? 'bad' : 'ok', invert: true },
		];

	}

	score( win ) {

		const s2 = win && this.counters.injByPolice <= 20, s3 = win && this.counters.injOther <= 10;
		return { stars: win + s2 + s3, lines: [
			[ 'Injuries caused by police', this.counters.injByPolice ], [ 'Brawl injuries', this.counters.injOther ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Arrests', this.counters.arrested ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const s = this.world.places[ 'Trg republike' ];
		this.drawZone( o, s[ 0 ], s[ 1 ], 40, ORANGE, 'MARCH DESTINATION' );
		const w = this.waves.find( ( q ) => ! q.spawned );
		if ( w && w.t - this.t < 60 ) this.drawZone( o, w.at[ 0 ], w.at[ 1 ], 35, LIME, `${fmt( w.t - this.t )}` );

	}

}
