// Pool of flow-field layers in one RG16F array texture, sampled bilinearly by the crowd shader.
// Layers are requested by goal (world position + radius) and computed in a small worker pool.
import * as THREE from 'three/webgpu';

export class FlowFields {

	declare w: any;
	declare h: any;
	declare res: any;
	declare x0: any;
	declare y0: any;
	declare layers: number;
	declare data: Uint16Array<ArrayBuffer>;
	declare texture: THREE.DataArrayTexture;
	declare slots: any[];
	declare pending: Map<any, any>;
	declare queue: any[];
	declare nextId: number;
	declare workers: Worker[];
	declare idle: Worker[];

	constructor( city, layers = 32, workers = 3 ) {

		const { w, h, res } = city.cost;
		this.w = w; this.h = h; this.res = res;
		this.x0 = city.bounds[ 0 ]; this.y0 = city.bounds[ 1 ];
		this.layers = layers;
		this.data = new Uint16Array( w * h * 2 * layers );
		this.texture = new THREE.DataArrayTexture( this.data, w, h, layers );
		this.texture.format = THREE.RGFormat;
		this.texture.type = THREE.HalfFloatType;
		this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
		this.texture.generateMipmaps = false;
		this.texture.needsUpdate = true;

		this.slots = new Array( layers ).fill( null ); // { key, pinned, lastUse }
		this.pending = new Map<any, any>(); // id → { resolve, layer }
		this.queue = [];
		this.nextId = 1;
		this.workers = [];
		this.idle = [];
		for ( let i = 0; i < workers; i ++ ) {

			const wk = new Worker( new URL( './flowfield.worker.ts', import.meta.url ), { type: 'module' } );
			wk.postMessage( { type: 'init', cost: city.costData, w, h } );
			wk.onmessage = ( e ) => this._done( wk, e.data );
			this.workers.push( wk );
			this.idle.push( wk );

		}

	}

	toCell( x, y ) {

		return [ Math.floor( ( x - this.x0 ) / this.res ), Math.floor( ( y - this.y0 ) / this.res ) ];

	}

	// goals: [{x, y, r}] in world metres. Returns Promise<layerIndex>. Same key → same layer.
	request( key, goals, { pinned = false } = {} ) {

		let layer = this.slots.findIndex( ( s ) => s && s.key === key );
		if ( layer >= 0 ) {

			this.slots[ layer ].lastUse = performance.now();
			return this.slots[ layer ].ready;

		}

		layer = this.slots.findIndex( ( s ) => s === null );
		if ( layer < 0 ) {

			let best = - 1, t = Infinity;
			this.slots.forEach( ( s, i ) => {

				if ( ! s.pinned && ! s.refs && s.lastUse < t && s.done ) { t = s.lastUse; best = i; }

			} );
			if ( best < 0 ) throw new Error( 'flow field pool exhausted' );
			layer = best;

		}

		const id = this.nextId ++;
		const slot: { key: any, pinned: boolean, lastUse: number, done: boolean, refs: number, ready?: Promise<any> } = { key, pinned, lastUse: performance.now(), done: false, refs: 0 };
		slot.ready = new Promise( ( resolve ) => this.pending.set( id, { resolve, layer, slot } ) );
		this.slots[ layer ] = slot;
		const cells = goals.map( ( g ) => [ ...this.toCell( g.x, g.y ), Math.max( 1, g.r / this.res ) ] );
		this.queue.push( { type: 'field', id, goals: cells } );
		this._pump();
		return slot.ready;

	}

	// groups currently steering by a layer hold a reference so it is never recycled under them
	retain( layer ) {

		const s = this.slots[ layer ];
		if ( s ) { s.refs ++; s.lastUse = performance.now(); }

	}

	release( layer ) {

		const s = this.slots[ layer ];
		if ( s && s.refs > 0 ) s.refs --;

	}

	_pump() {

		while ( this.queue.length && this.idle.length ) this.idle.pop().postMessage( this.queue.shift() );

	}

	_done( wk, m ) {

		this.idle.push( wk );
		this._pump();
		const p = this.pending.get( m.id );
		if ( ! p ) return;
		this.pending.delete( m.id );
		this.data.set( m.dirs, p.layer * this.w * this.h * 2 );
		this.texture.addLayerUpdate( p.layer );
		this.texture.needsUpdate = true;
		p.slot.done = true;
		p.resolve( p.layer );

	}

}
