# PStudio Graphics Work — Rollback Record

**Change set:** Phase 11 PVCS governor/reversible frame-budget overlay and Phase 12 legacy Three.js adapter boundary  
**Pre-change main:** acf5816cd16381569b8d7b672d0d91fbc05d9a45  
**Backup branch:** backup/pre-phase11-12-20261128  
**Work branch:** feat/phase11-pvcs-phase12-three-independence-20261128

## Recovery guarantees

- The backup branch points to the exact main commit before this work.
- Native runtime, SDL3 GPU adapter, World Rendering and Advanced Graphics files are additive. Existing production renderer, Three.js integration, editor/gameplay APIs, quality defaults, sky panorama, PMREM/IBL, water reflection, depth and authored shader files are not altered by this change.
- WebGL2 remains the live production renderer. The WebGL2 adapter wraps the existing renderer and does not dispose it unless the caller explicitly transfers ownership.
- The WebGPU adapter wraps the existing TSL scene session. It does not promote WebGPU to the visible production path.
- The SDL3 native adapter is optional and is not selected by the browser application. World and Advanced Graphics systems are executor-driven and opt-in; they do not mirror or double-register resources owned by PStudioResources or Three.js.

## Rollback procedure

1. Prefer reverting the integration merge commit through a new PR.
2. To inspect the exact pre-change repository, check out backup/pre-phase5-9-10-20261128 at 19e2a0dc1bb3159f869b4c92c7dddd4649f4f4b8.
3. If individual core services regress, stop instantiating the new modules; current production rendering does not import them.
4. Never force-push or reset shared main history.

The backup branch is a repository recovery point; it is not an automatic website/deployment rollback.


## Native / World / Advanced phase boundaries

- Phase 5's SDL3 adapter provides native Vulkan, Direct3D 12 and Metal **graphics** backend selection and compile-tested implementations for the configured platform builds. It currently reports Compute unsupported; do not infer native Compute support from Phase 5's 100% status.
- Phase 9 and Phase 10 modules are additive, executor-driven and not connected automatically to production scenes.
- CI compiles the SDL3 adapter on Linux, Windows and macOS without creating a physical GPU device/window. Hardware output, visual parity and performance remain unmeasured.


## Phase 11 and 12 safety boundaries

- PVCS remains analysis-only until a candidate is explicitly registered with same-context A/B P95 evidence, visual-difference metrics and temporal-delta limits.
- Automatic quality actuation is disabled in the browser bootstrap. A compensation is explicit, bounded, single-transaction and reversible.
- The additive frame-budget overlay never disables premium effects, changes quality presets, alters authored sky/water content or replaces the base frame-budget calculation.
- PStudio Graphics Core / Render Graph / PVCS / World / Advanced modules remain independent of Three.js. The optional legacy WebGPU adapter resolves Three.js r187 lazily.
- The production 3D engine, TSL modules, GLTF/BVH path and editor integration still depend on Three.js. Do not remove three or three-mesh-bvh, and do not switch production rendering in this phase.
