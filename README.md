# PStudio Game Engine 2.0.0

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
- The browser runtime provides frame lifecycle, per-object script state, keyboard/pointer input, 2D drawing, 3D primitive rendering, a persistent 3D mesh cache, basic 2D/3D collision callbacks, and simple 3D environment controls.
- The 3D renderer supports cubes, boxes, spheres, planes, cylinders, cones and capsules. Environment controls include background color, distance fog and one configurable directional light.
- It is not yet a full action-RPG engine: rigid-body physics, gravity, player character controller, terrain streaming, skeletal model import, animation blending, navigation, particles, audio mixing, combat and save systems are future work.
- Browser local storage is still the project persistence layer; large base64 assets can exceed browser storage quotas.

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
