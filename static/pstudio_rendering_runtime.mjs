import { createPStudioWebGPUSceneSession } from './pstudio_rendering_migration.mjs';

/**
 * Coordinates the asynchronous renderer hand-off used by the production engine.
 *
 * This module deliberately does not create a WebGL renderer: the legacy engine
 * owns that renderer and its large set of WebGL-only effects until each feature
 * has a tested TSL replacement. Callers provide the existing renderer path as
 * a fallback adapter, avoiding a second canvas/context acquisition.
 */
export function createPStudioProductionRendererRuntime(options = {}) {
  const { canvas, scene, camera } = options;
  if (!canvas) throw new TypeError('A canvas is required.');
  if (!scene?.isScene || !camera?.isCamera) {
    throw new TypeError('A Three.js Scene and Camera are required.');
  }

  const createWebGPU = options.createWebGPU || createPStudioWebGPUSceneSession;
  const createFallback = options.createFallback;
  const allowFallback = options.allowFallback !== false;
  const controller = new AbortController();
  let state = 'idle';
  let active = null;
  let initialization = null;
  let disposed = false;
  let generation = 0;
  let lastError = null;

  function publish(nextState, details = {}) {
    state = nextState;
    try { options.onStateChange?.(Object.freeze({ state, ...details })); } catch (_) {}
  }

  function isCurrent(ticket) {
    return !disposed && ticket === generation && !controller.signal.aborted;
  }

  async function initialize() {
    if (disposed) throw new Error('Renderer runtime has been disposed.');
    if (active) return active;
    if (initialization) return initialization;

    const ticket = ++generation;
    initialization = (async () => {
      publish('initializing-webgpu');
      try {
        const webgpu = await createWebGPU({
          canvas,
          scene,
          camera,
          signal: controller.signal,
          navigatorRef: options.navigatorRef,
          antialias: options.antialias === true,
          alpha: options.alpha === true,
          powerPreference: options.powerPreference,
          environmentProfile: options.environmentProfile,
          environmentResolution: options.environmentResolution,
          pipelineOptions: options.pipelineOptions,
          configureRenderer: options.configureRenderer,
          onDeviceLost: (info) => {
            if (!isCurrent(ticket)) return;
            publish('device-lost', { backend: 'webgpu', deviceLoss: info });
            try { options.onDeviceLost?.(info); } catch (_) {}
          }
        });
        if (!isCurrent(ticket)) {
          webgpu?.dispose?.();
          throw new Error('Renderer initialization was superseded.');
        }
        active = Object.freeze({
          backend: 'webgpu',
          handle: webgpu,
          render: () => webgpu.render(),
          dispose: () => webgpu.dispose?.()
        });
        publish('ready', { backend: 'webgpu', capabilities: webgpu.capabilities || null });
        return active;
      } catch (error) {
        if (!isCurrent(ticket) || error?.name === 'AbortError') throw error;
        lastError = error;
        if (!allowFallback || typeof createFallback !== 'function') {
          publish('failed', { backend: null, error });
          throw error;
        }
        publish('initializing-fallback', { previousError: error });
        const fallback = await createFallback({
          canvas,
          scene,
          camera,
          signal: controller.signal,
          cause: error
        });
        if (!isCurrent(ticket)) {
          fallback?.dispose?.();
          throw new Error('Fallback initialization was superseded.');
        }
        if (!fallback || typeof fallback.render !== 'function') {
          throw new TypeError('Fallback adapter must provide render().');
        }
        active = Object.freeze({
          backend: fallback.backend || 'webgl2',
          handle: fallback,
          render: () => fallback.render(),
          dispose: () => fallback.dispose?.()
        });
        publish('ready', { backend: active.backend, fallback: true, previousError: error });
        return active;
      }
    })().finally(() => {
      initialization = null;
    });
    return initialization;
  }

  return Object.freeze({
    kind: 'pstudio-production-renderer-runtime',
    initialize,
    render() {
      if (disposed || !active || state !== 'ready') return false;
      return active.render() !== false;
    },
    getState() {
      return Object.freeze({
        state,
        backend: active?.backend || null,
        initialized: !!active,
        disposed,
        fallbackAllowed: allowFallback,
        lastError: lastError ? String(lastError.message || lastError) : null
      });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      generation += 1;
      controller.abort();
      try { active?.dispose?.(); } catch (_) {}
      active = null;
      publish('disposed');
      return true;
    }
  });
}
