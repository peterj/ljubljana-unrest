// Sound: recorded effects (public/sfx, Pixabay) placed on the map, police radio traffic, and a Tone.js
// atmosphere (city rumble, wind, a tension drone, crowd beds that follow what is on screen).
// Everything is a no-op until the first click or key (browsers keep audio locked until then) and while the
// audio context is not running, so headless runs and game.advance() cost nothing.
import * as Tone from 'tone';
import { FACTION, MODE } from '../sim/crowd.ts';

const FILES = [
	'bang', 'car_pass', 'crowd_calm', 'crowd_roar', 'drums', 'gas_launch', 'handcuffs', 'panic', 'riot',
	'shot_1', 'shot_2', 'shot_3', 'siren_arrive', 'siren_far', 'siren_loop', 'smash', 'truck',
	'whistle_1', 'whistle_2', 'whistle_3', 'whistle_long',
	'radio_clear', 'radio_correct', 'radio_maam', 'radio_negative', 'radio_onmyway',
	'chat_1', 'chat_2', 'chat_3', 'chat_4', 'chat_5', 'chat_6', 'chat_7', 'chat_8', 'chat_9', 'chat_10',
	'voice_arrest', 'voice_silent', 'voice_weapon', 'voice_disperse',
];

// radio lines by situation (all recorded English police / dispatch traffic)
const ACK = [ 'radio_correct', 'radio_clear', 'radio_onmyway', 'radio_maam' ];
const CHAT = [ 'chat_1', 'chat_2', 'chat_3', 'chat_4', 'chat_5', 'chat_6', 'chat_7', 'chat_8', 'chat_9', 'chat_10' ];

const pick = ( a ) => a[ Math.floor( Math.random() * a.length ) ];
const clamp = ( v, a, b ) => Math.max( a, Math.min( b, v ) );

export class Sound {

	declare game: any;
	declare ready: boolean;
	declare muted: boolean;
	declare radioQ: any[];
	declare radioBusyUntil: number;
	declare last: any;
	declare loops: Map<any, any>;
	declare amb: any;
	declare tension: number;
	declare nextChat: number;
	declare nextSiren: number;
	declare starting: boolean;
	declare buffers: any;
	declare master: Tone.Volume;
	declare reverb: Tone.Reverb;
	declare sfx: Tone.Volume;
	declare ambBus: Tone.Volume;
	declare radioBus: Tone.Volume;
	declare squelchSynth: Tone.NoiseSynth;
	declare windGain: any;
	declare droneGain: any;
	declare droneFilter: Tone.Filter;
	declare dissGain: any;
	declare beds: Record<string, any>;
	declare boom: Tone.MembraneSynth;
	declare pad: Tone.PolySynth<Tone.Synth<Tone.SynthOptions>>;
	declare hitPan: Tone.Panner;
	declare knock: Tone.MembraneSynth;
	declare clang: Tone.MetalSynth;
	declare copsDown: any;
	declare prevC: any;

	constructor( game ) {

		this.game = game;
		this.ready = false;
		this.muted = false;
		try { this.muted = localStorage.getItem( 'lu-mute' ) === '1'; } catch { /* no storage: sound stays on */ }
		this.radioQ = [];
		this.radioBusyUntil = 0;
		this.last = {}; // throttles: key → Tone time
		this.loops = new Map<any, any>(); // owner → positional loop handle (cars, water jets, fires)
		this.amb = { calm: 0, roar: 0, fight: 0, pan: 0 };
		this.tension = 0;
		this.nextChat = 20;
		this.nextSiren = 30;

		const unlock = () => { this.start(); window.removeEventListener( 'pointerdown', unlock, true ); window.removeEventListener( 'keydown', unlock, true ); };
		window.addEventListener( 'pointerdown', unlock, true );
		window.addEventListener( 'keydown', unlock, true );

	}

	get on() { return this.ready && Tone.getContext().state === 'running'; }

	async start() {

		if ( this.starting ) return;
		this.starting = true;
		await Tone.start();
		this.buffers = await new Promise( ( ok ) => {

			const b = new Tone.ToneAudioBuffers( { urls: Object.fromEntries( FILES.map( ( f ) => [ f, f + '.mp3' ] ) ), baseUrl: './sfx/', onload: () => ok( b ) } );

		} );
		this.build();
		this.ready = true;

	}

	// ---------------------------------------------------------------- graph
	build() {

		this.master = new Tone.Volume( this.muted ? - Infinity : 0 ).chain( new Tone.Limiter( - 1 ), Tone.getDestination() );
		this.reverb = new Tone.Reverb( { decay: 2.6, preDelay: 0.02, wet: 1 } ).connect( this.master );
		this.sfx = new Tone.Volume( - 2 ).connect( this.master );
		this.ambBus = new Tone.Volume( - 6 ).connect( this.master );
		// handheld radio: narrow band, a little grit
		this.radioBus = new Tone.Volume( - 5 ).chain( new Tone.Filter( 380, 'highpass' ), new Tone.Filter( 3400, 'lowpass' ), new Tone.Distortion( 0.12 ), this.master );
		this.squelchSynth = new Tone.NoiseSynth( { noise: { type: 'white' }, envelope: { attack: 0.002, decay: 0.09, sustain: 0 }, volume: - 20 } )
			.chain( new Tone.Filter( 2200, 'bandpass', - 12 ), this.radioBus );

		// city rumble: brown noise, low-passed, breathing slowly like distant traffic
		const rumble = new Tone.Gain( 0.05 ).connect( this.ambBus );
		new Tone.Noise( 'brown' ).chain( new Tone.Filter( 150, 'lowpass' ), rumble ).start();
		new Tone.LFO( 0.03, 0.03, 0.08 ).connect( rumble.gain ).start();

		// wind: pink noise through a slowly sweeping band-pass; stronger with World.wind
		this.windGain = new Tone.Gain( 0.012 ).connect( this.ambBus );
		new Tone.Noise( 'pink' ).chain( new Tone.AutoFilter( { frequency: 0.06, baseFrequency: 260, octaves: 2.6, filter: { type: 'bandpass', Q: 1.4 } as Tone.FilterOptions } ).start(), this.windGain ).start();

		// tension drone: detuned saws on A1 / E2, filtered dark; opens and rises with escalation and anger.
		// A dissonant B♭ joins when it gets bad.
		this.droneGain = new Tone.Gain( 0 ).connect( this.ambBus );
		this.droneGain.connect( this.reverb );
		this.droneFilter = new Tone.Filter( { frequency: 180, type: 'lowpass', Q: 3 } ).connect( this.droneGain );
		for ( const [ f, v ] of [ [ 55, 0.5 ], [ 82.4, 0.32 ] ] ) {

			const g = new Tone.Gain( v ).connect( this.droneFilter );
			new Tone.FatOscillator( f, 'sawtooth', 22 ).set( { count: 3 } ).connect( g ).start();

		}

		this.dissGain = new Tone.Gain( 0 ).connect( this.droneFilter );
		new Tone.FatOscillator( 116.5, 'sawtooth', 35 ).set( { count: 2 } ).chain( new Tone.Tremolo( 0.4, 0.6 ).start(), this.dissGain ).start();
		new Tone.LFO( 0.045, 120, 260 ).connect( this.droneFilter.frequency ).start();

		// crowd beds (recorded), levels and pan follow the crowd on screen
		const bed = ( name, offset = 0 ) => {

			const g = new Tone.Gain( 0 );
			const p = new Tone.Panner( 0 ).connect( this.ambBus );
			g.connect( p );
			const pl = new Tone.Player( this.buffers.get( name ) ).connect( g );
			pl.loop = true;
			pl.start( Tone.now(), offset * pl.buffer.duration );
			return { g, p };

		};
		this.beds = { calm: bed( 'crowd_calm', Math.random() ), roar: bed( 'crowd_roar', Math.random() ), drums: bed( 'drums', Math.random() ), riot: bed( 'riot', Math.random() ) };

		// accents: a low hit for each escalation step, pads for the result
		this.boom = new Tone.MembraneSynth( { pitchDecay: 0.08, octaves: 5, envelope: { attack: 0.002, decay: 1.6, sustain: 0 }, volume: - 6 } ).connect( this.sfx );
		this.boom.connect( this.reverb );
		this.pad = new Tone.PolySynth( Tone.Synth, { oscillator: { type: 'fatsine', count: 3, spread: 18 }, envelope: { attack: 1.2, decay: 0.5, sustain: 0.6, release: 3 }, volume: - 16 } ).connect( this.reverb );
		// stones on shields and cobbles
		this.hitPan = new Tone.Panner( 0 ).connect( this.sfx );
		this.knock = new Tone.MembraneSynth( { pitchDecay: 0.01, octaves: 2, envelope: { attack: 0.001, decay: 0.12, sustain: 0 }, volume: - 14 } ).connect( this.hitPan );
		this.clang = new Tone.MetalSynth( { envelope: { attack: 0.001, decay: 0.18, release: 0.05 }, harmonicity: 3.1, resonance: 2400, volume: - 30 } ).connect( this.hitPan );

	}

	// ---------------------------------------------------------------- placement
	// pan from the screen position, level and brightness from the distance to the view centre and the zoom
	place( x, y ) {

		const c = this.game.controls, half = c.mpp * window.innerWidth / 2;
		const d = Math.hypot( x - c.center.x, y - c.center.y ) / half;
		const zoom = clamp( 0.45 / c.mpp, 0.35, 1 );
		return { pan: clamp( ( x - c.center.x ) / half, - 1, 1 ) * 0.8, gain: zoom * clamp( 1.15 - 0.45 * d, 0.06, 1 ), cut: clamp( 16000 - d * 4500, 1200, 16000 ), wet: clamp( 0.12 + d * 0.15, 0.12, 0.5 ) };

	}

	// one-shot of a recorded clip. at: [x, y] on the map, or null for non-positional
	play( name, at = null, { vol = 0, rate = 1, delay = 0, dur, offset = 0, bus, fade = 0 }: { vol?: number, rate?: number, delay?: number, dur?: number, offset?: number, bus?: Tone.InputNode, fade?: number } = {} ) {

		if ( ! this.on ) return null;
		const buf = this.buffers.get( name );
		if ( ! buf ) return null;
		const P = at ? this.place( at[ 0 ], at[ 1 ] ) : { pan: 0, gain: 1, cut: 16000, wet: 0.1 };
		const pl = new Tone.Player( buf );
		pl.playbackRate = rate;
		pl.fadeOut = fade;
		const f = new Tone.Filter( P.cut, 'lowpass' ), g = new Tone.Gain( P.gain * Tone.dbToGain( vol ) ), p = new Tone.Panner( P.pan );
		pl.chain( f, g, p, bus ?? this.sfx );
		const send = new Tone.Gain( P.wet ).connect( this.reverb );
		p.connect( send );
		pl.onstop = () => setTimeout( () => [ pl, f, g, p, send ].forEach( ( n ) => n.dispose() ), 200 );
		pl.start( Tone.now() + delay, offset, dur );
		return pl;

	}

	// a looping clip that follows something on the map (car, water jet, fire); call move() each frame
	loop( owner, name, at, { vol = 0, offset = 0 } = {} ) {

		if ( ! this.on || this.loops.has( owner ) ) return;
		const pl = new Tone.Player( this.buffers.get( name ) );
		pl.loop = true;
		pl.fadeIn = 0.6;
		pl.fadeOut = 1.2;
		const f = new Tone.Filter( 16000, 'lowpass' ), g = new Tone.Gain( 0 ), p = new Tone.Panner( 0 );
		pl.chain( f, g, p, this.sfx );
		pl.start( Tone.now(), offset * pl.buffer.duration );
		const h = { pl, f, g, p, vol: Tone.dbToGain( vol ), extra: [] };
		this.loops.set( owner, h );
		this.move( owner, at );
		return h;

	}

	move( owner, at ) {

		const h = this.loops.get( owner );
		if ( ! h ) return;
		const P = this.place( at[ 0 ], at[ 1 ] );
		h.g.gain.rampTo( P.gain * h.vol, 0.15 );
		h.p.pan.rampTo( P.pan, 0.15 );
		h.f.frequency.rampTo( P.cut, 0.15 );

	}

	unloop( owner ) {

		const h = this.loops.get( owner );
		if ( ! h ) return;
		this.loops.delete( owner );
		h.pl.stop( Tone.now() + 0.05 );
		for ( const n of h.extra ) n.stop?.( Tone.now() + 1.2 );
		setTimeout( () => [ h.pl, h.f, h.g, h.p, ...h.extra ].forEach( ( n ) => n.dispose() ), 2000 );

	}

	// procedural noise layer added to a loop: water spray (hissy) or fire (crackling)
	noiseLayer( h, kind ) {

		const n = new Tone.Noise( kind === 'spray' ? 'white' : 'pink' );
		const flt = kind === 'spray' ? new Tone.AutoFilter( { frequency: 0.7, baseFrequency: 1400, octaves: 2, filter: { type: 'bandpass', Q: 0.8 } as Tone.FilterOptions } ).start()
			: new Tone.AutoFilter( { frequency: 9, depth: 1, baseFrequency: 500, octaves: 3, type: 'square', filter: { type: 'bandpass', Q: 2 } as Tone.FilterOptions } ).start();
		const g = new Tone.Gain( kind === 'spray' ? 0.5 : 0.35 );
		n.chain( flt, g, h.f );
		n.start();
		h.extra.push( n, flt, g );

	}

	throttle( key, seconds ) {

		const now = Tone.now();
		if ( now - ( this.last[ key ] ?? - 1e9 ) < seconds ) return false;
		this.last[ key ] = now;
		return true;

	}

	// ---------------------------------------------------------------- radio
	// prio 0 ambient traffic (dropped if busy), 1 acknowledgements, 2 urgent (jumps the queue)
	radio( name, prio = 1 ) {

		if ( ! this.on || this.game.mission?.side !== 'police' ) return;
		const busy = Tone.now() < this.radioBusyUntil || this.radioQ.length;
		if ( busy && prio === 0 ) return;
		if ( prio >= 2 ) this.radioQ.unshift( name );
		else if ( this.radioQ.length < 2 ) this.radioQ.push( name );
		this.pumpRadio();

	}

	pumpRadio() {

		const now = Tone.now();
		if ( now < this.radioBusyUntil || ! this.radioQ.length ) return;
		const name = this.radioQ.shift(), buf = this.buffers.get( name );
		this.squelchSynth.triggerAttackRelease( 0.06, now );
		this.play( name, null, { bus: this.radioBus, delay: 0.12 } );
		const end = now + 0.12 + buf.duration;
		this.squelchSynth.triggerAttackRelease( 0.12, end + 0.02 );
		this.radioBusyUntil = end + 0.45;
		setTimeout( () => this.pumpRadio(), ( this.radioBusyUntil - now ) * 1000 + 20 );

	}

	// ---------------------------------------------------------------- game events
	// player orders to police squads: whistles for the forceful ones, an acknowledgement on the radio
	order( kind, at ) {

		if ( ! this.on ) return;
		if ( kind === 'line' ) this.play( 'whistle_2', at, { vol: - 8 } );
		if ( this.throttle( 'ack', 5 ) && Math.random() < 0.8 ) this.radio( pick( ACK ), 1 );

	}

	refuse() { if ( this.throttle( 'neg', 4 ) ) this.radio( 'radio_negative', 2 ); }

	// something went badly wrong (a 'bad' event in the feed): urgent traffic
	alarm() { if ( this.throttle( 'alarm', 15 ) ) this.radio( pick( CHAT ), 2 ); }

	// World.onFx: physical actions by anyone (player or AI police)
	fx( kind, x, y, from ) {

		if ( ! this.on ) return;
		const at = [ x, y ];
		if ( kind === 'charge' ) { this.play( 'whistle_3', at, { vol: - 2 } ); this.swell( at, 0.8 ); }
		if ( kind === 'kettle' ) { this.play( 'whistle_1', at, { vol: - 3 } ); this.play( 'whistle_2', at, { vol: - 4, delay: 0.5 } ); }
		if ( kind === 'shield' ) { this.play( 'whistle_long', at, { vol: - 4 } ); this.swell( at, 0.5 ); } // a cordon advancing shields up
		if ( kind === 'gas' ) {

			// launcher pop, the canister lands, a hiss spreads
			this.play( 'gas_launch', from ?? at, { vol: - 2, rate: 0.9 + Math.random() * 0.2 } );
			this.play( 'gas_launch', at, { vol: - 14, rate: 0.6, delay: 0.9 } );
			if ( Tone.now() > ( this.last.gasHiss ?? 0 ) ) {

				this.last.gasHiss = Tone.now() + 2;
				const P = this.place( x, y );
				const hiss = new Tone.NoiseSynth( { noise: { type: 'white' }, envelope: { attack: 0.4, decay: 5, sustain: 0 }, volume: - 22 } );
				const f = new Tone.Filter( 3500, 'highpass' ), p = new Tone.Panner( P.pan ), g = new Tone.Gain( P.gain );
				hiss.chain( f, g, p, this.sfx );
				hiss.triggerAttackRelease( 5, Tone.now() + 1 );
				setTimeout( () => [ hiss, f, p, g ].forEach( ( n ) => n.dispose() ), 8000 );

			}

			this.later( 6, () => this.swell( at, 0.5 ) );
			this.radio( pick( [ 'chat_7', 'chat_10' ] ), 0 );

		}

		if ( kind === 'water' ) {

			const h = this.loop( from, 'truck', from, { vol: - 4, offset: Math.random() } );
			if ( h ) this.noiseLayer( h, 'spray' );
			this.radio( 'radio_onmyway', 1 );

		}

	}

	later( s, fn ) { setTimeout( fn, s * 1000 ); }

	// an angry crowd surge: a burst of the roar bed at a place
	swell( at, vol = 1 ) {

		if ( this.throttle( 'swell', 4 ) ) this.play( 'crowd_roar', at, { vol: - 6 + 6 * vol, offset: Math.random() * 12, dur: 5, fade: 1.5 } );

	}

	dispersal( at ) {

		if ( ! this.on ) return;
		// loudspeaker: narrow, overdriven, echoing off the façades
		const chain = new Tone.Volume( 2 ).chain( new Tone.Filter( 600, 'highpass' ), new Tone.Filter( 3600, 'lowpass' ), new Tone.Distortion( 0.35 ), this.sfx );
		const send = new Tone.Gain( 0.45 ).connect( this.reverb );
		chain.connect( send );
		this.play( 'voice_disperse', at, { bus: chain } );
		setTimeout( () => { chain.dispose(); send.dispose(); }, 13000 );

	}

	reinforce( from ) {

		this.play( 'siren_arrive', from, { vol: - 2, dur: 6, fade: 2 } );
		this.radio( pick( CHAT ), 1 );
		this.later( 4, () => this.radio( 'radio_onmyway', 1 ) );

	}

	firearms( at ) {

		if ( ! this.on ) return;
		this.play( 'voice_weapon', at, { vol: 2 } );
		let t = 3.4;
		for ( let k = 0; k < 9; k ++ ) { t += 0.08 + Math.random() * 0.35; this.play( pick( [ 'shot_1', 'shot_2', 'shot_3' ] ), at, { delay: t, vol: - 1 - Math.random() * 4, rate: 0.92 + Math.random() * 0.16 } ); }
		this.play( 'panic', at, { delay: 3.9, vol: 0, fade: 4 } );
		this.play( 'bang', at, { delay: t + 0.4, vol: - 8 } );
		this.later( 6, () => this.radio( pick( CHAT ), 2 ) );

	}

	// an embassy alarm: a two-tone klaxon (synthesised) wailing over the area for `seconds`
	klaxon( at, seconds ) {

		if ( ! this.on ) return;
		const P = this.place( at[ 0 ], at[ 1 ] );
		const osc = new Tone.Oscillator( 620, 'square' );
		const lfo = new Tone.LFO( { frequency: 1.1, type: 'square', min: 620, max: 860 } ).connect( osc.frequency );
		const f = new Tone.Filter( 1800, 'lowpass' ), g = new Tone.Gain( 0 ), p = new Tone.Panner( P.pan );
		osc.chain( f, g, p, this.sfx );
		const send = new Tone.Gain( 0.4 ).connect( this.reverb );
		p.connect( send );
		const now = Tone.now(), v = 0.09 * Math.max( 0.4, P.gain );
		g.gain.setValueAtTime( 0, now );
		g.gain.linearRampToValueAtTime( v, now + 0.3 );
		g.gain.setValueAtTime( v, now + seconds - 1.5 );
		g.gain.linearRampToValueAtTime( 0, now + seconds );
		osc.start( now ).stop( now + seconds + 0.1 );
		lfo.start( now ).stop( now + seconds + 0.1 );
		this.later( seconds + 1, () => [ osc, lfo, f, g, p, send ].forEach( ( n ) => n.dispose() ) );
		this.radio( pick( CHAT ), 2 );

	}

	// one machine-gun round from a turret: a short, pitched-up shot (called at the rate of fire)
	round( at ) {

		if ( ! this.on ) return;
		this.play( pick( [ 'shot_1', 'shot_2', 'shot_3' ] ), at, { vol: - 5 - Math.random() * 3, rate: 1.15 + Math.random() * 0.25, dur: 0.35, fade: 0.08 } );

	}

	// a stone or a flare thrown from `from` to `to`
	projectile( from, to, flare = false ) {

		if ( ! this.on || ! this.throttle( 'throw', 0.12 ) ) return;
		if ( flare ) { this.play( 'gas_launch', from, { vol: - 10, rate: 1.4 } ); return; }
		// the stone lands half a second later: on a shield (clang) or the cobbles (knock)
		const P = this.place( ...( to as [ number, number ] ) ), when = Tone.now() + 0.5 + Math.random() * 0.2;
		this.hitPan.pan.setValueAtTime( P.pan, when );
		if ( Math.random() < 0.5 ) this.clang.triggerAttackRelease( 'C4', 0.1, when, P.gain );
		else this.knock.triggerAttackRelease( 'G2', 0.1, when, P.gain );

	}

	// the crowd breaks: screams and a roar where the shooting starts
	stampede( at ) {

		if ( ! this.on ) return;
		this.play( 'panic', at, { vol: 3, fade: 4 } );
		this.play( 'panic', at, { vol: - 2, delay: 2.5, rate: 0.92, fade: 4 } );
		this.play( 'crowd_roar', at, { vol: 2, offset: Math.random() * 12, dur: 14, fade: 4 } );
		this.later( 1.5, () => this.radio( pick( CHAT ), 2 ) );

	}

	escalate( level ) {

		if ( ! this.on ) return;
		this.boom.triggerAttackRelease( level >= 4 ? 'A0' : 'D1', 1.5 );

	}

	smash( at ) { this.play( 'smash', at, { vol: - 1 } ); this.play( 'smash', at, { vol: - 6, delay: 0.35, rate: 0.85 } ); this.swell( at, 0.6 ); }

	fire( owner, at, seconds = 45 ) {

		if ( ! this.on ) return;
		this.play( 'bang', at, { vol: - 2 } );
		this.smash( at );
		const h = this.loop( owner, 'riot', at, { vol: - 12, offset: Math.random() } );
		if ( h ) { this.noiseLayer( h, 'fire' ); this.later( seconds, () => this.unloop( owner ) ); }
		this.radio( pick( CHAT ), 2 );

	}

	end( win ) {

		if ( ! this.on ) return;
		this.pad.triggerAttackRelease( win ? [ 'C3', 'G3', 'E4' ] : [ 'A2', 'E3', 'C4', 'Bb3' ], 4 );

	}

	setMuted( m ) {

		this.muted = m;
		try { localStorage.setItem( 'lu-mute', m ? '1' : '0' ); } catch { /* not remembered */ }
		if ( this.master ) this.master.volume.rampTo( m ? - Infinity : 0, 0.2 );

	}

	// ---------------------------------------------------------------- per frame / per readback
	update( dt ) {

		if ( ! this.on ) return;
		const g = this.game, m = g.mission, W = g.world;
		if ( ! m || ! W ) return;

		// patrol cars: a siren follows each car while it drives
		for ( const c of W.patrols?.cars ?? [] ) {

			if ( c.civil ) continue;
			if ( c.path && ! this.loops.has( c ) ) this.loop( c, 'siren_loop', [ c.x, c.y ], { vol: - 9, offset: Math.random() } );
			else if ( ! c.path && this.loops.has( c ) ) this.unloop( c );
			if ( c.path ) this.move( c, [ c.x, c.y ] );

		}

		// water jets: the truck and spray last as long as the jet
		for ( const [ owner, h ] of this.loops ) {

			if ( ! Array.isArray( owner ) ) continue;
			const j = W.jets.find( ( q ) => q.from === owner || ( Math.abs( q.x - owner[ 0 ] ) < 0.5 && Math.abs( q.y - owner[ 1 ] ) < 0.5 ) );
			if ( ! j ) this.unloop( owner );
			else this.move( owner, j.truck ? [ j.x, j.y ] : owner );

		}

		for ( const [ owner ] of this.loops ) if ( owner.pos ) this.move( owner, owner.pos );

		// police radio traffic in the background, busier as things escalate
		this.nextChat -= dt;
		if ( this.nextChat <= 0 && ! g.paused ) {

			this.nextChat = 18 + Math.random() * 40 * ( 1 - this.tension * 0.6 );
			this.radio( pick( CHAT ), 0 );

		}

		// distant sirens somewhere in the city once things are tense
		this.nextSiren -= dt;
		if ( this.nextSiren <= 0 && ! g.paused ) {

			this.nextSiren = 45 + Math.random() * 80;
			if ( this.tension > 0.15 ) {

				const p = new Tone.Panner( Math.random() * 1.6 - 0.8 ).connect( this.ambBus );
				const f = new Tone.Filter( 1800, 'lowpass' ).connect( p );
				const pl = new Tone.Player( this.buffers.get( 'siren_far' ) ).connect( f );
				pl.volume.value = - 10;
				pl.fadeIn = 3;
				pl.fadeOut = 4;
				pl.onstop = () => setTimeout( () => [ pl, f, p ].forEach( ( n ) => n.dispose() ), 200 );
				pl.start( Tone.now(), Math.random() * 30, 12 + Math.random() * 8 );

			}

		}

		// ambience levels follow the crowd measured at the last readback; paused = the world goes quieter
		const A = this.amb, k = g.paused ? 0.35 : 1, protest = m.side === 'protest';
		this.beds.calm.g.gain.rampTo( k * A.calm * 0.55, 0.8 );
		this.beds.roar.g.gain.rampTo( k * A.roar * 0.7, 0.8 );
		this.beds.riot.g.gain.rampTo( k * A.fight * 0.55, 0.8 );
		this.beds.drums.g.gain.rampTo( k * ( protest ? Math.min( 0.35, A.calm * 0.6 ) : A.calm * 0.12 ), 0.8 );
		for ( const b of Object.values( this.beds ) ) b.p.pan.rampTo( A.pan, 0.8 );
		const T = this.tension;
		this.droneGain.gain.rampTo( k * ( 0.012 + T * 0.05 ), 2 );
		this.dissGain.gain.rampTo( T > 0.55 ? ( T - 0.55 ) * 0.8 : 0, 3 );
		const w = Math.hypot( ...( W.wind ?? [ 0, 0 ] ) );
		this.windGain.gain.rampTo( 0.012 + Math.min( 0.03, w * 0.008 ), 2 );

	}

	// every intel readback (2 Hz): crowd on screen, anger, fighting, arrests, officers going down
	intel() {

		if ( ! this.on ) return;
		const g = this.game, W = g.world, I = W.intel, m = g.mission;
		if ( ! I || ! m ) return;
		const c = g.controls, half = c.mpp * window.innerWidth / 2, zoom = clamp( 0.45 / c.mpp, 0.35, 1 );
		let calm = 0, angry = 0, sx = 0, sw = 0;
		for ( let i = 0; i < g.crowd.count; i ++ ) {

			const f = I.st[ i * 4 ];
			if ( f !== FACTION.PROTESTER && f !== FACTION.COUNTER && f !== FACTION.BYSTANDER ) continue;
			const dx = I.pos[ i * 2 ] - c.center.x, dy = I.pos[ i * 2 + 1 ] - c.center.y;
			const d = Math.hypot( dx, dy ) / half;
			if ( d > 2.2 ) continue;
			const w = 1 / ( 1 + d * d * 1.5 );
			if ( I.st[ i * 4 + 2 ] > 0.6 && f !== FACTION.BYSTANDER ) angry += w; else calm += w;
			sx += dx / half * w;
			sw += w;

		}

		const A = this.amb;
		A.calm = zoom * Math.min( 1, Math.sqrt( calm / 900 ) );
		A.roar = zoom * Math.min( 1, Math.sqrt( angry / 500 ) );
		A.pan = sw ? clamp( sx / sw, - 0.7, 0.7 ) : 0;

		// injuries since the last readback → fighting
		const C = m.counters, prev = this.prevC ?? { ...C };
		const hurt = ( C.injByPolice - prev.injByPolice ) + ( C.injOther - prev.injOther ) + ( C.injPolice - prev.injPolice );
		A.fight = clamp( A.fight * 0.85 + hurt * 0.08, 0, 1 ) * ( angry > 20 || hurt ? 1 : 0.7 );
		this.tension = clamp( Math.max( m.escalation / 4, A.roar * 0.8, A.fight ), 0, 1 );

		// officers going down: urgent traffic
		this.copsDown = ( this.copsDown ?? 0 ) * 0.8 + ( C.injPolice - prev.injPolice );
		if ( this.copsDown >= 3 && this.throttle( 'down', 25 ) ) { this.radio( pick( CHAT ), 2 ); this.play( 'whistle_3', null, { vol: - 14 } ); }

		// arrests: cuffs, and now and then the words
		const arrested = C.arrested - prev.arrested;
		if ( arrested > 0 && m.side === 'police' ) {

			const sq = W.groupsOf( FACTION.POLICE ).filter( ( q ) => q.center && ( q.mode === MODE.ARREST || q.mode === MODE.SNATCH ) );
			const at = ( sq.length ? pick( sq ) : null )?.center ?? null;
			for ( let k = 0; k < Math.min( 3, arrested ); k ++ ) this.play( 'handcuffs', at, { delay: k * 0.4 + Math.random() * 0.2, vol: - 2 } );
			if ( this.throttle( 'arrestVoice', 22 ) ) this.play( Math.random() < 0.6 ? 'voice_arrest' : 'voice_silent', at, { delay: 0.6, vol: - 2 } );

		}

		this.prevC = { ...C };

	}

}
