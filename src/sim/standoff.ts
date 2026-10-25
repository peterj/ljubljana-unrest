// Standoff: how a crowd faces a police line that blocks its way. Each civilian group the AI runs climbs a ladder
// (g.heat) instead of walking into the shields:
//   1 CALM   stands about STANDOFF_GAP m short of the line (MODE.STANDOFF); WAIT s after its front got there it
//            gets restless (→ 2)
//   2 PROBE  still standing, but small groups break off, lean on the line for a while and come back
//   3 BREACH the whole group leans on the line (MODE.PUSH)
//   4 PYRO   the group storms one point of the line (MODE.STORM) while its leader throws firecrackers at it: officers
//            near a blast flinch (crowd.ts: shields down, half the push) — snatch the leader to stop them
// Police action close by (World.provoke: charges, kettles, arrests, snatches, gas, water, shield pushes, shots) and
// the group's own people hurt or arrested by police each step it up, at most once per PROVOKE_GAP s; COOL s without
// any and it drops a level. A touchy group (g.touchy) is also provoked by blows: one of its people hit while next to
// an officer. Agitation only sets the level a group starts at (unless the mission sets g.heatStart): a crowd squeezed
// through a narrow street gets agitated, and that must not send it at the shields. Each kind of group has a
// ceiling (CEILING, or g.ceiling set by the mission): peaceful marches never get past 3, militants can reach 4.
// A mission's own PUSH / STORM order counts as that level, and the ladder hands a group back the moment the mission
// gives it any other mode (hold, riot, sit, disperse …). Runs on every intel readback (update) and every sim step (step).
import { FACTION, MODE, ROLE } from './crowd.ts';

export const HEAT = { CALM: 1, PROBE: 2, BREACH: 3, PYRO: 4 };
// how far short of the line a calm crowd stands (m; crowd.ts reads the police on its 4 m grid) · how long it waits
// before it gets restless (s) · how long without provocation before it calms down a level (s)
export const STANDOFF_GAP = 10, WAIT = 60, COOL = 90;
// police action within this of a group (m, plus the group's own spread) provokes it, at most once per PROVOKE_GAP s
export const PROVOKE_R = 40, PROVOKE_GAP = 10;
// a blow (touchy groups): health lost since the last readback, by someone within BLOW_R of an officer (m)
export const BLOW = 0.002, BLOW_R = 1.6;
// a line blocks a group heading through it within BLOCK_REACH of its front (m), one it merely stands near within
// BLOCK_NEAR (no known heading); it lets go BLOCK_SLACK further out. A group heading through the line that comes within
// QUEUE_REACH of a group standing off at it queues behind it however far back (a long march does not press into the
// people standing at the line)
export const BLOCK_REACH = 60, BLOCK_NEAR = 15, BLOCK_SLACK = 15, QUEUE_REACH = 6;
// probes: people per probe (min, max), how long one leans on the line (s), how long between probes (s)
export const PROBE_MIN = 5, PROBE_MAX = 15, PROBE_TIME = [ 10, 20 ], PROBE_EVERY = [ 8, 18 ];
// firecrackers: throwing range (m), seconds between throws of one leader, flight time (s), blast radius (m), how long
// officers flinch (s), how far behind the line the storm aims (m)
export const THROW_RANGE = 30, THROW_EVERY = [ 4, 9 ], THROW_FLIGHT = 0.8, BLAST_R = 4, FLINCH = 6, BREACH_DEPTH = 8;
// highest level by group kind; anything else stops at 3
export const CEILING = { violent: 4, bloc: 4, antifa: 4, radicals: 4, wave: 4, ultras: 4, hooligans: 4,
	supporters: 2, sitters: 1, blockade: 1, medics: 1 };
// starting level by the group's agitation (≥ each threshold: one level up)
const AG_START = [ 0.3, 0.55, 0.8 ];
// agitation added to every member when the group steps up (removed when it calms down)
const AG_STEP = 0.1;

type Vec2 = [ number, number ];

const rand = ( a, b, random ) => a + random() * ( b - a );

const segDist = ( px, py, a, b ) => {

	const dx = b[ 0 ] - a[ 0 ], dy = b[ 1 ] - a[ 1 ], l2 = dx * dx + dy * dy || 1;
	const t = Math.max( 0, Math.min( 1, ( ( px - a[ 0 ] ) * dx + ( py - a[ 1 ] ) * dy ) / l2 ) );
	return Math.hypot( px - a[ 0 ] - dx * t, py - a[ 1 ] - dy * t );

};

// which side of the line a → b the point p is on (±1, 0 on it)
const sideOf = ( p, a, b ) => Math.sign( ( b[ 0 ] - a[ 0 ] ) * ( p[ 1 ] - a[ 1 ] ) - ( b[ 1 ] - a[ 1 ] ) * ( p[ 0 ] - a[ 0 ] ) );

// whether segment p → q crosses a → b
const crosses = ( p, q, a, b ) => {

	const side = ( o, s, e ) => Math.sign( ( e[ 0 ] - s[ 0 ] ) * ( o[ 1 ] - s[ 1 ] ) - ( e[ 1 ] - s[ 1 ] ) * ( o[ 0 ] - s[ 0 ] ) );
	return side( p, a, b ) !== side( q, a, b ) && side( a, p, q ) !== side( b, p, q );

};

export const ceilingOf = ( kind ) => CEILING[ kind ] ?? 3;
export const levelOf = ( agitation ) => 1 + AG_START.filter( ( a ) => agitation >= a ).length;

export class Standoff {

	declare world: any;
	declare t: number;
	declare acts: any[];
	declare flights: any[];
	declare blasts: any[];
	declare exempt: number[];
	declare flashed: boolean;
	declare random: () => number;

	constructor( world, { random = Math.random } = {} ) {

		this.world = world;
		this.t = 0;
		this.acts = []; // police action since the last update: { kind, x, y }
		this.flights = []; // firecrackers in the air: { from, to, t, group }
		this.blasts = []; // firecrackers that went off: { x, y, r, t }
		this.exempt = []; // factions the player commands (their groups do what they are told)
		this.flashed = false; // a firecracker went off (the HUD offers the strobe switch from then on)
		this.random = random;

	}

	provoke( kind, x, y ) { this.acts.push( { kind, x, y } ); }

	// every sim step: firecrackers fly and go off, officers recover
	step( dt ) {

		this.t += dt;
		for ( const f of this.flights ) {

			if ( this.t - f.t < THROW_FLIGHT ) continue;
			f.done = true;
			this.blasts.push( { x: f.to[ 0 ], y: f.to[ 1 ], r: BLAST_R, t: 0, from: f.from } );
			if ( this.blasts.length > 8 ) this.blasts.shift();
			this.flashed = true;
			this.world.onFx?.( 'firecracker', f.to[ 0 ], f.to[ 1 ], f.from );

		}

		this.flights = this.flights.filter( ( f ) => ! f.done );
		for ( const b of this.blasts ) b.t += dt;
		this.blasts = this.blasts.filter( ( b ) => b.t < FLINCH );
		this.world.crowd.setBlasts?.( this.blasts.map( ( b ) => ( { x: b.x, y: b.y, r: b.r, strength: Math.min( 1, ( FLINCH - b.t ) / 1.5 ) } ) ) );

	}

	// every intel readback -> [ { type: 'standoff' | 'up' | 'down', group, level, at } ] for the mission's feed
	update() {

		const W = this.world, I = W.intel;
		if ( ! I ) return [];
		const out = [], acts = this.acts.splice( 0 );
		const lines = [ ...new Set( W.groups.filter( ( q ) => q.cordon && q.alive > 0 ).map( ( q ) => q.cordon ) ) ];
		let police = null; // officers on a 4 m grid, built when a touchy group needs it
		for ( const g of W.groups ) {

			if ( ( g.faction !== FACTION.PROTESTER && g.faction !== FACTION.COUNTER ) || g.probeOf ) continue;
			if ( this.exempt.includes( g.faction ) ) continue;
			if ( ! ( g.alive > 0 ) || ! g.center ) { if ( g.standoff ) this.leave( g, false ); continue; }
			this.heatOf( g, I );

			// police action close by, or our own people hurt or arrested by police
			const hurt = this.hurt( g, I );
			let hit = hurt > g.hurt;
			g.hurt = hurt;
			if ( g.touchy ) { police ??= this.officers( I ); hit = this.blows( g, I, police ) || hit; }
			const R = PROVOKE_R + Math.sqrt( g.alive ) * 0.9;
			if ( hit || acts.some( ( a ) => Math.hypot( a.x - g.center[ 0 ], a.y - g.center[ 1 ] ) < R ) ) {

				g.provokedAt = this.t;
				if ( this.t - g.steppedAt >= PROVOKE_GAP ) { g.steppedAt = this.t; this.set( g, g.heat + 1, out ); }

			}

			if ( g.standoff && ! this.owns( g ) ) this.leave( g, false ); // the mission took the group over
			g.radius = this.radius( g, I );
			const B = this.blocking( g, lines, I );
			if ( B && ! g.standoff && [ MODE.MARCH, MODE.PUSH, MODE.STORM ].includes( g.mode ) ) this.enter( g, B.L, out );
			else if ( g.standoff && ! B ) this.leave( g, true );
			const s = g.standoff;
			if ( s ) {

				s.L = B.L;
				if ( s.arrived === null && B.d <= STANDOFF_GAP + 5 ) s.arrived = this.t; // the front has reached the line

			}

			if ( s?.arrived !== null && s?.arrived !== undefined && g.heat === HEAT.CALM && this.t - Math.max( g.heatAt, s.arrived ) >= WAIT ) this.set( g, HEAT.PROBE, out );
			if ( g.heat > ( g.standoff?.floor ?? 1 ) && this.t - Math.max( g.heatAt, g.provokedAt ) >= COOL ) this.set( g, g.heat - 1, out );
			if ( g.standoff ) this.apply( g, I );

		}

		return out;

	}

	// the group's level, from its agitation when first seen
	heatOf( g, I ) {

		if ( g.heat !== undefined ) return g.heat;
		g.ceiling ??= ceilingOf( g.kind );
		g.heat = Math.min( g.ceiling, g.heatStart ?? levelOf( g.agitation ?? 0 ) );
		g.heatAt = this.t;
		g.provokedAt = g.steppedAt = - Infinity;
		g.hurt = this.hurt( g, I );
		return g.heat;

	}

	// members (with any out probing) injured by police or arrested
	hurt( g, I ) {

		let n = 0;
		for ( const i of [ ...g.members, ...( g.standoff?.probe ? g.standoff.probeGroup.members : [] ) ] ) {

			const f = I.st[ i * 4 ];
			if ( ( f >= 10 && f < 20 ) || f === FACTION.ARRESTED || f === FACTION.ARRESTED_SITTER ) n ++;

		}

		return n;

	}

	// officers on their feet, by 4 m cell
	officers( I ) {

		const grid = new Map();
		for ( let i = 0; i < I.st.length / 4; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.POLICE ) continue;
			const k = `${Math.floor( I.pos[ i * 2 ] / 4 )}:${Math.floor( I.pos[ i * 2 + 1 ] / 4 )}`;
			if ( ! grid.has( k ) ) grid.set( k, [] );
			grid.get( k ).push( I.pos[ i * 2 ], I.pos[ i * 2 + 1 ] );

		}

		return grid;

	}

	// whether any of the group's people (with any out probing) lost health since the last readback next to an officer
	blows( g, I, police ) {

		const last = g.health ?? new Map(), now = new Map();
		let hit = false;
		for ( const i of [ ...g.members, ...( g.standoff?.probe ? g.standoff.probeGroup.members : [] ) ] ) {

			if ( I.st[ i * 4 ] !== g.faction ) continue;
			const h = I.st[ i * 4 + 3 ];
			now.set( i, h );
			if ( hit || ! ( last.get( i ) - h > BLOW ) ) continue;
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ], cx = Math.floor( x / 4 ), cy = Math.floor( y / 4 );
			for ( let dx = - 1; dx <= 1 && ! hit; dx ++ ) for ( let dy = - 1; dy <= 1 && ! hit; dy ++ ) {

				const o = police.get( `${cx + dx}:${cy + dy}` ) ?? [];
				for ( let k = 0; k < o.length; k += 2 ) if ( Math.hypot( o[ k ] - x, o[ k + 1 ] - y ) < BLOW_R ) { hit = true; break; }

			}

		}

		g.health = now;
		return hit;

	}

	set( g, level, out ) {

		const s = g.standoff;
		const top = Math.max( g.ceiling, s?.floor ?? 1 );
		level = Math.max( s?.floor ?? 1, Math.min( top, level ) );
		if ( level === g.heat ) return;
		const up = level > g.heat;
		g.heat = level;
		g.heatAt = this.t;
		// away from any line the level is only remembered: it shows once the group meets one
		if ( ! s ) return;
		for ( const i of g.members ) this.world.crowd.nudge( i, up ? AG_STEP : - AG_STEP, 0 );
		out.push( { type: up ? 'up' : 'down', group: g, level, at: g.center } );

	}

	// the cordon line in the group's way, if any, and how far its front is from it ({ L, d }): one it heads through
	// (toward its goal, or the way it is moving) within BLOCK_REACH of its front, or one it stands right at
	blocking( g, lines, I ) {

		const v = g.center && g.lastCenter ? [ g.center[ 0 ] - g.lastCenter[ 0 ], g.center[ 1 ] - g.lastCenter[ 1 ] ] : [ 0, 0 ];
		g.heading = [ ( g.heading?.[ 0 ] ?? 0 ) * 0.6 + v[ 0 ] * 0.4, ( g.heading?.[ 1 ] ?? 0 ) * 0.6 + v[ 1 ] * 0.4 ];
		g.lastCenter = g.center;
		const sp = Math.hypot( ...( g.heading as Vec2 ) );
		let best = null;
		for ( const L of lines ) {

			const slack = g.standoff?.L === L ? BLOCK_SLACK : 0;
			// most of the group got through: the line no longer stands in its way
			if ( slack && sideOf( g.center, L.a, L.b ) === - g.standoff.side ) continue;
			const d = this.front( g, L, I );
			if ( d > BLOCK_REACH + slack ) continue;
			const dx = L.b[ 0 ] - L.a[ 0 ], dy = L.b[ 1 ] - L.a[ 1 ], len = Math.hypot( dx, dy ) || 1;
			const a = [ L.a[ 0 ] - dx / len * 2, L.a[ 1 ] - dy / len * 2 ], b = [ L.b[ 0 ] + dx / len * 2, L.b[ 1 ] + dy / len * 2 ];
			// heading: where ~25 m of the way it is moving would take it (a few readbacks of movement)
			const ahead = sp > 0.05 ? [ g.center[ 0 ] + g.heading[ 0 ] / sp * ( d + 25 ), g.center[ 1 ] + g.heading[ 1 ] / sp * ( d + 25 ) ] : null;
			const through = ( g.goal && crosses( g.center, g.goal, a, b ) ) || ( ahead && crosses( g.center, ahead, a, b ) );
			if ( ! through && d > BLOCK_NEAR + slack && ! ( slack && d < STANDOFF_GAP + slack ) ) continue;
			if ( ! best || d < best.d ) best = { L, d };

		}

		if ( best ) return best;
		// queued behind a group of the same side standing off at a line it is heading for, however far back
		for ( const q of this.world.groups ) {

			const L = q.standoff?.L;
			if ( ! L || q === g || q.faction !== g.faction || ! q.center || ! lines.includes( L ) ) continue;
			if ( Math.hypot( q.center[ 0 ] - g.center[ 0 ], q.center[ 1 ] - g.center[ 1 ] ) > ( q.radius ?? 0 ) + ( g.radius ?? 0 ) + QUEUE_REACH ) continue;
			const ahead = sp > 0.05 ? [ g.center[ 0 ] + g.heading[ 0 ] / sp * 1e3, g.center[ 1 ] + g.heading[ 1 ] / sp * 1e3 ] : null;
			if ( ! ( g.goal && crosses( g.center, g.goal, L.a, L.b ) ) && ! ( ahead && crosses( g.center, ahead, L.a, L.b ) ) && ! g.standoff ) continue;
			return { L, d: this.front( g, L, I ) };

		}

		return null;

	}

	// how far the group spreads round its centre (m; most of it: the furthest tenth left out)
	radius( g, I ) {

		const d = [];
		for ( const i of g.members ) if ( I.st[ i * 4 ] === g.faction ) d.push( Math.hypot( I.pos[ i * 2 ] - g.center[ 0 ], I.pos[ i * 2 + 1 ] - g.center[ 1 ] ) );
		d.sort( ( a, b ) => a - b );
		return d.length ? d[ Math.floor( d.length * 0.9 ) ] : 0;

	}

	// distance from the line to the group's member nearest it
	front( g, L, I ) {

		let d = Infinity;
		for ( const i of g.members ) {

			if ( I.st[ i * 4 ] !== g.faction ) continue;
			d = Math.min( d, segDist( I.pos[ i * 2 ], I.pos[ i * 2 + 1 ], L.a, L.b ) );

		}

		return d;

	}

	enter( g, L, out ) {

		g.standoff = { L, side: sideOf( g.center, L.a, L.b ), floor: 1, applied: null, arrived: null, probe: null, probeGroup: g.probeGroup ?? null,
			nextProbe: this.t + rand( ...( PROBE_EVERY as Vec2 ), this.random ), breach: null };
		this.owns( g );
		out.push( { type: 'standoff', group: g, level: g.heat, at: g.center } );

	}

	// whether the ladder still runs the group: its mode is one the ladder set, or a march (re-applied), or a mission's
	// PUSH / STORM order (which raises the floor of the ladder to that level)
	owns( g ) {

		const s = g.standoff;
		if ( g.mode === s.applied ) return true;
		if ( g.mode === MODE.MARCH ) { s.floor = 1; s.applied = null; return true; }
		if ( g.mode === MODE.PUSH || g.mode === MODE.STORM ) {

			s.floor = g.mode === MODE.STORM ? HEAT.PYRO : HEAT.BREACH;
			s.applied = g.mode;
			if ( g.heat < s.floor ) { g.heat = s.floor; g.heatAt = this.t; }
			return true;

		}

		return false;

	}

	// restore: back to marching (or the mission's push / storm); otherwise the mission has already given an order
	leave( g, restore ) {

		const s = g.standoff;
		if ( ! s ) return;
		this.endProbe( g );
		this.endBreach( g );
		g.probeGroup = s.probeGroup;
		g.standoff = null;
		if ( restore && g.mode === s.applied ) this.world.setMode( [ g ], s.floor >= HEAT.PYRO ? MODE.STORM : s.floor >= HEAT.BREACH ? MODE.PUSH : MODE.MARCH );

	}

	// the mode for the level, probes at 2, the storm and the firecrackers at 4
	apply( g, I ) {

		const s = g.standoff;
		const mode = g.heat >= HEAT.PYRO ? MODE.STORM : g.heat >= HEAT.BREACH ? MODE.PUSH : MODE.STANDOFF;
		if ( g.mode !== mode ) this.world.setMode( [ g ], mode );
		s.applied = mode;
		if ( g.heat === HEAT.PROBE && s.arrived !== null ) this.probe( g, I );
		else this.endProbe( g );
		if ( g.heat >= HEAT.PYRO ) this.breach( g, I );
		else this.endBreach( g );

	}

	// ---------------------------------------------------------------- probes

	probe( g, I ) {

		const s = g.standoff;
		if ( s.probe ) { if ( this.t >= s.probe.until || ! ( s.probeGroup.alive > 0 ) ) this.endProbe( g ); return; }
		if ( this.t < s.nextProbe ) return;
		s.nextProbe = this.t + rand( ...( PROBE_EVERY as Vec2 ), this.random );
		// a knot of people from the front: everyone within a few metres of the nearest, round one of them
		const live = g.members.filter( ( i ) => i !== g.leader && I.st[ i * 4 ] === g.faction );
		const d = new Map<number, number>( live.map( ( i ) => [ i, segDist( I.pos[ i * 2 ], I.pos[ i * 2 + 1 ], s.L.a, s.L.b ) ] ) );
		const d0 = Math.min( ...d.values() );
		const front = live.filter( ( i ) => d.get( i ) < d0 + 6 );
		if ( ! front.length ) return;
		const seed = front[ Math.floor( this.random() * front.length ) ];
		const n = Math.max( PROBE_MIN, Math.min( PROBE_MAX, Math.round( live.length * 0.1 ) ) );
		if ( live.length < n * 2 ) return;
		const sx = I.pos[ seed * 2 ], sy = I.pos[ seed * 2 + 1 ];
		const knot = live.map( ( i ) => [ i, Math.hypot( I.pos[ i * 2 ] - sx, I.pos[ i * 2 + 1 ] - sy ) ] ).sort( ( a, b ) => a[ 1 ] - b[ 1 ] ).slice( 0, n ).map( ( e ) => e[ 0 ] );

		// one probe group per group, used again for every probe
		const W = this.world;
		const p = s.probeGroup ??= Object.assign( W.newGroup( g.faction, g.kind, `${g.label} · probe` ), { probeOf: g } );
		const out = new Set( knot );
		g.members = g.members.filter( ( i ) => ! out.has( i ) );
		knot.forEach( ( i, k ) => W.crowd.regroup( i, p.id, k === 0 ? ROLE.LEADER : ROLE.MEMBER ) );
		for ( const i of knot ) W.crowd.nudge( i, 0.2, 0 );
		Object.assign( p, { members: knot, leader: knot[ 0 ], mode: MODE.PUSH, alive: knot.length, center: [ sx, sy ], leaderPos: [ sx, sy ],
			leaderState: 'active', identified: false, leaderReported: false, leaderDetained: false } );
		W.crowd.setGroup( p.id, { leader: knot[ 0 ], speed: W.crowd.getGroup?.( g.id )?.speed ?? 1, mode: MODE.PUSH, scale: 1, morale: 0.7 } );
		W.setLayer( p, g.layer );
		s.probe = { until: this.t + rand( ...( PROBE_TIME as Vec2 ), this.random ) };

	}

	// the probe comes back into its group (whoever is left of it)
	endProbe( g ) {

		const s = g.standoff, p = s?.probeGroup;
		if ( ! s?.probe ) return;
		s.probe = null;
		for ( const i of p.members ) this.world.crowd.regroup( i, g.id, ROLE.MEMBER );
		g.members.push( ...p.members );
		g.alive = ( g.alive ?? 0 ) + ( p.alive ?? 0 );
		p.members = [];
		p.alive = 0;
		if ( p.layer !== undefined ) { this.world.flow.release( p.layer ); p.layer = undefined; }

	}

	// ---------------------------------------------------------------- the storm and the firecrackers

	// where the group goes through the line: the point of it nearest the group's front
	breachPoint( g, L, I ) {

		const dx = L.b[ 0 ] - L.a[ 0 ], dy = L.b[ 1 ] - L.a[ 1 ], len = Math.hypot( dx, dy ) || 1;
		const near = g.members.filter( ( i ) => I.st[ i * 4 ] === g.faction )
			.map( ( i ) => [ i, segDist( I.pos[ i * 2 ], I.pos[ i * 2 + 1 ], L.a, L.b ) ] ).sort( ( a, b ) => a[ 1 ] - b[ 1 ] ).slice( 0, 12 );
		if ( ! near.length ) return null;
		let sx = 0, sy = 0;
		for ( const [ i ] of near ) { sx += I.pos[ i * 2 ]; sy += I.pos[ i * 2 + 1 ]; }
		sx /= near.length; sy /= near.length;
		const t = Math.max( Math.min( 1.5, len / 2 ), Math.min( len - Math.min( 1.5, len / 2 ), ( sx - L.a[ 0 ] ) * dx / len + ( sy - L.a[ 1 ] ) * dy / len ) );
		const at: Vec2 = [ L.a[ 0 ] + dx / len * t, L.a[ 1 ] + dy / len * t ];
		// the far side of the line: away from the group's centre
		let nx = - dy / len, ny = dx / len;
		if ( ( g.center[ 0 ] - at[ 0 ] ) * nx + ( g.center[ 1 ] - at[ 1 ] ) * ny > 0 ) { nx = - nx; ny = - ny; }
		return { at, along: [ dx / len, dy / len ], beyond: [ at[ 0 ] + nx * BREACH_DEPTH, at[ 1 ] + ny * BREACH_DEPTH ] as Vec2 };

	}

	breach( g, I ) {

		const s = g.standoff, W = this.world;
		const B = this.breachPoint( g, s.L, I );
		if ( ! B ) return;
		// the storm heads for the far side of the breach point (a new field only when the point has moved: the pool is small)
		if ( ! s.breach ) {

			s.breach = { layer0: g.layer, layer: null, aim: null, fieldAt: - Infinity, next: this.t + rand( 1, 3, this.random ) };
			if ( g.layer !== undefined ) W.flow.retain( g.layer );

		}

		const b = s.breach;
		if ( ( ! b.aim || Math.hypot( B.beyond[ 0 ] - b.aim[ 0 ], B.beyond[ 1 ] - b.aim[ 1 ] ) > 6 ) && this.t - b.fieldAt > 8 ) {

			b.aim = B.beyond;
			b.fieldAt = this.t;
			let field;
			try { field = W.fieldTo( B.beyond[ 0 ], B.beyond[ 1 ], 5 ); } catch { field = null; } // pool full: storm along the march's field
			Promise.resolve( field ).then( ( L ) => {

				if ( L === null || L === undefined || g.standoff?.breach !== b ) return;
				W.setLayer( g, L );
				b.layer = L;

			} ).catch( () => {} );

		}

		// the leader throws while within range of the line and on their feet
		const li = g.leader;
		if ( this.t < b.next || I.st[ li * 4 ] !== g.faction ) return;
		const from: Vec2 = [ I.pos[ li * 2 ], I.pos[ li * 2 + 1 ] ];
		if ( Math.hypot( from[ 0 ] - B.at[ 0 ], from[ 1 ] - B.at[ 1 ] ) > THROW_RANGE ) return;
		b.next = this.t + rand( ...( THROW_EVERY as Vec2 ), this.random );
		const j = rand( - 3, 3, this.random );
		this.flights.push( { from, to: [ B.at[ 0 ] + B.along[ 0 ] * j, B.at[ 1 ] + B.along[ 1 ] * j ], t: this.t, group: g } );

	}

	// back on the march's own field, unless someone else has given the group another since
	endBreach( g ) {

		const b = g.standoff?.breach;
		if ( ! b ) return;
		g.standoff.breach = null;
		if ( b.layer0 === undefined ) return;
		if ( b.layer !== null && g.layer === b.layer ) this.world.setLayer( g, b.layer0 );
		this.world.flow.release( b.layer0 );

	}

}
