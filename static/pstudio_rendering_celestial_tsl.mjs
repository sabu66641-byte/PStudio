import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { registerPStudioTSLMaterialAdapter } from './pstudio_rendering_external_tsl.mjs';

function readUniform(material, name, fallback) {
  const value = material?.uniforms?.[name]?.value;
  return value === undefined || value === null ? fallback : value;
}

function proxyUniforms(material, nodes, aliases) {
  const proxy = Object.create(null);
  for (const [name, node] of Object.entries(nodes)) {
    const alias = aliases?.[name] || name;
    const wrapper = {};
    Object.defineProperty(wrapper, 'value', {
      enumerable: true,
      get() { return node.value; },
      set(next) {
        const current = node.value;
        if (current?.isColor && next?.isColor) current.copy(next);
        else if (current?.isVector3 && next?.isVector3) current.copy(next);
        else node.value = next;
      }
    });
    proxy[alias] = wrapper;
  }
  material.uniforms = proxy;
  material.userData.pstudioTSLUniformNodes = nodes;
}

function copyRenderState(source, target) {
  for (const key of ['side', 'transparent', 'depthTest', 'depthWrite', 'blending', 'toneMapped', 'fog', 'visible']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  target.name = source.name || target.name;
  target.needsUpdate = true;
  return target;
}

function createMoonMaterial({ sourceMaterial }) {
  const texture = readUniform(sourceMaterial, 'uMoonMap', null);
  if (!texture?.isTexture) throw new TypeError('PStudio Moon TSL adapter requires its lunar surface texture.');
  const tint = TSL.uniform(readUniform(sourceMaterial, 'uMoonTint', new THREE.Color('#C7DCFF')));
  const lightDirection = TSL.uniform(readUniform(sourceMaterial, 'uLightDirectionWorld', new THREE.Vector3(0, -1, 0)));
  const intensity = TSL.uniform(Number(readUniform(sourceMaterial, 'uMoonIntensity', 1)));
  const glare = TSL.uniform(Number(readUniform(sourceMaterial, 'uMoonGlare', 0)));
  const earthshineStrength = TSL.uniform(Number(readUniform(sourceMaterial, 'uEarthshineStrength', 1)));

  const normal = TSL.normalize(TSL.normalWorld);
  const viewDirection = TSL.normalize(TSL.positionViewDirection);
  const facing = TSL.clamp(TSL.dot(normal, viewDirection), 0, 1);
  const light = TSL.normalize(lightDirection);
  const ndl = TSL.dot(normal, light);
  const direct = TSL.clamp(ndl, 0, 1);
  const terminator = TSL.smoothstep(-0.16, 0.17, ndl);
  const lunar = TSL.texture(texture, TSL.uv()).rgb;
  const lunarKey = TSL.mix(tint, TSL.vec3(1, 0.925, 0.80), 0.22);
  const directColor = lunar.mul(TSL.vec3(0.86, 0.94, 1.02)).mul(lunarKey)
    .mul(TSL.float(0.13).add(direct.mul(1.28)));
  const earthshine = TSL.vec3(0.012, 0.022, 0.047).add(tint.mul(0.012))
    .mul(earthshineStrength)
    .mul(TSL.float(0.62).add(TSL.float(1).sub(facing).mul(0.38)));
  let color = TSL.mix(earthshine, directColor, terminator);
  const terminatorRelief = TSL.exp(TSL.pow(ndl.div(0.115), 2).negate());
  color = color.add(TSL.vec3(0.12, 0.16, 0.24).mul(terminatorRelief).mul(0.045));
  const limb = TSL.pow(TSL.float(1).sub(facing), 2.7);
  color = color.mul(TSL.float(1).sub(limb.mul(0.22)));
  color = color.add(tint.mul(limb).mul(TSL.float(0.028).add(direct.mul(0.055))));
  const champagne = TSL.vec3(1, 0.88, 0.69);
  color = color.add(TSL.mix(champagne, tint, 0.28)
    .mul(glare)
    .mul(TSL.pow(TSL.float(1).sub(facing), 1.65))
    .mul(0.115));
  color = color.mul(intensity);

  const material = copyRenderState(sourceMaterial, new THREE.MeshBasicNodeMaterial());
  material.colorNode = color;
  material.userData = { ...(sourceMaterial.userData || {}) };
  proxyUniforms(material, { tint, lightDirection, intensity, glare, earthshineStrength }, {
    tint: 'uMoonTint',
    lightDirection: 'uLightDirectionWorld',
    intensity: 'uMoonIntensity',
    glare: 'uMoonGlare',
    earthshineStrength: 'uEarthshineStrength'
  });
  material.uniforms.uMoonMap = { value: texture };
  return material;
}

function createSunMaterial({ sourceMaterial }) {
  const texture = readUniform(sourceMaterial, 'uSunMap', null);
  if (!texture?.isTexture) throw new TypeError('PStudio Sun TSL adapter requires its photosphere texture.');
  const sunColor = TSL.uniform(readUniform(sourceMaterial, 'uSunColor', new THREE.Color('#FFF4DD')));
  const intensity = TSL.uniform(Number(readUniform(sourceMaterial, 'uSunIntensity', 1.12)));
  const glare = TSL.uniform(Number(readUniform(sourceMaterial, 'uSolarGlare', 0)));

  const normal = TSL.normalize(TSL.normalWorld);
  const viewDirection = TSL.normalize(TSL.positionViewDirection);
  const facing = TSL.clamp(TSL.dot(normal, viewDirection), 0, 1);
  const limb = TSL.float(0.68).add(TSL.float(0.32).mul(TSL.sqrt(facing)));
  const granulation = TSL.texture(texture, TSL.uv()).r;
  const surface = TSL.mix(0.91, 1.075, granulation);
  const hotCore = TSL.pow(facing, 16);
  let color = TSL.mix(sunColor.mul(0.78), TSL.vec3(1, 0.985, 0.91), hotCore.mul(0.34));
  color = color.mul(limb).mul(surface).mul(intensity);
  color = color.add(sunColor.mul(hotCore).mul(TSL.float(0.12).add(glare.mul(0.82))));

  const material = copyRenderState(sourceMaterial, new THREE.MeshBasicNodeMaterial());
  material.colorNode = color;
  material.toneMapped = false;
  material.userData = { ...(sourceMaterial.userData || {}) };
  proxyUniforms(material, { sunColor, intensity, glare }, {
    sunColor: 'uSunColor',
    intensity: 'uSunIntensity',
    glare: 'uSolarGlare'
  });
  material.uniforms.uSunMap = { value: texture };
  return material;
}

function createNightStarsMaterial({ sourceMaterial }) {
  const time = TSL.uniform(Number(readUniform(sourceMaterial, 'uTime', 0)));
  const moonDirection = TSL.uniform(readUniform(sourceMaterial, 'uMoonDirectionWorld', new THREE.Vector3(0, 1, 0)));
  const moonOcclusion = TSL.uniform(Number(readUniform(sourceMaterial, 'uMoonOcclusion', 0)));
  const phase = TSL.attribute('aPhase', 'float');
  const intensity = TSL.attribute('aIntensity', 'float');
  const speed = TSL.attribute('aSpeed', 'float');
  const pulse = TSL.float(0.58).add(TSL.sin(time.mul(speed).add(phase)).mul(0.21).add(0.21));
  const alignment = TSL.dot(TSL.normalize(TSL.positionLocal), TSL.normalize(moonDirection));
  const halo = TSL.smoothstep(0.89, 0.999, alignment);
  const moonDim = TSL.float(1).sub(moonOcclusion.mul(halo).mul(0.58));
  const point = TSL.pointUV.sub(TSL.vec2(0.5)).mul(2);
  const radius = point.dot(point);
  const core = TSL.exp(radius.mul(-190));
  const rayX = TSL.exp(point.x.abs().mul(-72)).mul(TSL.exp(point.y.abs().mul(-8)));
  const rayY = TSL.exp(point.y.abs().mul(-72)).mul(TSL.exp(point.x.abs().mul(-8)));
  const rays = TSL.max(rayX, rayY);
  // Four-point diffraction rays remain fully node-based and avoid atan2,
  // which is not exported by the pinned Three.js r187 TSL entry point.
  const crossGlint = TSL.cos(point.x.mul(6)).mul(TSL.cos(point.y.mul(6)));
  const hexLikeGlint = TSL.pow(TSL.max(crossGlint, 0), 24)
    .mul(TSL.float(1).sub(TSL.smoothstep(0.02, 0.48, radius)));
  const opacity = core.mul(0.92).add(rays.mul(0.16)).add(hexLikeGlint.mul(0.12))
    .mul(pulse).mul(intensity).mul(moonDim);

  const material = copyRenderState(sourceMaterial, new THREE.PointsNodeMaterial());
  material.colorNode = TSL.vec3(0.72, 0.83, 1.0);
  material.opacityNode = opacity;
  material.alphaTest = 0.012;
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  material.userData = { ...(sourceMaterial.userData || {}) };
  proxyUniforms(material, { time, moonDirection, moonOcclusion }, {
    time: 'uTime',
    moonDirection: 'uMoonDirectionWorld',
    moonOcclusion: 'uMoonOcclusion'
  });
  material.uniforms.uPointScale = { value: Number(readUniform(sourceMaterial, 'uPointScale', 1)) };
  return material;
}

registerPStudioTSLMaterialAdapter('pstudio.celestial.moon', {
  matches: material => material?.isShaderMaterial === true && material.userData?.pstudioTSLAdapterId === 'pstudio.celestial.moon',
  create: createMoonMaterial
});

registerPStudioTSLMaterialAdapter('pstudio.celestial.sun', {
  matches: material => material?.isShaderMaterial === true && material.userData?.pstudioTSLAdapterId === 'pstudio.celestial.sun',
  create: createSunMaterial
});

registerPStudioTSLMaterialAdapter('pstudio.celestial.twinkle-stars', {
  matches: material => material?.isShaderMaterial === true && material.userData?.pstudioTSLAdapterId === 'pstudio.celestial.twinkle-stars',
  create: createNightStarsMaterial
});
