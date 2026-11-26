# GENESIS_TORII_MIRROR_V1

A deterministic starter fixture for the PStudio WebGL2 renderer. The fixture is assembled from separate Game Objects because each Game Object supplies its own base material color.

## Build the scene

Create six Game Objects in a new 3D scene and attach the matching `.ps` script from this directory. Set the Game Object colors as follows:

| Game Object | Script | Color | Purpose |
|---|---|---|---|
| GENESIS Camera | `camera.ps` | `#FFFFFF` | Fixed camera pose |
| GENESIS Ground | `ground.ps` | `#637C59` | Terrain and shoreline |
| GENESIS Torii | `torii.ps` | `#A83F32` | Opaque torii structure |
| GENESIS Mirror Water | `water.ps` | `#174B68` | Planar reflection surface |
| GENESIS Foliage | `foliage.ps` | `#47734B` | Repeated vegetation silhouettes |
| GENESIS Particles | `particles.ps` | `#D6E8FF` | One-shot particle capture |

The scripts issue fixed world-space draw commands. Their 3D geometry does not depend on the Game Object's 2D canvas position. Attach the supplied source file as the Game Object script; do not combine the files into one script because each Game Object's color is used as its primitive material color.

Set the scene viewport to 960×540, use the High profile for the first baseline, keep the render scale unchanged, and leave the browser tab in the foreground. Set the scene environment from the editor to Day, Dusk, and Night for the three lighting captures. The Water script keeps the water surface at a fixed position and amplitude.

## Capture discipline

1. Start from a freshly loaded copy of the fixture.
2. Wait 20 seconds for shader compilation, texture uploads, and adaptive quality to settle.
3. Capture a still image and a 30-second temporal run for each environment preset.
4. Record commit SHA, browser/version, OS, GPU/driver, backend, canvas/DPR, quality preset, effective render scale, power mode, and foreground state.
5. Export the performance overlay data at the end of each run. Preserve frame-interval, CPU render-path, and GPU render p50/p95/p99 plus sample counts.
6. Repeat each environment capture three times without changing the camera, resolution, exposure, or object layout.

## Scope and known omissions

This is the first fixed core fixture, not a completed full qualification scene. It covers opaque torii geometry, terrain, foliage proxies, planar water reflection, and a one-shot particle burst. It does not yet include a standardized transparent imported asset, rain input, a wind controller, an automated camera path, golden-reference screenshots, or a browser-side capture/metadata exporter. Those remain explicit GENESIS 0 acceptance gaps; do not report the fixture as a full pass until they are added and tested.
