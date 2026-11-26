import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { isPStudioTSLSurfaceFeatureMaterial } from './pstudio_rendering_surface_tsl.mjs?v=20261126-surface-tsl-v8';

const NODE_MATERIAL_TYPES = Object.freeze([
  ['isMeshPhysicalMaterial', 'MeshPhysicalNodeMaterial', THREE.MeshPhysicalNodeMaterial],
  ['isMeshNormalMaterial', 'MeshNormalNodeMaterial', THREE.MeshNormalNodeMaterial],
  ['isMeshStandardMaterial', 'MeshStandardNodeMaterial', THREE.MeshStandardNodeMaterial],
  ['isMeshBasicMaterial', 'MeshBasicNodeMaterial', THREE.MeshBasicNodeMaterial],
  ['isMeshLambertMaterial', 'MeshLambertNodeMaterial', THREE.MeshLambertNodeMaterial],
  ['isMeshPhongMaterial', 'MeshPhongNodeMaterial', THREE.MeshPhongNodeMaterial],
  ['isMeshToonMaterial', 'MeshToonNodeMaterial', THREE.MeshToonNodeMaterial],
  ['isMeshMatcapMaterial', 'MeshMatcapNodeMaterial', THREE.MeshMatcapNodeMaterial],
  ['isLineDashedMaterial', 'LineDashedNodeMaterial', THREE.LineDashedNodeMaterial],
  ['isLineBasicMaterial', 'LineBasicNodeMaterial', THREE.LineBasicNodeMaterial],
  ['isPointsMaterial', 'PointsNodeMaterial', THREE.PointsNodeMaterial],
  ['isSpriteMaterial', 'SpriteNodeMaterial', THREE.SpriteNodeMaterial]
]);

function cloneUserData(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return { ...value };
  }
}

export function isPStudioLegacyTSLToonMaterial(material) {
  const metadata = material?.userData || {};
  const toon = metadata.pstudioTSLToon;
  return material?.pstudioTSLToonPreflightApproved === true
    && toon?.version === 1
    && toon.settings && typeof toon.settings === 'object'
    && material.pstudioTSLToonCompileHook === material.onBeforeCompile
    && material.pstudioTSLToonCacheKey === material.customProgramCacheKey
    && metadata.pstudioTSLPortHasForeignHook !== true;
}

function hasCustomShaderHook(material) {
  if (isPStudioLegacyTSLToonMaterial(material)) return false;
  if (isPStudioTSLSurfaceFeatureMaterial(material)) return false;
  const userData = material?.userData || {};
  const csmOnly = userData.pstudioCSMOnlyHook === true
    && userData.pstudioProbeShaderSetup !== true
    && userData.pstudioCSMHook === material.onBeforeCompile
    && !Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
  if (csmOnly) return false;
  const outline = userData.pstudioTSLOutline;
  const approvedOutline = outline?.version === 1
    && Number.isFinite(Number(outline.expansion))
    && Number(outline.expansion) > 0
    && material.pstudioTSLOutlineCompileHook === material.onBeforeCompile
    && material.pstudioTSLOutlineCacheKey === material.customProgramCacheKey
    && typeof material.onBeforeCompile === 'function'
    && typeof material.customProgramCacheKey === 'function';
  if (approvedOutline) return false;
  return Boolean(
    (Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile') && typeof material.onBeforeCompile === 'function')
    || (Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') && typeof material.customProgramCacheKey === 'function')
  );
}

function resolveNodeMaterialClass(source) {
  const entry = NODE_MATERIAL_TYPES.find(([flag]) => source?.[flag] === true);
  if (!entry) return null;
  const MaterialClass = entry[2];
  return typeof MaterialClass === 'function' ? { MaterialClass, nodeType: entry[1] } : null;
}

export function isPStudioLegacyPBRMaterial(material) {
  return Boolean(material?.isMeshStandardMaterial || material?.isMeshPhysicalMaterial);
}

export function isPStudioLegacyNodeConvertibleMaterial(material) {
  return Boolean(resolveNodeMaterialClass(material));
}

/**
 * Copies supported built-in Three.js mesh material state into its matching
 * r187 NodeMaterial. Custom GLSL hooks are deliberately not discarded: callers
 * must preflight and port those hooks explicitly before conversion.
 */
export function createPStudioNodeMaterial(source, options = {}) {
  const resolved = resolveNodeMaterialClass(source);
  if (!resolved) {
    throw new TypeError('PStudio TSL conversion requires a supported built-in Mesh material.');
  }
  if (hasCustomShaderHook(source)) {
    throw new TypeError('PStudio cannot convert a material with custom GLSL hooks until its shader behavior is ported to TSL.');
  }
  const { MaterialClass, nodeType } = resolved;
  const target = new MaterialClass();
  const approvedSurfaceFeatures = isPStudioTSLSurfaceFeatureMaterial(source);
  const approvedToonMaterial = isPStudioLegacyTSLToonMaterial(source);
  const originalUserData = source.userData;
  const safeMetadata = cloneUserData(originalUserData);

  try {
    source.userData = safeMetadata;
    target.copy(source);
  } catch (error) {
    target.dispose();
    throw new Error('PStudio could not copy the source material into its TSL NodeMaterial.', { cause: error });
  } finally {
    source.userData = originalUserData;
  }

  // The WebGL CSM defines and its shader hook have a native TSL equivalent.
  // They must not leak into the WebGPU NodeMaterial after conversion.
  if (source.userData?.pstudioCSMOnlyHook === true && !source.userData?.pstudioProbeShaderSetup) {
    delete safeMetadata.pstudioCSMOnlyHook;
    delete safeMetadata.pstudioCSMSetup;
    delete safeMetadata.pstudioCSMHook;
    if (target.defines) {
      delete target.defines.USE_CSM;
      delete target.defines.CSM_CASCADES;
      delete target.defines.CSM_FADE;
    }
  }

  const outline = safeMetadata.pstudioTSLOutline;
  if (outline?.version === 1
    && Number.isFinite(Number(outline.expansion))
    && Number(outline.expansion) > 0
    && source.pstudioTSLOutlineCompileHook === source.onBeforeCompile
    && source.pstudioTSLOutlineCacheKey === source.customProgramCacheKey) {
    let alpha = TSL.float(1);
    if (outline.useMapAlpha === true && source.map) {
      alpha = alpha.mul(TSL.texture(source.map, TSL.uv()).a);
    }
    if (outline.useAlphaMapAlpha === true && source.alphaMap) {
      alpha = alpha.mul(TSL.texture(source.alphaMap, TSL.uv()).g);
    }
    if (outline.useVertexAlpha === true && source.vertexColors === true) {
      alpha = alpha.mul(TSL.vertexColor().a);
    }

    target.colorNode = TSL.uniform(source.color.clone());
    target.opacityNode = alpha;
    target.positionNode = TSL.positionLocal.add(
      TSL.normalLocal.normalize().mul(TSL.float(Number(outline.expansion)))
    );
    // Alpha is reconstructed explicitly above to retain the legacy GLSL's
    // cutout/transparent mask while forcing the shell's RGB to its outline tint.
    target.map = null;
    target.alphaMap = null;
    target.vertexColors = false;
    safeMetadata.pstudioTSLOutlineTSL = true;
  }
  target.userData = {
    ...safeMetadata,
    pstudioNodeMaterial: true,
    pstudioSourceMaterialType: source.type || 'Material',
    pstudioNodeMaterialType: nodeType,
    pstudioRenderingBackend: 'webgpu-tsl'
  };
  target.onBeforeCompile = () => {};
  // Carry the preflight decision across the legacy-to-NodeMaterial boundary;
  // userData alone must never be able to assert this approval.
  target.pstudioTSLSurfacePreflightApproved = approvedSurfaceFeatures;
  target.pstudioTSLToonPreflightApproved = approvedToonMaterial;
  target.name = options.name ?? (source.name ? source.name + ' [TSL]' : 'PStudio ' + nodeType);
  target.needsUpdate = true;
  return target;
}

export function createPStudioNodePBRMaterial(source, options = {}) {
  if (!isPStudioLegacyPBRMaterial(source)) {
    throw new TypeError('PStudio PBR conversion requires MeshStandardMaterial or MeshPhysicalMaterial.');
  }
  return createPStudioNodeMaterial(source, options);
}

/**
 * Converts supported built-in mesh materials on a scene tree while preserving
 * shared-material identity. Unsupported and custom-hook materials remain intact.
 */
export function convertPStudioScenePBRMaterials(root, options = {}) {
  if (!root?.traverse) throw new TypeError('A Three.js Object3D or Scene is required.');
  const converted = new Map();
  const originalAssignments = [];
  const convertedByType = Object.create(null);
  let convertedMeshes = 0;
  let convertedObjects = 0;
  let skippedMaterials = 0;
  let skippedLegacyShaderHooks = 0;

  const convertOne = (source) => {
    if (!source || !isPStudioLegacyNodeConvertibleMaterial(source)) {
      if (source) skippedMaterials += 1;
      return source;
    }
    if (hasCustomShaderHook(source)) {
      skippedMaterials += 1;
      skippedLegacyShaderHooks += 1;
      return source;
    }
    if (!converted.has(source)) {
      const nodeMaterial = createPStudioNodeMaterial(source, options);
      converted.set(source, nodeMaterial);
      const type = nodeMaterial.userData.pstudioNodeMaterialType;
      convertedByType[type] = (convertedByType[type] || 0) + 1;
    }
    return converted.get(source);
  };

  try {
    root.traverse((object) => {
      if (!(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite) || !object.material) return;
      const oldMaterial = object.material;
      const nextMaterial = Array.isArray(oldMaterial) ? oldMaterial.map(convertOne) : convertOne(oldMaterial);
      const changed = Array.isArray(oldMaterial)
        ? nextMaterial.some((material, index) => material !== oldMaterial[index])
        : nextMaterial !== oldMaterial;
      if (changed) {
        originalAssignments.push([object, oldMaterial]);
        object.material = nextMaterial;
        convertedObjects += 1;
        if (object.isMesh) convertedMeshes += 1;
      }
    });
  } catch (error) {
    for (const [object, original] of originalAssignments) object.material = original;
    for (const material of converted.values()) {
      try { material.dispose?.(); } catch (_) {}
    }
    throw new Error('PStudio rolled back a partial scene material-to-TSL conversion.', { cause: error });
  }

  let released = false;
  return Object.freeze({
    convertedMaterials: converted.size,
    convertedMeshes,
    convertedObjects,
    convertedByType: Object.freeze({ ...convertedByType }),
    skippedMaterials,
    skippedLegacyShaderHooks,
    disposeSourceMaterials() {
      if (released) return false;
      released = true;
      for (const source of converted.keys()) {
        try { source.dispose?.(); } catch (_) {}
      }
      return true;
    },
    restore() {
      if (released) return false;
      for (const [object, original] of originalAssignments) object.material = original;
      for (const material of converted.values()) {
        try { material.dispose?.(); } catch (_) {}
      }
      originalAssignments.length = 0;
      converted.clear();
      released = true;
      return true;
    }
  });
}
