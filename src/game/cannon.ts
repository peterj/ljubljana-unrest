// Protest side: the AI police call in a water cannon truck when officers go down fast or a cordon breaks. The truck
// drives in by road from the nearest police station, parks behind the trouble and sprays the densest, angriest part
// of the crowd in reach; each spray is announced a few seconds ahead (a dashed red cone).
import { FACTION } from '../sim/crowd.ts';
import { WATER_JET, WATER_RANGE } from '../sim/world.ts';

const WARN = 3; // seconds of warning before a spray
const REST = 6; // seconds between the end of one jet and the next warning
const HURT = 12, HURT_WINDOW = 90; // officers injured within the window that call the truck in
const RED = 'rgba(255,72,56,0.9)';

export class CannonAI {

	declare m: any;
	declare W: any;
	declare stations: any;
	declare left: number;
	declare truck: any;
	declare goal: any;
	declare next: number;
	declare warn: any;
	declare idle: number;
	declare hurt: any[];
	declare lost: Map<any, any>;
	declare lastHurt: any;
	declare _intel: any;
	declare stuck: any;
	declare warned: boolean;

	// stations: where the truck can come from; sprays: how many before its tank is empty
	constructor( mission, { stations, sprays = 8 } ) {

		this.m = mission;
		this.W = mission.world;
		this.stations = stations.filter( Boolean );
		this.left = sprays;
		this.truck = null;
		this.goal = null; // where the trouble is
		this.next = 0; // earliest time for the next warning
		this.warn = null; // { angle, until }
		this.idle = 0;
		this.hurt = []; // [ t, officers injured so far ]
		this.lost = new Map<any, any>(); // police squad → officers down at the last check

	}

	// ---------------------------------------------------------------- triggers

	// every intel readback: injured officers within the last 90 s; the squad that lost the most is where it happens
	check() {

		const m = this.m, now = m.t, n = m.counters.injPolice;
		this.hurt.push( [ now, n ] );
		while ( this.hurt.length > 1 && this.hurt[ 0 ][ 0 ] < now - HURT_WINDOW ) this.hurt.shift();
		let worst = null, wd = 0;
		for ( const g of this.W.groupsOf( FACTION.POLICE ) ) {

			if ( ! g.center || g.kind === 'crew' ) continue; // crews in a car are off the map, not down
			const down = g.members.length - ( g.alive ?? g.members.length ), d = down - ( this.lost.get( g ) ?? down );
			this.lost.set( g, down );
			if ( d > wd ) { wd = d; worst = g; }

		}

		if ( worst ) this.lastHurt = worst.center.slice();
		if ( n - this.hurt[ 0 ][ 1 ] >= HURT && this.lastHurt ) {

			this.hurt = [ [ now, n ] ];
			this.call( this.lastHurt, 'officers down' );

		}

	}

	// a cordon fell back (World.cordonCheck 'retreat')
	onCordon( e ) {

		if ( e.type === 'retreat' ) this.call( e.at, 'a police line was overrun' );

	}

	async call( at, why ) {

		if ( this.left <= 0 || this.m.result ) return;
		const fresh = ! this.truck;
		if ( ! fresh && this.goal && Math.hypot( at[ 0 ] - this.goal[ 0 ], at[ 1 ] - this.goal[ 1 ] ) < 30 ) return;
		this.goal = at.slice();
		this.idle = 0;
		if ( fresh ) {

			this.truck = 'coming'; // guards against a second call while the truck is being added
			const from = this.stations.slice().sort( ( a, b ) => Math.hypot( a[ 0 ] - at[ 0 ], a[ 1 ] - at[ 1 ] ) - Math.hypot( b[ 0 ] - at[ 0 ], b[ 1 ] - at[ 1 ] ) )[ 0 ];
			try {

				this.truck = await this.W.patrols.add( { at: from, water: true, selectable: false, label: 'Police water cannon' } );

			} catch ( e ) {

				this.truck = null; // no vehicle slot left
				return;

			}

		}

		if ( this.truck === 'coming' ) return;
		this.m.event( fresh ? `Police call in a water cannon — ${why}` : `The water cannon moves up — ${why}`, 'bad', this.goal );
		this.drive();

	}

	// park on the police side of the trouble, ~16 m short of it, so the crowd is in reach
	drive() {

		const T = this.truck, P = this.W.patrols, g = this.goal;
		if ( this.warn ) this.warn = null;
		const dx = T.x - g[ 0 ], dy = T.y - g[ 1 ], d = Math.hypot( dx, dy ) || 1;
		const spot = d < 20 ? [ T.x, T.y ] : [ g[ 0 ] + dx / d * 16, g[ 1 ] + dy / d * 16 ];
		if ( d >= 20 && ! P.driveTo( T, ...spot ) ) P.driveTo( T, ...g );

	}

	// ---------------------------------------------------------------- per frame

	tick( dt ) {

		const m = this.m, T = this.truck;
		if ( this.W.intel && this.W.intel !== this._intel ) { this._intel = this.W.intel; this.check(); }
		if ( ! T || T === 'coming' || this.left <= 0 ) return;
		// held up by the crowd on the way: stop and spray the people in front
		if ( T.path ) {

			this.stuck = T.speed < 0.5 && T.blockers > 2 ? ( this.stuck ?? 0 ) + dt : 0;
			if ( this.stuck < 4 ) return;
			T.path = null;
			T.speed = 0;

		}

		if ( m.t < this.next ) return;
		if ( T.sprayUntil > m.t ) return;
		if ( this.warn ) {

			if ( m.t < this.warn.until ) return;
			this.W.spray( T, this.warn.angle );
			T.sprayUntil = m.t + WATER_JET;
			this.left --;
			this.warn = null;
			this.next = m.t + WATER_JET + REST;
			m.nudgeOpinion( 1, 'water cannon' );
			if ( ! this.left ) m.after( WATER_JET, () => m.event( 'The water cannon is out of water', 'good', [ T.x, T.y ] ) );
			return;

		}

		const angle = this.aim();
		if ( angle === null ) {

			// nobody in reach for a while: follow the nearest crowd within 80 m of the trouble, else stand by
			if ( ( this.idle += dt ) > 15 ) {

				this.idle = 0;
				const c = this.crowdNear( this.goal, 80 );
				if ( c ) { this.goal = c; this.drive(); }

			}

			return;

		}

		this.idle = 0;
		T.aim = angle;
		this.warn = { angle, until: m.t + WARN };
		if ( ! this.warned ) { this.warned = true; m.event( 'Water cannon about to spray — get out of the cone (dashed red)', 'warn', [ T.x, T.y ] ); }

	}

	// the direction (16 sectors) with the most protesters in reach, weighted by agitation; null if under 12 people
	aim() {

		const I = this.W.intel, T = this.truck;
		if ( ! I ) return null;
		const bins = new Float32Array( 16 ), cnt = new Uint16Array( 16 );
		for ( let i = 0; i < this.W.crowd.count; i ++ ) {

			const f = I.st[ i * 4 ];
			if ( f !== FACTION.PROTESTER && f !== FACTION.COUNTER ) continue;
			const dx = I.pos[ i * 2 ] - T.x, dy = I.pos[ i * 2 + 1 ] - T.y, d2 = dx * dx + dy * dy;
			if ( d2 > WATER_RANGE * WATER_RANGE || d2 < 9 ) continue;
			const b = ( Math.round( Math.atan2( dy, dx ) / ( Math.PI / 8 ) ) + 16 ) % 16;
			bins[ b ] += 0.4 + I.st[ i * 4 + 2 ];
			cnt[ b ] ++;

		}

		let best = - 1, bv = 0;
		for ( let b = 0; b < 16; b ++ ) {

			const v = bins[ b ] + 0.5 * ( bins[ ( b + 1 ) % 16 ] + bins[ ( b + 15 ) % 16 ] );
			if ( v > bv ) { bv = v; best = b; }

		}

		return best < 0 || cnt[ best ] + cnt[ ( best + 1 ) % 16 ] + cnt[ ( best + 15 ) % 16 ] < 12 ? null : best * Math.PI / 8;

	}

	crowdNear( at, r ) {

		const I = this.W.intel;
		let sx = 0, sy = 0, n = 0;
		for ( let i = 0; i < this.W.crowd.count; i ++ ) {

			if ( I.st[ i * 4 ] !== FACTION.PROTESTER ) continue;
			const x = I.pos[ i * 2 ], y = I.pos[ i * 2 + 1 ];
			if ( ( x - at[ 0 ] ) ** 2 + ( y - at[ 1 ] ) ** 2 > r * r ) continue;
			sx += x; sy += y; n ++;

		}

		return n >= 20 ? [ sx / n, sy / n ] : null;

	}

	// the announced spray: a dashed red cone with a countdown
	draw( o ) {

		const T = this.truck;
		if ( ! this.warn || ! T || T === 'coming' ) return;
		const ctx = o.ctx, [ x, y ] = o.toScreen( T.x, T.y ), R = WATER_RANGE / o.mpp, a = - this.warn.angle, half = Math.atan( 0.28 );
		ctx.setLineDash( [ 6, 5 ] );
		ctx.strokeStyle = RED;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo( x, y );
		ctx.arc( x, y, R, a - half, a + half );
		ctx.closePath();
		ctx.stroke();
		ctx.setLineDash( [] );
		ctx.fillStyle = RED;
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		ctx.fillText( `WATER CANNON · ${Math.ceil( this.warn.until - this.m.t )}`, x + Math.cos( a ) * R * 0.6, y + Math.sin( a ) * R * 0.6 - 8 );

	}

}
