# PStudio Independent Graphics Engine — Architecture Foundation

**Status (2026-11-28):** Phase 2 is approximately 50% complete. Vendor-neutral contracts, backend adapter validation, a feature-aware Hardware Abstraction Layer (HAL), a generic engine facade, lifecycle/fallback handling and regression tests are implemented. The existing production renderer has not yet been migrated behind these interfaces.

## 1. Architectural objective

PStudio must own its engine-facing graphics contracts and subsystem boundaries. Three.js may remain an implementation dependency during migration, but it must not define PStudio's public graphics architecture.

The target dependency direction is:

```text
PStudio Engine Layer
  Scene / Entity / Material / Camera / Asset
                 |
                 v
PStudio Graphics Core
  Renderer / Compute / Memory / Shader / Lighting / Resource
                 |
                 v
PStudio Render Graph
                 |
                 v
Hardware Abstraction Layer (HAL)
                 |
       +---------+---------+
       |                   |
    WebGPU              Native APIs
       |             Vulkan / D3D12 / Metal
       v
Browser / OS / Driver / GPU
```

WebGL2 remains a supported compatibility path while existing features are migrated. The current production WebGPU backend is still implemented through Three.js r187 WebGPURenderer/TSL. The architecture work here establishes an independent PStudio contract; it does not claim the backend implementation is already independent.

## 2. Dependency rules

1. Engine-facing contracts must not import Three.js, browser DOM types, WebGL or WebGPU implementation classes.
2. Backend-specific code is registered as an adapter and owns its API objects, canvas/context rules, command submission and disposal.
3. The HAL selects adapters from explicit backend identifiers, declared capabilities and requested features.
4. Fallback is observable. The selected backend and failed attempts remain available in state diagnostics; disabling fallback must never silently select another backend.
5. Scene, view, environment and quality payloads are opaque at the HAL boundary until their PStudio-owned schemas are defined in later core phases.
6. The HAL owns lifecycle and stale-initialization cleanup, not GPU resource allocation or render-pass scheduling.
7. The production Three.js runtime remains the compatibility implementation until a separately tested adapter is introduced.

## 3. Implemented architecture foundation

| Module | Responsibility | Dependency |
|---|---|---|
| `static/pstudio_graphics_contract.mjs` | Backend IDs, immutable descriptors, frame contract, errors and lifecycle transitions | Standard JavaScript only |
| `static/pstudio_graphics_hal.mjs` | Adapter registry, feature filtering, backend ordering, explicit fallback, cancellation and disposal | Contract module |
| `static/pstudio_graphics_engine.mjs` | Vendor-neutral engine facade for initialization, frame dispatch, resize and disposal | Contract + injected HAL |
| `tests/graphics_architecture.test.js` | Contract, fallback, feature-gating, rollback, lifecycle and dependency-boundary regression tests | Node.js test runner |

No production rendering defaults, shaders, water/sky materials, canvas ownership or current backend selection are changed by these modules.

## 4. Backend adapter contract

An adapter registers a descriptor and an asynchronous initializer:

```js
{
  descriptor: {
    id: 'backend.webgpu',
    backend: 'webgpu',
    priority: 100,
    features: ['pbr', 'compute'],
    limits: {}
  },
  supports(context) {
    return true;
  },
  async initialize(context) {
    return {
      render(frame) { /* submit one PStudio frame */ },
      resize(width, height, pixelRatio) { return true; },
      dispose() {}
    };
  }
}
```

The adapter's `initialize(context)` receives the selected backend, requested feature set, caller context and an abort signal. It returns a handle with `render(frame)`; `resize` and `dispose` are optional. Backend API objects remain inside the adapter handle.

## 5. HAL behavior

- Backend candidates are ordered by requested preference/order, then adapter priority.
- Adapters missing a required declared feature are skipped before initialization.
- An optional synchronous `supports(context)` predicate can reject an adapter without creating backend resources.
- Initialization failures are retained in the attempt history.
- Fallback can be disabled. When enabled, the final state is `fallback`, not `ready`, and the selected backend is explicit.
- Disposal aborts in-flight initialization, invalidates its generation, disposes active resources, and rejects late completion rather than adopting it.
- Render and resize operations are rejected while uninitialized, failed or disposed.

The feature descriptors are declared capabilities, not a claim that a feature has passed rendering parity. A later adapter must only advertise features that it can actually execute.

## 6. Remaining work to complete Phase 2

1. Define PStudio-owned Scene/View/Material/Resource and command-buffer contracts.
2. Map current WebGL2 and Three.js WebGPU execution paths to explicit adapters without changing the visible production path.
3. Define ownership of device/context loss, synchronization, resource handles and capability negotiation.
4. Add a migration matrix from existing `PStudio3D` and Three.js APIs to PStudio contracts.
5. Validate that fallback and rollback preserve the existing editor/gameplay API.

## 7. Rollback

The implementation is additive. Existing production rendering files and defaults are unchanged. The pre-change repository state is preserved by branch `backup/pre-independent-graphics-20261128`, rooted at commit `5f6ab6db674268a87b857103456837dfc77c57d9`.

The new architecture can be disabled simply by leaving the new modules unreferenced. If a later integration regresses production, revert the corresponding merge commit or restore the backup branch; do not reset shared `main` history.
