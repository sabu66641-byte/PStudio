import {
  PStudioGraphicsError,
  assertPStudioGraphicsStateTransition,
  validatePStudioGraphicsBackendAdapter
} from './pstudio_graphics_contract.mjs';

/**
 * Backend-neutral Hardware Abstraction Layer.
 *
 * Adapters own native API objects and canvas/context rules. The HAL owns
 * deterministic selection, feature gating, lifecycle, fallback reporting and
 * stale-initialization disposal. No backend is silently represented as another.
 */
export function createPStudioGraphicsHAL(options = {}) {
  const adapters = new Map();
  let state = 'idle';
  let active = null;
  let initialization = null;
  let generation = 0;
  let disposed = false;
  let lastError = null;
  let attempts = [];
  let controller = new AbortController();

  function snapshot(extra = {}) {
    return Object.freeze({
      state,
      backend: active?.descriptor.backend || null,
      adapterId: active?.descriptor.id || null,
      lastError: lastError ? String(lastError.message || lastError) : null,
      attempts: Object.freeze(attempts.map(item => Object.freeze({ ...item }))),
      ...extra
    });
  }

  function publish(nextState, extra = {}) {
    assertPStudioGraphicsStateTransition(state, nextState);
    state = nextState;
    try { options.onStateChange?.(snapshot(extra)); } catch (_) {}
  }

  function assertMutable() {
    if (disposed || state === 'disposed') throw new PStudioGraphicsError('Graphics HAL is disposed.', { code: 'PSTUDIO_GRAPHICS_DISPOSED' });
    if (state === 'initializing' || active) throw new PStudioGraphicsError('Backend registry cannot change while the HAL is active.', { code: 'PSTUDIO_GRAPHICS_REGISTRY_LOCKED' });
  }

  function register(adapter) {
    assertMutable();
    const validated = validatePStudioGraphicsBackendAdapter(adapter);
    if (adapters.has(validated.descriptor.id)) {
      throw new PStudioGraphicsError('Graphics backend adapter already registered: ' + validated.descriptor.id, {
        code: 'PSTUDIO_GRAPHICS_DUPLICATE_ADAPTER'
      });
    }
    adapters.set(validated.descriptor.id, validated);
    return validated.descriptor;
  }

  function unregister(id) {
    assertMutable();
    return adapters.delete(String(id || '').trim().toLowerCase());
  }

  function listBackends() {
    return Object.freeze([...adapters.values()]
      .map(item => item.descriptor)
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)));
  }

  function orderedCandidates(context) {
    const registered = [...adapters.values()];
    const preferred = context.preferredBackend || options.preferredBackend || null;
    const order = Array.isArray(context.backendOrder)
      ? context.backendOrder
      : Array.isArray(options.backendOrder) ? options.backendOrder : [];
    const ranking = [...new Set([preferred, ...order].filter(Boolean).map(value => String(value).toLowerCase()))];
    const rank = item => {
      const index = ranking.indexOf(item.descriptor.backend);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return registered.sort((a, b) => rank(a) - rank(b) || b.descriptor.priority - a.descriptor.priority || a.descriptor.id.localeCompare(b.descriptor.id));
  }

  function normalizeRequiredFeatures(context) {
    const value = context.requiredFeatures ?? options.requiredFeatures ?? [];
    if (!Array.isArray(value)) throw new TypeError('requiredFeatures must be an array of feature names.');
    return [...new Set(value.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  }

  function isCurrent(ticket) {
    return !disposed && ticket === generation && !controller.signal.aborted;
  }

  function cancelledError(ticket, cause) {
    const error = cause instanceof Error ? cause : new PStudioGraphicsError('Graphics initialization was cancelled.', { code: 'PSTUDIO_GRAPHICS_INITIALIZATION_CANCELLED' });
    if (!disposed && ticket === generation && state === 'initializing') {
      lastError = error;
      publish('failed');
    }
    return error;
  }

  async function initialize(context = {}) {
    if (disposed) throw new PStudioGraphicsError('Graphics HAL is disposed.', { code: 'PSTUDIO_GRAPHICS_DISPOSED' });
    if (active) return snapshot();
    if (initialization) return initialization;

    const ticket = ++generation;
    const requiredFeatures = normalizeRequiredFeatures(context);
    const allowFallback = context.allowFallback ?? options.allowFallback ?? true;
    const candidates = orderedCandidates(context);
    attempts = [];
    lastError = null;
    controller = new AbortController();

    const externalSignal = context.signal;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternal();
      else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }

    publish('initializing', { requiredFeatures: Object.freeze(requiredFeatures) });

    initialization = (async () => {
      try {
        const eligible = [];
        for (const item of candidates) {
          const missing = requiredFeatures.filter(feature => !item.descriptor.features.includes(feature));
          if (missing.length) {
            attempts.push({ adapterId: item.descriptor.id, backend: item.descriptor.backend, status: 'skipped', reason: 'missing-features', missingFeatures: missing });
            continue;
          }
          let supported = true;
          try {
            if (item.adapter.supports) supported = item.adapter.supports(Object.freeze({ ...context, requiredFeatures: Object.freeze(requiredFeatures) })) !== false;
          } catch (error) {
            supported = false;
            attempts.push({ adapterId: item.descriptor.id, backend: item.descriptor.backend, status: 'skipped', reason: String(error?.message || error) });
          }
          if (supported) eligible.push(item);
          else if (!attempts.some(entry => entry.adapterId === item.descriptor.id)) {
            attempts.push({ adapterId: item.descriptor.id, backend: item.descriptor.backend, status: 'skipped', reason: 'adapter-not-supported' });
          }
        }

        const primaryBackend = String(context.preferredBackend || options.preferredBackend || context.backendOrder?.[0] || options.backendOrder?.[0] || candidates[0]?.descriptor.backend || '').toLowerCase();
        const candidatesToTry = allowFallback
          ? eligible
          : eligible.filter(item => item.descriptor.backend === primaryBackend).slice(0, 1);
        if (!allowFallback) {
          for (const item of eligible) {
            if (!candidatesToTry.includes(item)) {
              attempts.push({ adapterId: item.descriptor.id, backend: item.descriptor.backend, status: 'skipped', reason: 'fallback-disabled' });
            }
          }
        }
        for (let index = 0; index < candidatesToTry.length; index++) {
          const item = candidatesToTry[index];
          if (!isCurrent(ticket)) throw cancelledError(ticket);
          let handle = null;
          let handleDisposed = false;
          try {
            handle = await item.adapter.initialize(Object.freeze({
              ...context,
              backend: item.descriptor.backend,
              signal: controller.signal,
              requiredFeatures: Object.freeze(requiredFeatures)
            }));
            if (!isCurrent(ticket)) {
              try { handle?.dispose?.(); } catch (_) {}
              handleDisposed = true;
              throw new PStudioGraphicsError('Late graphics backend initialization was discarded.', { code: 'PSTUDIO_GRAPHICS_STALE_INITIALIZATION' });
            }
            if (!handle || typeof handle.render !== 'function') {
              try { handle?.dispose?.(); } catch (_) {}
              handleDisposed = true;
              throw new TypeError('Initialized graphics backend must return an object with render(frame).');
            }
            active = { adapter: item.adapter, descriptor: item.descriptor, handle };
            const usedFallback = attempts.some(entry => entry.status === 'failed') || item.descriptor.backend !== primaryBackend || index > 0;
            attempts.push({ adapterId: item.descriptor.id, backend: item.descriptor.backend, status: usedFallback ? 'fallback' : 'selected' });
            publish(usedFallback ? 'fallback' : 'ready', {
              fallback: usedFallback,
              selectedBackend: item.descriptor.backend,
              selectedAdapter: item.descriptor.id
            });
            return snapshot();
          } catch (error) {
            if (handle && !active && !handleDisposed) {
              try { handle.dispose?.(); } catch (_) {}
              handleDisposed = true;
            }
            if (!isCurrent(ticket)) throw cancelledError(ticket, error);
            lastError = error;
            attempts.push({ adapterId: item.descriptor.id, backend: item.descriptor.backend, status: 'failed', reason: String(error?.message || error) });
            if (!allowFallback) break;
          }
        }

        if (!isCurrent(ticket)) throw cancelledError(ticket);
        const summary = attempts.length ? attempts.map(item => item.adapterId + ': ' + item.status).join(', ') : 'no eligible backend adapters';
        const error = new PStudioGraphicsError('No graphics backend could be initialized (' + summary + ').', {
          code: 'PSTUDIO_GRAPHICS_NO_BACKEND',
          details: { attempts }
        });
        error.cause = lastError || undefined;
        lastError = error;
        publish('failed');
        throw error;
      } finally {
        externalSignal?.removeEventListener?.('abort', abortFromExternal);
      }
    })().finally(() => {
      initialization = null;
    });
    return initialization;
  }

  function render(frame) {
    if (disposed || !active || !['ready', 'fallback'].includes(state)) return false;
    return active.handle.render(frame) !== false;
  }

  function resize(width, height, pixelRatio = 1) {
    if (disposed || !active || !['ready', 'fallback'].includes(state)) return false;
    const w = Number(width), h = Number(height), ratio = Number(pixelRatio);
    if (!Number.isSafeInteger(w) || w <= 0 || !Number.isSafeInteger(h) || h <= 0 || !Number.isFinite(ratio) || ratio <= 0) {
      throw new TypeError('Graphics resize requires positive integer dimensions and a positive pixel ratio.');
    }
    return active.handle.resize?.(w, h, ratio) !== false;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    generation += 1;
    try { controller.abort(); } catch (_) {}
    const previous = active;
    active = null;
    try { previous?.handle?.dispose?.(); } catch (_) {}
    publish('disposed');
    return true;
  }

  return Object.freeze({
    kind: 'pstudio-graphics-hal',
    register,
    unregister,
    listBackends,
    initialize,
    render,
    resize,
    getState: () => snapshot(),
    getActiveHandle: () => active?.handle || null,
    dispose
  });
}
