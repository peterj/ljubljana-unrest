import {
	Mission, FACTION, MODE, fmt, rand, pick,
	ORANGE, RED, inPoly, near, ringDist, cars, squads,
} from '../sdk/index.ts';

// ======================================================================================= BLACKBLOC
// A peaceful rally with a BlackBloc inside it. The cells look like everyone else until they mask up for
// an action. Their actions come on a countdown in a random order and end with three fires that cannot be
// stopped. The player is scored on the people around them: ordinary protesters hurt, BlackBloc detained.

const BLOC_FIRES = [ [ 'Frančiškanska cerkev', 'the Franciscan church' ], [ 'Državni zbor', 'the Assembly' ], [ 'Vlada RS', 'the Government building' ] ];
const BLOC_ACTS = [ 'stones', 'stones', 'flares', 'smash', 'smash', 'push' ];
const LEAD = 40, LEAD_SMASH = 80, LEAD_FIRE = 60; // seconds a cell is masked and moving before its action
const NORMAL_MAX = 200; // ordinary protesters hurt: the operation is called off
const BLOC_STAR = 35;
// police force near the crowd: radius, agitation added to every ordinary group in it
const OUTRAGE: Record<string, [ number, number, string ]> = { c: [ 45, 0.15, 'Baton charge' ], k: [ 50, 0.2, 'Kettle' ], g: [ 60, 0.2, 'Tear gas' ], w: [ 50, 0.15, 'Water cannon' ], s: [ 40, 0.12, 'Shield push' ] };

// a street spot just off the longest façade of a footprint ring
function facadeSpot( W, ring, pos ) {

	let best = null, bl = 0;
	for ( let k = 0; k < ring.length; k += 2 ) {

		const ax = ring[ k ], ay = ring[ k + 1 ], bx = ring[ ( k + 2 ) % ring.length ], by = ring[ ( k + 3 ) % ring.length ];
		const len = Math.hypot( bx - ax, by - ay ), mx = ( ax + bx ) / 2, my = ( ay + by ) / 2;
		const dx = mx - pos[ 0 ], dy = my - pos[ 1 ], l = Math.hypot( dx, dy ) || 1;
		const p = [ mx + dx / l * 6, my + dy / l * 6 ];
		if ( len > bl && W.sdf( ...p ) > 1 && W.cost( ...p ) <= 12 ) { bl = len; best = p; }

	}

	return best ?? W.spot( pos[ 0 ], pos[ 1 ], 30 );

}

export class BlackBloc extends Mission {

	declare focus: [ number, number ];
	declare zoom: number;
	declare waterOpinion: number;
	declare fires: number;
	declare smashed: number;
	declare hurt: any;
	declare innocent: number;
	declare blocHeld: number;
	declare blocDown: number;
	declare throws: any;
	declare buildings: any[];
	declare sites: any;
	declare sq: any;
	declare rallies: any[][];
	declare normalGroups: any[];
	declare cells: any[];
	declare blocTotal: any;
	declare acts: any;
	declare endAt: any;
	declare lastViolence: number;
	declare _intel: any;
	declare _arr: any;

	static id = 'blackbloc';
	static title = 'BlackBloc';
	static subtitle = 'Infiltrators in a peaceful rally · three fires are coming';
	static side = 'police';
	static brief = `Several thousand people rally peacefully on <b>Trg republike</b>, <b>Prešernov trg</b> and in front of the
		Government. Hidden among them is a <b>BlackBloc</b>: about a hundred people in small cells who came to make the police
		hit the crowd. They look like everyone else until they mask up. Intelligence has their countdown but not the order:
		stones and flares at your lines, smashed shop fronts, pushes against the cordons, and three arsons:
		<b>Frančiškanska cerkev</b>, the <b>National Assembly</b> and <b>Vlada</b>. The fires cannot be prevented. The people
		around them can be protected. The crowd does not know who is among them: every blow that lands on an ordinary
		protester turns their neighbours against you.`;
	static goals = [ 'Get through the night: it ends when the third building burns', `Fewer than ${NORMAL_MAX} ordinary protesters hurt, opinion above 10`,
		`★ Detain or disable ≥ ${BLOC_STAR} of the BlackBloc · ★ ≤ 30 ordinary protesters hurt, opinion ≥ 40` ];
	static tips = [ 'Masked cells show as black dots. Seen by CCTV while masked, they stay tagged: Snatch (X) them later, when the crowd is calm',
		'Charges, kettles, gas and water anger every ordinary group nearby, and so does every protester your officers hurt',
		'Stones and flares make officers jumpy. A line out of contact cannot hit anyone: step back rather than charge into the crowd',
		'Before a fire, get people away from the building: B sends calm groups home (it costs opinion while all is quiet)',
		'Arrest (A) is slow but gentle. In a dense crowd it mostly detains the innocent' ];

	async setup() {

		const W = this.world, P = W.places, M = W.marks, T = this.city.targets;
		await W.exits();
		this.focus = [ - 250, - 70 ];
		this.zoom = 0.75;
		this.opinion = 60;
		this.resources = { gas: { left: 4, max: 4 }, water: { left: 4, max: 4 }, reinforce: { left: 3, max: 3 }, order: { left: 99, max: 99, cooldown: 15, ready: 0 } };
		this.waterOpinion = - 2;
		this.fires = 0;
		this.smashed = 0;
		this.hurt = { all: 0, police: 0 };
		this.innocent = 0;
		this.blocHeld = 0;
		this.blocDown = 0;
		this.throws = [];

		// the three targets: footprint rings and a façade spot to attack from (one pinned field each)
		const church = M[ 'Frančiškanska cerkev' ];
		const fp = this.city.buildings.find( ( b ) => inPoly( b.p[ 0 ], ...( church as [ number, number ] ) ) );
		this.buildings = [];
		for ( const [ name, short ] of BLOC_FIRES ) {

			const t = T[ name ], pos = t ? t.pos : church;
			const rings = t ? t.poly.map( ( p ) => p[ 0 ] ) : [ fp.p[ 0 ] ];
			let r = 0;
			for ( const ring of rings ) for ( let k = 0; k < ring.length; k += 2 ) r = Math.max( r, Math.hypot( ring[ k ] - pos[ 0 ], ring[ k + 1 ] - pos[ 1 ] ) );
			const at = facadeSpot( W, rings[ 0 ], pos );
			this.buildings.push( { name, short, pos, rings, r, at } );

		}

		// shop fronts to smash; targets get their flow fields only when a cell heads there (the pool has 32)
		this.sites = [ [ 'Čopova', [ - 138, 24 ] ], [ 'Nebotičnik', M[ 'Nebotičnik' ] ], [ 'Slovenska', [ - 330, - 240 ] ], [ 'Mestni trg', P[ 'Mestni trg' ] ] ]
			.map( ( [ name, at ] ) => ( { name, at: W.spot( at[ 0 ], at[ 1 ], 8 ) } ) );

		// the rally: three crowds, each next to one of the targets
		const V = this.buildings[ 2 ], dx = V.at[ 0 ] - V.pos[ 0 ], dy = V.at[ 1 ] - V.pos[ 1 ], dl = Math.hypot( dx, dy ) || 1;
		const picket = W.spot( V.at[ 0 ] + dx / dl * 22, V.at[ 1 ] + dy / dl * 22, 10 );
		this.sq = P[ 'Trg republike' ];
		// where crowds stand, with goal radii: crowds drifting between them share these four fields
		this.rallies = [ [ this.sq, 45 ], [ P[ 'Prešernov trg' ], 30 ], [ picket, 20 ], [ P[ 'Kongresni trg' ], 35 ] ];
		this.normalGroups = [];
		const crowds = [];
		for ( const [ label, n, [ at, r ] ] of [ [ 'Trg republike rally', 2000, this.rallies[ 0 ] ], [ 'Prešernov trg rally', 900, this.rallies[ 1 ] ], [ 'Gregorčičeva picket', 500, this.rallies[ 2 ] ] ] as [ string, number, any[] ][] ) {

			const groups = await W.bloc( { kind: 'crowd', label, at, n, groupSize: 50, spread: r, goal: at, goalR: r, mode: MODE.HOLD, agitation: [ 0.05, 0.25 ], morale: 0.6, resolve: [ 0.6, 1.1 ] } );
			for ( const g of groups ) g.rally = this.rallies.find( ( q ) => q[ 0 ] === at ); // [ at, r ] (World.march overwrites g.goal)
			this.normalGroups.push( ...groups );
			crowds.push( { at, r, groups } );

		}

		// the BlackBloc: one arson cell in each crowd (so each fire has a team close by), six smaller cells anywhere
		this.cells = [];
		const cell = async ( crowd, n, role ) => {

			const host = pick( crowd.groups );
			const [ c ] = await W.bloc( { kind: 'bloc', label: host.label, at: crowd.at, n, groupSize: n, spread: crowd.r, layer: host.layer, mode: MODE.HOLD,
				agitation: [ 0.3, 0.45 ], morale: 0.9, resolve: [ 1.0, 1.3 ] } );
			Object.assign( c, { role, host } );
			this.cells.push( c );

		};

		for ( const crowd of crowds ) await cell( crowd, 15, 'arson' );
		for ( let k = 0; k < 6; k ++ ) await cell( crowds[ k % 2 ], 10, 'provoke' );
		this.blocTotal = this.cells.reduce( ( s, c ) => s + c.members.length, 0 );

		// nobody starts in contact with the crowd (officers in contact hurt people): Vlada's two squads wait on
		// the streets round the building farthest from the picket
		const A = T[ 'Državni zbor' ].pos, Vp = V.pos;
		const round = [ ...Array( 12 ).keys() ].map( ( k ) => W.roadSpot( Vp[ 0 ] + Math.cos( k * Math.PI / 6 ) * ( V.r + 20 ), Vp[ 1 ] + Math.sin( k * Math.PI / 6 ) * ( V.r + 20 ) ) )
			.filter( Boolean ).sort( ( a, b ) => Math.hypot( b[ 0 ] - picket[ 0 ], b[ 1 ] - picket[ 1 ] ) - Math.hypot( a[ 0 ] - picket[ 0 ], a[ 1 ] - picket[ 1 ] ) );
		await squads( W, [ [ A[ 0 ] + 15, A[ 1 ] + 35 ], [ A[ 0 ] + 40, A[ 1 ] + 15 ], round[ 0 ], round[ 1 ],
			[ - 60, 30 ], M[ 'PU Ljubljana' ], M[ 'PU Ljubljana' ], M[ 'Cankarjev dom' ], P[ 'Kongresni trg' ] ] );
		await cars( W, [ M[ 'PU Ljubljana' ], [ - 300, - 330 ] ] );
		await W.patrols.add( { at: [ M[ 'PU Ljubljana' ][ 0 ] + 15, M[ 'PU Ljubljana' ][ 1 ] ], water: true } );
		await this.bystanders( 1500 );

		// the countdown: provocations and fires shuffled, the last one always a fire
		const acts: any[] = [ ...BLOC_ACTS.map( ( kind ) => ( { kind } ) ), ...this.buildings.map( ( b ) => ( { kind: 'fire', b } ) ) ];
		for ( let k = acts.length - 1; k > 0; k -- ) {

			const j = Math.floor( Math.random() * ( k + 1 ) );
			[ acts[ k ], acts[ j ] ] = [ acts[ j ], acts[ k ] ];

		}

		const lastFire = acts.findLastIndex( ( a ) => a.kind === 'fire' );
		[ acts[ lastFire ], acts[ acts.length - 1 ] ] = [ acts[ acts.length - 1 ], acts[ lastFire ] ];
		let t = rand( 100, 125 );
		for ( const a of acts ) { a.t = t; t += rand( 65, 110 ); }
		this.acts = acts;
		this.endAt = acts.at( - 1 ).t + 45;

	}

	start() {

		this.after( 2, () => this.event( `Intelligence: a BlackBloc of ~${Math.round( this.blocTotal / 10 ) * 10} is hiding in the crowds. First action in ${fmt( this.acts[ 0 ].t - this.t )}.`, 'warn', this.sq ) );
		for ( const a of this.acts ) {

			this.after( a.t - ( a.kind === 'fire' ? LEAD_FIRE : a.kind === 'smash' ? LEAD_SMASH : LEAD ), () => this.prepare( a ) );
			this.after( a.t, () => this.strike( a ) );

		}

	}

	normal() { return this.normalGroups.filter( ( g ) => ( g.alive ?? 1 ) > 0 && ! g.home ); }

	commands() {

		// force near the crowd angers everyone around it, guilty or not
		return [ ...this.policeCommands().map( ( c ) => {

			const o = OUTRAGE[ c.key ];
			if ( ! o ) return c;
			return { ...c, run: ( x, y ) => {

				const left = c.resource ? this.resources[ c.resource ].left : 0;
				const r = c.run( x, y );
				if ( ! c.resource || this.resources[ c.resource ].left < left ) this.outrage( x, y, ...o );
				return r;

			} };

		} ), { key: 'b', label: 'Dispersal order', resource: 'order', run: ( x, y ) => this.order( x, y ) } ];

	}

	outrage( x, y, r, d, why ) {

		let n = 0;
		for ( const g of this.normal() ) {

			if ( ! g.center || ! near( g.center, [ x, y ], r ) ) continue;
			for ( const i of g.members ) this.crowd.nudge( i, d, 0 );
			n += g.alive ?? 0;

		}

		if ( n > 50 && this.t - ( this.flags.outrageMsg ?? - 99 ) > 12 ) {

			this.flags.outrageMsg = this.t;
			this.event( `${why} into the rally: ~${n} people around it turn on the police`, 'warn', [ x, y ] );

		}

	}

	order( x, y ) {

		if ( ! this.spend( 'order' ) ) return;
		const home = this.dispersal( x, y, 70, { calm: 0.4, chance: 0.3 } );
		// with nothing happening it looks like breaking up a lawful rally
		if ( home > 0 && this.t - ( this.lastViolence ?? - 999 ) > 60 && ! this.buildings.some( ( b ) => b.due ) ) this.nudgeOpinion( - 2, 'dispersing a peaceful rally' );
		this.event( `Dispersal order: ~${home} people leaving`, home ? 'good' : 'info', [ x, y ] );

	}

	opinionWeights() {

		// arrests are scored per group (innocent or BlackBloc) in perIntel
		return { injByPolice: - 0.35, injPolice: 0.25, arrested: 0, arrestedSitters: 0, injOther: - 0.05 };

	}

	// a free cell for an action: the preferred role first, nearest to the target if there is one
	pickCell( role, at? ) {

		const ok = this.cells.filter( ( c ) => ! c.busy && ! c.broken && ( c.alive ?? c.members.length ) >= 3 && c.center );
		const pref = ok.filter( ( c ) => c.role === role );
		const list = pref.length ? pref : ok;
		if ( ! list.length ) return null;
		if ( ! at ) return pick( list );
		return list.reduce( ( a, b ) => ( Math.hypot( a.center[ 0 ] - at[ 0 ], a.center[ 1 ] - at[ 1 ] ) < Math.hypot( b.center[ 0 ] - at[ 0 ], b.center[ 1 ] - at[ 1 ] ) ? a : b ) );

	}

	mask( c, a ) {

		c.masked = true;
		c.busy = a;
		this.crowd.setGroup( c.id, { speed: 1.35 } ); // masked, they run
		for ( const i of c.members ) this.crowd.nudge( i, 0.35, 0.3 );

	}

	prepare( a ) {

		const W = this.world;
		if ( a.kind === 'fire' ) {

			const b = a.b;
			this.after( LEAD_FIRE - 20, () => { b.due = a.t; this.event( `Fuel canisters spotted: they are going for ${b.short}! Get people away from it.`, 'bad', b.pos ); } );
			const c = a.cell = this.pickCell( 'arson', b.pos );
			if ( ! c ) return;
			this.mask( c, a );
			W.march( [ c ], ...b.at, 8 );
			this.event( `A group is masking up inside the ${c.host.label} and moving off`, 'warn', c.center );
			return;

		}

		const c = a.cell = this.pickCell( 'provoke' );
		if ( ! c ) return;
		this.mask( c, a );
		if ( a.kind === 'smash' ) {

			a.site = this.sites.reduce( ( p, q ) => ( Math.hypot( p.at[ 0 ] - c.center[ 0 ], p.at[ 1 ] - c.center[ 1 ] ) < Math.hypot( q.at[ 0 ] - c.center[ 0 ], q.at[ 1 ] - c.center[ 1 ] ) ? p : q ) );
			W.march( [ c ], ...a.site.at, 8 );

		}

		this.event( `A group is masking up inside the ${c.host.label}`, 'warn', c.center );

	}

	strike( a ) {

		const W = this.world;
		a.done = true;
		this.lastViolence = this.t;
		const c = a.cell && ! a.cell.broken && ( a.cell.alive ?? 0 ) >= 2 ? a.cell : null;
		if ( a.kind === 'fire' ) {

			const b = a.b;
			this.ignite( b );
			const there = c && near( c.center, b.pos, b.r + 45 );
			this.event( there ? `${b.name} is on fire. The masked group is slipping back into the crowd.` : `${b.name} is on fire: a second team was already inside.`, 'bad', b.pos );
			if ( c ) this.after( 12, () => this.rejoin( c ) );
			return;

		}

		if ( ! c ) { this.event( 'Intelligence: the BlackBloc has lost the people for its next action', 'good' ); return; }
		let back = 30;
		if ( a.kind === 'stones' || a.kind === 'flares' ) {

			const stones = a.kind === 'stones';
			c.volley = stones ? { until: this.t + 25, rate: 1.5, hit: 0.06, stress: 0.1 } : { until: this.t + 15, rate: 2.2, hit: 0.03, stress: 0.2, flare: true };
			back = stones ? 50 : 35;
			this.event( stones ? `Stones thrown at the police from inside the ${c.host.label}` : `Flares fired into the police line from the ${c.host.label}`, 'bad', c.center );

		} else if ( a.kind === 'smash' ) {

			const s = a.site;
			if ( ! near( c.center, s.at, 50 ) ) this.event( `The masked group never reached ${s.name}`, 'good', s.at );
			else if ( W.countNear( ...s.at, 30, FACTION.POLICE ) >= 6 ) this.event( `Police at ${s.name}: the masked group turns away`, 'good', s.at );
			else {

				s.hit = true;
				this.smashed ++;
				this.game.sound?.smash( s.at );
				this.event( `${s.name}: bank and shop windows smashed`, 'bad', s.at );

			}

		} else {

			// push: the front rows of the crowd around the cell are shoved into the nearest police line
			const hosts = this.normal().filter( ( g ) => g.center && near( g.center, c.center, 45 ) );
			for ( const g of hosts ) for ( const i of g.members ) this.crowd.nudge( i, 0.35, 0.1 );
			W.setMode( [ c, ...hosts ], MODE.RIOT );
			this.event( `Masked people shove the ${c.host.label} toward the police`, 'bad', c.center );

		}

		this.after( back, () => this.rejoin( c ) );

	}

	// unmask and melt back into the nearest ordinary crowd
	rejoin( c ) {

		if ( c.broken ) return;
		const hosts = this.normal().filter( ( g ) => g.center && ( g.alive ?? 0 ) > 10 );
		c.busy = null;
		c.volley = null;
		c.masked = false;
		this.crowd.setGroup( c.id, { speed: 1 } );
		if ( ! hosts.length || ! c.center ) return;
		c.host = hosts.reduce( ( a, b ) => ( Math.hypot( a.center[ 0 ] - c.center[ 0 ], a.center[ 1 ] - c.center[ 1 ] ) < Math.hypot( b.center[ 0 ] - c.center[ 0 ], b.center[ 1 ] - c.center[ 1 ] ) ? a : b ) );
		this.world.setLayer( c, c.host.layer );
		this.world.setMode( [ c ], MODE.HOLD );
		for ( const i of c.members ) this.crowd.nudge( i, - 0.25, 0 );

	}

	ignite( b ) {

		b.burning = true;
		b.litAt = this.t;
		this.game.sound?.fire( b, b.pos );
		b.due = null;
		this.fires ++;
		// people close by run: calm groups go home, the rest are wound up
		for ( const g of this.world.groups ) {

			if ( g.faction === FACTION.POLICE || g.kind === 'bloc' || ! g.center || ! near( g.center, b.pos, b.r + 70 ) ) continue;
			if ( g.faction === FACTION.PROTESTER && ! g.home && Math.random() < 0.6 ) this.sendHome( g );
			else for ( const i of g.members ) this.crowd.nudge( i, 0.3, 0 );

		}

	}

	tick( dt ) {

		const I = this.world.intel;
		if ( I && I !== this._intel ) { this._intel = I; this.perIntel( I ); }
		this.volleys( dt );
		this.ai();
		const all = this.hurt.all;
		for ( const m of [ 25, 50, 100, 150 ] ) if ( all >= m && ! this.flags[ 'h' + m ] ) { this.flags[ 'h' + m ] = true; this.event( `${m} ordinary protesters hurt`, 'bad' ); }

		if ( all >= NORMAL_MAX ) this.end( false, 'Hundreds of ordinary protesters hurt. The BlackBloc got the pictures it came for; the operation is called off.' );
		else if ( this.opinion < 10 ) this.end( false, 'The public blames the police for the night. The minister orders a withdrawal.' );
		else if ( this.t >= this.endAt ) this.end( true, 'Three buildings burned, as planned. What the cameras show around them is your doing.' );

	}

	// once per readback: who is hurt or detained, CCTV tags, burns around the fires
	perIntel( I ) {

		const W = this.world;
		let all = 0, byPolice = 0, innocent = 0;
		for ( const g of this.normalGroups ) {

			let h = 0, hp = 0;
			for ( const i of g.members ) {

				const f = I.faction( i );
				if ( f > 9.5 ) { h ++; if ( f < 19.5 ) hp ++; } else if ( f === FACTION.ARRESTED ) innocent ++;

			}

			// the crowd sees its own people beaten: the group and its neighbours turn on the police
			const fresh = hp - ( g.hurtByPolice ?? 0 );
			if ( fresh > 0 ) {

				const d = Math.min( 0.3, 0.08 * fresh );
				for ( const i of g.members ) this.crowd.nudge( i, d, 0 );
				for ( const q of this.normalGroups ) if ( q !== g && q.center && g.center && near( q.center, g.center, 40 ) ) for ( const i of q.members ) this.crowd.nudge( i, d / 3, 0 );

			}

			g.hurtByPolice = hp;
			all += h;
			byPolice += hp;

		}

		this.hurt = { all, police: byPolice };
		let held = 0, down = 0;
		for ( const c of this.cells ) for ( const i of c.members ) {

			const f = I.faction( i );
			if ( f === FACTION.ARRESTED ) held ++;
			else if ( f > 9.5 ) down ++;

		}

		// arrests: of the innocent cost, of the BlackBloc earn (shown in chunks like the base opinion)
		this._arr = ( this._arr ?? 0 ) - 0.6 * Math.max( 0, innocent - this.innocent ) + 0.2 * Math.max( 0, held - this.blocHeld );
		if ( Math.abs( this._arr ) >= 1 ) { this.nudgeOpinion( Math.trunc( this._arr ), this._arr < 0 ? 'innocent people detained' : 'BlackBloc detained' ); this._arr %= 1; }
		if ( innocent >= 5 && ! this.flags.innoMsg ) { this.flags.innoMsg = true; this.event( 'Peaceful protesters are being detained: the footage is everywhere', 'bad' ); }
		for ( const m of [ 1, 10, 25, 50 ] ) if ( held + down >= m && ! this.flags[ 'b' + m ] ) { this.flags[ 'b' + m ] = true; this.event( m === 1 ? 'First BlackBloc member detained or down' : `${m} of the BlackBloc detained or down`, 'good' ); }
		this.innocent = innocent;
		this.blocHeld = held;
		this.blocDown = down;

		// masked under a camera: tagged for good, and their leader can be snatched
		for ( const c of this.cells ) {

			if ( ! c.masked || c.tagged || ! c.center || W.cctv( ...c.center ) <= 0 ) continue;
			c.tagged = true;
			c.identified = true;
			c.label = `BlackBloc cell ${this.cells.indexOf( c ) + 1}`;
			this.event( 'CCTV tagged a masked BlackBloc cell. It stays marked after they unmask: snatch them (X) when the crowd is calm', 'info', c.center );

		}

		// smoke and burning debris close to a fire in its first 45 s
		for ( const b of this.buildings ) {

			if ( ! b.burning || this.t - b.litAt > 45 ) continue;
			for ( let i = 0; i < this.crowd.count; i ++ ) {

				const f = I.faction( i ), x = I.x( i ), y = I.y( i );
				if ( f < 0 || f > 3.5 || ( x - b.pos[ 0 ] ) ** 2 + ( y - b.pos[ 1 ] ) ** 2 > ( b.r + 10 ) ** 2 ) continue;
				if ( Math.random() < 0.02 && b.rings.some( ( r ) => ringDist( r, x, y ) < 6 ) ) this.crowd.setFaction( i, 20 + f );

			}

		}

	}

	// stones and flares from a masked cell inside the crowd at police within throwing range
	volleys( dt ) {

		const I = this.world.intel;
		this.throws = this.throws.filter( ( s ) => this.t - s.t < 0.8 );
		if ( ! I ) return;
		for ( const c of this.cells ) {

			const v = c.volley;
			if ( ! v || this.t > v.until || ! c.center || ( c.alive ?? 0 ) < 2 || Math.random() > dt * v.rate ) continue;
			const [ cx, cy ] = c.center, targets = [];
			for ( let i = 0; i < this.crowd.count; i ++ ) {

				if ( I.faction( i ) !== FACTION.POLICE ) continue;
				const d = Math.hypot( I.x( i ) - cx, I.y( i ) - cy );
				if ( d > 5 && d < 28 ) targets.push( i );

			}

			if ( ! targets.length ) {

				// nobody in range: go and find a line (and leave the crowd's cover doing it)
				if ( ! v.closing ) {

					v.closing = true;
					v.until += 20;
					const pol = this.world.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center );
					const q = pol.length && pol.reduce( ( a, b ) => ( Math.hypot( a.center[ 0 ] - cx, a.center[ 1 ] - cy ) < Math.hypot( b.center[ 0 ] - cx, b.center[ 1 ] - cy ) ? a : b ) );
					if ( q ) this.world.march( [ c ], ...q.center, 15 );

				}

				continue;

			}

			const i = pick( targets ), to = [ I.x( i ), I.y( i ) ];
			this.throws.push( { from: [ cx, cy ], to, t: this.t, flare: v.flare } );
			this.game.sound?.projectile( [ cx, cy ], to, v.flare );
			if ( Math.random() < v.hit ) this.crowd.setFaction( i, 21 ); // officer hurt, by others
			// officers under a barrage get jumpy; the crowd the stones came from gets excited
			for ( let j = 0; j < this.crowd.count; j ++ ) if ( I.faction( j ) === FACTION.POLICE && Math.hypot( I.x( j ) - to[ 0 ], I.y( j ) - to[ 1 ] ) < 6 ) this.crowd.nudge( j, v.stress, 0 );
			for ( const g of this.normalGroups ) if ( g.center && near( g.center, c.center, 30 ) ) for ( const k of g.members ) this.crowd.nudge( k, 0.015, 0 );

		}

	}

	// every 8 s: keep the cells determined and hidden, let the ordinary crowds drift and react
	ai() {

		const W = this.world;
		if ( ! W.intel || this.t - ( this.flags.ai ?? 0 ) < 8 ) return;
		this.flags.ai = this.t;
		for ( const c of this.cells ) {

			if ( c.broken ) continue;
			// most of the cell detained or down: the rest slip away
			if ( ( c.alive ?? 0 ) < 3 ) {

				c.broken = true;
				c.masked = false;
				c.volley = null;
				for ( const i of c.members ) this.crowd.nudge( i, - 0.3, - 2 );
				continue;

			}

			// determined: gas, water and blows do not send them home
			for ( const i of c.members ) this.crowd.nudge( i, c.masked ? 0.15 : 0, 0.25 );
			if ( c.busy ) continue;
			if ( ! c.host || c.host.home || ! c.host.alive ) { this.rejoin( c ); continue; }
			if ( c.layer !== c.host.layer ) { W.setLayer( c, c.host.layer ); W.setMode( [ c ], MODE.HOLD ); }

		}

		const police = W.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center );
		for ( const g of this.normal() ) {

			if ( ! g.center ) continue;
			if ( g.mode !== MODE.RIOT && g.agitation > 0.75 && police.some( ( q ) => near( q.center, g.center, 30 ) ) ) {

				W.setMode( [ g ], MODE.RIOT );
				if ( this.t - ( this.flags.riotMsg ?? - 99 ) > 20 ) { this.flags.riotMsg = this.t; this.event( `Part of the ${g.label} is fighting the police`, 'bad', g.center ); }

			} else if ( g.mode === MODE.RIOT && g.agitation < 0.35 ) W.march( [ g ], ...g.rally[ 0 ], g.rally[ 1 ] );
			else if ( g.mode !== MODE.RIOT && Math.random() < 0.03 ) { g.rally = pick( this.rallies ); W.march( [ g ], ...g.rally[ 0 ], g.rally[ 1 ] ); }

		}

	}

	next() { return this.acts.find( ( a ) => ! a.done ); }

	phase() {

		const a = this.next();
		if ( ! a ) return `All three buildings are burning · the night ends in ${fmt( this.endAt - this.t )}`;
		return `Next BlackBloc action in ${fmt( a.t - this.t )} · fires ${this.fires}/3 · ${this.hurt.all} protesters hurt`;

	}

	objectives() {

		const a = this.next(), all = this.hurt.all, bloc = this.blocHeld + this.blocDown;
		return [
			{ label: `Fires ${this.fires}/3`, value: Math.min( 1, this.t / this.endAt ), text: a ? `next action ${fmt( a.t - this.t )}` : `ends ${fmt( this.endAt - this.t )}`, state: this.buildings.some( ( b ) => b.due ) ? 'bad' : 'warn' },
			{ label: 'Ordinary protesters hurt', value: Math.min( 1, all / NORMAL_MAX ), text: `${all} / ${NORMAL_MAX}`, state: all > NORMAL_MAX * 0.6 ? 'bad' : all > 30 ? 'warn' : 'ok', invert: true },
			{ label: `★ BlackBloc detained or down ≥ ${BLOC_STAR}`, value: Math.min( 1, bloc / BLOC_STAR ), text: `${bloc} of ${this.blocTotal}`, state: bloc >= BLOC_STAR ? 'done' : 'ok' },
			{ label: '★ Protesters hurt ≤ 30, opinion ≥ 40', value: Math.min( 1, all / 30 ), text: `${all} · ${Math.round( this.opinion )}`, state: all > 30 || this.opinion < 40 ? 'bad' : all > 20 ? 'warn' : 'ok', invert: true },
		];

	}

	score( win ) {

		const bloc = this.blocHeld + this.blocDown, all = this.hurt.all;
		const s2 = win && bloc >= BLOC_STAR, s3 = win && all <= 30 && this.opinion >= 40;
		return { stars: win + s2 + s3, lines: [
			[ 'BlackBloc detained', `${this.blocHeld} of ${this.blocTotal}` ], [ 'BlackBloc injured', this.blocDown ],
			[ 'Ordinary protesters hurt', `${all} (${this.hurt.police} by police)` ], [ 'Innocent people detained', this.innocent ],
			[ 'Officers injured', this.counters.injPolice ], [ 'Shop fronts smashed', `${this.smashed} of ${this.sites.length}` ],
			[ 'Tear gas used', this.counters.gas ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const ctx = o.ctx, I = this.world.intel;
		ctx.font = '600 11px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		for ( const b of this.buildings ) {

			ctx.beginPath();
			for ( const r of b.rings ) {

				for ( let k = 0; k < r.length; k += 2 ) { const [ x, y ] = o.toScreen( r[ k ], r[ k + 1 ] ); k ? ctx.lineTo( x, y ) : ctx.moveTo( x, y ); }
				ctx.closePath();

			}

			if ( b.burning ) {

				ctx.fillStyle = `rgba(255,${70 + Math.floor( Math.random() * 70 )},20,${0.35 + Math.random() * 0.25})`;
				ctx.fill();

			}

			ctx.setLineDash( b.burning || b.due ? [] : [ 5, 5 ] );
			ctx.strokeStyle = b.burning || b.due ? RED : ORANGE;
			ctx.lineWidth = b.due ? 2.5 : 1.5;
			ctx.stroke();
			ctx.setLineDash( [] );
			if ( b.due ) this.drawZone( o, b.pos[ 0 ], b.pos[ 1 ], b.r + 25 + Math.sin( this.t * 4 ) * 3, RED, null, 0.05 );
			const [ lx, ly ] = o.toScreen( b.pos[ 0 ], b.pos[ 1 ] + b.r + 8 );
			ctx.fillStyle = b.burning || b.due ? RED : ORANGE;
			ctx.fillText( b.burning ? `${b.name.toUpperCase()} · BURNING` : b.due ? `${b.name.toUpperCase()} · ${fmt( b.due - this.t )}` : b.name.toUpperCase(), lx, ly );
			if ( ! b.burning ) continue;
			// smoke drifting north-east
			for ( let k = 0; k < 10; k ++ ) {

				const f = ( this.t * 0.12 + k / 10 ) % 1, d = f * 120;
				const [ x, y ] = o.toScreen( b.pos[ 0 ] + d * 0.8 + Math.sin( k * 2.1 + this.t * 0.3 ) * 8, b.pos[ 1 ] + d * 0.6 + Math.cos( k * 1.7 ) * 8 );
				ctx.beginPath();
				ctx.arc( x, y, ( 6 + f * 30 ) / o.mpp, 0, Math.PI * 2 );
				ctx.fillStyle = `rgba(110,108,112,${0.22 * ( 1 - f )})`;
				ctx.fill();

			}

		}

		for ( const s of this.sites ) {

			if ( ! s.hit ) continue;
			const [ x, y ] = o.toScreen( ...s.at );
			ctx.beginPath();
			ctx.arc( x, y, 4, 0, Math.PI * 2 );
			ctx.fillStyle = RED;
			ctx.fill();

		}

		ctx.lineWidth = 1.5;
		for ( const s of this.throws ) {

			const k = Math.min( 1, ( this.t - s.t ) / 0.6 );
			const [ ax, ay ] = o.toScreen( ...s.from ), [ bx, by ] = o.toScreen( ...s.to );
			ctx.strokeStyle = s.flare ? 'rgba(255,176,32,0.95)' : 'rgba(255,45,85,0.85)';
			ctx.beginPath();
			ctx.moveTo( ax + ( bx - ax ) * Math.max( 0, k - 0.3 ), ay + ( by - ay ) * Math.max( 0, k - 0.3 ) );
			ctx.lineTo( ax + ( bx - ax ) * k, ay + ( by - ay ) * k );
			ctx.stroke();

		}

		// masked cells: every member as a black dot; tagged cells keep a ring after they unmask
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		for ( const c of this.cells ) {

			if ( c.broken || ! c.center || ! ( c.masked || c.tagged ) ) continue;
			if ( c.masked && I ) {

				for ( const i of c.members ) {

					if ( I.faction( i ) !== FACTION.PROTESTER ) continue;
					const [ x, y ] = o.toScreen( I.x( i ), I.y( i ) );
					ctx.beginPath();
					ctx.arc( x, y, Math.max( 2.4, 0.6 / o.mpp ), 0, Math.PI * 2 );
					ctx.fillStyle = 'rgba(8,8,10,0.95)';
					ctx.fill();
					ctx.strokeStyle = RED;
					ctx.lineWidth = 1;
					ctx.stroke();

				}

			}

			const [ x, y ] = o.toScreen( ...c.center );
			const r = Math.max( 12, ( Math.sqrt( c.alive ?? 10 ) * 0.9 + 4 ) / o.mpp );
			ctx.setLineDash( c.masked ? [] : [ 3, 4 ] );
			ctx.strokeStyle = RED;
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.arc( x, y, r, 0, Math.PI * 2 );
			ctx.stroke();
			ctx.setLineDash( [] );
			ctx.fillStyle = RED;
			ctx.fillText( c.masked ? 'BLACKBLOC' : 'BLOC · CCTV', x, y - r - 4 );

		}

	}

}
