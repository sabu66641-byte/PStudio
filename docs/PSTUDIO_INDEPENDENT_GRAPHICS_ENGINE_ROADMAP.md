# PStudio Independent Graphics Engine — Development Roadmap

**Roadmap version:** 1.3  
**Last updated:** 2026-11-28  
**Current target:** Phase 0 = 100%, Phase 1 = 100%, Phase 2 = 100%, Phase 3 = 100%, Phase 4 = 100%, Phase 5 = 65%, Phase 6 = 100%, Phase 7 = 100%, Phase 8 = 100%.  
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
| 5 | Native Renderer — ネイティブ描画基盤 | **65%** | C++17 runtime, backend SPI/registry, feature negotiation, CPU reference rasterizer; native GPU API implementations remain |
| 6 | Rendering Quality — 描画品質基盤 | **100%** | PBR direct/indirect reference, material packing, PCF shadow sampling, cascade selection, ACES and sRGB output helpers |
| 7 | Atmosphere & Sky — 大気・空 | **100%** | GENESIS state normalization/packing, Rayleigh/Mie integration, cloud density/drift, sun/moon disks and aerial perspective helpers |
| 8 | Advanced Water — 高度な水面 | **100%** | Fresnel, Beer–Lambert absorption, wind-driven multi-scale waves, rain ripples, foam composition and ordered Render Graph pass declarations |
| 9 | World Rendering — ワールド描画 | **25% (暫定)** | Terrain, foliage, world visibility, LOD, streaming and material scale |
| 10 | Advanced Graphics — 高度な描画技術 | **15% (暫定)** | GPU VFX, advanced GI, clustered lighting and volumetric effects |
| 11 | PVCS Integration — 視覚補償・性能配分 | **25% (暫定)** | Evidence-based quality/cost selection and reversible runtime allocation |
| 12 | Three.js Independence — Three.js独立 | **0%** | Replace implementation dependencies only after parity, compatibility and migration gates |

Phase 9–11 percentages remain provisional source-level estimates. The overall percentage is not a simple arithmetic mean because phases differ in scope and effort. Existing rendering assets do not mean the future independent renderer has completed those phases.

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

## Phase 5 — Native Renderer (65%)

Completed repository scope:

- Header-only C++17 platform-neutral runtime, Backend SPI and opaque native resource handles.
- Frame packet validation, strictly increasing frame ids, owned-handle validation and wait-idle contract.
- Explicit device-lost state and replacement-backend recovery that recreates resources before accepting the replacement.
- `NativeBackendRegistry` with feature filtering, priority/preference ordering, explicit fallback and initialized-backend ownership.
- `SoftwareRasterBackend` as a bounded CPU reference rasterizer for position-buffer triangle lists, framebuffer captures and deterministic contract tests.
- C++17 compile-and-run tests for runtime recovery, feature negotiation and reference rasterization.

Remaining work preventing 100%:

- Concrete Vulkan, Direct3D 12 and Metal GPU device implementations.
- Per-API GPU resource allocation, shader/pipeline creation, command execution, fences and device-loss recovery.
- OS window/surface/swapchain and presentation lifecycle.
- Platform-specific build and driver validation.

The CPU reference rasterizer is an actual native software renderer, not a GPU renderer. The registry negotiates declared capabilities but does not create Vulkan/D3D12/Metal devices. Therefore Phase 5 is deliberately **65%, not 100%** until concrete native GPU backends are implemented.

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
