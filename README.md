# PStudio Game Engine 3.0.0

PStudio is an indentation-based `ps` IDE with two separate execution paths:

- **Normal ps programs:** `ps -> C++17 -> g++ -> execute` through `/run`.
- **Game scripts:** `ps -> validated AST -> PStudio browser runtime` through `/game/prepare` and the Scene **Play** control.

The game runtime does not send a request to the server every frame. Scripts are parsed and validated once when Play is pressed; `start()` runs once per object, then `update(dt)` runs from `requestAnimationFrame`. `dt` is seconds and is clamped to 0.1 seconds to avoid large simulation jumps after a stalled frame.

## Included files

- `app.py` — Flask app, original ps lexer/parser/validator/C++ generator/Discord endpoints, plus game AST and compile endpoints.
- `templates/index.html` — PStudio IDE, project explorer, editor, scene, inspector, asset handling and existing language UI.
- `static/pstudio_engine.js` — browser-side game runtime.
- `static/pstudio_3d_engine.js` — Three.js 3D renderer, HDR/IBL, shadows, screen-space effects, GPU particles and instancing.
- `static/pstudio_events.js` — shared namespaced event bus.
- `static/pstudio_platform.js` — browser capability and scheduling abstraction.
- `static/pstudio_jobs.js` — cooperative asynchronous job queue.
- `static/pstudio_resources.js` — shared CPU/GPU resource cache, reference leases and memory-budget eviction.
- `static/pstudio_modules.js` — dependency-aware module registry.
- `static/pstudio_ecs.js` — entity-component-system storage and scheduler.
- `discord_runtime.py` — original Discord runtime dependency.
- `network.py` — existing network runtime module, included unchanged.
- `examples/` — a small player/enemy scene example.
- `backup/` — untouched copies of the original uploaded `app.py` and PStudio HTML for rollback.

## Core Infrastructure 1.0

- Event bus (PStudioEvents): namespaced events, priority listeners, once subscriptions, AbortSignal cleanup, synchronous/asynchronous dispatch and FIFO deferred queue.
- Platform facade (PStudioPlatform): capability detection, monotonic clock, frame/task scheduling, viewport and guarded storage. The memory fallback is non-persistent.
- Job queue (PStudioJobs): priority scheduling, bounded cooperative async concurrency, cancellation, progress, pause/resume. This is not a Web Worker pool; synchronous CPU-heavy work still blocks the main thread.
- Module, ECS and resource lifecycle notifications are bridged to the shared event bus without removing their existing listener APIs.
- Automated tests cover these services and a source-level legacy runtime regression smoke test.

Example:

```js
PStudioEvents.on("scene.object.created", event => console.log(event.detail), { priority: 10 });
const job = PStudioJobs.submit(async ({ progress, yield: next }) => {
  progress(0.25);
  await next();
  return "finished";
});
```

Run from the repository root:

```bash
node --test tests/event_system.test.js tests/platform.test.js tests/job_system.test.js tests/core_regression.test.js
```

These are headless source tests, not a substitute for browser, Android, WebGL, IndexedDB or deployed-site smoke tests.

## Run locally

```bash
python -m pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000/`. Normal ps execution additionally requires `g++` with C++17 support. Discord Gateway features require the `websockets` dependency and the appropriate Discord configuration/token.

## Game lifecycle

Attach a `.ps` file to a Game Object in the Inspector, then choose **Play** in the Scene view.

```ps
speed = 220

func start()
    set_x(120)
    set_y(220)

func update(dt)
    if is_key_down("right")
        set_x(get_x() + speed * dt)
    draw_rect(get_x(), get_y(), 48, 48)

func on_collision(other)
    ps "Collision detected"
```

- `func start()` — called once when the game starts, per object.
- `func update(dt)` — called every animation frame, per object. `dt` is elapsed seconds.
- `func on_collision(other)` — called when a new collision begins. `other` is the other object's name (or ID if unnamed). It is not repeatedly called while objects remain in contact; leaving and re-entering creates a new event.

## Game API

| Function | Meaning |
|---|---|
| `get_x()` / `get_y()` | Read the current object's position |
| `set_x(value)` / `set_y(value)` | Set the current object's position |
| `get_width()` / `get_height()` | Read current object dimensions |
| `get_delta_time()` | Read frame delta in seconds |
| `is_key_down(key)` | Check keyboard state; supports `left`, `right`, `up`, `down`, `space` aliases and normal key names |
| `is_touched()` | True while a pointer/touch is held on the game canvas |
| `draw_rect(x, y, w, h)` | Queue a rectangle for the current frame |
| `draw_circle(x, y, radius)` | Queue a circle for the current frame |
| `draw_sprite(name, x, y)` | Draw an imported image asset at its native size |
| `len(value)` / `range(...)` | Standard ps helpers supported by the game runtime |

The selected object's **Enable Collider** checkbox is stored in the scene file. Collision detection supports rectangle-rectangle, circle-circle and circle-rectangle pairs. A callback is dispatched once on collision-enter to each participating object's attached script if that script defines `on_collision(other)`.

## Compatibility and boundaries

- Existing normal ps execution, C++17 generation, Discord routes, editor, local project storage, asset import, scene serialization and language UI are retained.
- Game APIs are opt-in: they are accepted by `/game/prepare`, but are not added to normal C++ execution. This prevents game-only calls from generating invalid C++.
- Game scripts execute in the browser runtime. `input()` and Discord side-effect functions are intentionally unavailable in game callbacks. Use the normal Run path for those workflows.
- The browser runtime provides the existing 2D path, a persistent 3D primitive renderer, basic 2D/3D collision callbacks, a fixed-step capsule character controller, GLB model loading and glTF animation playback.
- The custom physics module uses a 1/60-second fixed simulation step with a bounded accumulator, gravity, force/impulse, velocity, ground contact, jump buffering and a short coyote-time window.
- Character control includes normalized X/Z movement, ground acceleration, configurable air control, vertical jump speed and grounded state. Touch devices also show a virtual movement joystick and jump button while a 3D game is running.
- Static world collision supports finite `draw_plane` surfaces, triangle colliders, generated terrain and imported GLB triangle colliders (when **Enable Collider** is selected; extraction is capped at 4,000 sampled triangles per model). Capsule contacts support walkable triangle slopes, step climbing, translating/yaw-orienting platforms, swept capsule-vs-expanded-AABB collision and up to 256 adaptive substeps for other contacts. This is still a character-focused solver, not a general rigid-body engine. Extreme-speed tunnelling through arbitrary triangles, collision against animated/skinned mesh deformation, rotation-induced contact on tilted platforms, joints and full continuous collision detection are not guaranteed.
- Import binary glTF `.glb` or JSON glTF `.gltf` files through ASSETS. For `.gltf`, select the model and its referenced `.bin` / texture files together; PStudio embeds relative resources as data URIs and stores the bundled model in IndexedDB (30 MB combined limit). Project metadata remains in localStorage.
- `load_model(name, x, y, z, scale)` instantiates an imported model. `play_animation(name)` loops a matching animation clip; `play_animation_once(name)` plays it once. Clip names come from the GLB file.
- This is a game-development foundation, not a finished large-world action-RPG engine. The current runtime includes PMREM-filtered environment lighting, optional Bloom/SSAO post-processing, planar Reflector water, primitive GLSL shader nodes, named GLB material overrides, terrain collision, triangle-derived navigation, moving/rotating platform carry, adaptive swept collision, persistent particle emitters, animation layers, CCD-style bone IK, generic weapon attacks and combo chains, a small enemy state machine, equipment/consumable inventory, quest prerequisites/rewards, dialogue choices and DOM-based game UI. Still missing are true multi-bounce real-time global illumination, HDR lighting capture, a free-form drag-and-drop shader graph, water refraction/wave simulation, fully general CCD for arbitrary deforming meshes, dynamic NavMesh updates, motion-capture-grade IK/retargeting, tactical squad AI, complex hitbox animation events, multiplayer, audio mixing, save/load of live gameplay state and a standalone build/export pipeline.
- Browser local storage is still the project persistence layer; large base64 assets can exceed browser storage quotas.

## Module System 1.0

The module manager is exposed as `window.PStudioModules`. It supports module registration, required and optional dependency metadata, dependency-order resolution, conflict checks, asynchronous activation/deactivation hooks, cascading disable, lifecycle events and rollback when activation fails.

A module definition uses `id`, `version`, `dependencies`, `optionalDependencies`, `conflicts`, `activate(context)` and `deactivate(context)`. IDs are lowercase and stable. Example:

```js
PStudioModules.register({
  id: 'sample.editor-tool',
  version: '1.0.0',
  dependencies: [],
  activate: async () => { console.log('enabled'); },
  deactivate: async () => { console.log('disabled'); }
});
await PStudioModules.enable('sample.editor-tool');
await PStudioModules.disable('sample.editor-tool');
```

Use `enable(id)` to activate a module and its required dependencies. `disable(id)` refuses to disable a module while enabled dependents exist; pass `{ cascade: true }` to disable dependents first. `on(event, callback)` subscribes to `registered`, `enabled`, `disabled`, `unregistered` and `initialized` events.

**Current boundary:** this is the module-management foundation. Existing engine scripts (physics, gameplay, rendering, and asset storage) are still loaded as core scripts and are not yet dynamically unloaded or editor-toggleable. Converting those systems into independently managed modules is a later integration step; this manager does not pretend to hot-unload them.

Module manager regression tests can be run with `node --test tests/module_system.test.js` (Node.js built-in test runner; no third-party package is required).

## Resource Management 1.0

The resource manager is exposed as `window.PStudioResources`. It centralizes runtime cache ownership, reference tracking, CPU/GPU budget accounting and disposal.

- **Registration:** `register(type, key, value, options?)` tracks a resource. Options include `category: 'cpu' | 'gpu'`, `sizeBytes`, `pinned`, `dispose(value, reason)`, `onEvict(value, reason)` and metadata.
- **Lookup and loading:** `get(type, key)` updates LRU recency. `getOrLoad(type, key, loader, options?)` deduplicates concurrent loads and caches successful non-null results. Missing values and failed loads are not cached.
- **Reference safety:** `retain(type, key)` returns a lease with `value` and idempotent `release()`. Retained and pinned resources are excluded from budget eviction. `remove` refuses to remove retained resources unless `{ force: true }` is explicit.
- **Memory budgets:** CPU and GPU caches each default to 128 MiB. `setBudget('cpu' | 'gpu', bytes)` updates a budget and immediately trims least-recently-used eligible entries. `trim(category?)` can be called manually. A newly registered resource is protected during its own registration pass; if that single resource exceeds the budget it remains cached rather than being immediately destroyed.
- **Lifecycle and diagnostics:** `clear({ category?, force? })`, `stats()` and `on(event, callback)`. Events are also dispatched as `pstudio-resource-*` CustomEvents.

The IndexedDB-backed `PStudioAssetStore` now caches loaded model Blobs in the CPU resource cache. Updating or removing a stored asset invalidates its cached Blob. The 3D renderer registers decoded model assets in the GPU resource category, retains them while model instances use their shared geometry, and releases those references when instances are removed. Model GPU memory is an estimate based on source-file size, not a measurement from the WebGL driver; browser APIs do not expose exact per-resource GPU allocation.

Example:

```js
const lease = await PStudioResources.getOrLoad(
  'texture-data',
  'terrain-albedo',
  async () => await fetch('/assets/terrain.png').then(response => response.blob()),
  { category: 'cpu' }
);
// Use lease.value while needed; call lease.release() for retained resources.
```

For resources that need reference protection, first load/register them, then call `retain(type, key)`. The returned lease must be released when the consumer no longer uses the resource.

Resource manager regression tests can be run with `node --test tests/resource_manager.test.js`.

**Current boundary:** This stage manages cached binary assets and decoded 3D model lifetimes. It does not yet intercept every Three.js allocation, track browser-wide memory, measure actual GPU usage, or manage all image/audio/animation resources. Those integrations will be added incrementally rather than pretending the current counters represent total process memory.

## Entity Component System (ECS) 1.0

The ECS core is exposed as `window.PStudioECS`. It separates entity identity, component data and update systems. Component storage uses dense arrays with sparse entity-index maps, so systems can iterate only the entities that contain the components they need instead of scanning every Scene Object for every behavior.

- **Entities:** `createEntity(components?)`, `destroyEntity(entity)`, `query(componentTypes)`.
- **Components:** `registerComponent(type, options?)`, `addComponent`, `setComponent`, `getComponent`, `hasComponent`, `removeComponent`.
- **Systems:** `registerSystem({ id, components, priority, update })`, `setSystemEnabled`, `unregisterSystem`. Lower priority values run first; equal priorities preserve registration order.
- **Iteration:** `forEach(componentTypes, callback)` iterates matching entities without allocating a query result array. `query(componentTypes)` returns matching entity IDs in ascending order.
- **Deferred structure changes:** creating/destroying entities or adding/removing components during `forEach` is rejected to avoid corrupting an active iteration. Queue these changes with `ecs.defer(() => { ... })`; deferred actions run after the current system update.
- **Lifecycle and diagnostics:** `on(event, callback)`, `stats()`, `setEnabled(boolean)`, `clearEntities()`.

The built-in `Transform` component contains position (`x/y/z`), rotation (`rotationX/Y/Z`) and scale (`scaleX/Y/Z). `SceneObjectRef` identifies a linked editor object. During Play, the runtime mirrors existing Scene Objects into ECS entities, runs enabled ECS systems before the legacy per-object ps update callbacks, then applies ECS Transform changes back to Scene Objects. Changes made by existing ps scripts are synchronized back into ECS on the following frame. When no ECS system is enabled, the per-frame mirror and apply passes are skipped to avoid unnecessary runtime work. Stop removes only the Scene Object mirror entities; separately-created ECS entities and registered systems remain available.

**Physics boundary:** ECS Transform currently mirrors the editor-side Scene Object fields. Physics body state and simulation remain owned by the existing `PStudioPhysics` subsystem; a dedicated physics component and full ECS ownership migration are not part of this stage. The renderer also continues to use its established width/height and `modelScale` fields; the new ECS scale values are available to systems but are not yet applied as general non-uniform visual scaling. This separation avoids silently changing the physics engine's world-space state or the existing ps APIs.

Example: a generic movement system that does not depend on any specific game:

```js
PStudioECS.registerSystem({
  id: 'game.motion',
  components: ['Transform'],
  priority: 0,
  update(dt, ecs) {
    ecs.forEach(['Transform'], (entity, transform) => {
      transform.x += 2 * dt;
    });
  }
});
```

**Current boundary:** ECS now participates in the runtime update loop and can drive generic Transform changes, but it does not yet replace the existing physics, rendering, collision, gameplay-state or ps-script ownership systems. Those systems will be migrated incrementally after the foundation is validated. `PStudioECS` is currently a JavaScript-side engine API; direct Entity/Component/System declarations from the ps language and Inspector controls are a later integration step. The existing ps API remains unchanged. ECS scheduling is single-threaded; parallel job execution is a separate planned subsystem.

Run ECS regression tests with `node --test tests/ecs.test.js`. The test file uses Node.js built-ins only.


## Project Backup and Restore

Use the **Backup** menu in the application header to export or restore a portable `.pstudio` project archive. The archive includes project scripts, scene files, scene-object settings, image/audio data URLs, and the binary GLB/GLTF model files stored in IndexedDB. This allows a project to be moved to another browser or device instead of relying only on the current browser's local storage.

- Export saves the currently open file and active scene before creating the archive.
- Restore validates the archive version, file names, asset references, object IDs and declared sizes before replacing the active project.
- Existing model blobs, the previous localStorage project record, and the in-memory editor state are snapshotted before replacement. If an IndexedDB write, local project-storage write, or post-import UI refresh fails, the importer attempts to restore the previous project and asset state; it reports explicitly if rollback itself is incomplete.
- The archive is limited to 64 MB. Individual image/audio assets retain the existing 2 MB import limit.
- This is a project source/asset backup, not a standalone compiled game build. A portable runtime build/export pipeline remains future work.
- Browser storage is still local to each device; export backups regularly before clearing browser data.

## Validation performed for this build

- Python syntax compilation (`py_compile`).
- AST validation tests for lifecycle callbacks, game-only API gating and script-level state.
- `/game/prepare` payload/AST response test with a Flask test double.
- JavaScript syntax checks for the IDE inline script and game runtime.
- ECS harness checks for sparse component removal, system priority, deferred structural changes, bidirectional Scene Object synchronization and stale-entity cleanup.
- Resource manager harness checks for LRU budget trimming, CPU/GPU accounting, concurrent-load deduplication, reference protection and disposal.
- Rendering source/V8 checks: renderer syntax, addon import-map/module syntax, water/HDR/probe APIs, GPU-particle shader attributes, instancing/selection mapping and primitive mesh-cache consistency.
- A Node rendering regression suite was added at `tests/rendering_pipeline.test.js`; the Node test runner still needs to be run in a Node-enabled checkout.
- Core infrastructure V8 harness checks for event priority/once/async dispatch, job execution, module/ECS/resource event bridges, script load order and inline-script/import-map syntax.
- Node test-runner files were added for the event, platform, job and core regression suites; the Node test runner itself still needs to be run in a Node-enabled checkout.
- Runtime harness tests for `start()`, `update(dt)`, persistent per-object state, drawing commands, Stop, and collision-enter de-duplication/re-entry.
- Existing generated C++17 sample compiled with `g++` and printed the expected output.

A full graphical browser session and deployment-specific Flask/Discord integration were not available in this environment, so those still need a final smoke test after deployment.

## PStudio 2.0 3D API

| Function | Meaning |
|---|---|
| `draw_cube(x, y, z, size)` | Draw a cube |
| `draw_box(x, y, z, width, height, depth)` | Draw a rectangular box |
| `draw_sphere(x, y, z, radius)` | Draw a sphere |
| `draw_plane(x, y, z, width, depth)` | Draw a horizontal ground plane |
| `draw_cylinder(x, y, z, radius, height)` | Draw a cylinder |
| `draw_cone(x, y, z, radius, height)` | Draw a cone |
| `draw_capsule(x, y, z, radius, height)` | Draw a capsule-shaped object |
| `set_background(color)` | Set the 3D scene background color |
| `set_fog(color, near, far)` | Configure distance fog |
| `set_light(x, y, z, intensity)` | Set the directional light position and intensity |
| `set_camera(x, y, z, targetX, targetY, targetZ)` | Set an immediate 3D camera pose |
| `set_camera_follow(x, y, z, targetX, targetY, targetZ, smoothing)` | Smoothly follow a target; 0 is immediate and larger values catch up faster |
| `set_material(roughness, metalness)` | Set the current Game Object's PBR roughness and metalness (0–1) for following geometry and models |

Each Game Object can issue `set_material(roughness, metalness)` before its draw calls. The values are clamped to 0–1; low roughness gives a sharper reflection response, while higher metalness makes the surface more metallic. Imported model materials are cloned per instance before overrides, so one instance does not mutate another instance's shared source material. `set_camera_follow(..., smoothing)` applies exponential camera damping each frame; `0` disables smoothing and larger values track the target more quickly.

3D geometry is cached between frames when its owner and draw-call order remain stable. Geometry is rebuilt only when its shape or dimensions change. This reduces recurring allocation and disposal compared with rebuilding every mesh on every frame. It does not guarantee a particular frame rate; performance still depends on device GPU, geometry count, resolution and browser support.

Example:

```ps
func update(dt)
    set_background("#83b8e8")
    set_fog("#83b8e8", 18, 60)
    set_light(5, 10, 4, 2.4)
    draw_plane(0, -0.5, 0, 40, 40)
    draw_box(0, 1, 0, 1, 2, 1)
    draw_cylinder(3, 1, 0, 0.5, 2)
    draw_cone(-3, 1, 0, 0.7, 2)
    draw_capsule(0, 1, 3, 0.4, 2)
```

## PStudio 3.0 Physics and Character API

| Function | Meaning |
|---|---|
| `physics_body(x, y, z, radius, height, mass)` | Create a vertical capsule body in world units |
| `set_gravity(x, y, z)` | Set acceleration due to gravity |
| `apply_force(x, y, z)` / `apply_impulse(x, y, z)` | Apply force over the next physics step or an immediate impulse |
| `get_velocity_x/y/z()` | Read velocity components |
| `set_velocity_x/y/z(value)` | Set velocity components |
| `character_controller(max_speed, acceleration, air_control)` | Configure ground speed, acceleration and 0–1 air-control ratio |
| `set_step_height(height)` | Configure the controller's maximum step-up height |
| `set_max_slope(degrees)` | Configure the maximum walkable triangle slope |
| `add_triangle_collider(ax, ay, az, bx, by, bz, cx, cy, cz)` | Add a static triangle collision surface to the current object |
| `move_character(x, z)` | Set normalized horizontal movement input, transformed relative to the current 3D camera's horizontal forward/right directions |
| `character_animation(idle, walk, run, jump, fall, land)` | Select GLB locomotion clips from grounded state, horizontal speed, vertical velocity and landing transitions; use an empty string to disable an unused clip |
| `jump(speed)` | Buffer a jump using the requested initial upward speed |
| `is_grounded()` | Check current ground contact |
| `get_axis("horizontal" or "vertical")` | Read A/D + arrow-key movement axes; W/Up is negative Z |
| `was_key_pressed("space")` | Detect a key press edge for one game frame |

The character body is a vertical capsule. The physics step is fixed at 60 Hz and capped at eight substeps per rendered frame. The controller uses semi-implicit Euler integration, ground/air acceleration, a 0.12-second jump buffer and 0.12-second coyote time. The runtime emits per-frame jump and landing transition flags. Controlled characters smoothly turn toward their actual horizontal velocity; their model's local forward direction is assumed to be +Z. Camera-relative movement reads the active 3D camera view direction, so keyboard and touch-axis input continue to mean forward/back/left/right after orbiting the camera. While Play is active, dragging anywhere on the 3D view orbits the third-person camera instead of moving editor objects; pinch and wheel gestures zoom. `set_camera_follow` applies five offset ray tests against rendered scene meshes to pull the camera forward before it clips into walls or models, excluding the Game Object that owns the camera command. This camera collision is a practical ray-based approximation, not a full swept-sphere solver. Character collision still uses horizontal planes and primitive AABB approximations; sloped terrain, stairs, triangle-mesh player collision, dynamic body-to-body response and continuous collision detection are not implemented. It is intentionally not described as production-grade general-purpose physics.

## Scene model placement and rendering quality

Imported model assets can be added directly to the current Scene from the asset row's `⋯` menu using **シーンに追加**. The new Game Object stores the model asset name and model scale in the scene file; selecting it exposes its scale in the Inspector. The Scene preview switches to 3D automatically. Model-only game scripts also select the 3D renderer in AUTO mode.

The 3D renderer enables directional shadow mapping, soft PCF filtering, ACES filmic tone mapping, sRGB output and PMREM-filtered environment lighting. Bloom and SSAO can be enabled with `set_postprocessing(bloom, ssao, strength)` or the Inspector controls; they are off by default for mobile performance. The environment map provides image-based lighting and reflections, not multi-bounce real-time global illumination. `draw_water(...)` uses a planar Reflector pass where available; it is a flat mirror-like reflection, not a physically complete water simulation. Shadow quality and frame rate depend on the device GPU and browser. Imported models can opt into distance-based LOD by including sibling nodes or meshes named `LOD0`, `LOD1`, `LOD2`, etc. The renderer selects the first level at close range, then switches to progressively coarser levels at approximately 25, 70 and 150 world units. Models without named LOD levels render as before.

## Per-model ps Controller Scripts

Each imported `.glb` / `.gltf` asset has its own companion `.ps` controller script. PStudio creates the script during import (or on first asset selection for models already in an existing project). Selecting the model asset opens that controller in the code editor. Adding the model to the Scene automatically attaches its companion script to the new Game Object. The model file remains binary asset data; its behavior is kept in the separate editable `.ps` file. Script names use `<model>_controller.ps`, with a numeric suffix if that name already exists.

During Play, a scene model with an attached controller remains automatically rendered even if the script does not call `load_model()`. The controller can use the existing model animation APIs such as `play_animation("Idle")`; explicit `load_model()` calls remain available for additional model instances. For locomotion blending, call `character_animation("Idle", "Walk", "Run", "Jump", "Fall", "Land")` once per update. The renderer chooses the clip from grounded state and horizontal/vertical velocity, cross-fades between states, plays a landing clip once per landing event, and lets an active `play_animation_once()` action finish before returning to locomotion. Animation names must match clips embedded in the GLB (partial, case-insensitive matching is supported).

## Project File Management

Each script, scene and imported asset has a `⋯` menu in the Project explorer. It supports rename, lock/unlock and delete. Locked entries cannot be renamed or deleted from the menu. The final remaining ps script is protected so the project always retains an editable script. Renaming a script updates scene-object script assignments; renaming a model updates exact filename references in ps scripts. Deleting a model warns when scripts still refer to it.

Image/audio assets remain in the local project metadata; model binaries remain in IndexedDB. Browser storage is device-local, so export/backup support is still recommended before relying on it as the only copy.

## GLB Model and Animation API

Import a binary glTF `.glb` or JSON glTF `.gltf` model in the ASSETS area, then refer to its exact filename from a game script. For `.gltf`, select all referenced local `.bin` and texture files in the same import operation:

| Function | Meaning |
|---|---|
| `load_model(name, x, y, z, scale)` | Load and draw an imported GLB model |
| `play_animation(name)` | Loop the matching animation clip |
| `play_animation_once(name)` | Play a clip once and hold its final pose |
| `stop_animation()` | Stop the current model animation |
| `set_animation_speed(speed)` | Change animation playback speed |
| `animation_layer(clip, weight, additive)` | Add a weighted looping animation layer |
| `solve_ik(root_bone, end_bone, x, y, z, iterations, weight)` | Apply CCD-style bone-chain IK to a named GLB skeleton |
| `blend_animations(clip_a, clip_b, weight)` | Blend two looping clips; weight 0 selects the first and 1 selects the second |

The model loader uses the matching Three.js GLTFLoader and SkeletonUtils clone support. GLB files and bundled GLTF JSON are stored in IndexedDB, not embedded into the project JSON. Relative external buffers and images selected alongside a `.gltf` file are embedded during import. A model can contain multiple animation clips; clip matching is case-insensitive and accepts a partial name. Switching between clips uses a short cross-fade instead of abruptly stopping the previous action. Compressed texture formats requiring separately configured decoders are not included in this build.

## 3D RPG Starter Example

Attach `examples/3d_rpg/world.ps` to a world Game Object and `examples/3d_rpg/player_controller.ps` to a player Game Object. Import a rigged `Traveler.glb` with animation clips whose names include Idle, Walk, Run, Jump and Attack. On desktop, use WASD or arrow keys and Space to jump; press F to attack. On touch devices, use the on-screen joystick and JUMP button; the remaining 3D view area can be dragged to orbit the camera.

```ps
attack_timer = 0

func start()
    physics_body(0, 2.4, 0, 0.38, 1.8, 1)
    set_gravity(0, -18, 0)
    character_controller(5.5, 28, 0.28)

func update(dt)
    move_character(get_axis("horizontal"), get_axis("vertical"))

    if was_key_pressed("space")
        jump(7.5)

    if was_key_pressed("f")
        play_animation_once("Attack")
        attack_timer = 0.65

    if attack_timer > 0
        attack_timer -= dt
    elif not is_grounded()
        play_animation("Jump")
    elif get_velocity_x() ** 2 + get_velocity_z() ** 2 > 16
        play_animation("Run")
    elif get_velocity_x() ** 2 + get_velocity_z() ** 2 > 0.25
        play_animation("Walk")
    else
        play_animation("Idle")

    load_model("Traveler.glb", get_x(), get_y() - 0.9, get_z(), 1)
    set_camera(get_x() + 4, get_y() + 3, get_z() + 6, get_x(), get_y(), get_z())
```


## Gameplay systems API

The browser game runtime provides opt-in per-object gameplay state. Attach a script to an object and use `set_max_hp(value)`, `set_hp(value)`, `get_hp()`, `get_max_hp()`, `damage(amount)`, `heal(amount)` and `is_alive()`. `apply_damage(target_name, amount)` applies damage to a scene object resolved by its name or ID. `attack_hitbox(radius, damage)` performs a simple radial attack query against other scene objects with physics bodies; it applies a short per-target repeat interval and is not a directional weapon hitbox. `enemy_follow(target_name, speed, stop_distance)` steers a configured character controller toward a named target. Configure the follower with `physics_body()` and `character_controller()` first.

Each object has an in-memory inventory: `inventory_add(item, count)`, `inventory_remove(item, count)` and `inventory_count(item)`. Quest flags are shared by quest ID: `quest_start(id)`, `quest_complete(id)` and `quest_is_complete(id)`. A graph-based navigation helper is available through `nav_add_node(id, x, y, z)`, `nav_connect(a, b)`, `nav_build_grid(x, z, width, depth, cell_size)`, `nav_build_from_terrain(x, y, z, width, depth, segments, height, max_slope)`, `nav_build_from_triangles(flat_vertex_array, max_slope)`, `nav_build_from_model(model_name, x, y, z, scale, max_slope)`, `nav_block_node(id, blocked)`, `nav_next_node(start, goal)` and `nav_clear()`. Triangle navigation generation filters out slopes steeper than the configured walkable angle and connects triangles sharing edges. This is a sampled triangle-graph NavMesh approximation, not a hierarchical tiled navigation system. `quest_set_progress(id, value, target)` and `quest_get_progress(id)` provide a minimal objective counter. `use_skill(radius, damage, cooldown)` performs a cooldown-limited radial skill query; `enemy_attack(target, range, damage, cooldown)` performs a range-checked single-target enemy attack. The grid builder creates a capped 2D navigation graph and supports manually blocked nodes; it is not a polygonal NavMesh baked from scene geometry and does not perform obstacle sampling or path smoothing. HUD drawing supports `draw_hud_text(text, x, y, size, color)` and `draw_hud_bar(value, max, x, y, width, height, color)`.


`emit_particles(x, y, z, count, color, speed, lifetime)` emits a short 3D particle burst. Particle count is capped at 400 per burst and the effect is simulated in the browser renderer. Avoid calling it unconditionally every frame; trigger it from an input or gameplay event.


## Rendering Engine 1.5 — HDR, Lighting, Water and GPU Optimization

The 3D renderer uses Three.js r160 with ACES filmic tone mapping, sRGB output, PMREM-filtered image-based lighting and directional shadow mapping. Quality presets are available through the renderer API:

| Preset | Pixel ratio cap | Directional shadow map | Screen-space effects |
|---|---:|---:|---|
| `mobile` | 1.0 | 1024² PCF | off |
| `balanced` | 1.5 | 2048² PCF | off |
| `high` | 2.0 | 3072² VSM | GTAO + SSR |
| `ultra` | 2.0 | 4096² VSM | GTAO + SSR |

`auto` selects balanced settings on touch/narrow screens and high settings otherwise. VSM provides soft filtered directional shadows; balanced/mobile use PCF soft shadows. GTAO is preferred when its addon loads, with SSAO as a fallback. Screen-space reflections are optional and enabled by high/ultra presets. Bloom remains opt-in through `set_postprocessing(...)`; it is not forced onto every scene.

### HDR environments and diffuse light baking

`PStudio3D.loadEnvironmentHDR(url, { intensity, background })` loads an equirectangular RGBE/HDR environment and converts it through PMREM for physically based reflections and ambient image-based lighting. The image host must permit browser CORS access. Example:

```js
await PStudio3D.loadEnvironmentHDR("https://your-host.example/studio.hdr", {
  intensity: 1.25,
  background: true
});
```

After the scene, environment and lighting are in place, `PStudio3D.bakeLightProbe({ x, y, z, resolution, intensity })` captures the scene with a cube camera and converts the radiance to spherical-harmonic diffuse illumination. This is a **single global irradiance probe**, not a UV lightmap or spatially blended probe volume. The current probe is runtime-only and is not serialized into project files; re-bake it after page reloads and major static-scene or environment changes. It is a practical baked-indirect-light foundation, not full multi-bounce real-time path-traced GI.

### Water and reflections

`draw_water(x, y, z, width, depth, color, opacity)` now creates a tessellated physically based water surface. A vertex shader animates multiple wave components and perturbs the normals; the physical material uses water-like refraction (IOR 1.333), transmission and clearcoat. SSR can add screen-space reflections on high/ultra presets. Screen-space reflections cannot show off-screen objects and can be incomplete on transparent/refractive surfaces. Refraction is limited by the browser's transmission-buffer support. Caustics, volumetric underwater scattering, shore foam and fully simulated fluid dynamics are not included.

### GPU particles and instancing

`emit_particles(...)` and `particle_emitter(...)` now use custom GPU particle materials. Per-particle origin, velocity, birth time and lifetime are uploaded when particles spawn; the vertex shader calculates ballistic movement, gravity and fade on the GPU. CPU work remains for emission scheduling and writing newly spawned particle attributes. This is GPU-driven rendering/simulation, not a compute-shader particle solver.

Repeated simple primitives are automatically grouped into `THREE.InstancedMesh` batches when at least three instances share geometry, dimensions and material state. The batch retains an instance-to-Scene-Object mapping, so selection and editor manipulation continue to address the original object. Terrain, water, custom shaders and imported animated models are not merged into these primitive batches.

`PStudio3D.setQualityPreset("auto" | "mobile" | "balanced" | "high" | "ultra")` switches quality settings. `PStudio3D.getStats()` reports renderer calls, triangles, geometry/texture counts, active instances, GPU particle systems and measured render time. Existing model LOD selection and geometry/material caches remain active.

These features improve image-based indirect lighting, contact shading, reflections and draw-call efficiency. They do **not** yet constitute a full dynamic GI solution such as real-time multi-bounce voxel/ray-traced illumination.

## Custom GLSL Shader Editor

Select a non-model Scene object and use the **Shader Editor** graph or GLSL editor. The graph is a compact fixed flow (Color Input → UV Pattern → Fragment Output), not an unrestricted draggable node canvas. GLB material overrides are edited separately in the model Inspector by material name or `*`. PStudio supplies a fixed vertex shader with `uColor` and `vUv`; shader compilation depends on browser WebGL support.


## Extended Gameplay, Navigation and UI

- **Continuous particles:** `particle_emitter(id, rate, color, speed, lifetime, max_count)` maintains a per-object emitter while the call is present in `update()`. `stop_particle_emitter(id)` stops it. The Inspector exposes a basic emitter editor; each emitter is capped at 1,200 particles and the renderer caps active emitters at 32.
- **Weapon combat:** `weapon_define(name, range, arc_degrees, damage_multiplier)` stores a named weapon's range, attack arc and damage modifier. `weapon_attack(weapon, radius, damage, combo_window_ms)` uses that profile when defined and applies a forward-facing cone hit test and a five-step combo multiplier. It is not a full attack-animation/hitbox authoring system. No game-specific elemental rules are included in the default gameplay runtime.
- **Enemy state AI:** `enemy_ai(target, sight_range, attack_range, speed)` switches among idle, chase, attack, retreat and dead. It can follow the generated triangle graph when one exists; it does not perform tactical squad planning or dynamic cover analysis.
- **Inventory:** `define_item(item, kind, slot, value)`, `inventory_add`, `equip_item` and `use_item` define equipment and consumables. `open_inventory()` and `open_quest_log()` open the built-in DOM panels.
- **Quests and dialogue:** `quest_define(id, prerequisite, reward_item, reward_count)` defines a simple dependency and reward. Use `quest_start`, `quest_set_progress`, and `quest_complete`. `show_dialogue(speaker, text, choice1, choice2, choice3)` displays choices; `dialogue_choice()` reads the player's latest selection.
- **Navigation:** `nav_build_from_terrain(x, y, z, width, depth, segments, height, max_slope)`, `nav_build_from_triangles(flat_vertices, max_slope)` and `nav_build_from_model(...)` build an edge-connected walkable triangle graph. This is an approximate static NavMesh; dynamic obstacle re-baking, off-mesh links and hierarchical streaming are not included.


## Rendering Engine 1.6 — Spatial Irradiance and Large-World Rendering

`PStudio3D.bakeLightProbeVolume(options)` captures a bounded grid of spherical-harmonic (SH) irradiance probes (2–4 samples per axis, at most 32 probes, 32–128 cube resolution). The current renderer now performs per-object interpolation from the nearest probes and feeds the result into the indirect-diffuse term of standard/physical materials. It is a baked, object-local diffuse GI approximation; it is not a full dynamic ray-traced solution or a UV lightmap texture baker. Re-bake after major static lighting, geometry or environment changes.

```js
await PStudio3D.bakeLightProbeVolume({
  min: { x: -80, y: 0, z: -80 },
  max: { x: 80, y: 24, z: 80 },
  xCount: 3, yCount: 2, zCount: 3,
  resolution: 64, intensity: 0.8
});
```

Large-world controls:

- `PStudio3D.setWorldRenderConfig({ maxDrawDistance, lodDistances, shadowDistance, probeBlendCount })` configures distance visibility, imported-model LOD thresholds, directional shadow coverage and probe blending.
- `PStudio3D.registerWorldChunk(id, { x, y, z, loadDistance, unloadDistance })` defines a render/asset activation region with hysteresis.
- `PStudio3D.assignObjectToChunk(ownerId, id)` associates a Scene Object with a chunk. Inactive chunks stop issuing render commands while cached geometry/model instances are retained.
- `PStudio3D.unregisterWorldChunk(id)` removes a chunk and owner assignments.
- Three.js frustum culling remains enabled for ordinary meshes and model submeshes. Instanced batches compact visible instances and refresh selection mappings.

Directional shadow coverage follows the camera target and snaps its center to shadow-map texels to reduce shimmering. This describes the earlier single-camera baseline; the later Rendering Engine 1.7 section documents the optional three-cascade CSM path and single-camera fallback. Chunk streaming now supports model preloading and render/model resource release, but it still does not pause ps scripts, physics, AI or audio; those systems need project-level world-partition integration.

## Rendering Engine 1.8 — UV Lightmaps, BVH Occlusion and Chunk Lifecycle


### UV lightmap workflow

Bake the spatial probe volume first, then generate and apply a lightmap atlas to currently loaded static meshes:

```js
await PStudio3D.bakeLightProbeVolume({
  min: { x: -40, y: 0, z: -40 },
  max: { x: 40, y: 16, z: 40 },
  xCount: 3, yCount: 2, zCount: 3,
  resolution: 64, bounces: 2, bounceStrength: 0.3
});
const result = await PStudio3D.bakeUVLightmaps({ resolution: 512 });
console.log(result);
await PStudio3D.saveLightmaps('world-lighting');
```

After scene objects and model assets load in a later session, call `await PStudio3D.loadLightmaps('world-lighting')`. Mesh identifiers use scene-object command order and model hierarchy paths; changing topology or command order can invalidate a saved entry. Lightmap data is stored in that browser's IndexedDB, so include it in a project backup workflow before moving devices.

### Audio and streamed-owner lifecycle

```ps
func start()
    play_sound("forest_ambience.ogg", 0.65, true)

func update(dt)
    if dt > 0
        set_sound_volume("forest_ambience.ogg", 0.65)
```

The audio asset must already be imported into the project. `play_sound(name, volume, loop)` plays it for the calling Game Object; `stop_sound(name)` stops that owner's sound and `set_sound_volume(name, volume)` changes its volume. Browser autoplay restrictions can still prevent playback until the user interacts with the page.

## Rendering Engine 1.7 — Object-Space GI, Cascaded Shadows and Adaptive Worlds

### Object-local indirect lighting

The spatial probe volume now supplies each supported mesh with SH coefficients interpolated at that object's world-space position. The nearest four probes are weighted by inverse distance. Standard and physical materials evaluate the interpolated SH irradiance in the indirect-diffuse shader path. `PStudio3D.bakeLightProbeVolume(options)` supports bounded iterative capture passes:

```js
await PStudio3D.bakeLightProbeVolume({
  min: { x: -80, y: 0, z: -80 },
  max: { x: 80, y: 24, z: 80 },
  xCount: 3, yCount: 2, zCount: 3,
  resolution: 64,
  bounces: 1,
  bounceStrength: 0.35
});
```

The first pass captures the current scene lighting. Later passes temporarily feed the previous pass's probes into the next capture, providing approximate additional diffuse bounce. This is a bounded baked approximation, not a real-time path tracer or a complete solution for moving lights and moving geometry. UV lightmaps are available through `PStudio3D.bakeUVLightmaps({ resolution })`. The current atlas gives each triangle a separate non-overlapping chart, evaluates interpolated probe SH irradiance per texel, and applies a linear-float `lightMap` texture using the second UV channel. `saveLightmaps(name)` and `loadLightmaps(name)` persist UV2 coordinates and texture data in browser IndexedDB; `clearLightmaps()` removes the runtime application. This is a deterministic per-triangle atlas rather than a seam-aware chart packer, and the bake stores probe-derived diffuse irradiance rather than full direct-shadow/path-traced transport. Skinned meshes are excluded. Re-bake after topology or static-lighting changes.

### Cascaded shadow maps

When the version-matched Three.js CSM addon loads, the directional key light uses three practical cascades with camera-frustum fitting and fade blending. Standard and physical materials are registered with CSM. If the optional addon fails to load or initialize, the previous single directional shadow camera remains as a fallback. `PStudio3D.setWorldRenderConfig({ shadowDistance })` controls the configured far distance. Cascade count and shadow-map size are bounded for browser/mobile GPUs.

### Automatic mesh LOD

When `SimplifyModifier` is available, static indexed meshes with 240–16,000 vertices can generate two lower-detail representations during idle time. The thresholds use the first two values in `lodDistances`. Existing explicitly named GLTF LOD groups take precedence. Skinned meshes, explicitly named LOD hierarchies and meshes outside the supported size range retain their source geometry.

### Occlusion and world streaming

Occlusion culling performs a limited number of CPU ray checks per update and can reject objects behind opaque scene geometry, including sources represented by instanced batches. When the optional `three-mesh-bvh` addon loads, mesh raycasts use per-geometry BVHs for accelerated intersection tests; otherwise standard Three.js raycasting remains available. This is BVH-accelerated CPU occlusion, not hardware GPU occlusion queries or a world-level portal/cluster visibility solver. Transparent and transmissive materials are excluded as blockers. Use `PStudio3D.setOcclusionCulling(false)` to disable it.

A chunk can preload model assets asynchronously and run lifecycle callbacks:

```js
PStudio3D.registerWorldChunk('forest-east', {
  x: 500, y: 0, z: 0,
  loadDistance: 700, unloadDistance: 900,
  assets: ['Forest.glb', 'Ruins.glb'],
  active: false,
  onLoad: ({ id, assets }) => console.log('loaded', id, assets),
  onUnload: ({ id }) => console.log('unloaded', id)
});
PStudio3D.assignObjectToChunk('forest-tree-01', 'forest-east');
```

When a chunk leaves its unload radius, assigned render meshes and model instances are released and the resource manager trims unretained GPU resources. Owners assigned to an inactive chunk stop running their `.ps` callbacks; runtime state and previous draw commands are retained so `start()` is not called again on resume. Physics bodies are deactivated without discarding position or velocity, ECS `query()` / `forEach()` omit inactive scene entities, and owner audio started with `play_sound()` is paused and resumed only if it was playing before suspension. Use `stop_sound(name)` and `set_sound_volume(name, volume)` for audio control. This lifecycle currently follows the 3D world-chunk camera path; a generalized 2D world-partition scheduler and streaming of arbitrary external audio/asset dependencies remain future work.

### Adaptive quality

The `auto` preset now prefers asynchronous WebGL GPU timer queries through `EXT_disjoint_timer_query_webgl2` when the device supports them, and falls back to smoothed CPU render-submission time when the extension is unavailable or disjoint. It gradually adjusts pixel ratio, screen-space AO/reflections and shadow-map resolution. Manual `mobile`, `balanced`, `high` and `ultra` presets remain available. GPU timer queries measure submitted GPU work duration, not a device-wide utilization percentage. Adaptive changes and the active timing source are exposed through `getQualityPreset()` and renderer statistics.
