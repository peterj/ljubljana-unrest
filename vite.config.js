import { defineConfig } from 'vite';

// share tags need absolute URLs; set SITE_URL to where the build will live (any subdirectory), e.g.
// SITE_URL=https://example.com/unrest/ npm run build. Without it they stay relative (fine for local use).
const SITE = process.env.SITE_URL ? process.env.SITE_URL.replace( /\/?$/, '/' ) : null;

const shareTags = {
	name: 'share-tags',
	transformIndexHtml( html ) {

		if ( ! SITE ) return html;
		return html.replace( /content="\.\/(og-image\.png)"/g, `content="${SITE}$1"` )
			.replace( '<!--og:url-->', `<meta property="og:url" content="${SITE}">` );

	},
};

// base './' so the build runs from any subdirectory on shared hosting
export default defineConfig( {
	base: './',
	plugins: [ shareTags ],
	build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 2000 },
	worker: { format: 'es' },
} );
