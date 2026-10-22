// HTML overlay labels for landmarks, squares and (when zoomed in) street names.
export class Labels {

	declare root: any;
	declare controls: any;
	declare items: any[];

	constructor( root, city, controls ) {

		this.root = root;
		this.controls = controls;
		this.items = [];
		const seen = new Set<any>();
		const add = ( text, pos, cls, maxMpp ) => {

			const el = document.createElement( 'div' );
			el.className = 'lbl ' + cls;
			el.textContent = text;
			root.appendChild( el );
			this.items.push( { el, pos, maxMpp, angle: 0 } );
			return this.items[ this.items.length - 1 ];

		};

		for ( const l of city.landmarks ) {

			if ( seen.has( l.name ) || l.name === 'Policija' ) continue;
			seen.add( l.name );
			add( l.name, l.pos, l.kind, l.kind === 'gov' || l.kind === 'police' ? 1.6 : 0.7 );

		}

		for ( const p of city.pois ) if ( p.kind === 'place' ) add( p.name, p.pos, 'place', 2.5 );
		for ( const s of city.labels ) {

			let a = s.ang;
			if ( a > Math.PI / 2 ) a -= Math.PI;
			if ( a < - Math.PI / 2 ) a += Math.PI;
			add( s.name, s.pos, 'street', s.len > 600 ? 0.5 : 0.28 ).angle = a;

		}

	}

	setVisible( v ) {

		this.root.style.display = v ? '' : 'none';

	}

	update() {

		const mpp = this.controls.mpp;
		const w = window.innerWidth, h = window.innerHeight;
		for ( const it of this.items ) {

			const [ x, y ] = this.controls.worldToScreen( it.pos[ 0 ], it.pos[ 1 ] );
			const show = mpp <= it.maxMpp && x > - 100 && y > - 20 && x < w + 100 && y < h + 20;
			it.el.style.display = show ? '' : 'none';
			if ( show ) it.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${- it.angle}rad)`;

		}

	}

}
