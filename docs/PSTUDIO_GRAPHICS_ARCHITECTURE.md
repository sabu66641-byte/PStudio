# PStudio Independent Graphics Engine — Architecture Foundation

**Status (2026-11-28):** Phases 2–10 = 100% at their defined repository/API contract and deterministic-test scope. Phase 5 includes native SDL3 graphics backends for Vulkan/D3D12/Metal with Linux/Windows/macOS compile CI; Phase 9 and 10 are opt-in world and advanced-graphics subsystem/executor APIs. The production UI still uses the existing PStudio3D / Three.js renderer. The independent WebGPU backend and native runtime are opt-in; neither is silently wired into the live production path.

## 1. Target dependency direction

PStudio Engine Layer (Scene / Entity / Material / Camera / Asset)
→ PStudio Graphics Core (Renderer / Resource / Shader / Compute / Lighting)
→ PStudio Render Graph
→ PStudio HAL
→ Browser WebGPU / WebGL2 adapters
→ Browser / OS / Driver / GPU

Native Vulkan / Direct3D 12 / Metal requires a separate native runtime and concrete platform adapters. Browser WebGPU support does not imply native API support.

PStudio-owned contracts, HAL and core modules must not depend on Three.js, DOM types, WebGL classes or WebGPU implementation objects. Backend-specific adapters may depend on concrete APIs.

## 2. Phase 2 — Graphics Architecture (100%)

### 2.1 Vendor-neutral contracts

- Backend descriptors, declared capabilities, immutable frame packets and lifecycle states.
- PStudio-owned Scene, View, Material and Resource descriptors.
- Typed graphics command vocabulary and a single-use command encoder/buffer.
- Async synchronization/fence handle contract.
- Opaque scene and backend objects at the abstraction boundary; concrete backend objects remain inside adapters.

### 2.2 HAL and lifecycle ownership

- Adapter registry, backend preference/order, feature filtering and explicit fallback.
- Device/context-loss state via a standardized deviceLost promise or adapter callback.
- Lost backends stop accepting frame submissions.
- Recovery is explicit and selects a different registered adapter; it never silently reuses a lost device.
- Queue synchronization delegates to adapter waitIdle(). Unsupported synchronization returns false; it is never faked with a CPU delay.
- Initialization cancellation, stale-completion rejection and late-resource disposal.

### 2.3 Current backend adapter mapping

| Adapter | Existing implementation | Ownership boundary |
|---|---|---|
| PStudio WebGL2 adapter | Wraps an existing PStudio3D-owned WebGLRenderer | Does not create, mutate or dispose the renderer unless ownership is explicitly transferred |
| Three.js WebGPU adapter | Wraps createPStudioWebGPUSceneSession, WebGPURenderer and the TSL pipeline | Scene session owns material conversion, pipeline and GPU resources; adapter forwards render, resize, capabilities, loss and queue-idle |
| PStudio direct WebGPU Core adapter | Uses browser WebGPU directly; no Three.js scene session or renderer wrapper | Separate opt-in backend; owns only resources explicitly created through it |
| Existing-renderer HAL factory | Registers supplied adapters and preserves WebGL2 as the default preference | Opt-in only; it does not replace the visible production bridge |

A declared feature list is a selection contract, not proof of visual or hardware parity. The direct WebGPU path can be attached independently to the PStudio Graphics Core; it is not registered into the visible production renderer by this work.

### 2.4 Compatibility and rollback

- Existing editor/gameplay APIs and production render branch are unchanged.
- WebGPU and WebGL2 require separate canvases when both are initialized.
- The legacy renderer remains owned by PStudio3D. An adapter does not destroy it unless ownsRenderer is explicitly true.
- Device loss is observable. Recovery is explicit and uses another adapter/runtime instance.
- Migration/ownership mapping is documented in this file and the Roadmap.
- Full repository CI is the integration gate; physical-device testing is not a progress gate under the current project policy.

## 3. Phase 3 — Graphics Core (100%)

### 3.1 Core ownership modules

| Module | Responsibility | Boundary |
|---|---|---|
| pstudio_graphics_renderer_core.mjs | Monotonic frame submission, viewport and command-buffer validation, HAL dispatch | Does not take ownership of the visible production loop |
| pstudio_graphics_resource_core.mjs | Typed records, independent CPU/GPU budgets, leases, concurrent factory deduplication, LRU eviction, deterministic disposal, GPU resource create/destroy and rehydration | Does not claim driver-reported VRAM or intercept Three.js allocations |
| pstudio_graphics_shader_core.mjs | Backend-neutral shader registry, variant keys, compile deduplication, invalidation, recompilation and disposal | Compiler remains backend-owned; source registry survives device recovery |
| pstudio_graphics_compute_core.mjs | Kernel definitions, workgroup/dispatch validation, capability gating and executor delegation | Dispatch is submitted by an injected GPU backend; graph dependency scheduling belongs to Phase 4 |
| pstudio_graphics_lighting_core.mjs | Directional/point/spot normalization, stable typed-array packing and stable light-id → packed-index map | GPU upload is an explicit operation; it does not replace PStudioResources |
| pstudio_graphics_clustered_lighting_core.mjs | Sparse cluster assignment, validated unsigned indices, deterministic offset/index packing and GPU upload contract | Visibility/culling policy remains caller-supplied; no silent light truncation |
| pstudio_graphics_pbr_wgsl.mjs | GGX / Smith / Schlick direct-light BRDF include, layer-mask filtering and clustered-index consumption | Direct-light include only; it does not replace IBL, shadows, tone mapping, sky or water materials |
| pstudio_graphics_webgpu_backend.mjs | Direct WebGPU resource lifecycle, WGSL compile, render/compute pipelines, dispatch, light/cluster uploads, command recording, surface access and queue submission | Dedicated opt-in browser backend; does not import Three.js and does not take over the current production renderer |
| pstudio_graphics_core.mjs | Composition root, GPU runtime attachment, pipeline recipe retention and explicit recovery orchestration | No automatic backend switch or quality downgrade |

### 3.2 GPU path now implemented

- Backend-owned GPU buffers, textures, render targets and samplers can be created, written, recreated and destroyed through opaque resource handles.
- WGSL compilation uses WebGPU shader modules and checks available compilation diagnostics; unsupported shader languages fail closed.
- Compute pipelines dispatch through WebGPU command encoders and `dispatchWorkgroups`, with workgroup and capability validation in Compute Core.
- Lighting records and 32-bit layer masks upload to storage buffers. Cluster offsets and light indices upload to separate storage buffers.
- Light packing exposes the exact packed index for each light id, preventing cluster lists from accidentally referring to a different order after priority sorting.
- A PStudio WGSL include provides direct-light GGX/Smith/Schlick evaluation and consumes the same packed-light and cluster-buffer ABI.
- Core recovery explicitly reattaches a replacement runtime, recompiles previously requested shaders, recreates registered render/compute pipelines, restores GPU resource handles and reuploads lighting snapshots. Recovery failure is returned as an error rather than hidden fallback.
- An independent vertical slice connects Renderer Core → HAL-compatible backend → WebGPU surface → Render Graph plan → render pass → one queue submission.

### 3.3 Completion boundary

Phase 3 is 100% for the defined PStudio-owned Core API and the direct WebGPU backend vertical slice. It does **not** certify full feature parity with Three.js, correct visual matching for every existing scene, production renderer replacement, device-specific performance or all advanced effects. PBR shader code is an opt-in building block; the existing sky, water, IBL, shadows and quality path remain separate and unchanged.

## 4. Phase 4 — Render Graph (100%)

`static/pstudio_render_graph.mjs` owns:

- Declarative pass and resource descriptors, explicit pass dependencies and stable topological scheduling.
- Automatic RAW / WAR / WAW hazard edges and feedback-loop, unknown-resource, read-before-write and cycle rejection.
- Per-resource first/last-use lifetimes and compatibility-gated transient aliasing. Aliasing requires non-overlapping lifetimes and matching type, format, dimensions, sample count and usage.
- Explicit resource-transition, write-after-write, write-to-read and read-to-write barrier records. Read-only state changes are represented as transitions too.
- Materialization of physical backend resources, imported/external handle borrowing, idempotent release and reverse-order rollback on partial allocation failure.
- Async generic pass execution with cancellation, pass/graph begin/end/abort hooks and single-execution protection.
- Direct WebGPU command recording and a single queue submission for synchronous GPU pass callbacks. WebGPU resource transitions remain API-managed; the Render Graph records hazards without inventing unsupported global barrier commands.

Phase 4 is complete as a dependency/lifetime/materialization/execution API with deterministic tests. It does not mean every current PStudio3D/Three.js render pass has been migrated into the graph. The live production pipeline remains unchanged.

## 5. Phase 5 — Native Renderer (100%)

The optional native implementation consists of:

- \`native/include/pstudio/native_gpu.hpp\`: native GPU resource, shader, graphics-pipeline, frame and fence contracts with explicit capability reporting.
- \`native/include/pstudio/native_gpu_runtime.hpp\`: logical GPU-resource ownership, upload shadows, recovery recipes and transactional replacement-backend restoration.
- \`native/include/pstudio/sdl_gpu_backend.hpp\` and \`native/src/sdl_gpu_backend.cpp\`: SDL3 GPU adapter with strict Vulkan, Direct3D 12 and Metal driver selection; native buffer/texture creation and staged upload; SPIR-V/DXIL/MSL vertex/fragment shaders; graphics pipelines; render-pass/frame submission; fence/wait-idle; surface/swapchain resize; headless target; device-loss reporting and cleanup.
- \`NativeBackendRegistry\` integration exposes Vulkan/D3D12/Metal choices while rejecting unsupported capability requests and unexpected driver substitution.
- C++17 mock-backend tests validate resource ownership, frame/runtime lifecycle and transactional recovery.
- Optional CMake target compiles the adapter on Ubuntu/Linux, Windows and macOS CI without creating a GPU device or physical window.

Phase 5 is 100% for the specified **native graphics renderer** contract. SDL3 provides the actual OS GPU-driver implementation behind its GPU API, while PStudio owns the adapter and runtime. The current adapter intentionally reports compute shaders unavailable and rejects compute shader creation; native compute is not included in this phase's graphics-renderer acceptance scope. Physical-device rendering, raw per-vendor SDK implementations, image parity and performance are not claimed.

## 6. Phase 6 — Rendering Quality (100%)

`static/pstudio_graphics_rendering_quality.mjs` adds a PStudio-owned WGSL function library:

- GGX distribution, Schlick Fresnel and Smith/Schlick geometry for direct PBR.
- Separate diffuse and prefiltered-specular indirect-light composition inputs for SH/IBL/probe data.
- 3×3 PCF shadow filtering and deterministic four-cascade selection.
- ACES filmic tone mapping and linear-to-sRGB conversion.
- CPU reference BRDF/tone-map evaluators and validated packed material data.

`static/pstudio_graphics_rendering_systems.mjs` composes the libraries with caller-supplied WGSL entry points, compiles through Shader Core, creates a recoverable render pipeline and maintains persistent Resource Core uniform buffers. The path is opt-in; production quality defaults are unchanged.

## 7. Phase 7 — Atmosphere & Sky (100%)

`static/pstudio_graphics_atmosphere.mjs` consumes the normalized GENESIS environment state and supplies:

- Rayleigh molecular and Henyey–Greenstein Mie phase functions.
- Bounded 16-step atmospheric scattering and transmittance integration.
- 3D procedural cloud density, coverage and wind/time drift.
- Sun/moon disk contribution helpers.
- Height-dependent aerial perspective/fog composition.
- Normalized state and GPU uniform packing for time, celestial directions, clouds, fog, wind and weather.

The existing authored day/dusk/night panorama and PMREM/IBL source are not replaced or modified.

## 8. Phase 8 — Advanced Water (100%)

`static/pstudio_graphics_water.mjs` supplies:

- Three-scale directional wave displacement and analytic normal approximation.
- Wind and time-driven wave motion plus rain-ripple contribution.
- View-dependent Fresnel reflection.
- RGB Beer–Lambert transmission with depth-dependent scattering color.
- Reflection/refraction/foam composition.
- Render Graph passes ordered as planar reflection → depth prepass → depth-aware refraction → final water composite.

Pass callbacks and imported scene/surface handles are supplied by the caller. Existing production planar reflection and water shaders remain untouched.

## 9. Phase 9 — World Rendering (100%)

\`static/pstudio_graphics_world_core.mjs\` is a PStudio-owned, opt-in world subsystem:

- Heightfield terrain samples, normals and bounded terrain chunk descriptors.
- Projected-error LOD with hysteresis, AABB/frustum visibility and deterministic LOD selection.
- Bounded streaming request ranking, concurrency/byte budget and stale-load protection.
- Seeded foliage scattering with slope/height constraints.
- Packed world material layers and explicit GPU-handle ownership.
- World-rendering system for chunk registration/update/removal, view updates, stream ticks, invisible eviction, foliage preparation and executor-backed frame packets.

Terrain/asset loaders and the concrete render executor are caller-supplied. The new system does not mutate or replace production PStudio3D world content.

## 10. Phase 10 — Advanced Graphics (100%)

\`static/pstudio_graphics_advanced_core.mjs\` provides the independent advanced subsystem:

- Bounded GPU VFX compute command generation via injected executor and corresponding WGSL.
- SH probe GI storage, temporal blending and dirty-probe scheduling.
- Logarithmic clustered-light assignment with explicit overflow protection.
- Froxel volume layout under a strict memory budget.
- Beer–Lambert and Henyey–Greenstein reference functions, front-to-back volumetric integration and temporal-history blending.
- Volumetric WGSL and executor dispatch contract for lighting injection, integration and history.
- In-flight/frame sequencing, parameter bounds and disposal.

A real GPU executor is supplied by the consuming backend. The SDL3 native adapter in Phase 5 does not advertise Compute support. Phase 10 is complete for the specified advanced subsystem algorithms, bounded API contracts and executor integration; it does not claim native Compute, ray tracing, full scene integration or measured visual/performance parity.

## 11. Invariants that remain protected

1. Nov 24 authored sky/panorama and PMREM/IBL source are untouched.
2. Signature planar water reflection, water depth and absorption shaders are untouched.
3. Existing PStudio3D visible WebGL2 renderer remains production owner and default.
4. No quality defaults, effect enablement, resolution policy or existing sky/water shaders are changed.
5. New Graphics Core, Render Graph and direct WebGPU backend are opt-in. They do not mirror or double-register resources owned by PStudioResources or Three.js.
6. Missing GPU metrics/capabilities are unavailable, never inferred from CPU time or feature declarations.
7. Reality 55 : Anime 45 remains the image-level target; no automatic visual compromise is introduced.

## 12. Validation boundary

Repository validation includes deterministic Node tests for world terrain/chunk/LOD/streaming/foliage/material behavior and advanced VFX/GI/cluster/froxel/volumetric algorithms and executor packets, alongside Render Graph, direct WebGPU, PBR and Core recovery tests. Python invokes a C++17 compiler for native runtime/registry/recovery mock tests. SDL3 native adapter compilation is checked on Linux, Windows and macOS CI; those jobs do not initialize GPU devices or OS windows. Full CI also runs existing Python, Three.js runtime, TSL and JavaScript regression tests.

The WebGPU and Advanced Graphics tests use mock devices/executors and deterministic references; they validate API wiring, resource ownership, command packets and numeric invariants, not real hardware shader validation, rendered image quality or frame-time performance. Native C++ runtime tests use mock backends; SDL3 adapters are compile-checked per OS but no physical GPU/device or real OS window is created. No browser/device screenshot, real-driver execution or physical-device performance result is claimed here.
