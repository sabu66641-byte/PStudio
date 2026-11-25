import { createPStudioWebGPUSceneSession } from './pstudio_rendering_migration.mjs';

/**
 * Coordinates the asynchronous renderer hand-off used by the production engine.
 *
 * WebGPU and WebGL contexts cannot safely share one HTMLCanvasElement. The
 * optional fallback therefore requires a distinct canvas supplied by the host.
 * The legacy engine remains the owner of its WebGL-only effects until each
 * feature has a tested TSL replacement.
 */
export function createPStudioProductionRendererRuntime(options = {}) {
  const { canvas, scene, camera } = options;
  if (!canvas) throw new TypeError('A canvas is required.');
  if (!scene?.isScene || !camera?.isCamera) {
    throw new TypeError('A Three.js Scene and Camera are required.');
  }

  const createWebGPU = options.createWebGPU || createPStudioWebGPUSceneSession;
  const createFallback = options.createFallback;
  const fallbackCanvas = options.fallbackCanvas || null;
  const allowFallback = options.allowFallback !== false;
  if (allowFallback && typeof createFallback === 'function') {
    if (!fallbackCanvas) throw new TypeError('A separate fallbackCanvas is required; WebGPU and WebGL contexts must not share one canvas.');
    if (fallbackCanvas === canvas) throw new TypeError('The WebGPU canvas and WebGL fallback canvas must be different elements.');
  }
  const controller = new AbortController();
  let state = 'idle';
  let active = null;
  let initialization = null;
  let fallbackInitialization = null;
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

  async function activateFallback(cause, ticket = generation) {
    if (!allowFallback || typeof createFallback !== 'function') return false;
    if (!isCurrent(ticket)) return false;
    if (active?.backend === 'webgl2') return active;
    if (fallbackInitialization) return fallbackInitialization;

    fallbackInitialization = (async () => {
      let fallback = null;
      publish('initializing-fallback', { cause });
      try {
        fallback = await createFallback({
          canvas: fallbackCanvas,
          webgpuCanvas: canvas,
          scene,
          camera,
          signal: controller.signal,
          cause
        });
        if (!isCurrent(ticket)) {
          fallback?.dispose?.();
          throw new Error('Fallback initialization was superseded.');
        }
        if (!fallback || typeof fallback.render !== 'function') {
          fallback?.dispose?.();
          throw new TypeError('Fallback adapter must provide render().');
        }
        const previous = active;
        active = Object.freeze({
          backend: fallback.backend || 'webgl2',
          handle: fallback,
          render: () => fallback.render(),
          dispose: () => fallback.dispose?.()
        });
        try { previous?.dispose?.(); } catch (_) {}
        publish('ready', { backend: active.backend, fallback: true, cause });
        return active;
      } catch (error) {
        lastError = error;
        if (isCurrent(ticket)) publish('failed', { backend: null, error, cause });
        throw error;
      }
    })().finally(() => {
      fallbackInitialization = null;
    });
    return fallbackInitialization;
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
            const cause = new Error(String(info?.message || 'The WebGPU device was lost.'));
            cause.code = 'PSTUDIO_WEBGPU_DEVICE_LOST';
            cause.details = info || null;
            activateFallback(cause, ticket).catch(() => {});
          }
        });
        if (!isCurrent(ticket)) {
          webgpu?.dispose?.();
          throw new Error('Renderer initialization was superseded.');
        }
        if (fallbackInitialization) {
          await fallbackInitialization;
          webgpu?.dispose?.();
          if (active) return active;
        }
        if (active?.backend === 'webgl2') {
          webgpu?.dispose?.();
          return active;
        }
        if (!webgpu || typeof webgpu.render !== 'function') {
          webgpu?.dispose?.();
          throw new TypeError('WebGPU scene session must provide render().');
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
        if (state === 'failed' && lastError) throw lastError;
        lastError = error;
        if (!allowFallback || typeof createFallback !== 'function') {
          publish('failed', { backend: null, error });
          throw error;
        }
        try {
          const fallback = await activateFallback(error, ticket);
          if (fallback) return fallback;
          publish('failed', { backend: null, error });
          throw error;
        } catch (fallbackError) {
          if (isCurrent(ticket) && state !== 'failed') publish('failed', { backend: null, error: fallbackError, previousError: error });
          throw fallbackError;
        }
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
