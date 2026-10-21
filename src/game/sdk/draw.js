import { RED } from './colors.js';

// announced police moves: dashed red rings with a countdown
export function drawPending( o, pending, t ) {

	const ctx = o.ctx;
	for ( const p of pending ) {

		const [ x, y ] = o.toScreen( ...p.at ), r = p.r / o.mpp;
		ctx.setLineDash( [ 6, 5 ] );
		ctx.strokeStyle = RED;
		ctx.lineWidth = 1.5;
		ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.stroke();
		ctx.setLineDash( [] );
		ctx.fillStyle = RED;
		ctx.font = '600 10px "IBM Plex Mono", monospace';
		ctx.textAlign = 'center';
		ctx.fillText( `${p.label.toUpperCase()} · ${Math.ceil( p.until - t )}`, x, y - r - 4 );

	}

}
