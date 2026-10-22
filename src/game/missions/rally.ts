import {
	Mission, FACTION, MODE, STAT, ZONE, fmt, rand, pick,
	ORANGE, drawPending, near, squads,
} from '../sdk/index.ts';

// ======================================================================================= RALLY (protest side)
export class RallyMission extends Mission {

	declare goal: number;
	declare holdNeed: number;
	declare held: number;
	declare target: any;
	declare focus: [ number, number ];
	declare zoom: number;
	declare ai: PoliceAI;

	static id = 'rally';
	static title = 'Rally';
	static subtitle = 'Coordinate the protest: fill Trg republike and hold it';
	static side = 'protest';
	static brief = `You coordinate the protest. The police have orders to keep <b>Trg republike</b> clear. Bring
		<b>5,000 people</b> onto the square and hold it for <b>3 minutes</b>. Every rally call sends small groups in from all
		over town, and more answer when the public is on your side. The fuller the square, the harder the police push:
		more cordons, reinforcements, baton charges, and tear gas at 5,000. Police violence wins you sympathy; rioting loses it.`;
	static goals = [ 'Get 5,000 protesters onto Trg republike', 'Hold the square for 3:00 in total', 'Keep the protest alive (≥ 500 people)' ];
	static tips = [ 'Click a group, right-click to march. Shift adds to the selection; shift-drag selects a box',
		'Kolesarji (cyclists) are 2–3× faster: use them to fill the square early or draw the police away',
		'R: rally call — small groups set off from all over town (up to 2 km away) toward the cursor; call early. Arrivals grow with your headcount and sympathy',
		'The police get reinforcements and cordon off more streets as the square fills; at 2/3 of the goal they start clearing it, at 5,000 they gas it',
		'Q calms a group, E fires it up — angry groups push through cordons but riot', 'Isolated small groups get kettled — move in numbers' ];

	async setup() {

		const W = this.world, P = W.places;
		await W.exits();
		this.crowd.u.revealLeaders.value = 1;
		this.opinion = 50;
		this.goal = 5000;
		this.holdNeed = 180;
		this.held = 0;
		this.target = P[ 'Trg republike' ];
		this.focus = [ this.target[ 0 ] + 150, this.target[ 1 ] + 60 ];
		this.zoom = 0.95;
		this.setZones( [ { x: this.target[ 0 ], y: this.target[ 1 ], r: 60, type: ZONE.PROT } ] );
		this.resources = { rally: { left: 99, max: 99, cooldown: 30, ready: 0 } };
		for ( const [ from, n ] of [ [ 'Prešernov trg', 900 ], [ 'Metelkova', 700 ], [ 'Park Tivoli', 600 ] ] ) {

			await W.bloc( { kind: 'bloc', label: from, at: P[ from ], n, groupSize: 100, spread: 40, goal: P[ from ], goalR: 30, mode: MODE.HOLD, morale: 0.6, resolve: [ 0.7, 1.0 ] } );

		}

		// the Friday bike protest: fast, and slips round cordons, but riders get off once they hit a line
		await W.bloc( { kind: 'bloc', label: 'Kolesarji', at: P[ 'Kongresni trg' ], n: 300, groupSize: 60, spread: 25, goal: P[ 'Kongresni trg' ], goalR: 25, mode: MODE.HOLD, morale: 0.7, resolve: [ 0.8, 1.1 ], bikes: 1 } );

		// police: cordons on the approaches + reserves, more cordons and reinforcements as the square fills
		this.ai = new PoliceAI( this, this.target );
		await this.ai.setup();
		await this.bystanders( 2000 );

	}

	start() {

		this.after( 2, () => this.event( 'Select a bloc and right-click Trg republike to march', 'info', this.target ) );

	}

	commands() { return this.protestCommands(); }

	opinionWeights() {

		return { injByPolice: 0.4, injPolice: - 0.6, arrested: 0.05, arrestedSitters: 0.1, injOther: - 0.1 };

	}

	get headcount() { return this.zone( 0 ); }

	// rally call: people answer from all over town, 0.3–2 km out (most from nearer by), and converge on (x, y)
	// in small groups, so a call takes minutes to show on the square and its groups can be cut off on the way
	async rally( x, y ) {

		if ( ! this.spend( 'rally' ) ) return;
		const W = this.world, [ x0, y0, x1, y1 ] = this.city.bounds;
		const momentum = Math.min( 1, this.headcount / this.goal ) * 0.5 + this.opinion / 200;
		const n = Math.round( 200 + 900 * momentum );
		const layer = await W.fieldTo( x, y, 20 );
		let left = n, groups = 0;
		while ( left > 0 ) {

			const size = Math.min( left, Math.round( rand( 20, 45 ) ) );
			let at = null;
			for ( let t = 0; t < 40 && ! at; t ++ ) {

				const a = Math.random() * Math.PI * 2, d = 300 + 1700 * Math.random() ** 1.5;
				const px = x + Math.cos( a ) * d, py = y + Math.sin( a ) * d;
				if ( px > x0 + 20 && px < x1 - 20 && py > y0 + 20 && py < y1 - 20 ) at = W.roadSpot( px, py, 60 );

			}

			await W.bloc( { kind: 'bloc', label: 'Arrivals', at: at ?? pick( this.city.entries ).pos, n: size, groupSize: size, spread: 4, layer,
				morale: 0.6, resolve: [ 0.7, 1.0 ], speed: [ 1.05, 1.3 ] } );
			left -= size;
			groups ++;

		}

		this.event( `Rally call answered: ${n} people in ${groups} small groups heading in from across town`, 'good', [ x, y ] );

	}

	tick( dt ) {

		this.ai.tick();
		const hc = this.headcount;
		if ( hc >= this.goal ) {

			if ( ! this.flags.holding ) { this.flags.holding = true; this.event( 'The square is ours — hold it!', 'good', this.target ); }
			this.held += dt;

		} else if ( this.flags.holding ) { this.flags.holding = false; this.event( 'Headcount fell below 5,000 — the clock is paused', 'warn', this.target ); }

		for ( const m of [ 0.25, 0.5, 0.75 ] ) {

			if ( hc >= this.goal * m && ! this.flags[ 'hc' + m ] ) { this.flags[ 'hc' + m ] = true; this.event( `${Math.round( hc ).toLocaleString()} on the square`, 'good', this.target ); }

		}

		const alive = this.stats ? this.stats[ STAT.PROT ] : 9999;
		if ( this.held >= this.holdNeed ) this.end( true, 'Trg republike belongs to the people tonight.' );
		else if ( this.t > 60 && alive < 500 ) this.end( false, 'The protest fizzled out.' );
		else if ( this.t > 20 * 60 ) this.end( false, 'The night is over — the square was never held long enough.' );

	}

	phase() {

		const r = this.resources.rally;
		const police = this.ai.gassing ? ' · POLICE GASSING THE SQUARE' : this.ai.clearing ? ' · POLICE CLEARING THE SQUARE' : '';
		return ( this.flags.holding ? `HOLDING · ${fmt( this.holdNeed - this.held )} to go` : `Rally call ${r.ready > 0 ? 'in ' + fmt( r.ready ) : 'ready (R)'} · ${fmt( 20 * 60 - this.t )} left` ) + police;

	}

	objectives() {

		const hc = this.headcount, alive = this.stats ? this.stats[ STAT.PROT ] : 0;
		return [
			{ label: 'People on Trg republike', value: Math.min( 1, hc / this.goal ), text: `${hc.toLocaleString()} / ${this.goal.toLocaleString()}`, state: hc >= this.goal ? 'done' : 'ok' },
			{ label: 'Square held', value: this.held / this.holdNeed, text: `${fmt( this.held )} / ${fmt( this.holdNeed )}`, state: this.flags.holding ? 'done' : 'ok' },
			{ label: 'Protesters on the streets', value: Math.min( 1, alive / 6000 ), text: alive.toLocaleString(), state: alive < 900 ? 'bad' : 'ok' },
			{ label: '★ Officers injured ≤ 10 (stay peaceful)', value: Math.min( 1, this.counters.injPolice / 10 ), text: `${this.counters.injPolice}`, state: this.counters.injPolice > 10 ? 'bad' : 'ok', invert: true },
		];

	}

	score( win ) {

		const s2 = win && this.t <= 12 * 60, s3 = win && this.counters.injPolice <= 10;
		return { stars: win + s2 + s3, lines: [
			[ 'Time', fmt( this.t ) ], [ 'Public sympathy', Math.round( this.opinion ) ], [ 'Protesters injured', this.counters.injByPolice ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Arrested', this.counters.arrested ], [ 'Went home', this.counters.gone ] ] };

	}

	draw( o ) {

		this.drawZone( o, this.target[ 0 ], this.target[ 1 ], 60, this.flags.holding ? 'rgb(255,176,32)' : ORANGE, `TRG REPUBLIKE · ${this.headcount.toLocaleString()}`, 0.06 );
		this.ai.draw( o );

	}

}

// Police commander for the rally mission. Escalates with the headcount on the square (f = headcount / goal):
// - always: cordons on the four approaches, reserves kettle isolated groups and snatch visible leaders, gas on a
//   hard-pressed cordon; reinforcements every 90 s (60 s from f ≥ 1/3, 40 s from f ≥ 2/3), which first close off
//   more streets around the square (outer cordons wall to wall, where protesters are coming in), then join the reserves
// - f ≥ 0.66 (until < 0.5): clearing — the approach lines advance on the square, reserves baton-charge the crowd's edge
// - f ≥ 1 (until < 0.85): tear gas volleys into the square
// Charges and gas are announced a few seconds ahead (dashed red rings), like CourtPolice.
const RALLY_R = 60;

class PoliceAI {

	declare m: any;
	declare W: any;
	declare target: any;
	declare gas: number;
	declare squareGas: number;
	declare lastGas: number;
	declare lastKettle: number;
	declare last: any;
	declare clearing: boolean;
	declare gassing: boolean;
	declare extra: number;
	declare pending: any[];
	declare cordons: any[];
	declare reserves: any[];
	declare busy: Set<any>;
	declare posts: Map<any, any>;
	declare outer: any[];
	declare lastTick: any;

	constructor( mission, target ) {

		this.m = mission;
		this.W = mission.world;
		this.target = target;
		this.gas = 6; // for pressed cordons; the square's volleys have their own supply
		this.squareGas = 40;
		this.lastGas = - 99;
		this.lastKettle = - 99;
		this.last = { reinf: 0, charge: - 99, volley: - 99, advance: - 99 };
		this.clearing = false;
		this.gassing = false;
		this.extra = 0; // reinforcement squads so far
		this.pending = [];

	}

	async setup() {

		const W = this.W, [ tx, ty ] = this.target;
		this.cordons = [];
		const P = W.places;
		for ( const from of [ P[ 'Prešernov trg' ], P[ 'Park Tivoli' ], W.marks[ 'Železniška postaja' ], P[ 'Kongresni trg' ] ] ) {

			let dx = from[ 0 ] - tx, dy = from[ 1 ] - ty;
			const l = Math.hypot( dx, dy ); dx /= l; dy /= l;
			const c = W.spot( tx + dx * 85, ty + dy * 85, 10, false );
			const sq = await squads( W, [ c, c ] );
			const a = [ c[ 0 ] - dy * 22, c[ 1 ] + dx * 22 ], b = [ c[ 0 ] + dy * 22, c[ 1 ] - dx * 22 ];
			await W.lineSquads( sq, a, b, null );
			this.cordons.push( { at: c, squads: sq } );
			await W.patrols.add( { at: [ c[ 0 ] - dx * 12, c[ 1 ] - dy * 12 ], crew: 0, selectable: false, label: 'Police car' } );

		}

		this.reserves = await squads( W, [ W.marks[ 'PU Ljubljana' ], W.marks[ 'PU Ljubljana' ], W.marks[ 'PP Ljubljana Center' ], W.marks[ 'PP Ljubljana Center' ], [ tx, ty ], [ tx + 10, ty ] ], 26 );
		this.busy = new Set<any>();
		this.posts = new Map<any, any>(); // reserve squad → where it stands between charges

		// streets 120–220 m out where an outer cordon fits wall to wall (6–28 m across), ≥ 45 m apart
		this.outer = [];
		for ( const R of [ 140, 190 ] ) for ( let k = 0; k < 48; k ++ ) {

			const t = k / 48 * Math.PI * 2;
			const at = W.roadSpot( tx + Math.cos( t ) * R, ty + Math.sin( t ) * R, 30 );
			if ( ! at || ! near( at, this.target, 220 ) || near( at, this.target, 120 ) ) continue;
			if ( this.outer.some( ( o ) => near( o.at, at, 45 ) ) || this.cordons.some( ( c ) => near( c.at, at, 45 ) ) ) continue;
			const [ a, b ] = W.across( ...at, 16 );
			const w = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
			if ( w >= 6 && w <= 28 ) this.outer.push( { at, a, b, used: false } );

		}

	}

	// announce, then act
	tell( at, r, label, delay, fn ) {

		this.pending.push( { at, r, label, until: this.m.t + delay } );
		this.m.event( `Police: ${label} in ${delay} s`, 'warn', at );
		this.m.after( delay, fn );

	}

	free() { return this.reserves.filter( ( s ) => ! this.busy.has( s ) && ( s.alive ?? s.members.length ) > 10 ); }

	// protesters inside the square (positions), from the last intel readback
	inSquare() {

		const I = this.W.intel, [ tx, ty ] = this.target, out = [];
		for ( let i = 0; i < this.m.crowd.count; i ++ ) {

			if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
			const x = I.x( i ), y = I.y( i );
			if ( ( x - tx ) ** 2 + ( y - ty ) ** 2 < RALLY_R * RALLY_R ) out.push( [ x, y ] );

		}

		return out;

	}

	// Squads standing on their line or post hand back their own flow field (a layer per line runs the 32-layer pool
	// dry) and share the square's: officers in formation within 30 m of their slots ignore the field anyway.
	async settle() {

		const W = this.W;
		const idle = W.groupsOf( FACTION.POLICE ).filter( ( s ) => s.mode === MODE.FORMATION && ! this.busy.has( s ) && s.center && s.anchor && near( s.center, s.anchor, 25 ) );
		if ( ! idle.length ) return;
		const home = await W.fieldTo( ...this.target, 20 );
		for ( const s of idle ) if ( s.mode === MODE.FORMATION && ! this.busy.has( s ) ) W.setLayer( s, home );

	}

	async reinforce( f ) {

		const W = this.W, m = this.m;
		if ( this.extra >= 30 ) return;
		const from = pick( [ W.marks[ 'PU Ljubljana' ], W.marks[ 'PP Ljubljana Center' ] ] );
		const sq = await squads( W, [ from, from ] );
		this.extra += 2;

		// below 2/3: close off another street, the open one with most protesters coming in
		const open = this.outer.filter( ( o ) => ! o.used );
		if ( f < 0.66 && open.length ) {

			const score = ( o ) => W.countNear( ...o.at, 70, FACTION.PROTESTER ) - W.countNear( ...o.at, 12, FACTION.PROTESTER ) * 2 + Math.random() * 5;
			const o = open.reduce( ( p, q ) => ( score( q ) > score( p ) ? q : p ) );
			o.used = true;
			await W.lineSquads( sq, o.a, o.b, W.intel?.pos );
			this.cordons.push( { at: o.at, squads: sq, outer: true } );
			m.event( 'Police reinforcements cordon off another street', 'warn', o.at );
			return;

		}

		// clearing: every other wave thickens the weakest approach line, the rest join the reserves
		const inner = this.cordons.filter( ( c ) => ! c.outer && c.squads[ 0 ].cordon );
		if ( this.clearing && inner.length && this.extra % 4 === 0 ) {

			const c = inner.reduce( ( p, q ) => ( q.squads.length < p.squads.length ? q : p ) );
			const L = c.squads[ 0 ].cordon;
			c.squads.push( ...sq );
			await W.lineSquads( c.squads, L.a, L.b, W.intel?.pos );
			m.event( 'Police reinforcements join a line on the square', 'warn', c.at );
			return;

		}

		this.reserves.push( ...sq );
		m.event( 'Police reinforcements arrive', 'warn', from );

	}

	tick() {

		const m = this.m, W = this.W;
		if ( ! W.intel || m.t - ( this.lastTick ?? 0 ) < 5 ) return;
		this.lastTick = m.t;
		const f = m.headcount / m.goal;

		if ( ! this.clearing && f >= 0.66 ) {

			this.clearing = true;
			m.event( 'Police order: clear Trg republike! Lines advance, charges coming', 'bad', this.target );
			this.reinforce( f ).then( () => this.reinforce( f ) );

		} else if ( this.clearing && f < 0.5 ) { this.clearing = false; m.event( 'The police stop advancing and hold their lines', 'info', this.target ); }

		if ( ! this.gassing && f >= 1 ) { this.gassing = true; m.event( 'Police are firing tear gas into the square!', 'bad', this.target ); }
		else if ( this.gassing && f < 0.85 ) this.gassing = false;

		const every = f >= 0.66 ? 40 : f >= 1 / 3 ? 60 : 90;
		if ( m.t - this.last.reinf >= every ) { this.last.reinf = m.t; this.reinforce( f ); }

		// pressure on a cordon → gas it (limited, cooldown)
		for ( const c of this.cordons ) {

			const n = W.countNear( c.at[ 0 ], c.at[ 1 ], 30, FACTION.PROTESTER );
			if ( n > 250 && this.gas > 0 && m.t - this.lastGas > 45 ) {

				this.gas --;
				this.lastGas = m.t;
				W.gas( c.at[ 0 ] + rand( - 8, 8 ), c.at[ 1 ] + rand( - 8, 8 ) );
				m.event( 'Police fire tear gas at the cordon!', 'bad', c.at );
				break;

			}

		}

		this.settle();
		const sq = this.clearing || this.gassing ? this.inSquare() : [];

		// clearing: the approach lines step 8 m toward the square every 15 s, down to 30 m from its middle
		if ( this.clearing && m.t - this.last.advance >= 15 ) {

			this.last.advance = m.t;
			const [ tx, ty ] = this.target;
			for ( const c of this.cordons ) {

				const L = c.squads[ 0 ]?.cordon;
				if ( c.outer || ! L || m.t - L.retreatAt < 20 ) continue;
				const mx = ( L.a[ 0 ] + L.b[ 0 ] ) / 2, my = ( L.a[ 1 ] + L.b[ 1 ] ) / 2, d = Math.hypot( tx - mx, ty - my );
				if ( d < 38 ) continue;
				const sx = ( tx - mx ) / d * 8, sy = ( ty - my ) / d * 8;
				c.at = [ mx + sx, my + sy ];
				W.lineSquads( L.squads, [ L.a[ 0 ] + sx, L.a[ 1 ] + sy ], [ L.b[ 0 ] + sx, L.b[ 1 ] + sy ], W.intel.pos, L, { keepField: true } );

			}

		}

		// clearing: up to two free reserve squads baton-charge the edge of the crowd nearest to them, 15 m in, then re-form
		if ( this.clearing && sq.length > 50 && m.t - this.last.charge >= 25 ) {

			const team = this.free().filter( ( s ) => s.center ).slice( 0, 2 );
			if ( team.length ) {

				this.last.charge = m.t;
				const c = team[ 0 ].center;
				let edge = sq[ 0 ], bd = Infinity;
				for ( const p of sq ) { const d = ( p[ 0 ] - c[ 0 ] ) ** 2 + ( p[ 1 ] - c[ 1 ] ) ** 2; if ( d < bd ) { bd = d; edge = p; } }
				const [ tx, ty ] = this.target, dl = Math.hypot( tx - edge[ 0 ], ty - edge[ 1 ] ) || 1;
				const k = Math.min( 15, dl ) / dl, goal = [ edge[ 0 ] + ( tx - edge[ 0 ] ) * k, edge[ 1 ] + ( ty - edge[ 1 ] ) * k ];
				team.forEach( ( s ) => { this.busy.add( s ); this.posts.set( s, edge ); } );
				this.tell( goal, 15, 'baton charge', 5, () => {

					W.charge( team, ...goal );
					m.after( 14, () => { team.forEach( ( s ) => this.busy.delete( s ) ); W.moveSquads( team, ...this.posts.get( team[ 0 ] ) ); } );

				} );

			}

		}

		// gas: two canisters into the thick of the square every 20 s (a random protester there = density-weighted)
		if ( this.gassing && sq.length && this.squareGas > 0 && m.t - this.last.volley >= 20 ) {

			this.last.volley = m.t;
			const shots = [ pick( sq ), pick( sq ) ];
			this.tell( shots[ 0 ], 22, 'tear gas', 5, () => {

				for ( const p of shots ) if ( this.squareGas > 0 ) { this.squareGas --; W.gas( ...p ); }
				m.nudgeOpinion( 1, 'tear gas on a packed square' );

			} );

		}

		// isolated small groups far from the square → kettle with two reserve squads
		if ( m.t - this.lastKettle > 60 ) {

			const free = this.free();
			const lone = W.groupsOf( FACTION.PROTESTER ).filter( ( g ) => g.center && g.alive > 20 && ! near( g.center, this.target, 150 ) )
				.filter( ( g ) => W.countNear( g.center[ 0 ], g.center[ 1 ], 40, FACTION.PROTESTER ) < 160 );
			if ( lone.length && free.length >= 2 ) {

				const g = pick( lone ), team = free.slice( 0, 2 );
				team.forEach( ( s ) => this.busy.add( s ) );
				W.kettle( team, g.center[ 0 ], g.center[ 1 ], 16, W.intel.pos );
				this.lastKettle = m.t;
				m.event( `Police are kettling ${g.label}! Move other groups in to break it.`, 'bad', g.center );
				m.after( 90, () => { team.forEach( ( s ) => this.busy.delete( s ) ); W.moveSquads( team, ...this.target ); } );

			}

		}

		// visible leader close to the square → snatch
		const free = this.free();
		const leader = W.groupsOf( FACTION.PROTESTER ).find( ( g ) => g.identified && g.leaderState === 'active' && near( g.leaderPos, this.target, 160 ) );
		if ( leader && free.length && Math.random() < 0.3 ) {

			const s = free[ 0 ];
			this.busy.add( s );
			W.arrest( [ s ], ...leader.leaderPos );
			m.event( `Snatch squad going for the leader of ${leader.label}`, 'warn', leader.leaderPos );
			m.after( 45, () => { this.busy.delete( s ); W.moveSquads( [ s ], ...this.target ); } );

		}

	}

	draw( o ) {

		this.pending = this.pending.filter( ( p ) => p.until > this.m.t );
		drawPending( o, this.pending, this.m.t );

	}

}
