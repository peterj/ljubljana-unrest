// 2D canvas drawn over the WebGPU view: mission markers, selection rings, pings, gas clouds,
// order previews. Cheap and crisp; it deliberately does not bloom.
import { FACTION } from '../sim/crowd.ts';
import { WATER_RANGE, SHIELD_REACH } from '../sim/world.ts';
import { THROW_FLIGHT, FLINCH } from '../sim/standoff.ts';

const COLORS = { info: '43,140,255', good: '79,209,139', warn: '255,176,32', bad: '255,45,85' };

export class Overlay {

	declare canvas: any;
	declare ctx: any;
	declare controls: any;
	declare pings: any[];
	declare preview: any;

	constructor( canvas, controls ) {

		this.canvas = canvas;
		this.ctx = canvas.getContext( '2d' );
		this.controls = controls;
		this.pings = [];
		this.preview = null; // { type: 'line'|'box'|'radius', ... }
		this.resize();

	}

	resize() {

		const dpr = Math.min( 2, window.devicePixelRatio );
		this.canvas.width = window.innerWidth * dpr;
		this.canvas.height = window.innerHeight * dpr;
		this.ctx.setTransform( dpr, 0, 0, dpr, 0, 0 );

	}

	get mpp() { return this.controls.mpp; }

	toScreen( x, y ) { return this.controls.worldToScreen( x, y ); }

	arrowHead( x, y, a, color ) {

		const ctx = this.ctx;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo( x + Math.cos( a ) * 9, y + Math.sin( a ) * 9 );
		ctx.lineTo( x + Math.cos( a + 2.5 ) * 8, y + Math.sin( a + 2.5 ) * 8 );
		ctx.lineTo( x + Math.cos( a - 2.5 ) * 8, y + Math.sin( a - 2.5 ) * 8 );
		ctx.fill();

	}

	ping( x, y, kind = 'info' ) {

		this.pings.push( { x, y, kind, t: performance.now() } );

	}

	draw( game ) {

		const ctx = this.ctx;
		ctx.clearRect( 0, 0, window.innerWidth, window.innerHeight );
		const m = game.mission;
		if ( ! m ) return;

		m.draw( this );
		m.drawTools( this );
		game.world.patrols?.draw( this, game );

		// tear gas clouds
		for ( const c of game.world.gasClouds ) {

			const [ x, y ] = this.toScreen( c.x, c.y );
			const r = c.r / this.mpp;
			const a = Math.min( 1, ( c.ttl - c.t ) / 6 ) * 0.35;
			const g = ctx.createRadialGradient( x, y, 0, x, y, r );
			g.addColorStop( 0, `rgba(217,226,220,${a})` );
			g.addColorStop( 1, 'rgba(217,226,220,0)' );
			ctx.fillStyle = g;
			ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.fill();

		}

		// water cannon: truck + animated spray cone
		for ( const j of game.world.jets ) {

			const [ x, y ] = this.toScreen( j.x, j.y );
			const len = j.range / this.mpp, a = - j.angle; // screen y is flipped
			const g = ctx.createLinearGradient( x, y, x + Math.cos( a ) * len, y + Math.sin( a ) * len );
			g.addColorStop( 0, 'rgba(160,210,255,0.45)' );
			g.addColorStop( 1, 'rgba(160,210,255,0)' );
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.moveTo( x, y );
			ctx.arc( x, y, len, a - 0.27, a + 0.27 );
			ctx.closePath();
			ctx.fill();
			const ph = ( performance.now() / 120 ) % 1;
			ctx.strokeStyle = 'rgba(200,230,255,0.6)';
			ctx.lineWidth = 1;
			for ( let k = 0; k < 4; k ++ ) {

				const rr = ( ( k + ph ) / 4 ) * len;
				ctx.beginPath(); ctx.arc( x, y, rr, a - 0.2, a + 0.2 ); ctx.stroke();

			}

			if ( j.truck ) continue; // a truck draws itself
			ctx.fillStyle = '#2b8cff';
			ctx.save(); ctx.translate( x, y ); ctx.rotate( a );
			const s = Math.max( 6, 3 / this.mpp );
			ctx.fillRect( - s * 2.2, - s * 0.6, s * 2.2, s * 1.2 );
			ctx.restore();

		}

		// firecrackers (Standoff): a spark arcing over the crowd, then a flash where it lands and an orange glow while the
		// officers there flinch. With the strobe switched off (☀) only a dim glow
		const S = game.world.standoff;
		for ( const f of S.flights ) {

			const k = Math.min( 1, ( S.t - f.t ) / THROW_FLIGHT );
			const [ ax, ay ] = this.toScreen( ...( f.from as [ number, number ] ) ), [ bx, by ] = this.toScreen( ...( f.to as [ number, number ] ) );
			const x = ax + ( bx - ax ) * k, y = ay + ( by - ay ) * k - Math.sin( k * Math.PI ) * Math.max( 8, 3 / this.mpp );
			ctx.fillStyle = 'rgba(255,214,120,0.95)';
			ctx.beginPath(); ctx.arc( x, y, 2, 0, Math.PI * 2 ); ctx.fill();

		}

		for ( const b of S.blasts ) {

			const [ x, y ] = this.toScreen( b.x, b.y );
			const r = b.r / this.mpp;
			if ( b.t < 0.25 && ! game.strobeOff ) {

				const k = 1 - b.t / 0.25, R = r * ( 1.2 + b.t * 4 );
				const g = ctx.createRadialGradient( x, y, 0, x, y, R );
				g.addColorStop( 0, `rgba(255,255,240,${k})` );
				g.addColorStop( 0.35, `rgba(255,220,140,${k * 0.8})` );
				g.addColorStop( 1, 'rgba(255,170,60,0)' );
				ctx.fillStyle = g;
				ctx.beginPath(); ctx.arc( x, y, R, 0, Math.PI * 2 ); ctx.fill();

			}

			const a = Math.max( 0, 1 - b.t / FLINCH ) * ( game.strobeOff ? 0.18 : 0.3 );
			const g = ctx.createRadialGradient( x, y, 0, x, y, r );
			g.addColorStop( 0, `rgba(255,140,40,${a})` );
			g.addColorStop( 1, 'rgba(255,140,40,0)' );
			ctx.fillStyle = g;
			ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.fill();

		}

		// selected units: ring + label at the group centre
		ctx.font = '600 11px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		for ( const g of game.selected ) {

			if ( ! g.center ) continue;
			const [ x, y ] = this.toScreen( ...( g.center as [ number, number ] ) );
			const r = Math.max( 10, ( Math.sqrt( g.alive ?? g.members.length ) * 0.7 + 3 ) / this.mpp );
			const col = g.faction === FACTION.POLICE ? '43,140,255' : '255,106,16';
			ctx.strokeStyle = `rgba(${col},0.9)`;
			ctx.lineWidth = 1.5;
			ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.stroke();
			ctx.fillStyle = `rgba(${col},0.95)`;
			ctx.fillText( g.label, x, y - r - 5 );
			if ( g.snatch && g.snatch.leaderState === 'active' ) {

				const [ lx, ly ] = this.toScreen( ...( g.snatch.leaderPos as [ number, number ] ) );
				ctx.setLineDash( [ 4, 4 ] );
				ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( lx, ly ); ctx.stroke();
				ctx.setLineDash( [] );

			}

		}

		// CCTV-identified leaders (police side): a small tag so they can be found at any zoom
		if ( m.side === 'police' && game.selected.length && this.mpp < 0.8 ) {

			ctx.font = '500 10px "IBM Plex Mono", monospace';
			for ( const g of game.world.groups ) {

				if ( ! g.identified || g.leaderState !== 'active' || g.faction === FACTION.POLICE || ! g.leaderPos ) continue;
				const [ x, y ] = this.toScreen( ...( g.leaderPos as [ number, number ] ) );
				if ( x < - 20 || y < - 20 || x > window.innerWidth + 20 || y > window.innerHeight + 20 ) continue;
				ctx.strokeStyle = 'rgba(255,176,32,0.9)';
				ctx.beginPath(); ctx.moveTo( x, y - 7 ); ctx.lineTo( x + 6, y - 15 ); ctx.lineTo( x - 6, y - 15 ); ctx.closePath(); ctx.stroke();

			}

		}

		// cordons standing shields up (braced): a bar along the line
		for ( const L of new Set<any>( game.world.groups.filter( ( g ) => g.cordon?.braced ).map( ( g ) => g.cordon ) ) ) {

			const [ ax, ay ] = this.toScreen( ...( L.a as [ number, number ] ) ), [ bx, by ] = this.toScreen( ...( L.b as [ number, number ] ) );
			ctx.strokeStyle = 'rgba(43,140,255,0.45)';
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.moveTo( ax, ay ); ctx.lineTo( bx, by ); ctx.stroke();

		}

		// cordons advancing shields up: an arrow to where they are going
		const lines = new Set<any>( game.world.groups.filter( ( g ) => g.cordon?.push ).map( ( g ) => g.cordon ) );
		for ( const L of lines ) {

			const P = L.push, mx = ( L.a[ 0 ] + L.b[ 0 ] ) / 2, my = ( L.a[ 1 ] + L.b[ 1 ] ) / 2, left = P.d - P.done;
			const [ x, y ] = this.toScreen( mx, my ), [ tx, ty ] = this.toScreen( mx + P.n[ 0 ] * left, my + P.n[ 1 ] * left );
			const col = P.stalled ? '255,176,32' : '43,140,255';
			ctx.strokeStyle = `rgba(${col},0.8)`;
			ctx.lineWidth = 1.5;
			ctx.setLineDash( [ 5, 5 ] );
			ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( tx, ty ); ctx.stroke();
			ctx.setLineDash( [] );
			this.arrowHead( tx, ty, Math.atan2( ty - y, tx - x ), `rgba(${col},0.9)` );
			ctx.fillStyle = `rgba(${col},0.95)`;
			ctx.fillText( P.turn ? 'SHIELDS UP · TURNING' : P.stalled ? 'SHIELDS UP · STALLED' : 'SHIELDS UP', x, y + 16 );

		}

		// water cannon / shield push being aimed: its reach and where it will go
		const A = game.aiming;
		if ( A && ! A.truck ) {

			const P = game.world.pushAim( A.squads.filter( ( g ) => g.cordon ), game.mouse.x, game.mouse.y );
			if ( P ) {

				const [ x, y ] = this.toScreen( ...( P.mid as [ number, number ] ) ), R = SHIELD_REACH / this.mpp;
				const [ ax, ay ] = this.toScreen( ...( P.a as [ number, number ] ) ), [ bx, by ] = this.toScreen( ...( P.b as [ number, number ] ) );
				const [ tx, ty ] = this.toScreen( P.mid[ 0 ] + P.n[ 0 ] * P.d, P.mid[ 1 ] + P.n[ 1 ] * P.d );
				ctx.strokeStyle = 'rgba(43,140,255,0.85)';
				ctx.lineWidth = 1.5;
				ctx.setLineDash( [ 5, 5 ] );
				ctx.beginPath(); ctx.arc( x, y, R, 0, Math.PI * 2 ); ctx.stroke();
				ctx.setLineDash( [] );
				ctx.fillStyle = `rgba(43,140,255,${A.held ? 0.16 : 0.07})`;
				ctx.beginPath(); ctx.arc( x, y, R, 0, Math.PI * 2 ); ctx.fill();
				// aimed off its normal: the line turned to face the aim, where it re-forms before advancing
				if ( P.turn ) {

					const [ ta, tb ] = [ this.toScreen( ...( P.turn.a as [ number, number ] ) ), this.toScreen( ...( P.turn.b as [ number, number ] ) ) ];
					ctx.lineWidth = 2;
					ctx.strokeStyle = `rgba(43,140,255,${A.held ? 0.7 : 0.4})`;
					ctx.setLineDash( [ 4, 4 ] );
					ctx.beginPath(); ctx.moveTo( ...ta ); ctx.lineTo( ...tb ); ctx.stroke();
					ctx.setLineDash( [] );

				}

				// the line where it will stop, and the way there
				ctx.lineWidth = A.held ? 4 : 3;
				ctx.strokeStyle = `rgba(43,140,255,${A.held ? 0.95 : 0.6})`;
				ctx.beginPath(); ctx.moveTo( ax, ay ); ctx.lineTo( bx, by ); ctx.stroke();
				ctx.lineWidth = 1.5;
				ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( tx, ty ); ctx.stroke();
				this.arrowHead( tx, ty, Math.atan2( ty - y, tx - x ), 'rgba(43,140,255,0.95)' );
				ctx.fillStyle = 'rgba(160,200,255,0.95)';
				const turn = P.turn ? ` · TURN ${Math.round( P.turn.angle * 180 / Math.PI )}°` : '';
				ctx.fillText( `SHIELD PUSH${turn} ${Math.round( P.d )} m · ${A.held ? ( P.turn ? 'release to turn and advance' : 'release to advance' ) : 'hold the left button to aim'}`, x, y - R - 6 );

			}

		} else if ( A ) {

			const [ x, y ] = this.toScreen( A.truck.x, A.truck.y );
			const R = WATER_RANGE / this.mpp, a = - A.truck.aim, half = Math.atan( 0.28 ); // the kernel's cone: across < 0.28 × along (+ 1 m)
			ctx.strokeStyle = 'rgba(160,210,255,0.85)';
			ctx.lineWidth = 1.5;
			ctx.setLineDash( [ 5, 5 ] );
			ctx.beginPath(); ctx.arc( x, y, R, 0, Math.PI * 2 ); ctx.stroke();
			ctx.setLineDash( [] );
			ctx.fillStyle = `rgba(160,210,255,${A.held ? 0.28 : 0.14})`;
			ctx.beginPath(); ctx.moveTo( x, y ); ctx.arc( x, y, R, a - half, a + half ); ctx.closePath(); ctx.fill(); ctx.stroke();
			ctx.fillStyle = 'rgba(200,230,255,0.95)';
			ctx.fillText( A.held ? 'WATER CANNON · release to spray' : 'WATER CANNON · hold the left button to aim', x, y - R - 6 );

		}

		// order previews
		const p = this.preview;
		if ( p ) {

			ctx.strokeStyle = 'rgba(255,106,16,0.9)';
			ctx.fillStyle = 'rgba(255,106,16,0.08)';
			ctx.lineWidth = 2;
			if ( p.type === 'line' ) {

				const [ ax, ay ] = this.toScreen( ...( p.a as [ number, number ] ) ), [ bx, by ] = this.toScreen( ...( p.b as [ number, number ] ) );
				ctx.beginPath(); ctx.moveTo( ax, ay ); ctx.lineTo( bx, by ); ctx.stroke();

			} else if ( p.type === 'box' ) {

				ctx.lineWidth = 1;
				ctx.fillRect( p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0 );
				ctx.strokeRect( p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0 );

			} else if ( p.type === 'radius' ) {

				const [ x, y ] = this.toScreen( p.x, p.y );
				ctx.setLineDash( [ 5, 5 ] );
				ctx.beginPath(); ctx.arc( x, y, p.r / this.mpp, 0, Math.PI * 2 ); ctx.stroke(); ctx.fill();
				ctx.setLineDash( [] );
				ctx.fillStyle = 'rgba(255,106,16,0.95)';
				ctx.fillText( p.label, x, y - p.r / this.mpp - 6 );

			}

		}

		// event pings: expanding rings
		const now = performance.now();
		this.pings = this.pings.filter( ( q ) => now - q.t < 2200 );
		for ( const q of this.pings ) {

			const k = ( now - q.t ) / 2200;
			const [ x, y ] = this.toScreen( q.x, q.y );
			ctx.strokeStyle = `rgba(${COLORS[ q.kind ] ?? COLORS.info},${1 - k})`;
			ctx.lineWidth = 2;
			for ( const o of [ 0, 0.3 ] ) {

				const kk = Math.min( 1, k + o );
				ctx.beginPath(); ctx.arc( x, y, 8 + kk * 60, 0, Math.PI * 2 ); ctx.stroke();

			}

			// off-screen pings: an arrow at the edge pointing to the event
			const w = window.innerWidth, h = window.innerHeight;
			if ( x < 0 || y < 0 || x > w || y > h ) {

				const cx = w / 2, cy = h / 2, a = Math.atan2( y - cy, x - cx );
				const ex = Math.max( 30, Math.min( w - 30, cx + Math.cos( a ) * w ) ), ey = Math.max( 60, Math.min( h - 30, cy + Math.sin( a ) * h ) );
				ctx.fillStyle = `rgba(${COLORS[ q.kind ] ?? COLORS.info},${1 - k * 0.5})`;
				ctx.beginPath();
				ctx.moveTo( ex + Math.cos( a ) * 12, ey + Math.sin( a ) * 12 );
				ctx.lineTo( ex + Math.cos( a + 2.5 ) * 10, ey + Math.sin( a + 2.5 ) * 10 );
				ctx.lineTo( ex + Math.cos( a - 2.5 ) * 10, ey + Math.sin( a - 2.5 ) * 10 );
				ctx.fill();

			}

		}

	}

}
