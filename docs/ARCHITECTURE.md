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
- ECS `ScriptLifecycle` and `ScriptState` Components own per-object script lifecycle and global variables; `ScriptSystemState` owns per-Entity `.ps` System locals. The runtime service continues to execute ASTs and schedule browser callbacks.

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
- `static/pstudio_3d_engine.js`: Three.js renderer, GLTF/GLB loading, model instances, materials, camera controls, shadows, HDR/IBL, preset-driven solar elevation, moonlight, Rayleigh/Mie physical sky, twilight enhancement and procedural fallback, adaptive height-aware volumetric fog/clouds, depth-aware PBR water plus an isolated, downscaled planar Mirror Water reflection pass, SH probes, UV lightmaps, LOD, BVH-accelerated CPU raycasts, occlusion, GPU particle rendering, instancing and world chunks.
- `static/pstudio_physics.js`: fixed-step physics, capsule character controller, static collision geometry and moving-platform state.
- `static/pstudio_ecs.js`: ECS Entity/Component storage, typed schemas, persistent Scene Component serialization, lifecycle bridging and deterministic System scheduling.
- `static/pstudio_ecs_*.js`: domain bridges for Input, Audio, Collision, Gameplay, Physics, Rendering, Streaming, Time, UI, VFX, Materials, Scene, Script, Modules and Inspector; these adapt ECS state to the existing platform, renderer and editor services.
- `static/pstudio_gameplay.js`: retains the public ps gameplay API and no-ECS fallback; while ECS is available, the compatibility surface delegates migrated state and definitions to `PStudioECSGameplay`.
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
- `draw_mirror_water` is a browser game-script API (5–7 arguments) and remains separate from the legacy `draw_water` command; the IDE's persistent Mirror Water object uses the same renderer command path. The scene viewport exposes independently persisted Grid, Axes and Origin overlays; editor helpers are hidden during Play and excluded from planar water reflections.
- The 3D renderer owns Three.js resources and rendering caches.
- `PStudioPhysics` retains fixed-step integration, contact generation and collision resolution; ECS `PhysicsBody` owns persistent body configuration while `PhysicsState` / `PhysicsTransform` expose gameplay-facing runtime snapshots.
- ECS is authoritative for migrated game-world Entity/Component state and deterministic gameplay Systems. Scene Object/project adapters and public ps APIs remain compatibility surfaces; the no-ECS fallback remains available when the bridge is unavailable. GPU/Three.js resources, DOM, asset storage, async jobs and browser frame scheduling remain service-owned.
- The resource manager can coordinate registered resources, but it does not intercept every Three.js allocation or track total device memory.

Keep these boundaries explicit. Avoid silently duplicating ownership of transforms, physics bodies, model resources, or game state.

## Rendering and physics contracts

### Rendering

- The visible scene-editor sky is a 2048×1024 preset panorama with aligned solar direction, layered day/dusk cirrus, and a detailed night Milky Way/star/moon treatment. Night uses seam-safe multi-octave noise for galactic filaments and dust lanes with a slightly darker blue-black base; nebula generation is half-resolution before upscaling. Static and volumetric cloud layers are disabled in studio mode; decorative cloud banks are restricted to day/dusk. Day/dusk/studio retain the Three.js Rayleigh/Mie Sky model for PMREM lighting only, with a sky-local exposure compensation; the global renderer exposure is not reduced. A matching panorama PMREM is the fallback. The distant ground grid adapts density/opacity and safely disposes its material array; editor orbit stays above the ground plane while gameplay camera motion retains its wider pitch range.
- Regular baked SH probe volumes are stored in x-fastest grid order and sampled with trilinear interpolation; sparse/legacy probe sets use the bounded inverse-distance fallback. Per-object SH blends are cached and recomputed only after object movement or a probe-generation change.
- The optional Dynamic GI switch requires a baked SH probe volume. It incrementally captures one probe at a time from existing dynamic point/spot lights using a CubeCamera and LightProbeGenerator, then adds those SH coefficients to the static probe field. This is a raster-captured, one-bounce diffuse-light approximation, not hardware ray tracing, full DDGI, or complete multi-bounce dynamic GI. Capture cadence is headroom-aware and implemented in the separate `pstudio_rendering_gi.mjs` runtime module. Light changes dirty only probes inside the old/new light influence regions; captured SH coefficients are temporally blended in place, and removed-light contributions fade out before being retired. The module owns pure, GPU-independent probe scheduling and SH smoothing helpers so these rules stay small and unit-testable independently of the renderer. Ultra uses a 192px cube capture while lower profiles use smaller targets; at most one probe capture is serviced per main render frame.
- Rendering telemetry exposes frame interval/FPS estimates, frame p95, CPU render-submission time, GPU timer-query time when available, draw calls, triangles, geometry/texture counts and estimated resource memory. GPU timer-query support depends on `EXT_disjoint_timer_query_webgl2`; CPU render-submission time is not total CPU frame time, GPU memory figures are resource-registry estimates, and GPU frame-budget percentage is not total GPU utilization.
- Per-frame render counters and CPU/GPU render timings are snapshotted before the optional off-screen Dynamic GI CubeCamera capture. The capture can still affect observed frame pacing, but it is excluded from main-scene render-submit/GPU timing and draw-call counters.
- Continuous dynamic resolution is driven by fresh asynchronous GPU timer-query samples when available. If GPU timing is unavailable, disjoint or stale, it falls back to visible-page frame pacing while rejecting background-tab pauses, initial frames and long scheduling stalls. Both sources adjust drawing-buffer resolution inside bounded limits without silently disabling quality effects; the active source is exposed in performance diagnostics.
- Post-processing failures use a fail-open policy: a failing God Rays pass first retries through the existing Bloom fallback; if the composer still fails, the renderer switches to direct scene rendering instead of propagating the post-processing exception. The fallback state and bounded error reason are exposed in render statistics. Reapplying a quality preset or explicitly changing a post-processing effect retries the composer; a failed composer is not retried every frame.
- The WebGPU compatibility lab consumes shared `pstudio_rendering_backend.mjs`, `pstudio_rendering_materials.mjs`, and `pstudio_rendering_pipeline.mjs` modules. The backend module performs asynchronous initialization and rejects the internal WebGL 2 fallback; the material converter maps legacy standard/physical PBR state into r187 NodeMaterials while detaching unsupported GLSL hooks; the TSL pipeline composes scene color and Bloom in `RenderPipeline`. The lab still runs on its own canvas and does not mutate the production editor scene or renderer. This is the first shared backend/material/pipeline integration stage; custom terrain, water, foliage, clustered lighting, SH, mirror reflection, fog, cloud and other GLSL hooks remain on the production WebGL2 path until their TSL equivalents are ported and validated.
- The production renderer has been upgraded from Three.js r160 to the released r187 while retaining `WebGLRenderer` on WebGL 2. The import map pins the matching r187 core, addons, TSL entry and WebGPU entry; the `three/webgpu` and `three/tsl` modules are exposed as optional prototype dependencies. r187 does not expose the `WebGLRenderer.setNodesHandler()` bridge, and the old limited `WebGLNodeBuilder` path was removed in r164, so TSL Node Materials are not enabled on the production WebGL renderer. The existing `ShaderMaterial`, `onBeforeCompile` customizations and `EffectComposer` passes remain on the WebGL path. `WebGPURenderer` is not yet the production backend: its custom-material and post-processing contracts require dedicated TSL/NodeMaterial and RenderPipeline ports plus visual/performance parity testing before switching. The module GLTF worker uses a self-contained r187 ESM bundle for GLTFLoader and r187-matched Meshopt, KTX2 and Draco modules because workers do not inherit the page import map; its transferred material packet now carries r187 iridescence min/max values and still accepts the older range representation. The renderer uses r187's cube-render-target PMREM implementation for room, procedural-sky and HDR image-based lighting. GLTF worker serialization/hydration also carries r187 `diffuseRoughness` and `diffuseRoughnessMap` values; the Inspector exposes EON rough-diffuse strength as an opt-in per-material override (default 0) so existing assets keep their prior appearance. The import-map entry is checked against `THREE.REVISION` at startup so a cached or mismatched core cannot silently enter the production renderer.
- Generated terrain meshes use a dedicated height/slope/noise PBR shader layer. It is attached only to the procedural terrain material path; imported GLTF material preservation and existing water/foliage shader hooks remain separate.
- The Three.js dependency smoke suite imports the installed r187 core, GLTF/loader and post-processing addons, the TSL and WebGPU entry points and `three-mesh-bvh` before the JavaScript regression suite. This validates package exports and module loading but does not replace real-browser rendering or Android GPU profiling.
- The BVH accelerator is pinned to `three-mesh-bvh` 0.9.18; geometry builds use the current `targetLeafSize` option rather than the deprecated `maxLeafTris` name.
- High/ultra quality profiles enable GTAO when the addon is available. Shadow-map allocation is capped by the active WebGL `MAX_TEXTURE_SIZE` and device-memory class, including during adaptive quality changes.
- Foliage standard/physical materials add a directional, double-sided backlight transmission term using the existing `directionalLights` uniforms. The feature is material-local, keeps the original wind deformation hook, and can be tuned through GLTF `userData` extras.
- Contact shadows are a depth-aware, short-range screen-space ray march using the renderer's existing depth prepass. They are enabled by default for high/ultra profiles, disabled on mobile/balanced, obey adaptive/memory safety, and can be overridden with `PStudio3D.setContactShadows`. This effect is limited to visible depth data and is not a replacement for CSM or a full ray-traced shadow solution.

- Preserve source GLTF materials and their textures unless an explicit material override or supported lighting feature requires a controlled change.
- Preserve animation clips, skinning, hierarchy, morph data and model transforms. Generic automatic instancing only combines opaque, static, same-geometry/same-material nodes; animated ancestry, skinning, morph targets, transparent/transmissive materials, water/wind roles, custom shadow materials and baked per-object probe lighting are excluded.
- Generic repeated static nodes are grouped by geometry, material, stream chunk, render order, layer mask and shadow flags. Their transforms are stored relative to the owning model/stream chunk; their instance buffers use static usage. Explicit foliage/tree batches retain dynamic transforms and their existing update path.
- Keep quality features enabled according to the selected quality profile; do not mask performance problems by silently downgrading quality.
- Automatic LOD must retain source geometry and must not override explicit named GLTF LODs. Generated LOD levels are shared per source geometry and are owned/disposed with the cached model asset, not with an individual scene instance.
- BVH generation is deferred to browser idle time for sufficiently large geometry; small geometry is left on normal raycasting, and failed BVH builds are not retried continuously. Raycasting remains correct through the Three.js fallback.
- KTX2Loader/Basis Universal transcoding supports assets that already contain KHR_texture_basisu. It does not encode ordinary PNG/JPEG images into KTX2 at runtime; asset encoding is a separate import/build step and must not silently resample or discard source detail.
- Model import and GLB preparation emit phase/progress events. Progress is reported only where a real byte/item count exists; IndexedDB persistence is represented as a phase because the current browser storage API does not expose byte-level write progress.
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
4. **Browser validation:** source/Node tests do not replace real WebGL, Android touch input, IndexedDB quota, GLTF texture loading, Render deployment or browser GPU validation.
5. **World-scale limitations:** physics and chunk streaming have documented constraints; avoid advertising them as a complete general physics engine or a fully generalized 2D/3D world streaming system.

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


## GLTF asset display path

The asset UI stores GLB and bundled JSON glTF data in IndexedDB under the original asset name. GLB is decoded by `static/pstudio_gltf_worker.js`; JSON glTF is loaded by the renderer-compatible Three.js GLTFLoader using a Blob URL because the worker parser intentionally validates the GLB 2.0 binary header. The renderer then reconstructs/instances the scene, prepares textures, and renders it.

Worker hydration failures can use the main-thread GLTFLoader fallback when the input is not structurally invalid and the failure does not indicate memory exhaustion. Model errors are surfaced as `pstudio-model-error` events, with retry/status APIs owned by `PStudio3D`. The editor's “added to scene” message confirms scene registration only; it does not claim that asynchronous model loading or GPU preparation has completed.

## ECS Migration Reference

### Cinematic game-script APIs

The four Step 4 APIs remain browser-game-runtime-only and are registered in `GAME_FUNCTIONS` for `validate_ast(..., allow_game=True)`. They do not enter the regular C++17 built-in table:

- `camera_shake(intensity, duration)` delegates a bounded transient impulse to `PStudio3D.cameraShake()`; the renderer applies it only while drawing and restores the authored camera transform after the frame.
- `set_time_scale(scale)` sets the browser runtime's simulation multiplier. The scaled `dt` is shared by script callbacks, ECS, physics and render-command clocks; wall-clock browser APIs and audio playback are deliberately unaffected.
- `draw_trail(target_id, color, width, duration)` resolves a scene object by id or name and emits a world-space trail sample. The renderer owns bounded ribbon geometry and disposes expired/evicted effects.
- `set_god_rays(enabled, intensity)` toggles a screen-space ShaderPass before OutputPass. Missing or failed God Rays rendering falls back to the existing Bloom pass where available.

The trail pool is capped at 64 effects × 48 samples. The screen-space God Rays shader uses 20 texture samples per output pixel; desktop/mobile GPU compile, frame-time and visual equivalence checks remain real-device quality gates. A failed optional God Rays pass must not prevent the base renderer or other post-processing from running.

### ps ECS declarations and runtime bridge

The parser recognizes contextual top-level `component Name` and `system Name(ComponentA, ComponentB)` declarations without reserving those words as lexer keywords. Thus existing variables named `component` and `system` remain valid. Member access/assignment is represented by explicit AST nodes and validated against the declared Component fields. The browser runtime registers project Components and Systems with `PStudioECS`, then uses the existing scheduler and sparse-set iteration API.

The initial bridge policy attaches every declared custom Component to every Scene Game Object at Play start. System IDs are deterministically namespaced by source filename and declared system name. Component definitions and system references are validated across all .ps files in `/game/prepare`. Stop and failed-start paths unregister dynamic Systems, clear scene mirrors, then unregister custom Component types in dependency-safe order.

This stage does not replace legacy object scripts, PStudioPhysics ownership, renderer state, collision or gameplay systems. The built-in Transform is still synchronized between ECS and Scene Object fields. Native code generation must preserve the same Component schemas and System ordering without implying that JavaScript renderer/physics backends have been ported.

### Native build boundary

The normal `/compile` path continues to generate C++17 for the existing console-program subset. Browser game ASTs also contain renderer, input, asset and physics calls whose semantics currently live in JavaScript/Three.js, so they are not passed wholesale to `generate_cpp()`. `/native/ecs/export` is a separate project-level generator: it validates Component/System declarations across `.ps` files and packages a constrained C++17 ECS runtime, generated Component structs/System callbacks, a sample `main.cpp` and CMake build files. The current native System subset supports member data access/assignment, local scalar values, arithmetic/logical expressions, conditional/while/range loops, `len` and `range`. Unsupported game APIs or helper calls are rejected during export. The generated CMake package can be built with a local Windows/macOS C++17 toolchain or Android NDK CMake toolchain, but it is an ECS module/sample executable rather than a complete game. Native rendering, GLB loading, input/audio, physics and broader gameplay backends remain necessary before complete `.exe`, `.app` or APK game exports can be claimed.

## ECS and Physics frame contract

For each runtime frame:
1. Run ECS Systems in the `update` phase.
2. Run `prePhysics` Systems to create/configure bodies from ECS PhysicsBody Components.
3. Run the existing per-Scene-Object ps callbacks and generate render/Physics commands.
4. Run ECS `postUpdate` Systems. The gameplay AI Controller evaluates AI state and writes MovementIntent; the Movement Intent Resolver applies it to Physics before simulation.
5. Run the fixed-step `PStudioPhysics.step()` solver.
6. Run ECS `postPhysics` Systems to copy PhysicsState and PhysicsTransform snapshots from the solver.
7. Update collision events and render.

`Transform` is synchronized with existing Scene Object fields, which include the editor's 2D pixel coordinate convention. Physics body positions are world units and are exposed through `PhysicsTransform` instead. This split is intentional until a single explicit world-transform conversion layer is adopted. Do not write Physics world-space positions directly into Scene Object Transform fields.

The built-in `Velocity` System integrates non-Physics entities into ECS Transform. Entities with a PhysicsBody are excluded so the generic velocity integrator cannot compete with the fixed-step solver. PhysicsState and PhysicsTransform are runtime-only/read-only Components and are not serialized into the project.

## Incremental gameplay-state migration

The legacy `PStudioGameplay` API remains the compatibility surface for existing ps built-ins. While Play is active, the per-Scene-Object `Health`, `Inventory`, `Equipment`, `CombatState`, `AIController` and `MovementIntent` data are stored in runtime-only ECS Components. Quest progress is stored in standalone ECS entities with `QuestProgress`; the active conversation is stored in a singleton `DialogueSession`. These Components are not serialized into editor scene objects.

The existing API names and their result types remain in place. It routes HP, inventory, equipment, cooldown, combo, quest and dialogue reads/writes to ECS when a matching Scene Object/runtime is active. At Stop, the bridge snapshots state into a compatibility store and removes standalone quest/dialogue entities before Scene Object ECS teardown; the next Play restores those snapshots. The compatibility store is not an active second writer during a Play session.

AI decisions are evaluated by the ECS `gameplay.ai-controller` System in the `postUpdate` phase. It writes `MovementIntent`; `gameplay.movement-intent` then applies the intent to the existing Physics controller before the fixed-step solver. The `gameplay.combat-state-maintenance` System expires old per-target cooldown records. Physics still owns its solver, item/weapon/quest definitions remain configuration data in the Gameplay service, and `PStudioUI` continues to own DOM presentation. Navigation node coordinates, links, blocked state and A* next-node queries are ECS-owned by standalone `NavigationNode` Entities; the Gameplay API only provides compatibility wrappers and graph-building helpers. This is an incremental state/runtime migration, not a claim that every gameplay subsystem or infrastructure service has become ECS.

## ECS World Streaming Bridge

- `WorldPartition` is a persistent Scene Object Component describing a region center, load/unload radii, explicit member Scene Object IDs and model assets to preload.
- `StreamingInterest` is a persistent Component for a moving or fixed world position. Multiple interests are supported, with per-interest priority and independent load/unload multipliers.
- ECS snapshot Systems run in `postUpdate`; `PStudioECSStreaming.sync()` updates region registration, member assignments and the interest list before Physics and rendering consume owner activation state.
- `PStudio3D` remains the owner of asynchronous model requests, generation tokens, chunk activation/suspension, GPU resource leases, cache eviction and mesh/model disposal. ECS never owns promises or renderer resources.
- Chunk re-registration updates a stable record rather than replacing it. Asset-set changes invalidate the prior generation, preserve assets shared with the replacement configuration and ignore stale async completions. Load scheduling combines multiple interest points and respects a bounded concurrent-load budget.
- Stop clears ECS streaming registrations and interest points before renderer teardown. Persistent Component data remains stored on Scene Objects and is restored on the next Play.


## ECS Visual FX Configuration Bridge

- Persistent `Environment`, `Fog`, `Water`, and `PostFX` Components describe scene-level rendering configuration; `ParticleEmitter` and `Trail` Components describe per-Scene Object effects.
- `PStudioECSVisualFX` snapshots these values through ECS Systems and translates them into the existing renderer command stream before Physics.
- `PStudio3D` remains the exclusive owner of water materials/shaders, environment textures, post-processing passes, particle simulation/buffers and trail geometry/disposal. ECS stores no Three.js objects or GPU handles.
- Legacy ps rendering built-ins remain supported. Global Environment/Fog and PostFX Component commands are inserted before script-authored commands so existing ps script overrides retain precedence.
- One-shot `emit_particles` remains a transient command, not a persistent Component; `PStudioUI` continues to own DOM presentation.


## ECS UI Intent Bridge

- A singleton `UIOverlay` Component stores which gameplay overlay is currently active (inventory, quests or dialogue) and its optional Scene Object owner.
- `PStudioGameplay` reads/writes overlay intent through `PStudioECSUI`; Game Stop clears the transient Component.
- `UIOverlay` is internal and non-persistent: it is not written into project backups or scene files.
- `PStudioUI` continues to own DOM elements, buttons, layout, accessibility and actual display. ECS does not create or retain DOM nodes.


## ECS Module Lifecycle Mirror

- Each registered `PStudioModules` entry is mirrored by a standalone runtime-only `ModuleState` Entity.
- The bridge listens to registration, state-change, enabled, disabled and unregistration events; it also rebuilds the mirror from the registry on synchronization.
- `PStudioModules` remains authoritative for dependency resolution, conflict checks, async activate/deactivate callbacks, rollback and unregister guards. ECS does not run module hooks or own module resources.
- Module state Components are internal and non-persistent; they are not written into scenes or project backups.


## Versioned ECS Scene Component Persistence

- Scene Objects store persistent ECS data as `ecsComponentsVersion` plus an `ecsComponents` list.
- The current Component payload schema is version 1. Unversioned v0 arrays and type-keyed maps are migrated on load.
- Only persistent Components are serialized; transient runtime state such as `UIOverlay`, `ModuleState`, `PhysicsState`, `PhysicsTransform` and `AudioCommand` is excluded.
- Unknown future schema versions are left untouched and skipped by older runtimes rather than being silently downgraded.
- Scene Object position/rotation/scale remain in the existing project format; the core `Transform` and `SceneObjectRef` bridge Components are excluded from the Component payload to avoid duplicate persistence.


## ECS Gameplay Definition Entities

- `ItemDefinition`, `WeaponDefinition` and `QuestDefinition` are standalone ECS definition Entities, separate from per-Scene Object Inventory/Equipment/CombatState/QuestProgress state.
- Existing `PStudioGameplay.defineItem`, `defineWeapon` and `questDefine` APIs remain supported and write through to the ECS definition Components.
- Definition ID-to-Entity Maps are lookup caches only; definition records live in ECS.
- Definitions are runtime project configuration rebuilt by the existing ps definition calls. They are not automatically serialized into Scene Object data; project-authored data assets remain a separate content-authoring concern.


## Gameplay State and Session Persistence

- `Health`, `Inventory`, `Equipment`, `CombatState` and `AIController` are persistent Scene Object Components. On Game Stop, `PStudioECSGameplay` writes them through the same versioned `ecsComponentsVersion` serializer used by the Inspector; the legacy Map snapshot is no longer the normal persistence path.
- `QuestProgress` and `DialogueSession` are standalone, non-project-persistent ECS Entities. They remain in ECS across Game Stop/Play instead of being copied into `PStudioGameplay` Maps and reconstructed on the next start.
- `PlayerInput` stores durable per-entity key bindings and is serialized with its Scene Object. Its `ControlIntent` remains transient and is recreated by the PlayerInput Component lifecycle hook.
- A saved Scene Object with a newer unsupported Component schema is never overwritten by an older runtime. Unregistered Component records in the current supported schema are preserved for modules/plugins that are not loaded in the current session.


## Project Backup ECS Component Preservation

- Project backup import reconstructs a sanitized Scene Object model; it must explicitly copy `ecsComponentsVersion` and `ecsComponents`, otherwise all ECS-only gameplay/rendering/physics data would be silently lost.
- Legacy v0 array and type-keyed Component payloads are retained for the ECS core's migration path.
- Current supported Component payloads are copied with bounded per-object size/count limits.
- Newer future schema payloads are treated as opaque JSON and preserved without normalization or downgrade; older runtime restoration will skip them.


## ECS Rendering Authoring Configuration

- `ToonMaterial`, `MaterialOverrides`, `ShaderMaterial` and `MeshCollider` are persistent Inspector-facing Scene Object Components.
- Existing legacy Scene Object fields (`toonMaterialSettings`, `modelMaterialOverrides`, `shaderFragment`, `modelScale`, `collider`, `postProcessing`, `particleEmitter`) are migrated once into the same versioned `ecsComponents` payload and removed from the active Scene Object model.
- Inspector reads and writes ECS Components. The engine converts them to the existing `toon_material`, `model_material`, `material`, PostFX, particle-emitter and mesh-collider command paths.
- Three.js materials, shader programs/uniform buffers, GLB material instances, model triangle caches and Physics solver collision structures remain owned by PStudio3D/PStudioPhysics; ECS stores only JSON-safe authoring configuration and references.
- If a Scene Object has an unsupported future Component schema, migration and Inspector writes are blocked without mutating the saved data.


## ECS Scene Behavior and 2D Presentation

- `ScriptAttachment` stores a safe relative `.ps` project path and enabled state. The Runtime still compiles/executes ASTs and owns per-script locals/functions.
- `SpriteRenderer` stores an image asset reference, enabled flag, dimensions, tint, primitive shape, layer and sort order. AssetStore owns image bytes/decoding; Canvas/Three.js own drawing.
- `Collider2D` stores overlap/trigger intent. The Engine collision service still computes bounds/pairs and emits events.
- `Renderable.assetName` is authoritative for 3D model references; AssetStore/Renderer continue to own GLB bytes and loaded model resources.
- `EditorObjectSettings` stores persistent manipulation permission; pointer/DOM interaction remains editor-service logic.
- Legacy Scene Object fields `script`, `sprite`, `color`, `shape`, `w/h`, `model`, `modelScale`, `collider` and `manipulationEnabled` are migrated once into the versioned ECS Component payload and removed from the active Scene Object object. Future-version payloads are not modified.
