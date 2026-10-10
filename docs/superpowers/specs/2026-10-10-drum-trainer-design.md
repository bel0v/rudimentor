# Drum Rudiment Precision Trainer — Design (iteration 1)

Date: 2026-10-10
Status: draft for review

## 1. Purpose

A browser app that plays a click, listens to a practice pad through the
laptop microphone, and scores how precisely the learner hits a rhythmic grid.
Iteration 1 scores timing only. Dynamics (even volume, deliberate accents) and
a rolling guitar-hero view are later iterations on the same engine and
analyzer.

Feasibility was proven by the spike in `spike/` on 2026-10-10 (MacBook,
built-in speakers and mic, Chrome): click-arrival jitter 0.01 ms, 27 dB
cancellation of the app's own click, 16 of 16 pad hits detected at −25 dBFS,
real-time onsets within 0.5 ms of an independent offline pick. See
`spike/README.md` for the full table. The spike is throwaway; its `dsp.js` is
the reference for the engine's DSP.

## 2. Requirements and constraints

Stated by the owner:

- Works without headphones. The click plays from the speakers; the app
  subtracts its own click, tail included, from the mic signal.
- Hits are judged against a virtual grid, not the nearest click. At one tempo
  the learner may play quarters, eighths, triplets or sixteenths, and may
  switch between them mid-exercise without that being an error.
- Instant feedback while playing.
- Per-session analysis and history, so progress can be tracked.
- Local-first. All data lives on the device. A backend may be added later
  only to store data off-device; it must not be required.
- Single learner for now, more later, without rewriting the analysis.
- Calibration is one button. Ending a session releases the microphone.
- Wired or built-in audio only. Bluetooth is detected where possible and
  warned about; it is not supported.

Non-goals for iteration 1: sticking verification (the mic cannot tell hands
apart; sticking is display only), dynamics scoring, rhythm patterns with
rests, accounts, sync, mobile layout.

## 3. Architecture

Four units with one-way dependencies: UI → Store, UI → Analyzer, UI → Engine.
Engine and Analyzer do not know about each other; the UI wires engine events
into the analyzer.

```
┌─────────────┐  events   ┌──────────────┐  results   ┌───────┐
│ Audio engine│ ────────▶ │   Analyzer   │ ─────────▶ │ Store │
│ (worklet)   │           │ (pure TS)    │            │ (IDB) │
└─────────────┘           └──────────────┘            └───────┘
        ▲                        ▲                        ▲
        └──────────── React UI ──┴────────────────────────┘
```

Tooling: Vite, TypeScript, React, Vitest, Playwright. The engine and analyzer
are plain TypeScript modules with no React or DOM imports.

Directory layout:

```
src/
  engine/      worklet processor, DSP core, EngineClient (main-thread facade)
  analyzer/    grid, assignment, running stats, summaries
  store/       Repository interface, IndexedDB implementation, migrations
  ui/          React screens and components
  presets/     shipped exercises
spike/         throwaway probe, kept for reference and offline analysis
```

## 4. Data model

All persisted records have a UUID `id`, `createdAt` and `updatedAt` ISO
timestamps, and a `schemaVersion`. Records are append-mostly; a future sync
layer replays them to a server unchanged.

**Exercise**

| field | type | notes |
|---|---|---|
| name | string | e.g. "Single strokes 100 bpm 16ths" |
| bpm | number | click tempo |
| beatsPerBar | number | default 4 |
| bars | number | scored bars, excluding count-in |
| countInBars | number | default 1; clicks play, hits recorded, not scored |
| grid | 1 \| 2 \| 3 \| 4 | finest subdivision per click that counts as on time |
| expect | 'all' \| 'any' | `all`: every grid slot expected, empty slot is a miss. `any`: empty slots are never errors |
| sticking | string? | display only, e.g. "RLRL" |
| preset | boolean | shipped with the app, not editable |

A different tempo or grid is a different Exercise record, so history is per
tempo, which matches how rudiments are practised. Timing tolerance is a global
setting, not an exercise field, so history remains comparable when tightened.

**Session**

| field | type | notes |
|---|---|---|
| exerciseId | id | |
| exercise | Exercise snapshot | frozen copy of the parameters used |
| startedAt / endedAt | ISO | |
| calibration | CalibrationSnapshot | loopback delay ms, jitter ms, click level dBFS, cancellation dB, hit level dBFS, threshold dBFS, sample rate |
| toleranceMs | number | global setting at the time |
| summary | Summary | see below |
| completed | boolean | false if stopped early |

**HitResult** (one per scored grid slot that was played, plus one per extra hit)

| field | type | notes |
|---|---|---|
| sessionId | id | |
| slot | number \| null | index on the fine grid from the first scored bar; null for an extra hit |
| bar, beat, sub | numbers? | derived from slot, stored for querying |
| expectedSample | number \| null | grid line time, audio-clock samples |
| actualSample | number \| null | null for a miss (only in `all` mode) |
| deltaMs | number \| null | actual − expected |
| levelDbfs | number \| null | |
| kind | 'hit' \| 'miss' \| 'extra' | |
| countIn | boolean | true for hits during count-in bars; excluded from the summary |

**Summary** (stored on Session, derived from HitResults)

| field | meaning |
|---|---|
| hits, misses, extras | counts |
| meanMs, sdMs | of deltas over hits |
| inToleranceShare | hits with abs(delta) ≤ tolerance / hits |
| driftMsPerBar | slope of delta vs slot, rushing (negative) or dragging |
| densityPerBar | filled slots per bar, labelled by nearest subdivision |

**Settings** (single record): toleranceMs (default 20), clickFrequencyHz
(default 4000), clickGain, debug flags.

## 5. Audio engine

A port of the spike's DSP into an AudioWorklet processor, plus a main-thread
`EngineClient` that owns the AudioContext, the mic stream and the worklet node
and exposes a typed event emitter.

**Lifecycle**

1. `start()`: create the AudioContext (`latencyHint: 'interactive'`), load
   the worklet module, request the mic with echoCancellation,
   noiseSuppression and autoGainControl all false and channelCount 1, connect
   mic → worklet → destination. Report device settings, including whether the
   browser honoured the processing flags.
2. `calibrate()`: one call that runs both steps and reports progress events:
   - silence step: 16 clicks at 400 ms, learn loopback delay, jitter, click
     level, and the subtraction template as in the spike;
   - hit step: prompt the learner to hit the pad five times with no click;
     median hit level sets the detection threshold at hitLevel − 15 dB,
     clamped to at least 10 dB above the measured click residual and never
     below −45 dBFS.
   Returns a CalibrationSnapshot.
3. `startExercise({ bpm, totalBars, beatsPerBar })`: schedules clicks on the
   audio clock; emits `click` for each.
4. `stop()`: stops the click, keeps audio open for another exercise.
5. `close()`: stops everything, stops every mic track, closes the
   AudioContext. The "End session" button calls this.

**Events** (all timestamps are audio-clock sample indices)

- `calibration-progress { step, done, total }`
- `calibrated { snapshot }`
- `click { emittedSample, arrivalSample }` — arrival = emission + loopback delay
- `hit { sample, levelDbfs }`
- `level { peakDbfs }` at ~20 Hz for the input meter
- `health { clickIndex, residualDbfs, alignmentMs }` per click
- `error { message }` for device loss or worklet failure

**DSP changes relative to the spike**

- Self-aligning subtraction: for each click the worklet re-locates the click
  with the quadrature correlation over a ±4 ms window around the expected
  arrival and shifts the template by the measured offset before subtracting
  it. Calibration sets the starting offset. Because subtraction must happen as
  samples arrive, the shift measured on click k applies to click k+1; the
  health event reports both the measured offset and the residual so the UI can
  prompt a recalibration if alignment exceeds 0.5 ms or residual rises above
  the threshold margin.
- Onset detector as fixed during the spike: minimum-tracking noise floor,
  6 dB rise within 3 ms required, 40 ms refractory, hysteresis re-arm.
- Threshold set from the hit step, not a slider. A debug panel keeps manual
  override.

Known limits carried forward: linear and static room assumption, so moving the
laptop or changing volume requires recalibration; the UI prompts via health
events rather than guessing.

## 6. Analyzer

Pure functions and one incremental class, no audio or DOM.

**Grid.** Bar 1 beat 1 is anchored at the arrival of the first click after the
count-in. Each subsequent click re-anchors its own beat at its own arrival, and
fine grid lines are interpolated between consecutive clicks using the nominal
period, so the grid follows the actual click timeline.

**Assignment.** Each hit goes to the nearest fine grid line. If that line is
already taken, the closer hit keeps it and the other becomes `extra`. A hit
whose distance to the nearest line exceeds half the fine step is impossible by
construction; a hit farther than the tolerance is still a `hit` with a large
delta, not an extra, so the learner sees how far off it was. In `any` mode an
unplayed line is ignored. In `all` mode it becomes a `miss` once its time has
passed by more than the tolerance plus 50 ms, so the live view can mark it
promptly without racing a late hit.

**Count-in.** Hits during count-in bars are recorded with `slot = null` and
`kind = 'extra'` but flagged `countIn: true`, and excluded from the summary.

**Running stats.** Welford mean and variance, in-tolerance count, least-squares
slope of delta over slot, and per-bar filled-slot count labelled with the
nearest subdivision name (quarters, eighths, triplets, sixteenths, or mixed).
All updated per hit so the live readout never recomputes.

**Session end.** `finish()` returns HitResults and Summary for the store. A
session stopped early is marked `completed: false` with stats over the played
bars.

## 7. UI flow

Four screens, React, state held in a small app store (context + reducer);
engine and analyzer instances live outside React and are injected.

1. **Setup.** One primary button, "Calibrate". It starts audio, requests the
   mic, runs the silence step with a "stay quiet" prompt and progress, then the
   hit step with a "hit the pad 5 times" prompt and a counter, then shows a
   verdict: jitter, cancellation, hit level, each with a plain OK/warning, and
   the device line. Warnings: Bluetooth device, processing flags not honoured,
   click barely audible to the mic, hits too quiet. "Recalibrate" is the same
   button again. "End session" closes audio and returns to this screen.
2. **Exercise picker.** Presets (single strokes, double strokes, paradiddle
   stickings at a few tempos; each is just bpm, grid, sticking) and a custom
   form. Each row shows its last three summaries inline.
3. **Play.** Count-in indicator, then a static strip for the current bar with
   one marker per fine grid line; markers fill on hit, coloured by delta
   (green within tolerance, amber within 2×, red beyond), hollow for a miss in
   `all` mode. Below: running mean, SD, in-tolerance share, density label.
   Stop ends early; the exercise auto-stops after its bars. A health banner
   appears if the engine reports drift or residual problems.
4. **Report and history.** Session report: summary tiles, delta histogram,
   per-bar density, per-slot table. History per exercise: mean, SD and
   in-tolerance share over sessions as line charts, plus an overview listing
   every exercise with its latest and best in-tolerance share. Export and
   import of the whole store as JSON.

## 8. Store

`Repository` interface with methods for exercises, sessions, hit results and
settings, plus `exportAll()` / `importAll()`. One implementation on IndexedDB
through the `idb` wrapper, with a versioned schema and a migrations table.
Hit results are stored per session in one record array to keep writes cheap
and reads simple; the history view only reads Session summaries. A future
`SyncingRepository` can wrap the local one and push records by `updatedAt`.

## 9. Testing

- **DSP core**: Vitest, the spike's synthetic room ported to TypeScript:
  calibration accuracy, cancellation depth, zero false hits, hit timing within
  1 ms, subdivision grid, controls without the layers, self-alignment after an
  injected 2 ms stream shift.
- **Analyzer**: Vitest with synthetic event streams: perfect playing,
  consistent rushing, subdivision switch in `any` mode, double hit, missed
  beat in `all` mode, hit between lines, early stop, count-in exclusion.
- **Store**: Vitest with `fake-indexeddb`: round trips, migrations,
  export/import.
- **End to end**: one Playwright test in Chromium with a fake mic that loads
  the app, calibrates (the fake mic yields a poor but completed calibration),
  runs a four-bar exercise, and checks that a session record exists.
- **Real room**: manual, using a debug recording export identical to the
  spike's and `spike/analyze.mjs` for offline replay.

## 10. Implementation order

1. Project scaffold, engine DSP port with tests.
2. EngineClient with calibration flow and events, exercised by a bare debug page.
3. Analyzer with tests.
4. Store with tests.
5. Setup and Play screens.
6. Report and History screens, presets, export/import.
7. Playwright smoke test.

## 11. Open points

None blocking. Two decisions deferred to later iterations: automatic
subdivision inference (not needed while `any` mode judges against the fine
grid) and the rolling view (consumes the same analyzer output).
