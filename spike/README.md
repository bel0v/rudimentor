# Timing probe — THROWAWAY SPIKE

Answers one question: can a browser measure drum-pad hits against its own click
with sub-millisecond jitter, through laptop speakers and the built-in mic, with
the click subtracted from the mic signal programmatically?

Nothing here is product code. Keep the findings, not the files.

## Run

```
cd spike
python3 -m http.server 8765
# open http://localhost:8765 in Chrome (Safari should work too)
```

Wired/built-in audio only. Quit anything else that uses the mic. Put the pad
roughly where it will live relative to the laptop.

1. **Start audio**, allow the mic. Check the info line says echoCancellation,
   noiseSuppression and autoGainControl are all `false`.
2. **Calibrate** with the room silent. Read *jitter σ*: under 1 ms is the goal,
   under 0.3 ms is what I expect on Core Audio. *Correlation SNR* under 20 means
   the mic barely hears the click: raise click volume and recalibrate.
3. **Run, test A**: start the metronome and do not play. *Hits detected* must
   stay at 0. If it climbs, the residual is leaking through the detector; try a
   higher threshold or louder/quieter click, and recalibrate after any change.
4. **Run, test B**: play along. Read the grid delta σ and the histogram.
   *Separation* above 20 dB is comfortable.

"Notes per click" sets the virtual grid: 2 = eighths, 4 = sixteenths against
the click. Every hit is measured against the nearest grid line (Δ grid) and,
for comparison, the nearest click (Δ click).

## Findings (2026-10-10, MacBook built-in speakers + mic, Chrome)

| Measurement | Result |
|---|---|
| Loopback delay speaker → mic | 66 ms, constant |
| Jitter σ of click arrival over 16 clicks | 0.007–0.016 ms |
| Stream alignment drift during a run | < 0.05 ms |
| Click at mic / after subtraction | −23 dBFS / −51 dBFS (27 dB cancellation) |
| False hits, metronome only, 29 clicks | 0 |
| Pad hits at −22…−29 dBFS, threshold −40 | 16/16 detected |
| Real-time onset vs independent offline pick | 0.13 ± 0.48 ms |

Verdict: the web stack is sufficient. Timing resolution is three orders of
magnitude below human spread, and the app can remove its own click from the
mic well enough to detect a pad 20+ dB quieter than the click.

Two detector bugs found on real audio and fixed: the noise floor was a running
mean (now a minimum tracker), and decaying tails could re-trigger after the
refractory period (now a 6 dB rise within 3 ms is required).

`node analyze.mjs recordings/<run>.json` replays a downloaded run offline.

## What's inside

- `dsp.js` — click synth, calibration analysis, template subtractor, notch,
  onset detector, and `ProbeEngine`, the per-sample loop.
- `worklet.js` — AudioWorklet wrapper; the engine runs on the audio thread.
- `index.html` — UI and main-thread analysis.
- `test.mjs` — `node test.mjs` drives the engine through a synthetic room
  (31 ms loopback, reflections, tail, noise, synthetic pad hits).

## Known limits of the probe

- The template assumes the room is linear and static. Moving the laptop or
  changing volume needs a recalibration.
- "Click arrival" is the best-overlap point of the correlation, not the first
  wavefront; a constant bias of a fraction of a millisecond is expected.
- The onset detector is a plain envelope follower: good for a pad, untested on
  a full kit.
