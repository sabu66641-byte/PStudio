# PStudio Visual Compensation System — Foundation

**Status:** Merged into `main` via PR #126 (Analysis Mode foundation only).  
**Integrated commit:** `48599f90db4c5ea3cf6996317e0966d6b7c91ddf`  
**Sky lock:** `6b973a50c781f7fb2ea24fdffeb24d0d482556a9` — preserve the Nov 24 authored day/dusk/night panorama as the single visible sky and PMREM/IBL source.

## Scope

The foundation establishes:
1. Reuse of renderer telemetry for frame intervals, CPU render submission, valid/fresh WebGL2 GPU timer-query samples, draw calls, triangles, renderer resource counts and estimated resource memory.
2. Opt-in CPU stage timing around selected render calls.
3. A bounded Visual Compensation Graph (VCG) with explicit stage dependencies.
4. Caller-driven RGBA image and aligned temporal-sequence comparison helpers.

PVCS is currently **Analysis Mode only**. Monitoring is disabled by default. It does not automatically change quality presets, render resolution, reflection cadence, GI cadence, cloud/fog steps, shader settings, sky assets or the production render backend.

## Measurement boundaries

The WebGL2 GPU timer query measures the combined render section: it begins before the water depth prepass and planar mirror reflection, and ends after the main scene/composer render. It excludes the later Dynamic GI CubeCamera capture. This is an aggregate frame-render measurement, not a per-pass GPU breakdown.

The renderer's manual statistics reset occurs before the depth/reflection passes, and `renderer.info.autoReset=false` allows render counters to accumulate through the render section. The captured draw-call and triangle counts are therefore aggregate counts, not per-pass attribution.

The stage profiler uses `performance.now()` around synchronous calls. These are CPU elapsed/submit measurements, not GPU execution time. Dynamic GI is wrapped with asynchronous elapsed-time measurement; this can include waiting and must not be interpreted as CPU execution or GPU time.

PStudio resource accounting estimates resource memory; it is not driver-reported physical VRAM. A frame interval includes browser scheduling and is not pure CPU execution time. The current PVCS `frame-loop` record uses CPU render-submission time, which is the render section rather than the full `drawFrame` callback.

## Initial stages

- environment-state-update
- clustered-lighting
- water-depth-prepass
- mirror-reflection
- post-processing
- scene-render
- webgpu-render-submit (CPU submission timing)
- dynamic-gi-capture (asynchronous elapsed timing)

The current graph primarily ranks CPU P95 and does not yet offer a per-stage GPU breakdown or fair cross-domain ranking of CPU, GPU, async and memory pressure. The WebGPU path must report GPU timing as unavailable until a supported timestamp-query path is implemented; CPU submission must never be substituted for GPU time.

## Visual Difference Evaluation

`compareRgbaFrames` accepts two caller-supplied, equal-sized 8-bit RGB/RGBA buffers. It reports normalized mean absolute error, RMSE, luminance error, changed-pixel ratio and maximum channel difference. `compareTemporalSequences` reports basic aligned frame-to-frame pixel-delta mismatch.

These are reproducible baseline metrics, not yet a validated perceptual metric, optical-flow analysis or universal flicker detector. Frames are compared only when explicitly supplied by the caller; there are no automatic framebuffer readbacks in the live render loop.

## Cause analysis and next roadmap

See [PVCS Cause Analysis and Implementation Roadmap](PVCS_CAUSE_ANALYSIS_AND_ROADMAP.md). It distinguishes source-confirmed cost structures from unverified real-device hypotheses, specifies measurement boundaries, and sets Phase 0 (decision-grade instrumentation) as the next implementation task.

## Validation and rollback

- PVCS monitoring is off by default; automatic quality actuation is not implemented.
- Backup branch: `backup/pre-pvcs-sky-20261124-20261128` retains the pre-PVCS main snapshot.
- Source-level hypotheses are not physical-device bottleneck measurements. Browser visual checks and named-device profiling remain required.
- Keep the Nov 24 sky baseline unchanged during PVCS instrumentation and early optimisation work.
