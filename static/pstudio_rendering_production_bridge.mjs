import { createPStudioProductionRendererHost } from './pstudio_rendering_production_host.mjs?v=20261126-genesis-water-live-v1';
import { inspectPStudioWebGPUSceneMaterials } from './pstudio_rendering_migration.mjs';

/**
 * Safely promotes the existing production scene from its already-live WebGL2
 * canvas to an isolated WebGPU canvas. WebGL2 remains the visible renderer until
 * the WebGPU scene has converted and compiled successfully.
 *
 * Promotion is deliberately fail-closed: unsupported material hooks and
 * engine-declared feature blockers keep the legacy renderer active.
 */
export function createPStudioProductionRenderingBridge(options = {}) {
  const legacyCanvas = options.legacyCanvas;
  const scene = options.scene;
  const camera = options.camera;
  if (!legacyCanvas || !legacyCanvas.parentElement) {
    throw new TypeError('An attached legacy WebGL canvas is required.');
  }
  if (!scene?.isScene || !camera?.isCamera) {
    throw new TypeError('A Three.js Scene and Camera are required.');
  }

  const documentRef = options.documentRef || legacyCanvas.ownerDocument;
  if (!documentRef?.createElement) {
    throw new TypeError('The legacy canvas must belong to a document that can create canvases.');
  }

  const createHost = options.createHost || createPStudioProductionRendererHost;
  const navigatorRef = options.navigatorRef ?? globalThis.navigator;
  let host = null;
  let webgpuCanvas = null;
  let initialization = null;
  let disposed = false;
  let state = 'idle';
  let lastError = null;
  let blockers = Object.freeze([]);
  let lastStage = null;

  function publish(nextState, details = {}) {
    state = nextState;
    try {
      options.onStateChange?.(Object.freeze({
        state,
        backend: host?.getState?.().backend || 'webgl2',
        blockers,
        lastError: lastError ? String(lastError.message || lastError) : null,
        ...details
      }));
    } catch (_) {}
  }

  function evaluate() {
    const nextBlockers = [];
    let compatibility;
    try {
      compatibility = inspectPStudioWebGPUSceneMaterials(scene);
    } catch (error) {
      nextBlockers.push(Object.freeze({
        id: 'scene-preflight',
        message: String(error?.message || error)
      }));
    }
    if (compatibility && !compatibility.compatible) {
      for (const material of compatibility.unsupported || []) {
        nextBlockers.push(Object.freeze({
          id: 'unsupported-material',
          material: material.name,
          type: material.type,
          reason: material.reason
        }));
      }
    }
    if (!options.createWebGPU && options.requireWebGPUCapability !== false && !navigatorRef?.gpu) {
      nextBlockers.push(Object.freeze({
        id: 'webgpu-unavailable',
        message: 'The current browser does not expose navigator.gpu.'
      }));
    }

    if (typeof options.canPromote === 'function') {
      try {
        const policy = options.canPromote({ scene, compatibility });
        if (policy === false) {
          nextBlockers.push(Object.freeze({ id: 'engine-feature-policy', message: 'The active production scene uses a feature that has not been ported to TSL.' }));
        } else if (Array.isArray(policy)) {
          for (const item of policy) nextBlockers.push(Object.freeze({ id: 'engine-feature-policy', message: String(item) }));
        } else if (policy && typeof policy === 'object') {
          if (policy.allowed === false) {
            const supplied = Array.isArray(policy.blockers) ? policy.blockers : [];
            if (!supplied.length) nextBlockers.push(Object.freeze({ id: 'engine-feature-policy', message: 'The active production scene uses an unported feature.' }));
            for (const item of supplied) {
              nextBlockers.push(Object.freeze(
                typeof item === 'string'
                  ? { id: 'engine-feature-policy', message: item }
                  : { id: 'engine-feature-policy', ...item }
              ));
            }
          }
        }
      } catch (error) {
        nextBlockers.push(Object.freeze({
          id: 'engine-feature-policy-error',
          message: String(error?.message || error)
        }));
      }
    }

    blockers = Object.freeze(nextBlockers);
    return Object.freeze({
      allowed: blockers.length === 0,
      blockers,
      compatibility: compatibility || null
    });
  }

  function createWebGPUCanvas() {
    const parent = legacyCanvas.parentElement;
    const canvas = documentRef.createElement('canvas');
    canvas.className = legacyCanvas.className || 'game-canvas game-canvas-3d';
    canvas.setAttribute?.('aria-label', 'PStudio WebGPU renderer');
    canvas.setAttribute?.('data-pstudio-renderer', 'webgpu');
    parent.insertBefore(canvas, legacyCanvas);
    return canvas;
  }

  function defaultFallback() {
    return {
      backend: 'webgl2',
      render: () => options.renderLegacy?.() !== false,
      resize: (width, height, pixelRatio) => options.resizeLegacy?.(width, height, pixelRatio) !== false,
      // The engine owns and retains its original WebGLRenderer for recovery.
      dispose() {}
    };
  }

  async function initialize() {
    if (disposed) throw new Error('PStudio production rendering bridge has been disposed.');
    if (host) return host.initialize();
    if (initialization) return initialization;

    const assessment = evaluate();
    if (!assessment.allowed) {
      publish('blocked', { compatibility: assessment.compatibility });
      return false;
    }

    initialization = (async () => {
      try {
        webgpuCanvas = createWebGPUCanvas();
        host = createHost({
          ...options,
          primaryCanvas: webgpuCanvas,
          fallbackCanvas: legacyCanvas,
          initialBackend: 'webgl2',
          scene,
          camera,
          navigatorRef,
          createFallback: options.createFallback || defaultFallback,
          onStageChange(stage, details) {
            lastStage = stage;
            try { options.onStageChange?.(stage, details); } catch (_) {}
            publish(state, { stage, stageDetails: details || null });
          },
          onStateChange(snapshot) {
            publish(snapshot.state, {
              backend: snapshot.backend || 'webgl2',
              runtime: snapshot
            });
          }
        });

        publish('initializing-webgpu', { backend: 'webgl2' });
        const active = await host.initialize();
        const finalState = host.getState();
        if (finalState.backend === 'webgpu') {
          publish('ready', { backend: 'webgpu', capabilities: active?.capabilities || null });
        } else {
          lastError = finalState.lastError ? new Error(finalState.lastError) : lastError;
          publish('fallback', { backend: 'webgl2' });
        }
        return active;
      } catch (error) {
        lastError = error;
        publish('failed', { backend: 'webgl2' });
        throw error;
      } finally {
        initialization = null;
      }
    })();
    return initialization;
  }

  return Object.freeze({
    kind: 'pstudio-production-rendering-bridge',
    initialize,
    render() {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.render();
    },
    resize(width, height, pixelRatio) {
      if (disposed || !host) return false;
      return host.resize(width, height, pixelRatio);
    },
    setEnvironment(profile) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setEnvironment?.(profile) === true;
    },
    setWaterEnvironment(profile) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setWaterEnvironment?.(profile) === true;
    },
    setBloom(settings) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setBloom?.(settings) === true;
    },
    setAntiAliasing(settings) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setAntiAliasing?.(settings) === true;
    },
    setAmbientOcclusion(settings) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setAmbientOcclusion?.(settings) === true;
    },
    setSSR(settings) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setSSR?.(settings) === true;
    },
    setGodRays(settings) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setGodRays?.(settings) === true;
    },
    setContactShadows(settings) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setContactShadows?.(settings) === true;
    },
    setVolumetricFog(settings) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setVolumetricFog?.(settings) === true;
    },
    setVolumetricClouds(settings) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setVolumetricClouds?.(settings) === true;
    },
    setClusteredLightingSnapshot(snapshot) {
      if (disposed || !host || host.getState().backend !== 'webgpu') return false;
      return host.setClusteredLightingSnapshot?.(snapshot) === true;
    },
    getRenderer() {
      if (disposed || !host || host.getState().backend !== 'webgpu') return null;
      return host.getRenderer?.() || null;
    },
    async useFallback(cause) {
      if (disposed || !host) return false;
      const error = cause instanceof Error ? cause : new Error(String(cause || 'PStudio requested WebGL2 fallback.'));
      const result = await host.useFallback(error);
      if (result) publish('fallback', { backend: 'webgl2', cause: error });
      return !!result;
    },
    evaluate,
    getState() {
      const runtime = host?.getState?.() || null;
      return Object.freeze({
        state,
        backend: runtime?.backend || 'webgl2',
        initialized: !!runtime?.initialized,
        disposed,
        blockers,
        compatibility: runtime ? undefined : null,
        stage: lastStage,
        runtime,
        lastError: lastError ? String(lastError.message || lastError) : runtime?.lastError || null
      });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      try { host?.dispose?.(); } catch (_) {}
      webgpuCanvas?.remove?.();
      host = null;
      webgpuCanvas = null;
      publish('disposed', { backend: 'webgl2' });
      return true;
    }
  });
}
