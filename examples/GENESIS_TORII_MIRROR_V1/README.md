# GENESIS_TORII_MIRROR_V1

A deterministic, manually assembled torii/mirror-water benchmark fixture for the PStudio renderer. This six-object reference fixture is intentionally separate from the one-click **Scene Environment → GENESIS 鳥居・水鏡デモを開く** procedural moonlit shrine showcase. Use this folder when a small, fixed script-based baseline is needed; the Inspector showcase is renderer-owned geometry and does not load these six scripts.

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

Set the scene viewport to 960×540, use the High profile for the first baseline, keep the render scale unchanged, and leave the browser tab in the foreground. The Scene Environment inspector now provides a continuous time slider, weather selector (Clear / Cloudy / Overcast / Rain / Storm), wind speed/direction, and optional automatic time progression. Those controls drive the shared atmosphere, lighting, fog, cloud drift, foliage sway, mirror-water waves and rain-impact ripples. The Water script keeps the reference surface at a fixed position; the environment controller supplies its runtime wave amplitude.

## Capture discipline

1. Start from a freshly loaded copy of the fixture.
2. Wait 20 seconds for shader compilation, texture uploads, and adaptive quality to settle.
3. Capture a still image and a 30-second temporal run for each environment preset.
4. Record commit SHA, browser/version, OS, GPU/driver, backend, canvas/DPR, quality preset, effective render scale, power mode, and foreground state.
5. Export the performance overlay data at the end of each run. Preserve frame-interval, CPU render-path, and GPU render p50/p95/p99 plus sample counts.
6. Repeat each environment capture three times without changing the camera, resolution, exposure, or object layout.

## Scope and known omissions

This is the integrated GENESIS demo fixture, but not yet a full visual qualification harness. It covers opaque torii geometry, terrain, foliage proxies, planar mirror reflection, depth-aware ordinary water, camera-local GPU rain particles, wind-driven waves, weather-driven ripple rings and shared sky/light/fog updates. It still lacks a standardized transparent imported reference asset, a repeatable automated camera path, golden-reference screenshots and a browser-side capture/metadata exporter. Physical-device visual and performance baselines also remain outstanding.
