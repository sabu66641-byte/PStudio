import {
  createPStudioGraphicsFrame,
  PStudioGraphicsError
} from './pstudio_graphics_contract.mjs';

/**
 * Vendor-neutral engine facade over a PStudio Graphics HAL instance.
 * Scene, view and environment values are opaque to this layer.
 */
export function createPStudioGraphicsEngine(options = {}) {
  const hal = options.hal;
  if (!hal || typeof hal.initialize !== 'function' || typeof hal.render !== 'function' ||
      typeof hal.resize !== 'function' || typeof hal.dispose !== 'function' ||
      typeof hal.getState !== 'function') {
    throw new TypeError('A compatible PStudio Graphics HAL instance is required.');
  }

  let state = 'idle';
  let disposed = false;
  let initialization = null;
  let lastError = null;

  function snapshot(extra = {}) {
    return Object.freeze({
      state,
      backend: hal.getState().backend || null,
      lastError: lastError ? String(lastError.message || lastError) : null,
      hal: hal.getState(),
      ...extra
    });
  }

  function publish(nextState, extra = {}) {
    state = nextState;
    try { options.onStateChange?.(snapshot(extra)); } catch (_) {}
  }

  async function initialize(context = {}) {
    if (disposed) throw new PStudioGraphicsError('Graphics engine is disposed.', { code: 'PSTUDIO_GRAPHICS_DISPOSED' });
    if (['ready', 'fallback'].includes(state)) return snapshot();
    if (initialization) return initialization;
    publish('initializing');
    initialization = (async () => {
      try {
        const result = await hal.initialize(context);
        const next = result?.state === 'fallback' ? 'fallback' : 'ready';
        publish(next, { selectedBackend: result?.backend || null });
        return snapshot();
      } catch (error) {
        if (disposed) throw error;
        lastError = error;
        publish('failed');
        throw error;
      }
    })().finally(() => { initialization = null; });
    return initialization;
  }

  function render(input) {
    if (disposed || !['ready', 'fallback'].includes(state)) return false;
    const frame = createPStudioGraphicsFrame(input);
    return hal.render(frame);
  }

  function resize(width, height, pixelRatio = 1) {
    if (disposed || !['ready', 'fallback'].includes(state)) return false;
    return hal.resize(width, height, pixelRatio);
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    try { hal.dispose(); } finally { publish('disposed'); }
    return true;
  }

  return Object.freeze({
    kind: 'pstudio-independent-graphics-engine',
    apiVersion: '0.1.0',
    initialize,
    render,
    resize,
    getState: () => snapshot(),
    dispose
  });
}
