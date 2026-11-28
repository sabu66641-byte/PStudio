# PStudio Independent Graphics Engine — Development Roadmap

**Roadmap version:** 1.4  
**Last updated:** 2026-11-28  
**Current target:** Phase 0 = 100%, Phase 1 = 100%, Phase 2 = 100%, Phase 3 = 100%, Phase 4 = 100%, Phase 5 = 100%, Phase 6 = 100%, Phase 7 = 100%, Phase 8 = 100%, Phase 9 = 100%, Phase 10 = 100%.  
**Progress policy:** Physical-device verification is explicitly excluded from phase completion. Use repository tests, static/module checks, API contracts, cross-platform compile-only checks, dependency audits and reversible integration. Never label an unrun hardware test as passed.

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
| 5 | Native Renderer — ネイティブ描画基盤 | **100%** | SDL3 GPU adapter for strict Vulkan / Direct3D 12 / Metal selection, borrowed OS surfaces/swapchains, resources/shaders/pipelines, uploads/fences, transactional Device Lost recovery and Linux/Windows/macOS compile-only CI |
| 6 | Rendering Quality — 描画品質基盤 | **100%** | PBR direct/indirect reference, material packing, PCF shadow sampling, cascade selection, ACES and sRGB output helpers |
| 7 | Atmosphere & Sky — 大気・空 | **100%** | GENESIS state normalization/packing, Rayleigh/Mie integration, cloud density/drift, sun/moon disks and aerial perspective helpers |
| 8 | Advanced Water — 高度な水面 | **100%** | Fresnel, Beer–Lambert absorption, wind-driven multi-scale waves, rain ripples, foam composition and ordered Render Graph pass declarations |
| 9 | World Rendering — ワールド描画 | **100%** | Terrain/heightfield, chunk descriptors, frustum visibility, projected-error LOD/hysteresis, budgeted async streaming, deterministic foliage, material layers and residency eviction |
| 10 | Advanced Graphics — 高度な描画技術 | **100%** | GPU VFX compute contract, SH probe GI, logarithmic clustered-light assignment, froxel volumetrics, WGSL injection/integration and mock-executor validation |
| 11 | PVCS Integration — 視覚補償・性能配分 | **25% (暫定)** | Evidence-based quality/cost selection and reversible runtime allocation |
| 12 | Three.js Independence — Three.js独立 | **0%** | Replace implementation dependencies only after parity, compatibility and migration gates |

Phases 9–10 are complete at their defined independent subsystem/API and deterministic mock-test scope. Phase 11 remains a provisional source-level estimate. The overall percentage is not a simple arithmetic mean because phases differ in scope and effort. Existing rendering assets do not by themselves count as implementation in the independent engine.

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

## Phase 5 — Native Renderer (100% at repository validation scope)

Completed repository scope:

- C++17 native SPI and logical resource runtime with monotonic frame validation, ownership checks, wait-idle and explicit lost/failed/disposed lifecycle.
- Native SDL3 GPU adapter strictly selects and verifies the requested Vulkan, Direct3D 12 or Metal driver; unexpected driver selection is rejected rather than silently accepted.
- Borrowed SDL_Window host surface contract for Win32, Xlib, Xcb, Wayland and MetalLayer platform tags. SDL3 owns the OS-specific native surface and swapchain, while PStudio retains surface dimensions, present policy, swapchain generation and resize lifecycle. Headless offscreen rendering is supported.
- GPU buffer and texture allocation/uploads, SPIR-V/DXIL/MSL vertex/fragment shaders, graphics pipeline creation, vertex layouts, validated frame/draw submission, GPU fences and wait-idle.
- Device-loss classification and explicit host notification; a replacement backend can be initialized and all retained buffer/texture data, shaders and graphics pipeline recipes can be recreated transactionally. Logical PStudio handles remain stable after successful recovery.
- Native backend registry retains feature negotiation, preference ordering, priority and explicit fallback. The bounded software rasterizer remains a CPU reference backend.
- C++17 deterministic mock tests cover native surface descriptors, buffer/texture upload contracts, pipeline dependencies, frame submit/fence, failed replacement rollback and successful logical-handle-preserving recovery.
- Pinned SDL3 3.2.10 compile-only CI on Linux, Windows and macOS validates the adapter and the corresponding host presentation integration code. No OS window or GPU device is created by these builds.

The native GPU adapter uses SDL3's cross-platform GPU API, which owns the underlying Vulkan/D3D12/Metal API objects and presentation implementation. This is intentionally not a second set of raw Vulkan, D3D12 and Metal object-management code inside PStudio.

**Completion boundary:** Phase 5 is 100% for the defined native backend contracts, SDL3-backed GPU adapter, resource/shader/graphics-pipeline lifecycle, fences, surface/swapchain integration, explicit loss reporting/recovery, mock behavior and compile-only OS matrix. Compute/storage capabilities not implemented by the current SDL3 adapter are reported as unsupported. Physical GPU/device execution, actual driver runtime validation, rendered-image parity and hardware performance measurements are explicitly excluded.

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


## Phase 9 — World Rendering (100% at independent subsystem scope)

Implemented in static/pstudio_graphics_world_core.mjs:

- Heightfield terrain sampling with bilinear interpolation, world-space origin/bounds and finite-difference surface normals.
- Validated world chunk descriptors with stable id, bounds, geometric error, assets, material set and revision.
- Projected pixel-error LOD selection with configurable thresholds and hysteresis.
- Conservative six-plane AABB/frustum visibility.
- Deterministic streaming request priority and explicit max-concurrent / byte budgets; over-budget requests are deferred, not discarded.
- Deterministic seeded foliage scatter with terrain samplers, slope limits and minimum spacing.
- World material-layer packing with unique ids and PBR/range validation.
- World Rendering System orchestration connects view/visibility/LOD to asynchronous asset load, injected GPU upload, generation-checked stale-result rejection, foliage upload and injected world-frame rendering.
- Non-visible resident chunks can be evicted after a configurable grace period while visible chunks are protected; resident count and byte budgets are both enforced by the eviction API.
- Regression tests cover terrain, normals, LOD monotonicity/hysteresis, frustum culling, request ranking, foliage determinism, material packing, async stale-work rejection, render submission and residency eviction.

The subsystem is independent and opt-in. The asset loader, GPU uploader and frame renderer are supplied by the host through explicit executor functions. The existing production scene graph, renderer and ECS streaming behavior remain unchanged.

**Completion boundary:** Phase 9 is 100% for the defined PStudio-owned World Rendering data model, visibility/LOD/streaming/lifetime APIs and deterministic mock-executor tests. It does not claim production scene migration, authored world content completion, hardware rendering parity or real-device streaming performance.

## Phase 10 — Advanced Graphics (100% at independent subsystem scope)

Implemented in static/pstudio_graphics_advanced_core.mjs:

- GPU VFX system with bounded capacity, emitter registration, deterministic burst/rate accounting, per-frame spawn limits, dropped-spawn reporting, workgroup planning and a WGSL particle simulation ABI.
- Advanced GI with 27-coefficient RGB spherical-harmonic probes, spatial validity/confidence, weighted probe sampling, temporal half-life blending, spatial invalidation and deterministic dirty-probe capture scheduling.
- Clustered lighting with perspective tile bounds, logarithmic depth slices, explicit per-cluster capacity checks and packed cluster-offset/light-index arrays. Overflow fails closed; no light is silently lost.
- Volumetric reference core with memory-budgeted froxel grids, Henyey–Greenstein phase, Beer–Lambert transmittance, front-to-back integration and confidence-weighted temporal history.
- GPU volumetric WGSL compute functions for segment-light injection and front-to-back column integration, plus an injected dispatch/execution system with workgroup and pass contracts.
- Deterministic tests exercise VFX spawn accounting and concurrency, GI update/invalidation/sampling, cluster assignment/overflow, froxel budgets, phase functions, volumetric integration/history and mock GPU dispatch.

These APIs compose with the Phase 3 Shader/Compute/Resource cores through explicitly supplied executors. They are not automatically wired into existing production scenes or enabled in default rendering.

**Completion boundary:** Phase 10 is 100% for the defined independent advanced-effect APIs, WGSL compute source contracts and deterministic CPU/mock-executor validation. Physical GPU shader execution, final image parity, hardware performance and production scene integration are explicitly excluded.

## Delivery and rollback

1. Use a dedicated feature branch based on main.
2. Preserve the exact pre-change main SHA in a named backup branch.
3. Add deterministic contract tests before integration.
4. Run the full Python/C++17, JavaScript and renderer syntax/TSL CI suite.
5. Inspect the PR diff, merge by PR and retain a revert path; never rewrite shared main history.
6. Keep the live production renderer, sky, water and quality defaults untouched until their replacements pass their own gates.

## Validation boundary

The added WebGPU tests use a mock WebGPU device. They cover API wiring, resource ownership, command recording/submission, shader/pipeline registration and recovery behavior, but do not prove real-device shader validation, rendered output quality, image parity or frame-time performance. The native tests compile/run the C++17 runtime, feature registry and CPU reference rasterizer; concrete Vulkan/D3D12/Metal GPU drivers are still absent.
