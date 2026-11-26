import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function color(value, fallback) {
  try {
    return new THREE.Color(value ?? fallback);
  } catch (_) {
    return new THREE.Color(fallback);
  }
}

function normalizeSettings(value = {}) {
  const shadowThreshold = Math.max(0.02, Math.min(0.95, finite(value.shadowThreshold, 0.32)));
  return Object.freeze({
    enabled: value.enabled !== false,
    shadowColor: color(value.shadowColor, '#46516f'),
    midColor: color(value.midColor, '#9eafd0'),
    highlightColor: color(value.highlightColor, '#ffffff'),
    shadowThreshold,
    highlightThreshold: Math.max(shadowThreshold + 0.02, Math.min(0.99, finite(value.highlightThreshold, 0.68))),
    rimColor: color(value.rimColor, '#b8dcff'),
    rimIntensity: Math.max(0, Math.min(4, finite(value.rimIntensity, 0.42))),
    rimPower: Math.max(0.5, Math.min(8, finite(value.rimPower, 2.6))),
    sssColor: color(value.sssColor, '#f0a5a0'),
    sssIntensity: Math.max(0, Math.min(1.5, finite(value.sssIntensity, 0.12)))
  });
}

function createToonLightingModel(baseModel, uniforms) {
  return {
    start(builder) {
      baseModel.start?.call(baseModel, builder);
    },
    direct(lightData, builder) {
      baseModel.direct?.call(baseModel, lightData, builder);
    },
    directRectArea(lightData, builder) {
      baseModel.directRectArea?.call(baseModel, lightData, builder);
    },
    indirect(builder) {
      baseModel.indirect?.call(baseModel, builder);
    },
    ambientOcclusion(input, stack, builder) {
      baseModel.ambientOcclusion?.call(baseModel, input, stack, builder);
    },
    finish(builder) {
      const context = builder.context;
      const reflectedLight = context?.reflectedLight;
      const outgoingLight = context?.outgoingLight;
      if (reflectedLight && outgoingLight) {
        const diffuse = reflectedLight.directDiffuse.add(reflectedLight.indirectDiffuse);
        const directLum = TSL.dot(reflectedLight.directDiffuse, TSL.vec3(0.2126, 0.7152, 0.0722));
        const indirectLum = TSL.dot(reflectedLight.indirectDiffuse, TSL.vec3(0.2126, 0.7152, 0.0722));
        const baseLum = TSL.max(
          TSL.dot(TSL.max(TSL.diffuseColor.rgb, TSL.vec3(0)), TSL.vec3(0.2126, 0.7152, 0.0722)),
          0.025
        );
        const lightLevel = TSL.clamp(directLum.add(indirectLum).div(baseLum), 0, 1);

        const shadowWeight = TSL.smoothstep(
          uniforms.shadowThreshold.sub(0.015),
          uniforms.shadowThreshold.add(0.015),
          lightLevel
        );
        const highlightWeight = TSL.smoothstep(
          uniforms.highlightThreshold.sub(0.015),
          uniforms.highlightThreshold.add(0.015),
          lightLevel
        );
        const shadowToMid = TSL.mix(uniforms.shadowColor, uniforms.midColor, shadowWeight);
        const ramp = TSL.mix(shadowToMid, uniforms.highlightColor, highlightWeight);
        const toonDiffuse = diffuse.mul(ramp);
        const enabled = TSL.clamp(uniforms.enabled, 0, 1);
        const finalDiffuse = TSL.mix(diffuse, toonDiffuse, enabled);

        // The legacy NPR shader changes only diffuse illumination. Preserve the
        // physical direct/indirect specular contribution calculated by r187.
        const specular = outgoingLight.sub(diffuse);
        const viewDirection = TSL.positionViewDirection.negate().normalize();
        const normal = TSL.normalView.normalize();
        const ndv = TSL.clamp(TSL.dot(normal, viewDirection), 0, 1);
        const rim = TSL.pow(TSL.float(1).sub(ndv), TSL.max(0.5, uniforms.rimPower))
          .mul(uniforms.rimIntensity)
          .mul(enabled);
        const subsurface = TSL.pow(TSL.float(1).sub(lightLevel), 2)
          .mul(uniforms.sssIntensity)
          .mul(enabled);
        outgoingLight.assign(
          finalDiffuse
            .add(specular)
            .add(uniforms.sssColor.mul(subsurface))
            .add(uniforms.rimColor.mul(rim).mul(0.82))
        );
      }
      baseModel.finish?.call(baseModel, builder);
    }
  };
}

function attachToonMaterial(material) {
  const metadata = material.userData?.pstudioTSLToon;
  if (!metadata || metadata.version !== 1) return null;
  if (material.isNodeMaterial !== true || material.pstudioTSLToonPreflightApproved !== true) {
    throw new Error('PStudio refused an NPR Toon material without an explicit legacy-hook TSL preflight certificate.');
  }
  if (material.userData.pstudioTSLToonAdapterVersion === 1) return null;
  if (typeof material.setupLightingModel !== 'function') {
    throw new TypeError('PStudio NPR Toon requires a NodeMaterial with a lighting model.');
  }

  const initial = normalizeSettings(metadata.settings);
  const uniforms = {
    enabled: TSL.uniform(initial.enabled ? 1 : 0),
    shadowColor: TSL.uniform(initial.shadowColor),
    midColor: TSL.uniform(initial.midColor),
    highlightColor: TSL.uniform(initial.highlightColor),
    shadowThreshold: TSL.uniform(initial.shadowThreshold),
    highlightThreshold: TSL.uniform(initial.highlightThreshold),
    rimColor: TSL.uniform(initial.rimColor),
    rimIntensity: TSL.uniform(initial.rimIntensity),
    rimPower: TSL.uniform(initial.rimPower),
    sssColor: TSL.uniform(initial.sssColor),
    sssIntensity: TSL.uniform(initial.sssIntensity)
  };

  const originalOwnSetup = Object.prototype.hasOwnProperty.call(material, 'setupLightingModel');
  const originalSetup = material.setupLightingModel;
  let disposed = false;
  let updates = 0;
  let currentSettings = initial;

  function update(nextSettings) {
    if (disposed) return false;
    currentSettings = normalizeSettings(nextSettings);
    uniforms.enabled.value = currentSettings.enabled ? 1 : 0;
    uniforms.shadowColor.value.copy(currentSettings.shadowColor);
    uniforms.midColor.value.copy(currentSettings.midColor);
    uniforms.highlightColor.value.copy(currentSettings.highlightColor);
    uniforms.shadowThreshold.value = currentSettings.shadowThreshold;
    uniforms.highlightThreshold.value = currentSettings.highlightThreshold;
    uniforms.rimColor.value.copy(currentSettings.rimColor);
    uniforms.rimIntensity.value = currentSettings.rimIntensity;
    uniforms.rimPower.value = currentSettings.rimPower;
    uniforms.sssColor.value.copy(currentSettings.sssColor);
    uniforms.sssIntensity.value = currentSettings.sssIntensity;
    updates += 1;
    return true;
  }

  const adapter = function setupPStudioToonLightingModel(builder) {
    const baseModel = originalSetup.call(this, builder);
    if (!baseModel || typeof baseModel !== 'object') {
      throw new Error('PStudio NPR Toon could not obtain the material\'s native TSL lighting model.');
    }
    return createToonLightingModel(baseModel, uniforms);
  };

  material.setupLightingModel = adapter;
  material.pstudioTSLToonUpdate = update;
  material.userData.pstudioTSLToonAdapterVersion = 1;
  material.needsUpdate = true;

  return Object.freeze({
    kind: 'pstudio-tsl-npr-toon',
    material,
    update,
    getState() {
      return Object.freeze({ disposed, updates, enabled: currentSettings.enabled });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      if (material.setupLightingModel === adapter) {
        if (originalOwnSetup) material.setupLightingModel = originalSetup;
        else delete material.setupLightingModel;
      }
      if (material.pstudioTSLToonUpdate === update) delete material.pstudioTSLToonUpdate;
      if (material.userData?.pstudioTSLToonAdapterVersion === 1) {
        delete material.userData.pstudioTSLToonAdapterVersion;
      }
      material.needsUpdate = true;
      return true;
    }
  });
}

/**
 * Installs the three-color diffuse ramp, rim light and art-directed SSS from
 * PStudio's NPR material settings while retaining the NodeMaterial's original
 * Standard/Physical specular and clearcoat lighting model.
 */
export function applyPStudioTSLToonMaterials(root) {
  if (!root?.traverse) throw new TypeError('A Three.js Object3D or Scene is required.');
  const materials = new Set();
  root.traverse(object => {
    if (!(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite) || !object.material) return;
    const assigned = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of assigned) {
      if (material?.userData?.pstudioTSLToon?.version === 1) materials.add(material);
    }
  });

  const handles = [];
  try {
    for (const material of materials) {
      const handle = attachToonMaterial(material);
      if (handle) handles.push(handle);
    }
  } catch (error) {
    for (const handle of handles) handle.dispose();
    throw new Error('PStudio could not attach NPR Toon TSL lighting; previous material lighting models were restored.', { cause: error });
  }

  let disposed = false;
  return Object.freeze({
    kind: 'pstudio-tsl-npr-toon-scene',
    materialCount: handles.length,
    getState() {
      return Object.freeze({ disposed, materialCount: handles.length });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      for (const handle of handles) handle.dispose();
      return true;
    }
  });
}
