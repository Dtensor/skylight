// The sound of standing outside at night in the hills, made entirely in the
// browser (no audio files): wind, crickets, an owl now and then, a far
// monastery bell, birds by day — and the low rumble of the aircraft, placed
// left/right where each one is on the wall.
//
// Honest note: real jets 100+ km away are silent on the ground. Their rumble
// here follows the same distance compression as the picture.

export interface Voice {
  /** 0..1 loudness. */
  gain: number;
  /** -1 left .. 1 right. */
  pan: number;
  /** 0 muffled (far) .. 1 open (near). */
  bright: number;
}

interface Chirper {
  gain: GainNode;
  rate: number;
  next: number;
  level: number;
}

type Ctx = AudioContext;

function noiseBuffer(ctx: Ctx, seconds: number, brown: boolean): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else {
      d[i] = w;
    }
  }
  // Cross-fade the ends so the loop has no click.
  const f = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < f; i++) {
    const t = i / f;
    d[i] = d[i] * t + d[n - f + i] * (1 - t);
  }
  return buf;
}

export class Soundscape {
  private ctx: Ctx | null = null;
  private master!: GainNode;
  private wind!: GainNode;
  private crickets!: GainNode;
  private insects!: GainNode;
  private chirpers: Chirper[] = [];
  private voices: { gain: GainNode; filter: BiquadFilterNode; pan: StereoPannerNode | null }[] = [];
  private nextOwl = 40 + Math.random() * 60;
  private nextBell = 150 + Math.random() * 240;
  private nextBird = 4;
  private white!: AudioBuffer;

  constructor() {
    try {
      const AC: typeof AudioContext | undefined =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.build(this.ctx);
    } catch (e) {
      console.warn("[wall] no audio:", e);
      this.ctx = null;
    }
  }

  /** Browsers hold audio until a key or click; the wall app does not need this. */
  unlock(): void {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
  }

  get running(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }

  private panner(ctx: Ctx, pan: number): { node: AudioNode; pan: StereoPannerNode | null } {
    if (typeof ctx.createStereoPanner === "function") {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      return { node: p, pan: p };
    }
    return { node: ctx.createGain(), pan: null };
  }

  private build(ctx: Ctx): void {
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    const brown = noiseBuffer(ctx, 5, true);
    const white = noiseBuffer(ctx, 3, false);
    this.white = white;
    const loop = (buf: AudioBuffer, rate: number): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start();
      return s;
    };

    // Wind in the trees: brown noise through a soft low-pass, breathing slowly.
    const wf = ctx.createBiquadFilter();
    wf.type = "lowpass";
    wf.frequency.value = 520;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    loop(brown, 1).connect(wf);
    wf.connect(this.wind);
    this.wind.connect(this.master);

    // A thin high insect shimmer under the individual crickets.
    const bf = ctx.createBiquadFilter();
    bf.type = "bandpass";
    bf.frequency.value = 5400;
    bf.Q.value = 7;
    const trem = ctx.createGain();
    trem.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9.5;
    const depth = ctx.createGain();
    depth.gain.value = 0.4;
    lfo.connect(depth);
    depth.connect(trem.gain);
    lfo.start();
    this.insects = ctx.createGain();
    this.insects.gain.value = 0;
    loop(white, 1).connect(bf);
    bf.connect(trem);
    trem.connect(this.insects);
    this.insects.connect(this.master);

    // Crickets: each one a steady tone gated into short pulse trains.
    this.crickets = ctx.createGain();
    this.crickets.gain.value = 0;
    this.crickets.connect(this.master);
    for (let i = 0; i < 6; i++) {
      const osc = ctx.createOscillator();
      osc.frequency.value = 3900 + Math.random() * 1300;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = this.panner(ctx, Math.random() * 1.8 - 0.9);
      osc.connect(g);
      g.connect(p.node);
      p.node.connect(this.crickets);
      osc.start();
      this.chirpers.push({ gain: g, rate: 1.5 + Math.random() * 1.3, next: ctx.currentTime + Math.random() * 2, level: 0.02 + Math.random() * 0.05 });
    }

    // Three aircraft voices.
    for (let i = 0; i < 3; i++) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 200;
      f.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = this.panner(ctx, 0);
      loop(brown, 0.8 + i * 0.17).connect(f);
      f.connect(g);
      g.connect(p.node);
      p.node.connect(this.master);
      this.voices.push({ gain: g, filter: f, pan: p.pan });
    }
  }

  /** One enveloped sine partial; the building block of the owl, bell and birds. */
  private tone(at: number, f0: number, f1: number, dur: number, level: number, pan: number, attack = 0.04, cutoff = 0): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(level, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const p = this.panner(ctx, pan);
    osc.connect(g);
    let out: AudioNode = g;
    if (cutoff) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = cutoff;
      g.connect(lp);
      out = lp;
    }
    out.connect(p.node);
    p.node.connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /** "Hoo ... hoo-hoo" from somewhere off in the trees. */
  owl(pan: number): void {
    if (!this.running) return;
    const t = this.ctx!.currentTime + 0.1;
    for (const [dt, dur] of [[0, 0.5], [0.85, 0.22], [1.15, 0.6]]) {
      this.tone(t + dt, 372, 338, dur, 0.085, pan, 0.07, 900);
      this.tone(t + dt, 744, 676, dur, 0.012, pan, 0.07, 1400);
    }
  }

  /** A far monastery bell: inharmonic partials with long, uneven decays. */
  bell(): void {
    if (!this.running) return;
    const t = this.ctx!.currentTime + 0.1;
    const pan = Math.random() * 1.2 - 0.6;
    for (const [mul, amp, dur] of [[1, 1, 8], [2.0, 0.55, 5.5], [2.76, 0.32, 4], [5.4, 0.1, 2]]) {
      this.tone(t, 172 * mul, 171 * mul, dur, 0.04 * amp, pan, 0.008, 1500);
    }
  }

  private speaking = 0;

  /** True while a spoken exchange is still playing. */
  get busy(): boolean {
    return !!this.ctx && this.ctx.currentTime < this.speaking;
  }

  /**
   * Speak an exchange softly. "radio" is thin and narrow with a click of static
   * at each end, as from a cockpit speaker; "cabin" starts with the two-note
   * chime and sounds like an overhead speaker a few rows away.
   */
  async say(lines: { url: string; pitch: number }[], channel: "radio" | "cabin", pan: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || this.busy) return;
    this.speaking = ctx.currentTime + 20; // held until the real length is known
    const bufs: (AudioBuffer | null)[] = await Promise.all(lines.map(async (l) => {
      try {
        const r = await fetch(l.url);
        if (!r.ok) return null;
        const data = await r.arrayBuffer();
        return await new Promise<AudioBuffer | null>((done) => ctx.decodeAudioData(data, (b) => done(b), () => done(null)));
      } catch {
        return null;
      }
    }));
    const out = ctx.createGain();
    out.gain.value = channel === "radio" ? 0.42 : 0.34;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = channel === "radio" ? 420 : 260;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = channel === "radio" ? 2500 : 3600;
    const p = this.panner(ctx, Math.max(-0.7, Math.min(0.7, pan)));
    hp.connect(lp);
    lp.connect(out);
    out.connect(p.node);
    p.node.connect(this.master);
    let t = ctx.currentTime + 0.15;
    if (channel === "cabin") {
      this.tone(t, 587, 585, 1.1, 0.05, pan * 0.5, 0.01, 2400);
      this.tone(t + 0.42, 466, 464, 1.5, 0.05, pan * 0.5, 0.01, 2400);
      t += 1.5;
    }
    const hiss = (at: number, dur: number, level: number) => {
      const n = ctx.createBufferSource();
      n.buffer = this.white;
      n.loop = true;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, at);
      g.gain.setValueAtTime(0, at + dur);
      n.connect(g);
      g.connect(hp);
      n.start(at);
      n.stop(at + dur + 0.02);
    };
    lines.forEach((l, i) => {
      const b = bufs[i];
      if (!b) return;
      const dur = b.duration / l.pitch;
      if (channel === "radio") {
        hiss(t, 0.09, 0.5); // the click of a transmit key
        hiss(t + 0.09, dur + 0.1, 0.035); // carrier hiss under the voice
        hiss(t + dur + 0.19, 0.07, 0.4);
      }
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.playbackRate.value = l.pitch;
      src.connect(hp);
      src.start(t + 0.1);
      t += dur + (channel === "radio" ? 0.75 : 0.5);
    });
    this.speaking = t;
  }

  private tweet(): void {
    const t = this.ctx!.currentTime + 0.05;
    const pan = Math.random() * 1.8 - 0.9;
    const base = 2300 + Math.random() * 1800;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      this.tone(t + i * (0.11 + Math.random() * 0.05), base, base * (1.2 + Math.random() * 0.5), 0.09, 0.028, pan, 0.012);
    }
  }

  update(dt: number, tSec: number, o: { enabled: boolean; volume: number; night: number; windKmh: number; voices: Voice[] }): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.5) => p.setTargetAtTime(v, now, tc);
    set(this.master.gain, o.enabled ? Math.max(0, Math.min(1, o.volume)) : 0, 0.3);
    if (!o.enabled) return;

    const gust = 0.62 + 0.24 * Math.sin(tSec * 0.11) + 0.14 * Math.sin(tSec * 0.37 + 1.3);
    set(this.wind.gain, (0.05 + (Math.min(o.windKmh, 40) / 40) * 0.24) * gust, 1.2);
    set(this.crickets.gain, 0.9 * o.night, 2);
    set(this.insects.gain, 0.03 * o.night, 2);

    // Crickets: schedule the next half second of pulses.
    for (const c of this.chirpers) {
      if (c.next < now) c.next = now + Math.random() * 0.3;
      while (c.next < now + 0.5) {
        const pulses = 2 + Math.floor(Math.random() * 3);
        for (let k = 0; k < pulses; k++) {
          const t = c.next + k * 0.021;
          c.gain.gain.setValueAtTime(0, t);
          c.gain.gain.linearRampToValueAtTime(c.level, t + 0.005);
          c.gain.gain.linearRampToValueAtTime(0, t + 0.016);
        }
        // Mostly steady, with the odd pause while it listens.
        c.next += (1 / c.rate) * (0.92 + Math.random() * 0.16) + (Math.random() < 0.04 ? 2 + Math.random() * 5 : 0);
      }
    }

    this.nextOwl -= dt;
    if (this.nextOwl <= 0) {
      this.nextOwl = 70 + Math.random() * 150;
      if (o.night > 0.8) this.owl(Math.random() * 1.6 - 0.8);
    }
    this.nextBell -= dt;
    if (this.nextBell <= 0) {
      this.nextBell = 240 + Math.random() * 420;
      this.bell();
    }
    this.nextBird -= dt;
    if (this.nextBird <= 0) {
      this.nextBird = 2.5 + Math.random() * 9;
      if (o.night < 0.35) this.tweet();
    }

    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const src = o.voices[i];
      set(v.gain.gain, src ? src.gain * 0.5 : 0, 0.9);
      if (!src) continue;
      set(v.filter.frequency, 130 + 950 * src.bright, 0.9);
      if (v.pan) set(v.pan.pan, Math.max(-1, Math.min(1, src.pan)), 0.6);
    }
  }
}
