import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssao } from 'three/addons/tsl/display/SSAONode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';

export const supportsPStudioTSLSSAO = typeof ssao === 'function';
export const supportsPStudioTSLGTAO = typeof gtao === 'function';
export const supportsPStudioTSLSSR = typeof ssr === 'function';

function normalizeBloom(options) {
  if (options === false || options?.enabled === false) return null;
  const source = options === true || options === undefined ? {} : (options || {});
  return {
    strength: Math.max(0, Math.min(2, Number.isFinite(Number(source.strength)) ? Number(source.strength) : 0.18)),
    radius: Math.max(0, Math.min(1, Number.isFinite(Number(source.radius)) ? Number(source.radius) : 0.22)),
    threshold: Math.max(0, Math.min(1, Number.isFinite(Number(source.threshold)) ? Number(source.threshold) : 0.82))
  };
}

function normalizeAO(options) {
  if (options === false || options?.enabled === false || options == null) return null;
  const source = options === true ? {} : options;
  const mode = source.mode === 'gtao' && supportsPStudioTSLGTAO ? 'gtao' : 'ssao';
  return {
    mode,
    strength: Math.max(0, Math.min(1, Number.isFinite(Number(source.strength)) ? Number(source.strength) : 0.82))
  };
}

function normalizeSSR(options) {
  if (options === false || options?.enabled === false || options == null) return null;
  const source = options === true ? {} : options;
  return {
    quality: Math.max(0, Math.min(1, Number.isFinite(Number(source.quality)) ? Number(source.quality) : 0.72)),
    blurQuality: Math.max(1, Math.min(3, Math.round(Number(source.blurQuality) || 2))),
    maxDistance: Math.max(0.01, Math.min(1, Number.isFinite(Number(source.maxDistance)) ? Number(source.maxDistance) : 0.72)),
    intensity: Math.max(0, Math.min(2, Number.isFinite(Number(source.intensity)) ? Number(source.intensity) : 1)),
    thickness: Math.max(0.001, Math.min(0.1, Number.isFinite(Number(source.thickness)) ? Number(source.thickness) : 0.03)),
    binaryRefine: source.binaryRefine === true,
    reflectNonMetals: source.reflectNonMetals !== false
  };
}

function normalizeGodRays(options) {
  if (options === false || options?.enabled === false || options == null) return null;
  const source = options === true ? {} : options;
  const position = Array.isArray(source.lightPosition) ? source.lightPosition : [0.5, 0.78];
  return {
    enabled: true,
    intensity: Math.max(0, Math.min(2, Number.isFinite(Number(source.intensity)) ? Number(source.intensity) : 0)),
    lightPosition: [
      Math.max(-2, Math.min(3, Number.isFinite(Number(position[0])) ? Number(position[0]) : 0.5)),
      Math.max(-2, Math.min(3, Number.isFinite(Number(position[1])) ? Number(position[1]) : 0.78))
    ],
    density: Math.max(0, Math.min(1.5, Number.isFinite(Number(source.density)) ? Number(source.density) : 0.92)),
    decay: Math.max(0, Math.min(1, Number.isFinite(Number(source.decay)) ? Number(source.decay) : 0.965)),
    weight: Math.max(0, Math.min(2, Number.isFinite(Number(source.weight)) ? Number(source.weight) : 0.82)),
    threshold: Math.max(0, Math.min(1, Number.isFinite(Number(source.threshold)) ? Number(source.threshold) : 0.58))
  };
}

function createGodRaysNode(sceneColor, settings) {
  const lightPosition = TSL.uniform(new THREE.Vector2(...settings.lightPosition));
  const intensity = TSL.uniform(settings.intensity);
  const density = TSL.uniform(settings.density);
  const decay = TSL.uniform(settings.decay);
  const weight = TSL.uniform(settings.weight);
  const threshold = TSL.uniform(settings.threshold);
  const node = TSL.Fn(() => {
    const source = sceneColor.sample(TSL.screenUV);
    const delta = TSL.screenUV.sub(lightPosition).mul(density.div(20));
    const coord = TSL.screenUV.toVar();
    const illuminationDecay = TSL.float(1).toVar();
    const shafts = TSL.vec3(0).toVar();
    TSL.Loop({ start: 0, end: 20 }, () => {
      coord.subAssign(delta);
      const sampleColor = sceneColor.sample(TSL.clamp(coord, TSL.vec2(0.001), TSL.vec2(0.999)));
      const luminance = sampleColor.rgb.dot(TSL.vec3(0.2126, 0.7152, 0.0722));
      const bright = TSL.smoothstep(threshold, threshold.add(0.38), luminance);
      shafts.addAssign(sampleColor.rgb.mul(bright).mul(illuminationDecay));
      illuminationDecay.mulAssign(decay);
    });
    const rays = shafts.mul(weight.div(20)).mul(intensity);
    return TSL.vec4(source.rgb.add(rays), source.a);
  })();
  return Object.freeze({
    node,
    set(settings) {
      if (!settings) {
        intensity.value = 0;
        return;
      }
      lightPosition.value.set(settings.lightPosition[0], settings.lightPosition[1]);
      intensity.value = settings.intensity;
      density.value = settings.density;
      decay.value = settings.decay;
      weight.value = settings.weight;
      threshold.value = settings.threshold;
    },
    getState() {
      return Object.freeze({
        intensity: intensity.value,
        density: density.value,
        decay: decay.value,
        weight: weight.value,
        threshold: threshold.value,
        lightPosition: Object.freeze([lightPosition.value.x, lightPosition.value.y])
      });
    }
  });
}

/**
 * Creates the r187 TSL RenderPipeline used by PStudio's WebGPU path.
 * Beauty, projection depth, packed view normals and packed metal/roughness
 * are produced by one shared MRT scene pass. Optional effects consume those
 * attachments without introducing a second opaque-scene render.
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
  let sceneMetalRough = null;
  let bloomSettings = normalizeBloom(options.bloom);
  let aoSettings = normalizeAO(options.ambientOcclusion ?? options.ao);
  let ssrSettings = normalizeSSR(options.ssr);
  let godRaysSettings = normalizeGodRays(options.godRays);
  let godRaysHandle = null;
  let aoPass = null;
  let ssrPass = null;
  let disposed = false;

  function releaseScreenSpaceNodes() {
    try { aoPass?.dispose?.(); } catch (_) {}
    try { ssrPass?.dispose?.(); } catch (_) {}
    aoPass = null;
    ssrPass = null;
  }

  function rebuildOutput() {
    releaseScreenSpaceNodes();
    let output = sceneColor;

    if (aoSettings) {
      if (aoSettings.mode === 'gtao') {
        aoPass = gtao(sceneDepth, sceneNormal, camera);
        const aoTexture = aoPass.getTextureNode();
        const factor = TSL.mix(TSL.float(1), aoTexture.sample(TSL.screenUV).r, aoSettings.strength);
        output = output.mul(factor);
      } else {
        aoPass = ssao(sceneDepth, sceneNormal, camera);
        const factor = TSL.mix(TSL.float(1), aoPass.r, aoSettings.strength);
        output = output.mul(factor);
      }
    }

    if (ssrSettings) {
      ssrPass = ssr(sceneColor, sceneDepth, sceneNormal, {
        metalnessNode: sceneMetalRough.r,
        roughnessNode: sceneMetalRough.g,
        reflectNonMetals: ssrSettings.reflectNonMetals,
        binaryRefine: ssrSettings.binaryRefine,
        camera
      });
      if (ssrPass.quality?.value !== undefined) ssrPass.quality.value = ssrSettings.quality;
      if (ssrPass.maxDistance?.value !== undefined) ssrPass.maxDistance.value = ssrSettings.maxDistance;
      if (ssrPass.intensity?.value !== undefined) ssrPass.intensity.value = ssrSettings.intensity;
      if (ssrPass.thickness?.value !== undefined) ssrPass.thickness.value = ssrSettings.thickness;
      ssrPass.blurQuality = ssrSettings.blurQuality;
      // SSRNode returns premultiplied reflection radiance; Three.js r187's
      // reference composition adds its RGB result over the beauty contribution.
      output = output.add(ssrPass.rgb);
    }

    if (bloomSettings && bloomSettings.strength > 0) {
      const glow = bloom(output, bloomSettings.strength, bloomSettings.radius, bloomSettings.threshold);
      output = output.add(glow);
    }
    if (godRaysHandle) output = godRaysHandle.node;
    renderPipeline.outputNode = output;
    renderPipeline.needsUpdate = true;
  }

  try {
    if (
      typeof scenePass.setMRT !== 'function'
      || typeof scenePass.getTexture !== 'function'
      || typeof scenePass.getTextureNode !== 'function'
      || typeof TSL.mrt !== 'function'
      || typeof TSL.packNormalToRGB !== 'function'
      || typeof TSL.unpackRGBToNormal !== 'function'
      || typeof TSL.sample !== 'function'
      || !TSL.output
      || !TSL.normalView
      || !TSL.metalness
      || !TSL.roughness
    ) {
      throw new Error('Three.js r187 does not expose the required TSL scene-frame attachment APIs.');
    }

    scenePass.setMRT(TSL.mrt({
      output: TSL.output,
      normal: TSL.packNormalToRGB(TSL.normalView),
      metalrough: TSL.vec2(TSL.metalness, TSL.roughness)
    }));

    const normalTexture = scenePass.getTexture('normal');
    const metalRoughTexture = scenePass.getTexture('metalrough');
    if (!normalTexture || !metalRoughTexture) {
      throw new Error('The TSL scene pass did not create its normal and metal/roughness attachments.');
    }
    normalTexture.type = THREE.UnsignedByteType;
    metalRoughTexture.type = THREE.UnsignedByteType;

    const sceneNormalPacked = scenePass.getTextureNode('normal');
    sceneColor = scenePass.getTextureNode('output');
    sceneDepth = scenePass.getTextureNode('depth');
    sceneMetalRough = scenePass.getTextureNode('metalrough');
    sceneNormal = TSL.sample((uvNode) => TSL.unpackRGBToNormal(sceneNormalPacked.sample(uvNode)));
    if (!sceneColor || !sceneDepth || !sceneNormal || !sceneMetalRough) {
      throw new Error('The TSL scene pass did not expose all required frame attachments.');
    }

    renderPipeline = new THREE.RenderPipeline(renderer);
    if (godRaysSettings) godRaysHandle = createGodRaysNode(sceneColor, godRaysSettings);
    rebuildOutput();
  } catch (error) {
    releaseScreenSpaceNodes();
    try { scenePass.dispose?.(); } catch (_) {}
    try { renderPipeline?.dispose?.(); } catch (_) {}
    throw error;
  }

  const frameResources = Object.freeze({
    kind: 'pstudio-scene-frame-resources',
    color: sceneColor,
    depth: sceneDepth,
    normal: sceneNormal,
    metalRough: sceneMetalRough,
    normalEncoding: 'packed-rgb-unorm8-decoded-to-view-normal',
    metalRoughEncoding: 'rg-unorm8',
    normalSpace: 'view',
    depthSpace: 'projection',
    attachments: Object.freeze(['output', 'depth', 'normal', 'metalrough'])
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
    setAmbientOcclusion(nextOptions) {
      if (disposed) return false;
      aoSettings = normalizeAO(nextOptions);
      rebuildOutput();
      return true;
    },
    setSSR(nextOptions) {
      if (disposed) return false;
      ssrSettings = normalizeSSR(nextOptions);
      rebuildOutput();
      return true;
    },
    setGodRays(nextOptions) {
      if (disposed) return false;
      godRaysSettings = normalizeGodRays(nextOptions);
      if (!godRaysSettings) {
        godRaysHandle?.set(null);
        rebuildOutput();
        return true;
      }
      if (!godRaysHandle) godRaysHandle = createGodRaysNode(sceneColor, godRaysSettings);
      else godRaysHandle.set(godRaysSettings);
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
        ambientOcclusion: aoSettings ? { ...aoSettings } : null,
        ssr: ssrSettings ? { ...ssrSettings } : null,
        godRays: godRaysHandle ? godRaysHandle.getState() : null,
        frameResources: disposed ? null : Object.freeze({
          attachments: frameResources.attachments,
          normalEncoding: frameResources.normalEncoding,
          metalRoughEncoding: frameResources.metalRoughEncoding,
          normalSpace: frameResources.normalSpace,
          depthSpace: frameResources.depthSpace
        }),
        pipeline: 'three-r187-render-pipeline'
      });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      releaseScreenSpaceNodes();
      try { scenePass.dispose?.(); } catch (_) {}
      try { renderPipeline.dispose(); } catch (_) {}
      return true;
    }
  });
}
