import * as THREE from 'three';

/**
 * Fully synthesised audio. No sample assets ship with this project.
 *
 * Every sound is generated with Web Audio primitives (noise buffers,
 * oscillators, filters) plus one procedurally-built convolution reverb that
 * models a large wet industrial space. That keeps the repo licence-clean and
 * lets the mix be tuned numerically, at the cost of not sounding like a
 * recorded firearm - which is the honest trade-off at this scope.
 *
 * A weapon report here is layered the way a real one is mixed:
 *   1. CRACK  - a very short, bright, filtered noise transient (the supersonic
 *               shock). This is what makes a shot feel sharp.
 *   2. BODY   - a pitched-down noise burst through a bandpass sweep (the
 *               muzzle blast). This is what makes it feel loud.
 *   3. THUMP  - a sine dropping from ~90Hz to ~40Hz (the low end you feel).
 *   4. MECH   - a tiny click transient (the action cycling).
 *   5. TAIL   - the whole thing fed to the reverb send, which is what places
 *               the shot in the harbour instead of in a vacuum.
 *
 * Spatialisation is manual (distance gain + stereo pan from the listener
 * basis) rather than PannerNode: it is cheaper, fully deterministic, and at
 * this scale indistinguishable.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private impulse: AudioBuffer | null = null;

  private ambienceGain: GainNode | null = null;
  private ambienceSources: AudioBufferSourceNode[] = [];

  private listenerPosition = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);

  /** Master volume 0..1. */
  volume = 0.75;
  private started = false;
  private muted = false;

  /** Timers used to de-duplicate events that can fire twice in one frame. */
  private lastEventTime = new Map<string, number>();

  /**
   * Web Audio requires a user gesture. The game calls this from the first
   * click; until then every play() call is a silent no-op rather than an error.
   */
  async start(): Promise<void> {
    if (this.started) return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;

      // A gentle limiter keeps a chain of explosions from clipping.
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 22;
      this.compressor.ratio.value = 6;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.22;

      this.master.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      this.noiseBuffer = this.createNoiseBuffer(2.0);
      this.impulse = this.createImpulseResponse(2.4, 2.6);

      const convolver = this.ctx.createConvolver();
      convolver.buffer = this.impulse;
      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 0.42;
      this.reverbSend.connect(convolver);
      const reverbReturn = this.ctx.createGain();
      reverbReturn.gain.value = 0.85;
      convolver.connect(reverbReturn);
      reverbReturn.connect(this.master);

      this.started = true;
      this.startAmbience();
    } catch (err) {
      // Audio must never break the game. Log once and continue silently.
      console.warn('[AudioEngine] failed to initialise; running muted', err);
      this.ctx = null;
      this.started = false;
    }
  }

  get isRunning(): boolean {
    return this.started && this.ctx !== null && !this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setVolume(value: number): void {
    this.volume = value;
    if (this.master && this.ctx && !this.muted) {
      this.master.gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
    }
  }

  /** Updates the virtual listener. Called once per frame from the game loop. */
  setListener(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.listenerPosition.copy(position);
    this.listenerRight.set(1, 0, 0).applyQuaternion(quaternion);
  }

  // ------------------------------------------------------------------
  // Buffers
  // ------------------------------------------------------------------

  private createNoiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * Procedural impulse response for a large, hard-surfaced wet space.
   * Exponentially decaying noise with a few discrete early reflections and a
   * low-pass slope baked in by shaping the noise amplitude over time.
   */
  private createImpulseResponse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, length, rate);
    // Early reflections off containers and the warehouse wall.
    const earlyTimes = [0.011, 0.019, 0.031, 0.047, 0.068, 0.091, 0.127];
    const earlyGains = [0.62, 0.48, 0.4, 0.32, 0.26, 0.19, 0.14];

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let lowpassState = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const envelope = Math.pow(1 - t, decay);
        const white = Math.random() * 2 - 1;
        // One-pole low-pass that closes as the tail decays: high frequencies
        // die first in a real room.
        const cutoff = 0.42 * (1 - t * 0.75);
        lowpassState += cutoff * (white - lowpassState);
        data[i] = lowpassState * envelope * 0.55;
      }
      for (let e = 0; e < earlyTimes.length; e++) {
        // Slight per-channel offset gives the reflections stereo width.
        const index = Math.floor((earlyTimes[e] + channel * 0.0023) * rate);
        if (index < length) data[index] += earlyGains[e] * (channel === 0 ? 1 : -0.92);
      }
    }
    return buffer;
  }

  // ------------------------------------------------------------------
  // Spatial helper
  // ------------------------------------------------------------------

  /**
   * Builds the per-sound output chain: gain (distance) -> pan (direction) ->
   * master, with a parallel send to the reverb. Returns the input node.
   */
  private spatialChain(
    position: THREE.Vector3 | null,
    baseGain: number,
    reverbAmount: number,
    rolloff = 14,
  ): { input: GainNode; delaySec: number } {
    const ctx = this.ctx as AudioContext;
    const input = ctx.createGain();

    let gain = baseGain;
    let pan = 0;
    let delaySec = 0;
    if (position) {
      const distance = position.distanceTo(this.listenerPosition);
      // Inverse-distance with a soft near-field floor.
      gain = baseGain / (1 + Math.pow(distance / rolloff, 1.65));
      tmpVec.subVectors(position, this.listenerPosition).normalize();
      pan = THREE.MathUtils.clamp(tmpVec.dot(this.listenerRight), -1, 1) * 0.85;
      // Speed of sound: a hit 60m away arrives ~0.18s late. This is the single
      // biggest cue that a scene has real scale.
      delaySec = Math.min(0.6, distance / 343);
      // Distant sounds lose their top end, handled by the caller's filter.
    }

    input.gain.value = gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    input.connect(panner);
    panner.connect(this.master as GainNode);

    if (reverbAmount > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = gain * reverbAmount;
      input.connect(send);
      send.connect(this.reverbSend);
    }
    return { input, delaySec };
  }

  private noiseSource(duration: number, playbackRate = 1): AudioBufferSourceNode {
    const ctx = this.ctx as AudioContext;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.playbackRate.value = playbackRate;
    // Random start offset so repeated shots never phase-align.
    const offset = Math.random() * 1.5;
    source.start(ctx.currentTime, offset, duration + 0.05);
    return source;
  }

  private throttle(key: string, minInterval: number): boolean {
    const now = this.ctx?.currentTime ?? 0;
    const last = this.lastEventTime.get(key) ?? -999;
    if (now - last < minInterval) return false;
    this.lastEventTime.set(key, now);
    return true;
  }

  // ------------------------------------------------------------------
  // Sounds
  // ------------------------------------------------------------------

  /** The player's own weapon: close, dry-ish, with a heavy low end. */
  playWeaponFire(): void {
    if (!this.isRunning) return;
    const ctx = this.ctx as AudioContext;
    const now = ctx.currentTime;
    const { input } = this.spatialChain(null, 0.5, 0.55);

    // 1. CRACK - 12ms of bright noise through a high shelf.
    const crack = this.noiseSource(0.06, 1.6);
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'highpass';
    crackFilter.frequency.value = 2200;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.85, now);
    crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    crack.connect(crackFilter).connect(crackGain).connect(input);
    crack.stop(now + 0.07);

    // 2. BODY - bandpass sweeping down; the muzzle blast.
    const body = this.noiseSource(0.22, 1);
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'bandpass';
    bodyFilter.Q.value = 0.9;
    bodyFilter.frequency.setValueAtTime(1500, now);
    bodyFilter.frequency.exponentialRampToValueAtTime(240, now + 0.16);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.9, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    body.connect(bodyFilter).connect(bodyGain).connect(input);
    body.stop(now + 0.24);

    // 3. THUMP - the sub you feel rather than hear.
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(96, now);
    thump.frequency.exponentialRampToValueAtTime(38, now + 0.13);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.85, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
    thump.connect(thumpGain).connect(input);
    thump.start(now);
    thump.stop(now + 0.2);

    // There was a fourth layer here: a 3.4kHz bandpassed noise burst 12ms
    // behind the shot, meant to read as the action cycling. It arrived just
    // late enough to be heard as a separate metallic tick after every round,
    // which at 720rpm is a continuous rattle rather than a mechanism.
  }

  /** Enemy weapon: same structure, thinner, distance-filtered and delayed. */
  playEnemyFire(position: THREE.Vector3): void {
    if (!this.isRunning) return;
    if (!this.throttle('enemyFire', 0.03)) return;
    const ctx = this.ctx as AudioContext;
    const { input, delaySec } = this.spatialChain(position, 0.65, 0.85, 22);
    const now = ctx.currentTime + delaySec;

    const body = this.noiseSource(0.26, 1);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.1;
    filter.frequency.setValueAtTime(1100, now);
    filter.frequency.exponentialRampToValueAtTime(210, now + 0.14);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.9, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    body.connect(filter).connect(gain).connect(input);
    body.stop(now + 0.3);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(72, now);
    thump.frequency.exponentialRampToValueAtTime(34, now + 0.11);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.linearRampToValueAtTime(0.5, now + 0.004);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    thump.connect(thumpGain).connect(input);
    thump.start(now);
    thump.stop(now + 0.17);
  }

  /**
   * Impact. The filter profile IS the material: concrete is a dull thud,
   * metal rings, thin metal rings longer and higher, water is a soft slap.
   */
  playImpact(position: THREE.Vector3, surface: string): void {
    if (!this.isRunning) return;
    if (!this.throttle(`impact_${surface}`, 0.018)) return;
    const ctx = this.ctx as AudioContext;
    const { input, delaySec } = this.spatialChain(position, 0.5, 0.5, 16);
    const now = ctx.currentTime + delaySec;

    let frequency = 900;
    let q = 1;
    let duration = 0.09;
    let level = 0.6;
    let ring = 0;
    /** Ring loudness relative to the impact. 0 disables the tail entirely. */
    let ringLevel = 0.32;

    switch (surface) {
      // The ring on the two metal cases used to run 2.2x the impact duration
      // at near-full level. Every container in the level is thinMetal, so in
      // practice almost every round the player fired left a 750ms tone hanging
      // behind it and consecutive shots stacked into a drone. Kept, because it
      // is how the player hears what they hit, but as a tick rather than a
      // bell - see `ringDecay` below.
      case 'metal':
        frequency = 2600; q = 3.2; duration = 0.14; ring = 1750; ringLevel = 0.1; break;
      case 'thinMetal':
        frequency = 1800; q = 5.5; duration = 0.34; level = 0.75; ring = 620; ringLevel = 0.12; break;
      case 'fence':
        frequency = 3200; q = 6; duration = 0.28; level = 0.45; ring = 980; break;
      case 'water':
        frequency = 620; q = 0.8; duration = 0.13; level = 0.5; break;
      case 'glass':
        frequency = 4200; q = 2.4; duration = 0.22; ring = 3100; break;
      case 'wood':
        frequency = 700; q = 1.6; duration = 0.1; break;
      case 'sand':
        frequency = 380; q = 0.7; duration = 0.08; level = 0.4; break;
      default:
        frequency = 850; q = 1.2; duration = 0.1; break;
    }

    const noise = this.noiseSource(duration + 0.05, 1);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    noise.connect(filter).connect(gain).connect(input);
    noise.stop(now + duration + 0.05);

    // A struck metal panel keeps ringing after the strike - the detail that
    // makes shooting a container obviously different from shooting concrete.
    if (ring > 0 && ringLevel > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(ring * (0.92 + Math.random() * 0.16), now);
      const ringGain = ctx.createGain();
      ringGain.gain.setValueAtTime(level * ringLevel, now);
      ringGain.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.7);
      osc.connect(ringGain).connect(input);
      osc.start(now);
      osc.stop(now + duration * 2.3);
    }
  }

  playExplosion(position: THREE.Vector3, power = 1): void {
    if (!this.isRunning) return;
    const ctx = this.ctx as AudioContext;
    const { input, delaySec } = this.spatialChain(position, 1.15 * power, 1.4, 34);
    const now = ctx.currentTime + delaySec;

    // Crack, body and a long low rumble.
    const blast = this.noiseSource(1.5, 0.7);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(4200, now);
    filter.frequency.exponentialRampToValueAtTime(180, now + 0.85);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.0, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);
    blast.connect(filter).connect(gain).connect(input);
    blast.stop(now + 1.6);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(64, now);
    sub.frequency.exponentialRampToValueAtTime(22, now + 0.7);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(1.1, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.95);
    sub.connect(subGain).connect(input);
    sub.start(now);
    sub.stop(now + 1.0);
  }

  /** Distant ordnance: no transient left, just a low rolling rumble. */
  playDistantBlast(delaySec: number, intensity: number): void {
    if (!this.isRunning) return;
    const ctx = this.ctx as AudioContext;
    const { input } = this.spatialChain(null, 0.22 * intensity, 1.6);
    const now = ctx.currentTime + delaySec;

    const rumble = this.noiseSource(2.6, 0.35);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 150;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    // A slow attack is what makes it sound far away rather than muffled.
    gain.gain.linearRampToValueAtTime(1, now + 0.22);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 2.2);
    rumble.connect(filter).connect(gain).connect(input);
    rumble.stop(now + 2.5);
  }

  playCasing(position: THREE.Vector3): void {
    if (!this.isRunning) return;
    if (!this.throttle('casing', 0.04)) return;
    const ctx = this.ctx as AudioContext;
    const { input } = this.spatialChain(position, 0.16, 0.4, 8);
    const now = ctx.currentTime;
    // Three inharmonic partials = a small metallic object, not a musical note.
    const base = 2300 + Math.random() * 1400;
    for (const [mult, level] of [[1, 0.5], [2.41, 0.28], [3.87, 0.15]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * mult;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(level, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16 / mult);
      osc.connect(gain).connect(input);
      osc.start(now);
      osc.stop(now + 0.2);
    }
  }

  playFootstep(sprinting: boolean): void {
    if (!this.isRunning) return;
    const ctx = this.ctx as AudioContext;
    const { input } = this.spatialChain(null, sprinting ? 0.2 : 0.13, 0.25);
    const now = ctx.currentTime;
    // Wet concrete: a broadband scuff with a short splash of high end.
    const noise = this.noiseSource(0.16, 1);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900 + Math.random() * 500, now);
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    noise.connect(filter).connect(gain).connect(input);
    noise.stop(now + 0.18);

    const splash = this.noiseSource(0.09, 1.8);
    const splashFilter = ctx.createBiquadFilter();
    splashFilter.type = 'highpass';
    splashFilter.frequency.value = 4200;
    const splashGain = ctx.createGain();
    splashGain.gain.setValueAtTime(0.3, now + 0.01);
    splashGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    splash.connect(splashFilter).connect(splashGain).connect(input);
    splash.stop(now + 0.12);
  }

  /** Mechanical clicks for the reload sequence. */
  playMech(kind: 'magOut' | 'magIn' | 'bolt' | 'dry' | 'ads'): void {
    if (!this.isRunning) return;
    if (!this.throttle(`mech_${kind}`, 0.08)) return;
    const ctx = this.ctx as AudioContext;
    const { input } = this.spatialChain(null, 0.32, 0.3);
    const now = ctx.currentTime;

    const profiles: Record<string, { freq: number; q: number; dur: number; level: number; rate: number }> = {
      magOut: { freq: 1500, q: 2.4, dur: 0.09, level: 0.7, rate: 1.2 },
      magIn: { freq: 900, q: 1.8, dur: 0.13, level: 1.0, rate: 0.9 },
      bolt: { freq: 2400, q: 3.6, dur: 0.11, level: 0.95, rate: 1.5 },
      dry: { freq: 3200, q: 4.5, dur: 0.05, level: 0.55, rate: 2.0 },
      ads: { freq: 1800, q: 2, dur: 0.05, level: 0.22, rate: 1.4 },
    };
    const p = profiles[kind];
    const noise = this.noiseSource(p.dur + 0.04, p.rate);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = p.freq;
    filter.Q.value = p.q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(p.level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + p.dur);
    noise.connect(filter).connect(gain).connect(input);
    noise.stop(now + p.dur + 0.05);

    if (kind === 'magIn' || kind === 'bolt') {
      // A metallic clack has a body as well as a click.
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(kind === 'magIn' ? 220 : 340, now);
      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.16, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(oscGain).connect(input);
      osc.start(now);
      osc.stop(now + 0.08);
    }
  }

  /** Rising tone + a thud when the player takes a hit. */
  playPlayerHit(): void {
    if (!this.isRunning) return;
    const ctx = this.ctx as AudioContext;
    const { input } = this.spatialChain(null, 0.5, 0.2);
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.22);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.6, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain).connect(input);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  /** Short UI blip for the hitmarker; pitched up for a kill. */
  playHitmarker(killed: boolean): void {
    if (!this.isRunning) return;
    const ctx = this.ctx as AudioContext;
    const { input } = this.spatialChain(null, 0.16, 0.05);
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(killed ? 1400 : 980, now);
    if (killed) osc.frequency.exponentialRampToValueAtTime(1900, now + 0.06);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (killed ? 0.13 : 0.06));
    osc.connect(gain).connect(input);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  // ------------------------------------------------------------------
  // Ambience
  // ------------------------------------------------------------------

  /**
   * Continuous bed: wind through the containers, a low harbour drone and the
   * lap of water. Three looping filtered-noise voices with slow LFOs so the
   * bed never sits still.
   */
  private startAmbience(): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    this.ambienceGain = ctx.createGain();
    this.ambienceGain.gain.value = 0;
    this.ambienceGain.connect(this.master);
    this.ambienceGain.gain.setTargetAtTime(0.32, ctx.currentTime, 1.5);

    const voices: Array<{ type: BiquadFilterType; freq: number; q: number; gain: number; lfo: number; depth: number; rate: number }> = [
      // Wind: band-limited hiss that swells.
      { type: 'bandpass', freq: 620, q: 0.7, gain: 0.32, lfo: 0.07, depth: 420, rate: 0.9 },
      // Harbour drone: distant machinery.
      { type: 'lowpass', freq: 120, q: 0.9, gain: 0.5, lfo: 0.031, depth: 40, rate: 0.35 },
      // Water against the quay.
      { type: 'bandpass', freq: 260, q: 1.4, gain: 0.22, lfo: 0.13, depth: 120, rate: 0.6 },
    ];

    for (const voice of voices) {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;
      source.playbackRate.value = voice.rate;
      const filter = ctx.createBiquadFilter();
      filter.type = voice.type;
      filter.frequency.value = voice.freq;
      filter.Q.value = voice.q;
      const gain = ctx.createGain();
      gain.gain.value = voice.gain;

      // Slow LFO on the filter cutoff keeps the bed alive.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = voice.lfo;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = voice.depth;
      lfo.connect(lfoGain).connect(filter.frequency);
      lfo.start();

      source.connect(filter).connect(gain).connect(this.ambienceGain);
      source.start(ctx.currentTime, Math.random() * 1.5);
      this.ambienceSources.push(source);
    }
  }

  /** Ducks the ambience during the intro and the end card. */
  setAmbienceLevel(level: number): void {
    if (!this.ambienceGain || !this.ctx) return;
    this.ambienceGain.gain.setTargetAtTime(level * 0.32, this.ctx.currentTime, 0.4);
  }

  dispose(): void {
    for (const source of this.ambienceSources) {
      try {
        source.stop();
      } catch {
        // Already stopped; nothing to do.
      }
    }
    this.ambienceSources.length = 0;
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}

const tmpVec = new THREE.Vector3();
