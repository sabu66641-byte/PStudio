import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

const SUPPORTED_FEATURES = new Set(['terrain', 'triplanar', 'parallax', 'foliage']);
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
  return data.pstudioTSLPortVersion === 1
    && data.pstudioTSLPortHasForeignHook !== true
    && features.length > 0
    && features.every((feature) => SUPPORTED_FEATURES.has(feature));
}

function requiredNodeFunctions() {
  const names = [
    'color', 'texture', 'uv', 'vec3', 'vec4', 'float', 'mix', 'smoothstep',
    'positionWorld', 'positionLocal', 'normalWorld', 'normalWorldGeometry',
    'positionView', 'positionViewDirection', 'modelWorldMatrixInverse',
    'materialColor', 'materialRoughness', 'materialMetalness', 'materialEmissive',
    'materialOpacity', 'time', 'vertexColor'
  ];
  return names.filter((name) => TSL[name] === undefined);
}

function makeTriplanarSample(texture, position, normal, scale, sharpness) {
  const weightsRaw = normal.abs().normalize().pow(TSL.vec3(sharpness));
  const weightSum = weightsRaw.x.add(weightsRaw.y).add(weightsRaw.z).max(EPSILON);
  const weights = weightsRaw.div(weightSum);
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
  const albedo = makeTriplanarSample(material.map, position, normal, scale, sharpness).rgb;
  let colorNode = TSL.color(material.color).mul(albedo);

  if (material.vertexColors === true) {
    colorNode = colorNode.mul(TSL.vertexColor);
  }
  material.colorNode = colorNode;

  if (material.roughnessMap?.isTexture) {
    material.roughnessNode = TSL.float(material.roughness)
      .mul(makeTriplanarSample(material.roughnessMap, position, normal, scale, sharpness).g)
      .clamp(0.045, 1);
  }
  if (material.metalnessMap?.isTexture) {
    material.metalnessNode = TSL.float(material.metalness)
      .mul(makeTriplanarSample(material.metalnessMap, position, normal, scale, sharpness).b)
      .clamp(0, 1);
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
  root.traverse((object) => {
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
      'positionNode', 'castShadowPositionNode', 'alphaTestNode'
    ].map((key) => [key, material[key]]));
    let foliageRole = null;
    try {
      if (hasTriplanar) applyTriplanar(material, material.userData);
      if (hasParallax) applyParallax(material);
      if (features.includes('terrain')) applyTerrain(material, material.userData);
      if (features.includes('foliage')) foliageRole = applyFoliage(material, material.userData, options);
      material.userData = {
        ...material.userData,
        pstudioTSLFeaturesApplied: features.slice(),
        pstudioTSLFoliageRole: foliageRole
      };
      material.needsUpdate = true;
      applied.push({ material, previous });
    } catch (error) {
      for (const [key, value] of Object.entries(previous)) material[key] = value;
      throw new Error('PStudio failed to build a TSL surface material graph.', { cause: error });
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
