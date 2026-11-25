import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
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

  const scenePass = pass(scene, camera);
  let renderPipeline = null;
  let sceneColor = null;
  let sceneDepth = null;
  let sceneNormal = null;
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
    // One shared scene pass supplies the beauty, projection-depth and packed
    // view-normal attachments needed by water, terrain, GI and screen-space FX.
    // Keep normals in RGBA8 to avoid the default FP16 MRT bandwidth cost.
    if (
      typeof scenePass.setMRT !== 'function'
      || typeof scenePass.getTexture !== 'function'
      || typeof scenePass.getTextureNode !== 'function'
      || typeof TSL.mrt !== 'function'
      || typeof TSL.packNormalToRGB !== 'function'
      || !TSL.output
      || !TSL.normalView
    ) {
      throw new Error('Three.js r187 does not expose the required TSL scene-frame attachment APIs.');
    }

    scenePass.setMRT(TSL.mrt({
      output: TSL.output,
      normal: TSL.packNormalToRGB(TSL.normalView)
    }));

    const normalTexture = scenePass.getTexture('normal');
    if (!normalTexture) {
      throw new Error('The TSL scene pass did not create its normal attachment.');
    }
    normalTexture.type = THREE.UnsignedByteType;

    sceneColor = scenePass.getTextureNode('output');
    sceneDepth = scenePass.getTextureNode('depth');
    sceneNormal = scenePass.getTextureNode('normal');
    if (!sceneColor || !sceneDepth || !sceneNormal) {
      throw new Error('The TSL scene pass did not expose all required frame attachments.');
    }

    renderPipeline = new THREE.RenderPipeline(renderer);
    rebuildOutput();
  } catch (error) {
    try { scenePass.dispose?.(); } catch (_) {}
    try { renderPipeline?.dispose?.(); } catch (_) {}
    throw error;
  }

  const frameResources = Object.freeze({
    kind: 'pstudio-scene-frame-resources',
    color: sceneColor,
    depth: sceneDepth,
    normal: sceneNormal,
    normalEncoding: 'packed-rgb-unorm8',
    normalSpace: 'view',
    depthSpace: 'projection',
    attachments: Object.freeze(['output', 'depth', 'normal'])
  });

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
    getFrameResources() {
      return disposed ? null : frameResources;
    },
    getState() {
      return Object.freeze({
        disposed,
        bloom: bloomSettings ? { ...bloomSettings } : null,
        frameResources: disposed ? null : Object.freeze({
          attachments: frameResources.attachments,
          normalEncoding: frameResources.normalEncoding,
          normalSpace: frameResources.normalSpace,
          depthSpace: frameResources.depthSpace
        }),
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
