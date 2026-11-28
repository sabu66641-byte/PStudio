# PStudio Visual Compensation System — Foundation

**Status:** Draft foundation / Analysis Mode only  
**Baseline:** main at cb0986d611b10c51efb1a59e136a996ec29096e3  
**Sky lock:** 6b973a50c781f7fb2ea24fdffeb24d0d482556a9 — the Nov 24 authored day/dusk/night panorama is restored as the single visible sky and PMREM/IBL source.

## Scope

This change establishes four foundations:

1. Reuse existing renderer telemetry for frame intervals, CPU render submission, fresh GPU timer-query samples, draw calls, triangles, renderer resource counts, and estimated resource memory.
2. Add opt-in CPU stage timing around existing render calls.
3. Represent render-stage dependencies and bounded measurements in Visual Compensation Graph (VCG).
4. Provide caller-driven image and aligned temporal-sequence comparisons.

PVCS remains **Analysis Mode**. It does not change quality presets, render resolution, reflection cadence, GI cadence, cloud/fog steps, shader settings, sky assets, or the production render backend.

## Existing telemetry and measurement boundaries

The current renderer already retains 120 samples for frame intervals, CPU render submission and GPU render timing. GPU timing is backed by EXT_disjoint_timer_query_webgl2 when the extension is available. Disjoint or stale samples are discarded / marked unavailable. The GPU metric is a whole-main-scene timer, not a per-pass breakdown. The CPU render metric is the elapsed CPU-side render submission path, not total application CPU time.

renderer.info provides draw-call, triangle, geometry and texture counters. PStudio resource accounting estimates GPU/CPU resource memory; it is not driver-reported physical VRAM. PVCS preserves those labels.

The optional stage profiler uses performance.now() around existing synchronous calls. Its measurements are CPU elapsed/submit time, not GPU execution time. It is disabled by default and stores a bounded history only when enabled. It adds no framebuffer readback and does not capture images automatically.

## Initial VCG stages

- environment-state-update
- clustered-lighting
- water-depth-prepass
- mirror-reflection
- post-processing
- scene-render
- webgpu-render-submit
- dynamic-gi-capture (registered as a stage; detailed asynchronous timing is not yet wired)

The WebGL2 and WebGPU paths are alternatives, not a single additive render path. The graph represents shared frame dependencies and path-specific stages.

## Visual Difference Evaluation

compareRgbaFrames accepts two caller-supplied, equal-sized 8-bit RGB/RGBA buffers. It reports normalized mean absolute error, RMSE, luminance error, changed-pixel ratio and maximum channel difference. compareTemporalSequences reports a basic aligned frame-to-frame pixel-delta mismatch.

These are reproducible baseline metrics, not a validated perceptual metric, optical-flow analysis, or universal flicker detector. Screenshots / pixel buffers are compared only when explicitly supplied by the caller. They are never read back automatically in the live frame loop.

## Current source-audit bottleneck hypotheses

These are **code-path hypotheses**, not measured rankings on a physical device. The stage profiler is required to establish real costs on each target browser/GPU.

| Suspect | Why it can be expensive | Safe investigation / possible treatment |
|---|---|---|
| Planar mirror reflection | Each refreshed mirror renders the scene from a reflected camera; resolution follows the drawing buffer and may include a cloud pass. | Record mirror count, target dimensions, refresh cadence and CPU submission time. Later evaluate per-mirror target scale/cadence, visibility bounds, and reuse of last valid reflection. |
| Water depth prepass | Can submit an additional scene render to provide depth for water and screen-space effects. | Record whether it ran, target size and time. Evaluate sharing depth only where the pipeline can guarantee compatible depth semantics. |
| Post-processing | Composer may run AO/GTAO, SSR, volumetric cloud/fog, contact shadows, god rays, TAA/SMAA and bloom. | Record active pass set and pass resolution. Test each pass in an isolated benchmark before changing defaults. |
| Clustered-lighting preparation | CPU traversals / cluster assignment can add CPU work as light count and scene complexity rise. | Measure the update call and cluster/light counts; cache stable cluster assignments and update only dirty data where correct. |
| Dynamic GI capture | Asynchronous probe work can contend for GPU time and frame pacing after the main render timer closes. | Measure capture duration and frequency separately; throttle / stagger captures only after observing impact. |
| GENESIS scene geometry and effects | The scene contains large instanced populations, detailed architecture, lighting and particles. Geometry cost, overdraw, shadow casters and material diversity can matter. | Correlate triangles, calls, instances, shadow casters and GPU time. Prefer batching, frustum/LOD culling, bounded particle work and texture reuse based on evidence. |
| Shader compilation / resource uploads | First-use compilation and texture uploads can cause spikes even when steady-state rendering is acceptable. | Separate cold-start from warmed runs; inspect compile and upload counters. Keep compilation and large transfers out of steady-state frame work. |

## Reference causes already addressed before PVCS

Commit 6b973a50 removed a duplicate GENESIS CanvasTexture sky overlay and its 80–125 ms periodic upload loop, restoring the Nov 24 authored panorama as the single visible sky / PMREM source. PVCS must not reintroduce that overlay or modify the authored sky files.

## Validation protocol

1. Use a fixed scene, camera, output size, DPR, render scale, quality preset, exposure, environment state and browser foreground state.
2. Warm up before sampling.
3. Record repeated foreground runs and compare p50/p95/p99 with sample counts.
4. Keep GPU timer results unavailable when unsupported, stale or disjoint. Never substitute CPU time for GPU time.
5. Compare image captures using matching dimensions, color space and camera path. Keep temporal captures aligned.
6. Repeat on named target devices / browsers. Source tests cannot establish physical-device GPU performance.

## Safety and rollback

- This work is isolated on feat/pvcs-foundation-20261128.
- A full pre-change snapshot is retained on backup/pre-pvcs-sky-20261124-20261128.
- All changes are additive or instrumentation-only; PVCS monitoring is off by default.
- No automatic quality changes are implemented in this foundation.
- Do not merge to main until the draft review, regression suite, browser image checks and real-device measurements pass.
