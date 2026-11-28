# PStudio Graphics Work — Rollback Record

**Change set:** Independent Graphics Engine Phase 5 native GPU backends and Phase 9–10 subsystem foundations  
**Pre-change main:** 19e2a0dc1bb3159f869b4c92c7dddd4649f4f4b8  
**Backup branch:** backup/pre-phase5-9-10-20261128  
**Work branch:** phase-5-native-gpu-backends

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
