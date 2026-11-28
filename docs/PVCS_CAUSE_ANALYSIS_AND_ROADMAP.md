# PVCS Cause Analysis and Implementation Roadmap

**Status:** Static source audit complete. Phase 0 instrumentation corrections are under validation on this Draft PR branch; physical-device bottleneck ranking and visual review remain pending.  
**Main baseline:** `48599f90db4c5ea3cf6996317e0966d6b7c91ddf` (PVCS foundation merged from PR #126).  
**Sky constraint:** Preserve the Nov 24 authored sky state at `6b973a50c781f7fb2ea24fdffeb24d0d482556a9`. Do not use PVCS work as a reason to modify sky assets, sky composition, or sky cache keys.

## 1. Decision

Do not begin automatic quality reduction or visual compensation yet.

The Phase 0 implementation on this branch adds full `drawFrame` CPU timing, separate CPU render-submission measurements, CPU timings for world/occlusion/instance work and individual composer passes, sparse non-nested WebGL2 GPU render-path sampling, frame-start context metadata and independent CPU/GPU/async/memory-domain rankings that do not compare unlike contexts. The WebGPU path continues to report GPU timing as unavailable. See [PVCS Foundation](PVCS_FOUNDATION.md) for the precise limits and measurement boundaries.

The source audit identifies several high-priority cost candidates. These are code-backed reasons to measure them, **not proof that any one candidate is the dominant bottleneck on a real device**.

## 2. What the current measurements actually mean

| Metric | Current meaning | Boundary |
|---|---|---|
| Frame interval | Time between successive `drawFrame` starts | Includes browser scheduling and other delays; it is not pure CPU execution time. |
| CPU render submission | CPU wall time from the start of the WebGL render section through depth, reflection and main composition/direct render | Does not include earlier frame preparation such as GENESIS/environment and clustered-light updates. |
| WebGL2 GPU timer | One asynchronous `EXT_disjoint_timer_query_webgl2` measurement around the render section | It starts before water depth and mirror reflection, and ends after the main render/composer. It therefore includes those render passes. It excludes the later Dynamic GI CubeCamera capture. It is frame-wide, not per-pass. |
| Renderer draw/triangle counters | Counters accumulated with `renderer.info.autoReset=false` | Reset before water depth/reflection and read after the main render, so they cover those render calls in aggregate. They do not identify which pass generated each draw. |
| PVCS stage measurements | `performance.now()` around selected synchronous calls | CPU-side elapsed/submit time only; not isolated GPU execution time. |
| Dynamic GI async elapsed | Promise wall-clock duration around the capture service | Useful for finding intermittent stalls, but it is not GPU time and may include asynchronous waiting. |
| Resource memory | PStudio resource-registry estimates plus browser-visible heap data | Not driver-reported physical VRAM or total device memory pressure. |

**Implementation correction on this branch:** the `frame-loop` node now records the full `drawFrame` CPU callback separately from `cpuRenderSubmitMs`. Graph ranking is partitioned by resource domain; a CPU P95 is never compared directly with a GPU duration, asynchronous elapsed duration or memory estimate.

The WebGPU stage currently exposes CPU render-submit timing in PVCS. PVCS does not yet expose per-stage WebGPU timestamp-query results. Unsupported GPU timing must remain explicitly unavailable; CPU submission must never be relabelled as GPU time.

Relevant code:
- [PVCS stage registration and measurement](../static/pstudio_pvcs.mjs#L4)
- [PVCS frame-root recording and ranking entry point](../static/pstudio_pvcs.mjs#L119)
- [Context-aware resource-domain ranking](../static/pstudio_visual_compensation_graph.mjs#L190)
- [Renderer timing/counter collection](../static/pstudio_3d_engine.js#L1490)
- [Render-section GPU timer boundaries](../static/pstudio_3d_engine.js#L1784)

## 3. Source-audit cost candidates

### A. Full-screen atmospheric and screen-space effects — highest GPU investigation priority

The High, Maximum and Ultra profiles enable AO, SSR, volumetric clouds, atmosphere/fog and contact shadows (where the corresponding pass is available). The custom volumetric cloud shader uses a variable ray-march loop with up to 64 view steps and up to 3 light-density samples per view step. Its density function evaluates several procedural 3D-noise terms. Volumetric fog uses up to 32 view steps; contact shadows use up to 32 depth samples; God Rays use 20 texture samples per output pixel. Composer targets follow the renderer's effective pixel ratio.

Why this matters: full-screen pixel cost grows with output pixel count, and the ray-march/sample work is repeated for many pixels. A high render ratio combined with several active passes can multiply GPU work.

Measure separately:
- Per-effect enabled state, actual buffer dimensions and effective pixel ratio.
- GPU time for the active full composer/direct render path; CPU submission per individual pass separately. Do not describe composer-subpass GPU timing as available yet.
- Cloud/fog/contact-shadow step counts and AO/SSR quality settings.
- Number of active full-screen passes and their internal render-target scales.

Candidate treatments:
- Give each effect its own render scale instead of lowering the whole scene resolution.
- Test half- or quarter-resolution cloud/fog/contact-shadow buffers with depth-aware upsampling.
- Add temporal accumulation/reprojection only with rejection on camera, lighting, depth or scene changes; preserve disocclusion handling to avoid ghosting.
- Use early-outs and reduced sampling where the pixel contributes little, while keeping important silhouettes and high-contrast regions stable.
- Evaluate AO, SSR, cloud, fog and contact shadows independently before combining or fusing passes.

Do not disable all premium effects as a blanket fix. Visual Difference Evaluation must determine which lower-cost representations preserve the important appearance.

References: [cloud shader](../static/pstudio_environment_fx.js#L898), [contact shadow shader](../static/pstudio_environment_fx.js#L1037), [God Rays shader](../static/pstudio_environment_fx.js#L1123), [fog shader](../static/pstudio_environment_fx.js#L1159), [quality profiles](../static/pstudio_3d_engine.js#L273).

### B. Planar mirror reflection — highest additional-scene-render investigation priority

The reflection path collects every visible mirror-water mesh. On an eligible refresh, it renders the scene from a reflected camera once per mirror. If volumetric clouds are active, it also runs a cloud composite for each mirror. The target follows the drawing-buffer dimensions multiplied by the mirror scale. A frame-budget controller can reduce cadence and resolution, but the source path still performs a full scene render for each refreshed mirror.

Measure separately:
- Visible mirror count, refreshed mirror count and skipped count.
- Per-mirror target dimensions and pixels.
- Reflected scene render time versus reflected cloud-composite time.
- Camera motion, mirror-plane movement, lighting/environment changes and the interval between refreshes.

Candidate treatments:
- Cache the last valid reflection and refresh only when the reflected view is materially dirty.
- Prioritise mirrors by projected screen area, view angle and visual importance; avoid spending equal work on tiny/off-screen reflections.
- Derive each reflection target size from its projected pixel footprint, bounded by device memory and texture limits.
- Stagger multiple mirrors across frames rather than refreshing all of them together.
- Use temporal reuse only when camera/plane/environment changes are small enough; invalidate history on large changes.

Preserve the main water-mirror identity and reflection direction. Do not replace the signature water reflection with a generic blur or tint.

Reference: [Mirror Water reflection path](../static/pstudio_3d_engine.js#L1211).

### C. Water depth prepass — high additional-pass investigation priority

When water materials, volumetric fog, volumetric clouds or contact shadows need scene depth, the engine resizes a depth target to the full drawing-buffer size, traverses the scene to hide unsupported/irrelevant objects, and performs an additional scene render with a depth override material.

Measure:
- Whether the prepass ran and which feature required it.
- Target dimensions, visible mesh count and hidden/omitted mesh count.
- CPU traversal time and GPU depth-render time.
- Which downstream passes actually consumed the depth texture.

Candidate treatments:
- Keep one canonical depth source for compatible water and screen-space effects rather than generating duplicate depth work.
- Investigate using the main render target's depth attachment where lifetime, camera and depth semantics match.
- Consider a depth pyramid or reduced-resolution depth for fog/cloud/contact-shadow consumers; retain full-resolution depth where water edge/thickness accuracy needs it.
- Cache visibility classifications and avoid repeated name/material inspection where scene structure has not changed.

A reflected camera has a different view/depth, so its depth data cannot be assumed reusable from the main camera.

Reference: [water depth prepass](../static/pstudio_3d_engine.js#L1052).

### D. CPU-side clustered lighting — high CPU investigation priority

The clustered-light update scans dynamic point lights, updates world transforms, constructs a signature, and may rebuild cluster data and upload light/cluster textures. The update is throttled to at most roughly 10 Hz when the signature is stable, but light/camera signature construction still happens before the early-return check.

Measure:
- Dynamic point-light count and number of clusters with lights.
- Time spent gathering/transformation/signature versus cluster assignment.
- Whether the signature changes each frame during camera or light motion.
- Texture-upload and material-update counts.

Candidate treatments:
- Use explicit dirty flags/version counters for camera and light changes instead of reconstructing a long string signature on every frame.
- Reuse typed arrays and sets instead of allocating them during each rebuild.
- Separate static from dynamic lights; update only dirty light records and affected clusters where correct.
- Coalesce texture uploads and update material uniforms only when their effective values change.

Reference: [clustered lighting update](../static/pstudio_3d_engine.js#L3013).

### E. World visibility, LOD and occlusion — interaction-time CPU investigation priority

World visibility is updated on camera changes. It visits mesh/model instances, applies distance/LOD and streaming requests, invokes the occlusion path, then rebuilds instance-batch transforms. The occlusion path is throttled to 180 ms and tests up to eight candidates per update, but each raycast can inspect scene objects.

This may present as camera-movement hitching rather than a constant GPU frame cost.

Measure:
- Number of mesh/model/batch candidates.
- Time in frustum/distance/LOD, streaming requests, occlusion raycasts and instance-matrix rebuild.
- Number of raycast intersections and geometry BVH readiness.
- Frame interval spikes aligned with camera input.

Candidate treatments:
- Add a broad-phase spatial structure before raycasts and reuse existing geometry BVHs.
- Cache bounds and owner/chunk membership; rebuild only on relevant transforms or membership changes.
- Mark instance batches dirty and update only batches whose sources changed.
- Budget visibility/occlusion work across frames without hiding nearby or selected content incorrectly.

References: [occlusion update](../static/pstudio_3d_engine.js#L2757), [world visibility update](../static/pstudio_3d_engine.js#L3125), [camera update call site](../static/pstudio_3d_engine.js#L3280).

### F. Dynamic GI probe capture — intermittent frame-pacing investigation priority

Dynamic GI processes one dirty probe at a time, but a capture creates a CubeCamera and calls `cube.update(captureRenderer, scene)` before SH extraction. The capture uses preset-dependent resolutions (64/96/128/192). It runs after the main GPU timer and render counters have been closed, so it is deliberately excluded from those main-render metrics.

Measure:
- Capture start/end, resolution, probe index and dirty-probe count.
- Cube capture duration separately from SH extraction/blending and scene visibility preparation.
- Frame interval p95/p99 before, during and after captures.
- Whether the capture occurs during camera movement or other heavy updates.

Candidate treatments:
- Skip or defer capture during camera motion, high frame time or a busy upload/compilation window.
- Prioritise probes by distance to camera, recent light changes and likely visible contribution.
- Time-slice capture work across frames where a consistent scene snapshot can be preserved; publish only after a complete valid capture.
- Reuse unchanged probe data and retain the last valid coefficients until replacement data is ready.

Reference: [Dynamic GI capture service](../static/pstudio_3d_engine.js#L2466).

### G. Pixel ratio and shadow maps — device-budget investigation priority

High requests a pixel ratio of 2 and a 3072 shadow map; Maximum requests 2.1 and 4096; Ultra requests a substantially higher output target and up to an 8192 shadow map before device/memory caps. Actual values are constrained by device pixel ratio, memory mode, texture limits and adaptive settings.

Measure actual drawing-buffer width/height, render pixel ratio, shadow-map dimensions, cascade count, shadow-caster count and shadow update frequency. Do not infer actual cost from preset names alone.

Candidate treatments:
- Allocate a per-device pixel budget and a separate shadow texel budget.
- Adjust shadow coverage/cascade distribution and update cadence based on projected shadow error and caster movement.
- Reuse static shadow maps when neither relevant casters nor lights move.
- Make changes only after isolating shadow cost from screen-space and reflection cost.

References: [quality profiles](../static/pstudio_3d_engine.js#L273), [effective pixel-ratio selection](../static/pstudio_3d_engine.js#L321), [shadow-map caps](../static/pstudio_3d_engine.js#L305).

### H. Shader compilation and texture upload — cold-start investigation

PStudio already stages model texture uploads across animation frames and uses asynchronous shader compilation when supported. GLTF parsing also has worker-based preparation. This is a less likely explanation for a steady-state frame-rate problem, but it can explain first-open, first-material or first-use stutters.

Measure cold-start and warmed runs separately. Do not redesign the existing preparation path without evidence of a remaining stall.

## 4. PVCS implementation and validation sequence

### PVCS Step 0 — Decision-grade instrumentation (implemented on PR #127 branch)

The branch implementation adds:
1. Full `drawFrame` callback CPU duration, separate from render-section CPU submission and frame interval.
2. CPU stages for camera/environment preparation, clustered lighting, world visibility, occlusion, instance-batch rebuild, water depth, planar reflection, per-mirror scene rendering and cloud composition.
3. CPU instrumentation around individual EffectComposer passes when the pass exposes a render method: source, TAA/SMAA, GTAO/SSAO, SSR, contact shadows, bloom, volumetric fog/clouds, God Rays and output.
4. Sparse WebGL2 GPU render-path sampling. One analysis frame in four samples the active full EffectComposer path or the direct scene-render path; the aggregate timer is omitted on that frame, so elapsed queries do not nest. Individual composer sub-passes remain CPU-only. Query results are polled without blocking.
5. Disjoint query results are discarded and invalidate the previous aggregate GPU sample. Stale query results are discarded.
6. Frame-start context metadata for backend, scene label, quality preset, render dimensions, pixel ratio and selected effect flags. History is partitioned by context (up to eight recent contexts per node), with a shared context per frame.
7. Separate graph metrics and rankings for CPU frame, CPU stages, GPU frame, GPU stages, async elapsed and estimated memory. Each metric exposes its sample count; rankings compare only samples from the same context.
8. Regression tests for domain separation, explicit unavailable values, renderer backend attribution and composer instrumentation.

Known boundaries:
- WebGPU per-stage GPU timing remains unavailable; there is no CPU-to-GPU relabelling.
- WebGL2 GPU render-path sampling is intentionally sparse; the target is the active composer or direct-render path. The per-effect composer sub-passes are not yet individually GPU-timed.
- Composer CPU stage measurements are nested within the overall composer timing; they are diagnostic and must not be added to the parent duration. The overall composer GPU query is a single non-nested measurement.
- Mirror count/target size and shadow-map dimensions are not yet in every sample context.
- Physical-device measurements and visual review have not been performed by CI.

### PVCS Step 1 — Controlled baseline on real hardware

Use a fixed camera path and repeatable scene state. Warm up first, then take at least three runs with enough samples for p50/p95/p99.

Required cases:
- Static scene with no camera movement.
- Standard camera movement through the shrine.
- Water/reflection scene.
- High/Maximum/Ultra effect stack, where the device can safely run it.
- Day, dusk and night environment states.
- Dynamic GI off versus on.
- Cold load versus warmed steady-state.

Capture CPU frame time, CPU render submission, GPU frame time, pass timings, frame interval, draw calls, triangles, memory estimates and actual render dimensions. A source-code audit cannot replace this device run.

### PVCS Step 2 — Fix the measured bottlenecks one at a time

For each candidate:
1. Record a baseline with the fixed test path.
2. Change one subsystem only.
3. Run the same test path and compare p50/p95/p99 plus visual output.
4. Keep the change only if the relevant CPU/GPU bottleneck improves and visual/temporal quality remains within the agreed tolerance.
5. Keep each subsystem change isolated so it can be reverted independently.

Start with the subsystem that consumes the largest repeatable share of the real-device frame budget—not the subsystem that looks most complicated in source code.

### PVCS Step 3 — Strengthen Visual Difference Evaluation

Keep the current RGBA MAE/RMSE and aligned temporal-delta metrics as simple diagnostics. Add a more robust comparison path that accounts for:
- Matching camera, resolution, color space, exposure and scene time.
- Luminance/chroma and edge/structure changes, not only raw channel averages.
- Spatially weighted error around silhouettes, water boundaries, fine foliage and other visually important regions.
- Temporal stability during camera movement, lighting transitions and disocclusion.

Treat this as a benchmark/capture tool. Do not add automatic framebuffer readbacks to the live render loop.

### PVCS Step 4 — Build the actual Visual Compensation Graph allocator

Only after Phases 0–3:
- Attach measured CPU/GPU cost, memory cost, visual impact, temporal stability, update frequency and stage dependencies to each candidate.
- Evaluate multiple alternatives (for example, lower pass resolution, lower sample count, slower refresh, cached result, or a different approximation).
- Build a Pareto/utility selection that considers quality gained per millisecond and penalises flicker, ghosting and important-detail loss.
- Select actions by bottleneck domain: lower pixel cost for GPU-bound work; reduce traversal/rebuild frequency for CPU-bound work; stagger captures for intermittent work; manage target/cache sizes for memory pressure.
- Keep automatic actuation opt-in, bounded, reversible and hysteretic. Never infer an unavailable GPU metric from CPU time.

### PVCS Step 5 — Integration and release gates

- Run the existing Python/C++/JavaScript regression suites.
- Validate WebGL2 and WebGPU separately; never assume one backend's timing represents the other.
- Compare before/after fixed-path captures and temporal sequences.
- Confirm no sky asset, sky panorama, environment preset or sky cache-key regression.
- Keep rollback to a known-good main commit available.

## 5. Acceptance criteria

A compensation candidate is accepted only when:
- The measured resource domain is known (CPU, GPU, asynchronous scheduling or memory).
- The same reproducible workload shows a repeatable improvement in the relevant p95/p99 metric.
- Visual Difference Evaluation shows no unacceptable loss in the high-importance regions.
- Temporal tests show no unacceptable flicker, ghosting or stale-reflection artifacts.
- No unrelated feature, sky state or backend behavior regresses.
- A candidate can be disabled or reverted independently.

## 6. Immediate next task

Review PR #127 and retain the instrumentation changes only while the full repository CI remains green. Then collect a controlled baseline on the target Android/browser device and any available desktop reference. The device run must capture p50/p95/p99 for frame interval and CPU/GPU domains, and compare the same shrine scene and camera path before changing reflection cadence, depth resolution, cloud samples, shadow maps or quality defaults.

The Phase 1 visual-identity specification is maintained separately in [PSTUDIO_VISUAL_IDENTITY.md](PSTUDIO_VISUAL_IDENTITY.md).
