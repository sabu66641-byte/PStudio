# PStudio Independent Graphics Engine — Development Roadmap

**Roadmap version:** 1.4  
**Last updated:** 2026-11-28  
**Current target:** Phase 0 = 100%, Phase 1 = 100%, Phase 2 = 100%, Phase 3 = 100%, Phase 4 = 100%, Phase 5 = 70%, Phase 6 = 100%, Phase 7 = 100%, Phase 8 = 100%, Phase 9 = 100%, Phase 10 = 100%.  
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
| 5 | Native Renderer — ネイティブ描画基盤 | **70%** | C++17 runtime, backend registry, CPU reference rasterizer and backend-neutral surface acquire/present/resize lifecycle; concrete native GPU APIs remain |
| 6 | Rendering Quality — 描画品質基盤 | **100%** | PBR direct/indirect reference, material packing, PCF shadow sampling, cascade selection, ACES and sRGB output helpers |
| 7 | Atmosphere & Sky — 大気・空 | **100%** | GENESIS state normalization/packing, Rayleigh/Mie integration, cloud density/drift, sun/moon disks and aerial perspective helpers |
| 8 | Advanced Water — 高度な水面 | **100%** | Fresnel, Beer–Lambert absorption, wind-driven multi-scale waves, rain ripples, foam composition and ordered Render Graph pass declarations |
| 9 | World Rendering — ワールド描画 | **100%** | Terrain tile generation/GPU upload, screen-space LOD, frustum visibility, deterministic foliage, bounded streaming, material tables and Render Graph pass declarations |
| 10 | Advanced Graphics — 高度な描画技術 | **100%** | SH radiance cache/GPU upload, view-space clustered-light assignment, WebGPU particle and volumetric compute pipelines, froxel layout and temporal history validation |
| 11 | PVCS Integration — 視覚補償・性能配分 | **25% (暫定)** | Evidence-based quality/cost selection and reversible runtime allocation |
| 12 | Three.js Independence — Three.js独立 | **0%** | Replace implementation dependencies only after parity, compatibility and migration gates |

Phase 9 and 10 are complete for the explicitly defined independent subsystem APIs, GPU buffer/pipeline integration contracts and deterministic repository tests. They remain opt-in and are not wired into the production renderer; visual parity and performance are not claimed. Phase 11 remains a provisional source-level estimate. The overall percentage is not a simple arithmetic mean because phases differ in scope and effort. Existing rendering assets do not substitute for implementation in the independent engine.

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

## Phase 5 — Native Renderer (70%)

Completed repository scope:

- Header-only C++17 platform-neutral Runtime, Backend SPI and opaque native resource handles.
- Frame packet validation, monotonic frame ids, owned-handle validation, wait-idle and explicit device-lost recovery.
- NativeBackendRegistry with feature filtering, preference/priority ordering, explicit fallback and initialized-backend ownership.
- SoftwareRasterBackend as a bounded CPU reference rasterizer for position-buffer triangle lists and deterministic framebuffer contract tests.
- presentation.hpp adds a backend-neutral native-surface/swapchain presentation contract and PresentationRuntime: configure, acquire, present, abandon, resize generation, device-loss and release lifecycle. Stale/double-presented images and resize races are rejected.
- C++17 compile-and-run tests cover runtime recovery, backend selection, CPU rasterization and presentation lifecycle.

Remaining work preventing 100%:

- Concrete Vulkan, Direct3D 12 and Metal GPU device implementations.
- Per-API GPU resource allocation, shader/pipeline creation, command execution, fences and device-loss recovery.
- OS window/surface/swapchain implementations that satisfy the new presentation contract.
- Platform-specific build validation for the concrete API source and runtime initialization.

The CPU reference rasterizer and presentation contract are not GPU API implementations. The registry still has no concrete Vulkan/D3D12/Metal backend. Phase 5 is deliberately **70%, not 100%**; claiming completion without those implementations would be inaccurate.

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

## Delivery and rollback

1. Use a dedicated feature branch based on main.
2. Preserve the exact pre-change main SHA in a named backup branch.
3. Add deterministic contract tests before integration.
4. Run the full Python/C++17, JavaScript and renderer syntax/TSL CI suite.
5. Inspect the PR diff, merge by PR and retain a revert path; never rewrite shared main history.
6. Keep the live production renderer, sky, water and quality defaults untouched until their replacements pass their own gates.

## Validation boundary

The added WebGPU tests use a mock WebGPU device. They cover API wiring, resource ownership, command recording/submission, shader/pipeline registration and recovery behavior, but do not prove real-device shader validation, rendered output quality, image parity or frame-time performance. The native tests compile/run the C++17 runtime, feature registry and CPU reference rasterizer; concrete Vulkan/D3D12/Metal GPU drivers are still absent.

## Phase 9 — World Rendering (100%)

static/pstudio_graphics_world.mjs is an independent, opt-in world-rendering subsystem:

- Heightfield terrain tile generation with positions, normals, UVs, indexed triangles, validated vertex budgets and seam-hiding skirts.
- Screen-space geometric-error LOD selection with stable threshold hysteresis and AABB frustum culling.
- Deterministic, slope-aware foliage placement with height sampling, compact typed instance records and GPU wind vertex-shader source.
- World tile streaming with priority queue, bounded concurrent loads, cancellation, stale-completion disposal, caller-reported resident-byte accounting, pin/unpin and pin-aware LRU eviction.
- Stable packed PBR world-material table with roughness/metalness/emissive/alpha controls and deterministic material-ID indexing.
- Explicit depth/opaque/transparent/debug Render Graph pass declarations.
- uploadPStudioWorldTile uploads validated terrain vertex/index data to caller-owned WebGPU buffers and rolls back partial allocation failures.

Phase 9 completion is the defined world data, visibility, LOD, streaming, material-table and GPU-upload API scope with deterministic tests. The caller supplies tile hierarchy/bounds, height/slope samplers, asset loader, pass callbacks and the scene-specific material shader. It does not claim generalized procedural world authoring, occlusion-query/Hi-Z implementation, automatic biome generation or production-scene migration.

## Phase 10 — Advanced Graphics (100%)

static/pstudio_graphics_advanced.mjs supplies an independent advanced-lighting/effects subsystem:

- 3D SH9 irradiance-probe cache with temporal blending, AABB invalidation, trilinear sampling and diffuse irradiance evaluation.
- Persistent GPU storage-buffer binding/upload for SH coefficients and probe validity.
- Positive-forward view-space clustered-light assignment with logarithmic depth slices, conservative frustum-cell bounds, deterministic packed offsets/indices and explicit overflow rejection; it uses the Phase 3 clustered-buffer upload contract.
- Bounded fixed-step CPU particle reference with deterministic state, capacity/drop accounting and explicit dropped-time telemetry.
- Actual direct-WebGPU particle compute pipeline helper using WGSL, storage/uniform buffers, bind groups, device workgroup limits and dispatch.
- Front-to-back single-scattering reference integration, Henyey–Greenstein phase, froxel-grid sizing and temporal-history rejection/clamping for frame gaps, depth discontinuities and camera cuts.
- Direct-WebGPU volumetric ray-batch compute pipeline helper with per-ray sample packing, output storage, uniform parameters and bounded memory/workgroup limits.
- Declared Render Graph pass sequence for probe updates, VFX simulation, volumetric injection/integration and final composition.

Phase 10 completion is the specified advanced subsystem and direct WebGPU compute/buffer integration API scope with deterministic mock-backend tests. The caller supplies light/view-space transforms, probe capture/update data, particle spawn data, volumetric sample fields and Render Graph execution callbacks. Full production-scene visual parity, ray tracing, multi-bounce path tracing and hardware performance are not claimed.

