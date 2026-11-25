import { createPStudioWebGPUBackend, isPStudioWebGPUAvailable } from './pstudio_rendering_backend.mjs';
import { convertPStudioScenePBRMaterials, isPStudioLegacyNodeConvertibleMaterial } from './pstudio_rendering_materials.mjs';
import { createPStudioRenderPipeline } from './pstudio_rendering_pipeline.mjs';
import { createPStudioTSLEnvironment } from './pstudio_rendering_environment_tsl.mjs?v=20261125-unified-sky-cloud-ibl-v1';

const PRODUCTION_BLOCKERS = Object.freeze([
  Object.freeze({ id: 'renderer-lifecycle', label: '非同期WebGPU初期化と本番フレームループの統合' }),
  Object.freeze({ id: 'legacy-materials', label: '地形・水面・植生・VFXのカスタムGLSLをTSLへ移植' }),
  Object.freeze({ id: 'environment-effects', label: '物理大気散乱・体積雲・高度フォグ・水面反射の環境表現を移植' }),
  Object.freeze({ id: 'lighting-gi-shadows', label: 'クラスタ照明・SH GI・CSM・水面反射のTSL／WebGPU移植' }),
  Object.freeze({ id: 'post-processing', label: 'EffectComposer依存のGTAO・SSR・霧・雲・AA等をRenderPipelineへ移植' }),
  Object.freeze({ id: 'resource-profiling', label: 'GPUリソース管理・タイミング計測・デバイスロスト復旧の統合' }),
  Object.freeze({ id: 'parity-validation', label: '実ブラウザー／実GPUで画質・性能・長時間動作の同等性を検証' })
]);

function hasCustomShaderHooks(material) {
  return Boolean(
    (Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile') && typeof material.onBeforeCompile === 'function')
    || (Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') && typeof material.customProgramCacheKey === 'function')
  );
}

export function inspectPStudioWebGPUSceneMaterials(scene) {
  if (!scene?.traverse) throw new TypeError('A Three.js Object3D or Scene is required.');
  const materials = new Set();
  let meshCount = 0;
  scene.traverse((object) => {
    if (!object?.isMesh || !object.material) return;
    meshCount += 1;
    const assigned = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of assigned) if (material) materials.add(material);
  });

  const unsupported = [];
  let standardPBR = 0;
  let physicalPBR = 0;
  let builtInMeshMaterials = 0;
  let nodeMaterials = 0;
  let legacyShaderHooks = 0;
  const builtInMaterialTypes = Object.create(null);
  for (const material of materials) {
    const name = String(material.name || material.type || 'Unnamed material');
    if (material.isNodeMaterial === true || material.isMeshStandardNodeMaterial === true || material.isMeshPhysicalNodeMaterial === true) {
      nodeMaterials += 1;
      continue;
    }
    if (isPStudioLegacyNodeConvertibleMaterial(material)) {
      const hasCustomHook = hasCustomShaderHooks(material);
      if (hasCustomHook) {
        legacyShaderHooks += 1;
        unsupported.push(Object.freeze({
          name,
          type: String(material.type || 'Material'),
          reason: 'custom-glsl-hook-requires-tsl-port'
        }));
        continue;
      }
      builtInMeshMaterials += 1;
      const type = String(material.type || 'MeshMaterial');
      builtInMaterialTypes[type] = (builtInMaterialTypes[type] || 0) + 1;
      if (material.isMeshPhysicalMaterial) physicalPBR += 1;
      else if (material.isMeshStandardMaterial) standardPBR += 1;
      continue;
    }
    unsupported.push(Object.freeze({
      name,
      type: String(material.type || 'Material'),
      reason: 'material-type-has-no-approved-tsl-converter'
    }));
  }

  return Object.freeze({
    meshCount,
    materialCount: materials.size,
    standardPBR,
    physicalPBR,
    builtInMeshMaterials,
    builtInMaterialTypes: Object.freeze({ ...builtInMaterialTypes }),
    nodeMaterials,
    legacyShaderHooks,
    unsupportedMaterials: unsupported.length,
    unsupported: Object.freeze(unsupported),
    compatible: unsupported.length === 0
  });
}

export function getPStudioWebGPUMigrationStatus(options = {}) {
  const navigatorRef = options.navigatorRef ?? globalThis.navigator;
  const webgpuAvailable = isPStudioWebGPUAvailable(navigatorRef);
  const sceneCompatibility = options.scene
    ? inspectPStudioWebGPUSceneMaterials(options.scene)
    : null;
  const blockers = PRODUCTION_BLOCKERS.map((item) => Object.freeze({ ...item }));
  if (!webgpuAvailable) {
    blockers.unshift(Object.freeze({
      id: 'webgpu-unavailable',
      label: '現在のブラウザーでWebGPUが利用できることを確認'
    }));
  }
  if (sceneCompatibility && !sceneCompatibility.compatible) {
    blockers.unshift(Object.freeze({
      id: 'scene-materials',
      label: '現在のシーンに残る未移植マテリアルをTSLへ移植',
      unsupportedMaterials: sceneCompatibility.unsupportedMaterials
    }));
  }
  return Object.freeze({
    productionBackend: 'webgl2',
    targetBackend: 'webgpu-tsl',
    webgpuAvailable,
    sceneReady: sceneCompatibility ? sceneCompatibility.compatible : null,
    sceneCompatibility,
    productionReady: false,
    completedFoundations: Object.freeze([
      'strict WebGPU backend initialization',
      'standard/physical PBR NodeMaterial conversion',
      'TSL RenderPipeline with Bloom',
      'TSL atmospheric sky and shared equirectangular PBR IBL',
      'shared frame-budget and environment-state modules'
    ]),
    blockers: Object.freeze(blockers)
  });
}

/**
 * Owns the complete lifecycle for one migrated WebGPU scene:
 * preflight, backend init, PBR conversion, shader compilation and TSL pipeline.
 */
export async function createPStudioWebGPUSceneSession(options = {}) {
  const { canvas, scene, camera } = options;
  if (!canvas) throw new TypeError('A canvas is required for a PStudio WebGPU scene session.');
  if (!scene?.isScene || !camera?.isCamera) {
    throw new TypeError('A Three.js Scene and Camera are required for a PStudio WebGPU scene session.');
  }

  const compatibility = inspectPStudioWebGPUSceneMaterials(scene);
  if (!compatibility.compatible) {
    const error = new Error('The scene contains materials that have not been ported to TSL.');
    error.code = 'PSTUDIO_WEBGPU_SCENE_INCOMPATIBLE';
    error.details = compatibility;
    throw error;
  }

  let backendHandle = null;
  let materialConversion = null;
  let environmentHandle = null;
  let pipelineHandle = null;
  let disposed = false;
  let deviceLoss = null;
  let deviceLostPromise = Promise.resolve(null);

  try {
    backendHandle = await createPStudioWebGPUBackend({
      canvas,
      navigatorRef: options.navigatorRef,
      signal: options.signal,
      antialias: options.antialias === true,
      alpha: options.alpha === true,
      powerPreference: options.powerPreference
    });
    const renderer = backendHandle.renderer;
    options.configureRenderer?.(renderer);

    const device = renderer.backend?.device;
    const features = device?.features && typeof device.features[Symbol.iterator] === 'function'
      ? [...device.features].map(String).sort()
      : [];
    const selectedLimits = {};
    for (const name of ['maxTextureDimension2D', 'maxBindGroups', 'maxStorageBufferBindingSize', 'maxBufferSize']) {
      const value = Number(device?.limits?.[name]);
      if (Number.isFinite(value) && value > 0) selectedLimits[name] = value;
    }
    const capabilities = Object.freeze({
      backend: 'webgpu',
      compatibilityMode: renderer.backend?.compatibilityMode === true,
      features: Object.freeze(features),
      limits: Object.freeze(selectedLimits)
    });

    if (device?.lost && typeof device.lost.then === 'function') {
      deviceLostPromise = Promise.resolve(device.lost).then((info) => {
        deviceLoss = Object.freeze({
          reason: info?.reason || null,
          message: String(info?.message || 'The WebGPU device was lost.')
        });
        if (!disposed && info?.reason !== 'destroyed') {
          try { options.onDeviceLost?.(deviceLoss); } catch (_) {}
        }
        return deviceLoss;
      }).catch((error) => {
        deviceLoss = Object.freeze({
          reason: 'unknown',
          message: String(error?.message || error || 'The WebGPU device-loss promise failed.')
        });
        if (!disposed) {
          try { options.onDeviceLost?.(deviceLoss); } catch (_) {}
        }
        return deviceLoss;
      });
    }

    materialConversion = convertPStudioScenePBRMaterials(scene);
    // Existing NodeMaterials are valid WebGPU inputs and are intentionally skipped
    // by the legacy PBR converter. Only a newly detected legacy GLSL hook is fatal.
    if (materialConversion.skippedLegacyShaderHooks !== 0) {
      throw new Error('A legacy GLSL material hook appeared after WebGPU preflight; conversion was rolled back.');
    }

    environmentHandle = createPStudioTSLEnvironment(scene, {
      profile: options.environmentProfile || globalThis.PStudioSceneEnvironment?.getPreset?.('day'),
      camera,
      resolution: options.environmentResolution
    });
    environmentHandle.updateCamera(camera);

    await renderer.compileAsync(scene, camera);
    if (options.signal?.aborted) {
      const error = new Error('WebGPU scene session initialization was cancelled.');
      error.name = 'AbortError';
      throw error;
    }

    pipelineHandle = createPStudioRenderPipeline(
      renderer,
      scene,
      camera,
      options.pipelineOptions || {}
    );

    return Object.freeze({
      kind: 'pstudio-webgpu-scene-session',
      renderer,
      capabilities,
      deviceLost: deviceLostPromise,
      render() {
        if (disposed || (deviceLoss && deviceLoss.reason !== 'destroyed')) return false;
        environmentHandle?.updateCamera?.(camera);
        return pipelineHandle.render();
      },
      setEnvironment(profile) {
        if (disposed) return false;
        return environmentHandle?.setProfile?.(profile) === true;
      },
      setBloom(settings) {
        if (disposed) return false;
        return pipelineHandle.setBloom(settings);
      },
      getState() {
        return Object.freeze({
          disposed,
          backend: disposed ? 'disposed' : deviceLoss && deviceLoss.reason !== 'destroyed' ? 'lost' : 'webgpu',
          deviceLoss,
          capabilities,
          pipeline: pipelineHandle?.getState?.() || null,
          environment: environmentHandle?.getState?.() || null,
          materials: Object.freeze({
            convertedMeshes: materialConversion?.convertedMeshes || 0,
            convertedMaterials: materialConversion?.convertedMaterials || 0,
            skippedMaterials: materialConversion?.skippedMaterials || 0
          })
        });
      },
      dispose() {
        if (disposed) return false;
        disposed = true;
        try { pipelineHandle?.dispose?.(); } catch (_) {}
        try { environmentHandle?.dispose?.(); } catch (_) {}
        try { materialConversion?.restore?.(); } catch (_) {}
        try { backendHandle?.dispose?.(); } catch (_) {}
        return true;
      }
    });
  } catch (error) {
    try { pipelineHandle?.dispose?.(); } catch (_) {}
    try { environmentHandle?.dispose?.(); } catch (_) {}
    try { materialConversion?.restore?.(); } catch (_) {}
    try { backendHandle?.dispose?.(); } catch (_) {}
    throw error;
  }
}

export function getPStudioWebGPUProductionBlockers() {
  return PRODUCTION_BLOCKERS;
}
