# PStudio Graphics Work — Rollback Record

**Change set:** Independent Graphics Engine Phase 5 native presentation contract and Phase 9–10 subsystem foundations  
**Pre-change main:** 19e2a0dc1bb3159f869b4c92c7dddd4649f4f4b8  
**Backup branch:** backup/pre-phase5-9-10-20261128  
**Work branch:** feat/graphics-phase5-100-phase9-10-100-20261128

## Recovery guarantees

- The backup branch points to the exact main commit before this work.
- New World Rendering, Advanced Graphics and presentation-contract files are additive. Existing production renderer, Three.js integration, editor/gameplay APIs, quality defaults, sky panorama, PMREM/IBL, water reflection, depth and shader files are not altered.
- WebGL2 remains the live production renderer. The WebGL2 adapter wraps the existing renderer and does not dispose it unless the caller explicitly transfers ownership.
- The WebGPU adapter wraps the existing TSL scene session. It does not promote WebGPU to the visible production path.
- The new Graphics Core, World Rendering and Advanced Graphics modules are opt-in. They do not mirror or double-register resources owned by PStudioResources or Three.js.

## Rollback procedure

1. Prefer reverting the integration merge commit through a new PR.
2. To inspect the exact pre-change repository, check out backup/pre-phase5-9-10-20261128 at 19e2a0dc1bb3159f869b4c92c7dddd4649f4f4b8.
3. If individual core services regress, stop instantiating the new modules; current production rendering does not import them.
4. Never force-push or reset shared main history.

The backup branch is a repository recovery point; it is not an automatic website/deployment rollback.

The native presentation addition is a backend-neutral contract only. It does not add or activate Vulkan, Direct3D 12 or Metal devices. Phase 9 and 10 utilities remain opt-in and do not change production scene rendering.
