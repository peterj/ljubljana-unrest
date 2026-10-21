import { Mission, MODE, fmt } from '../mission.js';
import { Convoy } from '../convoy.js';
import { ORANGE, RED, WHITE } from './shared/colors.js';
import { cars, squads } from './shared/spawn.js';

// ======================================================================================= CONVOY
export class ConvoyMission extends Mission {

	static id = 'convoy';
	static title = 'Convoy';
	static subtitle = 'Escort the VIP convoy from Celovška to the National Assembly';
	static side = 'police';
	static brief = `A foreign head of state lands at Brnik and is driven to the National Assembly. Word has spread:
		protesters are gathering along <b>Celovška</b>, at <b>Bavarski dvor</b> and on <b>Župančičeva</b>. The convoy will not
		stop for anyone. If it is boxed in, the VIP is in danger.`;
	static goals = [ 'Get the convoy to the Assembly', 'Keep the VIP car intact', 'Avoid injuring people — the cameras are watching' ];
	static tips = [ 'You have 1:15 before departure — put squads where the hotspots are', 'Right-drag a cordon line along the road to keep crowds off it',
		'Patrol cars drive ahead fast and park as roadblocks — their crews get out (U)',
		'Leaders appear as rings under CCTV coverage — Snatch (X) them to break a group up', 'V departs early' ];

	async setup() {

		const city = this.city, W = this.world;
		await W.exits();
		this.convoy = new Convoy( city.route );
		this.game.scene.add( this.convoy.group );
		const C = this.convoy;
		this.departAt = 75;
		this.focus = [ C.at( C.length * 0.3 ).x, C.at( C.length * 0.3 ).y ];
		this.zoom = 1.1;
		this.resources = { gas: { left: 3, max: 3 }, water: { left: 3, max: 3 }, reinforce: { left: 2, max: 2 } };
		this.waterOpinion = - 2;

		// hotspots: crowds waiting beside the route, they surge onto it when the convoy approaches
		this.hotspots = [];
		const spots = [ [ 0.3, 'Celovška', 520 ], [ 0.6, 'Bavarski dvor', 800 ], [ 0.86, 'Župančičeva', 1000 ] ];
		for ( const [ f, name, n ] of spots ) {

			const s = f * C.length;
			const p = C.at( s );
			const side = Math.random() < 0.5 ? 1 : - 1;
			const at = W.spot( p.x + Math.cos( p.heading + side * Math.PI / 2 ) * 30, p.y + Math.sin( p.heading + side * Math.PI / 2 ) * 30, 15 );
			const L = await W.fieldTo( p.x, p.y, 10 );
			const groups = await W.bloc( { kind: 'hotspot', label: name, at, n, groupSize: 80, spread: 25, layer: L, mode: MODE.HOLD, agitation: [ 0.15, 0.4 ] } );
			// Friday cyclists ride along Celovška to block the road
			if ( name === 'Celovška' ) groups.push( ...await W.bloc( { kind: 'hotspot', label: 'Cyclists', at: W.spot( at[ 0 ], at[ 1 ], 20 ), n: 220, groupSize: 55, spread: 15, layer: L, mode: MODE.HOLD, agitation: [ 0.2, 0.45 ], bikes: 1 } ) );
			this.hotspots.push( { name, s, pos: [ p.x, p.y ], groups, active: false } );

		}

		// a small radical cell hidden off the route in Tivoli — they go for the car when it passes
		const pr = C.at( 0.45 * C.length );
		await W.bloc( { kind: 'radicals', label: 'Radical cell', at: W.spot( pr.x - 60, pr.y - 30, 30 ), n: 120, groupSize: 40, spread: 15, mode: MODE.HOLD, agitation: [ 0.55, 0.8 ], morale: 0.9 } );
		// and a standing crowd at the destination
		const sq = W.places[ 'Trg republike' ];
		await W.bloc( { kind: 'crowd', label: 'Trg republike crowd', at: sq, n: 1400, groupSize: 100, spread: 45, goal: sq, goalR: 40, mode: MODE.HOLD, agitation: [ 0.1, 0.35 ] } );

		// police: escort at the start, a mid-route detachment, a reception at the Assembly
		const start = C.at( 30 ), mid = C.at( C.length * 0.55 ), end = C.at( C.length - 40 );
		await squads( W, [ [ start.x + 12, start.y ], [ start.x - 12, start.y ], [ start.x, start.y + 15 ] ] );
		await squads( W, [ [ mid.x + 15, mid.y ], [ mid.x - 15, mid.y ], [ mid.x, mid.y - 15 ] ] );
		await squads( W, [ [ end.x + 15, end.y ], [ end.x - 15, end.y ], [ end.x, end.y + 15 ], [ end.x, end.y - 15 ] ] );
		const ahead = C.at( 70 ), late = C.at( C.length * 0.75 );
		await cars( W, [ [ ahead.x, ahead.y ], [ mid.x, mid.y ], [ late.x, late.y ] ] );
		// the water cannon waits on the route between Tivoli and Bavarski dvor (the middle of the trouble)
		const wc = C.at( C.length * 0.5 );
		await W.patrols.add( { at: [ wc.x, wc.y ], water: true } );
		await this.bystanders( 2200 );

	}

	start() {

		this.event( 'Convoy departs in 1:15. Position your squads along the route.', 'info', this.convoy.route[ 0 ] );

	}

	depart() {

		if ( this.convoy.moving ) return;
		this.convoy.moving = true;
		this.departedAt = this.t;
		this.event( 'Convoy is moving', 'good', this.convoy.route[ 0 ] );

	}

	commands() {

		return [ ...this.policeCommands(), { key: 'v', label: 'Depart now', run: () => this.depart(), hide: () => this.convoy.moving } ];

	}

	tick( dt ) {

		const C = this.convoy;
		if ( ! C.moving && this.t >= this.departAt ) this.depart();
		C.update( dt, this.stats );
		this.world.convoyVehicles = C.vehicles();

		for ( const h of this.hotspots ) {

			if ( ! h.active && C.s > h.s - 320 ) {

				h.active = true;
				this.world.setMode( h.groups, MODE.MARCH );
				for ( const g of h.groups ) for ( const i of g.members ) this.crowd.nudge( i, 0.2, 0 );
				this.event( `${h.name}: the crowd is surging onto the road!`, 'bad', h.pos );

			}

		}

		const lead = C.poses[ 0 ];
		if ( C.moving && C.speed < 0.5 && ! C.arrived ) {

			if ( ! this.flags.halted ) { this.flags.halted = true; this.event( 'Convoy HALTED — road blocked ahead', 'bad', [ lead.x, lead.y ] ); }

		} else this.flags.halted = false;

		if ( C.attackers > 0.5 && this.t - ( this.flags.attackMsg ?? - 99 ) > 8 ) {

			this.flags.attackMsg = this.t;
			this.event( 'VIP car under attack!', 'bad', [ C.poses[ C.vip ].x, C.poses[ C.vip ].y ] );

		}

		for ( const m of [ 0.75, 0.5, 0.25 ] ) {

			if ( C.integrity < m && ! this.flags[ 'int' + m ] ) { this.flags[ 'int' + m ] = true; this.event( `VIP car integrity ${m * 100}%`, 'bad' ); }

		}

		if ( C.integrity <= 0 ) this.end( false, 'The VIP car was overrun.' );
		else if ( C.blockedFor > 75 ) this.end( false, 'The convoy was stuck for too long — the VIP was evacuated by helicopter.' );
		else if ( C.arrived ) this.end( true, 'The VIP arrived at the National Assembly.' );

	}

	get travel() { return this.departedAt !== undefined ? this.t - this.departedAt : 0; }

	phase() {

		const C = this.convoy;
		if ( ! C.moving ) return `Convoy departs in ${fmt( this.departAt - this.t )} — press V to go now`;
		if ( C.speed < 0.5 ) return `CONVOY HALTED · ${fmt( C.blockedFor )} / 1:15`;
		return `Convoy moving · ${Math.round( C.speed * 3.6 )} km/h · ${C.blockers} on the road ahead`;

	}

	objectives() {

		const C = this.convoy, inj = this.counters.injByPolice;
		return [
			{ label: 'Convoy reaches the Assembly', value: C.progress, text: `${Math.round( C.progress * 100 )}%`, state: C.arrived ? 'done' : C.speed < 0.5 && C.moving ? 'warn' : 'ok' },
			{ label: 'VIP car integrity', value: C.integrity, text: `${Math.round( C.integrity * 100 )}%`, state: C.integrity < 0.35 ? 'bad' : C.integrity < 0.7 ? 'warn' : 'ok' },
			{ label: '★ Arrive within 6:00 of departure', value: Math.min( 1, this.travel / 360 ), text: fmt( this.travel ), state: this.travel > 360 ? 'bad' : 'ok', invert: true },
			{ label: '★ Injuries caused by police ≤ 15', value: Math.min( 1, inj / 15 ), text: `${inj}`, state: inj > 15 ? 'bad' : inj > 10 ? 'warn' : 'ok', invert: true },
		];

	}

	score( win ) {

		const C = this.convoy;
		const s1 = win, s2 = win && C.integrity >= 0.6 && this.travel <= 360, s3 = win && this.counters.injByPolice <= 15;
		return { stars: s1 + s2 + s3, lines: [
			[ 'VIP car integrity', `${Math.round( C.integrity * 100 )}%` ], [ 'Travel time', fmt( this.travel ) ],
			[ 'Injuries caused by police', this.counters.injByPolice ], [ 'Officers injured', this.counters.injPolice ],
			[ 'Arrests', this.counters.arrested ], [ 'Public opinion', Math.round( this.opinion ) ] ] };

	}

	draw( o ) {

		const C = this.convoy, ctx = o.ctx;
		ctx.lineWidth = 2;
		const path = ( a, b ) => {

			ctx.beginPath();
			for ( let s = a; s <= b; s += 8 ) {

				const p = C.at( s );
				const [ x, y ] = o.toScreen( p.x, p.y );
				s === a ? ctx.moveTo( x, y ) : ctx.lineTo( x, y );

			}

			ctx.stroke();

		};

		ctx.strokeStyle = 'rgba(233,228,216,0.75)';
		path( 0, C.s );
		ctx.setLineDash( [ 8, 8 ] );
		ctx.strokeStyle = 'rgba(43,140,255,0.6)';
		path( C.s, C.length );
		ctx.setLineDash( [] );
		for ( const h of this.hotspots ) this.drawZone( o, h.pos[ 0 ], h.pos[ 1 ], 30, h.active ? RED : ORANGE, h.active ? `${h.name} ⚠` : h.name );
		const end = C.at( C.length );
		this.drawZone( o, end.x, end.y, 12, WHITE, 'ASSEMBLY', 0.12 );

	}

}
