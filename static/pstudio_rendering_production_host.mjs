import { createPStudioProductionRendererRuntime } from './pstudio_rendering_runtime.mjs?v=20261126-genesis-water-live-v1';
import { createPStudioRendererCanvasHost } from './pstudio_rendering_canvas_host.mjs';

/**
 * Composes renderer lifecycle selection with a dual-canvas host. Each backend
 * receives its own canvas, and only the successfully initialized surface is
 * made interactive/visible.
 */
export function createPStudioProductionRendererHost(options = {}) {
  const canvasHost = createPStudioRendererCanvasHost({
    primaryCanvas: options.primaryCanvas,
    fallbackCanvas: options.fallbackCanvas,
    initialBackend: options.initialBackend
  });
  let disposed = false;
  const userStateChange = options.onStateChange;

  const runtime = createPStudioProductionRendererRuntime({
    ...options,
    canvas: canvasHost.primaryCanvas,
    fallbackCanvas: canvasHost.fallbackCanvas,
    onStateChange(snapshot) {
      if (snapshot.state === 'ready') {
        canvasHost.activate(snapshot.backend === 'webgpu' ? 'webgpu' : 'webgl2');
      }
      try { userStateChange?.(snapshot); } catch (_) {}
    }
  });

  return Object.freeze({
    kind: 'pstudio-production-renderer-host',
    initialize: runtime.initialize,
    render: runtime.render,
    resize: runtime.resize,
    setEnvironment: runtime.setEnvironment,
    setWaterEnvironment: runtime.setWaterEnvironment,
    setBloom: runtime.setBloom,
    setAntiAliasing: runtime.setAntiAliasing,
    setAmbientOcclusion: runtime.setAmbientOcclusion,
    setSSR: runtime.setSSR,
    setGodRays: runtime.setGodRays,
    setContactShadows: runtime.setContactShadows,
    setVolumetricFog: runtime.setVolumetricFog,
    setVolumetricClouds: runtime.setVolumetricClouds,
    setClusteredLightingSnapshot: runtime.setClusteredLightingSnapshot,
    getRenderer: runtime.getRenderer,
    useFallback: runtime.useFallback,
    getState() {
      return Object.freeze({
        ...runtime.getState(),
        canvasHost: canvasHost.getState()
      });
    },
    getCanvas(backend) {
      return canvasHost.getCanvas(backend);
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      runtime.dispose();
      canvasHost.dispose();
      return true;
    }
  });
}
