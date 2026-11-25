import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

const SH_COEFFICIENT_COUNT = 9;
const SH_CHANNELS = 3;
const SH_VALUES = SH_COEFFICIENT_COUNT * SH_CHANNELS;

function readCoefficientArray(value) {
  if (value instanceof Float32Array && value.length === SH_VALUES) return value;
  if (Array.isArray(value) && value.length === SH_COEFFICIENT_COUNT) {
    const flat = new Float32Array(SH_VALUES);
    for (let index = 0; index < SH_COEFFICIENT_COUNT; index++) {
      const item = value[index];
      flat[index * 3] = Number(item?.x ?? item?.[0]) || 0;
      flat[index * 3 + 1] = Number(item?.y ?? item?.[1]) || 0;
      flat[index * 3 + 2] = Number(item?.z ?? item?.[2]) || 0;
    }
    return flat;
  }
  if (value && typeof value.length === 'number' && value.length === SH_VALUES) {
    return Float32Array.from(value, item => Number.isFinite(Number(item)) ? Number(item) : 0);
  }
  throw new TypeError('PStudio SH coefficients must contain exactly 9 RGB coefficients.');
}

/**
 * Creates a PBR irradiance contribution using the same nine real SH basis
 * coefficients and constants as PStudio's established GLSL probe evaluator.
 */
export function createPStudioTSLSHProbeNode() {
  const uniforms = Array.from({ length: SH_COEFFICIENT_COUNT }, () => TSL.uniform(new THREE.Vector3()));
  const normal = TSL.normalWorld.normalize();
  const x = normal.x, y = normal.y, z = normal.z;

  const basis = [
    0.886227,
    y.mul(1.023327),
    z.mul(1.023327),
    x.mul(1.023327),
    x.mul(y).mul(0.858086),
    y.mul(z).mul(0.858086),
    z.mul(z).mul(3).sub(1).mul(0.247708),
    x.mul(z).mul(0.858086),
    x.mul(x).sub(y.mul(y)).mul(0.429043)
  ];

  let irradiance = TSL.vec3(0);
  for (let index = 0; index < SH_COEFFICIENT_COUNT; index++) {
    irradiance = irradiance.add(uniforms[index].mul(basis[index]));
  }
  irradiance = irradiance.max(TSL.vec3(0));

  const node = new THREE.IrradianceNode(irradiance);
  return Object.freeze({
    kind: 'pstudio-tsl-sh-irradiance',
    node,
    uniforms: Object.freeze(uniforms),
    setCoefficients(value) {
      const coefficients = readCoefficientArray(value);
      for (let index = 0; index < SH_COEFFICIENT_COUNT; index++) {
        const offset = index * SH_CHANNELS;
        uniforms[index].value.set(
          coefficients[offset],
          coefficients[offset + 1],
          coefficients[offset + 2]
        );
      }
      return true;
    }
  });
}

/**
 * Installs SH irradiance into a converted PBR NodeMaterial's lighting context.
 * Scene lights are retained; only the new SH IrradianceNode is appended.
 */
export function attachPStudioTSLSHProbeToMaterial(material, sceneLights = []) {
  if (material?.isNodeMaterial !== true) {
    throw new TypeError('PStudio SH irradiance requires a converted NodeMaterial.');
  }
  if (typeof THREE.LightsNode !== 'function' || typeof THREE.IrradianceNode !== 'function') {
    throw new Error('Three.js r187 LightsNode/IrradianceNode exports are unavailable.');
  }

  const originalLightsNode = material.lightsNode ?? null;
  let lights = originalLightsNode?.getLights?.();
  if (!Array.isArray(lights)) lights = sceneLights.filter(light => light?.isLight);
  const sh = createPStudioTSLSHProbeNode();
  const nextLightsNode = new THREE.LightsNode().setLights([...lights, sh.node]);
  material.lightsNode = nextLightsNode;
  material.userData ||= {};
  material.userData.pstudioTSLProbeUniforms = sh.uniforms;
  material.needsUpdate = true;

  let disposed = false;
  return Object.freeze({
    kind: 'pstudio-tsl-sh-probe-material',
    uniforms: sh.uniforms,
    setCoefficients: sh.setCoefficients,
    dispose() {
      if (disposed) return false;
      disposed = true;
      if (material.lightsNode === nextLightsNode) material.lightsNode = originalLightsNode;
      if (material.userData?.pstudioTSLProbeUniforms === sh.uniforms) {
        delete material.userData.pstudioTSLProbeUniforms;
      }
      material.needsUpdate = true;
      return true;
    }
  });
}

export function blendPStudioTSLSHCoefficients(target, incoming, deltaMs, halfLifeMs = 240) {
  if (!target || !incoming || target.length !== SH_VALUES || incoming.length !== SH_VALUES) return 0;
  const elapsed = Math.max(0, Math.min(10000, Number(deltaMs) || 0));
  const halfLife = Math.max(1, Number(halfLifeMs) || 240);
  if (elapsed <= 0) return 0;
  const alpha = 1 - Math.exp((-Math.LN2 * elapsed) / halfLife);
  for (let index = 0; index < SH_VALUES; index++) {
    const current = Number(target[index]) || 0;
    const next = Number(incoming[index]) || 0;
    target[index] = current + (next - current) * alpha;
  }
  return alpha;
}
