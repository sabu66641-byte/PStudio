
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
    atmosphereStrength: clamp(source.atmosphereStrength,0,1,0.96),
    cloudDensity: clamp(source.cloudDensity,0,2,0),
    cloudCoverage: clamp(source.cloudCoverage,0,1,0.48),
    cloudDetail: clamp(source.cloudDetail,0,1,0.58),
    cloudBase: Number(source.cloudBase)||54,
    cloudTop: Number(source.cloudTop)||108
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

function periodicValueNoise(u,v,gridX,gridY,seed) {
  const x=u*gridX,y=v*gridY;
  const x0=Math.floor(x),y0=Math.floor(y);
  const tx=smooth(x-x0),ty=smooth(y-y0);
  const wrap=(value,size)=>((value%size)+size)%size;
  const sample=(ix,iy)=>hash2(wrap(ix,gridX)+seed*97,wrap(iy,gridY)+seed*193);
  const a=sample(x0,y0),b=sample(x0+1,y0);
  const c=sample(x0,y0+1),d=sample(x0+1,y0+1);
  return (a+(b-a)*tx)*(1-ty)+(c+(d-c)*tx)*ty;
}

/**
 * Builds one seamless equirectangular radiance map for both the visible sky
 * and PBR IBL. The map is regenerated on explicit environment changes only.
 */
export function generatePStudioEnvironmentPixels(state,width=1024,height=512) {
  const w=Math.max(64,Math.min(1024,Math.floor(Number(width)||1024)));
  const h=Math.max(32,Math.min(512,Math.floor(Number(height)||w/2)));
  const data=new Uint8Array(w*h*4);
  const top=colorBytes(state.skyTop),mid=colorBytes(state.skyMid);
  const horizon=colorBytes(state.skyHorizon||state.fogColor),ground=colorBytes(state.skyGround);
  const sun=colorBytes(state.sunColor,'#fff7e5'),moon=colorBytes(state.moonColor,'#c7dcff');
  const sunDir=state.sunDirection||[0.35,0.89,0.28],moonDir=state.moonDirection||[0,1,0];
  const sunRadius=Math.max(0.5,clamp(state.sunAngularRadius,0.01,5,0.28))*Math.PI/180;
  const sunOuter=Math.cos(sunRadius*1.16),sunInner=Math.cos(sunRadius*0.84);
  const sunPower=clamp(state.sunIntensity,0,8,1.24),sunGlow=clamp(state.sunGlow,0,4,0.76);
  const moonPower=clamp(state.moonIntensity,0,4,0);
  const stars=state.name==='night'?clamp(state.starBrightness,0,4,1.5):0;
  const exposure=Math.pow(2,clamp(state.skyExposure,0.1,2,0.56)-0.5);
  const atmosphere=clamp(state.atmosphereStrength,0,1,0.96);
  const cloudEnabled=(state.name==='day'||state.name==='dusk')&&Number(state.cloudDensity)>0.05;
  const cloudDensity=clamp(state.cloudDensity,0,2,0);
  const cloudCoverage=clamp(state.cloudCoverage,0,1,0.48);
  const cloudDetail=clamp(state.cloudDetail,0,1,0.58);
  const cloudThreshold=0.78-cloudCoverage*0.52;
  const cloudShadow=[105,126,149];
  const cloudBaseColor=blend([198,214,226],sun,0.11);
  const cloudSpan=clamp((Number(state.cloudTop)-Number(state.cloudBase))/130,0.35,1.35,1);
  const cloudTopY=clamp(0.78+cloudSpan*0.16,0.82,0.97,0.92);
  const cellWidth=Math.max(3,Math.round(w/128));
  const cellHeight=Math.max(3,Math.round(h/64));
  const starCells=new Map();

  for(let y=0;y<h;y++) {
    const v=(y+0.5)/h;
    const theta=(1-v)*Math.PI;
    const directionY=Math.cos(theta);
    const ring=Math.sin(theta);
    const lower=blend(ground,horizon,smooth((directionY+0.24)/0.24));
    const horizonToMid=blend(horizon,mid,smooth((directionY+0.02)/0.47));
    const midToTop=blend(mid,top,smooth((directionY-0.45)/0.55));
    const upper=blend(horizonToMid,midToTop,smooth((directionY-0.42)/0.06));
    const horizonBlend=smooth((directionY+0.012)/0.024);
    const rowColor=blend(lower,upper,horizonBlend);

    for(let x=0;x<w;x++) {
      const u=(x+0.5)/w;
      const phi=(u-0.5)*Math.PI*2;
      const direction=[ring*Math.cos(phi),directionY,ring*Math.sin(phi)];
      const dotSun=clamp(direction[0]*sunDir[0]+direction[1]*sunDir[1]+direction[2]*sunDir[2],-1,1,-1);
      const dotMoon=clamp(direction[0]*moonDir[0]+direction[1]*moonDir[1]+direction[2]*moonDir[2],-1,1,-1);
      let rgb=rowColor.slice();

      if(sunPower>0) {
        const disk=smooth((dotSun-sunOuter)/Math.max(1e-6,sunInner-sunOuter));
        const halo=Math.pow(Math.max(0,dotSun),Math.max(12,38/Math.max(0.2,sunGlow)));
        const influence=disk*sunPower*0.88+halo*sunGlow*0.22*atmosphere;
        if(influence>1e-5)rgb=rgb.map((value,index)=>Math.min(255,Math.round(value+sun[index]*influence)));
      }
      if(moonPower>0) {
        const moonOuter=Math.cos(0.0048),moonInner=Math.cos(0.0024);
        const disk=smooth((dotMoon-moonOuter)/Math.max(1e-7,moonInner-moonOuter));
        const halo=Math.pow(Math.max(0,dotMoon),180);
        const influence=disk*moonPower*0.42+halo*moonPower*0.12;
        if(influence>1e-5)rgb=rgb.map((value,index)=>Math.min(255,Math.round(value+moon[index]*influence)));
      }
      if(stars>0&&directionY>-0.08) {
        const cx=Math.floor(x/cellWidth),cy=Math.floor(y/cellHeight);
        const key=cy*Math.ceil(w/cellWidth)+cx;
        let star=starCells.get(key);
        if(star===undefined) {
          const random=hash2(cx+173,cy+941);
          star=random>0.986?(0.45+hash2(cx+919,cy+257)*0.55):0;
          starCells.set(key,star);
        }
        if(star>0) {
          const localX=(x%cellWidth)/cellWidth-0.5,localY=(y%cellHeight)/cellHeight-0.5;
          const point=Math.max(0,1-Math.hypot(localX,localY)*2.7);
          const amount=point*star*Math.min(1,stars/1.5)*170;
          rgb=rgb.map((value,index)=>Math.min(255,Math.round(value+(index===0?0.82:1)*amount)));
        }
      }

      if(cloudEnabled&&directionY>0.025&&directionY<cloudTopY) {
        const broad=periodicValueNoise(u,v,6,4,1);
        const middle=periodicValueNoise(u,v,12,8,2);
        const fine=periodicValueNoise(u,v,24,16,3);
        const noise=broad*0.58+middle*0.28+fine*0.14;
        const coverage=smooth((noise-(cloudThreshold-0.13))/0.26);
        const cloudZone=smooth((directionY-0.025)/0.18)
          *(1-smooth((directionY-cloudTopY)/Math.max(0.04,1-cloudTopY)));
        const detail=0.84+fine*cloudDetail*0.28;
        const opacity=clamp(coverage*cloudZone*Math.min(1.12,cloudDensity/1.08)*0.9,0,0.84,0);
        if(opacity>0.001) {
          const illumination=clamp(0.34+Math.max(0,dotSun)*0.48+Math.max(0,directionY)*0.18,0.24,1,0.6);
          const cloudColor=blend(cloudShadow,cloudBaseColor,illumination).map(value=>Math.min(255,Math.round(value*detail)));
          rgb=blend(rgb,cloudColor,opacity);
        }
      }

      const i=(y*w+x)*4;
      data[i]=Math.min(255,Math.round(rgb[0]*exposure));
      data[i+1]=Math.min(255,Math.round(rgb[1]*exposure));
      data[i+2]=Math.min(255,Math.round(rgb[2]*exposure));
      data[i+3]=255;
    }
  }
  return Object.freeze({width:w,height:h,data});
}

/**
 * Adds a TSL sky shell and the exact same equirectangular radiance texture as
 * the scene's PBR IBL, keeping background and reflection lighting coherent.
 */
export function createPStudioTSLEnvironment(scene,options={}) {
  if(!scene?.isScene)throw new TypeError('A Three.js Scene is required for the TSL environment.');
  const previousEnvironment=scene.environment;
  const previousEnvironmentIntensity=scene.environmentIntensity;
  const profile=options.profile||globalThis.PStudioSceneEnvironment?.getPreset?.('day')||DEFAULT_PROFILE;
  let state=resolveState(profile);
  const resolution=Math.max(64,Math.min(1024,Math.floor(Number(options.resolution)||1024)));
  const pixels=generatePStudioEnvironmentPixels(state,resolution,Math.max(32,Math.floor(resolution/2)));
  const environmentTexture=new THREE.DataTexture(pixels.data,pixels.width,pixels.height,THREE.RGBAFormat,THREE.UnsignedByteType);
  environmentTexture.mapping=THREE.EquirectangularReflectionMapping;
  environmentTexture.colorSpace=THREE.SRGBColorSpace;
  environmentTexture.wrapS=THREE.RepeatWrapping;
  environmentTexture.generateMipmaps=true;
  environmentTexture.minFilter=THREE.LinearMipmapLinearFilter;
  environmentTexture.magFilter=THREE.LinearFilter;
  environmentTexture.needsUpdate=true;
  scene.environment=environmentTexture;
  scene.environmentIntensity=state.environmentIntensity;

  const direction=TSL.positionWorldDirection;
  const skyUV=TSL.equirectUV(direction);
  const skyColor=TSL.texture(environmentTexture,skyUV).rgb;
  const material=new THREE.MeshBasicNodeMaterial();
  material.colorNode=skyColor;
  material.side=THREE.BackSide;
  material.depthWrite=false;
  material.depthTest=false;
  material.fog=false;
  material.toneMapped=true;
  material.name='PStudio TSL Equirectangular Sky';
  material.userData.pstudioNodeMaterial=true;
  material.userData.pstudioEnvironmentRole='sky';
  material.userData.pstudioEnvironmentSource='shared-equirectangular-ibl';
  const cameraFar=Number(options.camera?.far);
  const radius=clamp(options.radius,32,10000,cameraFar>64?cameraFar*0.82:Math.max(32,cameraFar*0.82||64));
  const geometry=new THREE.SphereGeometry(radius,64,32);
  const skyMesh=new THREE.Mesh(geometry,material);
  skyMesh.name='PStudio TSL Equirectangular Sky';
  skyMesh.frustumCulled=false;
  skyMesh.renderOrder=-10000;
  skyMesh.userData.pstudioTSLSky=true;
  scene.add(skyMesh);

  let disposed=false;
  return Object.freeze({
    kind:'pstudio-tsl-atmospheric-environment',
    skyMesh,
    environmentTexture,
    setProfile(nextProfile) {
      if(disposed)return false;
      state=resolveState(nextProfile||{});
      const nextPixels=generatePStudioEnvironmentPixels(state,resolution,Math.max(32,Math.floor(resolution/2)));
      environmentTexture.image.data.set(nextPixels.data);
      environmentTexture.needsUpdate=true;
      scene.environmentIntensity=state.environmentIntensity;
      return true;
    },
    updateCamera(camera) {
      if(disposed||!camera?.position)return false;
      skyMesh.position.copy(camera.position);
      return true;
    },
    getState() {
      return Object.freeze({
        disposed,
        preset:state.name,
        ibl:scene.environment===environmentTexture,
        intensity:state.environmentIntensity,
        resolution:Object.freeze([pixels.width,pixels.height]),
        skyNode:'equirectangular-tsl-texture-sample',
        radianceSource:'shared-sky-and-pbr-ibl'
      });
    },
    dispose() {
      if(disposed)return false;
      disposed=true;
      scene.remove(skyMesh);
      geometry.dispose();
      material.dispose();
      if(scene.environment===environmentTexture)scene.environment=previousEnvironment||null;
      environmentTexture.dispose();
      if(previousEnvironmentIntensity!==undefined)scene.environmentIntensity=previousEnvironmentIntensity;
      return true;
    }
  });
}
