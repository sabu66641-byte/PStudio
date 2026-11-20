# PStudio Architecture and Audit Notes

This document records the current repository structure and the responsibilities of each subsystem. It is intended to be the shared technical reference for future PStudio work. Update it whenever an API contract, ownership boundary, or execution path changes.

## Product direction

PStudio is a general-purpose game development environment. Its core is not tied to a particular game, IP, genre, or combat system. The intended scope includes 2D and 3D games, action games, RPGs, simulations, puzzle games, visual novels, and large-world projects.

Core engine systems belong in PStudio. Game-specific experiments and reference rules must remain outside the default runtime unless they are deliberately generalized and reviewed.

## Two separate ps execution paths

### Normal ps programs

`templates/index.html` sends source code to Flask `/run` or `/compile`.

`app.py` owns the normal language pipeline:

1. `tokenize()` creates indentation-aware tokens.
2. `parse()` builds the ps AST.
3. `validate_ast()` checks the AST and allowed built-ins.
4. `generate_cpp()` emits C++17.
5. `/run` compiles with `g++ -std=c++17` and executes a temporary binary.
6. `/compile` returns generated C++ without executing it.
- Branch/loop-assigned variables are hoisted into their owning C++ function scope using checked optional storage; an unset value raises a runtime error rather than becoming an invalid out-of-scope reference.
- C++ range-loop variable types use iterator `value_type`, including proxy iterators such as `std::vector<bool>`.
- ps division uses floating-point semantics in both the C++ and Discord interpreter paths; prefix increment/decrement update their target in the Discord interpreter.

The normal ps path and the browser game-script path are intentionally distinct. Do not add game-only APIs to normal C++ generation without defining their C++ semantics.

### Browser game scripts

When Play is pressed, `static/pstudio_engine.js` sends the project's ps scripts to `/game/prepare`.

`app.py` parses and validates those scripts with `allow_game=True`, then returns ASTs. The browser runtime executes the ASTs locally:

- `start()` runs once per attached Game Object when a game starts.
- `update(dt)` runs from the browser animation loop.
- `on_collision(other)` is dispatched on collision-enter.
- Game state is kept per object in the runtime maps.

Do not send a server request every frame. Preserve the division between server-side parsing/validation and client-side game execution.

## Repository map

### Server and language

- `app.py`: Flask routes, ps lexer/parser/validator, C++17 generator, game-script preparation, Discord-enabled normal ps interpreter, process limits.
- `discord_runtime.py`: Discord REST and Gateway client implementation.
- `network.py`: standalone HTTP/HTTPS/JSON helper. It is not currently a browser game-script API.
- `requirements.txt`: Python runtime dependencies.
- `Procfile`: Gunicorn web-process entrypoint.

### IDE and game runtime

- `templates/index.html`: IDE, navigation, project explorer, source editor, scene view, Inspector, asset import, project backup, language switching.
- `static/pstudio_engine.js`: 2D preview, browser game-script interpreter, game lifecycle, input, render-command generation and game-loop scheduling.
- `static/pstudio_3d_engine.js`: Three.js renderer, GLTF/GLB loading, model instances, materials, camera controls, shadows, HDR/IBL, SH probes, UV lightmaps, LOD, BVH-accelerated CPU raycasts, occlusion, water, GPU particle rendering, instancing and world chunks.
- `static/pstudio_physics.js`: fixed-step physics, capsule character controller, static collision geometry and moving-platform state.
- `static/pstudio_ecs.js`: entity/component/system storage and scheduling; not yet the owner of all existing gameplay/physics/render state.
- `static/pstudio_gameplay.js`: generic combat helpers, simple enemy state AI, inventory, quests, dialogue and navigation helpers.
- `static/pstudio_game_ui.js`: in-game HUD and DOM panels.
- `static/pstudio_assets.js`: IndexedDB-backed binary model-asset storage.

### Shared infrastructure

- `static/pstudio_events.js`: namespaced event dispatch and subscriptions.
- `static/pstudio_platform.js`: browser capability, storage and scheduling facade.
- `static/pstudio_jobs.js`: cooperative asynchronous job queue. It is not a Web Worker pool; synchronous CPU work still blocks the main thread.
- `static/pstudio_modules.js`: dependency-aware module registry. Most engine scripts are still loaded as core scripts, not dynamically unloaded modules.
- `static/pstudio_resources.js`: CPU/GPU resource registry, leases, LRU accounting and budget trimming. Its counters are not total browser or physical GPU memory measurements.

### Examples, references and tests

- `examples/`: small 2D and 3D RPG sample scripts and a starter scene.
- `archive/`: intentionally unloaded experimental reference material. It is not part of PStudio Core.
- `tests/`: Python, C++17 integration, and Node.js regression suites.
- `.github/workflows/ci.yml`: automated test workflow for pushes and pull requests.

## Core runtime ownership boundaries

- The IDE owns project serialization, selected object state, Inspector fields and calls into the renderer.
- The game runtime owns ps callback state and emits frame render commands.
- The 3D renderer owns Three.js resources and rendering caches.
- The physics module owns fixed-step body state and collision calculations.
- ECS is integrated with scene entities and system iteration but is not yet a full migration of every legacy subsystem.
- The resource manager can coordinate registered resources, but it does not intercept every Three.js allocation or track total device memory.

Keep these boundaries explicit. Avoid silently duplicating ownership of transforms, physics bodies, model resources, or game state.

## Rendering and physics contracts

### Rendering

- Preserve source GLTF materials and their textures unless an explicit material override or supported lighting feature requires a controlled change.
- Preserve animation clips, skinning, hierarchy, morph data and model transforms.
- Keep quality features enabled according to the selected quality profile; do not mask performance problems by silently downgrading quality.
- Automatic LOD must retain the source geometry and must not override explicit named GLTF LODs.
- Occlusion is optional CPU ray-based visibility testing accelerated by BVH when available; it is not hardware GPU occlusion queries.
- Spatial SH probe GI and its iterative diffuse bounces are approximations, not physically complete dynamic path tracing.
- UV lightmaps use a per-triangle atlas and probe-derived diffuse irradiance. They are not a seam-aware UV unwrap or full direct-shadow bake.
- World chunk streaming currently follows the 3D camera path; a generic 2D partition scheduler is not yet implemented.

### Physics

- Physics uses a fixed simulation step with a bounded accumulator.
- The character controller is capsule-focused and does not claim to be a fully general rigid-body solver.
- Static collision includes planes, boxes, triangle colliders, generated terrain and sampled GLB model triangles.
- Moving-platform state must be discarded when the platform/collider leaves the active scene.
- Static terrain/model collider geometry should be cached when its source geometry and transform are unchanged, then pruned when no longer active.

## Server execution safeguards

Current limits in `app.py`:

- HTTP request body: 2 MiB.
- Normal ps source: 512 KiB.
- Normal ps stdin: 128 KiB.
- Concurrent `/run` requests per Python process: 2.
- C++ compilation timeout: 30 seconds.
- Program execution timeout: 30 seconds.
- Captured stdout: 1 MiB.
- Captured stderr: 256 KiB.
- Discord send message: 2,000 characters.
- Discord REST success response: 16 MiB by default (configurable per request); Discord error response: 64 KiB.
- Discord interpreter: 100,000 AST/loop steps per top-level execution and 1 MiB accumulated output.
- The Discord interpreter step budget is shared across nested function calls and resets for each top-level run/event callback.

These measures bound inputs, runtime duration, captured output and in-process concurrency. They do **not** create an operating-system sandbox, memory cgroup, syscall filter, or network isolation for generated binaries.

## Current high-priority risks and boundaries

These are audit findings to keep visible rather than silently implying they are solved:

1. **Discord multi-user isolation (P1):** REST Discord routes use a process-global `discord_bot`; the normal ps Discord interpreter separately uses process-global `_ps_discord_bot` and `_ps_discord_handlers`. These two Bot paths are not per-user and are not unified. The REST endpoints have no authentication or ownership check. On a publicly shared deployment, visitors can interfere with the REST Bot state, and the two control paths can report/control different Bot instances. A per-user ownership/authentication model is required before treating Discord features as safe for multi-tenant public hosting.
2. **Normal C++ process isolation (P1):** source generation is constrained by the ps grammar and the child process has time/output caps, but it is not isolated with OS-level memory, filesystem, syscall or network restrictions. Do not treat the endpoint as a hostile multi-tenant code sandbox.
3. **Network runtime reachability:** `network.py` has URL/timeout/response-byte validation but no explicit private-network/SSRF destination policy. It is not currently exposed through the normal built-in allowlist or browser game-script API. Re-audit before integrating it.
5. **Browser validation:** source/Node tests do not replace real WebGL, Android touch input, IndexedDB quota, GLTF texture loading, Render deployment or browser GPU validation.
6. **World-scale limitations:** physics and chunk streaming have documented constraints; avoid advertising them as a complete general physics engine or a fully generalized 2D/3D world streaming system.

## Test commands

From the repository root:

```bash
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests/*.test.js
```

The GitHub Actions workflow runs both suites. Python tests include actual generated C++17 compilation/execution when `g++` is installed. Passing these suites does not establish Android/WebGL or Render deployment correctness.

## Change discipline

For future modifications:

1. Fetch the current file and SHA before editing.
2. Identify the owning subsystem and its public API/compatibility contract.
3. Reproduce the bug or add a focused regression test first.
4. Make the smallest change that fixes the root cause without reducing quality.
5. Run the relevant focused tests and the complete CI suite.
6. Inspect the resulting commit and current branch state.
7. Record limitations and untested environments honestly.
8. Keep this document and README aligned with the actual code.
