import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { attachPStudioTSLSHProbeToMaterial } from './pstudio_rendering_gi_tsl.mjs?v=20261126-tsl-sh-gi-v1';

const SUPPORTED_FEATURES = new Set(['terrain', 'triplanar', 'parallax', 'foliage', 'water', 'water-detail', 'sh-gi', 'clustered-lighting']);
const EPSILON = 1e-5;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function recordValue(record, key, fallback) {
  const value = record?.[key];
  return finite(value && typeof value === 'object' && 'value' in value ? value.value : value, fallback);
}

function readFeatureList(material) {
  const list = material?.userData?.pstudioTSLFeatures;
  return Array.isArray(list) ? [...new Set(list.map(String))] : [];
}

/**
 * Only FX hooks emitted by PStudio's explicitly versioned legacy adapters may
 * be stripped during NodeMaterial conversion. Arbitrary user GLSL stays blocked.
 */
export function isPStudioTSLSurfaceFeatureMaterial(material) {
  const data = material?.userData || {};
  const features = readFeatureList(material);
  const approvedHookMatches = typeof material?.onBeforeCompile === 'function'
    && material.pstudioTSLPortApprovedCompileHook === material.onBeforeCompile
    && material.pstudioTSLPortApprovedCacheKey === material.customProgramCacheKey;
  const convertedSurfaceCertificate = material?.isNodeMaterial === true
    && material.pstudioTSLSurfacePreflightApproved === true;
  const knownCSMHook = data.pstudioCSMOnlyHook === true
    && data.pstudioProbeShaderSetup !== true
    && data.pstudioCSMHook === material?.onBeforeCompile
    && material.pstudioTSLPortApprovedCacheKey === material.customProgramCacheKey;
  return data.pstudioTSLPortVersion === 1
    && data.pstudioTSLPortHasForeignHook !== true
    && (approvedHookMatches || knownCSMHook || convertedSurfaceCertificate)
    && features.length > 0
    && features.every((feature) => SUPPORTED_FEATURES.has(feature));
}

function requiredNodeFunctions() {
  const names = [
    'color', 'texture', 'uv', 'vec3', 'vec4', 'float', 'mix', 'smoothstep',
    'positionWorld', 'positionLocal', 'normalWorld', 'normalWorldGeometry',
    'positionView', 'positionViewDirection', 'modelWorldMatrixInverse',
    'materialColor', 'materialRoughness', 'materialMetalness', 'materialEmissive',
    'materialOpacity', 'materialAlphaTest', 'time', 'vertexColor', 'select', 'bool', 'cameraViewMatrix'
  ];
  return names.filter((name) => TSL[name] === undefined);
}

function makeTriplanarWeights(normal, sharpness) {
  const weightsRaw = normal.abs().normalize().pow(TSL.vec3(sharpness));
  const weightSum = weightsRaw.x.add(weightsRaw.y).add(weightsRaw.z).max(EPSILON);
  return weightsRaw.div(weightSum);
}

function makeTriplanarSample(texture, position, scale, weights) {
  const sampleX = TSL.texture(texture, position.yz.mul(scale)).setUpdateMatrix(true).mul(weights.x);
  const sampleY = TSL.texture(texture, position.zx.mul(scale)).setUpdateMatrix(true).mul(weights.y);
  const sampleZ = TSL.texture(texture, position.xy.mul(scale)).setUpdateMatrix(true).mul(weights.z);
  return sampleX.add(sampleY).add(sampleZ);
}

function applyTriplanar(material, metadata) {
  if (!material.map?.isTexture) {
    throw new Error('TSL triplanar material requires a valid base-color texture.');
  }

  const settings = metadata.pstudioTriplanarHQ || {};
  const scale = Math.max(0.0001, Math.min(2, recordValue(settings, 'scale', 0.082)));
  const sharpness = Math.max(1, Math.min(12, recordValue(settings, 'sharpness', 4)));
  const position = TSL.positionWorld;
  const normal = TSL.normalWorldGeometry.normalize();
  const weights = makeTriplanarWeights(normal, sharpness);
  const albedo = makeTriplanarSample(material.map, position, scale, weights).rgb;
  let colorNode = TSL.color(material.color).mul(albedo);

  if (material.vertexColors === true) {
    colorNode = colorNode.mul(TSL.vertexColor);
  }
  material.colorNode = colorNode;

  if (material.roughnessMap?.isTexture) {
    material.roughnessNode = TSL.float(material.roughness)
      .mul(makeTriplanarSample(material.roughnessMap, position, scale, weights).g)
      .clamp(0.045, 1);
  }
  if (material.metalnessMap?.isTexture) {
    material.metalnessNode = TSL.float(material.metalness)
      .mul(makeTriplanarSample(material.metalnessMap, position, scale, weights).b)
      .clamp(0, 1);
  }

  if (material.normalMap?.isTexture && material.normalMapType === THREE.TangentSpaceNormalMap) {
    const normalScale = material.normalScale || { x: 1, y: 1 };
    const readNormal = (coordinates) => {
      const sample = TSL.texture(material.normalMap, coordinates).setUpdateMatrix(true).xyz.mul(2).sub(1);
      return TSL.vec3(
        sample.x.mul(finite(normalScale.x, 1)),
        sample.y.mul(finite(normalScale.y, 1)),
        sample.z
      );
    };
    const normalX = readNormal(position.yz.mul(scale));
    const normalY = readNormal(position.zx.mul(scale));
    const normalZ = readNormal(position.xy.mul(scale));
    // Each projection uses a right-handed tangent frame:
    // X -> (Y, Z), Y -> (Z, X), Z -> (X, Y). Flip the bitangent
    // component together with the face normal on negative-facing planes.
    const signX = normal.x.sign();
    const signY = normal.y.sign();
    const signZ = normal.z.sign();
    const worldX = TSL.vec3(signX.mul(normalX.z), normalX.x, signX.mul(normalX.y));
    const worldY = TSL.vec3(signY.mul(normalY.y), signY.mul(normalY.z), normalY.x);
    const worldZ = TSL.vec3(normalZ.x, signZ.mul(normalZ.y), signZ.mul(normalZ.z));
    const blendedWorldNormal = worldX.mul(weights.x)
      .add(worldY.mul(weights.y))
      .add(worldZ.mul(weights.z))
      .normalize();
    material.normalNode = blendedWorldNormal
      .transformNormalByViewMatrix(TSL.cameraViewMatrix)
      .normalize();
  }
}

function applyParallax(material) {
  if (!material.map?.isTexture || !material.normalMap?.isTexture) {
    throw new Error('TSL parallax requires both base-color and alpha-height textures.');
  }

  const settings = material.userData?.pstudioParallaxHQ || {};
  const scale = Math.max(0, Math.min(0.035, finite(settings.scale, 0.012)));
  const uv = TSL.uv(material.map.channel || 0);
  const normalUV = TSL.uv(material.normalMap.channel || 0);
  const viewPosition = TSL.positionView;
  const normal = TSL.normalView.normalize();

  // Reconstruct a tangent frame from screen-space derivatives. This keeps
  // parallax direction stable on rotated UV islands without requiring a
  // tangent attribute on every legacy asset.
  const dpdx = viewPosition.dFdx();
  const dpdy = viewPosition.dFdy();
  const duvdx = uv.dFdx();
  const duvdy = uv.dFdy();
  const tangentRaw = dpdy.cross(normal).mul(duvdx.x)
    .add(normal.cross(dpdx).mul(duvdy.x));
  const bitangentRaw = dpdy.cross(normal).mul(duvdx.y)
    .add(normal.cross(dpdx).mul(duvdy.y));
  const inverseScale = TSL.float(1).div(
    tangentRaw.dot(tangentRaw).max(bitangentRaw.dot(bitangentRaw)).max(EPSILON).sqrt()
  );
  const tangent = tangentRaw.mul(inverseScale);
  const bitangent = bitangentRaw.mul(inverseScale);
  const viewDirection = TSL.positionViewDirection;
  const viewTangent = TSL.vec3(
    viewDirection.dot(tangent),
    viewDirection.dot(bitangent),
    viewDirection.dot(normal)
  ).normalize();
  const rayOffset = viewTangent.xy
    .div(viewTangent.z.abs().max(0.18))
    .mul(scale);

  // Eight fixed, unrolled taps provide deterministic POM behavior without a
  // divergent GPU loop. First-hit selection prevents later layers from
  // overwriting the shallowest intersection.
  let parallaxUV = uv;
  let foundIntersection = TSL.bool(false);
  for (let step = 1; step <= 8; step += 1) {
    const layerDepth = step / 8;
    const candidateUV = uv.sub(rayOffset.mul(layerDepth));
    const heightUV = normalUV.add(candidateUV.sub(uv));
    const height = TSL.float(1).sub(TSL.texture(material.normalMap, heightUV).setUpdateMatrix(true).a);
    const crossed = TSL.float(layerDepth).greaterThanEqual(height);
    const firstHit = crossed.and(foundIntersection.not());
    parallaxUV = TSL.select(firstHit, candidateUV, parallaxUV);
    foundIntersection = foundIntersection.or(crossed);
  }

  const sampledColor = TSL.texture(material.map, parallaxUV).setUpdateMatrix(true);
  let colorNode = TSL.color(material.color).mul(sampledColor.rgb);
  if (material.vertexColors === true) colorNode = colorNode.mul(TSL.vertexColor);
  material.colorNode = colorNode;
  if (material.alphaTest > 0 || material.transparent === true || material.alphaHash === true) {
    material.opacityNode = (material.opacityNode || TSL.materialOpacity).mul(sampledColor.a);
    material.alphaTestNode = material.alphaTestNode || TSL.materialAlphaTest;
  }
}

function applyTerrain(material, metadata) {
  const settings = metadata.pstudioTerrainHQ || {};
  const heightMin = recordValue(settings, 'heightMin', 0);
  const heightRange = Math.max(0.001, recordValue(settings, 'heightRange', 1));
  const detailScale = Math.max(0.005, Math.min(2, recordValue(settings, 'detailScale', 0.16)));
  const snowLine = Math.max(0, Math.min(1.5, recordValue(settings, 'snowLine', 1.08)));
  const wetness = Math.max(0, Math.min(0.8, recordValue(settings, 'wetness', 0.035)));
  const rockThreshold = Math.max(0.08, Math.min(0.92, recordValue(settings, 'rockThreshold', 0.38)));

  const position = TSL.positionWorld;
  const normal = TSL.normalWorldGeometry.normalize();
  const elevation = position.y.sub(heightMin).div(heightRange).clamp(0, 1);
  const slope = TSL.float(1).sub(normal.y.abs().clamp(0, 1));
  // Two incommensurate world-space waves avoid the obvious grid repetition of
  // a single sine while keeping the terrain classification inexpensive.
  const noise = TSL.float(0.5).add(
    position.x.mul(detailScale).sin()
      .mul(position.z.mul(detailScale * 0.73).add(position.x.mul(detailScale * 0.31)).sin())
      .mul(0.25)
  );
  const rock = TSL.smoothstep(
    rockThreshold,
    rockThreshold + 0.28,
    slope.add(noise.sub(0.5).mul(0.16))
  );
  const grass = TSL.float(1).sub(rock)
    .mul(TSL.float(1).sub(TSL.smoothstep(0.46, 0.9, elevation)))
    .mul(noise.mul(0.28).add(0.72));
  const soil = TSL.float(1).sub(rock)
    .mul(TSL.float(1).sub(TSL.smoothstep(0.12, 0.78, elevation)))
    .mul(noise.mul(0.28).add(0.16));
  const snow = TSL.smoothstep(snowLine, snowLine + 0.12, elevation)
    .mul(TSL.float(1).sub(TSL.smoothstep(0.12, 0.62, slope)));

  let tint = TSL.vec3(1);
  tint = TSL.mix(tint, TSL.vec3(0.78, 1.055, 0.76), grass.mul(0.42));
  tint = TSL.mix(tint, TSL.vec3(1.08, 0.88, 0.70), soil.mul(0.34));
  tint = TSL.mix(tint, TSL.vec3(0.72, 0.76, 0.81), rock.mul(0.48));
  tint = TSL.mix(
    tint,
    TSL.mix(TSL.vec3(0.78, 0.84, 0.91), TSL.vec3(0.98, 0.99, 1), noise),
    snow
  );
  tint = tint.mul(TSL.float(1).sub(wetness * (0.06 + 0.08 * noise)));

  const baseColor = material.colorNode || TSL.materialColor;
  material.colorNode = baseColor.mul(tint);
  if (material.isMeshStandardNodeMaterial || material.isMeshPhysicalNodeMaterial) {
    const baseRoughness = material.roughnessNode || TSL.materialRoughness;
    material.roughnessNode = baseRoughness
      .add(rock.mul(0.12))
      .sub(wetness * (0.05 + 0.12 * noise))
      .clamp(0.12, 1);
  }
}

function applyWaterDetail(material, metadata) {
  const settings = metadata.pstudioWaterDetailTSLSettings || {};
  const role = String(settings.role || 'micro-ripple');
  const type = Math.max(0, Math.min(2, finite(settings.type, role === 'spray-particles' ? 2 : role === 'shoreline-foam' ? 1 : 0)));
  const strength = Math.max(0, Math.min(1, finite(settings.strength, 0.72)));
  const local = TSL.positionLocal;
  const world = TSL.positionWorld;
  const time = TSL.time;

  const waveA = local.x.mul(1.7).add(local.z.mul(1.13)).add(time.mul(1.7)).sin();
  const waveB = local.x.mul(0.71).sub(local.z.mul(1.91)).sub(time.mul(1.13)).sin();
  const move = TSL.mix(TSL.float(0.009), TSL.float(0.002), TSL.float(type));
  const deformed = (material.positionNode || local).add(
    TSL.vec3(0, move.mul(waveA.mul(0.65).add(waveB.mul(0.35))), 0)
  );
  material.positionNode = deformed;
  material.castShadowPositionNode = deformed;

  const phase = world.x.mul(0.47).add(world.z.mul(0.39))
    .add(time.mul(1.1 + type * 0.35));
  const glint = TSL.max(TSL.float(0), phase.sin().mul(0.5).add(0.5))
    .pow(type < 0.5 ? 8 : 4);
  const pulse = TSL.float(0.82).add(
    TSL.float(0.18).mul(TSL.float(0.5).add(TSL.float(0.5).mul(phase.mul(1.37).sin())))
  );
  const opacityPattern = type > 0.5
    ? TSL.mix(pulse, TSL.float(0.72).add(glint.mul(0.28)), 1)
    : pulse;

  const baseColor = material.colorNode || TSL.materialColor;
  material.colorNode = baseColor.add(
    TSL.vec3(0.035, 0.105, 0.12).mul(glint.mul(strength))
  );
  material.opacityNode = (material.opacityNode || TSL.materialOpacity).mul(opacityPattern);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
}

function resolveSunDirection(profile = {}) {
  const x = finite(profile.skySunX ?? profile.sunDirection?.[0], 0.35);
  const y = finite(profile.skySunY ?? profile.sunDirection?.[1], 0.89);
  const z = finite(profile.skySunZ ?? profile.sunDirection?.[2], 0.28);
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < EPSILON) return [0.35, 0.89, 0.28];
  return [x / length, y / length, z / length];
}

function applyFoliage(material, metadata, options) {
  const settings = metadata.pstudioFoliageHQ || {};
  const height = Math.max(0.1, recordValue(settings, 'height', 10));
  const base = recordValue(settings, 'base', 0);
  const strength = Math.max(0, Math.min(2.5, recordValue(settings, 'strength', 0.34)));
  const speed = Math.max(0, Math.min(4, recordValue(settings, 'speed', 1)));
  const role = String(settings.role || 'foliage');
  const directionSource = settings.direction || {};
  const dx = finite(directionSource.x, 0.83);
  const dz = finite(directionSource.y, 0.56);
  const directionLength = Math.max(EPSILON, Math.hypot(dx, dz));
  const windX = dx / directionLength;
  const windZ = dz / directionLength;

  const localPosition = TSL.positionLocal;
  const worldPosition = TSL.positionWorld;
  const height01 = localPosition.y.sub(base).div(height).clamp(0, 1);
  const bend = height01.pow(1.42);
  const worldPhase = worldPosition.x.mul(windX).add(worldPosition.z.mul(windZ));
  const broadGust = TSL.time.mul(speed * 0.78).add(worldPhase.mul(0.047)).sin();
  const secondaryGust = TSL.time.mul(speed * 1.31)
    .add(worldPhase.mul(0.113))
    .add(localPosition.y.mul(0.39)).sin();
  const leafFlutter = TSL.time.mul(speed * 3.25)
    .add(worldPhase.mul(0.31))
    .add(localPosition.y.mul(1.7))
    .add(localPosition.x.mul(1.1)).sin();
  const sway = broadGust.mul(0.23)
    .add(secondaryGust.mul(0.052))
    .add(leafFlutter.mul(0.014))
    .mul(bend)
    .mul(strength);

  // Convert world-space wind displacement back to object-local space. This
  // keeps the gust direction consistent for rotated/scaled meshes and instances.
  const worldDelta = TSL.vec4(
    sway.mul(windX),
    leafFlutter.mul(0.006).mul(bend).mul(strength),
    sway.mul(windZ),
    0
  );
  const localDelta = TSL.modelWorldMatrixInverse.mul(worldDelta).xyz;
  const deformedPosition = (material.positionNode || localPosition).add(localDelta);
  material.positionNode = deformedPosition;
  // Keep wind deformation consistent in shadow-map passes as well as beauty.
  material.castShadowPositionNode = deformedPosition;

  const translucency = Math.max(0, Math.min(1, recordValue(settings, 'translucency', 0)));
  if (translucency > 0 && (material.isMeshStandardNodeMaterial || material.isMeshPhysicalNodeMaterial)) {
    const thickness = Math.max(0.05, Math.min(1.5, recordValue(settings, 'thickness', 0.52)));
    const power = Math.max(1, Math.min(12, recordValue(settings, 'scatteringPower', 3.2)));
    const tintValue = settings.translucencyColor || '#d9edaa';
    const sun = resolveSunDirection(options.environmentProfile || {});
    const sunDirection = TSL.vec3(...sun).normalize();
    const backLighting = TSL.normalWorld.negate().dot(sunDirection).max(0).pow(power);
    const transmission = backLighting.mul(translucency * thickness);
    const scatteringColor = TSL.color(new THREE.Color(tintValue)).mul(transmission);
    material.emissiveNode = (material.emissiveNode || TSL.materialEmissive).add(scatteringColor);
  }
  material.side = THREE.DoubleSide;
  if (material.alphaMap || material.map) {
    // NodeMaterial continues to use the source map/alphaMap for cutout opacity.
    material.alphaTestNode = material.alphaTestNode || TSL.materialAlphaTest;
  }

  return role;
}

/**
 * Applies the approved terrain and foliage metadata to converted r187 NodeMaterials.
 * Unsupported shaders are rejected instead of silently dropping their visual effects.
 */
export function applyPStudioTSLSurfaceFeatures(root, options = {}) {
  if (!root?.traverse) throw new TypeError('A Three.js Object3D or Scene is required.');
  const missing = requiredNodeFunctions();
  if (missing.length > 0) {
    throw new Error('Three.js r187 is missing required TSL APIs: ' + missing.join(', '));
  }

  const applied = [];
  const materials = new Set();
  const sceneLights = [];
  root.traverse((object) => {
    if (object?.isLight && object.visible !== false) sceneLights.push(object);
    if (!(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite) || !object.material) return;
    const assigned = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of assigned) if (material) materials.add(material);
  });

  for (const material of materials) {
    const features = readFeatureList(material);
    if (features.length === 0) continue;
    if (!isPStudioTSLSurfaceFeatureMaterial(material)) {
      throw new Error('A surface material contains an unapproved legacy shader hook.');
    }
    if (material.isNodeMaterial !== true) {
      throw new TypeError('PStudio TSL surface features can only be attached after NodeMaterial conversion.');
    }
    const hasTriplanar = features.includes('triplanar');
    const hasParallax = features.includes('parallax');
    if (hasTriplanar && hasParallax) {
      throw new Error('PStudio does not combine triplanar projection and UV parallax on one material.');
    }

    const previous = Object.fromEntries([
      'colorNode', 'roughnessNode', 'metalnessNode', 'emissiveNode',
      'positionNode', 'castShadowPositionNode', 'alphaTestNode', 'opacityNode',
      'side', 'transparent', 'depthWrite', 'lightsNode'
    ].map((key) => [key, material[key]]));
    let foliageRole = null;
    let shHandle = null;
    try {
      if (hasTriplanar) applyTriplanar(material, material.userData);
      if (hasParallax) applyParallax(material);
      if (features.includes('terrain')) applyTerrain(material, material.userData);
      if (features.includes('foliage')) foliageRole = applyFoliage(material, material.userData, options);
      if (features.includes('water-detail')) applyWaterDetail(material, material.userData);
      if (features.includes('sh-gi')) shHandle = attachPStudioTSLSHProbeToMaterial(material, options.sceneLights || sceneLights);
      material.userData = {
        ...material.userData,
        pstudioTSLFeaturesApplied: features.slice(),
        pstudioTSLFoliageRole: foliageRole
      };
      material.needsUpdate = true;
      applied.push({ material, previous, shHandle });
    } catch (error) {
      try { shHandle?.dispose?.(); } catch (_) {}
      for (const [key, value] of Object.entries(previous)) material[key] = value;
      for (const entry of applied) {
        try { entry.shHandle?.dispose?.(); } catch (_) {}
        for (const [key, value] of Object.entries(entry.previous)) entry.material[key] = value;
        if (entry.material.userData) {
          delete entry.material.userData.pstudioTSLFeaturesApplied;
          delete entry.material.userData.pstudioTSLFoliageRole;
        }
        entry.material.needsUpdate = true;
      }
      throw new Error('PStudio rolled back all partial TSL surface material graphs.', { cause: error });
    }
  }

  let disposed = false;
  return Object.freeze({
    kind: 'pstudio-tsl-surface-feature-handle',
    materialCount: applied.length,
    features: Object.freeze([...new Set(applied.flatMap((entry) => readFeatureList(entry.material)))]),
    dispose() {
      if (disposed) return false;
      disposed = true;
      for (const entry of applied) {
        try { entry.shHandle?.dispose?.(); } catch (_) {}
        for (const [key, value] of Object.entries(entry.previous)) entry.material[key] = value;
        if (entry.material.userData) {
          delete entry.material.userData.pstudioTSLFeaturesApplied;
          delete entry.material.userData.pstudioTSLFoliageRole;
        }
        entry.material.needsUpdate = true;
      }
      return true;
    }
  });
}
