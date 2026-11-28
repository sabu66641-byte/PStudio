# PStudio Graphics Work — Rollback Record

**Change set:** Independent Graphics Engine Phase 2 completion and Phase 3 core foundation  
**Pre-change main:** d2f1172ad78c5c6229602e87b415c532184f7ccb  
**Backup branch:** backup/pre-phase2-3-20261128  
**Work branch:** feat/graphics-phase2-100-phase3-50-20261128

## Recovery guarantees

- The backup branch points to the exact main commit before this work.
- New adapter and core files are additive. Existing production renderer, Three.js integration, editor/gameplay APIs, quality defaults, sky panorama, PMREM/IBL, water reflection, depth and shader files are not altered by the new architecture.
- WebGL2 remains the live production renderer. The WebGL2 adapter wraps the existing renderer and does not dispose it unless the caller explicitly transfers ownership.
- The WebGPU adapter wraps the existing TSL scene session. It does not promote WebGPU to the visible production path.
- The new Graphics Core is opt-in. It does not mirror or double-register resources owned by PStudioResources or Three.js.

## Rollback procedure

1. Prefer reverting the integration merge commit through a new PR.
2. To inspect the exact pre-change repository, check out backup/pre-phase2-3-20261128 at d2f1172ad78c5c6229602e87b415c532184f7ccb.
3. If individual core services regress, stop instantiating the new modules; current production rendering does not import them.
4. Never force-push or reset shared main history.

The backup branch is a repository recovery point; it is not an automatic website/deployment rollback.
