import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

function normalizeBloom(options) {
  if (options === false || options?.enabled === false) return null;
  const source = options === true || options === undefined ? {} : (options || {});
  return {
    strength: Math.max(0, Math.min(2, Number.isFinite(Number(source.strength)) ? Number(source.strength) : 0.18)),
    radius: Math.max(0, Math.min(1, Number.isFinite(Number(source.radius)) ? Number(source.radius) : 0.22)),
    threshold: Math.max(0, Math.min(1, Number.isFinite(Number(source.threshold)) ? Number(source.threshold) : 0.82))
  };
}

/**
 * Creates the r187 TSL RenderPipeline used by PStudio's WebGPU path.
 * The pipeline owns a single fullscreen material and composes effects as nodes.
 */
export function createPStudioRenderPipeline(renderer, scene, camera, options = {}) {
  if (renderer?.backend?.isWebGPUBackend !== true) {
    throw new TypeError('PStudio RenderPipeline requires an initialized WebGPU backend.');
  }
  if (!scene?.isScene || !camera?.isCamera) {
    throw new TypeError('PStudio RenderPipeline requires a Scene and Camera.');
  }

  const renderPipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  let bloomSettings = normalizeBloom(options.bloom);
  let disposed = false;

  function rebuildOutput() {
    let output = sceneColor;
    if (bloomSettings && bloomSettings.strength > 0) {
      const glow = bloom(sceneColor, bloomSettings.strength, bloomSettings.radius, bloomSettings.threshold);
      output = sceneColor.add(glow);
    }
    renderPipeline.outputNode = output;
    renderPipeline.needsUpdate = true;
  }

  try {
    rebuildOutput();
  } catch (error) {
    try { scenePass.dispose?.(); } catch (_) {}
    try { renderPipeline.dispose(); } catch (_) {}
    throw error;
  }

  return Object.freeze({
    kind: 'webgpu-tsl-render-pipeline',
    render() {
      if (disposed) return false;
      renderPipeline.render();
      return true;
    },
    setBloom(nextOptions) {
      if (disposed) return false;
      bloomSettings = normalizeBloom(nextOptions);
      rebuildOutput();
      return true;
    },
    getState() {
      return Object.freeze({
        disposed,
        bloom: bloomSettings ? { ...bloomSettings } : null,
        pipeline: 'three-r187-render-pipeline'
      });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      try { scenePass.dispose?.(); } catch (_) {}
      try { renderPipeline.dispose(); } catch (_) {}
      return true;
    }
  });
}
