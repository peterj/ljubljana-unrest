// Top-down pan/zoom for an orthographic camera looking down -Z. Drag (left or middle) pans,
// wheel zooms around the cursor, two-finger pinch zooms on touch.
import { Vector2 } from 'three/webgpu';

export class PanZoom {

	constructor( camera, dom, { bounds, minMpp = 0.04, maxMpp = 4 } ) {

		this.camera = camera;
		this.dom = dom;
		this.bounds = bounds; // [minX, minY, maxX, maxY]
		this.minMpp = minMpp;
		this.maxMpp = maxMpp;
		this.center = new Vector2( 0, 0 );
		this.mpp = 1.2; // metres per CSS pixel
		this.onChange = () => {};
		this.onGesture = () => {}; // 'pan' | 'zoom', from the player only (not from code moving the camera)
		this.shouldPan = () => true;
		this.pointers = new Map();
		this.dragMoved = 0;

		dom.addEventListener( 'pointerdown', ( e ) => this._down( e ) );
		dom.addEventListener( 'pointermove', ( e ) => this._move( e ) );
		dom.addEventListener( 'pointerup', ( e ) => this._up( e ) );
		dom.addEventListener( 'pointercancel', ( e ) => this._up( e ) );
		dom.addEventListener( 'wheel', ( e ) => this._wheel( e ), { passive: false } );
		dom.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );
		this.update();

	}

	screenToWorld( sx, sy ) {

		const r = this.dom.getBoundingClientRect();
		return new Vector2(
			this.center.x + ( sx - r.left - r.width / 2 ) * this.mpp,
			this.center.y - ( sy - r.top - r.height / 2 ) * this.mpp
		);

	}

	worldToScreen( x, y ) {

		const r = this.dom.getBoundingClientRect();
		return [ ( x - this.center.x ) / this.mpp + r.width / 2, - ( y - this.center.y ) / this.mpp + r.height / 2 ];

	}

	zoomAt( sx, sy, factor ) {

		const before = this.screenToWorld( sx, sy );
		this.mpp = Math.min( this.maxMpp, Math.max( this.minMpp, this.mpp * factor ) );
		const after = this.screenToWorld( sx, sy );
		this.center.add( before.sub( after ) );
		this.update();
		this.onGesture( 'zoom' );

	}

	_down( e ) {

		if ( e.button === 2 || ! this.shouldPan( e ) ) return;
		this.dom.setPointerCapture( e.pointerId );
		this.pointers.set( e.pointerId, { x: e.clientX, y: e.clientY } );
		this.dragMoved = 0;

	}

	_move( e ) {

		const p = this.pointers.get( e.pointerId );
		if ( ! p ) return;
		if ( this.pointers.size === 2 ) {

			const [ a, b ] = [ ...this.pointers.values() ];
			const d0 = Math.hypot( a.x - b.x, a.y - b.y );
			p.x = e.clientX; p.y = e.clientY;
			const d1 = Math.hypot( a.x - b.x, a.y - b.y );
			if ( d0 > 0 && d1 > 0 ) this.zoomAt( ( a.x + b.x ) / 2, ( a.y + b.y ) / 2, d0 / d1 );
			return;

		}

		const dx = e.clientX - p.x, dy = e.clientY - p.y;
		p.x = e.clientX; p.y = e.clientY;
		this.dragMoved += Math.abs( dx ) + Math.abs( dy );
		this.center.x -= dx * this.mpp;
		this.center.y += dy * this.mpp;
		this.update();
		this.onGesture( 'pan' );

	}

	_up( e ) {

		this.pointers.delete( e.pointerId );

	}

	_wheel( e ) {

		e.preventDefault();
		this.zoomAt( e.clientX, e.clientY, Math.exp( e.deltaY * 0.0015 ) );

	}

	update() {

		const [ x0, y0, x1, y1 ] = this.bounds;
		this.center.x = Math.min( x1, Math.max( x0, this.center.x ) );
		this.center.y = Math.min( y1, Math.max( y0, this.center.y ) );
		const w = this.dom.clientWidth, h = this.dom.clientHeight;
		const cam = this.camera;
		cam.left = - w / 2 * this.mpp;
		cam.right = w / 2 * this.mpp;
		cam.top = h / 2 * this.mpp;
		cam.bottom = - h / 2 * this.mpp;
		cam.position.set( this.center.x, this.center.y, 100 );
		cam.updateProjectionMatrix();
		this.onChange();

	}

}
