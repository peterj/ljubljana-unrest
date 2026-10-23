// Vector-noir palette: near-black ground, orange (protest), bright blue (police), muted white (civil).
// Values above 1 are HDR and will bloom; keep everything that should stay quiet well below ~0.6 luminance.
import { Color } from 'three/webgpu';

const c = ( hex, k = 1 ) => new Color( hex ).multiplyScalar( k );

export const PAL = {
	bg: c( 0x05070b ),
	park: c( 0x0b1611 ),
	parkEdge: c( 0x16291f ),
	water: c( 0x081826 ),
	waterEdge: c( 0x1d5d8c ),
	waterway: c( 0x1d5d8c ),
	roadMajor: c( 0x1a1f28 ),
	roadMinor: c( 0x14181f ),
	roadPed: c( 0x1f1a15 ), // warm tint: pedestrian zones are where crowds gather
	roadLine: c( 0x2a303b ),
	pathLine: c( 0x1d222b ),
	rail: c( 0x2c2a33 ),
	building: c( 0x0f1218 ),
	buildingEdge: c( 0x262d39 ),

	// landmark kinds: [fill, edge]
	kinds: {
		gov: [ c( 0x2b1206 ), c( 0xff6a10, 3.0 ) ],
		media: [ c( 0x2a1d06 ), c( 0xffb020, 2.4 ) ],
		police: [ c( 0x06162b ), c( 0x2b8cff, 3.0 ) ],
		hospital: [ c( 0x1c1c1a ), c( 0xe9e4d8, 1.8 ) ],
		embassy: [ c( 0x150f22 ), c( 0x9a7cff, 1.6 ) ],
		transit: [ c( 0x14181e ), c( 0x9fb0c4, 1.1 ) ],
		landmark: [ c( 0x17161a ), c( 0x6b6458 ) ],
	},

	camera: c( 0xff3b30, 1.4 ),
	bus: c( 0x6f7a8a ),

	protester: c( 0xd8641a ),
	protesterHot: c( 0xffa060, 3.2 ),
	police: c( 0x2b8cff, 1.6 ),
	policeHot: c( 0x9fd0ff, 3.5 ),
	bystander: c( 0x77756f ),
	sitter: c( 0xf4efe2, 1.6 ), // constitution readers: calm, bright, unmistakable
	counter: c( 0x9ad62a ), // counter-protesters: acid lime, the one off-palette colour, on purpose
	counterHot: c( 0xd8ff6a, 3.0 ),
	vip: c( 0xffffff, 2.5 ),
	patrol: c( 0x0d2244 ), // police car body
	cannon: c( 0xa0d2ff, 1.4 ), // water cannon turret
	civilCar: c( 0x3a3530 ), // the rescue car: unmarked, warm grey
	civilCarEdge: c( 0xff6a10, 2.2 ),
	siren: c( 0x3a8dff, 4.0 ), // rotating beacon + light bar: HDR so it blooms
	gas: c( 0xd9e2dc ),
	injured: c( 0xff2d55, 0.7 ),
	dead: c( 0x8a0d24, 0.55 ), // killed: a dark, dull red, unlike the bright injured dots
};

export const css = ( col ) => '#' + col.clone().multiplyScalar( 1 / Math.max( 1, col.r, col.g, col.b ) ).getHexString();
