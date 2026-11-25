import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

function copyColor(source, fallback = 0xffffff) {
  if (source?.isColor) return source.clone();
  return new THREE.Color(source ?? fallback);
}

function readProjection(camera) {
  return [
    camera.near, camera.far, camera.zoom,
    camera.fov, camera.aspect,
    camera.left, camera.right, camera.top, camera.bottom,
    camera.view?.enabled ? 1 : 0,
    camera.view?.offsetX, camera.view?.offsetY,
    camera.view?.width, camera.view?.height
  ].map(value => Number.isFinite(Number(value)) ? Number(value) : null);
}

/**
 * Replaces the production WebGL CSM lights with Three.js r187's native
 * WebGPU CSMShadowNode. The original lights are disabled, not destroyed,
 * and are restored when this handle is disposed (including fallback/error).
 */
export function createPStudioTSLCascadeShadows(scene, camera, options = {}) {
  if (!scene?.isScene || !camera?.isCamera) {
    throw new TypeError('PStudio TSL CSM requires a Three.js Scene and Camera.');
  }

  const config = options.legacyCSM || options;
  const legacyLights = Array.isArray(config.legacyLights)
    ? config.legacyLights.filter(Boolean)
    : [];
  if (config.enabled === false) {
    return Object.freeze({
      kind: 'pstudio-tsl-csm',
      enabled: false,
      updateCamera: () => false,
      getState: () => Object.freeze({ enabled: false, disposed: false }),
      dispose: () => false
    });
  }

  const sourceLight = legacyLights[0] || null;
  const suppliedDirection = config.lightDirection;
  const direction = suppliedDirection?.isVector3
    ? suppliedDirection.clone()
    : Array.isArray(suppliedDirection)
      ? new THREE.Vector3(...suppliedDirection.map(Number))
      : sourceLight
        ? sourceLight.target.position.clone().sub(sourceLight.position)
        : new THREE.Vector3(-5, -9, -6);
  if (!Number.isFinite(direction.length()) || direction.lengthSq() < 1e-10) {
    throw new TypeError('PStudio TSL CSM requires a finite, non-zero light direction.');
  }
  direction.normalize();

  const legacyStates = legacyLights.map(light => ({
    light,
    intensity: light.intensity,
    castShadow: light.castShadow,
    shadowAutoUpdate: light.shadow?.autoUpdate
  }));

  const lightColor = copyColor(config.lightColor || sourceLight?.color, 0xffffff);
  const lightIntensity = clamp(config.lightIntensity ?? sourceLight?.intensity, 0, 16, 3);
  const cascades = Math.floor(clamp(config.cascades, 1, 4, 3));
  const maxFar = clamp(config.maxFar, camera.near + 0.01, camera.far, Math.min(900, camera.far));
  const lightMargin = clamp(config.lightMargin, 0, 2000, 200);
  const mapWidth = Math.floor(clamp(
    config.shadowMapSize ?? sourceLight?.shadow?.mapSize?.x,
    256, 8192, 2048
  ));
  const mapHeight = Math.floor(clamp(
    config.shadowMapSize ?? sourceLight?.shadow?.mapSize?.y,
    256, 8192, 2048
  ));

  let light = null;
  let shadowNode = null;
  let disposed = false;
  let lastProjection = null;

  try {
    light = new THREE.DirectionalLight(lightColor, lightIntensity);
    light.name = 'PStudio WebGPU TSL CSM Light';
    light.castShadow = true;
    light.position.copy(direction).negate().multiplyScalar(200);
    light.target.position.set(0, 0, 0);
    light.shadow.mapSize.set(mapWidth, mapHeight);
    light.shadow.bias = clamp(config.shadowBias ?? sourceLight?.shadow?.bias, -0.02, 0.02, 0.000001);
    light.shadow.normalBias = clamp(config.normalBias ?? sourceLight?.shadow?.normalBias, 0, 0.5, 0.018);
    light.shadow.radius = clamp(config.shadowRadius ?? sourceLight?.shadow?.radius, 0, 12, 1);
    light.shadow.camera.near = clamp(config.shadowNear ?? config.lightNear ?? sourceLight?.shadow?.camera?.near, 0.01, 1000, 1);
    light.shadow.camera.far = clamp(config.shadowFar ?? config.lightFar ?? sourceLight?.shadow?.camera?.far, light.shadow.camera.near + 0.01, 10000, 2000);
    light.shadow.camera.updateProjectionMatrix();

    shadowNode = new CSMShadowNode(light, {
      cascades,
      maxFar,
      mode: ['practical', 'uniform', 'logarithmic'].includes(config.mode) ? config.mode : 'practical',
      lightMargin
    });
    shadowNode.fade = config.fade === true;
    light.shadow.shadowNode = shadowNode;

    // Do not remove the old WebGL lights. Keeping them alive is essential for
    // a rollback to the already initialized legacy renderer.
    for (const state of legacyStates) {
      state.light.intensity = 0;
      state.light.castShadow = false;
      if (state.light.shadow) state.light.shadow.autoUpdate = false;
    }
    scene.add(light, light.target);
    lastProjection = readProjection(camera);
  } catch (error) {
    try { shadowNode?.dispose?.(); } catch (_) {}
    if (light) {
      scene.remove(light, light.target);
      if (light.shadow?.shadowNode === shadowNode) light.shadow.shadowNode = null;
    }
    for (const state of legacyStates) {
      state.light.intensity = state.intensity;
      state.light.castShadow = state.castShadow;
      if (state.light.shadow && state.shadowAutoUpdate !== undefined) {
        state.light.shadow.autoUpdate = state.shadowAutoUpdate;
      }
    }
    throw new Error('PStudio could not initialize the WebGPU TSL CSM replacement.', { cause: error });
  }

  function updateCamera(nextCamera = camera, force = false) {
    if (disposed || nextCamera !== camera) return false;
    const current = readProjection(camera);
    const changed = force || !lastProjection || current.some((value, index) => value !== lastProjection[index]);
    if (changed && shadowNode.camera === camera) {
      shadowNode.updateFrustums();
      lastProjection = current;
    }
    return true;
  }

  return Object.freeze({
    kind: 'pstudio-tsl-csm',
    enabled: true,
    light,
    shadowNode,
    updateCamera,
    getState() {
      return Object.freeze({
        enabled: true,
        disposed,
        cascades,
        maxFar,
        mode: shadowNode.mode,
        fade: shadowNode.fade,
        shadowMapSize: Object.freeze([mapWidth, mapHeight]),
        legacyLightsDisabled: legacyStates.length
      });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      try { shadowNode.dispose(); } catch (_) {}
      if (light.shadow?.shadowNode === shadowNode) light.shadow.shadowNode = null;
      scene.remove(light, light.target);
      for (const state of legacyStates) {
        state.light.intensity = state.intensity;
        state.light.castShadow = state.castShadow;
        if (state.light.shadow && state.shadowAutoUpdate !== undefined) {
          state.light.shadow.autoUpdate = state.shadowAutoUpdate;
        }
      }
      return true;
    }
  });
}
