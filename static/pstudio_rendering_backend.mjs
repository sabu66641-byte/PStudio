import { loadPStudioLegacyThreeWebGPU, isPStudioLegacyThreeWebGPURuntime } from "./pstudio_three_legacy_runtime.mjs";

function abortIfRequested(signal) {
  if (signal?.aborted) {
    const error = new Error("WebGPU initialization was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

/**
 * Reports browser WebGPU API availability. Supplying a runtime additionally
 * verifies the optional legacy Three.js renderer adapter implementation.
 */
export function isPStudioWebGPUAvailable(navigatorRef = globalThis.navigator, threeRuntime = null) {
  return Boolean(navigatorRef?.gpu && (!threeRuntime || isPStudioLegacyThreeWebGPURuntime(threeRuntime)));
}

export function isPStudioWebGPUBackend(renderer) {
  return renderer?.backend?.isWebGPUBackend === true;
}

/**
 * Creates the optional legacy Three.js WebGPU renderer adapter.
 * The package is imported lazily (or supplied by the caller) so importing
 * this module does not make Three.js a prerequisite for PStudio Graphics Core.
 */
export async function createPStudioWebGPUBackend(options = {}) {
  const navigatorRef = options.navigatorRef ?? globalThis.navigator;
  const canvas = options.canvas;
  const signal = options.signal;

  if (!canvas) throw new TypeError("A canvas is required to create the PStudio WebGPU backend.");
  if (!navigatorRef?.gpu) {
    const error = new Error("WebGPU is not available in this browser.");
    error.code = "PSTUDIO_WEBGPU_UNAVAILABLE";
    throw error;
  }

  abortIfRequested(signal);
  let renderer = null;
  try {
    const THREE = await loadPStudioLegacyThreeWebGPU(options);
    abortIfRequested(signal);
    renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: options.antialias === true,
      alpha: options.alpha === true,
      powerPreference: options.powerPreference === "low-power" ? "low-power" : "high-performance",
      preserveDrawingBuffer: false
    });

    await renderer.init();
    abortIfRequested(signal);

    if (!isPStudioWebGPUBackend(renderer)) {
      throw new Error("Three.js selected a non-WebGPU backend. The WebGL2 renderer remains a separate production path.");
    }

    let disposed = false;
    return Object.freeze({
      kind: "webgpu",
      renderer,
      dispose() {
        if (disposed) return false;
        disposed = true;
        try { renderer.setAnimationLoop(null); } catch (_) {}
        try { renderer.dispose(); } catch (_) {}
        return true;
      },
      get disposed() { return disposed; }
    });
  } catch (error) {
    try { renderer?.setAnimationLoop(null); } catch (_) {}
    try { renderer?.dispose(); } catch (_) {}
    throw error;
  }
}
