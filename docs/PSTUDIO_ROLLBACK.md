# PStudio Graphics Work — Rollback Record

**Change set:** Independent Graphics Engine Phase 0–2 foundation  
**Pre-change main:** `5f6ab6db674268a87b857103456837dfc77c57d9`  
**Backup branch:** `backup/pre-independent-graphics-20261128`  
**Work branch:** `feat/independent-graphics-phase0-2-20261128`

## Recovery guarantees

- The backup branch points to the exact main commit before this work.
- Phase 0/1 changes update documentation and tests only; they do not alter renderer defaults or scene appearance.
- Phase 2 adds isolated vendor-neutral modules. Existing production rendering code, Three.js imports, visible WebGL2 default, sky assets and water shaders are not replaced.
- Do not force-push or reset shared `main` history.

## Rollback procedure

1. Prefer reverting the integration merge commit through a new reviewed PR.
2. If the merge cannot be reverted cleanly, branch from `backup/pre-independent-graphics-20261128` and compare the result before restoring any files.
3. Keep the backup branch until the new engine contracts have been exercised by a real production adapter and the following phase has passed its CI gates.

The backup branch is a recovery point, not a deployed rollback. It does not change the live website until the repository's deployment mechanism publishes a commit.
