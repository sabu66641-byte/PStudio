import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import './pstudio_rendering_environment.js';

const DEFAULT_PROFILE = Object.freeze({
  name: 'day',
  skyTop: '#1c5a92',
  skyMid: '#438fc3',
  horizon: '#cde5ef',
  ground: '#313b3d',
  skySunX: 0.35,
  skySunY: 0.89,
  skySunZ: 0.28,
  sunIntensity: 1.24,
  sunAngularRadius: 0.28,
  sunGlow: 0.76,
  atmosphereStrength: 0.96,
  environmentIntensity: 0.92
});

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const smooth = value => {
  const t = clamp(value, 0, 1, 0);
  return t * t * (3 - 2 * t);
};

function resolveState(profile = {}) {
  const resolver = globalThis.PStudioRenderingEnvironment;
  if (typeof resolver?.resolvePStudioEnvironmentState === 'function') {
    return resolver.resolvePStudioEnvironmentState({ ...DEFAULT_PROFILE, ...profile });
  }
  const source = { ...DEFAULT_PROFILE, ...profile };
  const direction = (x, y, z, fallback) => {
    const v = [Number(x), Number(y), Number(z)];
    const length = Math.hypot(...v);
    return length > 1e-6 && v.every(Number.isFinite)
      ? v.map(value => value / length)
      : fallback.slice();
  };
  return Object.freeze({
    name: ['day','dusk','night','studio'].includes(source.name) ? source.name : 'day',
    sunDirection: Object.freeze(direction(source.skySunX, source.skySunY, source.skySunZ, [0.35,0.89,0.28])),
    moonDirection: Object.freeze(direction(source.moonDirectionX, source.moonDirectionY, source.moonDirectionZ, [0,1,0])),
    sunColor: source.atmosphereSunColor || source.sunColor || '#fff7e5',
    moonColor: source.moonColor || '#c7dcff',
    skyTop: source.skyTop,
    skyMid: source.skyMid,
    skyHorizon: source.horizon,
    skyGround: source.ground,
    skyExposure: clamp(source.skyExposure,0.1,2,0.56),
    environmentIntensity: clamp(source.environmentIntensity,0,4,0.92),
    sunIntensity: clamp(source.sunIntensity,0,8,1.24),
    sunAngularRadius: clamp(source.sunAngularRadius,0.01,5,0.28),
    sunGlow: clamp(source.sunGlow,0,4,0.76),
    starBrightness: clamp(source.starBrightness,0,4,0),
    moonIntensity: clamp(source.moonIntensity,0,4,0),
    atmosphereStrength: clamp(source.atmosphereStrength,0,1,0.96)
  });
}

function colorBytes(value, fallback = '#ffffff') {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const text = raw[0] === '#' ? raw.slice(1) : raw;
  if (/^[0-9a-f]{3}$/i.test(text)) {
    return text.split('').map(part => parseInt(part + part, 16));
  }
  if (/^[0-9a-f]{6}$/i.test(text)) {
    return [0,2,4].map(index => parseInt(text.slice(index,index+2),16));
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return [(numeric>>16)&255,(numeric>>8)&255,numeric&255];
  return colorBytes(fallback);
}

function blend(a,b,t) {
  const amount = clamp(t,0,1,0);
  return [
    Math.round(a[0] + (b[0]-a[0])*amount),
    Math.round(a[1] + (b[1]-a[1])*amount),
    Math.round(a[2] + (b[2]-a[2])*amount)
  ];
}

function hash2(x,y) {
  let value = Math.imul(x|0, 0x1f123bb5) ^ Math.imul(y|0, 0x5f356495);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value = Math.imul(value ^ (value >>> 12), 0x297a2d39);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967295;
}

/**
 * Builds a low-frequency equirectangular sky radiance map.
 * This texture supplies both PBR image-based lighting and a stable environment
 * fallback; the visible TSL sky dome adds the sharper directional sun/moon.
 */
export function generatePStudioEnvironmentPixels(state, width = 512, height = 256) {
  const w = Math.max(64, Math.min(1024, Math.floor(Number(width) || 512)));
  const h = Math.max(32, Math.min(512, Math.floor(Number(height) || w / 2)));
  const data = new Uint8Array(w * h * 4);
  const top = colorBytes(state.skyTop);
  const mid = colorBytes(state.skyMid);
  const horizon = colorBytes(state.skyHorizon || state.fogColor);
  const ground = colorBytes(state.skyGround);
  const sun = colorBytes(state.sunColor, '#fff7e5');
  const moon = colorBytes(state.moonColor, '#c7dcff');
  const sunDir = state.sunDirection || [0.35,0.89,0.28];
  const moonDir = state.moonDirection || [0,1,0];
  const sunRadius = clamp(state.sunAngularRadius,0.01,5,0.28) * Math.PI / 180;
  const sunPower = clamp(state.sunIntensity,0,8,1.24);
  const sunGlow = clamp(state.sunGlow,0,4,0.76);
  const moonPower = clamp(state.moonIntensity,0,4,0);
  const stars = state.name === 'night' ? clamp(state.starBrightness,0,4,1.5) : 0;
  const exposure = Math.pow(2,clamp(state.skyExposure,0.1,2,0.56)-0.5);
  const atmosphere = clamp(state.atmosphereStrength,0,1,0.96);
  const cellWidth = Math.max(3, Math.round(w / 128));
  const cellHeight = Math.max(3, Math.round(h / 64));
  const starCells = new Map();

  for (let y=0;y<h;y++) {
    const theta = (y + 0.5) / h * Math.PI;
    const directionY = Math.cos(theta);
    const ring = Math.sin(theta);
    const lower = blend(ground, horizon, smooth((directionY + 0.24) / 0.24));
    const horizonToMid = blend(horizon, mid, smooth((directionY + 0.02) / 0.47));
    const midToTop = blend(mid, top, smooth((directionY - 0.45) / 0.55));
    const upper = blend(horizonToMid, midToTop, smooth((directionY - 0.42) / 0.06));
    const horizonBlend = smooth((directionY + 0.012) / 0.024);
    const rowColor = blend(lower, upper, horizonBlend);

    for (let x=0;x<w;x++) {
      const phi = (x + 0.5) / w * Math.PI * 2;
      const direction = [ring*Math.cos(phi), directionY, ring*Math.sin(phi)];
      let dotSun = direction[0]*sunDir[0] + direction[1]*sunDir[1] + direction[2]*sunDir[2];
      let dotMoon = direction[0]*moonDir[0] + direction[1]*moonDir[1] + direction[2]*moonDir[2];
      dotSun = clamp(dotSun,-1,1,-1);
      dotMoon = clamp(dotMoon,-1,1,-1);
      let rgb = rowColor.slice();

      if (sunPower > 0) {
        const angle = Math.acos(dotSun);
        const disk = smooth((sunRadius * 1.16 - angle) / Math.max(1e-5,sunRadius * 0.32));
        const halo = Math.pow(Math.max(0,dotSun), Math.max(12, 38 / Math.max(0.2,sunGlow)));
        const influence = disk * sunPower * 0.88 + halo * sunGlow * 0.22 * atmosphere;
        if (influence > 1e-5) {
          rgb = rgb.map((value,index)=>Math.min(255,Math.round(value + sun[index]*influence)));
        }
      }
      if (moonPower > 0) {
        const angle = Math.acos(dotMoon);
        const disk = smooth((0.0048 - angle) / 0.0024);
        const halo = Math.pow(Math.max(0,dotMoon), 180);
        const influence = disk * moonPower * 0.42 + halo * moonPower * 0.12;
        if (influence > 1e-5) {
          rgb = rgb.map((value,index)=>Math.min(255,Math.round(value + moon[index]*influence)));
        }
      }
      if (stars > 0 && directionY > -0.08) {
        const cx = Math.floor(x / cellWidth);
        const cy = Math.floor(y / cellHeight);
        const key = cy * Math.ceil(w / cellWidth) + cx;
        let star = starCells.get(key);
        if (star === undefined) {
          const random = hash2(cx + 173, cy + 941);
          star = random > 0.986 ? (0.45 + hash2(cx + 919,cy + 257)*0.55) : 0;
          starCells.set(key,star);
        }
        if (star > 0) {
          const localX = (x % cellWidth) / cellWidth - 0.5;
          const localY = (y % cellHeight) / cellHeight - 0.5;
          const point = Math.max(0,1-Math.hypot(localX,localY)*2.7);
          const amount = point * star * Math.min(1,stars/1.5) * 170;
          rgb = rgb.map((value,index)=>Math.min(255,Math.round(value + (index===0?0.82:1)*amount)));
        }
      }

      const i = (y*w+x)*4;
      data[i] = Math.min(255,Math.round(rgb[0] * exposure));
      data[i+1] = Math.min(255,Math.round(rgb[1] * exposure));
      data[i+2] = Math.min(255,Math.round(rgb[2] * exposure));
      data[i+3] = 255;
    }
  }
  return Object.freeze({ width:w, height:h, data });
}

function makeColorUniform(value, fallback) {
  return TSL.uniform(new THREE.Color(value || fallback));
}

/**
 * Adds a TSL atmospheric sky shell and a matching equirectangular PBR IBL map.
 * All profile changes happen on explicit preset updates, never in the frame loop.
 */
export function createPStudioTSLEnvironment(scene, options = {}) {
  if (!scene?.isScene) throw new TypeError('A Three.js Scene is required for the TSL environment.');
  const previousEnvironment = scene.environment;
  const previousEnvironmentIntensity = scene.environmentIntensity;
  const profile = options.profile || globalThis.PStudioSceneEnvironment?.getPreset?.('day') || DEFAULT_PROFILE;
  let state = resolveState(profile);
  const resolution = Math.max(64,Math.min(1024,Math.floor(Number(options.resolution)||512)));
  const pixels = generatePStudioEnvironmentPixels(state,resolution,Math.max(32,Math.floor(resolution/2)));
  const environmentTexture = new THREE.DataTexture(
    pixels.data,pixels.width,pixels.height,THREE.RGBAFormat,THREE.UnsignedByteType
  );
  environmentTexture.mapping = THREE.EquirectangularReflectionMapping;
  environmentTexture.colorSpace = THREE.SRGBColorSpace;
  environmentTexture.wrapS = THREE.RepeatWrapping;
  environmentTexture.generateMipmaps = true;
  environmentTexture.minFilter = THREE.LinearMipmapLinearFilter;
  environmentTexture.magFilter = THREE.LinearFilter;
  environmentTexture.needsUpdate = true;
  scene.environment = environmentTexture;
  scene.environmentIntensity = state.environmentIntensity;

  const uniforms = {
    skyTop: makeColorUniform(state.skyTop,'#1c5a92'),
    skyMid: makeColorUniform(state.skyMid,'#438fc3'),
    horizon: makeColorUniform(state.skyHorizon,'#cde5ef'),
    ground: makeColorUniform(state.skyGround,'#313b3d'),
    sunColor: makeColorUniform(state.sunColor,'#fff7e5'),
    moonColor: makeColorUniform(state.moonColor,'#c7dcff'),
    sunDirection: TSL.uniform(new THREE.Vector3(...state.sunDirection)),
    moonDirection: TSL.uniform(new THREE.Vector3(...state.moonDirection)),
    sunIntensity: TSL.uniform(state.sunIntensity),
    sunAngularRadius: TSL.uniform(state.sunAngularRadius * Math.PI / 180),
    sunGlow: TSL.uniform(state.sunGlow),
    moonIntensity: TSL.uniform(state.moonIntensity),
    twilight: TSL.uniform(state.name === 'dusk' ? 1 : 0),
    stars: TSL.uniform(state.name === 'night' ? state.starBrightness : 0)
  };
  const direction = TSL.positionLocal.normalize();
  const y = direction.y;
  const lower = TSL.mix(uniforms.ground,uniforms.horizon,TSL.smoothstep(-0.24,0.0,y));
  const horizonToMid = TSL.mix(uniforms.horizon,uniforms.skyMid,TSL.smoothstep(-0.02,0.45,y));
  const midToTop = TSL.mix(uniforms.skyMid,uniforms.skyTop,TSL.smoothstep(0.45,1.0,y));
  const upper = TSL.mix(horizonToMid,midToTop,TSL.smoothstep(0.42,0.48,y));
  const horizonMask = TSL.smoothstep(-0.012,0.012,y);
  const baseSky = TSL.mix(lower,upper,horizonMask);
  const sunAlignment = TSL.dot(direction,uniforms.sunDirection).clamp(-1,1);
  const sunDisk = TSL.smoothstep(
    TSL.cos(uniforms.sunAngularRadius.mul(1.16)),
    TSL.cos(uniforms.sunAngularRadius.mul(0.84)),
    sunAlignment
  );
  const sunHalo = TSL.pow(sunAlignment.max(0),TSL.float(38)).mul(uniforms.sunGlow).mul(0.2);
  const sunContribution = uniforms.sunColor.mul(
    sunDisk.mul(uniforms.sunIntensity).add(sunHalo.mul(uniforms.sunIntensity))
  );
  const twilightBand = TSL.float(1).sub(TSL.smoothstep(0.02,0.42,y));
  const twilightContribution = uniforms.sunColor.mul(twilightBand.mul(uniforms.twilight).mul(0.14));
  const starCell = TSL.floor(direction.mul(420));
  const starHash = TSL.fract(TSL.sin(
    TSL.dot(starCell,TSL.vec3(127.1,311.7,74.7))
  ).mul(43758.5453));
  const starVisibility = TSL.smoothstep(-0.12,0.08,y);
  const starMask = TSL.step(TSL.float(0.9987),starHash).mul(starVisibility).mul(uniforms.stars);
  const starContribution = TSL.vec3(0.58,0.74,1.0).mul(starMask.mul(0.9));
  const moonAlignment = TSL.dot(direction,uniforms.moonDirection).clamp(-1,1);
  const moonDisk = TSL.smoothstep(TSL.float(0.99994),TSL.float(0.999985),moonAlignment);
  const moonHalo = TSL.pow(moonAlignment.max(0),TSL.float(180)).mul(uniforms.moonIntensity).mul(0.12);
  const moonContribution = uniforms.moonColor.mul(moonDisk.mul(uniforms.moonIntensity).mul(0.42).add(moonHalo));
  const skyColor = baseSky.add(sunContribution).add(moonContribution)
    .add(twilightContribution).add(starContribution);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = skyColor;
  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.depthTest = false;
  material.fog = false;
  material.toneMapped = true;
  material.name = 'PStudio TSL Atmospheric Sky';
  material.userData.pstudioNodeMaterial = true;
  material.userData.pstudioEnvironmentRole = 'sky';
  const cameraFar = Number(options.camera?.far);
  const radius = clamp(options.radius,32,10000,cameraFar>64?cameraFar*0.82:Math.max(32,cameraFar*0.82||64));
  const geometry = new THREE.SphereGeometry(radius,64,32);
  const skyMesh = new THREE.Mesh(geometry,material);
  skyMesh.name = 'PStudio TSL Atmospheric Sky';
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -10000;
  skyMesh.userData.pstudioTSLSky = true;
  scene.add(skyMesh);

  function updateUniforms(nextState) {
    uniforms.skyTop.value.set(nextState.skyTop);
    uniforms.skyMid.value.set(nextState.skyMid);
    uniforms.horizon.value.set(nextState.skyHorizon);
    uniforms.ground.value.set(nextState.skyGround);
    uniforms.sunColor.value.set(nextState.sunColor);
    uniforms.moonColor.value.set(nextState.moonColor);
    uniforms.sunDirection.value.set(...nextState.sunDirection).normalize();
    uniforms.moonDirection.value.set(...nextState.moonDirection).normalize();
    uniforms.sunIntensity.value = nextState.sunIntensity;
    uniforms.sunAngularRadius.value = nextState.sunAngularRadius * Math.PI / 180;
    uniforms.sunGlow.value = nextState.sunGlow;
    uniforms.moonIntensity.value = nextState.moonIntensity;
    uniforms.twilight.value = nextState.name === 'dusk' ? 1 : 0;
    uniforms.stars.value = nextState.name === 'night' ? nextState.starBrightness : 0;
  }

  let disposed = false;
  return Object.freeze({
    kind: 'pstudio-tsl-atmospheric-environment',
    skyMesh,
    environmentTexture,
    setProfile(nextProfile) {
      if (disposed) return false;
      state = resolveState(nextProfile || {});
      updateUniforms(state);
      const nextPixels = generatePStudioEnvironmentPixels(state,resolution,Math.max(32,Math.floor(resolution/2)));
      environmentTexture.image.data.set(nextPixels.data);
      environmentTexture.needsUpdate = true;
      scene.environmentIntensity = state.environmentIntensity;
      return true;
    },
    updateCamera(camera) {
      if (disposed || !camera?.position) return false;
      skyMesh.position.copy(camera.position);
      return true;
    },
    getState() {
      return Object.freeze({
        disposed,
        preset: state.name,
        ibl: scene.environment === environmentTexture,
        intensity: state.environmentIntensity,
        resolution: Object.freeze([pixels.width,pixels.height]),
        skyNode: true,
        iblMapping: 'equirectangular'
      });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      scene.remove(skyMesh);
      geometry.dispose();
      material.dispose();
      if (scene.environment === environmentTexture) scene.environment = previousEnvironment || null;
      environmentTexture.dispose();
      if (previousEnvironmentIntensity !== undefined) scene.environmentIntensity = previousEnvironmentIntensity;
      return true;
    }
  });
}
