# PStudio Independent Graphics Engine — Architecture Foundation

**Status (2026-11-28):** Phase 2 = 100%; Phase 3 = 50% at repository architecture/core-contract level. The production UI still uses the existing PStudio3D / Three.js renderer. New adapters and core modules are opt-in and do not claim Three.js removal or WebGPU hardware parity.

## 1. Target dependency direction

PStudio Engine Layer (Scene / Entity / Material / Camera / Asset)
→ PStudio Graphics Core (Renderer / Resource / Shader / Compute / Lighting)
→ PStudio Render Graph (Phase 4)
→ PStudio HAL
→ WebGPU / WebGL2 adapters
→ Browser / OS / Driver / GPU

Native Vulkan / Direct3D 12 / Metal requires a separate native runtime and is not implied by browser backend support.

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
| Existing-renderer HAL factory | Registers supplied adapters and preserves WebGL2 as the default preference | Opt-in only; it does not replace the visible production bridge |

The WebGPU adapter declares a conservative baseline feature set. Additional features must be explicitly passed by the caller. A declared feature list is a selection contract, not proof of visual or hardware parity.

### 2.4 Compatibility and rollback

- Existing editor/gameplay APIs and production render branch are unchanged.
- WebGPU and WebGL2 require separate canvases when both are initialized.
- The legacy renderer remains owned by PStudio3D. An adapter does not destroy it unless ownsRenderer is explicitly true.
- Device loss is observable. Recovery is explicit and uses another adapter.
- Migration/ownership mapping is documented in this file and the Roadmap.
- Full repository CI is the integration gate; physical-device testing is not a progress gate under the current project policy.

## 3. Phase 3 — Graphics Core (50%)

### Implemented PStudio-owned core modules

| Module | Responsibility | Boundary |
|---|---|---|
| pstudio_graphics_renderer_core.mjs | Monotonic frame submission, viewport and command-buffer validation, HAL dispatch | Does not schedule render passes or build dependency graphs |
| pstudio_graphics_resource_core.mjs | Typed records, independent CPU/GPU budgets, leases, concurrent factory deduplication, LRU eviction, deterministic disposal | Does not claim driver-reported VRAM or intercept Three.js allocations |
| pstudio_graphics_shader_core.mjs | Backend-neutral shader registry, variants, compile deduplication, invalidation and disposal through injected compiler | Does not compile a language itself; compiler belongs to a backend |
| pstudio_graphics_compute_core.mjs | Kernel definitions, workgroup/dispatch validation, feature gating and executor delegation | Does not schedule Render Graph dependencies |
| pstudio_graphics_lighting_core.mjs | Directional/point/spot normalization, stable snapshots and compact typed-array packing | Does not upload GPU buffers or replace clustered lighting yet |
| pstudio_graphics_core.mjs | Composition root that wires Renderer, Resource, Shader, Compute and Lighting owners | Does not alter production defaults |

### Remaining Phase 3 work

- Backend resource create/destroy paths with opaque native/GPU handles.
- Concrete WebGPU shader compiler and compiler extension points.
- Real GPU compute dispatch implementation and resource barriers.
- GPU lighting-buffer upload, clustered-light integration and PBR consumption.
- Minimal end-to-end independent GPU renderer vertical slice.
- Resource/pipeline recreation following device loss and backend recovery.

Phase 3 at 50% is a PStudio-owned, testable CPU-side ownership and backend-injection foundation. It is not yet a GPU-executing independent renderer.

## 4. Migration and ownership matrix

| Current implementation | Current owner | PStudio target owner | Migration status |
|---|---|---|---|
| PStudio3D scene/camera/render loop | static/pstudio_3d_engine.js | Graphics Renderer Core | Contract and wrapper exist; production loop not migrated |
| THREE.WebGLRenderer | PStudio3D | WebGL2 adapter | Wrap-existing-instance adapter implemented |
| WebGPURenderer / TSL scene session | rendering migration module | WebGPU adapter | Adapter implemented; Three.js remains an implementation dependency |
| PStudioResources registry | static/pstudio_resources.js | Graphics Resource Core | Parallel opt-in core; no dual registration in live renderer |
| TSL material/pipeline assembly | Three.js TSL modules | Shader Core + backend compiler | Shader registry exists; actual compiler remains backend-owned |
| Clustered lights / SH | legacy and TSL rendering modules | Lighting Core | CPU schema/packing exists; GPU upload/integration pending |
| GPU compute nodes | existing Three.js/TSL and effects | Compute Core | Kernel/executor contract exists; concrete GPU implementation pending |
| Render-pass dependencies | current pipeline/composer | Render Graph (Phase 4) | Explicitly not folded into Phase 3 |

## 5. Invariants that remain protected

1. Nov 24 authored sky/panorama and PMREM/IBL source are untouched.
2. Signature planar water reflection, water depth and absorption shaders are untouched.
3. Existing PStudio3D visible WebGL2 renderer remains production owner and default.
4. No quality defaults, effect enablement, resolution policy or shaders are changed.
5. New Graphics Core is opt-in. It does not mirror or double-register resources owned by PStudioResources or Three.js.
6. Missing GPU metrics/capabilities are unavailable, never inferred from CPU time or feature declarations.
7. Reality 55 : Anime 45 remains the image-level target; no automatic visual compromise is introduced.

## 6. Validation boundary

Repository validation includes deterministic Node tests, Python/C++17 regression tests, pinned Three.js package smoke checks and TSL/engine syntax checks. This satisfies the current development-progress rule; it does not certify device-specific frame time, visual parity, WebGPU availability or deployment.
