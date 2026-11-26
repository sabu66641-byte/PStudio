const adapters = new Map();

function normalizeId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,95}$/i.test(id)) {
    throw new TypeError('A TSL adapter id must be 2-96 URL-safe characters.');
  }
  return id;
}

function adapterIdOf(material) {
  return String(material?.userData?.pstudioTSLAdapterId || '').trim();
}

/**
 * Register an explicit semantic port for one legacy ShaderMaterial/custom hook.
 * A registration is executable conversion code; a userData marker alone never
 * grants WebGPU compatibility.
 */
export function registerPStudioTSLMaterialAdapter(id, adapter) {
  const key = normalizeId(id);
  if (!adapter || typeof adapter.create !== 'function') {
    throw new TypeError('A PStudio TSL material adapter must provide create(context).');
  }
  const existing = adapters.get(key);
  if (existing && existing !== adapter) {
    throw new Error('A different PStudio TSL material adapter is already registered: ' + key);
  }
  adapters.set(key, adapter);
  let active = true;
  return Object.freeze({
    id: key,
    unregister() {
      if (!active) return false;
      active = false;
      if (adapters.get(key) === adapter) adapters.delete(key);
      return true;
    }
  });
}

export function getPStudioTSLMaterialAdapterId(material) {
  return adapterIdOf(material);
}

export function isPStudioTSLMaterialAdapterRegistered(material) {
  const id = adapterIdOf(material);
  if (!id) return false;
  const adapter = adapters.get(id);
  if (!adapter) return false;
  try {
    return typeof adapter.matches !== 'function' || adapter.matches(material) === true;
  } catch (_) {
    return false;
  }
}

export function listPStudioTSLMaterialAdapters() {
  return Object.freeze([...adapters.keys()].sort());
}

/**
 * Replaces only explicitly registered legacy materials with NodeMaterials.
 * Shared source materials remain shared; all assignments roll back atomically
 * if an adapter throws or returns a non-NodeMaterial.
 */
export function applyPStudioTSLMaterialAdapters(root, options = {}) {
  if (!root?.traverse) throw new TypeError('A Three.js Object3D or Scene is required.');
  const converted = new Map();
  const originalAssignments = [];
  const createdTargets = new Set();
  let convertedObjects = 0;
  let disposed = false;

  const convertOne = (source, object) => {
    if (!source || source.isNodeMaterial === true) return source;
    const id = adapterIdOf(source);
    if (!id) return source;
    const adapter = adapters.get(id);
    if (!adapter || (typeof adapter.matches === 'function' && adapter.matches(source) !== true)) {
      throw new Error('No approved TSL adapter is registered for legacy material: ' + id);
    }
    if (converted.has(source)) return converted.get(source);

    const target = adapter.create(Object.freeze({
      id,
      sourceMaterial: source,
      object,
      root,
      renderer: options.renderer || null
    }));
    if (!target || target.isNodeMaterial !== true) {
      target?.dispose?.();
      throw new TypeError('TSL adapter ' + id + ' must return a Three.js NodeMaterial.');
    }
    const adapterUserData = target.userData && typeof target.userData === 'object' ? target.userData : {};
    target.userData = {
      ...(source.userData || {}),
      ...adapterUserData,
      pstudioNodeMaterial: true,
      pstudioExternalTSLAdapter: id,
      pstudioSourceMaterialType: source.type || 'Material',
      pstudioRenderingBackend: 'webgpu-tsl'
    };
    target.name = target.name || (source.name ? source.name + ' [TSL]' : 'PStudio TSL Adapter ' + id);
    target.needsUpdate = true;
    converted.set(source, target);
    createdTargets.add(target);
    return target;
  };

  try {
    root.traverse(object => {
      if (!(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite) || !object.material) return;
      const original = object.material;
      const replacement = Array.isArray(original)
        ? original.map(material => convertOne(material, object))
        : convertOne(original, object);
      const changed = Array.isArray(original)
        ? replacement.some((material, index) => material !== original[index])
        : replacement !== original;
      if (changed) {
        originalAssignments.push([object, original]);
        object.material = replacement;
        convertedObjects += 1;
      }
    });
  } catch (error) {
    for (let index = originalAssignments.length - 1; index >= 0; index -= 1) {
      const [object, original] = originalAssignments[index];
      object.material = original;
    }
    for (const target of createdTargets) {
      try { target.dispose?.(); } catch (_) {}
    }
    throw new Error('PStudio rolled back a partial external GLSL-to-TSL material conversion.', { cause: error });
  }

  function restore() {
    if (disposed) return false;
    disposed = true;
    for (let index = originalAssignments.length - 1; index >= 0; index -= 1) {
      const [object, original] = originalAssignments[index];
      object.material = original;
    }
    for (const target of createdTargets) {
      try { target.dispose?.(); } catch (_) {}
    }
    originalAssignments.length = 0;
    converted.clear();
    createdTargets.clear();
    return true;
  }

  return Object.freeze({
    kind: 'pstudio-external-tsl-material-adapters',
    convertedMaterials: converted.size,
    convertedObjects,
    getState() {
      return Object.freeze({ disposed, convertedMaterials: converted.size, convertedObjects });
    },
    restore,
    dispose: restore
  });
}
