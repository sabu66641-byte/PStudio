# PStudio Game Engine 3.0.0

PStudio is an indentation-based `ps` IDE with two separate execution paths:

- **Normal ps programs:** `ps -> C++17 -> g++ -> execute` through `/run`.
- **Game scripts:** `ps -> validated AST -> PStudio browser runtime` through `/game/prepare` and the Scene **Play** control.

The game runtime does not send a request to the server every frame. Scripts are parsed and validated once when Play is pressed; `start()` runs once per object, then `update(dt)` runs from `requestAnimationFrame`. `dt` is seconds and is clamped to 0.1 seconds to avoid large simulation jumps after a stalled frame.

## Architecture reference

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for subsystem ownership, execution-path separation, current implementation boundaries, server safeguards, open audit risks and change discipline.

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
- `static/pstudio_ecs_rendering.js` — Camera, Light, Renderable and Animation Components bridged to the existing renderer.
- `static/pstudio_ecs_streaming.js` — persistent WorldPartition and StreamingInterest Components bridged to PStudio3D chunk management.
- `static/pstudio_physics.js` — fixed-step capsule character physics, static triangle/box/plane collision and moving-platform carry.
- `static/pstudio_gameplay.js` — generic combat, enemy state, inventory, quests, dialogue and navigation helpers.
- `static/pstudio_game_ui.js` — DOM-based in-game HUD and panels.
- `static/pstudio_assets.js` — IndexedDB storage for binary model assets.
- `discord_runtime.py` — Discord REST/Gateway runtime used by the normal server-side ps path.
- `network.py` — standalone HTTP/HTTPS helper module. It is not currently exposed as a browser game-script API.
- `tests/` — Python compiler/server tests and Node.js subsystem/regression suites.
- `.github/workflows/ci.yml` — CI for Python, actual C++17 compile/run regression tests, and Node.js tests.
- `examples/` — player/enemy and 3D RPG starter scripts.
- `archive/` — explicitly unloaded experimental references; not part of PStudio Core.

## Core Infrastructure 1.0

- Event bus (PStudioEvents): namespaced events, priority listeners, once subscriptions, AbortSignal cleanup, synchronous/asynchronous dispatch and FIFO deferred queue.
- Platform facade (PStudioPlatform): capability detection, monotonic clock, frame/task scheduling, viewport and guarded storage. The memory fallback is non-persistent.
- Job queue (PStudioJobs): priority scheduling, bounded cooperative async concurrency, cancellation, progress, pause/resume. This is not a Web Worker pool; synchronous CPU-heavy work still blocks the main thread.
- Module, ECS and resource lifecycle notifications are bridged to the shared event bus without removing their existing listener APIs.
- Automated regression tests cover these services, the rendering pipeline, localization, model-viewer controls, physics collider caching, server input limits and legacy runtime behavior.

Example:

```js
PStudioEvents.on("scene.object.created", event => console.log(event.detail), { priority: 10 });
const job = PStudioJobs.submit(async ({ progress, yield: next }) => {
  progress(0.25);
  await next();
  return "finished";
});
```

Run the complete test suites from the repository root:

```bash
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests/*.test.js
```

The GitHub Actions workflow runs both commands on pushes to `main` and pull requests. Python tests include actual C++17 compilation and execution when `g++` is available. These automated tests do not replace browser, Android, WebGL, IndexedDB or deployed-site smoke tests.

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
| `set_atmosphere(elevation, azimuth, turbidity, cloud_density)` | Set the physical sky and cloud parameters; angles are degrees, azimuth 0° points north (+Z), turbidity is 1–10 and cloud density is 0–1 |
| `set_camera_lens(dof_enabled, focus_distance, aperture, chromatic_aberration)` | Set depth of field and edge-weighted chromatic aberration; focus distance is camera-space depth in world units, aperture is f/1.2–f/22 and chromatic aberration is 0–1 |
| `set_color_grading(exposure, contrast, saturation, temperature, vignette, film_grain)` | Set exposure/contrast/saturation/temperature on the linear scene buffer, plus vignette and animated film grain; identity values disable the extra pass |
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
- This is a game-development foundation, not a finished large-world action-RPG engine. The current renderer includes PMREM-filtered HDR image-based lighting, a single global diffuse probe, spatial SH probe volumes with approximate iterative diffuse-bounce capture, UV2 lightmap baking from probe irradiance, optional Bloom/GTAO/SSAO/SSR, transmissive animated water, GPU-driven particle rendering, instancing, cascaded-shadow maps with fallback, automatic LOD and CPU BVH-accelerated occlusion raycasts. The runtime also includes terrain collision, triangle-derived static navigation, moving/rotating platform carry, adaptive swept capsule collision, persistent particle emitters, animation layers, CCD-style bone IK, generic combat/combo helpers, a small enemy state machine, equipment/consumable inventory, quest prerequisites/rewards, dialogue choices and DOM-based game UI. The renderer does not provide physically complete real-time multi-bounce GI or path tracing; probe bounces are a spatial-SH approximation. Water does not yet provide a full fluid simulation, shore foam or volumetric caustics. Other future work includes general CCD for arbitrary deforming meshes, dynamic NavMesh updates, motion-capture-grade IK/retargeting, tactical squad AI, complex animation-authored hitboxes, multiplayer, a full audio mixer, live gameplay save/load and a standalone build/export pipeline.
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

## Entity Component System (ECS) 1.2

The ECS core is exposed as `window.PStudioECS`. It separates Entity identity, Component data and System scheduling. Component storage uses dense arrays with sparse entity-index maps; Systems query only the Components they require.

- **Entities:** `createEntity(components?)`, `destroyEntity(entity)`, `query(componentTypes)`, `getEntities(includeInactive?)`.
- **Typed Components:** `registerComponent(type, options?)`, `updateComponentDefinition(type, options)`, `getComponentDefinition(s)`, `getEntityComponents(entity)`, `addComponent`, `setComponent`, `getComponent`, `hasComponent`, `removeComponent`.
- **System scheduler:** `registerSystem({ id, components, priority, phase, update })`, `getSystems()`, `setSystemEnabled`, `setSystemPriority`, `setSystemPhase`, `unregisterSystem`.
- **System phases:** `update`, `prePhysics`, `postUpdate`, and `postPhysics`. `postUpdate` runs after per-object ps callbacks and before the Physics step, allowing ECS gameplay Systems to resolve movement intent for the current simulation tick. Priorities run from lower to higher; equal priorities retain registration order.
- **Iteration and safety:** `forEach(componentTypes, callback)` avoids allocating a query-result array. Structural mutations during iteration must use `ecs.defer(() => { ... })`.
- **Diagnostics:** `on(event, callback)`, `stats()`, `hasActiveSystems()`, `setEnabled(boolean)`, `clearEntities()`.

### Component schemas and Inspector

A Component definition can provide a `schema` describing field types, defaults and validation constraints. Supported field types are `number`, `integer`, `boolean`, `string`, `enum`, `color`, `vector3`, `array`, `json` and `entity`. Required fields, numeric ranges, enum options and unknown-field rejection are checked by the ECS core when a Component is added or updated. Definitions can be updated safely; existing instance data is revalidated before the new schema is committed.

The ECS Inspector now:
- shows typed field controls for Component schemas and JSON editing for unstructured Components;
- discovers `component` / `system` declarations from project `.ps` files using the same `/game/prepare` validator used by Play;
- lets the user register a custom schema, attach/remove Components on a selected Scene Object and persist those values with the Scene;
- lists declared and currently registered Systems, opens their source `.ps` file, and manages enabled state, priority and runtime phase.

New Scene Objects start with an explicit empty `ecsComponents` list, so custom Components can be assigned selectively. Older projects that do not yet contain this field keep the legacy behavior: their declared `.ps` Components are attached to all Scene Objects at Play. A saved empty list `[]` means that the object has no custom Components assigned.

### Transform and Physics ownership

`Transform` remains the Scene/IDE transform bridge. It mirrors the existing Scene Object coordinates and therefore retains the current editor and renderer coordinate conventions.

Physics uses a separate world-space data path:

- `PhysicsBody` is persistent configuration: world position, capsule size, mass, gravity and optional character-controller settings.
- `PhysicsState` is a read-only, runtime-only snapshot of velocity, grounded state, controller state, landing flags and world position.
- `PhysicsTransform` is the read-only world-space position produced by the fixed-step Physics solver.
- `Velocity` is a lightweight per-second velocity Component for non-Physics entities; its built-in System integrates it into `Transform`. Physics-driven entities are excluded to avoid competing transform owners.

The runtime order is: ECS `update` Systems → ECS `prePhysics` Systems → legacy per-object ps callbacks and render-command generation → ECS `postUpdate` Systems → `PStudioPhysics.step()` → ECS `postPhysics` Systems → rendering. The Physics bridge creates/configures bodies before the simulation and copies the solver snapshot back to `PhysicsState` / `PhysicsTransform` afterward. It deliberately does not copy Physics world units directly into the editor `Transform`; the renderer and legacy runtime still use their established coordinate conversion. This prevents a 2D pixel coordinate from being mistaken for a 3D Physics world coordinate and avoids two subsystems writing the same position.

### Navigation graph ownership

The runtime Navigation graph is stored in standalone ECS Entities carrying the internal, runtime-only `NavigationNode` Component. Each node owns its world-space position, neighboring node IDs and blocked state. The `PStudioECSGameplay` bridge provides node lookup, nearest-node queries and A* next-node lookup; the existing `nav_*` ps built-ins remain the compatibility surface. Grid and triangle-derived graph builders create/update these Components. Navigation Entities are intentionally not attached to Scene Objects or serialized as editor Scene Components; the graph retains its existing in-memory Play/Stop lifetime. The ID-to-Entity Map in the bridge is only a lookup cache, not a second owner of graph data.

### ps-native ECS declarations

The browser game-script language can declare reusable data Components and update Systems directly:

```ps
component EnemyAI
    speed = 3.0
    health = 100

system MoveEnemy(Transform, EnemyAI)
    transform.x += enemy_ai.speed * dt
    if enemy_ai.health <= 0
        transform.y = 0
```

- `component Name` declares typed fields using literal or literal-array defaults. The Inspector reads these declarations and presents the matching type-aware fields.
- `system Name(ComponentA, ComponentB)` registers a System. Its body receives `entity`, `dt` and lower_snake_case Component bindings (for example `EnemyAI` becomes `enemy_ai`).
- Component member reads and writes are validated against the declared Component fields. Project-wide Component references across multiple `.ps` files are supported.
- The initial phase for a declared `.ps` System is `update`; its runtime priority, enabled state and phase can be adjusted in the Inspector while the game is running.
- These declarations remain browser-game-only. They do not enter the normal `ps -> C++17` console-program pipeline.

Attach `examples/ecs_systems.ps` to a Scene Object. In the ECS Inspector, add `EnemyAI` to the specific objects that should participate in `MoveEnemy` / `Regenerate`, then press Play. The previous all-objects attachment behavior remains only for older Scene Objects that have no explicit `ecsComponents` property.

### Native-build boundary

The Backup menu also exports a **Native C++17 ECS project (.zip)** with Component structs, supported System callbacks, a portable C++17 ECS runtime and a CMake sample project. That export is a native ECS module/sample executable, not a complete PStudio game build. The browser Three.js renderer, GLB pipeline, browser input/audio, JavaScript Physics bridge and broader gameplay systems have not yet been ported to native C++. A complete native game `.exe`, `.app` or APK remains a separate backend/packaging project.

Run the focused JavaScript regression suites with `node --test tests/ecs.test.js tests/ecs_physics.test.js tests/physics.test.js`. The full JavaScript suite is `node --test tests/*.test.js`; Python tests are `python -m unittest discover -s tests -p "test_*.py" -v`.

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
- Node.js regression suites run under Node 24 in the GitHub Actions workflow, including rendering, ECS, events, jobs, modules, platform, resources, localization and model-viewer behavior.
- Python regression suites run under Python 3.12 and compile/execute generated C++17 programs with `g++` for variable-scope, loop, function, division and modulo behavior.
- Server tests cover request-size limits and bounded child-process output/timeout handling.
- The automated suites are source/runtime tests in CI; they do not run a real browser, Android device, WebGL driver or Render deployment.
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

The model loader uses the matching Three.js GLTFLoader and SkeletonUtils clone support. GLB files and bundled GLTF JSON are stored in IndexedDB, not embedded into the project JSON. Relative external buffers and images selected alongside a `.gltf` file are embedded during import. A model can contain multiple animation clips; clip matching is case-insensitive and accepts a partial name. Switching between clips uses a short cross-fade instead of abruptly stopping the previous action. Meshopt, Draco and KTX2/Basis compression are supported through the GLTF worker decoder pipeline when the browser and required CDN decoder modules are available; the renderer-compatible main-thread parser remains a fallback.

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

Each object has an in-memory inventory: `inventory_add(item, count)`, `inventory_remove(item, count)` and `inventory_count(item)`. While Play is active, Health, Inventory, Equipment, CombatState, AIController and MovementIntent are owned by internal ECS Components; QuestProgress is stored on standalone quest Entities and DialogueSession stores conversation content and the selected choice. The existing ps built-ins remain the compatibility API. At Stop, the ECS bridge snapshots the values so the next Play can restore them. These runtime Components are not serialized into editor Scene Objects. Item/weapon/quest definitions remain configuration/service state; Navigation nodes, links, blocked state and A* next-node queries are ECS-owned through `NavigationNode` Components. PStudioUI still owns DOM presentation. Quest flags are shared by quest ID: `quest_start(id)`, `quest_complete(id)` and `quest_is_complete(id)`. A graph-based navigation helper is available through `nav_add_node(id, x, y, z)`, `nav_connect(a, b)`, `nav_build_grid(x, z, width, depth, cell_size)`, `nav_build_from_terrain(x, y, z, width, depth, segments, height, max_slope)`, `nav_build_from_triangles(flat_vertex_array, max_slope)`, `nav_build_from_model(model_name, x, y, z, scale, max_slope)`, `nav_block_node(id, blocked)`, `nav_next_node(start, goal)` and `nav_clear()`. When the ECS bridge is active, node coordinates, edges and blocked state are stored in internal `NavigationNode` Components, and `nav_next_node` runs the ECS-backed A* query; the legacy API remains unchanged. Triangle navigation generation filters out slopes steeper than the configured walkable angle and connects triangles sharing edges. This is a sampled triangle-graph NavMesh approximation, not a hierarchical tiled navigation system. `quest_set_progress(id, value, target)` and `quest_get_progress(id)` provide a minimal objective counter. `use_skill(radius, damage, cooldown)` performs a cooldown-limited radial skill query; `enemy_attack(target, range, damage, cooldown)` performs a range-checked single-target enemy attack. The grid builder creates a capped 2D navigation graph and supports manually blocked nodes; it is not a polygonal NavMesh baked from scene geometry and does not perform obstacle sampling or path smoothing. HUD drawing supports `draw_hud_text(text, x, y, size, color)` and `draw_hud_bar(value, max, x, y, width, height, color)`.


`emit_particles(x, y, z, count, color, speed, lifetime)` emits a short 3D particle burst. Particle count is capped at 400 per burst and the effect is simulated in the browser renderer. Avoid calling it unconditionally every frame; trigger it from an input or gameplay event.


### Stylized NPR toon materials and GPU foliage wind (PStudio 3.0 Step 2)

The renderer now provides an opt-in hybrid PBR/NPR material path. It keeps the Three.js standard/physical BRDF, clustered lighting, image-based lighting and shadow integration, then applies three-color toon ramps, a view-dependent rim response, outline ink and a lightweight pseudo-subsurface term. The pseudo-SSS term is an art-directed lighting approximation, not physical subsurface transport. PBR remains the default; use `set_shader("toon")` or `set_toon_material(...)` only on objects that need the stylized treatment.

The browser game-script API is:

```ps
set_shader("toon")
set_toon_material(
    "#46516f", "#9eafd0", "#ffffff",
    0.32, 0.68,
    "#b8dcff", 0.42, 2.6,
    "#182235", 0.12,
    "#f0a5a0", 0.12,
    0.35, 1.0
)
```

Arguments, in order: shadow, midtone and highlight colors; shadow and highlight thresholds; rim color, intensity and power; outline color and width; pseudo-SSS color and intensity; GPU wind strength and speed. Colors use `#RRGGBB`. Numeric values are bounded by the runtime before reaching shader uniforms. `set_toon_material` also selects the toon path for subsequent primitives and imported models owned by the script.

The shared Object Inspector exposes the toon/rim/outline/pseudo-SSS controls plus foliage wind controls for both script-owned 3D primitives and GLB models. GLB material-specific overrides expose the same controls per named material; the shared Object Inspector applies its settings across the selected object's 3D materials. Overrides are applied to per-instance material clones; the imported asset data and other instances are not rewritten. Foliage deformation is evaluated in the vertex shader and supports both the automatic name/role-based foliage path and explicit material wind settings. Outlines use expanded back-face shell passes for regular, skinned and instanced meshes. Multi-material GLBs retain each material slot's alpha-test/transparent texture masking; shells use depth testing, no depth writes, and do not participate in raycasts or shadow passes. Verify the actual WebGL shader compile and visual result on each target GPU.

## Cinematic gameplay APIs

The browser-only game runtime includes a small set of time and presentation controls for action-game feedback. These calls are available in attached `.ps` Game Object scripts validated by `/game/prepare`; they are not normal `ps -> C++17` built-ins.

```ps
func start()
    set_time_scale(1)
    set_god_rays(true, 0.7, 0.97)
    set_camera_lens(true, 18, 2.8, 0.08)
    set_color_grading(0.25, 1.08, 1.1, 0.15, 0.22, 0.04)

func update(dt)
    if was_key_pressed("space")
        camera_shake(0.9, 0.24)
        set_time_scale(0.2)
    if not is_key_down("space")
        set_time_scale(1)
    # Call every frame to record the moving target's path.
    draw_trail("Weapon", "#8fe6ff", 0.08, 0.3)
```

- `camera_shake(intensity, duration)`: triggers a decaying 3D camera impulse. Intensity is bounded to 0–2; duration is seconds, bounded to 0–8. Its envelope uses wall-clock time, so it is not frozen by `set_time_scale(0)`.
- `set_time_scale(scale)`: sets the scene simulation multiplier, bounded to 0–4. Zero freezes the runtime delta time; values below/above 1 slow down/speed up script `update(dt)`, ECS, physics and runtime-clock effects. Browser audio playback and wall-clock timers are not time-scaled. The value resets to 1 on the next Play session.
- `draw_trail(target_id, color, width, duration)`: records the world-space position of a Scene Game Object resolved by its id or name. Call it repeatedly from `update(dt)` to form a moving ribbon; a one-off call cannot infer a path. Width is in world units (0.001–1) and lifetime is seconds (0.05–10). The renderer retains up to 64 simultaneous trails, each with up to 48 sampled points; the oldest trail is disposed when that budget is reached.
- `set_god_rays(enabled, intensity, decay)`: enables screen-space radial light shafts from the projected sun. Intensity is bounded to 0–2 and decay to 0.8–0.995. The third argument is optional for compatibility with existing two-argument scripts. Quality presets control the ray-pass resolution and sample count; the mobile preset disables volumetric fog and rays. If the shader pass is unavailable or fails, PStudio falls back to Bloom when available.
- `set_camera_lens(dof_enabled, focus_distance, aperture, chromatic_aberration)`: enables depth-of-field (DoF) and/or chromatic aberration. Focus distance is camera-space depth in world units (0.1–100,000); aperture is an f-number from 1.2 to 22 (smaller values produce stronger blur); chromatic aberration is an intensity from 0 to 1. Set `dof_enabled` to false to use chromatic aberration alone. Lens effects are off by default. The mobile quality profile suppresses DoF; balanced/high/ultra profiles scale its render target and blur radius. A memory-safety event suppresses both lens effects while preserving their requested settings. If only the depth prepass fails, DoF is suppressed but chromatic aberration can still run when GPU resources are available.
- `set_color_grading(exposure, contrast, saturation, temperature, vignette, film_grain)`: controls the cinematic finishing pass before `OutputPass`. Exposure is in EV (-3 to +3); contrast and saturation are 0–2 (1 is neutral); temperature is -1 (cool) to +1 (warm); vignette and animated film grain are 0–1. All identity values disable the pass, so there is no additional grading work by default. A shader failure restores the unmodified input frame and disables grading until the API is called again. Memory safety also disables the pass while retaining the requested settings.
  
The DoF pass uses the existing opaque-scene depth prepass and a 12-tap depth-aware blur at reduced resolution, then composites before OutputPass. Transparent materials, wind-deformed foliage, static foliage batches and sky geometry are excluded from the existing depth prepass, so their blur boundaries are not guaranteed to be accurate. It is a real-time screen-space lens approximation, not a physically based lens simulation.

The color-grading pass is a single full-resolution shader pass after the lens effects and before `OutputPass`. It works in the renderer's linear intermediate color buffer so the existing ACES tone mapping and sRGB output conversion remain in the final output stage. Film grain uses a time-varying screen-space hash; it is not a film-stock or sensor simulation.

These are screen-space/art-directed effects, not physically simulated volumetric light transport. Lens and God Rays passes are inserted before the final output/tonemapping pass to preserve the compositing color pipeline. Real-device WebGL shader compilation, visual quality and frame-time checks are still required.

## Rendering Engine 1.5 — HDR, Lighting, Water and GPU Optimization

The 3D renderer uses Three.js r160 with ACES filmic tone mapping, sRGB output, PMREM-filtered image-based lighting and directional shadow mapping. Quality presets are available through the renderer API:

| Preset | Pixel ratio cap | Directional shadow map | Screen-space effects |
|---|---:|---:|---|
| `mobile` | 1.0 | 1024² PCF | off |
| `balanced` | 1.5 | 2048² PCF | off |
| `high` | 2.0 | 3072² VSM | GTAO + SSR |
| `ultra` | 2.25 | 4096² VSM | GTAO + SSR + full volumetrics |
| `cinematic` | 2.5 | 4096² VSM | higher-sample GTAO, SSR, full-resolution volumetrics and DoF |

`auto` prefers the mobile profile on touch devices, balanced on narrow non-touch windows, and high on wider desktop layouts. VSM provides soft filtered directional shadows; balanced/mobile use PCF soft shadows. GTAO is preferred when its addon loads, with SSAO as a fallback. Screen-space reflections are optional and enabled by high/ultra presets. Bloom remains opt-in through `set_postprocessing(...)`; it is not forced onto every scene. The Scene Environment inspector exposes these renderer profiles as a persistent local quality preference. `auto` adapts render scale to frame time; manual profiles keep their selected tier until a memory-safety limit is reached. `cinematic` is deliberately restricted to devices reporting at least 6 GiB of memory; devices below that threshold are mapped down to a safer profile (`mobile` at 2 GiB or less, `balanced` through 3 GiB, `high` below 4 GiB and `ultra` below 6 GiB) and increases render scale, GTAO samples, volumetric raymarch steps/samples and depth-of-field quality. Selecting a higher tier therefore increases GPU work and memory bandwidth; actual frame rate still depends on the device, scene complexity and browser GPU driver. The Studio environment uses three RectAreaLight softboxes when their shader support initializes, with directional fill lights as a fallback.

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
- **Navigation:** `nav_build_from_terrain(x, y, z, width, depth, segments, height, max_slope)`, `nav_build_from_triangles(flat_vertices, max_slope)` and `nav_build_from_model(...)` build an edge-connected walkable triangle graph. Runtime nodes/edges/blocking and A* next-node queries are ECS-owned by `NavigationNode` Components. This remains an approximate static NavMesh; dynamic obstacle re-baking, off-mesh links and hierarchical streaming are not included.


## Rendering Engine 1.6 — Spatial Irradiance and Large-World Rendering

`PStudio3D.bakeLightProbeVolume(options)` captures a bounded grid of spherical-harmonic (SH) irradiance probes (2–4 samples per axis, at most 32 probes, 32–128 cube resolution). Structured grids preserve their bounds and dimensions, allowing per-object 3D trilinear interpolation of the eight surrounding SH samples before the irradiance is added to standard/physical materials. Legacy or unstructured probe arrays retain inverse-distance blending. This remains a baked, object-local diffuse GI approximation; it is not a full dynamic ray-traced solution or a UV lightmap texture baker. Re-bake after major static lighting, geometry or environment changes.

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
- `PStudio3D.setWorldStreamingInterests([{ id, x, y, z, priority, loadMultiplier, unloadMultiplier }])` supplies multiple player/camera interest points. Active chunks remain resident while any interest stays within its unload radius.
- `PStudio3D.setWorldRenderConfig({ maxConcurrentChunkLoads })` bounds concurrent chunk asset loads (1–32; default 4).
- Scene authoring can use persistent `WorldPartition` Components for region membership and `StreamingInterest` Components for moving/static interest points; the ECS bridge synchronizes them before Physics and rendering. The renderer remains responsible for async asset loading and GPU resource lifetime.
- Three.js frustum culling remains enabled for ordinary meshes and model submeshes. Instanced batches compact visible instances and refresh selection mappings.

Directional shadow coverage follows the camera target and snaps its center to shadow-map texels to reduce shimmering. This describes the earlier single-camera baseline; the later Rendering Engine 1.7 section documents the optional three-cascade CSM path and single-camera fallback. Chunk streaming was subsequently extended in Rendering Engine 1.8 to suspend owner scripts, physics, ECS iteration and owner audio while preserving runtime state.

## Rendering Engine 1.7 — Object-Space GI, Cascaded Shadows and Adaptive Worlds

### Object-local indirect lighting

The spatial probe volume supplies each supported mesh with SH coefficients evaluated at that object's world-space position. Regular probe grids use 3D trilinear interpolation across the eight surrounding grid samples; weights are clamped to the baked volume bounds and normalized when samples are available. Legacy or unstructured probe arrays use inverse-distance weighting, with `probeBlendCount` controlling that fallback. Standard and physical materials evaluate the interpolated SH irradiance in the indirect-diffuse shader path. `PStudio3D.bakeLightProbeVolume(options)` supports bounded iterative capture passes:

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

The first pass captures direct and environment illumination. Up to four later passes disable direct emitters and the environment, then feed only the previous diffuse-bounce field back through scene materials; a low-energy threshold can stop the iteration early. This improves multi-bounce color transfer while avoiding repeatedly adding direct light. It remains a spatial-SH approximation: it does not perform visibility-correct surface-to-surface ray transport, dynamic path tracing, or physically complete GI for moving lights and geometry. UV lightmaps are available through `PStudio3D.bakeUVLightmaps({ resolution })`. The current atlas gives each triangle a separate non-overlapping chart, evaluates interpolated probe SH irradiance per texel, and applies a linear half-float `lightMap` texture using the second UV channel. `saveLightmaps(name)` and `loadLightmaps(name)` persist UV2 coordinates and texture data in browser IndexedDB; `clearLightmaps()` removes the runtime application. This is a deterministic per-triangle atlas rather than a seam-aware chart packer, and the bake stores probe-derived diffuse irradiance rather than full direct-shadow/path-traced transport. Skinned meshes are excluded. The default memory budget scales with reported device memory (capped at 256 MiB); pass `maxBytes` to override it. Re-bake after topology or static-lighting changes.

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

## Rendering Engine 1.8 — UV Lightmaps, BVH Occlusion and Chunk Lifecycle


### UV lightmap workflow

Bake the spatial probe volume first, then generate and apply a lightmap atlas to currently loaded meshes. Stop Play before either bake so the scene remains static. Use `ownerIds` to limit the bake to known static scene objects:

```js
await PStudio3D.bakeLightProbeVolume({
  min: { x: -40, y: 0, z: -40 },
  max: { x: 40, y: 16, z: 40 },
  xCount: 3, yCount: 2, zCount: 3,
  resolution: 64, bounces: 2, bounceStrength: 0.3
});
const result = await PStudio3D.bakeUVLightmaps({
  resolution: 512,
  ownerIds: ['building-01', 'ground-01'],
  maxBytes: 64 * 1024 * 1024
});
console.log(result);
await PStudio3D.saveLightmaps('world-lighting');
```

After scene objects and model assets load in a later session, call `await PStudio3D.loadLightmaps('world-lighting')`. Mesh identifiers use scene-object command order and model hierarchy paths; changing topology, command order or the baked world transform invalidates a saved entry. Lightmap data is stored in that browser's IndexedDB, so include it in a project backup workflow before moving devices.

### Audio and streamed-owner lifecycle

```ps
func start()
    play_sound("forest_ambience.ogg", 0.65, true)

func update(dt)
    if dt > 0
        set_sound_volume("forest_ambience.ogg", 0.65)
```

The audio asset must already be imported into the project. `play_sound(name, volume, loop)` plays it for the calling Game Object; `stop_sound(name)` stops that owner's sound and `set_sound_volume(name, volume)` changes its volume. Browser autoplay restrictions can still prevent playback until the user interacts with the page.

## Rendering Engine 1.9 — Worker inspection and staged GPU startup

Large .glb files are now structurally inspected in static/pstudio_model_worker.js. The worker checks the GLB header and chunk boundaries, parses the glTF JSON, validates buffer-view references, inspects embedded PNG/JPEG dimensions, and estimates geometry, decoded-texture, CPU and GPU resource sizes. The editor transfers the File object to the worker rather than first copying the complete model into a JavaScript ArrayBuffer. If Web Workers are unavailable or fail to start, the previous main-thread validator remains as a compatibility fallback.

**Important boundary:** this worker performs import-time validation and metadata analysis; it does not yet move the complete Three.js GLTFLoader scene construction pipeline off the main thread. GLTFLoader still parses the actual scene, creates Three.js objects and resolves embedded image resources on the main thread. The scene-decode-start / scene-decoded events report the duration of that stage so it can be measured separately. A future transferable scene/geometry pipeline is required to eliminate that remaining CPU-side bottleneck.

After a model instance is constructed, it stays hidden while unique material textures are initialized one per animation frame with WebGLRenderer.initTexture. This spreads texture upload work over multiple frames, but a single very large texture upload remains an indivisible GPU operation. When the device exposes KHR_parallel_shader_compile and the installed Three.js renderer provides compileAsync, PStudio prepares scene shader programs asynchronously before showing the model. Browsers without that capability use the regular renderer compilation path; PStudio does not force a synchronous compile pass.

Static imported mesh sub-objects use Three.js frustum culling. Skinned and morph-target meshes remain conservatively visible because their animated bounds may exceed their undeformed geometry bounds. Primitive InstancedMesh batches additionally test individual source bounds against the camera frustum before compacting visible instance transforms. Foliage and modular architecture continue to use chunk-local GPU instancing. Authored LOD0, LOD1, etc. groups and generated static-mesh LOD now use model/mesh bounding-sphere centers for distance decisions rather than relying only on the scene-object origin.

Memory diagnostics expose JavaScript heap pressure and PStudio CPU/GPU resource-cache budget pressure alongside renderer geometry/texture counts. The browser does not expose exact per-texture VRAM allocation, so GPU pressure is an estimate from registered resource sizes, not a hardware VRAM measurement. Automatic safety mode protects retained model data and adjusts expensive screen-space effects/render scale; it does not delete source assets or silently replace model geometry. A 1 GB import ceiling is a file-acceptance limit, not a guarantee that a 1 GB model can be decoded or rendered on a particular device.

## Rendering Engine 2.0 — Worker GLTF, Virtual Textures and Clustered Forward Lighting

### Worker-first GLTF asset pipeline

The primary binary GLB path now runs Three.js r160 GLTFLoader `parseAsync()` inside a dedicated module Worker. The editor passes the IndexedDB Blob to that Worker instead of first expanding the entire file into an ArrayBuffer on the editor thread. The Worker uses Meshopt decoding and configures Draco and KTX2/Basis transcoders when their modules and worker environments are available.

The parsed Three.js scene is serialized into a transferable packet: scene-node hierarchy and transforms, typed geometry buffers, index and morph attributes, material properties and texture references, skeletons and inverse bind matrices, InstancedMesh transforms, cameras, lights and animation clips. Non-interleaved geometry attributes backed by the same GLTF ArrayBuffer retain their byte offsets and are transferred as shared backing buffers, avoiding a separate copy per attribute. Interleaved attributes are repacked into typed arrays so their stride/offset and integer-normalization semantics remain correct; ImageBitmaps and compressed mip buffers are transferred rather than base64-expanded. The main thread reconstructs the Three.js objects in bounded batches across animation frames because live Three.js objects and the WebGL context cannot be transferred as structured-clone objects.

The renderer builds model instances, duplicates material state, creates world-stream chunks and forms foliage/architecture instance batches incrementally. Static and deforming meshes keep their original geometry and animation data; the pipeline does not simplify source meshes merely to get through loading. Failed worker initialization, unsupported decoder conditions, or packet transport failures use the renderer-compatible main-thread GLTFLoader path where possible.

### Staged GPU preparation

New model instances remain hidden while the renderer initializes their unique textures one per animation frame. On devices exposing `KHR_parallel_shader_compile`, Three.js `compileAsync()` prepares the new model's shaders before it becomes visible. The model's visible scene is then committed on a subsequent animation frame.

This spreads work across frames but cannot subdivide every indivisible GPU command: one oversized texture or one compressed mip-level upload can still take a long frame. GPU upload is performed by the main-thread renderer because the WebGL context belongs to that renderer; the Worker performs parsing, decompression/transcoding and packet preparation, not WebGL calls.

### Virtual texture pages

For large raster images decoded from GLB (currently the PNG/JPEG ImageBitmap route, with a longest dimension above 2048 pixels), the GLTF Worker retains the full-resolution source bitmap and transfers a small fallback bitmap to the renderer. Visible mesh UV samples request 256×256 source tiles. The Worker extracts the requested tile with OffscreenCanvas, and the renderer uploads it into a bounded GPU atlas using Three.js r160 `copyTextureToTexture()` partial updates. A page table directs supported PBR material texture slots to resident atlas pages, while absent or coarse pages fall back to the low-resolution source texture. The atlas uses a bounded LRU page cache; evicted page-table entries are invalidated. Atlas dimensions are 1024² on devices reporting at most 2 GiB, 2048² on mid-range devices, and 4096² on devices reporting at least 8 GiB.

The current page request selection is a CPU-side sampled triangle-centroid visibility estimate, not GPU feedback or a complete virtual-texturing system. The atlas currently has no per-page mip chain or anisotropic page-border stitching, and KTX2 compressed textures are transferred as compressed mip levels rather than virtualized into pages. If OffscreenCanvas/ImageBitmap support is missing, the importer uses the regular full-image texture path instead. These are explicit quality/performance boundaries, not silent texture-quality changes.

### Clustered forward point lighting

On WebGL2 devices that support float texture sampling, the renderer can assign up to 96 dynamic point lights to a 16 × 9 × 16 screen/depth cluster grid, with up to 24 light indices per cluster. CPU-side cluster construction uses camera-space light bounds and logarithmic depth slices; the material shader samples only the current fragment's cluster and evaluates its local point lights on the GPU. When this path is unavailable or disabled, native Three.js point-light rendering remains active.

This first clustered path supplements the existing directional/hemisphere/environment lighting with clustered direct diffuse point-light contribution. It does not yet replace the full Three.js BRDF for clustered specular highlights, point-light shadows, spot lights, area lights or physically complete all-light transport. Use `PStudio3D.setClusteredLighting(true|false)` to select the path, and inspect `PStudio3D.getStats().clusteredLighting` for availability and active-cluster counts.

### GPU instance culling and memory visibility

Instanced batches retain their original instance mapping for scene selection. A vertex-shader bounding-sphere test rejects individual instances outside the camera frustum; regular static meshes use Three.js frustum culling, while skinned and morph-target meshes keep conservative visibility bounds. LOD decisions use world-space model/mesh bounds, and foliage/architecture batch construction is spread across animation frames.

Renderer diagnostics expose staged preparation, virtual-texture page counts, clustered-light counts, renderer geometry/texture counts and PStudio CPU/GPU resource-cache estimates. WebGL does not expose exact per-allocation VRAM usage, so GPU cache pressure remains a registered-size estimate rather than a hardware VRAM reading. The 1 GB GLB import limit is a storage/acceptance ceiling, not a promise that every 1 GB asset can be rendered on every device.

**Validation boundary:** source syntax and static regression assertions are included in the repository's Node test suite. Real GPU shader compilation, visual equivalence across complex glTF variants, browser-specific decoder-worker behavior, and low-memory Android stress tests still require runtime testing on actual supported browsers and devices.


## Model loading diagnostics and recovery

GLB files use the dedicated GLTF module Worker. JSON glTF files bundled into the asset store use the regular Three.js GLTFLoader Blob-URL path; they are not sent to the GLB-header parser. A Worker packet that parses but cannot be rehydrated into the live Three.js scene is released and retried through the main-thread loader when the failure is not a malformed-file or memory-allocation failure. Decoder instances created for the fallback are disposed after parsing.

Model loading stages are surfaced in the Scene status line. Worker parsing, packet hydration, instance creation, texture preparation, and initial-render failures produce an OUTPUT error with a retry path. Scene Refresh now refreshes the active 2D or 3D view and re-enters the model loading path for previously failed models. A failed instance build is retained as an explicit error state rather than being silently retried on every render.
