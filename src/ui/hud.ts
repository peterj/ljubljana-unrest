// DOM HUD: top bar, objectives, opinion meter, command panel, event feed, and the modal cards
// (mission menu, briefing, result).
import { fmt } from '../game/mission.ts';

const $ = ( id ) => document.getElementById( id );
const esc = ( s ) => String( s ).replace( /[&<>"]/g, ( c ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ c ] ) );

// mission text is data, not markup: everything is escaped except <b> and <i>, which are kept balanced
export function richText( s ) {

	const open = [];
	const out = esc( s ).replace( /&lt;(\/?)(b|i)&gt;/g, ( _, close, tag ) => {

		if ( ! close ) { open.push( tag ); return `<${tag}>`; }
		if ( open.at( - 1 ) !== tag ) return ''; // a closer with no matching opener
		open.pop();
		return `</${tag}>`;

	} );
	return out + open.reverse().map( ( tag ) => `</${tag}>` ).join( '' );

}

const starStr = ( n ) => '★★★'.split( '' ).map( ( s, k ) => k < n ? s : `<span class="off">${s}</span>` ).join( '' );

// what each order does, by side and key: the "How to play" table and the order panel's info box both read it.
// A mission's own command can bring its own text (c.desc), which wins.
const DESC = {
	police: { rmb: 'send selected squads there in block formation; patrol cars drive there by road',
		l: 'press L, then drag with the left button: the squads hold the line 2–3 deep. Right-drag or Ctrl-drag also draws one',
		k: 'surround the crowd at the cursor and tighten (force)', c: 'charge the crowd at the cursor (force, injuries)',
		a: 'wade in and restrain people at the cursor (slow, low force)', x: 'arrest the nearest CCTV-identified leader',
		g: 'tear gas cloud at the cursor (limited, costs opinion)',
		s: 'squads standing in a cordon line: shows how far the line can advance; hold the left button to aim, release to push forward shields up, shoving the crowd back. Stops when the crowd is too dense to move',
		w: 'water cannon truck selected: shows its reach; hold the left button to aim, release to spray for 10 s (limited). Right-click drives the truck, Esc puts the cannon away',
		f: 'fresh squad from the nearest police station, sent to the cursor', o: 'firearms — last resort, confirm dialog, caps the mission at 1★',
		b: 'loudspeaker order over the crowd at the cursor: calmer groups go home, the hard core gets angrier. A group hears it once',
		u: 'parked patrol car: crew gets out beside it, or nearby crew get back in (cars also pick up their crew when they drive off)' },
	protest: { rmb: 'march the selected groups there', h: 'stop and hold where they stand', e: 'raise agitation and resolve. Again: push the police line (costs sympathy). Three times: storm it for 40 s (costs a lot)',
		q: 'one level calmer: from storming to pushing, from pushing to marching, calms them down', d: 'scatter the group',
		s: 'sit down (or stand up): slow to arrest, and force against sitters is hard to justify',
		b: 'locked arms and banners: half speed, hard to push back or pull people out of', w: 'scatter for 8 s (out of a kettle, away from a charge), then regroup at the cursor',
		v: 'split each selected group in two; the half without the leader gets a new one', m: 'merge the selected groups into the largest one',
		u: 'umbrellas up for 0:30: tear gas barely reaches them (limited)',
		r: 'call more people to join, near the cursor (cooldown)' },
};

export const describe = ( side, c ) => c.desc ?? DESC[ side ]?.[ c.key ] ?? c.hint ?? '';

export function bestStars() {

	try { return JSON.parse( localStorage.getItem( 'lu-stars' ) || '{}' ); } catch { return {}; }

}

export function saveStars( id, n ) {

	try {

		const b = bestStars();
		b[ id ] = Math.max( b[ id ] ?? 0, n );
		localStorage.setItem( 'lu-stars', JSON.stringify( b ) );

	} catch { /* storage unavailable: progress just is not remembered */ }

}

export class Hud {

	declare game: any;
	declare feed: HTMLElement;
	declare prevObj: any[];
	declare hoverKey: any;

	constructor( game ) {

		this.game = game;
		this.feed = $( 'feed' );
		this.prevObj = [];
		$( 'pauseBtn' ).onclick = () => game.togglePause();
		$( 'speedBtn' ).onclick = () => game.cycleSpeed();
		$( 'soundBtn' ).onclick = () => game.toggleSound();
		$( 'strobeBtn' ).onclick = () => game.toggleStrobe();
		$( 'menuBtn' ).onclick = () => game.toMenu();

	}

	show( mission ) {

		$( 'hud' ).hidden = false;
		$( 'mTitle' ).textContent = mission.constructor.title;
		$( 'mSub' ).textContent = mission.constructor.subtitle;
		$( 'opLabel' ).textContent = mission.opinionLabel;

	}

	toast( text, kind = 'info' ) {

		const d = document.createElement( 'div' );
		d.className = kind;
		d.textContent = text;
		this.feed.appendChild( d );
		[ ...this.feed.children ].slice( 0, - 2 ).forEach( ( c ) => c.classList.add( 'old' ) );
		while ( this.feed.children.length > 6 ) this.feed.firstChild.remove();
		setTimeout( () => { d.style.opacity = '0'; setTimeout( () => d.remove(), 700 ); }, 9000 );

	}

	opinionDelta( d, why ) {

		const s = document.createElement( 'span' );
		s.className = d < 0 ? 'neg' : 'pos';
		s.textContent = `${d > 0 ? '+' : ''}${d} ${why ?? ''}`;
		$( 'opDelta' ).appendChild( s );
		setTimeout( () => s.remove(), 1600 );

	}

	// called a few times per second
	update( m ) {

		const g = this.game;
		$( 'clock' ).textContent = fmt( m.t );
		$( 'pauseBtn' ).textContent = g.paused ? '▶' : '❚❚';
		$( 'speedBtn' ).textContent = g.speed + '×';
		$( 'soundBtn' ).classList.toggle( 'off', g.sound.muted );
		$( 'strobeBtn' ).hidden = ! m.constructor.flashing && ! g.world?.standoff?.flashed; // firecrackers flash too
		$( 'strobeBtn' ).classList.toggle( 'off', g.strobeOff );
		const ph = m.phase();
		$( 'phase' ).textContent = ph;
		$( 'phase' ).className = /HALTED|HOLDING|ALERT|FIRING/.test( ph ) ? 'bad' : '';

		const objs = m.objectives();
		const list = $( 'objList' );
		if ( list.children.length !== objs.length ) list.innerHTML = objs.map( () => '<li><div class="ol"><span></span><b></b></div><div class="bar"><i></i></div></li>' ).join( '' );
		objs.forEach( ( o, k ) => {

			const li = list.children[ k ] as HTMLElement;
			li.className = `${o.state}${o.invert ? ' inv' : ''}`;
			li.querySelector( 'span' ).textContent = o.label;
			li.querySelector( 'b' ).textContent = o.text;
			li.querySelector( 'i' ).style.width = `${Math.round( Math.max( 0, Math.min( 1, o.value ) ) * 100 )}%`;
			const prev = this.prevObj[ k ];
			if ( prev && prev.state !== o.state ) { li.classList.remove( 'pulse' ); void li.offsetWidth; li.classList.add( 'pulse' ); }

		} );
		this.prevObj = objs;

		$( 'opValue' ).textContent = String( Math.round( m.opinion ) );
		const ESC = [ 'none', 'force', 'tear gas', 'water cannon', 'FIREARMS' ];
		$( 'escBar' ).innerHTML = m.side === 'police'
			? [ 1, 2, 3, 4 ].map( ( k ) => `<i class="${k <= m.escalation ? 'on l' + k : ''}"></i>` ).join( '' ) + ` <em>${ESC[ m.escalation ]}</em>` : '';
		$( 'escBar' ).parentElement.hidden = m.side !== 'police';
		$( 'opBar' ).style.left = `calc(${m.opinion}% - 1px)`;

		this.updateCommands( m );

	}

	updateCommands( m ) {

		const g = this.game, sel = g.selected;
		const people = g.squads.reduce( ( s, q ) => s + ( q.alive ?? q.members.length ), 0 );
		$( 'selTitle' ).textContent = sel.length ? ( sel.length === 1 ? sel[ 0 ].label : `${sel.length} units` ) : 'No units selected';
		$( 'selInfo' ).textContent = sel.length === 1 && sel[ 0 ].isCar ? `Patrol car · ${sel[ 0 ].info ?? ''}` : sel.length
			? `${people} people · ${sel.length === 1 && sel[ 0 ].agitation !== undefined ? 'agitation ' + Math.round( sel[ 0 ].agitation * 100 ) + '%' : ''}${sel.length === 1 && sel[ 0 ].leaderState && sel[ 0 ].leaderState !== 'active' ? ' · leader ' + sel[ 0 ].leaderState : ''}`
			: 'Click a unit to select it. Shift adds; shift-drag selects a box. Space pauses.';

		const cmds = m.commands().filter( ( c ) => ! c.hide?.() );
		const key = cmds.map( ( c ) => c.key ).join();
		const box = $( 'cmdList' );
		if ( box.dataset.key !== key ) {

			box.dataset.key = key;
			box.innerHTML = '';
			for ( const c of cmds ) {

				const b = document.createElement( 'button' );
				b.dataset.key = c.key;
				if ( c.danger ) b.style.borderColor = 'rgba(255,45,85,0.5)';
				// letter keys always show the letter; mouse commands show the hint. What it does: the info box on hover
				const letter = c.key.length === 1;
				b.innerHTML = `<span>${esc( c.label )}</span><span class="res"></span><kbd>${esc( letter ? c.key.toUpperCase() : c.hint ?? c.key )}</kbd>`;
				// not a real `disabled`: disabled buttons get no hover events, and the info box says why it is off
				b.onclick = () => g.command( c.key );
				b.onpointerenter = () => { this.hoverKey = c.key; this.cmdInfo( m ); };
				b.onpointerleave = () => { if ( this.hoverKey === c.key ) { this.hoverKey = null; this.cmdInfo( m ); } };
				box.appendChild( b );

			}

		}

		for ( const c of cmds ) {

			const b = box.querySelector( `[data-key="${c.key}"]` );
			const r = c.resource ? m.resources[ c.resource ] : null;
			b.querySelector( '.res' ).textContent = r ? ( r.ready > 0 ? fmt( r.ready ) : r.max > 20 ? '' : `${r.left}/${r.max}` ) : '';
			b.classList.toggle( 'off', ! g.hasSelFor( c ) || !! ( r && ( r.left <= 0 || r.ready > 0 ) ) || ! c.run );
			b.classList.toggle( 'armed', g.armed === c.key || ( c.key === 'l' && !! g.drawing ) );
			b.classList.toggle( 'coach', !! m.coachKeys?.includes( c.key ) );

		}

		this.cmdInfo( m );

	}

	// the tutorial's instruction card: { chapter, text (<b>/<i> allowed), step, total, next?, onNext, onSkip?, spot? (a HUD element id to point at) }
	coach( c ) {

		const el = $( 'coach' );
		document.querySelectorAll( '.coach-spot' ).forEach( ( q ) => q.classList.remove( 'coach-spot' ) );
		el.hidden = ! c;
		if ( ! c ) return;
		if ( c.spot ) $( c.spot )?.classList.add( 'coach-spot' );
		el.innerHTML = `<div class="co-head"><h2>${esc( c.chapter )}</h2><span>${c.step} / ${c.total}</span></div>
			<p>${richText( c.text )}</p>
			<div class="co-go">${c.onSkip ? '<button class="co-skip">Skip</button>' : ''}${c.next ? '<button class="co-next primary">Continue</button>' : ''}</div>`;
		// blur: a focused button would also take the next Space / Enter meant for the game
		el.querySelector( '.co-skip' )?.addEventListener( 'click', ( e ) => { ( e.currentTarget as HTMLElement ).blur(); c.onSkip(); } );
		el.querySelector( '.co-next' )?.addEventListener( 'click', ( e ) => { ( e.currentTarget as HTMLElement ).blur(); c.onNext(); } );
		el.classList.remove( 'fresh' );
		void el.offsetWidth;
		el.classList.add( 'fresh' );

	}

	// the order under the mouse: what it does, what it costs, and why it is greyed out
	cmdInfo( m ) {

		const el = $( 'cmdInfo' ), c = this.hoverKey && m.commands().find( ( q ) => q.key === this.hoverKey );
		if ( ! c ) { el.hidden = true; return; }
		const g = this.game, r = c.resource ? m.resources[ c.resource ] : null, protest = m.side === 'protest';
		const keyName = { rmb: 'right-click' }[ c.key ] ?? c.key.toUpperCase();
		let state = '', bad = true;
		if ( ! c.run ) { state = 'Use the mouse on the map'; bad = false; }
		else if ( ! g.hasSelFor( c ) ) state = c.forCordon ? 'Select squads standing in a cordon line (L or right-drag forms one)'
			: c.forCars ? ( c.key === 'w' ? 'Select the water cannon truck first' : 'Select a patrol car first' ) : `Select ${protest ? 'a group' : 'a squad'} first`;
		else if ( r && r.left <= 0 ) state = 'None left';
		else if ( r && r.ready > 0 ) state = `Ready in ${fmt( r.ready )}`;
		else { bad = false; if ( r && r.max <= 20 ) state = `${r.left} of ${r.max} left`; }
		el.hidden = false;
		el.innerHTML = `<div class="ci-head"><b>${esc( c.label )}</b><kbd>${esc( keyName )}</kbd></div><p>${esc( describe( m.side, c ) )}</p>${state ? `<div class="ci-state${bad ? ' bad' : ''}">${esc( state )}</div>` : ''}`;

	}

	// ------------------------------------------------------------------ modal cards
	modal( html ) {

		const el = $( 'modal' );
		el.innerHTML = html;
		el.hidden = ! html;
		return el;

	}

	// the landing page: the training mission, then the cities ({ id, name, country, open, missions })
	home( training, cities, onMission, onCity, notes = [] ) {

		const best = bestStars();
		const el = this.modal( `<div class="card">
			<h1>Cordon <span class="bleu">Bleu</span></h1>
			<div class="sub">Crowd strategy on the streets of real cities. Start with training, then pick a city.</div>
			${notes.map( ( n ) => `<p class="note">Plugin not loaded: ${esc( n )}</p>` ).join( '' )}
			${training ? `<div class="missions">${this.missionCard( training, best, 0 )}</div>` : ''}
			<h3>Cities</h3>
			<div class="missions cities">${cities.map( ( c, k ) => `
				<button class="mcard city" data-c="${k}"${c.open ? '' : ' disabled'}>
					<div class="row"><span class="t">${esc( c.name )}</span>${c.open ? '' : '<span class="side soon">soon</span>'}</div>
					<div class="s">${esc( c.country )}</div>
					<div class="count">${c.open ? `${c.missions} mission${c.missions === 1 ? '' : 's'}` : 'In preparation'}</div>
				</button>` ).join( '' )}
			</div>
			${this.footer()}
		</div>` );
		el.querySelector<HTMLElement>( '.mcard[data-k]' )?.addEventListener( 'click', () => onMission( training ) );
		el.querySelectorAll<HTMLElement>( '.mcard[data-c]' ).forEach( ( b ) => b.onclick = () => onCity( cities[ + b.dataset.c ] ) );

	}

	// a built map without a mission (?map=<city>/<map>, linked from the map editor): what missions can refer to by name
	preview( id, city, onHome ) {

		const n = ( k ) => city.pois.filter( ( p ) => p.kind === k ).length;
		const src = city.source ? `${esc( city.source.extract )}, ${esc( city.source.timestamp?.slice( 0, 10 ) ?? '?' )}` : 'tools/build_city.py';
		const el = document.createElement( 'div' );
		el.id = 'preview';
		el.className = 'panel';
		el.innerHTML = `<h2>Map preview // ${esc( id )}</h2>
			<p class="hint">${city.buildings.length} buildings · ${n( 'place' )} places · ${city.landmarks.length} landmarks ·
				${Object.keys( city.targets ).length} targets · ${city.entries.length} entries · ${n( 'bus' )} stops · ${n( 'camera' )} cameras${city.route.length ? ' · a convoy route' : ''}</p>
			<p class="hint">Data: ${src}. Drag to pan, wheel to zoom.</p>
			<button id="pvHome">Home</button>`;
		document.body.append( el );
		el.querySelector<HTMLElement>( '#pvHome' ).onclick = onHome;

	}

	// one city's missions
	menu( city, missions, onPick, onBack, notes = [] ) {

		const best = bestStars();
		const el = this.modal( `<div class="card">
			<h1>Cordon <span class="bleu">Bleu</span> <span>// ${esc( city.name )}</span></h1>
			<div class="sub">Crowd strategy in the streets of ${esc( city.name )}. Pick a mission.</div>
			${notes.map( ( n ) => `<p class="note">Plugin not loaded: ${esc( n )}</p>` ).join( '' )}
			<div class="missions">${missions.map( ( M, k ) => this.missionCard( M, best, k ) ).join( '' )}</div>
			<div class="go"><button id="mBack">Cities</button></div>
			${this.footer()}
		</div>` );
		el.querySelectorAll<HTMLElement>( '.mcard' ).forEach( ( b ) => b.onclick = () => onPick( missions[ + b.dataset.k ] ) );
		el.querySelector<HTMLElement>( '#mBack' ).onclick = onBack;

	}

	missionCard( M, best, k ) {

		return `
				<button class="mcard" data-k="${k}">
					<div class="row"><span class="t">${esc( M.title )}</span>${M.tutorial
		? `<span class="side tutorial">${best[ M.id ] ? 'tutorial' : 'start here'}</span>` : `<span class="side ${M.side}">${M.side}</span>`}</div>
					<div class="s">${esc( M.subtitle )}</div>
					<div class="stars">${starStr( best[ M.id ] ?? 0 )}</div>
				</button>`;

	}

	footer() {

		return `<p class="hint" style="margin-top:14px">Drag to pan · wheel to zoom · Space to pause · the cities are real: map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>; Ljubljana buildings © GURS, stops © LPP.</p>
			<p class="credit">© 2026 Virostatiq // <a href="https://bloki.si" target="_blank" rel="noopener">bloki.si</a> // <a href="https://github.com/virostatiq/ljubljana-unrest" target="_blank" rel="noopener">GitHub</a></p>`;

	}

	// "how to play": camera + selection basics, then the mission's own command set (keys as bound)
	howTo( side, commands ) {

		const keyName = ( k ) => ( { rmb: 'Right-click' }[ k ] ?? k.toUpperCase() );
		const row = ( k, label, desc ) => `<tr><td><kbd>${esc( k )}</kbd></td><td><b>${esc( label )}</b>${desc ? ' — ' + esc( desc ) : ''}</td></tr>`;
		const unit = side === 'protest' ? 'group' : 'squad';
		const basics: [ string, string, string ][] = [
			[ 'Left-drag · wheel', 'Pan · zoom', '' ],
			[ 'Click', `Select a ${unit}`, `shift-click adds, shift-drag box-selects, Tab cycles through your ${unit}s, Esc clears` ],
			[ 'Space', 'Pause', 'orders can be given while paused' ],
			[ '+ / −', 'Speed 1–3×', 'or the speed button top right' ],
			[ 'N', 'Sound on / off', 'or the ♪ button top right' ],
		];
		return `<h3>How to play</h3>
			<p class="howto-lead">${side === 'protest'
		? 'You lead affinity groups, each with a leader. Members follow their leader: if the leader is arrested or hurt, the group falls apart.'
		: 'You command police squads. Officers act on their own inside the formation you give them; hurting people or escalating costs public opinion.'}
			Keyed orders fire at the <b>mouse cursor</b>; buttons in the order panel arm the order for the next map click.</p>
			<table class="howto">${basics.map( ( b ) => row( ...b ) ).join( '' )}
			${commands.map( ( c ) => row( keyName( c.key ), c.label, describe( side, c ) ) ).join( '' )}</table>`;

	}

	briefing( M, onStart, commands = [] ) {

		const el = this.modal( `<div class="card">
			<div class="row" style="display:flex;justify-content:space-between;align-items:center">
				<h1>${esc( M.title )}</h1><span class="side ${M.side}">${M.side}</span></div>
			<div class="sub">${esc( M.subtitle )}</div>
			<p>${richText( M.brief )}</p>
			<div class="cols">
				<div><h3>Objectives</h3><ul>${M.goals.map( ( g ) => `<li>${esc( g )}</li>` ).join( '' )}</ul></div>
				<div><h3>Tips</h3><ul>${M.tips.map( ( g ) => `<li>${esc( g )}</li>` ).join( '' )}</ul></div>
			</div>
			${this.howTo( M.side, commands )}
			<div class="go"><button id="bBack">Missions</button><button class="primary" id="bStart">Start ▶</button></div>
		</div>` );
		el.querySelector<HTMLElement>( '#bStart' ).onclick = () => { this.modal( '' ); onStart(); };
		el.querySelector<HTMLElement>( '#bBack' ).onclick = () => this.game.toMenu();

	}

	result( M, r, onRetry ) {

		saveStars( M.id, r.stars );
		const el = this.modal( `<div class="card" style="max-width:520px">
			<h1 style="text-align:center">${r.win ? 'Mission complete' : 'Mission failed'}</h1>
			<div class="result-stars stars">${'★★★'.split( '' ).map( ( s, k ) => k < r.stars ? `<span>${s}</span>` : `<span class="off">${s}</span>` ).join( '' )}</div>
			<p class="verdict ${r.win ? 'win' : 'lose'}">${esc( r.reason )}</p>
			<table>${r.lines.map( ( [ a, b ] ) => `<tr><td>${esc( a )}</td><td>${esc( b )}</td></tr>` ).join( '' )}</table>
			<div class="go"><button id="rMenu">Missions</button><button class="primary" id="rRetry">Retry</button></div>
		</div>` );
		el.querySelector<HTMLElement>( '#rRetry' ).onclick = onRetry;
		el.querySelector<HTMLElement>( '#rMenu' ).onclick = () => this.game.toMenu();

	}

}
