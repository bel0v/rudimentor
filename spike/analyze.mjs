// THROWAWAY SPIKE — offline analysis of a downloaded run (WAV + JSON).
// Usage: node analyze.mjs recordings/run-....json
// 1. independent onset pick on the raw channel (frame energy, rise over local min)
// 2. replay the real-time OnsetDetector over the residual channel
// 3. compare both against the real-time detections and the click arrivals
import fs from 'node:fs';
import { OnsetDetector, mean, std, dB } from './dsp.js';

const jsonPath = process.argv[2];
const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const wav = fs.readFileSync(jsonPath.replace(/\.json$/, '.wav'));
const sr = meta.sr;
const dataOff = 44, frames = (wav.length - dataOff) / 4;
const raw = new Float32Array(frames), res = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  raw[i] = wav.readInt16LE(dataOff + i * 4) / 32768;
  res[i] = wav.readInt16LE(dataOff + i * 4 + 2) / 32768;
}
const n0 = meta.recStart;
const toS = (sample) => ((sample - n0) / sr).toFixed(3);
const arrivals = meta.clicks.map((c) => c.e + meta.cal.D);
const nearestArrival = (s) => arrivals.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
const deltaMs = (s) => ((s - nearestArrival(s)) / sr) * 1000;
console.log(`recording ${(frames / sr).toFixed(1)} s, ${meta.clicks.length} clicks, ${meta.hits.length} real-time hits, threshold ${meta.threshDb} dBFS`);

// ---- 1. independent onset pick on the residual channel (click already removed) ----
const F = Math.round(sr * 0.0005); // 0.5 ms frames
const nF = Math.floor(frames / F);
const en = new Float32Array(nF);
for (let f = 0; f < nF; f++) { let s = 0; for (let i = 0; i < F; i++) { const v = res[f * F + i]; s += v * v; } en[f] = Math.sqrt(s / F); }
const offline = [];
const lookback = 40; // 20 ms
let lastOnset = -1e9;
for (let f = lookback; f < nF; f++) {
  if (en[f] < 0.006) continue; // -44 dBFS
  let mn = Infinity; for (let k = f - lookback; k < f - 2; k++) mn = Math.min(mn, en[k]);
  if (en[f] > mn * 6 && (f * F) - lastOnset > sr * 0.08) {
    // refine: first frame in the rise above 25% of the next 3 ms peak
    let pk = 0; for (let k = f; k < Math.min(nF, f + 6); k++) pk = Math.max(pk, en[k]);
    let on = f; while (on > f - 6 && en[on - 1] > pk * 0.25) on--;
    offline.push({ sample: n0 + on * F, peak: pk });
    lastOnset = f * F;
  }
}
console.log(`\noffline onsets: ${offline.length}`);
for (const o of offline) {
  const rt = meta.hits.find((h) => Math.abs(h.sample - o.sample) < sr * 0.01);
  console.log(`  ${toS(o.sample)} s  Δclick ${deltaMs(o.sample).toFixed(1).padStart(6)} ms  level ${dB(o.peak).toFixed(0)} dBFS  ${rt ? `realtime Δ ${(((rt.sample - o.sample) / sr) * 1000).toFixed(2)} ms later` : 'NOT detected in real time'}`);
}
for (const h of meta.hits) if (!offline.some((o) => Math.abs(o.sample - h.sample) < sr * 0.01)) console.log(`  realtime-only (spurious?) ${toS(h.sample)} s Δclick ${h.dClick.toFixed(1)} ms level ${dB(h.peak).toFixed(0)} dBFS`);

// ---- 2. replay the real-time detector over the residual with variants ----
function replay(opts) {
  const det = new OnsetDetector(sr, { absThresh: Math.pow(10, meta.threshDb / 20), ...opts });
  const out = [];
  for (let i = 0; i < frames; i++) { const on = det.push(res[i], n0 + i); if (on >= 0) out.push(on); }
  return out;
}
function score(label, dets) {
  const matched = offline.filter((o) => dets.some((d) => Math.abs(d - o.sample) < sr * 0.01));
  const extra = dets.filter((d) => !offline.some((o) => Math.abs(d - o.sample) < sr * 0.01));
  const errs = matched.map((o) => { const d = dets.find((x) => Math.abs(x - o.sample) < sr * 0.01); return ((d - o.sample) / sr) * 1000; });
  console.log(`  ${label.padEnd(34)} detected ${matched.length}/${offline.length}, extra ${extra.length}${extra.length ? ' (' + extra.map((e) => toS(e)).join(', ') + ')' : ''}, onset bias ${mean(errs).toFixed(2)} ± ${std(errs).toFixed(2)} ms`);
}
console.log('\ndetector replay vs offline onsets:');
score('current (ratio 6, refractory 40)', replay({}));
score('refractory 60', replay({ refractoryMs: 60 }));
score('ratio 10', replay({ ratio: 10 }));
score('rise rule 6 dB / 3 ms', replay({ riseDb: 6 }));
score('rise rule 10 dB / 3 ms', replay({ riseDb: 10 }));

// ---- 3. what the drummer actually did ----
const d = offline.map((o) => deltaMs(o.sample));
console.log(`\ndeltas vs click arrival (offline onsets): mean ${mean(d).toFixed(1)} ms, σ ${std(d).toFixed(1)} ms`);
console.log('  ' + d.map((x) => x.toFixed(0)).join(' '));
