# PStudio Independent Graphics Engine — Development Roadmap

**Roadmap version:** 1.1  
**Last updated:** 2026-11-28  
**Current target:** Phase 0 = 100%, Phase 1 = 100%, Phase 2 = 100%, Phase 3 = 50%.  
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
| 3 | Graphics Core — 独自グラフィックスコア | **50%** | Renderer, Resource, Shader, Compute and Lighting core ownership foundations |
| 4 | Render Graph — 描画依存グラフ | **0%** | Declarative passes, resource edges, scheduling, transient lifetime, barriers and dependency compilation |
| 5 | Native Renderer — ネイティブ描画基盤 | **0%** | Native runtime and API backends where platform/runtime support is deliberately provided |
| 6 | Rendering Quality — 描画品質基盤 | **30% (暫定)** | PBR, shadows, indirect lighting, color management and material response |
| 7 | Atmosphere & Sky — 大気・空 | **45% (暫定)** | Sky radiance, atmosphere, weather, volumetrics and coherent IBL |
| 8 | Advanced Water — 高度な水面 | **40% (暫定)** | Reflection, refraction, absorption, depth, wave spectrum and temporal stability |
| 9 | World Rendering — ワールド描画 | **25% (暫定)** | Terrain, foliage, world visibility, LOD, streaming and material scale |
| 10 | Advanced Graphics — 高度な描画技術 | **15% (暫定)** | GPU VFX, advanced GI, clustered lighting and volumetric effects |
| 11 | PVCS Integration — 視覚補償・性能配分 | **25% (暫定)** | Evidence-based quality/cost selection and reversible runtime allocation |
| 12 | Three.js Independence — Three.js独立 | **0%** | Replace implementation dependencies only after parity, compatibility and migration gates |

Phase 6–11 percentages are provisional source-level estimates. The overall percentage is not a simple arithmetic mean because phases differ in scope and effort. Existing rendering assets do not mean the future independent renderer has completed those phases.

## Phase 0 — Foundation (100%)

PVCS analysis and instrumentation, distinct CPU/GPU/async/memory metrics, context-aware histories, no-monitoring fast paths, explicit RGBA comparison utilities, regression tests and CI-backed documentation are complete at source/repository scope. Real-device bottleneck ranking remains unmeasured.

## Phase 1 — Visual Identity (100%)

Reality 55 : Anime 45 is defined as whole-image art direction. Physical coherence, deliberate artistic control, temporal stability, PBR, shadows, SH/probe GI, atmosphere, sky/IBL, optical water behavior, material identity, protected reference assets and the shrine/water review rubric are specified. This completes the visual contract, not the implementation of every listed effect.

## Phase 2 — Graphics Architecture (100%)

- PStudio-owned backend, scene, view, material, resource, frame, command-buffer and sync contracts.
- Feature-aware HAL with explicit fallback, cancellation, device/context-loss state and manual alternate-adapter recovery.
- Existing PStudio3D WebGL2 renderer wrapper; ownership remains with PStudio3D unless explicitly transferred.
- Three.js r187 WebGPU/TSL scene-session wrapper; its session owns conversions and GPU resources.
- Adapter synchronization, capabilities and lifecycle reporting.
- Source-level dependency separation, migration/ownership matrix, compatibility and rollback tests.
- Existing visible production path is deliberately unchanged and can adopt these adapters in a controlled integration.

## Phase 3 — Graphics Core (50%)

### Completed half

- Renderer Core: monotonic frame submission, validated frame/command packets and HAL dispatch.
- Resource Core: descriptors, independent CPU/GPU budget accounting, leases, concurrent creation deduplication, LRU eviction and deterministic disposal.
- Shader Core: backend-neutral shader registry, variant keys, concurrent compilation deduplication, invalidation and disposal via injected compiler.
- Compute Core: kernel registration, workgroup/dispatch validation, feature checks and injected execution.
- Lighting Core: directional/point/spot normalization and packed typed-array snapshots.
- Composition root and deterministic Node regression coverage.

### Remaining half

- GPU resource creation/destruction paths with backend handles and device-loss recovery.
- Concrete WebGPU shader compiler plus native compiler extension points.
- Real GPU compute dispatch implementation and resource barriers.
- GPU lighting buffer upload, clustered-light integration and PBR consumption.
- Minimal end-to-end independent GPU renderer vertical slice.
- Resource and pipeline recreation across device-loss/recovery events.

Phase 3 at 50% is a PStudio-owned, testable core foundation. It is not yet a complete GPU-executing replacement renderer.

## Remaining phases

- Phase 4 builds the dependency-aware Render Graph. It owns pass declarations, scheduling, resource lifetimes, barriers and safe transient reuse; it must not be folded prematurely into Phase 3.
- Phase 5 adds native runtime/backends only when a real native platform is in scope.
- Phases 6–10 implement independent rendering quality, atmosphere, water, world and advanced graphics while preserving Reality 55 : Anime 45.
- Phase 11 connects measured cost and visual-impact allocation through PVCS; no automatic quality reduction is enabled by this roadmap update.
- Phase 12 removes Three.js only after feature parity, API migration, rollback and regression gates are satisfied.

## Delivery and rollback

1. Use a dedicated feature branch based on main.
2. Preserve the exact pre-change main SHA in a named backup branch.
3. Add deterministic contract tests before integration.
4. Run the full Python/C++17, JavaScript and renderer syntax/TSL CI suite.
5. Inspect the PR diff, merge by PR and retain a revert path; never rewrite shared main history.
6. Keep the live production renderer, sky, water and quality defaults untouched until their replacements pass their own gates.
