import {
	Mission, FACTION, MODE, ROLE, STAT, ZONE, fmt, rand, pick,
	ORANGE, RED, WHITE, drawPending, inPoly, near, squads,
} from '../sdk/index.js';

// ======================================================================================= COURT
// Protest side, capture the flag: carry the banner up Miklošičeva to the steps of the Palace of Justice
// before the verdict. The banner is a unit (its bloc's leader); if the bearer falls, the banner lies in the
// street until a group picks it up, or the police hold it and confiscate it.

const STEPS_R = 40, STEPS_NEED = 300, STEPS_HOLD = 20; // crowd on the steps, how many, for how long
const VERDICT = 600, COURT_END = 900;
// Miklošičeva's axis (from its street label): Prešernov trg (by the Franciscan church) → the station
const MIKLOSICEVA = [ [ 10, 75 ], [ 200, 741 ] ];
const onMiklosiceva = ( y ) => [ MIKLOSICEVA[ 0 ][ 0 ] + ( y - MIKLOSICEVA[ 0 ][ 1 ] ) * ( MIKLOSICEVA[ 1 ][ 0 ] - MIKLOSICEVA[ 0 ][ 0 ] ) / ( MIKLOSICEVA[ 1 ][ 1 ] - MIKLOSICEVA[ 0 ][ 1 ] ), y ];

export class CourtMission extends Mission {

	static id = 'court';
	static title = 'The Court';
	static subtitle = 'Carry the banner up Miklošičeva to the court before the verdict';
	static side = 'protest';
	static brief = `At 10:00 the court reads the verdict against seven climate activists who blockaded the ring road. You
		coordinate the march from <b>Prešernov trg</b> up <b>Miklošičeva</b> to the <b>Palace of Justice</b>. The police have
		closed the street with cordons and hold the steps. The march is about one thing: the <b>banner</b>. Get it to the
		court steps with at least ${STEPS_NEED} people around it and hold for ${STEPS_HOLD} seconds. If its bearer is arrested
		the banner falls; pick it up before the police do. Police violence on camera wins you sympathy and new arrivals;
		rioting loses both.`;
	static goals = [ `Banner on the court steps with ≥ ${STEPS_NEED} people for ${STEPS_HOLD} s`, 'Do not lose the banner to the police', 'Within 15:00',
		'★ Before the verdict (10:00) · ★ Sympathy ≥ 50 and ≤ 10 officers injured' ];
	static tips = [ 'The banner bloc is slow and precious: screen it with other groups, put it in a shield wall (B) near the lines',
		'Police moves are announced a few seconds ahead (red dashed rings): scatter (W) out of a forming kettle, umbrellas (U) against gas',
		'Gas drifts with the wind (shown top left)', 'Miklošičeva is the obvious way. Kolodvorska, the park and the square south of the court are not',
		'Split (V) a decoy off a big group; merge (M) groups back together before a line', 'Medics take the injured off the street; R calls more people in' ];

	async setup() {

		const W = this.world, P = W.places, M = W.marks;
		await W.exits();
		this.crowd.u.revealLeaders.value = 1;
		this.opinion = 50;
		this.focus = [ 30, 160 ];
		this.zoom = 0.55;
		this.resources = { rally: { left: 99, max: 99, cooldown: 40, ready: 0 }, umbrella: { left: 3, max: 3 } };
		const a = Math.random() * Math.PI * 2, ws = rand( 0.5, 1.0 );
		W.wind = [ Math.cos( a ) * ws, Math.sin( a ) * ws ];

		// the court: the Palace of Justice footprint, steps on the open façade closest to Miklošičeva
		const court = M[ 'Vrhovno sodišče' ];
		const ring = this.city.buildings.find( ( b ) => inPoly( b.p[ 0 ], ...court ) ).p[ 0 ];
		this.courtRing = ring;
		let best = null;
		for ( let k = 0; k < ring.length; k += 2 ) {

			const ax = ring[ k ], ay = ring[ k + 1 ], bx = ring[ ( k + 2 ) % ring.length ], by = ring[ ( k + 3 ) % ring.length ];
			const len = Math.hypot( bx - ax, by - ay ), mx = ( ax + bx ) / 2, my = ( ay + by ) / 2;
			let nx = ( by - ay ) / len, ny = - ( bx - ax ) / len;
			if ( inPoly( ring, mx + nx * 2, my + ny * 2 ) ) { nx = - nx; ny = - ny; }
			// the main façade: long enough, open in front, facing Miklošičeva
			if ( len < 25 || W.sdf( mx + nx * 8, my + ny * 8 ) <= 1 ) continue;
			const d = Math.hypot( mx - onMiklosiceva( my )[ 0 ], 0 );
			if ( ! best || d < best.d ) best = { d, ax, ay, bx, by, nx, ny, mx, my };

		}

		this.facade = best;
		this.steps = W.spot( best.mx + best.nx * 7, best.my + best.ny * 7, 4 );
		this.setZones( [ { x: this.steps[ 0 ], y: this.steps[ 1 ], r: STEPS_R, type: ZONE.PROT } ] );

		// the march
		const start = P[ 'Prešernov trg' ];
		const [ banner ] = await W.bloc( { kind: 'bloc', label: 'Banner bloc', at: start, n: 250, groupSize: 250, spread: 15, goal: start, goalR: 20, mode: MODE.HOLD, morale: 0.75, agitation: [ 0.05, 0.2 ], resolve: [ 0.9, 1.2 ] } );
		this.banner = { group: banner, pos: banner.leaderPos ?? start, bearers: 1 };
		await W.bloc( { kind: 'bloc', label: 'Students', at: start, n: 600, groupSize: 100, spread: 35, goal: start, goalR: 30, mode: MODE.HOLD, morale: 0.6 } );
		await W.bloc( { kind: 'bloc', label: 'Unions', at: P[ 'Kongresni trg' ], n: 500, groupSize: 100, spread: 30, goal: P[ 'Kongresni trg' ], goalR: 30, mode: MODE.HOLD, morale: 0.65, resolve: [ 0.8, 1.1 ] } );
		await W.bloc( { kind: 'bloc', label: 'Kolesarji', at: P[ 'Tromostovje' ], n: 120, groupSize: 40, spread: 15, goal: P[ 'Tromostovje' ], goalR: 20, mode: MODE.HOLD, morale: 0.7, bikes: 1 } );
		await W.bloc( { kind: 'medics', label: 'Medics', at: start, n: 20, groupSize: 20, spread: 8, goal: start, goalR: 15, mode: MODE.HOLD, agitation: [ 0, 0.05 ], morale: 0.9, resolve: [ 1.0, 1.3 ] } );

		this.arrivals = [ ...this.city.entries.map( ( e ) => ( { name: e.name ?? 'street', pos: e.pos } ) ),
			...this.city.pois.filter( ( p ) => p.kind === 'bus' ).map( ( p ) => ( { name: p.name, pos: p.pos } ) ),
			{ name: 'Railway station', pos: M[ 'Železniška postaja' ] } ];

		this.ai = new CourtPolice( this );
		await this.ai.setup();
		await this.bystanders( 1500 );
		this.held = 0;

	}

	start() {

		this.after( 2, () => this.event( 'Select the Banner bloc and march it up Miklošičeva. The court is waiting.', 'info', this.steps ) );
		this.after( VERDICT - 60, () => this.event( 'The verdict is read in 1:00', 'warn', this.steps ) );
		this.after( VERDICT, () => this.event( 'The verdict is read. The banner can still make the evening news: keep going', 'warn', this.steps ) );

	}

	commands() { return this.protestCommands(); }

	opinionWeights() {

		return { injByPolice: 0.4, injPolice: - 0.6, arrested: 0.05, arrestedSitters: 0.1, injOther: - 0.1 };

	}

	// rally call: people arrive at the nearest stop or street; more when the public is with you
	async rally( x, y ) {

		let best = this.arrivals[ 0 ], bd = Infinity;
		for ( const a of this.arrivals ) {

			const d = ( a.pos[ 0 ] - x ) ** 2 + ( a.pos[ 1 ] - y ) ** 2;
			if ( d < bd ) { bd = d; best = a; }

		}

		if ( ! this.spend( 'rally' ) ) return;
		const n = Math.round( 80 + this.opinion * 4 );
		await this.world.bloc( { kind: 'bloc', label: 'Arrivals', at: best.pos, n, groupSize: 100, spread: 20, goal: [ x, y ], goalR: 20, morale: 0.6, resolve: [ 0.6, 1.0 ] } );
		this.event( `Rally call answered: ${n} arriving at ${best.name ?? 'the edge of town'}`, 'good', best.pos );

	}

	tick( dt ) {

		const W = this.world, I = W.intel;
		this.ai.tick( dt );
		if ( I && I !== this._intel ) { this._intel = I; this.bannerTick( I, this._intelT ? this.t - this._intelT : 0 ); this._intelT = this.t; }

		const B = this.banner, onSteps = B.group && near( B.pos, this.steps, 18 ) && this.zone( 0 ) >= STEPS_NEED;
		if ( onSteps ) {

			if ( ! this.flags.steps ) { this.flags.steps = true; this.event( `The banner is on the steps! Hold ${STEPS_HOLD} seconds`, 'good', this.steps ); }
			this.held += dt;

		} else {

			if ( this.flags.steps ) this.event( 'Pushed off the steps', 'warn', this.steps );
			this.flags.steps = false;
			this.held = 0;

		}

		const alive = this.stats ? this.stats[ STAT.PROT ] : 9999;
		if ( this.held >= STEPS_HOLD ) this.end( true, this.t < VERDICT ? 'The banner stood on the court steps as the verdict was read.' : 'The banner made it to the court steps, and onto every front page.' );
		else if ( B.lost ) this.end( false, 'The police confiscated the banner. The march breaks up.' );
		else if ( this.t > 60 && alive < 300 ) this.end( false, 'The march fizzled out.' );
		else if ( this.t >= COURT_END ) this.end( false, 'The evening is over and the banner never reached the court.' );

	}

	// the banner follows its bearer (the group's leader); when the bearer falls it lies in the street until a group
	// picks it up, or until police standing over it for 10 s confiscate it
	bannerTick( I, dt ) {

		const W = this.world, B = this.banner;
		if ( B.group ) {

			const g = B.group;
			if ( g.leaderState === 'active' && ( g.alive ?? 0 ) > 0 ) { B.pos = g.leaderPos; this.crowd.u.parting.value = g.id; return; }
			B.group = null;
			B.held = 0;
			this.crowd.u.parting.value = - 1;
			this.event( 'The banner bearer is down: the banner is lying in the street! Get a group to it', 'bad', B.pos );

		}

		const prot = W.countNear( ...B.pos, 8, FACTION.PROTESTER ), pol = W.countNear( ...B.pos, 8, FACTION.POLICE );
		B.held = pol >= 5 && prot < 5 ? ( B.held ?? 0 ) + dt : 0;
		if ( B.held > 10 ) { B.lost = true; return; }
		if ( prot < 5 || pol >= prot ) return;
		// nearest protester lifts it and becomes the group's new leader
		let bi = - 1, bd = 64;
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
			const d = ( I.x( i ) - B.pos[ 0 ] ) ** 2 + ( I.y( i ) - B.pos[ 1 ] ) ** 2;
			if ( d < bd ) { bd = d; bi = i; }

		}

		const g = bi >= 0 && W.groups[ I.group( bi ) ];
		if ( ! g || g.kind === 'medics' ) return;
		if ( g.leaderState !== 'active' || g.leader !== bi ) {

			this.crowd.regroup( bi, g.id, ROLE.LEADER );
			this.crowd.setGroup( g.id, { leader: bi } );
			g.leader = bi;
			g.leaderState = 'active';
			g.leaderPos = [ I.x( bi ), I.y( bi ) ];

		}

		B.group = g;
		B.bearers ++;
		this.event( `${g.label} picked up the banner`, 'good', B.pos );

	}

	get windArrow() {

		const a = Math.atan2( this.world.wind[ 1 ], this.world.wind[ 0 ] );
		return [ '→', '↗', '↑', '↖', '←', '↙', '↓', '↘' ][ ( Math.round( a / ( Math.PI / 4 ) ) + 8 ) % 8 ];

	}

	phase() {

		const B = this.banner;
		const where = B.group ? `banner ${Math.round( Math.hypot( B.pos[ 0 ] - this.steps[ 0 ], B.pos[ 1 ] - this.steps[ 1 ] ) )} m from the steps` : 'BANNER IN THE STREET';
		const v = this.t < VERDICT ? `verdict in ${fmt( VERDICT - this.t )}` : `${fmt( COURT_END - this.t )} left`;
		return `${where} · ${v} · wind ${this.windArrow}`;

	}

	objectives() {

		const B = this.banner, z = this.zone( 0 ), d = Math.hypot( B.pos[ 0 ] - this.steps[ 0 ], B.pos[ 1 ] - this.steps[ 1 ] );
		return [
			{ label: 'Banner to the court steps', value: Math.max( 0, 1 - d / 420 ), text: B.group ? `${Math.round( d )} m` : 'dropped!', state: ! B.group ? 'bad' : d < 18 ? 'done' : 'ok' },
			{ label: `People on the steps (${STEPS_NEED})`, value: Math.min( 1, z / STEPS_NEED ), text: `${z}${this.held > 0 ? ` · ${Math.ceil( STEPS_HOLD - this.held )} s` : ''}`, state: z >= STEPS_NEED ? 'done' : 'ok' },
			{ label: '★ Before the verdict', value: Math.min( 1, this.t / VERDICT ), text: this.t < VERDICT ? fmt( VERDICT - this.t ) : 'read', state: this.t < VERDICT ? 'ok' : 'bad', invert: true },
			{ label: '★ Sympathy ≥ 50, officers injured ≤ 10', value: Math.min( 1, this.counters.injPolice / 10 ), text: `${Math.round( this.opinion )} · ${this.counters.injPolice}`, state: this.opinion < 50 || this.counters.injPolice > 10 ? 'bad' : 'ok', invert: true },
		];

	}

	score( win ) {

		const s2 = win && this.t < VERDICT, s3 = win && this.opinion >= 50 && this.counters.injPolice <= 10;
		return { stars: win + s2 + s3, lines: [
			[ 'Time', fmt( this.t ) ], [ 'Banner bearers', this.banner.bearers ], [ 'Public sympathy', Math.round( this.opinion ) ],
			[ 'Protesters injured', this.counters.injByPolice ], [ 'Treated by medics', this.counters.treated ?? 0 ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Arrested', this.counters.arrested ], [ 'Tear gas fired', this.ai.gasUsed ] ] };

	}

	draw( o ) {

		const ctx = o.ctx, B = this.banner, z = this.zone( 0 );
		this.drawZone( o, this.steps[ 0 ], this.steps[ 1 ], STEPS_R, this.flags.steps ? 'rgb(255,176,32)' : WHITE, `COURT STEPS · ${z} / ${STEPS_NEED}`, 0.06 );
		// the banner: a flag over its bearer, or a pulsing marker where it fell
		const [ x, y ] = o.toScreen( ...B.pos );
		if ( B.group ) {

			ctx.strokeStyle = ORANGE;
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( x, y - 26 ); ctx.stroke();
			ctx.fillStyle = ORANGE;
			ctx.beginPath(); ctx.moveTo( x, y - 26 ); ctx.lineTo( x + 18, y - 21 + Math.sin( this.t * 4 ) * 2 ); ctx.lineTo( x, y - 16 ); ctx.closePath(); ctx.fill();

		} else {

			const r = 10 + ( this.t * 2 % 1 ) * 12;
			ctx.strokeStyle = RED;
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.stroke();
			ctx.fillStyle = RED;
			ctx.font = '600 11px "IBM Plex Mono", monospace';
			ctx.textAlign = 'center';
			ctx.fillText( B.held > 0 ? `BANNER · police ${Math.ceil( 10 - B.held )} s` : 'BANNER', x, y - r - 4 );

		}

		// wind, top left
		ctx.fillStyle = 'rgba(217,226,220,0.8)';
		ctx.font = '600 12px "IBM Plex Mono", monospace';
		ctx.textAlign = 'left';
		ctx.fillText( `WIND ${this.windArrow} ${Math.hypot( ...this.world.wind ).toFixed( 1 )} m/s`, 16, 96 );
		this.ai.draw( o );

	}

}

// Police commander for the court march: cordons across Miklošičeva and a line on the steps, flank blocks,
// reserves at PP Ljubljana Center. Every move is announced a few seconds ahead (the livestream sees the vans
// move) and drawn as a dashed red ring with a countdown: gas, charges, kettles, snatches of the banner bearer.
class CourtPolice {

	constructor( m ) {

		this.m = m;
		this.W = m.world;
		this.gas = 6;
		this.gasUsed = 0;
		this.busy = new Set();
		this.pending = []; // { at, r, label, until }
		this.last = { gas: - 99, charge: - 99, kettle: - 99, snatch: - 99 };

	}

	async setup() {

		const W = this.W, M = W.marks, m = this.m, F = m.facade;
		const across = async ( p ) => {

			const c = W.roadSpot( ...p, 30 ) ?? p;
			const [ a, b ] = W.across( ...c );
			const sq = await squads( W, [ c, c ], 24 );
			await W.lineSquads( sq, a, b, null );
			return { at: c, a, b, squads: sq };

		};

		this.cordons = [ await across( onMiklosiceva( 110 ) ), await across( onMiklosiceva( 220 ) ) ];
		// the steps: a line along the façade, 12 m out
		const a = [ F.ax + F.nx * 12, F.ay + F.ny * 12 ], b = [ F.bx + F.nx * 12, F.by + F.ny * 12 ];
		const at = [ ( a[ 0 ] + b[ 0 ] ) / 2, ( a[ 1 ] + b[ 1 ] ) / 2 ];
		const sq = await squads( W, [ at, at ], 24 );
		await W.lineSquads( sq, a, b, null );
		this.cordons.push( { at, a, b, squads: sq, steps: true } );
		this.posts = new Map();
		this.flanks = await squads( W, [ [ 20, 285 ], [ 160, 330 ] ], 24 );
		this.reserves = await squads( W, [ M[ 'PP Ljubljana Center' ], M[ 'PP Ljubljana Center' ], [ 130, 200 ] ], 24 );
		for ( const s of [ ...this.flanks, ...this.reserves ] ) this.posts.set( s, s.anchor );
		for ( const c of this.cordons.slice( 0, 2 ) ) await W.patrols.add( { at: W.roadSpot( c.at[ 0 ] + 2, c.at[ 1 ] + 14, 20 ) ?? c.at, crew: 0, selectable: false, label: 'Police van' } );

	}

	// protesters within r of p: count and centroid
	crowdAt( p, r ) {

		const I = this.W.intel;
		let n = 0, sx = 0, sy = 0;
		for ( let i = 0; i < this.W.crowd.count; i ++ ) {

			if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
			const x = I.x( i ), y = I.y( i );
			if ( ( x - p[ 0 ] ) ** 2 + ( y - p[ 1 ] ) ** 2 > r * r ) continue;
			n ++; sx += x; sy += y;

		}

		return { n, c: n ? [ sx / n, sy / n ] : p };

	}

	// announce, then act: the player sees it coming
	tell( at, r, label, delay, fn ) {

		this.pending.push( { at, r, label, until: this.m.t + delay } );
		this.m.event( `Police: ${label} in ${delay} s`, 'warn', at );
		this.m.after( delay, () => { this.pending = this.pending.filter( ( p ) => p.until > this.m.t ); fn(); } );

	}

	free() { return [ ...this.reserves, ...this.flanks ].filter( ( s ) => ! this.busy.has( s ) && ( s.alive ?? 0 ) > 10 && s.center ); }

	release( team ) {

		for ( const s of team ) { this.busy.delete( s ); s.snatch = null; }
		for ( const s of team ) if ( this.posts.get( s ) ) this.W.moveSquads( [ s ], ...this.posts.get( s ) );

	}

	tick() {

		const m = this.m, W = this.W;
		if ( ! W.intel || m.t - ( this.lastTick ?? 0 ) < 4 ) return;
		this.lastTick = m.t;
		const B = m.banner, close = B.group && near( B.pos, m.steps, 170 ); // second stage: the banner is near the court

		for ( const c of this.cordons ) {

			if ( ! c.squads.some( ( s ) => ( s.alive ?? 0 ) > 5 ) ) continue;
			const { n, c: crowd } = this.crowdAt( c.at, 30 );
			// gas on a pressed cordon, thrown toward the crowd's middle
			if ( n > 150 && this.gas > 0 && m.t - this.last.gas > 35 ) {

				this.last.gas = m.t;
				this.gas --;
				const p = [ c.at[ 0 ] + ( crowd[ 0 ] - c.at[ 0 ] ) * 0.6, c.at[ 1 ] + ( crowd[ 1 ] - c.at[ 1 ] ) * 0.6 ];
				this.tell( p, 20, 'tear gas', 6, () => {

					W.gas( ...p );
					this.gasUsed ++;
					m.nudgeOpinion( 1.5, 'tear gas on camera' );
					m.event( 'Tear gas fired into the march', 'bad', p );

				} );
				break;

			}

			// once the banner is close: a hard-pressed line charges 20 m into the crowd, then re-forms
			if ( close && n > 220 && m.t - this.last.charge > 60 && ! c.squads.some( ( s ) => this.busy.has( s ) ) ) {

				this.last.charge = m.t;
				this.tell( crowd, 15, 'baton charge', 6, () => {

					c.squads.forEach( ( s ) => this.busy.add( s ) );
					W.charge( c.squads, ...crowd );
					m.after( 12, () => { c.squads.forEach( ( s ) => this.busy.delete( s ) ); W.lineSquads( c.squads, c.a, c.b, W.intel?.pos ); } );

				} );
				break;

			}

		}

		// snatch squads go for the banner bearer when one is close
		const free = this.free();
		if ( B.group && m.t - this.last.snatch > 40 ) {

			const s = free.find( ( q ) => near( q.center, B.pos, 80 ) );
			if ( s ) {

				this.last.snatch = m.t;
				this.busy.add( s );
				this.tell( B.pos, 10, 'snatch squad for the banner bearer', 5, () => {

					if ( ! B.group ) { this.release( [ s ] ); return; }
					s.snatch = B.group;
					W.arrest( [ s ], ...B.pos );
					m.after( 40, () => this.release( [ s ] ) );

				} );

			}

		}

		// isolated groups (or the banner bloc on its own) get kettled by two free squads
		if ( m.t - this.last.kettle > 60 ) {

			const team = this.free().slice( 0, 2 );
			const lone = W.groupsOf( FACTION.PROTESTER ).filter( ( g ) => g.center && ( g.alive ?? 0 ) > 20 && g.kind !== 'medics'
				&& this.crowdAt( g.center, 40 ).n < 170 && team.length === 2 && team.every( ( q ) => near( q.center, g.center, 160 ) ) );
			const g = lone.find( ( q ) => q === B.group ) ?? pick( lone );
			if ( g ) {

				this.last.kettle = m.t;
				team.forEach( ( s ) => this.busy.add( s ) );
				const at = g.center;
				this.tell( at, 18, `kettle around ${g.label}`, 8, () => {

					W.kettle( team, ...g.center, 16, W.intel.pos );
					m.after( 90, () => this.release( team ) );

				} );

			}

		}

	}

	draw( o ) {

		this.pending = this.pending.filter( ( p ) => p.until > this.m.t );
		drawPending( o, this.pending, this.m.t );

	}

}
