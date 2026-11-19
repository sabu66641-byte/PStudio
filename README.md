# PStudio Game Engine 3.0.0

PStudio is an indentation-based `ps` IDE with two separate execution paths:

- **Normal ps programs:** `ps -> C++17 -> g++ -> execute` through `/run`.
- **Game scripts:** `ps -> validated AST -> PStudio browser runtime` through `/game/prepare` and the Scene **Play** control.

The game runtime does not send a request to the server every frame. Scripts are parsed and validated once when Play is pressed; `start()` runs once per object, then `update(dt)` runs from `requestAnimationFrame`. `dt` is seconds and is clamped to 0.1 seconds to avoid large simulation jumps after a stalled frame.

## Included files

- `app.py` — Flask app, original ps lexer/parser/validator/C++ generator/Discord endpoints, plus game AST and compile endpoints.
- `templates/index.html` — PStudio IDE, project explorer, editor, scene, inspector, asset handling and existing language UI.
- `static/pstudio_engine.js` — browser-side game runtime.
- `discord_runtime.py` — original Discord runtime dependency.
- `network.py` — existing network runtime module, included unchanged.
- `examples/` — a small player/enemy scene example.
- `backup/` — untouched copies of the original uploaded `app.py` and PStudio HTML for rollback.

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
- This is a game-development foundation, not a finished large-world action-RPG engine. The current runtime includes PMREM-filtered environment lighting, optional Bloom/SSAO post-processing, planar Reflector water, primitive GLSL shader nodes, named GLB material overrides, terrain collision, triangle-derived navigation, moving/rotating platform carry, adaptive swept collision, persistent particle emitters, animation layers, CCD-style bone IK, weapon combos and elemental reactions, a small enemy state machine, equipment/consumable inventory, quest prerequisites/rewards, dialogue choices and DOM-based game UI. Still missing are true multi-bounce real-time global illumination, HDR lighting capture, a free-form drag-and-drop shader graph, water refraction/wave simulation, fully general CCD for arbitrary deforming meshes, dynamic NavMesh updates, motion-capture-grade IK/retargeting, tactical squad AI, complex hitbox animation events, multiplayer, audio mixing, save/load of live gameplay state and a standalone build/export pipeline.
- Browser local storage is still the project persistence layer; large base64 assets can exceed browser storage quotas.

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


## Rendering and Shader Controls

The 3D runtime supports directional, point and spot lights. `set_environment(sky_color, ground_color, intensity)` creates a procedural environment map that is PMREM-filtered for image-based lighting; it is not multi-bounce global illumination. `draw_terrain(...)` creates matching render and collision triangles. `draw_water(...)` uses a planar reflection when the Reflector addon loads; this is an approximate planar mirror, not refraction or animated wave optics. `set_shader(...)` selects built-in material presets. `set_model_material(name, roughness, metalness, color)` applies named or `*` overrides to cloned GLB materials. The Inspector includes a compact fixed three-node shader graph (solid, stripe, checker, radial and glow patterns) and direct GLSL text editing for primitive geometry.

## Custom GLSL Shader Editor

Select a non-model Scene object and use the **Shader Editor** graph or GLSL editor. The graph is a compact fixed flow (Color Input → UV Pattern → Fragment Output), not an unrestricted draggable node canvas. GLB material overrides are edited separately in the model Inspector by material name or `*`. PStudio supplies a fixed vertex shader with `uColor` and `vUv`; shader compilation depends on browser WebGL support.


## Extended Gameplay, Navigation and UI

- **Continuous particles:** `particle_emitter(id, rate, color, speed, lifetime, max_count)` maintains a per-object emitter while the call is present in `update()`. `stop_particle_emitter(id)` stops it. The Inspector exposes a basic emitter editor; each emitter is capped at 1,200 particles and the renderer caps active emitters at 32.
- **Weapons and elements:** `weapon_define(name, range, arc_degrees, damage_multiplier)` stores a named weapon's range, attack arc and damage modifier. `weapon_attack(weapon, element, radius, damage, combo_window_ms)` uses that profile when defined and applies a forward-facing cone hit test, a five-step combo multiplier and basic reactions (Vaporize, Melt, Freeze, Bloom, Quicken, Superconduct, Electro-Charged and Burning). It is not a full attack-animation/hitbox authoring system.
- **Enemy state AI:** `enemy_ai(target, sight_range, attack_range, speed)` switches among idle, chase, attack, retreat and dead. It can follow the generated triangle graph when one exists; it does not perform tactical squad planning or dynamic cover analysis.
- **Inventory:** `define_item(item, kind, slot, value)`, `inventory_add`, `equip_item` and `use_item` define equipment and consumables. `open_inventory()` and `open_quest_log()` open the built-in DOM panels.
- **Quests and dialogue:** `quest_define(id, prerequisite, reward_item, reward_count)` defines a simple dependency and reward. Use `quest_start`, `quest_set_progress`, and `quest_complete`. `show_dialogue(speaker, text, choice1, choice2, choice3)` displays choices; `dialogue_choice()` reads the player's latest selection.
- **Navigation:** `nav_build_from_terrain(x, y, z, width, depth, segments, height, max_slope)`, `nav_build_from_triangles(flat_vertices, max_slope)` and `nav_build_from_model(...)` build an edge-connected walkable triangle graph. This is an approximate static NavMesh; dynamic obstacle re-baking, off-mesh links and hierarchical streaming are not included.
