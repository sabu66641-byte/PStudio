# PStudio Independent Graphics Engine — Development Roadmap

**Roadmap version:** 1.0  
**Last updated:** 2026-11-28  
**Current execution target:** Phase 0 = 100%, Phase 1 = 100%, Phase 2 = 50%.  
**Progress policy:** Physical-device testing is not a completion axis for this project plan. Use repository-level automated tests, static/module checks, API contract tests, dependency audits and reversible integration. Never label an unrun hardware test as passed.

## Mission

Build a PStudio-owned, browser-first graphics engine with independent contracts and subsystem ownership. Preserve existing editor/gameplay APIs and rendering quality while migrating away from Three.js implementation ownership in controlled vertical slices. Browser deployment continues to use browser graphics APIs; native Vulkan, Direct3D 12 and Metal backends require a separate native runtime/platform.

## Non-negotiable rules

- Phase 0 is permanently **Foundation: 基盤強化・基盤整理・土台作り**.
- Keep current production WebGL2 rendering available until a replacement passes compatibility and regression gates.
- Preserve the Nov 24 sky panorama baseline and signature water-reflection behavior.
- Keep Reality 55 : Anime 45 as the governing visual identity. It is an art-direction contract, not a numeric shader blend.
- Do not reduce quality defaults, disable configured premium effects or alter sky/water appearance just to improve a benchmark.
- Separate CPU execution, CPU submission, GPU execution, async elapsed time and estimated memory. Missing measurements are unavailable, never zero.
- Keep changes additive, feature-gated and independently reversible.
- Repository-level validation is the progress gate. Physical-device checks may be recorded as future evidence but do not block the requested phase percentages.

## Phase definitions and current status

| Phase | Name | Current target | Purpose |
|---:|---|---:|---|
| 0 | Foundation — 基盤強化・基盤整理・土台作り | **100%** | PVCS analysis foundation, diagnostics, context separation, visual-difference utilities, regression coverage and accurate documentation |
| 1 | Visual Identity — 視覚設計・品質契約 | **100%** | Reality 55 : Anime 45, physical/artistic principles, material/lighting/atmosphere/water requirements and reference-scene rubric |
| 2 | Graphics Architecture — 独立アーキテクチャ | **50%** | Vendor-neutral contracts, backend adapter model, HAL lifecycle/fallback, engine facade and architecture tests |
| 3 | Graphics Core — 独自グラフィックスコア | 0% | PStudio-owned renderer, resource, shader, compute and lighting core implementations |
| 4 | Render Graph — 描画依存グラフ | 0% | Declarative passes, resource edges, scheduling, transient lifetime and barriers |
| 5 | Native Renderer — ネイティブ描画基盤 | 0% | Native runtime and API backends where platform/runtime support is deliberately provided |
| 6 | Rendering Quality — 描画品質基盤 | Existing assets; formal phase pending | PBR, shadows, indirect lighting, color management and material response |
| 7 | Atmosphere & Sky — 大気・空 | Existing assets; formal phase pending | Sky radiance, atmosphere, weather, volumetrics and coherent IBL |
| 8 | Advanced Water — 高度な水面 | Existing assets; formal phase pending | Reflection, refraction, absorption, depth, wave spectrum and temporal stability |
| 9 | World Rendering — ワールド描画 | Existing assets; formal phase pending | Terrain, foliage, world visibility, LOD, streaming and material scale |
| 10 | Advanced Graphics — 高度な描画技術 | Existing assets; formal phase pending | GPU VFX, advanced GI, clustered lighting and volumetric effects |
| 11 | PVCS Integration — 視覚補償・性能配分 | Foundation only; allocator pending | Evidence-based quality/cost selection and reversible runtime allocation |
| 12 | Three.js Independence — Three.js独立 | 0% | Replace implementation dependencies only after parity, compatibility and migration gates |

The percentages describe progress toward the independent-engine target, not the maturity of all existing rendering features. Phases marked "existing assets" must not be interpreted as phase completion.

## Phase 0 — Foundation (100%)

### Completed scope

- PVCS analysis mode and monitoring-off-by-default behavior.
- Separate CPU, GPU, asynchronous and memory metric domains.
- CPU-stage instrumentation, sparse WebGL2 GPU render-path sampling and honest WebGPU timing boundaries.
- Context-aware rankings, sample counts, late-result/session guards and no-op fast paths while monitoring is disabled.
- Explicitly caller-supplied RGBA still/temporal comparison utilities; no automatic framebuffer readback in the live render loop.
- Regression tests for graph behavior, lifecycle, context separation, measurement-off behavior and rendering integration.
- CI-backed repository verification and current documentation of measurement limitations.

### Completion boundary

Phase 0 is complete at source, architecture, tests and CI level. A named-device benchmark is explicitly outside the user's requested progress axis. The absence of device data must not be replaced with invented performance results. Actual bottleneck ranking remains "not measured" until a machine/browser supplies valid samples.

## Phase 1 — Visual Identity (100%)

### Completed scope

- Reality 55 : Anime 45 written as a whole-image art-direction principle.
- Physical coherence, artistic treatment, temporal stability and preservation of established assets.
- Explicit requirements for PBR, shadows, SH/probe GI, atmospheric scattering, height fog, HDR IBL, Fresnel, Beer–Lambert absorption, refraction, multi-scale waves and material identity.
- Cinematic compensation rules tied to PVCS and visual-quality preservation.
- Shrine/water reference-scene review set, repeatable capture inputs and separate physical/artistic/consistency/temporal/performance rubric.

### Completion boundary

Phase 1 completes the visual contract. It does not claim that every listed effect is already implemented or that any unperformed visual capture has passed. No renderer default or appearance is changed by completing this specification phase.

## Phase 2 — Graphics Architecture (50%)

### Completed half

- Backend-neutral graphics API version and backend identifier set.
- Immutable backend descriptors, feature declarations and frame context.
- Adapter validation.
- HAL registry, backend preference/order, required-feature filtering and explicit fallback state.
- Initialization cancellation, generation guards and disposal of late-created resources.
- Vendor-neutral engine facade and regression tests.
- A documented dependency direction that prevents the contract/HAL/facade from importing Three.js or browser globals.

### Remaining half

- PStudio-owned scene/view/material/resource and command-buffer contracts.
- Explicit WebGL2 and Three.js WebGPU adapter wrappers.
- Device/context loss and synchronization ownership.
- Resource/shader/compute/lighting ownership mapping.
- Migration matrix from current PStudio3D + Three.js APIs.
- Compatibility-preserving integration of the HAL into the production renderer host.

Phase 2 reaches 100% only when the current production paths can be represented behind the PStudio adapter contracts without changing visible production behavior, and rollback/recovery tests cover the hand-off.

## Delivery and rollback discipline

1. Work on a dedicated feature branch based on the current main commit.
2. Preserve a named backup branch at the exact pre-change main SHA.
3. Add contract tests before production integration.
4. Run the full repository CI and inspect changed files and merge diff.
5. Integrate by reviewed PR; do not rewrite shared main history.
6. If a regression appears, revert the merge commit or restore the backup branch. Keep the production renderer path unchanged until its adapter migration is independently validated.

## Next implementation order

1. Finish Phase 2's PStudio-owned Scene/View/Material/Resource contracts.
2. Add adapter wrappers for the existing WebGL2 and WebGPU paths while keeping the WebGL2 visible default.
3. Define PStudio Graphics Core ownership for renderer, resources, shader, compute and lighting.
4. Start Phase 3 only after contracts and adapter boundaries are stable.
