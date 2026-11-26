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
export const supportsPStudioTSLGodRays = typeof TSL.Fn === 'function' && typeof TSL.Loop === 'function' && typeof TSL.smoothstep === 'function' && typeof TSL.screenUV !== 'undefined';

export const supportsPStudioTSLVolumetricFog = [
  'getViewPosition', 'projectionDepth', 'cameraProjectionMatrixInverse',
  'cameraWorldMatrix', 'cameraNear', 'cameraFar', 'isBackgroundDepth',
  'Loop', 'If', 'Break', 'sin', 'cos', 'exp', 'pow', 'mix', 'smoothstep'
].every(name => TSL[name] !== undefined);

function vector3Option(value, fallback) {
  if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(item => Number.isFinite(Number(item)))) {
    return new THREE.Vector3(Number(value[0]), Number(value[1]), Number(value[2]));
  }
  if (value?.isColor || value?.isVector3) return new THREE.Vector3(value.r ?? value.x, value.g ?? value.y, value.b ?? value.z);
  return new THREE.Vector3(...fallback);
}

function normalizeVolumetricFog(options) {
  if (options === false || options?.enabled === false || options == null) return null;
  const source = options === true ? {} : options;
  return {
    fogColor: vector3Option(source.fogColor, [0.725, 0.847, 0.851]),
    fogAmbientColor: vector3Option(source.fogAmbientColor, [0.851, 0.933, 1]),
    sunColor: vector3Option(source.sunColor, [1, 0.945, 0.839]),
    sunDirection: vector3Option(source.sunDirection, [-0.35, 0.82, -0.44]).normalize(),
    density: Math.max(0, Math.min(0.08, Number.isFinite(Number(source.density)) ? Number(source.density) : 0.0018)),
    heightFalloff: Math.max(0, Math.min(0.2, Number.isFinite(Number(source.heightFalloff)) ? Number(source.heightFalloff) : 0.018)),
    baseHeight: Math.max(-10000, Math.min(10000, Number.isFinite(Number(source.baseHeight)) ? Number(source.baseHeight) : 0)),
    anisotropy: Math.max(0, Math.min(0.88, Number.isFinite(Number(source.anisotropy)) ? Number(source.anisotropy) : 0.42)),
    steps: Math.max(6, Math.min(32, Math.round(Number(source.steps) || 16))),
    time: Number.isFinite(Number(source.time)) ? Number(source.time) : 0
  };
}

function createVolumetricFogNode(inputColor, sceneDepth, settings) {
  const fogColor = TSL.uniform(settings.fogColor.clone());
  const fogAmbientColor = TSL.uniform(settings.fogAmbientColor.clone());
  const sunColor = TSL.uniform(settings.sunColor.clone());
  const sunDirection = TSL.uniform(settings.sunDirection.clone());
  const density = TSL.uniform(settings.density);
  const heightFalloff = TSL.uniform(settings.heightFalloff);
  const baseHeight = TSL.uniform(settings.baseHeight);
  const anisotropy = TSL.uniform(settings.anisotropy);
  const steps = TSL.uniform(settings.steps);
  const time = TSL.uniform(settings.time);
  const noise3 = TSL.Fn(([p]) => {
    const phase = p.x.mul(0.73)
      .add(TSL.sin(p.y.mul(0.51).add(p.z.mul(0.91)).mul(1.7)))
      .add(time.mul(0.025));
    return TSL.float(0.5).add(TSL.sin(phase).mul(0.5));
  }, { p: 'vec3', return: 'float' });

  const node = TSL.Fn(() => {
    const uv = TSL.screenUV;
    const source = inputColor.sample(uv);
    const depth = sceneDepth.sample(uv).r;
    const linearDepth = TSL.projectionDepth(depth, TSL.cameraNear, TSL.cameraFar);
    const viewPosition = TSL.getViewPosition(uv, linearDepth, TSL.cameraProjectionMatrixInverse);
    const worldEnd = TSL.cameraWorldMatrix.mul(TSL.vec4(viewPosition, 1)).xyz;
    const worldOrigin = TSL.cameraWorldMatrix.mul(TSL.vec4(0, 0, 0, 1)).xyz;
    const rayVector = worldEnd.sub(worldOrigin);
    const rayLength = rayVector.length();
    const rayDirection = rayVector.div(TSL.max(rayLength, 1e-5));
    const sun = TSL.normalize(sunDirection);
    const cosine = TSL.dot(rayDirection.negate(), sun);
    const g = TSL.clamp(anisotropy, 0, 0.88);
    const g2 = g.mul(g);
    const phaseDenominator = TSL.max(0.001, TSL.float(1).add(g2).sub(g.mul(cosine).mul(2)));
    const phase = TSL.float(1).sub(g2).div(TSL.float(12.5663706).mul(TSL.pow(phaseDenominator, 1.5)));
    const activeSteps = TSL.clamp(steps, 6, 32);
    const segmentLength = rayLength.div(activeSteps);
    const optical = TSL.float(0).toVar();
    const scatter = TSL.vec3(0).toVar();

    TSL.Loop({ start: 0, end: 32 }, ({ i }) => {
      TSL.If(TSL.float(i).greaterThanEqual(activeSteps), () => TSL.Break());
      const fraction = TSL.float(i).add(0.5).div(activeSteps);
      const worldPosition = worldOrigin.add(rayDirection.mul(rayLength.mul(fraction)));
      const height = worldPosition.y.sub(baseHeight);
      const vertical = TSL.exp(TSL.max(height, 0).mul(heightFalloff).negate());
      const groundHaze = TSL.float(1).add(TSL.exp(height.abs().mul(-0.022)).mul(0.24));
      const noiseA = noise3(worldPosition.mul(0.035));
      const noiseB = noise3(worldPosition.mul(0.11));
      const detail = TSL.mix(noiseA, noiseB, 0.32);
      const localDensity = density.mul(vertical).mul(groundHaze).mul(TSL.mix(0.82, 1.14, detail));
      const segmentOptical = localDensity.mul(segmentLength);
      const transmittance = TSL.exp(optical.negate());
      const segmentAlpha = TSL.float(1).sub(TSL.exp(segmentOptical.negate()));
      const sunForward = TSL.pow(TSL.max(cosine, 0), 5);
      const ambient = fogAmbientColor.mul(0.52).add(fogColor.mul(0.48));
      const direct = sunColor.mul(phase.mul(4).add(sunForward.mul(0.38)));
      scatter.addAssign(ambient.add(direct).mul(transmittance).mul(segmentAlpha));
      optical.addAssign(segmentOptical);
      TSL.If(optical.greaterThan(8), () => TSL.Break());
    });

    const finalTransmittance = TSL.exp(optical.negate());
    const fogged = source.rgb.mul(finalTransmittance).add(scatter);
    const result = TSL.vec4(fogged, source.a);
    return TSL.isBackgroundDepth(depth).select(source, result);
  })();

  return Object.freeze({
    node,
    set(next) {
      if (!next) { density.value = 0; return; }
      fogColor.value.copy(next.fogColor);
      fogAmbientColor.value.copy(next.fogAmbientColor);
      sunColor.value.copy(next.sunColor);
      sunDirection.value.copy(next.sunDirection);
      density.value = next.density;
      heightFalloff.value = next.heightFalloff;
      baseHeight.value = next.baseHeight;
      anisotropy.value = next.anisotropy;
      steps.value = next.steps;
      time.value = next.time;
    },
    getState() {
      return Object.freeze({
        density: density.value, heightFalloff: heightFalloff.value,
        baseHeight: baseHeight.value, anisotropy: anisotropy.value,
        steps: steps.value, time: time.value
      });
    }
  });
}

export const supportsPStudioTSLContactShadows = [
  'getViewPosition', 'getScreenPositionFromClip', 'projectionDepth',
  'cameraProjectionMatrix', 'cameraProjectionMatrixInverse', 'cameraViewMatrix',
  'cameraNear', 'cameraFar', 'isBackgroundDepth', 'Loop', 'If', 'Break',
  'step', 'smoothstep', 'clamp', 'normalize', 'screenUV'
].every(name => TSL[name] !== undefined);


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


function normalizeContactShadows(options) {
  if (options === false || options?.enabled === false || options == null) return null;
  const source = options === true ? {} : options;
  const lightDirection = Array.isArray(source.lightDirectionWorld) ? source.lightDirectionWorld : [0.35, 0.82, 0.44];
  const vectorLength = Math.hypot(...lightDirection);
  const direction = vectorLength > 1e-6
    ? lightDirection.map(value => Number(value) / vectorLength)
    : [0.35, 0.82, 0.44];
  const fadeStart = Math.max(0, Number.isFinite(Number(source.fadeStart)) ? Number(source.fadeStart) : 28);
  const fadeEnd = Math.max(fadeStart + 1, Number.isFinite(Number(source.fadeEnd)) ? Number(source.fadeEnd) : 105);
  return {
    enabled: true,
    intensity: Math.max(0, Math.min(1.5, Number.isFinite(Number(source.intensity)) ? Number(source.intensity) : 0.42)),
    maxDistance: Math.max(0.01, Math.min(4, Number.isFinite(Number(source.maxDistance)) ? Number(source.maxDistance) : 0.82)),
    thickness: Math.max(0.001, Math.min(0.5, Number.isFinite(Number(source.thickness)) ? Number(source.thickness) : 0.075)),
    depthBias: Math.max(0, Math.min(0.25, Number.isFinite(Number(source.depthBias)) ? Number(source.depthBias) : 0.018)),
    steps: Math.max(4, Math.min(32, Math.round(Number(source.steps) || 12))),
    fadeStart, fadeEnd,
    lightDirectionWorld: direction
  };
}

function createContactShadowsNode(inputColor, sceneDepth, settings) {
  const intensity = TSL.uniform(settings.intensity);
  const maxDistance = TSL.uniform(settings.maxDistance);
  const thickness = TSL.uniform(settings.thickness);
  const depthBias = TSL.uniform(settings.depthBias);
  const steps = TSL.uniform(settings.steps);
  const fadeStart = TSL.uniform(settings.fadeStart);
  const fadeEnd = TSL.uniform(Math.max(settings.fadeStart + 1, settings.fadeEnd));
  const lightDirectionWorld = TSL.uniform(new THREE.Vector3(...settings.lightDirectionWorld));

  const node = TSL.Fn(() => {
    const uv = TSL.screenUV;
    const source = inputColor.sample(uv);
    const depth = sceneDepth.sample(uv).r;
    const viewDepth = TSL.projectionDepth(depth, TSL.cameraNear, TSL.cameraFar);
    const origin = TSL.getViewPosition(uv, viewDepth, TSL.cameraProjectionMatrixInverse);
    const viewDistance = TSL.max(0, origin.z.negate());
    const distanceFade = TSL.float(1).sub(TSL.smoothstep(fadeStart, fadeEnd, viewDistance));
    const lightDirection = TSL.normalize(
      TSL.cameraViewMatrix.mul(TSL.vec4(TSL.normalize(lightDirectionWorld), 0)).xyz
    );
    const stepLength = maxDistance.div(steps);
    const jitter = TSL.fract(
      TSL.sin(TSL.dot(uv.mul(1000), TSL.vec2(12.9898, 78.233))).mul(43758.5453)
    );
    const occlusion = TSL.float(0).toVar();

    TSL.Loop({ start: 0, end: 32 }, ({ i }) => {
      TSL.If(TSL.float(i).greaterThanEqual(steps), () => TSL.Break());
      const travel = TSL.float(0.045).add(TSL.float(i).add(jitter).mul(stepLength));
      const rayPoint = origin.add(lightDirection.mul(travel));
      TSL.If(rayPoint.z.greaterThan(-0.02), () => TSL.Break());

      const projected = TSL.cameraProjectionMatrix.mul(TSL.vec4(rayPoint, 1));
      TSL.If(projected.w.lessThanEqual(0.0001), () => TSL.Break());
      const sampleUV = TSL.getScreenPositionFromClip(projected);
      const outside = sampleUV.x.lessThan(0.002)
        .or(sampleUV.x.greaterThan(0.998))
        .or(sampleUV.y.lessThan(0.002))
        .or(sampleUV.y.greaterThan(0.998));
      TSL.If(outside, () => TSL.Break());

      const hitDepth = sceneDepth.sample(sampleUV).r;
      const hitViewDepth = TSL.projectionDepth(hitDepth, TSL.cameraNear, TSL.cameraFar);
      const hitPoint = TSL.getViewPosition(sampleUV, hitViewDepth, TSL.cameraProjectionMatrixInverse);
      const separation = hitPoint.z.sub(rayPoint.z);
      const nearIntersection = TSL.float(1).sub(
        TSL.smoothstep(thickness.mul(0.35), thickness, separation.abs())
      );
      const foreground = TSL.step(depthBias, separation).mul(
        TSL.float(1).sub(TSL.smoothstep(depthBias, depthBias.add(thickness.mul(2)), separation))
      );
      const hitValid = TSL.isBackgroundDepth(hitDepth).select(0, 1);
      const candidate = TSL.max(nearIntersection, foreground.mul(0.72)).mul(hitValid);
      occlusion.assign(TSL.max(occlusion, candidate));
      TSL.If(occlusion.greaterThan(0.94), () => TSL.Break());
    });

    const shadow = TSL.clamp(occlusion.mul(intensity).mul(distanceFade), 0, 0.78);
    const visible = TSL.isBackgroundDepth(depth).select(1, TSL.float(1).sub(shadow));
    return TSL.vec4(source.rgb.mul(visible), source.a);
  })();

  return Object.freeze({
    node,
    set(next) {
      if (!next) {
        intensity.value = 0;
        return;
      }
      intensity.value = next.intensity;
      maxDistance.value = next.maxDistance;
      thickness.value = next.thickness;
      depthBias.value = next.depthBias;
      steps.value = next.steps;
      fadeStart.value = next.fadeStart;
      fadeEnd.value = Math.max(next.fadeStart + 1, next.fadeEnd);
      lightDirectionWorld.value.set(...next.lightDirectionWorld);
    },
    getState() {
      return Object.freeze({
        intensity: intensity.value,
        maxDistance: maxDistance.value,
        thickness: thickness.value,
        depthBias: depthBias.value,
        steps: steps.value,
        fadeStart: fadeStart.value,
        fadeEnd: fadeEnd.value,
        lightDirectionWorld: Object.freeze([
          lightDirectionWorld.value.x, lightDirectionWorld.value.y, lightDirectionWorld.value.z
        ])
      });
    }
  });
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
  let contactShadowsSettings = normalizeContactShadows(options.contactShadows);
  let contactShadowsHandle = null;
  let volumetricFogSettings = normalizeVolumetricFog(options.volumetricFog);
  let volumetricFogHandle = null;
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

    if (volumetricFogSettings) {
      volumetricFogHandle = createVolumetricFogNode(output, sceneDepth, volumetricFogSettings);
      output = volumetricFogHandle.node;
    } else {
      volumetricFogHandle = null;
    }

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
      ssrPass = ssr(output, sceneDepth, sceneNormal, {
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

    if (contactShadowsSettings) {
      contactShadowsHandle = createContactShadowsNode(output, sceneDepth, contactShadowsSettings);
      output = contactShadowsHandle.node;
    } else {
      contactShadowsHandle = null;
    }

    if (bloomSettings && bloomSettings.strength > 0) {
      const glow = bloom(output, bloomSettings.strength, bloomSettings.radius, bloomSettings.threshold);
      output = output.add(glow);
    }

    if (godRaysSettings) {
      godRaysHandle = createGodRaysNode(output, godRaysSettings);
      output = godRaysHandle.node;
    } else {
      godRaysHandle = null;
    }

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
        rebuildOutput();
        return true;
      }
      if (!godRaysHandle) rebuildOutput();
      else godRaysHandle.set(godRaysSettings);
      return true;
    },
    setContactShadows(nextOptions) {
      if (disposed) return false;
      const nextSettings = normalizeContactShadows(nextOptions);
      if (!nextSettings && !contactShadowsSettings && !contactShadowsHandle) return true;
      contactShadowsSettings = nextSettings;
      if (!contactShadowsSettings) {
        rebuildOutput();
        return true;
      }
      if (!contactShadowsHandle) rebuildOutput();
      else contactShadowsHandle.set(contactShadowsSettings);
      return true;
    },
    setVolumetricFog(nextOptions) {
      if (disposed) return false;
      const nextSettings = normalizeVolumetricFog(nextOptions);
      if (!nextSettings && !volumetricFogSettings && !volumetricFogHandle) return true;
      volumetricFogSettings = nextSettings;
      if (!volumetricFogSettings) {
        rebuildOutput();
        return true;
      }
      if (!volumetricFogHandle) rebuildOutput();
      else volumetricFogHandle.set(volumetricFogSettings);
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
        contactShadows: contactShadowsHandle ? contactShadowsHandle.getState() : null,
        volumetricFog: volumetricFogHandle ? volumetricFogHandle.getState() : null,
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
