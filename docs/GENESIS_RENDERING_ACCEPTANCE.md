# GENESIS Rendering Acceptance and Phase Plan

**Status (2026-11-26):** GENESIS 0 and GENESIS 1/2 implementation changes are merged into `main`. GENESIS 1/2 was merged in commit `7968bda6209c6e6a196b4566fa30c565a2a79f62` via [PR #103](https://github.com/sabu66641-byte/PStudio/pull/103). Candidate CI #1385 and post-merge `main` Push CI #1386 both passed. This confirms source, regression and build-smoke checks; it does not certify physical-device visual quality. Browser-based captures, named-device WebGL2 baselines, WebGPU hardware parity, device-loss recovery and the 60-minute soak remain unverified. See docs/GENESIS_DEVICE_MATRIX.md. This document is an acceptance contract, not a claim that all hardware exit gates have passed.

## Mission

Build one coherent real-time environment-rendering system for PStudio. Atmosphere, weather, water, lighting, shadows, GI, and VFX must describe the same world state. The integrated torii-and-water-mirror scene is the reference workload used to verify both visual quality and runtime behavior.

A feature is not considered complete because a module exists or a shader compiles. It is complete only after its visual behavior, frame-time cost, resource lifetime, backend compatibility, and failure behavior have been checked.

## Non-negotiable engineering rules

1. Preserve the existing WebGL2 renderer and every existing editor/gameplay API. WebGPU promotion remains gated until a supported physical device passes the hardware checks.
2. Keep one normalized environment state as the authoritative source for sky, sun, moon, clouds, fog, water, direct lighting, reflections, and weather-driven VFX.
3. Never silently disable a configured effect in High/Ultra. If a target device cannot sustain the requested profile, report the unmet budget and expose the reason. Dynamic resolution and explicitly permitted update-rate/resolution budgeting may be used, but every adjustment must be observable.
4. Do not hide unsupported materials, failed passes, or missing GPU capabilities. Fail closed with a useful diagnostic and preserve the WebGL2 recovery path.
5. Keep frame-loop allocations, shader recompilation, resource duplication, and unbounded render-target growth out of steady-state rendering.
6. Describe approximations honestly. SH probe GI, screen-space reflections, planar reflections, and rasterized refraction must not be described as path tracing, complete multi-bounce GI, or physically complete fluid simulation.

## Source-audit snapshot

The following is a source-level review of the default branch as of 2026-11-26. It is not a physical-device benchmark.

### Foundations already present

- Three.js r187 WebGPU/TSL backend, strict material preflight, reversible material conversion, and a separate-canvas WebGPU bridge.
- WebGL2 remains the visible production backend. The migration status intentionally reports `productionReady: false`; WebGPU initialization failure and device loss have a WebGL2 recovery path.
- A GPU-independent environment normalizer supplies sun/moon direction and color, sky palette, fog parameters, cloud parameters, and water tint/absorption.
- TSL sky/IBL generation, TSL volumetric cloud/fog passes, water depth prepass, TSL water surfaces, and planar reflection support.
- Forward+ clustered lighting, SH probe irradiance, GPU probe capture, CSM, GPU particles/trails, and TSL post-processing foundations.
- Frame-budget coordination, frame p95 telemetry, CPU submission timing, GPU timing when supported, draw/triangle counters, and estimated resource-memory diagnostics.
- Python, Node.js, Three.js import/syntax, and renderer regression suites are wired into GitHub Actions.

### Gaps that block the GENESIS acceptance target

- The shared environment state currently represents named presets (day, dusk, night, studio). Its normalized contract does not yet provide a complete time-of-day clock or weather model for rain, wind, precipitation, and wetness.
- The WebGPU equirectangular sky/IBL map is regenerated on explicit environment changes. That is a useful foundation, but it is not proof of smooth time-of-day transitions or view-dependent dynamic weather.
- Water already has depth-aware absorption, procedural waves/foam, a depth prepass, and planar reflection support. The integrated scene still needs visual and temporal verification across day, dusk, night, camera motion, wind, and rain.
- The frame-budget broker coordinates reflection cadence/resolution, GI capture cadence, and cloud/fog/contact-shadow steps. The baseline audit found an adaptive touch-mode path that disabled premium screen-space and volumetric passes. This GENESIS 0 change removes that coupling: the touch budget now applies to resolution and sampling policy only, while configured effects remain active. The regression test enforces this; emergency memory-safety suppression remains separately visible. Physical-device validation is still pending.
- Existing telemetry has known limits: WebGL GPU timer queries depend on browser extensions; CPU render-submission time is not total CPU frame time; resource-registry GPU memory is an estimate, not driver-reported allocation; these values must be labeled accordingly.
- Automated tests and module smoke tests do not prove browser image parity, Android GPU behavior, sustained frame pacing, total memory stability, or device-loss recovery on physical hardware.

## GENESIS 0 — Baseline & Audit

### Required reference fixture

Create a deterministic benchmark fixture named `GENESIS_TORII_MIRROR_V1` with:

- One torii, its surrounding terrain/shoreline, a large mirror-water surface, and representative opaque, transparent, emissive, foliage, and particle materials.
- Fixed camera poses plus a repeatable camera path that passes near the water, across the shore, and around the torii.
- Fixed scene seed, asset versions, output resolution, render scale, exposure, and environment inputs for every capture.
- Capture points for daytime, golden-hour dusk, moonlit night, overcast weather, rain, and wind. Include both still captures and short temporal sequences.

### Baseline record

For each run, record the date, commit SHA, browser/version, OS, device/GPU and driver when available, backend, canvas size, DPR, render scale, quality preset, power mode, and whether the tab is foregrounded.

Measure and retain:

- Frame interval p50/p95/p99 and dropped/stalled-frame counts. The renderer telemetry now exposes nearest-rank p50/p95/p99 and sample counts for frame intervals.
- CPU render-path duration p50/p95/p99, kept separate from frame intervals. This is measured around the renderer branch; it is not a complete application/game-update CPU profile. A separate full update-loop timer remains required before that acceptance item can pass.
- GPU frame time only when a valid GPU timing mechanism is available; identify the source and mark unavailable/stale/disjoint samples rather than substituting CPU time.
- Draw calls, triangles, geometry/texture counts, render-target dimensions/counts, and estimated resource memory.
- Available process/device memory signals, clearly distinguished from actual GPU allocation.
- Screenshots and temporal captures with the fixture metadata attached.

Run a warm-up before measurement and collect repeated foreground runs. The telemetry uses a rolling 120-sample history and nearest-rank percentile selection (`ceil(p × n) - 1`). Always record the sample count. Never compare different scenes, resolutions, exposure values, or camera paths as though they were equivalent. Preserve the raw measurements; do not keep only averages. Frame interval percentiles include browser scheduling/display cadence; CPU render-path percentiles are not the total app update time. GPU percentiles are only valid while a recent, non-disjoint timer-query result exists. A blank/stale GPU result is unavailable, never a CPU-time substitute.

### Provisional frame budgets

Use the following as initial targets, then validate them against named reference devices:

| Target cadence | Frame budget | Required sustained p95 |
|---|---:|---:|
| 60 FPS | 16.67 ms | <= 16.67 ms |
| 30 FPS | 33.33 ms | <= 33.33 ms |

Record p50, p95, and p99 separately. The 30 FPS tier is a minimum-device target, not permission to silently downgrade a High/Ultra profile. A run only passes a named quality profile when its configured effect set and published render-scale policy remain active. If it misses the target, record a performance failure and optimize the responsible pass.

### GENESIS 0 exit gate

- The fixture and capture protocol are deterministic and versioned.
- Current WebGL2 baseline is measured on named representative devices.
- WebGPU is measured only on browsers/devices that actually expose a supported adapter; unsupported devices are marked not tested, not passed.
- Existing Python and Node.js regression suites pass on the candidate commit, including explicit percentile-helper tests and source-level WebGL2 guards.
- Every known measurement limitation and unverified hardware claim is documented.

## GENESIS 1/2 implementation (merged into main)

The current implementation path is:

- `PStudioGenesisEnvironment` owns smoothed time-of-day transitions, day/dusk/night profile interpolation, weather weights (clear/cloudy/overcast/rain/storm), wind vector/speed, precipitation, wetness, cloud drift and water-wave parameters.
- Scene settings persist through the existing `.scene` and project backup formats. The inspector's time, weather and wind controls update that shared controller; an optional auto-cycle advances time at a slow fixed rate.
- `PStudio3D` uses one full-resolution authored day/dusk/night panorama for both the visible sky and the matching PMREM/IBL source. The redundant GENESIS-only CanvasTexture overlay and its 80–125 ms re-upload loop have been removed; named preset changes refresh the canonical panorama/PMREM once at the original resolution. The shared GENESIS state continues to update sun/moon, key and hemisphere lighting, fog, volumetric cloud/fog uniforms and planar mirror-water uniforms. The active WebGPU environment/IBL profile is refreshed at 250 ms intervals, while water-specific TSL uniforms are updated each renderer frame.
- WebGPU water settings are forwarded through the TSL water surface handle and every production layer (scene session → runtime → host → bridge). Wind direction/speed, wave amplitude, rain intensity and ripple strength update existing TSL uniforms rather than rebuilding shader programs.
- `PStudioEnvironmentFX` receives cloud-wind, foliage-wind, water-wave, rain, wetness and water-reflection inputs. Ordinary water retains its depth prepass and Beer–Lambert absorption/transmission path. Mirror water retains its separate planar reflection target and receives wind/rain-driven UV perturbation and ripple rings. The TSL water path receives the same wind/rain state and changes wave displacement, mirror UVs and foam.
- GPU billboard rain particles are emitted around the camera with a bounded 384-particle system, use a single update owner between Editor and Play, and are disposed when rain stops or the 3D scene is cleared.
- The inspector can generate the integrated torii/shoreline/mirror-water/foliage demo from separate `.ps` scripts. The demo is an interactive rendering fixture, not yet a golden-image capture or automated camera-path harness.

**Qualification boundary:** these source changes do not certify WebGL2 visual quality or WebGPU parity on a physical device. Browser/GPU measurements, screenshots and long-running soak results must be added independently before GENESIS 1/2 exit gates can be signed off.

## GENESIS 1 — Unified Atmosphere

Build a single time/weather state model with at least:

- Time-of-day progression and normalized sun/moon direction.
- Sky radiance, solar/lunar contribution, cloud coverage/density/detail, and atmospheric scattering controls.
- Fog color, density, height falloff, anisotropy, and lighting response.
- Weather mode/intensity, precipitation, wind direction/speed, and wetness.
- Shared inputs for sky, IBL, water, direct lighting, shadows, and weather VFX.

Transitions must interpolate continuously. A time/weather update must not cause a one-frame color jump, mismatched sun direction, abrupt fog-density change, sky/IBL disagreement, or shader recompilation in the frame loop. Rain and wind must affect both the atmosphere and water/VFX through the same environment state.

**Exit gate:** deterministic day-to-dusk-night transitions and weather transitions pass fixed-camera and camera-motion captures; all consumers report the same environment revision/state.

## GENESIS 2 — Advanced Water

Extend the existing water path rather than replacing it blindly:

- Stable depth/thickness prepass and Beer-Lambert absorption.
- Fresnel-weighted reflection and view-dependent reflection quality.
- Reflection of sky, clouds, sun/moon, terrain, torii, and supported scene objects.
- Refraction and shoreline/depth transitions with correct clipping and camera-side behavior.
- Multi-scale directional waves driven by the shared wind state.
- Rain impact ripples that are visible, temporally stable, and bounded in cost.
- Underwater color/visibility and coherent surface-to-underwater transitions.
- Explicit handling and diagnostics for transparent materials, multiple water surfaces, and unsupported reflection content.

**Exit gate:** all reference environment states pass the camera path without reflection popping, inverted clipping, depth leaks, severe temporal shimmer, or unexplained missing scene content. Reflection cadence/resolution changes are visible in diagnostics.

## GENESIS 3 — Lighting & GI

Integrate lighting as one coherent transport approximation:

- Clustered PBR direct lighting with consistent attenuation, material response, and shadow inputs.
- Stable sun/moon directional lighting synchronized with the atmosphere.
- CSM and contact-shadow consistency across camera motion and changing light direction.
- Static SH probe lighting and dynamic probe capture with bounded cadence, explicit validity, and temporal blending.
- Coherent IBL, water reflections, fog/cloud scattering, and exposure/color-management.
- Avoid double-counting direct light in indirect terms and prevent probe updates from producing visible flashes.

Do not label SH/raster probe methods as full path tracing or complete multi-bounce GI. Document their bounce count, capture method, spatial resolution, update cadence, and limitations.

**Exit gate:** fixed-material reference captures show stable lighting across time/weather transitions; moving-camera tests show no unacceptable shadow swimming, GI popping, or exposure discontinuity; probe resources are disposed and recreated safely.

## Integrated demonstration and final qualification

The torii-and-water-mirror fixture becomes one interactive demonstration, not a collection of disconnected feature showcases. It must support:

- Day, dusk, and night transitions.
- Clear, cloudy, rain, and wind conditions.
- A camera path that exposes reflection, refraction, shoreline, fog, and shadow behavior.
- Visible diagnostic controls for backend, quality preset, effective render scale, frame-time percentiles, GPU-timing source, and active environment state.
- A repeatable capture mode so regressions can be compared between commits.

### Reliability and compatibility qualification

- Run the existing WebGL2 editor/gameplay regression suite before and after every rendering phase.
- Test the same fixture on WebGL2 and supported physical WebGPU devices; compare output and behavior without requiring bit-identical pixels between different backends.
- Test backend initialization failure, forced device loss, renderer recreation, resize, scene changes, repeated mount/dispose cycles, and resource release.
- Perform at least a 60-minute foreground soak on each reference device. Track frame-time drift, resource growth, console errors, and recovery behavior.
- Confirm that no GPU resource, render target, event listener, animation loop, or material conversion remains owned after its scene/session is disposed.
- Do not promote WebGPU to the production default until all mandatory hardware and recovery gates pass.

## Change discipline

Work one subsystem at a time. Before implementation, read its current owner module, callers, tests, and resource lifecycle. Add or update focused regression tests with each change. Do not rewrite adjacent systems merely for stylistic consistency. Keep changes additive or reversible until parity is demonstrated. Update this document and `docs/ARCHITECTURE.md` whenever actual implementation boundaries or known limitations change.

A phase is complete only when its exit gate passes. A green Node.js test suite alone is not a hardware-rendering pass.


## Current Independent Graphics Engine progress-gate clarification (2026-11-28)

For the user's current Independent Graphics Engine roadmap, physical-device testing, named Android/GPU benchmarks and on-device visual captures are not progress or integration gates. Repository validation uses the CI workflow, Node/Python regression suites, module/syntax checks, source-level dependency audits and deterministic contract tests. Hardware-dependent observations remain explicitly unmeasured and must not be presented as passed. This clarification changes project progress scoring and delivery policy; it does not claim WebGL2/WebGPU visual parity or production readiness.
