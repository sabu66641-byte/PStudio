import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

const WATER_FEATURE = 'water';
const MAX_WATER_REFLECTORS = 8;
const EPSILON = 1e-5;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function plainColor(value, fallback) {
  try {
    return new THREE.Color(value ?? fallback);
  } catch (_) {
    return new THREE.Color(fallback);
  }
}

function readSettings(material) {
  const settings = material?.userData?.pstudioWaterTSLSettings || {};
  const bounds = settings.bounds || {};
  return Object.freeze({
    waterfall: settings.waterfall === true,
    mirrorOnly: settings.mirrorOnly === true,
    waveStrength: Math.max(0, Math.min(1, finite(settings.waveStrength, 0.05))),
    amplitude: Math.max(0, Math.min(0.5, finite(settings.amplitude, 0.105))),
    minX: finite(bounds.minX, -50),
    minZ: finite(bounds.minZ, -50),
    width: Math.max(0.001, finite(bounds.width, 100)),
    depth: Math.max(0.001, finite(bounds.depth, 100)),
    shallow: plainColor(settings.shallow, '#65d9bf'),
    deep: plainColor(settings.deep, '#08727d'),
    foam: plainColor(settings.foam, '#e3fff6'),
    reflectivity: Math.max(0, Math.min(1, finite(settings.reflectivity, 0.92))),
    reflectionResolutionScale: Math.max(0.125, Math.min(0.75, finite(settings.reflectionResolutionScale, 0.5))),
    absorption: Math.max(0.001, Math.min(2, finite(settings.absorption, 0.19)))
  });
}

function requiredTSLFunctions() {
  const names = [
    'texture', 'screenUV', 'positionLocal', 'positionWorld', 'positionView',
    'positionViewDirection', 'normalWorldGeometry', 'cameraViewMatrix',
    'cameraNear', 'cameraFar', 'modelNormalMatrix', 'time', 'vec2', 'vec3',
    'float', 'color', 'mix', 'max', 'min', 'clamp', 'sin', 'cos', 'pow',
    'exp', 'smoothstep', 'reflector', 'perspectiveDepthToViewZ', 'uv', 'vertexColor'
  ];
  return names.filter((name) => TSL[name] === undefined);
}

function hasWaterFeature(material) {
  const features = material?.userData?.pstudioTSLFeatures;
  return material?.isNodeMaterial === true
    && Array.isArray(features)
    && features.includes(WATER_FEATURE)
    && material.pstudioTSLSurfacePreflightApproved === true;
}

function collectWaterMeshes(root) {
  const entries = [];
  root.traverse((object) => {
    if (!object?.isMesh || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const indices = [];
    for (let index = 0; index < materials.length; index += 1) {
      if (hasWaterFeature(materials[index])) indices.push(index);
    }
    if (indices.length) entries.push({ object, materials, indices });
  });
  return entries;
}

function buildWaterNodes(material, settings, depthTexture, object, reflectors) {
  const local = TSL.positionLocal;
  const world = TSL.positionWorld;
  const t = TSL.time;
  const x = local.x;
  const z = local.z;
  const amplitude = settings.amplitude;

  const waveA = x.mul(0.071).add(z.mul(0.043)).add(t.mul(0.92));
  const waveB = x.mul(0.137).sub(z.mul(0.091)).sub(t.mul(0.67));
  const waveC = x.mul(0.31).add(z.mul(0.22)).add(t.mul(1.43));
  const waveD = x.mul(0.49).sub(z.mul(0.37)).add(t.mul(2.07));
  const displacement = waveA.sin().mul(0.52)
    .add(waveB.sin().mul(0.27))
    .add(waveC.sin().mul(0.14))
    .add(waveD.sin().mul(0.07))
    .mul(amplitude);

  const slopeX = waveA.cos().mul(0.071 * 0.52)
    .add(waveB.cos().mul(0.137 * 0.27))
    .add(waveC.cos().mul(0.31 * 0.14))
    .add(waveD.cos().mul(0.49 * 0.07))
    .mul(amplitude);
  const slopeZ = waveA.cos().mul(0.043 * 0.52)
    .sub(waveB.cos().mul(0.091 * 0.27))
    .add(waveC.cos().mul(0.22 * 0.14))
    .sub(waveD.cos().mul(0.37 * 0.07))
    .mul(amplitude);

  const previousPosition = material.positionNode || TSL.positionLocal;
  material.positionNode = previousPosition.add(TSL.vec3(0, displacement, 0));

  const localNormal = TSL.vec3(slopeX.negate(), 1, slopeZ.negate()).normalize();
  const worldNormal = TSL.modelNormalMatrix.mul(localNormal).normalize();
  const viewNormal = worldNormal.transformNormalByViewMatrix(TSL.cameraViewMatrix).normalize();
  material.normalNode = viewNormal;

  const depthSample = TSL.texture(depthTexture, TSL.screenUV).r;
  const sceneViewZ = TSL.perspectiveDepthToViewZ(depthSample, TSL.cameraNear, TSL.cameraFar);
  const thickness = TSL.max(TSL.positionView.z.sub(sceneViewZ), 0).min(24);
  const absorbed = TSL.float(1).sub(TSL.exp(thickness.mul(-settings.absorption)));

  const localUV = TSL.vec2(
    x.sub(settings.minX).div(settings.width),
    z.sub(settings.minZ).div(settings.depth)
  );
  const edgeX = TSL.min(localUV.x, TSL.float(1).sub(localUV.x));
  const edgeZ = TSL.min(localUV.y, TSL.float(1).sub(localUV.y));
  const edge = TSL.clamp(TSL.min(edgeX, edgeZ), 0, 0.5);
  const edgeFoam = TSL.float(1).sub(TSL.smoothstep(0.018, 0.092, edge))
    .mul(TSL.float(0.55).add(TSL.float(0.45).mul(
      world.x.mul(0.46).add(world.z.mul(0.39)).add(t.mul(1.6)).sin()
    )));

  const foamNoise = TSL.float(0.5).add(TSL.float(0.5).mul(
    world.x.mul(0.61).add(world.z.mul(0.47)).add(t.mul(1.8)).sin()
      .mul(world.z.mul(0.83).sub(world.x.mul(0.39)).sub(t.mul(1.13)).sin())
  ));
  const shorelineFoam = TSL.float(1).sub(TSL.smoothstep(0.035, 0.95, thickness))
    .mul(TSL.float(0.52).add(foamNoise.mul(0.48)));
  let foam = TSL.max(edgeFoam.mul(0.22), shorelineFoam);
  const crest = TSL.float(0.5).add(TSL.float(0.5).mul(
    world.x.mul(0.31).add(world.z.mul(0.27)).add(t.mul(1.22)).sin()
  ));
  foam = TSL.max(foam, TSL.smoothstep(0.91, 0.995, crest).mul(0.11));

  const variation = TSL.float(0.5).add(TSL.float(0.5).mul(
    world.x.mul(0.043).add(world.z.mul(0.037).sin().mul(1.8)).sin()
  ));
  let baseColor = TSL.mix(
    TSL.color(settings.shallow),
    TSL.color(settings.deep),
    TSL.clamp(absorbed.mul(0.88).add(variation.mul(0.12)), 0, 1)
  );

  if (material.map?.isTexture) {
    const mapUV = TSL.uv(material.map.channel || 0);
    const mapColor = TSL.texture(material.map, mapUV).setUpdateMatrix(true).rgb;
    baseColor = TSL.mix(
      TSL.color(material.color).mul(mapColor),
      baseColor,
      0.68
    );
  } else {
    baseColor = TSL.mix(TSL.color(material.color), baseColor, 0.68);
  }
  if (material.vertexColors === true) baseColor = baseColor.mul(TSL.vertexColor);

  if (settings.waterfall) {
    const flow = TSL.float(0.5).add(TSL.float(0.5).mul(
      TSL.uv(0).y.mul(110).sub(t.mul(3.5)).add(TSL.uv(0).x.mul(24).sin().mul(2.2)).sin()
    ));
    baseColor = TSL.mix(baseColor, TSL.vec3(0.58, 0.88, 0.91), TSL.smoothstep(0.74, 0.98, flow).mul(0.45));
  }

  const reflectorNode = TSL.reflector({
    resolutionScale: settings.reflectionResolutionScale,
    bounces: false,
    depth: true
  });
  object.add(reflectorNode.target);
  reflectors.push({ object, node: reflectorNode });

  if (settings.mirrorOnly) {
    const reflectorUV = reflectorNode.uvNode;
    const ripple = TSL.vec2(
      reflectorUV.y.mul(190).add(t.mul(0.65)).sin(),
      reflectorUV.x.mul(170).sub(t.mul(0.52)).cos()
    ).mul(0.008 * settings.waveStrength);
    reflectorNode.uvNode = reflectorUV.add(ripple);
    material.colorNode = TSL.mix(
      TSL.color(material.color),
      reflectorNode.rgb,
      settings.reflectivity
    );
    material.roughnessNode = TSL.float(0.012);
    material.metalnessNode = TSL.float(0);
    material.side = THREE.DoubleSide;
    material.transparent = false;
    material.depthWrite = true;
    material.needsUpdate = true;
    return;
  }

  const facing = TSL.max(viewNormal.dot(TSL.positionViewDirection), 0);
  const fresnel = TSL.float(0.02).add(
    TSL.float(0.98).mul(TSL.pow(TSL.float(1).sub(facing), 5))
  ).mul(settings.reflectivity);
  const reflected = TSL.mix(baseColor, reflectorNode.rgb, fresnel);
  material.colorNode = TSL.mix(reflected, TSL.color(settings.foam), TSL.clamp(foam.mul(0.62), 0, 0.62));
  material.roughnessNode = TSL.float(0.075).add(
    TSL.float(0.035).mul(TSL.float(0.5).add(
      world.x.mul(2).add(world.z.mul(1.7)).add(t).sin().mul(0.5)
    ))
  ).clamp(0.035, 0.34);
  material.metalnessNode = TSL.float(0.015);
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.needsUpdate = true;
}

/**
 * Creates the WebGPU opaque-scene depth prepass used by TSL water thickness.
 * All scene/material state is restored, even when the render throws.
 */
export function createPStudioTSLWaterDepthPrepass(renderer, scene, camera) {
  if (!renderer || !scene?.isScene || !camera?.isCamera) {
    throw new TypeError('PStudio TSL water prepass requires a renderer, Scene and Camera.');
  }
  if (typeof THREE.MeshBasicNodeMaterial !== 'function' || typeof THREE.RenderTarget !== 'function' || typeof THREE.DepthTexture !== 'function') {
    throw new Error('Three.js r187 WebGPU depth-prepass primitives are unavailable.');
  }

  const depthMaterial = new THREE.MeshBasicNodeMaterial();
  depthMaterial.colorWrite = false;
  depthMaterial.depthWrite = true;
  depthMaterial.depthTest = true;
  depthMaterial.side = THREE.DoubleSide;
  depthMaterial.toneMapped = false;

  const target = new THREE.RenderTarget(1, 1, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false
  });
  target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  target.depthTexture.format = THREE.DepthFormat;
  target.depthTexture.minFilter = THREE.NearestFilter;
  target.depthTexture.magFilter = THREE.NearestFilter;

  let disposed = false;
  let preparing = false;
  let preparedFrames = 0;
  let lastError = null;

  function collectHiddenObjects() {
    const hidden = [];
    scene.traverse((object) => {
      if (!object?.isMesh || object.visible !== true) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const name = String(object.name || '');
      const transparent = materials.some((material) => material && (
        material.transparent === true
        || (Number.isFinite(material.opacity) && material.opacity < 0.999)
        || !!material.alphaMap
        || finite(material.alphaTest, 0) > 0.001
        || material.alphaHash === true
      ));
      const omit = object.userData?.pstudioWaterSurface === true
        || object.userData?.pstudioWindPart === true
        || object.userData?.pstudioFoliageLOD !== undefined
        || transparent
        || /(?:sky|cloud|tree|foliage|grass|wildflower|atmosphere[_ -]?dome|PStudio_Foliage_GPU|PStudio_GPU_Instances_Foliage)/i.test(name);
      if (omit) {
        hidden.push({ object, visible: object.visible });
        object.visible = false;
      }
    });
    return hidden;
  }

  function captureDepthState() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(1, Math.floor(size.x || 1));
    const height = Math.max(1, Math.floor(size.y || 1));
    if (target.width !== width || target.height !== height) target.setSize(width, height);

    const hidden = collectHiddenObjects();
    const previousTarget = renderer.getRenderTarget?.() ?? null;
    const previousMRT = renderer.getMRT?.() ?? null;
    const previousOverride = scene.overrideMaterial;
    const previousAutoClear = renderer.autoClear;
    const previousShadowAutoUpdate = renderer.shadowMap?.autoUpdate;
    const previousXrEnabled = renderer.xr?.enabled;
    let restored = false;

    const restore = () => {
      if (restored) return false;
      restored = true;
      scene.overrideMaterial = previousOverride;
      for (const entry of hidden) {
        try { entry.object.visible = entry.visible; } catch (_) {}
      }
      try { renderer.setMRT?.(previousMRT); } catch (_) {}
      try { renderer.setRenderTarget(previousTarget); } catch (_) {}
      try { renderer.autoClear = previousAutoClear; } catch (_) {}
      if (renderer.shadowMap && previousShadowAutoUpdate !== undefined) {
        try { renderer.shadowMap.autoUpdate = previousShadowAutoUpdate; } catch (_) {}
      }
      if (renderer.xr && previousXrEnabled !== undefined) {
        try { renderer.xr.enabled = previousXrEnabled; } catch (_) {}
      }
      return true;
    };

    try {
      scene.overrideMaterial = depthMaterial;
      if (renderer.shadowMap) renderer.shadowMap.autoUpdate = false;
      if (renderer.xr) renderer.xr.enabled = false;
      renderer.setMRT?.(null);
      renderer.setRenderTarget(target);
      renderer.autoClear = true;
      renderer.clear?.(true, true, true);
    } catch (error) {
      restore();
      throw error;
    }

    return Object.freeze({ width, height, restore });
  }

  function withDepthState(callback) {
    const state = captureDepthState();
    try {
      return callback(state.width, state.height);
    } finally {
      state.restore();
    }
  }

  async function withDepthStateAsync(callback) {
    const state = captureDepthState();
    try {
      return await callback(state.width, state.height);
    } finally {
      state.restore();
    }
  }

  return Object.freeze({
    kind: 'pstudio-tsl-water-depth-prepass',
    depthTexture: target.depthTexture,
    async compile() {
      if (disposed) throw new Error('PStudio water prepass has been disposed.');
      await withDepthStateAsync(() => renderer.compileAsync(scene, camera));
      return true;
    },
    prepareFrame() {
      if (disposed) return false;
      if (preparing) throw new Error('Reentrant PStudio water depth prepass was rejected.');
      preparing = true;
      try {
        withDepthState(() => renderer.render(scene, camera));
        preparedFrames += 1;
        lastError = null;
        return true;
      } catch (error) {
        lastError = error;
        throw new Error('PStudio TSL water depth prepass failed; WebGL2 fallback is required.', { cause: error });
      } finally {
        preparing = false;
      }
    },
    getState() {
      return Object.freeze({ disposed, preparing, preparedFrames, lastError: lastError ? String(lastError.message || lastError) : null, width: target.width, height: target.height });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      try { target.dispose(); } catch (_) {}
      try { depthMaterial.dispose(); } catch (_) {}
      return true;
    }
  });
}

/**
 * Per-mesh TSL water adapters. Materials are cloned per water mesh so each
 * ReflectorNode owns exactly one planar target and can be disposed safely.
 */
export function applyPStudioTSLWaterSurfaces(root, options = {}) {
  if (!root?.traverse) throw new TypeError('A Three.js Object3D or Scene is required.');
  const depthTexture = options.depthTexture;
  if (!depthTexture?.isDepthTexture) throw new TypeError('A WebGPU water depth texture is required.');

  const missing = requiredTSLFunctions();
  if (missing.length) throw new Error('Three.js r187 is missing TSL water APIs: ' + missing.join(', '));
  const entries = collectWaterMeshes(root);
  const reflectorCountRequested = entries.reduce((sum, entry) => sum + entry.indices.length, 0);
  if (reflectorCountRequested > MAX_WATER_REFLECTORS) {
    throw new Error('The current scene exceeds the safe TSL planar water reflector limit.');
  }

  const assignments = [];
  const reflectors = [];
  const touchedMaterials = new Set();
  let disposed = false;

  try {
    for (const entry of entries) {
      const originalMaterial = entry.object.material;
      const nextMaterials = entry.materials.slice();
      for (const index of entry.indices) {
        const source = entry.materials[index];
        const clone = source.clone();
        clone.userData = { ...(source.userData || {}) };
        clone.pstudioTSLSurfacePreflightApproved = true;
        touchedMaterials.add(clone);
        const settings = readSettings(source);
        buildWaterNodes(clone, settings, depthTexture, entry.object, reflectors);
        nextMaterials[index] = clone;
      }
      entry.object.material = Array.isArray(originalMaterial) ? nextMaterials : nextMaterials[0];
      const previousActive = entry.object.userData?.pstudioWaterTSLActive;
      entry.object.userData ||= {};
      entry.object.userData.pstudioWaterTSLActive = true;
      assignments.push({ object: entry.object, originalMaterial, assignedMaterial: entry.object.material, previousActive });
    }
  } catch (error) {
    for (const entry of assignments.reverse()) {
      entry.object.material = entry.originalMaterial;
      if (entry.previousActive === undefined) delete entry.object.userData.pstudioWaterTSLActive;
      else entry.object.userData.pstudioWaterTSLActive = entry.previousActive;
    }
    for (const reflector of reflectors) {
      try { reflector.object.remove(reflector.node.target); } catch (_) {}
      try { reflector.node.dispose?.(); } catch (_) {}
    }
    for (const material of touchedMaterials) {
      try { material.dispose(); } catch (_) {}
    }
    throw new Error('PStudio failed to construct the TSL water graph; all water materials were restored.', { cause: error });
  }

  return Object.freeze({
    kind: 'pstudio-tsl-water-surfaces',
    waterMeshes: entries.length,
    reflectorCount: reflectors.length,
    depthTexture,
    getState() {
      return Object.freeze({ disposed, waterMeshes: entries.length, reflectorCount: reflectors.length });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      for (const entry of assignments) {
        if (entry.object.material === entry.assignedMaterial) entry.object.material = entry.originalMaterial;
        if (entry.previousActive === undefined) delete entry.object.userData.pstudioWaterTSLActive;
    else entry.object.userData.pstudioWaterTSLActive = entry.previousActive;
      }
      for (const reflector of reflectors) {
        try { reflector.object.remove(reflector.node.target); } catch (_) {}
        try { reflector.node.dispose?.(); } catch (_) {}
      }
      for (const material of touchedMaterials) {
        try { material.dispose(); } catch (_) {}
      }
      return true;
    }
  });
}
