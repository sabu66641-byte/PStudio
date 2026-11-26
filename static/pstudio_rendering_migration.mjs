import { createPStudioWebGPUBackend, isPStudioWebGPUAvailable } from './pstudio_rendering_backend.mjs';
import { convertPStudioScenePBRMaterials, isPStudioLegacyNodeConvertibleMaterial } from './pstudio_rendering_materials.mjs?v=20261126-surface-hook-safe-v6';
import { createPStudioRenderPipeline } from './pstudio_rendering_pipeline.mjs?v=20261126-shared-frame-resources-v1';
import { createPStudioTSLEnvironment } from './pstudio_rendering_environment_tsl.mjs?v=20261125-unified-sky-cloud-ibl-v1';
import { createPStudioTSLCascadeShadows } from './pstudio_rendering_csm_tsl.mjs?v=20261126-tsl-csm-v1';
import { isPStudioTSLSurfaceFeatureMaterial, applyPStudioTSLSurfaceFeatures } from './pstudio_rendering_surface_tsl.mjs?v=20261126-surface-tsl-v8';
import { createPStudioTSLWaterDepthPrepass, applyPStudioTSLWaterSurfaces } from './pstudio_rendering_water_tsl.mjs?v=20261126-water-tsl-v3';
import { createPStudioTSLClusterStorage, applyPStudioTSLClusteredLighting } from './pstudio_rendering_clustered_lighting_tsl.mjs?v=20261126-clustered-tsl-v2';

export const supportsPStudioTSLWater = typeof createPStudioTSLWaterDepthPrepass === 'function' && typeof applyPStudioTSLWaterSurfaces === 'function';
export const supportsPStudioTSLSurfaceFeatures = typeof applyPStudioTSLSurfaceFeatures === 'function';
export const supportsPStudioTSLCaustics = supportsPStudioTSLSurfaceFeatures;
export const supportsPStudioTSLClusteredLighting = typeof createPStudioTSLClusterStorage === 'function' && typeof applyPStudioTSLClusteredLighting === 'function';

export const supportsPStudioTSLCSM = typeof createPStudioTSLCascadeShadows === 'function';

const PRODUCTION_BLOCKERS = Object.freeze([
  Object.freeze({ id: 'renderer-parity-validation', label: '本番WebGPUの実機負荷・長時間動作・WebGL2復旧の回帰検証' }),
  Object.freeze({ id: 'legacy-materials', label: '認定済みTSLアダプター対象外の独自GLSL・拡張材質を移植' }),
  Object.freeze({ id: 'environment-effects', label: '体積雲・高度フォグのTSL移植' }),
  Object.freeze({ id: 'lighting-gi-shadows', label: 'クラスタ照明・静的／動的SH GI・プローブキャプチャのTSL／WebGPU移植' }),
  Object.freeze({ id: 'post-processing', label: 'EffectComposer依存のGTAO・SSR・霧・雲・AA等をRenderPipelineへ移植' }),
  Object.freeze({ id: 'resource-profiling', label: 'GPUリソース管理・タイミング計測・デバイスロスト復旧の統合' }),
  Object.freeze({ id: 'parity-validation', label: '実ブラウザー／実GPUで画質・性能・長時間動作の同等性を検証' })
]);

function hasCustomShaderHooks(material) {
  if (isPStudioTSLSurfaceFeatureMaterial(material)) return false;
  const userData = material?.userData || {};
  const csmOnly = userData.pstudioCSMOnlyHook === true
    && userData.pstudioProbeShaderSetup !== true
    && userData.pstudioCSMHook === material.onBeforeCompile
    && !Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
  if (csmOnly) return false;
  return Boolean(
    (Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile') && typeof material.onBeforeCompile === 'function')
    || (Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') && typeof material.customProgramCacheKey === 'function')
  );
}

export function inspectPStudioWebGPUSceneMaterials(scene) {
  if (!scene?.traverse) throw new TypeError('A Three.js Object3D or Scene is required.');
  const materials = new Set();
  let meshCount = 0;
  let renderableCount = 0;
  scene.traverse((object) => {
    if (!(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite) || !object.material) return;
    if (object.isMesh) meshCount += 1;
    renderableCount += 1;
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
    renderableCount,
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
      'native TSL CSMShadowNode with reversible WebGL CSM hand-off',
      'production dual-canvas bridge with compatibility-gated WebGPU promotion and WebGL2 recovery',
      'production scene frame-loop, resize and staged material-conversion handoff',
      'standard/physical PBR NodeMaterial conversion',
      'TSL RenderPipeline with shared beauty/depth/packed-view-normal frame resources and Bloom',
      'TSL atmospheric sky and shared equirectangular PBR IBL',
      'shared frame-budget and environment-state modules',
      'TSL clustered point-light irradiance with revisioned StorageBuffer uploads and native-light overflow fallback',
      'TSL SH irradiance nodes preserving PStudio 9xRGB probe coefficients and temporal blending',
      'TSL Terrain/Triplanar/Parallax/Foliage surface adapters',
      'TSL Water surface, native ReflectorNode planar reflection and opaque-scene depth prepass',
      'TSL underwater caustics with the legacy diffuse-light response preserved'
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
  let csmHandle = null;
  let surfaceHandle = null;
  let waterDepthHandle = null;
  let waterSurfaceHandle = null;
  let clusterStorageHandle = null;
  let clusteredLightingHandle = null;
  let disposed = false;
  let deviceLoss = null;
  let deviceLostPromise = Promise.resolve(null);
  const reportStage = (stage, details = {}) => {
    try { options.onStageChange?.(stage, Object.freeze({ ...details })); } catch (_) {}
  };

  try {
    reportStage('initializing-backend');
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

    reportStage('converting-materials', { materialCount: compatibility.materialCount });
    materialConversion = convertPStudioScenePBRMaterials(scene);
    // Existing NodeMaterials are valid WebGPU inputs and are intentionally skipped
    // by the legacy PBR converter. Only a newly detected legacy GLSL hook is fatal.
    if (materialConversion.skippedLegacyShaderHooks !== 0) {
      throw new Error('A legacy GLSL material hook appeared after WebGPU preflight; conversion was rolled back.');
    }

    const environmentProfile = options.environmentProfile || globalThis.PStudioSceneEnvironment?.getPreset?.('day');
    reportStage('porting-surface-features', { materialCount: materialConversion.convertedMaterials || 0 });
    surfaceHandle = applyPStudioTSLSurfaceFeatures(scene, { environmentProfile });

    const initialClusterSnapshot = typeof options.getClusteredLightingSnapshot === 'function'
      ? options.getClusteredLightingSnapshot()
      : options.clusteredLightingSnapshot || null;
    if (initialClusterSnapshot) {
      reportStage('porting-clustered-lighting', {
        lights: initialClusterSnapshot.lightCount || 0,
        revision: initialClusterSnapshot.revision ?? null
      });
      clusterStorageHandle = createPStudioTSLClusterStorage(renderer, options.clusteredLightingOptions || {});
      clusteredLightingHandle = applyPStudioTSLClusteredLighting(scene, {
        storage: clusterStorageHandle,
        snapshot: initialClusterSnapshot
      });
    }

    let hasWaterMaterials = false;
    scene.traverse((object) => {
      if (!object?.isMesh || !object.material) return;
      const assigned = Array.isArray(object.material) ? object.material : [object.material];
      if (assigned.some((material) => material?.userData?.pstudioTSLFeatures?.includes('water'))) {
        hasWaterMaterials = true;
      }
    });
    if (hasWaterMaterials) {
      reportStage('porting-water-depth-and-reflections');
      waterDepthHandle = createPStudioTSLWaterDepthPrepass(renderer, scene, camera);
      waterSurfaceHandle = applyPStudioTSLWaterSurfaces(scene, {
        depthTexture: waterDepthHandle.depthTexture
      });
      await waterDepthHandle.compile();
    }

    environmentHandle = createPStudioTSLEnvironment(scene, {
      profile: environmentProfile,
      camera,
      resolution: options.environmentResolution
    });
    environmentHandle.updateCamera(camera);

    if (options.csm?.enabled !== false && options.csm) {
      reportStage('initializing-csm', { cascades: options.csm.cascades || 3 });
      csmHandle = createPStudioTSLCascadeShadows(scene, camera, options.csm);
    }

    reportStage('compiling', { convertedMaterials: materialConversion.convertedMaterials || 0 });
    await renderer.compileAsync(scene, camera);
    csmHandle?.updateCamera?.(camera, true);
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
    reportStage('ready', { convertedMaterials: materialConversion.convertedMaterials || 0 });

    return Object.freeze({
      kind: 'pstudio-webgpu-scene-session',
      renderer,
      capabilities,
      deviceLost: deviceLostPromise,
      resize(width, height, pixelRatio) {
        if (disposed) return false;
        const nextWidth = Math.floor(Number(width));
        const nextHeight = Math.floor(Number(height));
        if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth < 1 || nextHeight < 1) return false;
        const ratio = Number(pixelRatio);
        if (Number.isFinite(ratio) && ratio > 0 && Math.abs(renderer.getPixelRatio() - ratio) > 0.001) {
          renderer.setPixelRatio(Math.max(0.5, Math.min(4.5, ratio)));
        }
        renderer.setSize(nextWidth, nextHeight, false);
        return true;
      },
      render() {
        if (disposed || (deviceLoss && deviceLoss.reason !== 'destroyed')) return false;
        environmentHandle?.updateCamera?.(camera);
        csmHandle?.updateCamera?.(camera);
        waterDepthHandle?.prepareFrame?.();
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
      setClusteredLightingSnapshot(snapshot) {
        if (disposed || !snapshot) return false;
        if (!clusteredLightingHandle) {
          clusterStorageHandle = createPStudioTSLClusterStorage(renderer, options.clusteredLightingOptions || {});
          clusteredLightingHandle = applyPStudioTSLClusteredLighting(scene, {
            storage: clusterStorageHandle,
            snapshot
          });
          return true;
        }
        return clusteredLightingHandle.update(snapshot);
      },
      getState() {
        return Object.freeze({
          disposed,
          backend: disposed ? 'disposed' : deviceLoss && deviceLoss.reason !== 'destroyed' ? 'lost' : 'webgpu',
          deviceLoss,
          capabilities,
          pipeline: pipelineHandle?.getState?.() || null,
          environment: environmentHandle?.getState?.() || null,
          csm: csmHandle?.getState?.() || null,
          clusteredLighting: clusteredLightingHandle?.getState?.() || null,
          surfaceFeatures: Object.freeze({
            materialCount: surfaceHandle?.materialCount || 0,
            features: surfaceHandle?.features || Object.freeze([])
          }),
          water: Object.freeze({
            active: !!waterSurfaceHandle,
            waterMeshes: waterSurfaceHandle?.waterMeshes || 0,
            reflectorCount: waterSurfaceHandle?.reflectorCount || 0,
            depthPrepass: waterDepthHandle?.getState?.() || null
          }),
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
        try { csmHandle?.dispose?.(); } catch (_) {}
        try { clusteredLightingHandle?.dispose?.(); } catch (_) {}
        try { clusterStorageHandle?.dispose?.(); } catch (_) {}
        try { waterSurfaceHandle?.dispose?.(); } catch (_) {}
        try { waterDepthHandle?.dispose?.(); } catch (_) {}
        try { surfaceHandle?.dispose?.(); } catch (_) {}
        try { materialConversion?.restore?.(); } catch (_) {}
        try { backendHandle?.dispose?.(); } catch (_) {}
        reportStage('disposed');
        return true;
      }
    });
  } catch (error) {
    reportStage('failed', { message: String(error?.message || error) });
    try { pipelineHandle?.dispose?.(); } catch (_) {}
    try { environmentHandle?.dispose?.(); } catch (_) {}
    try { csmHandle?.dispose?.(); } catch (_) {}
    try { clusteredLightingHandle?.dispose?.(); } catch (_) {}
    try { clusterStorageHandle?.dispose?.(); } catch (_) {}
    try { waterSurfaceHandle?.dispose?.(); } catch (_) {}
    try { waterDepthHandle?.dispose?.(); } catch (_) {}
    try { surfaceHandle?.dispose?.(); } catch (_) {}
    try { materialConversion?.restore?.(); } catch (_) {}
    try { backendHandle?.dispose?.(); } catch (_) {}
    throw error;
  }
}

export function getPStudioWebGPUProductionBlockers() {
  return PRODUCTION_BLOCKERS;
}
