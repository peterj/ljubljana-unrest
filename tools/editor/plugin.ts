// Dev-server API for the map editor (tools/editor/): lists, reads and saves maps/<city>/<area>.json and runs
// tools/mapbuild on them. Only the dev server (`npm run editor`) has it; `vite build` leaves it out.
//
//   GET  /__maps                      [ { id, name, center, size } ]
//   GET  /__maps/<city>/<area>        the settings
//   PUT  /__maps/<city>/<area>        save the settings (JSON body)
//   POST /__maps/<city>/<area>/build  run the build; streams its log, the last line is "exit <code>"
//   GET  /__maps/<city>/<area>/view   what the editor draws from the last build (.cache/maps/<city>-<area>.editor.json)
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const ID = /^[a-z0-9_-]+$/;

// JSON with two-space indents, but arrays of plain values ([lon, lat], name tags) on one line
function pretty( d, indent = '' ) {

	const inner = indent + '  ';
	if ( Array.isArray( d ) ) {

		if ( d.every( ( v ) => v === null || typeof v !== 'object' ) ) return '[' + d.map( ( v ) => JSON.stringify( v ) ).join( ', ' ) + ']';
		return '[\n' + d.map( ( v ) => inner + pretty( v, inner ) ).join( ',\n' ) + '\n' + indent + ']';

	}

	if ( d && typeof d === 'object' ) {

		const keys = Object.keys( d );
		if ( ! keys.length ) return '{}';
		return '{\n' + keys.map( ( k ) => inner + JSON.stringify( k ) + ': ' + pretty( d[ k ], inner ) ).join( ',\n' ) + '\n' + indent + '}';

	}

	return JSON.stringify( d );

}

export function mapEditor(): Plugin {

	const building = new Set();

	return {
		name: 'map-editor',
		apply: 'serve',
		configureServer( server ) {

			const root = server.config.root;
			const maps = path.join( root, 'maps' );

			server.middlewares.use( '/__maps', async ( req, res ) => {

				const send = ( status, body ) => {

					res.statusCode = status;
					res.setHeader( 'Content-Type', 'application/json' );
					res.end( JSON.stringify( body ) );

				};

				try {

					const parts = ( req.url ?? '/' ).split( '?' )[ 0 ].split( '/' ).filter( Boolean );
					if ( parts.length === 0 && req.method === 'GET' ) {

						const list = [];
						for ( const city of await fs.readdir( maps, { withFileTypes: true } ).catch( () => [] ) ) {

							if ( ! city.isDirectory() || ! ID.test( city.name ) ) continue;
							for ( const f of await fs.readdir( path.join( maps, city.name ) ) ) {

								if ( ! f.endsWith( '.json' ) ) continue;
								const d = JSON.parse( await fs.readFile( path.join( maps, city.name, f ), 'utf8' ) );
								list.push( { id: `${ city.name }/${ f.slice( 0, - 5 ) }`, name: d.name, center: d.center, size: d.size } );

							}

						}

						return send( 200, list );

					}

					const [ city, area, action ] = parts;
					if ( ! ID.test( city ?? '' ) || ! ID.test( area ?? '' ) || parts.length > 3 ) return send( 404, { error: 'not found' } );
					if ( city === 'ljubljana' ) return send( 403, { error: 'the Ljubljana maps are built by tools/build_city.py' } );
					const file = path.join( maps, city, area + '.json' );

					if ( ! action && req.method === 'GET' ) {

						return send( 200, JSON.parse( await fs.readFile( file, 'utf8' ) ) );

					}

					if ( ! action && req.method === 'PUT' ) {

						let body = '';
						for await ( const chunk of req ) body += chunk;
						const d = JSON.parse( body );
						if ( typeof d?.name !== 'string' || ! Array.isArray( d.center ) || ! Array.isArray( d.size ) ) {

							return send( 400, { error: 'name, center and size are required' } );

						}

						await fs.mkdir( path.dirname( file ), { recursive: true } );
						await fs.writeFile( file, pretty( d ) + '\n' );
						return send( 200, { saved: path.relative( root, file ) } );

					}

					if ( action === 'view' && req.method === 'GET' ) {

						const view = path.join( root, '.cache', 'maps', `${ city }-${ area }.editor.json` );
						const data = await fs.readFile( view, 'utf8' ).catch( () => null );
						if ( data === null ) return send( 404, { error: 'not built yet' } );
						res.setHeader( 'Content-Type', 'application/json' );
						return res.end( data );

					}

					if ( action === 'build' && req.method === 'POST' ) {

						const id = `${ city }/${ area }`;
						if ( building.has( id ) ) return send( 409, { error: 'a build of this map is already running' } );
						building.add( id );
						res.setHeader( 'Content-Type', 'text/plain; charset=utf-8' );
						res.setHeader( 'Cache-Control', 'no-cache' );
						const child = spawn( 'uv', [ 'run', '--project', 'tools/mapbuild', 'mapbuild', id ], { cwd: root } );
						child.stdout.on( 'data', ( b ) => res.write( b ) );
						child.stderr.on( 'data', ( b ) => res.write( b ) );
						child.on( 'error', ( e ) => {

							building.delete( id );
							res.end( `could not start uv: ${ e.message }\nexit 127\n` );

						} );
						child.on( 'close', ( code ) => {

							building.delete( id );
							res.end( `exit ${ code }\n` );

						} );
						return;

					}

					send( 405, { error: 'method not allowed' } );

				} catch ( e ) {

					send( e.code === 'ENOENT' ? 404 : 500, { error: e.message } );

				}

			} );

		},
	};

}
