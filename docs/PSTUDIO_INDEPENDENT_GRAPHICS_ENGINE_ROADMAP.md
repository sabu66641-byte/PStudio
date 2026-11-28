# PStudio Independent Graphics Engine — Development Roadmap

**Roadmap version:** 1.6  
**Last updated:** 2026-11-28  
**Current status:** Phases 0–10 = 100%; Phase 11 = 65%; Phase 12 = 35%.  
**Progress policy:** Physical-device verification is not a completion axis. Use repository tests, static/module checks, API contracts, dependency audits and reversible integration. Never label an unrun hardware test as passed.

## Mission

Build a PStudio-owned, browser-first graphics engine with independent contracts and subsystem ownership. Preserve existing editor/gameplay APIs and rendering quality while migrating away from Three.js implementation ownership in controlled vertical slices. Browser deployment continues to use browser graphics APIs; native Vulkan, Direct3D 12 and Metal require a separate native runtime/platform.

## Non-negotiable rules

- Phase 0 is permanently **Foundation: 基盤強化・基盤整理・土台作り**.
- Keep the current production WebGL2 renderer available until a replacement passes compatibility and regression gates.
- Preserve the Nov 24 sky panorama baseline and signature water-reflection behavior.
- Keep Reality 55 : Anime 45 as the governing visual identity; it is not a numeric shader blend.
- Do not reduce quality defaults, disable premium effects or alter sky/water appearance to improve a benchmark.
- Separate CPU execution, CPU submission, GPU execution, async elapsed time and estimated memory. Missing measurements are unavailable, never zero.
- Keep changes additive, opt-in and independently reversible.
- Repository validation is the progress gate; physical-device checks do not block these phase percentages.

## Phase status

| Phase | Name | Progress | Scope |
|---:|---|---:|---|
| 0 | Foundation — 基盤強化・基盤整理・土台作り | **100%** | PVCS instrumentation, diagnostics, context separation, visual-difference utilities, regression coverage and documentation |
| 1 | Visual Identity — 視覚設計・品質契約 | **100%** | Reality 55 : Anime 45; physical/artistic/material/lighting/atmosphere/water requirements and visual evaluation contract |
| 2 | Graphics Architecture — 独立アーキテクチャ | **100%** | Contracts, HAL, Scene/View/Material/Resource/command-buffer types, WebGL2 and WebGPU adapters, loss/sync lifecycle, migration and compatibility tests |
| 3 | Graphics Core — 独自グラフィックスコア | **100%** | GPU resource lifecycle, WGSL compiler, compute dispatch, lighting/cluster buffers, PBR direct-light include, device recovery and independent GPU vertical slice |
| 4 | Render Graph — 描画依存グラフ | **100%** | Pass/resource graph, hazard scheduling, barriers, lifetimes, transient aliasing, GPU materialization, execution/cancellation/rollback and WebGPU queue submission |
| 5 | Native Renderer — ネイティブ描画基盤 | **100%** | C++17 native runtime, SDL3 Vulkan/D3D12/Metal graphics backends, buffers/textures, vertex/fragment shaders, graphics pipelines, frame submission, fences, native surface/swapchain lifecycle, recovery and 3-OS compile CI |
| 6 | Rendering Quality — 描画品質基盤 | **100%** | PBR direct/indirect reference, material packing, PCF shadow sampling, cascade selection, ACES and sRGB output helpers |
| 7 | Atmosphere & Sky — 大気・空 | **100%** | GENESIS state normalization/packing, Rayleigh/Mie integration, cloud density/drift, sun/moon disks and aerial perspective helpers |
| 8 | Advanced Water — 高度な水面 | **100%** | Fresnel, Beer–Lambert absorption, wind-driven multi-scale waves, rain ripples, foam composition and ordered Render Graph pass declarations |
| 9 | World Rendering — ワールド描画 | **100%** | Heightfield terrain, world chunks, projected-error LOD/hysteresis, AABB visibility, bounded streaming, deterministic foliage, material packing and executor-backed render system |
| 10 | Advanced Graphics — 高度な描画技術 | **100%** | GPU VFX compute contract, SH probe GI/dirty scheduling, clustered-light assignments, bounded froxel volumes, Beer–Lambert/HG integration, temporal history and volumetric executor |
| 11 | PVCS Integration — 視覚補償・性能配分 | **65%** | Domain-isolated evidence governor, paired alternating A/B calibration harness, visual/temporal gates, reversible frame-budget overlay and explicit manual transactions; no production auto-actuation |
| 12 | Three.js Independence — Three.js独立 | **35%** | PStudio-owned Scene Asset schema/importer and an opt-in direct-WebGPU opaque PBR mesh renderer; production renderer, TSL effects, textures, animation, shadows, loaders and BVH still require migration |

Phase 9 and 10 are complete for their defined PStudio-owned subsystem APIs, bounded resource/dispatch contracts, integration executors and deterministic repository tests. Their executors remain caller-supplied and the new systems are not automatically wired into the production renderer. Phase 11 and 12 percentages describe repository/API milestones only: Phase 11 has a paired calibration harness but no in-repository production scene capture runner, calibrated production candidate registry or automatic actuation; Phase 12 has a basic independently-owned scene asset/import path and a limited WebGPU PBR renderer, but has not migrated the production 3D renderer or removed legacy Three.js dependencies. The overall percentage is not a simple arithmetic mean because phases differ in scope and effort. Existing rendering assets do not substitute for independent-engine implementation.

## Phase 0 — Foundation (100%)

PVCS analysis and instrumentation, distinct CPU/GPU/async/memory metrics, context-aware histories, no-monitoring fast paths, explicit RGBA comparison utilities, regression tests and CI-backed documentation are complete at source/repository scope. Real-device bottleneck ranking remains unmeasured.

## Phase 1 — Visual Identity (100%)

Reality 55 : Anime 45 is defined as whole-image art direction. Physical coherence, deliberate artistic control, temporal stability, PBR, shadows, SH/probe GI, atmosphere, sky/IBL, optical water behavior, material identity, protected reference assets and the shrine/water review rubric are specified. This completes the visual contract, not the implementation of every listed effect.

## Phase 2 — Graphics Architecture (100%)

- PStudio-owned backend, scene, view, material, resource, frame, command-buffer and sync contracts.
- Feature-aware HAL with explicit fallback, cancellation, device/context-loss state and manual alternate-adapter recovery.
- Existing PStudio3D WebGL2 renderer wrapper; ownership remains with PStudio3D unless explicitly transferred.
- Three.js r187 WebGPU/TSL scene-session wrapper; its session owns conversions and GPU resources.
- Separate direct WebGPU Core adapter built on browser APIs without a Three.js scene session.
- Source-level dependency separation, migration/ownership matrix, compatibility and rollback tests.
- Existing visible production path is deliberately unchanged and can adopt these adapters in a controlled integration.

## Phase 3 — Graphics Core (100%)

- Renderer, Resource, Shader, Compute and Lighting ownership cores are composed through a PStudio-owned root.
- GPU resources use explicit create/write/destroy/recreate lifecycles and separate resource budgets/leases.
- Direct WebGPU backend compiles WGSL, creates render/compute pipelines, dispatches workgroups and submits graph command buffers.
- Directional/point/spot lights are packed into a stable 16-float record plus a separate uint32 layer mask; `indexById` maps scene light ids to packed indices.
- Sparse clustered-light assignments compile to offset/index arrays and upload to dedicated storage buffers. Visibility policy is provided by the caller and overflow is rejected instead of silently dropping lights.
- A WGSL direct-light include implements GGX/Smith/Schlick BRDF evaluation with light-layer and cluster-index filtering. Existing IBL, shadow, sky and water paths remain separate.
- Explicit backend recovery rehydrates GPU resources, recompiles shader variants, recreates stored pipelines and uploads light/cluster data.
- An independent renderer vertical slice reaches a configured WebGPU surface through Renderer Core, HAL-compatible backend and Render Graph.

Phase 3 completion means the defined Core APIs and independent WebGPU vertical slice are implemented and covered by deterministic repository tests. It is not proof of visual parity with every Three.js scene or production renderer migration.

## Phase 4 — Render Graph (100%)

- Pass and resource declarations, explicit dependencies and stable topological order.
- RAW / WAR / WAW inference, feedback-loop/read-before-write/unknown-resource/cycle rejection.
- Resource lifetimes, compatible transient aliasing and physical resource materialization.
- External-resource borrowing, idempotent release and reverse-order rollback.
- Read/write state transitions, barrier metadata, async execution hooks, cancellation, pass abort and concurrency protection.
- Direct WebGPU command recording and a single queue submission per graph execution; WebGPU's own API-managed transition behavior is respected.

Phase 4 completion is the Render Graph subsystem implementation and contract validation. It does not mean all legacy PStudio render passes have already been migrated into it.

## Phase 5 — Native Renderer (100%)

The optional C++17 native runtime and SDL3 GPU adapter implement the defined native graphics-renderer boundary:

- PStudio-owned native GPU backend interface, capability descriptors, logical resource handles, validation and backend registry with explicit feature negotiation/fallback.
- SDL3 GPU device creation with strict Vulkan, Direct3D 12 and Metal driver selection. The selected driver is read back and verified; unexpected driver substitution fails closed.
- Native buffer and texture allocation, staged uploads, SPIR-V/DXIL/MSL vertex/fragment shader creation and graphics-pipeline creation.
- Native render-frame submission, viewport/render-pass setup, vertex-buffer binding, draw calls, GPU fences, wait-idle and monotonically increasing frame IDs.
- Host-window claiming/release and SDL-managed OS surface/swapchain lifecycle, resize generation, plus headless offscreen targets.
- Device-loss notification, resource ownership/disposal and replacement-backend recovery. The runtime retains buffer/texture upload shadows and restores resources, shaders and graphics pipelines transactionally before committing a replacement.
- The optional adapter is compiled in CI on Linux, Windows and macOS. C++17 mock-backend tests cover contracts and recovery without creating a GPU device.

Phase 5 is 100% for the defined native **graphics rendering** backend contract and compile-time platform matrix. SDL3 supplies the OS-specific Vulkan/D3D12/Metal GPU-driver implementation behind its GPU API; PStudio owns the backend adapter and runtime contracts. This is not a claim that the code directly reimplements each vendor API from raw SDK calls.

Scope boundary: this native adapter currently advertises compute-shader support as unavailable and rejects compute shader creation. Native compute is not counted as part of Phase 5's graphics-renderer acceptance criteria; browser WebGPU compute and injected executors belong to the Graphics Core/Advanced Graphics paths. No physical GPU, real OS-window session, rendered-image parity or hardware-performance result is claimed. Those checks are explicitly not progress gates.

## Phase 6 — Rendering Quality (100%)

The independent rendering library in `static/pstudio_graphics_rendering_quality.mjs` supplies:

- GGX normal distribution, Schlick Fresnel and Smith/Schlick geometry for direct PBR response.
- Separate diffuse/specular indirect-light composition inputs for SH/IBL/probe irradiance.
- 3×3 percentage-closer-filter shadow sampling and deterministic four-cascade selection validation.
- ACES filmic tone mapping and linear-to-sRGB output conversion.
- CPU reference BRDF/tone-map functions and validated material uniform packing.
- `static/pstudio_graphics_rendering_systems.mjs` composes the quality library with caller-supplied WGSL vertex/fragment entry points, compiles them through Shader Core and creates a recoverable Graphics Core render pipeline.
- Persistent GPU material/environment uniform buffers use Resource Core and update in place.

These are opt-in shader building blocks. The live PStudio3D quality defaults and production material path are not changed. Hardware image parity and device-specific performance remain unmeasured.

## Phase 7 — Atmosphere & Sky (100%)

The independent `static/pstudio_graphics_atmosphere.mjs` layer consumes the existing normalized GENESIS time/weather state and provides:

- Rayleigh molecular and Henyey–Greenstein Mie phase functions.
- A bounded 16-step atmospheric scattering/transmittance integration.
- 3D procedural cloud density with wind/time drift and coverage control.
- Sun and moon disk functions.
- Height-dependent aerial perspective / fog composition.
- Normalized celestial directions, time, weather, wind and fog state with packed GPU uniforms.

This supplements rather than replaces the protected authored day/dusk/night panorama and existing PMREM/IBL source. The new shader library is composed into caller-provided WGSL entry points; no automatic production backend switch is made.

## Phase 8 — Advanced Water (100%)

The independent `static/pstudio_graphics_water.mjs` layer provides:

- Three-scale directional wave displacement and a corresponding analytic surface-normal approximation.
- Wind-driven motion, time evolution and rain-impact ripple contribution.
- View-angle Fresnel reflection.
- RGB Beer–Lambert transmission and depth-dependent scattering color.
- Reflection/refraction/foam composition.
- An ordered Render Graph declaration for planar reflection, water depth prepass, depth-aware refraction and final surface composition.
- CPU reference tests for absorption monotonicity, Fresnel response and wave variation.

The pass declaration requires caller-supplied GPU pass callbacks and imported scene/surface handles at execution time. Existing production planar reflection and water shaders remain untouched. Physical image parity and water stability on named devices are not claimed.

## Phase 9 — World Rendering (100%)

\`static/pstudio_graphics_world_core.mjs\` provides the independent world subsystem:

- Heightfield terrain sampling, vertex/normal generation, bounded tile descriptors and validated dimensions.
- Projected screen-space error LOD with hysteresis, conservative AABB/frustum visibility and deterministic selection.
- Bounded world-chunk streaming priorities, resident-byte/concurrency budgets and stale-load handling.
- Seeded deterministic foliage scattering with slope/height constraints and stable instance data.
- Packed world material layers and explicit ownership/disposal rules.
- \`createPStudioWorldRenderingSystem\` coordinates chunk registration/update/removal, view/LOD updates, stream ticks, invisible-chunk eviction, foliage preparation and render-frame packets through an injected executor.

Phase 9 is complete for the declared world data, LOD/visibility, bounded streaming, foliage, material-packing and rendering-executor APIs. Asset decoding and concrete GPU drawing remain caller/executor responsibilities. The new world system is opt-in and is not wired into existing production scenes.

## Phase 10 — Advanced Graphics (100%)

\`static/pstudio_graphics_advanced_core.mjs\` provides:

- GPU VFX compute command construction and bounded workgroup/particle validation through an injected executor.
- SH probe GI data, temporal blending, dirty-probe update scheduling and probe-buffer contracts.
- Logarithmic clustered-light assignment with stable offsets/indices and explicit overflow rejection.
- Memory-budgeted froxel-grid creation.
- Beer–Lambert extinction, Henyey–Greenstein phase evaluation, bounded front-to-back volumetric integration and temporal-history blending.
- Volumetric compute WGSL and an executor-facing dispatch packet describing lighting injection, front-to-back integration and temporal history passes.
- Explicit in-flight protection, frame sequencing, disposal and input/memory bounds.

Phase 10 is complete for these independent advanced-GI, clustered-lighting, VFX and volumetric subsystem APIs and the GPU-executor integration contract. A concrete executor is supplied by the consuming backend. Native SDL3 compute is not implemented by the current Phase 5 adapter. No ray tracing/path tracing, production-scene migration, physical-GPU image parity or hardware performance is claimed.

## Phase 11 — PVCS Integration (55%)

The PVCS foundation and Visual Compensation Graph remain the source of performance evidence. The new governor is an opt-in decision and transaction layer:

- Reads PVCS's separate CPU-frame, CPU-stage/submission, GPU-frame, GPU-stage, async-elapsed and estimated-memory rankings. It never compares or substitutes one domain for another.
- Requires a live measurement context matching backend, scene, quality, dimensions, pixel ratio and effect state. Candidate calibration must use the same context for baseline and alternative.
- Requires bounded repeated A/B P95 samples, an explicitly measured improvement, RGBA image-difference metrics and aligned temporal-delta metrics with caller-defined acceptance limits.
- Ranks eligible candidates by measured improvement, priority and visual/temporal penalty; records explicit rejection reasons for unavailable domains, context mismatch, insufficient samples, calibration drift or quality-limit failure.
- Uses a narrow action allowlist. It does not accept turning off premium effects, changing quality presets, changing the protected sky/water implementation or unbounded resolution changes.
- Integrates an additive frame-budget overlay with scale, reflection cadence/resolution, GI cadence and volumetric/contact-shadow sample scales. The overlay can only constrain those bounded values; it cannot change the underlying frame-budget policy or disable the GI/effect state.
- Applies one compensation transaction at a time through an explicit executor returning a rollback token. Manual rollback restores the previous budget overlay. Concurrent apply/rollback transactions are rejected.
- Automatic actuation is disabled by default. Even when explicitly enabled at construction, it requires an explicitly registered automaticEligible candidate, repeated confirmations and a cooldown.
- The browser exposes manual evaluate/apply/rollback entry points for an operator/developer. It does not pre-register guessed candidate thresholds.

Phase 11 is **65%** at repository/API scope. In addition to the governor, evidence gates, frame-budget bridge and reversible overlay, `static/pstudio_pvcs_calibration.mjs` now provides paired alternating baseline/alternative execution across the six isolated measurement domains. It requires a fixed backend/scene/quality/resolution/effect context, explicit per-variant measurements and byte-image captures, computes P95 A/B results, worst-sample RGBA error and bounded temporal-delta error, and emits evidence in the governor's accepted schema. Calibration is caller-driven: PStudio still needs an in-repository production capture runner, repeatable scene/backend calibration suites, candidate-specific executors, richer spatial/perceptual/edge metrics and longer temporal validation. No candidate is registered by default and no automatic quality adjustment is active.

## Phase 12 — Three.js Independence (35%)

The migration starts by making the PStudio-owned core boundary enforceable without pretending the entire application has already been ported:

- Graphics Core, Render Graph, PVCS/VCG and World/Advanced core modules are protected by regression tests that reject direct Three.js package imports.
- The direct PStudio WebGPU Graphics Core stays independent of Three.js.
- `static/pstudio_graphics_scene_asset.mjs` defines PStudio-owned geometry/material/entity scene data, converts supported legacy mesh data without importing Three.js, and reports unsupported features instead of hiding them.
- `static/pstudio_graphics_webgpu_scene_renderer.mjs` draws the PStudio scene asset through browser WebGPU with cached vertex/index buffers, per-object transforms, depth testing, a direct PBR path and emissive output. This is an opt-in first vertical slice, not a replacement for all existing effects.
- The scene importer is strict by default. Textures, non-PBR materials, transparency, double-sided materials, scene background/environment, lights, animation/skinning/morphing, instances, unsupported groups/draw ranges and shadows are rejected or listed in its explicit report.
- The independent renderer currently accepts only opaque, single-sided, untextured PBR meshes with one material per entity; it does not yet implement sky/IBL, shadows, water, GI, post-processing or production editor integration.
- The file pstudio_three_legacy_runtime.mjs is the explicit lazy-loading boundary for the optional Three.js r187 WebGPU compatibility adapter.
- The file pstudio_rendering_backend.mjs no longer imports three/webgpu at module evaluation time; it only resolves the legacy runtime when that adapter is explicitly initialized.
- The legacy adapter accepts an injected runtime for deterministic tests and validates the pinned r187 contract.

Phase 12 is **35%** at repository/API scope, not application-wide independence. PStudio now has a data-owned scene asset contract, a duck-typed mesh importer and a separately-created direct-WebGPU PBR renderer that does not import or retain Three.js objects. GPU geometry buffers are revision-cached and reused; 16-bit index uploads are padded to WebGPU's four-byte write alignment. The importer/renderer deliberately fail closed on features the vertical slice cannot preserve. Production rendering still depends on `window.THREE`; TSL modules for material, environment, GI, water, clustered lighting, shadows, toon and post-processing still use Three.js r187. GLTF/KTX2/Draco/meshopt loaders, BVH, skinning, morphs, instancing, editor object/material APIs and asset lifecycle still require independent implementations. The `three` and `three-mesh-bvh` packages remain installed, and the production renderer has not been switched.

Migration order is compatibility-first: define PStudio scene/material/asset/render-pass contracts; migrate isolated asset and material adapters; provide equivalent shader/pass implementations in PStudio WGSL; connect World/Advanced systems through the Render Graph; compare old/new output and lifecycle behavior; then move one production vertical slice at a time. Keep the current WebGL2 production renderer and legacy Three.js implementation available until each slice passes API, image, temporal, resource-lifetime and rollback gates. No broad import rewrite or default backend switch is part of this step.

## Delivery and rollback

1. Use a dedicated feature branch based on main.
2. Preserve the exact pre-change main SHA in a named backup branch.
3. Add deterministic contract tests before integration.
4. Run the full Python/C++17, JavaScript and renderer syntax/TSL CI suite.
5. Inspect the PR diff, merge by PR and retain a revert path; never rewrite shared main history.
6. Keep the live production renderer, sky, water and quality defaults untouched until their replacements pass their own gates.

## Validation boundary

The Advanced Graphics executor tests use deterministic mock executors and validate command packets, resource budgets, workgroup sizes and state transitions; they do not prove real GPU compute execution, rendered output quality, image parity or frame-time performance. Native SDL3 adapter CI compiles on Linux, Windows and macOS without creating GPU devices or physical windows. C++17 mock tests validate native resource/recovery contracts. Real-driver execution, rendered image parity and hardware performance remain unmeasured and are outside this progress policy.


## Phase 11/12 implementation added on 2026-11-28

- PVCS calibration can now be driven through `pvcs.createCalibrationHarness({ runVariant })`. The callback is responsible for rendering the same scene/context for each variant and returning the requested domain metric plus an RGBA frame. The harness alternates A/B order to reduce ordering bias and does not mutate quality or apply a candidate.
- A calibration run returns evidence only after the configured sample floor and image/temporal acceptance limits are met. A caller may then register that evidence with the PVCS Governor; registration is still separate from proposal evaluation and reversible manual execution.
- The first independent scene path converts supported mesh geometry and basic PBR material values into PStudio-owned typed arrays/descriptors. Source objects are read only; callers must update world matrices before conversion.
- The independent WebGPU renderer owns its GPU buffers and render pipeline, reuses geometry resources by ID/revision, renders indexed or non-indexed opaque PBR meshes and writes emissive RGB separately from material color. It is an isolated renderer adapter and does not take over the production canvas or frame loop.
- The new deterministic tests cover paired calibration/evidence registration, measurement-domain isolation, context drift, visual-limit rejection, legacy mesh conversion, unsupported-feature reporting, direct WebGPU submission, depth target reuse and GPU-buffer cache reuse.

These additions are **not** evidence that the requested complete Three.js replacement has been achieved. Full acceptance still requires migrating and comparing the actual PStudio production scene, texture/material and animation/skin/instance paths, lighting/IBL/sky, shadows, planar water/refraction/absorption, GI, volumetrics, toon and post-processing; moving asset loading and collision/BVH ownership; integrating the independent renderer with editor/gameplay APIs; then demonstrating no visual regressions and measurable performance/resource improvements in repeatable browser workload runs. Until that is true, both phases remain in progress and the legacy production path stays the fallback.
