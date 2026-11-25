import * as THREE from 'three/webgpu';

function cloneUserData(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return { ...value };
  }
}

export function isPStudioLegacyPBRMaterial(material) {
  return Boolean(material?.isMeshStandardMaterial || material?.isMeshPhysicalMaterial);
}

/**
 * Copies public standard/physical PBR state into the matching r187 NodeMaterial.
 * The native NodeMaterial.copy() path carries texture references and extended
 * physical properties such as diffuseRoughness and iridescence.
 * Legacy onBeforeCompile hooks are detached; custom shading must be expressed
 * as TSL nodes before the converted material is used by WebGPU.
 */
export function createPStudioNodePBRMaterial(source, options = {}) {
  if (!isPStudioLegacyPBRMaterial(source)) {
    throw new TypeError('PStudio TSL material conversion requires MeshStandardMaterial or MeshPhysicalMaterial.');
  }

  const MaterialClass = source.isMeshPhysicalMaterial
    ? THREE.MeshPhysicalNodeMaterial
    : THREE.MeshStandardNodeMaterial;
  if (typeof MaterialClass !== 'function') {
    throw new Error('The pinned Three.js build does not expose the required NodeMaterial class.');
  }

  const target = new MaterialClass();
  const originalUserData = source.userData;
  const safeMetadata = cloneUserData(originalUserData);

  try {
    // NodeMaterial.copy() clones userData as JSON. Temporarily supply a safe
    // snapshot so cyclic custom metadata cannot abort an otherwise valid copy.
    source.userData = safeMetadata;
    target.copy(source);
  } catch (error) {
    target.dispose();
    throw new Error('PStudio could not copy the source PBR material into its TSL NodeMaterial.', { cause: error });
  } finally {
    source.userData = originalUserData;
  }

  target.userData = {
    ...safeMetadata,
    pstudioNodeMaterial: true,
    pstudioSourceMaterialType: source.type || 'MeshStandardMaterial',
    pstudioRenderingBackend: 'webgpu-tsl'
  };
  target.onBeforeCompile = () => {};
  target.name = options.name ?? (source.name ? source.name + ' [TSL]' : 'PStudio PBR [TSL]');
  target.needsUpdate = true;
  return target;
}

/**
 * Converts PBR materials on a scene tree while preserving shared-material
 * identity. Non-PBR materials are deliberately left unchanged.
 */
export function convertPStudioScenePBRMaterials(root, options = {}) {
  if (!root?.traverse) throw new TypeError('A Three.js Object3D or Scene is required.');
  const converted = new Map();
  const originalAssignments = [];
  let convertedMeshes = 0;
  let skippedMaterials = 0;

  const convertOne = (source) => {
    if (!isPStudioLegacyPBRMaterial(source)) {
      if (source) skippedMaterials += 1;
      return source;
    }
    if (!converted.has(source)) converted.set(source, createPStudioNodePBRMaterial(source, options));
    return converted.get(source);
  };

  root.traverse((object) => {
    if (!object?.isMesh || !object.material) return;
    const oldMaterial = object.material;
    const nextMaterial = Array.isArray(oldMaterial) ? oldMaterial.map(convertOne) : convertOne(oldMaterial);
    const changed = Array.isArray(oldMaterial)
      ? nextMaterial.some((material, index) => material !== oldMaterial[index])
      : nextMaterial !== oldMaterial;
    if (changed) {
      originalAssignments.push([object, oldMaterial]);
      object.material = nextMaterial;
      convertedMeshes += 1;
    }
  });

  let released = false;
  return Object.freeze({
    convertedMaterials: converted.size,
    convertedMeshes,
    skippedMaterials,
    disposeSourceMaterials() {
      if (released) return false;
      released = true;
      for (const source of converted.keys()) {
        try { source.dispose?.(); } catch (_) {}
      }
      return true;
    },
    restore() {
      for (const [object, original] of originalAssignments) object.material = original;
      for (const material of converted.values()) {
        try { material.dispose?.(); } catch (_) {}
      }
      originalAssignments.length = 0;
      converted.clear();
      released = true;
    }
  });
}
