# GENESIS hardware validation matrix

**Last reviewed:** 2026-11-26  
**Hardware status:** not secured / not executed. This matrix records minimum candidate targets; it is not a device-test result.

## Why CI is not the hardware lab

The repository's Ubuntu GitHub Actions job verifies Python/C++17 tests, JavaScript regression contracts, and module syntax. It does not provide a named physical GPU/browser combination, visual screenshots, sustained frame pacing, or real adapter/device-loss behavior. A green CI run must not be reported as a WebGL2/WebGPU hardware pass.

## Required reference targets

| Tier | OS / hardware | Browser baseline | Purpose | Status |
|---|---|---|---|---|
| WebGL2 compatibility | One named Android handset and one named Windows/macOS computer with WebGL2 | Current stable Chrome/Edge; confirm WebGL2 context creation | Legacy renderer correctness and low-memory behavior | Not allocated |
| WebGPU primary | Windows 11 computer with a GPU/driver exposed through D3D12 | Chrome or Edge 113+; verify actual adapter availability | Production candidate validation | Not allocated |
| WebGPU mobile | Android 12+ with a supported Qualcomm or ARM GPU | Chrome 121+ | Mobile adapter, memory pressure, touch and thermal behavior | Not allocated |
| Optional WebGPU Mac | macOS computer with supported GPU | Chrome 113+ | Second desktop backend/driver comparison | Not allocated |

Chrome's published Android WebGPU rollout starts at Chrome 121 on Android 12+ devices with Qualcomm or ARM GPUs. Browser version alone is not sufficient: the browser/GPU driver may still block the adapter. Chrome's WebGPU troubleshooting guidance also requires a secure context and recommends checking the actual browser/GPU state.

## Preflight diagnostics

Run on the target device from the deployed HTTPS origin. Do not enable experimental flags or bypass a browser/GPU blocklist to turn an unsupported device into a supposed pass.

```js
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2');
let adapter = null;
let adapterError = null;

try {
  adapter = await navigator.gpu?.requestAdapter() ?? null;
} catch (error) {
  adapterError = String(error?.message || error);
}

console.table({
  secureContext: window.isSecureContext,
  webgl2Context: Boolean(gl),
  webgpuApi: Boolean(navigator.gpu),
  webgpuAdapter: Boolean(adapter),
  adapterError
});
```

Record the exact OS build, browser version, GPU name, driver version, adapter availability, canvas size, DPR, backend, and selected quality. The WebGL2 run and WebGPU run must be logged independently.

## Execution protocol

1. Confirm the WebGL2 context is present and the renderer runtime reports productionBackend = webgl2 with webgl2 = true.
2. Run the GENESIS fixture on WebGL2 through Day, Dusk, and Night. Capture the fixed viewpoint and the same 30-second run three times.
3. On a separately qualified WebGPU device, verify adapter acquisition, shader/module initialization, the fixture, and all reported feature blockers. Do not interpret a loaded WebGPU module as a production WebGPU renderer pass.
4. Exercise initialization failure, resize, repeated scene start/stop, resource disposal, and device-loss recovery. Confirm WebGL2 fallback after WebGPU failure.
5. Run a 60-minute foreground soak on every named reference device. Retain raw p50/p95/p99, sample counts, draw calls, triangles, texture/geometry counts, memory estimates, console errors, and screenshots.
6. Mark each backend/device pair as pass, fail, or not tested. Never infer one device's result from another.

## Current blocker

No physical reference device or remote hardware-backed browser session has been allocated to this task. A cloud VM or software-rendered headless browser is useful for automation but does not satisfy the physical-GPU acceptance gate unless its actual GPU acceleration and adapter are positively identified. A possible reproducible research path is Chrome's published Google Colab + Puppeteer workflow, which describes a real Chrome browser with hardware support; it still requires an available GPU runtime and a captured GPU identity.

## References

- [Chrome WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips/)
- [Chrome 121: WebGPU on Android](https://developer.chrome.com/blog/new-in-webgpu-121/)
- [web.dev: WebGPU browser availability](https://web.dev/blog/webgpu-supported-major-browsers)
- [Chrome: WebGPU testing in Google Colab](https://developer.chrome.com/docs/web-platform/webgpu/colab-headless/)
