// THROWAWAY SPIKE — drives ProbeEngine through a synthetic acoustic loop:
// engine output → fixed delay (output+input latency) → room impulse response
// (direct path, two reflections, decaying tail) → + noise + synthetic pad hits
// → engine input. Checks the calibration, the subtraction and the hit timing.
import { ProbeEngine, analyzeCalibration, makeClick, mean, std, dB } from './dsp.js';

const sr = 48000;
const BLOCK = 128;
const D_TRUE = Math.round(sr * 0.0312); // 31.2 ms loopback
const NOISE = 0.001; // -60 dBFS

// --- room impulse response (sparse + short dense tail) ---
const ir = [];
ir.push([0, 0.4]);
ir.push([Math.round(sr * 0.0021), 0.18]);
ir.push([Math.round(sr * 0.0057), -0.09]);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const tailLen = Math.round(sr * 0.02);
for (let i = 0; i < tailLen; i += 3) ir.push([Math.round(sr * 0.008) + i, 0.04 * rnd() * Math.exp(-i / (sr * 0.006))]);

// --- synthetic pad hit: broadband burst + low thump, fast decay ---
function makeHit(amp = 0.6) {
  const n = Math.round(sr * 0.06);
  const h = new Float32Array(n);
  const att = Math.round(sr * 0.0003);
  for (let i = 0; i < n; i++) {
    const env = (i < att ? i / att : 1) * Math.exp(-(i - att) / (sr * 0.012));
    h[i] = amp * env * (0.7 * rnd() + 0.3 * Math.sin((2 * Math.PI * 180 * i) / sr));
  }
  return h;
}

const outHist = new Float32Array(1 << 17);
const HM = outHist.length - 1;
const extra = new Map(); // sample index -> additive value (hits)
function addEvent(at, wave) {
  for (let i = 0; i < wave.length; i++) extra.set(at + i, (extra.get(at + i) || 0) + wave[i]);
}

const msgs = [];
const engine = new ProbeEngine(sr, (m) => msgs.push(m));
engine.handle({ type: 'params', gain: 1.0 }); // loud click, as a drummer would need it
let n = 0;
const inp = new Float32Array(BLOCK), out = new Float32Array(BLOCK);
function runBlocks(count) {
  for (let b = 0; b < count; b++) {
    for (let i = 0; i < BLOCK; i++) {
      const k = n + i;
      let v = NOISE * rnd();
      for (const [d, g] of ir) v += g * outHist[(k - D_TRUE - d) & HM];
      const ex = extra.get(k);
      if (ex) { v += ex; extra.delete(k); }
      inp[i] = v;
    }
    engine.processBlock(inp, out);
    for (let i = 0; i < BLOCK; i++) outHist[(n + i) & HM] = out[i];
    n += BLOCK;
  }
}
const take = (type) => { const r = msgs.filter((m) => m.type === type); for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === type) msgs.splice(i, 1); return r; };
const ms = (s) => (s / sr) * 1000;
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

// ---------- 1. calibration ----------
engine.handle({ type: 'calibrate', count: 16, periodMs: 400 });
runBlocks(Math.ceil((sr * 7.5) / BLOCK));
const segs = take('segment').map((m) => m.data);
check(segs.length === 16, `calibration captured 16 segments (got ${segs.length})`);
const cal = analyzeCalibration(segs, sr, makeClick(sr, engine.clickFreq, 0), makeClick(sr, engine.clickFreq, Math.PI / 2), engine);
console.log(`  loopback delay ${cal.delayMs.toFixed(3)} ms (true ${ms(D_TRUE).toFixed(3)}), jitter σ ${cal.jitterMs.toFixed(4)} ms, spread ${cal.spreadMs.toFixed(4)} ms, corr SNR ${cal.snr.toFixed(1)}, click peak at mic ${dB(cal.clickPeak).toFixed(1)} dBFS`);
// the correlation peak is "best overlap with the room response", not first
// arrival, so a small constant bias vs. the direct path is expected and harmless
check(Math.abs(ms(cal.D - D_TRUE)) <= 0.5, 'estimated delay within 0.5 ms of the direct path');
check(cal.jitterMs < 0.02, 'jitter floor below 0.02 ms in a deterministic loop');
const calibTriggers = take('hit').length;
console.log(`  detector triggers during calibration (notch only, no subtraction yet): ${calibTriggers}/16`);
engine.handle({ type: 'template', template: cal.template, start: cal.start });
take('click'); take('residual'); take('meter');

// ---------- 2. metronome, nobody playing ----------
engine.handle({ type: 'start', bpm: 120, count: 12 });
runBlocks(Math.ceil((sr * 6.5) / BLOCK));
let res = take('residual').map((m) => m.peak);
const idleResidualMax = Math.max(...res);
let hits = take('hit');
take('click');
console.log(`  residual peak after subtraction: max ${dB(idleResidualMax).toFixed(1)} dBFS, mean ${dB(mean(res)).toFixed(1)} dBFS → cancellation ${(dB(cal.clickPeak) - dB(idleResidualMax)).toFixed(1)} dB`);
check(res.length === 12, `12 residual windows (got ${res.length})`);
check(hits.length === 0, `no false hits while idle against the metronome (got ${hits.length})`);
check(idleResidualMax < cal.clickPeak * 0.05, 'residual at least 26 dB below the raw click');

// ---------- 3. metronome with synthetic hits at known offsets ----------
const offsetsMs = [0, 8, -6, 20, -15, 0, 3, -3, 12, -9, 0, 25];
engine.handle({ type: 'start', bpm: 120, count: offsetsMs.length });
const clicks = [];
const period = Math.round((sr * 60) / 120);
// schedule hits relative to where each click will ARRIVE at the mic
const firstE = engine.nextClick;
offsetsMs.forEach((o, i) => addEvent(firstE + i * period + cal.D + Math.round((sr * o) / 1000), makeHit(0.6)));
runBlocks(Math.ceil((sr * 6.5) / BLOCK));
clicks.push(...take('click').map((m) => m.e));
hits = take('hit');
res = take('residual').map((m) => m.peak);
check(hits.length === offsetsMs.length, `one detection per hit (${hits.length}/${offsetsMs.length})`);
let worst = 0;
hits.forEach((h, i) => {
  const arrivals = clicks.map((e) => e + cal.D);
  const nearest = arrivals.reduce((a, b) => (Math.abs(b - h.sample) < Math.abs(a - h.sample) ? b : a));
  const delta = ms(h.sample - nearest);
  const err = delta - (offsetsMs[i] ?? NaN);
  worst = Math.max(worst, Math.abs(err));
  console.log(`  hit ${i + 1}: measured ${delta.toFixed(2)} ms, true ${offsetsMs[i]} ms, error ${err.toFixed(2)} ms, peak ${dB(h.peak).toFixed(1)} dBFS`);
});
check(worst < 1, `every hit timed within 1 ms of truth (worst ${worst.toFixed(2)} ms)`);
const hitPeak = mean(hits.map((h) => h.peak));
console.log(`  separation margin: hit peak ${dB(hitPeak).toFixed(1)} dBFS vs idle residual max ${dB(idleResidualMax).toFixed(1)} dBFS = ${(dB(hitPeak) - dB(idleResidualMax)).toFixed(1)} dB`);

// ---------- 4. subdivision grid: 16ths against a 120 bpm click ----------
const subdiv = 4;
const gridOffsetsMs = [0, 4, -3, 2, 6, 0, -5, 3, 1, -2, 0, 4, 0, 0, 2, -4]; // 16 sixteenths = 4 beats
engine.handle({ type: 'start', bpm: 120, count: 4 });
const e0 = engine.nextClick;
const step = period / subdiv;
gridOffsetsMs.forEach((o, i) => addEvent(Math.round(e0 + i * step + cal.D + (sr * o) / 1000), makeHit(0.6)));
runBlocks(Math.ceil((sr * 2.5) / BLOCK));
const gridClicks = take('click').map((m) => m.e);
const gridHits = take('hit');
take('residual');
check(gridHits.length === gridOffsetsMs.length, `one detection per sixteenth (${gridHits.length}/${gridOffsetsMs.length})`);
let worstGrid = 0;
gridHits.forEach((h, i) => {
  // nearest click, then nearest grid line inside that beat
  const arrivals = gridClicks.map((e) => e + cal.D);
  const nearestClick = arrivals.reduce((a, b) => (Math.abs(b - h.sample) < Math.abs(a - h.sample) ? b : a));
  const k = Math.round((h.sample - nearestClick) / step);
  const delta = ms(h.sample - (nearestClick + k * step));
  worstGrid = Math.max(worstGrid, Math.abs(delta - gridOffsetsMs[i]));
});
check(worstGrid < 1, `sixteenths measured against the virtual grid within 1 ms (worst ${worstGrid.toFixed(2)} ms)`);

// ---------- 5. controls: what happens without the layers ----------
engine.handle({ type: 'params', subtract: false });
engine.handle({ type: 'start', bpm: 120, count: 8 });
runBlocks(Math.ceil((sr * 4.5) / BLOCK));
const ctrlHits = take('hit').length;
const ctrlRes = take('residual').map((m) => m.peak);
console.log(`  control (notch only, no subtraction): ${ctrlHits} false hits over 8 clicks, leak peak ${dB(Math.max(...ctrlRes)).toFixed(1)} dBFS`);
engine.handle({ type: 'params', subtract: false, notch: false });
engine.handle({ type: 'start', bpm: 120, count: 8 });
runBlocks(Math.ceil((sr * 4.5) / BLOCK));
const rawHits = take('hit').length;
take('residual');
console.log(`  control (nothing): ${rawHits} false hits over 8 clicks`);
check(rawHits >= 6, 'without the layers the click itself triggers the detector (so the tests above are meaningful)');
engine.handle({ type: 'params', subtract: true, notch: false });
engine.handle({ type: 'start', bpm: 120, count: 8 });
runBlocks(Math.ceil((sr * 4.5) / BLOCK));
const ctrl2 = take('hit').length;
const ctrl2Res = take('residual').map((m) => m.peak);
console.log(`  control (subtraction only, no notch): ${ctrl2} false hits over 8 clicks, residual peak ${dB(Math.max(...ctrl2Res)).toFixed(1)} dBFS`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
