// THROWAWAY SPIKE — DSP core shared by the AudioWorklet (worklet.js) and the
// Node simulation (test.mjs). Plain ES module, no DOM, no Web Audio objects.

// ---------- click synthesis ----------

// Short band-limited sine burst. phase=π/2 gives the quadrature twin used for
// envelope-based cross-correlation.
export function makeClick(sr, freq = 4000, phase = 0, durMs = 25, attackMs = 1, tauMs = 8) {
  const n = Math.round((sr * durMs) / 1000);
  const a = Math.max(1, Math.round((sr * attackMs) / 1000));
  const tau = (sr * tauMs) / 1000;
  const fadeLen = Math.round(sr * 0.002);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let env = i < a ? 0.5 - 0.5 * Math.cos((Math.PI * i) / a) : Math.exp(-(i - a) / tau);
    const left = n - i;
    if (left < fadeLen) env *= left / fadeLen;
    out[i] = env * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  }
  return out;
}

// ---------- analysis helpers (main thread / test) ----------

export function crossCorrelate(seg, ref, maxLag) {
  const out = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    const end = Math.min(ref.length, seg.length - lag);
    for (let i = 0; i < end; i++) s += seg[lag + i] * ref[i];
    out[lag] = s;
  }
  return out;
}

export function argmaxParabolic(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  let frac = 0;
  if (best > 0 && best < arr.length - 1) {
    const y0 = arr[best - 1], y1 = arr[best], y2 = arr[best + 1];
    const d = y0 - 2 * y1 + y2;
    if (d !== 0) frac = (0.5 * (y0 - y2)) / d;
  }
  return { index: best, value: arr[best], refined: best + frac };
}

export function median(xs) {
  const s = Array.from(xs).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
export function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : 0;
}
export function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
export const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

// Locate the click in each captured mic segment (quadrature correlation →
// smooth envelope → parabolic peak), then average the aligned segments into a
// template of "what one click looks like at the mic, tail included".
// Envelope of the quadrature cross-correlation, peak-picked: where does the
// click start inside this segment? Returns a fractional lag plus a crude SNR.
export function locateClick(seg, click, clickQ, maxLag) {
  const c1 = crossCorrelate(seg, click, maxLag);
  const c2 = crossCorrelate(seg, clickQ, maxLag);
  const mag = new Float32Array(maxLag + 1);
  for (let i = 0; i <= maxLag; i++) mag[i] = Math.hypot(c1[i], c2[i]);
  const pk = argmaxParabolic(mag);
  return { index: pk.index, refined: pk.refined, snr: pk.value / (median(mag) || 1e-12) };
}

export function analyzeCalibration(segments, sr, click, clickQ, { maxD, L, pre }) {
  const per = segments.map((seg) => locateClick(seg, click, clickQ, maxD));
  const refined = per.map((p) => p.refined);
  const D = Math.round(median(refined));
  const start = Math.max(0, D - pre);
  const template = new Float32Array(L);
  for (const seg of segments) for (let i = 0; i < L; i++) template[i] += seg[start + i];
  for (let i = 0; i < L; i++) template[i] /= segments.length;
  let clickPeak = 0;
  for (let i = 0; i < L; i++) clickPeak = Math.max(clickPeak, Math.abs(template[i]));
  const ms = (s) => (s / sr) * 1000;
  return {
    D,
    start,
    template,
    clickPeak,
    delayMs: ms(D),
    jitterMs: ms(std(refined)),
    spreadMs: ms(Math.max(...refined) - Math.min(...refined)),
    snr: median(per.map((p) => p.snr)),
    perClickMs: refined.map(ms),
  };
}

// ---------- real-time pieces (worklet) ----------

export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  static notch(sr, f, Q) {
    const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
    return Object.assign(new Biquad(), { b0: 1 / a0, b1: -2 * c / a0, b2: 1 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 });
  }
  static highpass(sr, f, Q) {
    const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
    return Object.assign(new Biquad(), { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 });
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// Future-subtraction ring: when a click is emitted at sample e, the learned
// template is added at e+offset; every incoming mic sample takes (and clears)
// its slot.
export class Subtractor {
  constructor(size = 1 << 16) {
    this.buf = new Float32Array(size);
    this.mask = size - 1;
    this.template = null;
    this.offset = 0;
  }
  setTemplate(t, offset) { this.template = t; this.offset = offset; }
  schedule(e) {
    const t = this.template;
    if (!t) return;
    const s = e + this.offset;
    for (let i = 0; i < t.length; i++) this.buf[(s + i) & this.mask] += t[i];
  }
  take(n) {
    const k = n & this.mask;
    const v = this.buf[k];
    this.buf[k] = 0;
    return v;
  }
}

// Envelope-follower onset detector with adaptive floor, refractory period and
// hysteresis re-arm. Returns an onset sample index (slightly back-tracked) or -1.
export class OnsetDetector {
  constructor(sr, o = {}) {
    const coef = (ms) => 1 - Math.exp(-1 / ((sr * ms) / 1000));
    this.attack = coef(o.attackMs ?? 0.3);
    this.release = coef(o.releaseMs ?? 6);
    this.floorUp = coef(o.floorRiseMs ?? 1500);
    this.floorDown = coef(o.floorFallMs ?? 20);
    this.ratio = o.ratio ?? 6;
    this.absThresh = o.absThresh ?? 0.03;
    this.refractory = Math.round((sr * (o.refractoryMs ?? 40)) / 1000);
    this.lookback = Math.round((sr * (o.lookbackMs ?? 3)) / 1000);
    // optional rise rule: the envelope must have grown by riseDb within riseMs,
    // which a decaying tail never satisfies but a stick attack always does
    this.riseGain = (o.riseDb ?? 6) ? Math.pow(10, (o.riseDb ?? 6) / 20) : 0;
    this.riseLag = Math.round((sr * (o.riseMs ?? 3)) / 1000);
    this.hist = new Float32Array(1 << 10);
    this.mask = this.hist.length - 1;
    this.env = 0; this.floor = 0.001; this.refUntil = 0; this.armed = true; this.peakHold = 0;
  }
  push(x, n) {
    const a = Math.abs(x);
    this.env += (a - this.env) * (a > this.env ? this.attack : this.release);
    this.hist[n & this.mask] = this.env;
    if (!this.armed) {
      if (this.env > this.peakHold) this.peakHold = this.env;
      else if (this.env < this.peakHold * 0.3) this.armed = true;
    }
    if (n < this.refUntil) return -1;
    const rose = !this.riseGain || this.env > this.riseGain * this.hist[(n - this.riseLag) & this.mask];
    if (this.armed && rose && this.env > this.absThresh && this.env > this.ratio * this.floor) {
      this.peakHold = this.env;
      this.armed = false;
      this.refUntil = n + this.refractory;
      // back-track along the envelope while it is still clearly above the floor
      const thr = Math.max(this.floor * 2, this.env * 0.1);
      let onset = n;
      for (let k = 1; k <= this.lookback; k++) {
        const v = this.hist[(n - k) & this.mask];
        if (v < thr || v > this.hist[(n - k + 1) & this.mask]) break;
        onset = n - k;
      }
      return onset;
    }
    // minimum tracker: falls quickly to the quiet gaps between hits, rises slowly
    this.floor += (this.env - this.floor) * (this.env < this.floor ? this.floorDown : this.floorUp);
    return -1;
  }
}

// ---------- the engine the worklet runs ----------

export class ProbeEngine {
  constructor(sr, post) {
    this.sr = sr;
    this.post = post;
    this.n = 0;
    this.gain = 0.5;
    this.clickPos = -1;
    this.period = 0; this.nextClick = 0; this.clicksLeft = -1;
    this.mode = 'idle';
    this.maxD = Math.round(sr * 0.15);
    this.L = Math.round(sr * 0.12);
    this.pre = Math.round(sr * 0.002);
    this.captures = [];
    this.sub = new Subtractor();
    this.start = null;
    this.subtract = true;
    this.useNotch = true;
    this.hp = Biquad.highpass(sr, 150, 0.707);
    this.setClick(4000);
    this.onset = new OnsetDetector(sr);
    this.windows = [];
    this.pendingHits = [];
    this.blockPeak = 0; this.meterBlocks = 0;
    this.rec = null; // {raw, res, i, n0} chunk being filled while recording
  }
  newRecChunk(n0) {
    const size = 1 << 14;
    this.rec = { raw: new Float32Array(size), res: new Float32Array(size), i: 0, n0 };
  }
  flushRec() {
    const r = this.rec;
    if (!r || r.i === 0) return;
    const raw = r.raw.subarray(0, r.i).slice(), res = r.res.subarray(0, r.i).slice();
    this.post({ type: 'rec', n0: r.n0, raw, res }, [raw.buffer, res.buffer]);
  }
  setClick(freq) {
    this.clickFreq = freq;
    this.click = makeClick(this.sr, freq);
    this.notch = Biquad.notch(this.sr, freq, 2);
  }
  handle(m) {
    switch (m.type) {
      case 'params':
        if (m.gain != null) this.gain = m.gain;
        if (m.subtract != null) this.subtract = m.subtract;
        if (m.notch != null) this.useNotch = m.notch;
        if (m.absThresh != null) this.onset.absThresh = m.absThresh;
        if (m.ratio != null) this.onset.ratio = m.ratio;
        if (m.clickFreq != null && m.clickFreq !== this.clickFreq) {
          this.setClick(m.clickFreq);
          this.sub.setTemplate(null, 0); this.start = null;
        }
        break;
      case 'calibrate':
        this.mode = 'calib';
        this.period = Math.round((this.sr * m.periodMs) / 1000);
        this.clicksLeft = m.count;
        this.nextClick = this.n + 128;
        break;
      case 'template':
        this.start = m.start;
        this.sub.setTemplate(m.template, m.start);
        break;
      case 'start':
        this.mode = 'run';
        this.period = Math.round((this.sr * 60) / m.bpm);
        this.clicksLeft = m.count ?? -1;
        this.nextClick = this.n + 128;
        break;
      case 'stop':
        this.mode = 'idle';
        this.period = 0;
        this.clickPos = -1;
        break;
      case 'record':
        if (m.on) this.newRecChunk(this.n);
        else { this.flushRec(); this.rec = null; }
        break;
    }
  }
  processBlock(inp, out) {
    const len = out.length;
    for (let i = 0; i < len; i++) {
      const n = this.n + i;
      // --- click output ---
      if (this.period > 0 && n === this.nextClick) this.emit(n);
      let o = 0;
      if (this.clickPos >= 0) {
        o = this.click[this.clickPos++] * this.gain;
        if (this.clickPos >= this.click.length) this.clickPos = -1;
      }
      out[i] = o;
      // --- mic input ---
      const x = inp ? inp[i] : 0;
      const ax = Math.abs(x);
      if (ax > this.blockPeak) this.blockPeak = ax;
      for (const c of this.captures) if (n >= c.from && c.i < c.buf.length) c.buf[c.i++] = x;
      let r = x - (this.subtract ? this.sub.take(n) : 0);
      r = this.hp.process(r);
      if (this.useNotch) r = this.notch.process(r);
      const ar = Math.abs(r);
      if (this.rec) {
        const rc = this.rec;
        rc.raw[rc.i] = x; rc.res[rc.i] = r;
        if (++rc.i === rc.raw.length) { this.flushRec(); this.newRecChunk(n + 1); }
      }
      for (const w of this.windows) if (n >= w.start && n < w.end && ar > w.peak) w.peak = ar;
      for (const h of this.pendingHits) if (this.onset.env > h.peak) h.peak = this.onset.env;
      const onset = this.onset.push(r, n);
      if (onset >= 0) {
        this.pendingHits.push({ onset, peak: this.onset.env, reportAt: n + Math.round(this.sr * 0.006) });
        for (const w of this.windows) if (onset >= w.start && onset < w.end) w.hit = true;
      }
    }
    this.n += len;
    this.flush();
  }
  emit(e) {
    this.clickPos = 0;
    this.post({ type: 'click', e, mode: this.mode });
    if (this.mode === 'calib') this.captures.push({ kind: 'segment', e, from: e, buf: new Float32Array(this.maxD + this.L), i: 0 });
    if (this.mode === 'run' && this.subtract) this.sub.schedule(e);
    if (this.start != null && this.mode === 'run') {
      this.windows.push({ e, start: e + this.start, end: e + this.start + this.L, peak: 0, hit: false });
      // raw capture around the expected arrival, to re-locate the click per beat
      const pad = Math.round(this.sr * 0.004);
      const from = Math.max(e, e + this.start + this.pre - pad);
      this.captures.push({ kind: 'arrival', e, from, buf: new Float32Array(2 * pad + this.click.length), i: 0 });
    }
    this.nextClick += this.period;
    if (this.clicksLeft > 0 && --this.clicksLeft === 0) this.period = 0;
  }
  flush() {
    const n = this.n;
    this.captures = this.captures.filter((c) => {
      if (c.i < c.buf.length) return true;
      this.post({ type: c.kind, e: c.e, from: c.from, data: c.buf }, [c.buf.buffer]);
      return false;
    });
    this.windows = this.windows.filter((w) => {
      if (n < w.end) return true;
      this.post({ type: 'residual', e: w.e, peak: w.peak, hit: w.hit });
      return false;
    });
    this.pendingHits = this.pendingHits.filter((h) => {
      if (n < h.reportAt) return true;
      this.post({ type: 'hit', sample: h.onset, peak: h.peak, mode: this.mode });
      return false;
    });
    if (++this.meterBlocks >= 20) {
      this.post({ type: 'meter', peak: this.blockPeak });
      this.blockPeak = 0; this.meterBlocks = 0;
    }
  }
}
