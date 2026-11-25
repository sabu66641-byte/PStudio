import * as THREE from 'three/webgpu';

function abortIfRequested(signal) {
  if (signal?.aborted) {
    const error = new Error('WebGPU initialization was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

export function isPStudioWebGPUAvailable(navigatorRef = globalThis.navigator) {
  return Boolean(navigatorRef?.gpu && typeof THREE.WebGPURenderer === 'function');
}

export function isPStudioWebGPUBackend(renderer) {
  return renderer?.backend?.isWebGPUBackend === true;
}

/**
 * Creates an explicitly WebGPU-backed renderer.
 * Three.js WebGPURenderer can select its WebGL2 fallback, so a handle is only
 * returned after the backend identity has been verified.
 */
export async function createPStudioWebGPUBackend(options = {}) {
  const navigatorRef = options.navigatorRef ?? globalThis.navigator;
  const canvas = options.canvas;
  const signal = options.signal;

  if (!canvas) throw new TypeError('A canvas is required to create the PStudio WebGPU backend.');
  if (!isPStudioWebGPUAvailable(navigatorRef)) {
    const error = new Error('WebGPU is not available in this browser.');
    error.code = 'PSTUDIO_WEBGPU_UNAVAILABLE';
    throw error;
  }

  abortIfRequested(signal);
  let renderer = null;
  try {
    renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: options.antialias === true,
      alpha: options.alpha === true,
      powerPreference: options.powerPreference === 'low-power' ? 'low-power' : 'high-performance',
      preserveDrawingBuffer: false
    });

    await renderer.init();
    abortIfRequested(signal);

    if (!isPStudioWebGPUBackend(renderer)) {
      throw new Error('Three.js selected a non-WebGPU backend. The WebGL2 renderer remains a separate production path.');
    }

    let disposed = false;
    return Object.freeze({
      kind: 'webgpu',
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
