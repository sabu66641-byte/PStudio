# PStudio Visual Compensation System — Foundation

**Status:** Original analysis foundation merged into `main` through PR #126. Phase 0 instrumentation expansion is implemented on the Draft PR #127 branch; it is not yet merged into `main`.  
**Main baseline:** `48599f90db4c5ea3cf6996317e0966d6b7c91ddf`  
**Sky lock:** `6b973a50c781f7fb2ea24fdffeb24d0d482556a9` — preserve the Nov 24 authored day/dusk/night panorama as the single visible sky and PMREM/IBL source.

## Scope and safety

PVCS remains **Analysis Mode only**. Monitoring is disabled by default. It does not automatically change quality presets, render resolution, reflection cadence, GI cadence, cloud/fog steps, shader settings, sky assets or the production render backend.

The Phase 0 expansion changes instrumentation and analysis metadata only. It does not change scene appearance, quality defaults, sky assets, water shaders, rendering backend or automatic quality controls.

## Measurement domains

The graph keeps the following values independent:

- **CPU frame callback:** elapsed CPU wall time from entry to exit of the `drawFrame` callback, including synchronous setup, render submission and finalization. The timer is started only when PVCS monitoring is enabled; work performed before entering `drawFrame` is outside this boundary.
- **CPU render submission:** elapsed CPU-side render section. It is not the full application CPU cost and is not GPU execution time.
- **Frame interval:** start-to-start renderer callback interval. It includes browser scheduling and is not pure CPU execution time.
- **GPU frame:** aggregate WebGL2 `EXT_disjoint_timer_query_webgl2` time for the main depth/reflection/scene-or-composer render section.
- **GPU stage:** a selected WebGL2 render-path timer measured on one analysis frame in four. It times either the complete EffectComposer render path or the direct scene-render path, never an individual composer sub-pass. It is not nested with the aggregate timer.
- **Asynchronous elapsed:** wall-clock duration of the asynchronous dynamic GI capture path; it may include waits and must not be interpreted as CPU execution or GPU time.
- **Memory:** PStudio resource-registry estimates, not driver-reported physical VRAM.

CPU, GPU, asynchronous and memory rankings are produced separately. Values from different domains are never compared as though they shared units.

## Instrumented CPU stages

- camera-state-update
- environment-state-update
- clustered-lighting
- world-visibility
- occlusion-visibility
- instance-batch-rebuild
- water-depth-prepass
- mirror-reflection
- mirror-reflection-scene-render
- mirror-cloud-composite
- post-processing
- individual composer passes (source, TAA/SMAA, GTAO/SSAO, SSR, contact shadows, bloom, volumetric fog/clouds, God Rays and output)
- scene-render
- webgpu-render-submit
- dynamic-gi-capture (asynchronous elapsed)

Some parent and child stages are inclusive and overlap by design. Their durations are useful for identifying expensive areas, but **must not be added together** as a total frame cost.

## GPU timing boundaries

On WebGL2, the aggregate timer covers the main render section and excludes the later Dynamic GI CubeCamera capture. A separate GPU-stage query is sampled on one analysis frame in four. The target is selected from the render path that the current frame will actually execute: either the full EffectComposer call or the direct scene render. This avoids scheduling a query for an inactive/skipped pass. The aggregate query is omitted on those sampled frames, so `TIME_ELAPSED_EXT` queries are not nested. Query results are polled asynchronously; disjoint results and results older than the query timeout are discarded.

Individual composer sub-passes remain CPU-instrumented only. Their wrappers call the original render method directly while monitoring is disabled, without allocating a per-pass timing closure. A missing GPU sample means **unmeasured**, not zero. Per-effect GPU attribution requires a future query design with explicit pass activation and non-overlapping timing boundaries.

The current WebGPU path reports CPU submission time. It does not claim GPU frame or pass timings until a timestamp-query implementation is supported by the actual device and enabled. CPU submission must never be substituted for GPU time.

## Context and graph

Samples capture the available backend, scene label, quality preset, render dimensions, pixel ratio and selected effect flags. A frame-start context is shared by the samples recorded within that frame. Each graph node retains up to eight recent context buckets (least-recently-used eviction); percentile summaries and rankings never combine different backend/scene/quality/resolution/effect contexts. Rankings also identify the context and expose the sample count for the specific metric, so sparse samples are not mistaken for strong evidence.

The measurements are intended for comparisons under a fixed scene, camera, output size, color space, exposure and effect configuration. Source-code hypotheses are not proof of a real-device bottleneck.

## Visual Difference Evaluation

`compareRgbaFrames` accepts two caller-supplied, equal-sized 8-bit RGB/RGBA buffers. It reports normalized mean absolute error, RMSE, luminance error, changed-pixel ratio and maximum channel difference. `compareTemporalSequences` reports basic aligned frame-to-frame pixel-delta mismatch.

These are reproducible baseline metrics, not a validated perceptual metric, optical-flow analysis or universal flicker detector. Frames are compared only when explicitly supplied by the caller; there are no automatic framebuffer readbacks in the live render loop.

## Validation and rollback

- Monitoring remains off by default; automatic quality actuation remains absent.
- The Phase 0 code changes are isolated on PR #127's feature branch and must pass CI before merge.
- The pre-PVCS backup branch `backup/pre-pvcs-sky-20261124-20261128` retains the known-good pre-PVCS main snapshot.
- Browser visual checks and named-device profiling are still required before any visual/performance optimization or backend promotion.
- Keep the Nov 24 sky baseline unchanged during PVCS instrumentation and early optimization work.

## Related specifications

- [PVCS Cause Analysis and Implementation Roadmap](PVCS_CAUSE_ANALYSIS_AND_ROADMAP.md)
- [PStudio Visual Identity Specification — Reality 55 : Anime 45](PSTUDIO_VISUAL_IDENTITY.md)
