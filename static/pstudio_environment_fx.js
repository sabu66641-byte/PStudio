/* PStudio Environment FX: water, foliage, underwater caustics and volumetric depth fog. */
(() => {
  'use strict';
  const T = () => window.THREE;
  const water = new Set(), foliage = new Set(), caustics = new Set(), parallaxMaterials = new Set();
  const has = (text, re) => re.test(String(text || ''));
  const addAfter = (source, token, code) => source.includes(token) ? source.replace(token, token + '\n' + code) : source;
  const WATER = /water|river|lake|ocean|sea|lagoon|cascade|waterfall|foam|spray/i;
  const LEAF = /tree|foliage|leaf|leaves|canopy|grass|meadow|wildflower|pine|bush|shrub/i;
  const UNDER = /submerged|underwater|reef|riverbed|seabed|waterbed/i;

  function configureWater(material, object, waterfall) {
    if (!material || material.userData.pstudioWaterHQ) return material;
    const Three = T();
    if (!Three || (!material.isMeshPhysicalMaterial && !material.isMeshStandardMaterial)) return material;
    object?.geometry?.computeBoundingBox?.();
    const b = object?.geometry?.boundingBox;
    const minX = b ? b.min.x : -50, minZ = b ? b.min.z : -50;
    const width = b ? Math.max(0.001, b.max.x-b.min.x) : 100;
    const depth = b ? Math.max(0.001, b.max.z-b.min.z) : 100;
    const u = {
      time:{value:0}, amplitude:{value:waterfall?0.018:0.105},
      bounds:{value:new Three.Vector4(minX,minZ,width,depth)},
      shallow:{value:new Three.Color('#65d9bf')},
      deep:{value:new Three.Color('#08727d')},
      foam:{value:new Three.Color('#e3fff6')},
      mode:{value:waterfall?1:0}
    };
    const old = material.onBeforeCompile, oldKey = material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile = function(shader, renderer) {
      if (old) old.call(this,shader,renderer);
      Object.assign(shader.uniforms,{
        uPStudioWaterTime:u.time,uPStudioWaterAmplitude:u.amplitude,uPStudioWaterBounds:u.bounds,
        uPStudioWaterShallow:u.shallow,uPStudioWaterDeep:u.deep,uPStudioWaterFoam:u.foam,uPStudioWaterMode:u.mode
      });
      shader.vertexShader = addAfter(shader.vertexShader,'#include <common>',[
        'uniform float uPStudioWaterTime;','uniform float uPStudioWaterAmplitude;',
        'varying vec3 vPStudioWaterWorld;','varying vec3 vPStudioWaterLocal;','varying vec2 vPStudioWaterUV;'
      ].join('\n'));
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',[
        'float wa=sin(position.x*.071+position.z*.043+uPStudioWaterTime*.92);',
        'float wb=sin(position.x*.137-position.z*.091-uPStudioWaterTime*.67);',
        'float wc=sin(position.x*.31+position.z*.22+uPStudioWaterTime*1.43);',
        'float wx=uPStudioWaterAmplitude*(.071*cos(position.x*.071+position.z*.043+uPStudioWaterTime*.92)+.137*cos(position.x*.137-position.z*.091-uPStudioWaterTime*.67)+.31*cos(position.x*.31+position.z*.22+uPStudioWaterTime*1.43));',
        'float wz=uPStudioWaterAmplitude*(.043*cos(position.x*.071+position.z*.043+uPStudioWaterTime*.92)-.091*cos(position.x*.137-position.z*.091-uPStudioWaterTime*.67)+.22*cos(position.x*.31+position.z*.22+uPStudioWaterTime*1.43));',
        'objectNormal=normalize(vec3(-wx,1.0,-wz));'
      ].join('\n'));
      shader.vertexShader = addAfter(shader.vertexShader,'#include <begin_vertex>',[
        'float w1=sin(position.x*.071+position.z*.043+uPStudioWaterTime*.92);',
        'float w2=sin(position.x*.137-position.z*.091-uPStudioWaterTime*.67);',
        'float w3=sin(position.x*.31+position.z*.22+uPStudioWaterTime*1.43);',
        'transformed.y+=uPStudioWaterAmplitude*(.53*w1+.29*w2+.12*w3);'
      ].join('\n'));
      shader.vertexShader = addAfter(shader.vertexShader,'#include <worldpos_vertex>',[
        'vPStudioWaterWorld=(modelMatrix*vec4(transformed,1.0)).xyz;','vPStudioWaterLocal=position;','vPStudioWaterUV=uv;'
      ].join('\n'));
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <common>',[
        'uniform float uPStudioWaterTime;','uniform vec4 uPStudioWaterBounds;',
        'uniform vec3 uPStudioWaterShallow;','uniform vec3 uPStudioWaterDeep;','uniform vec3 uPStudioWaterFoam;',
        'uniform float uPStudioWaterMode;','varying vec3 vPStudioWaterWorld;','varying vec3 vPStudioWaterLocal;','varying vec2 vPStudioWaterUV;'
      ].join('\n'));
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <color_fragment>',[
        'vec2 wuv=(vPStudioWaterLocal.xz-uPStudioWaterBounds.xy)/max(uPStudioWaterBounds.zw,vec2(.001));',
        'vec2 wed=min(wuv,vec2(1.0)-wuv);float edge=clamp(min(wed.x,wed.y),0.0,.5);',
        'float depth=smoothstep(.012,.34,edge);',
        'float variation=.5+.5*sin(vPStudioWaterWorld.x*.043+sin(vPStudioWaterWorld.z*.037)*1.8);',
        'vec3 depthColor=mix(uPStudioWaterShallow,uPStudioWaterDeep,clamp(depth*.88+variation*.12,0.0,1.0));',
        'float ripple=sin(vPStudioWaterWorld.x*1.85+vPStudioWaterWorld.z*1.31+uPStudioWaterTime*2.0)*sin(vPStudioWaterWorld.z*1.63-vPStudioWaterWorld.x*.74-uPStudioWaterTime*1.43);',
        'float foamBand=(1.0-smoothstep(.018,.092,edge))*(.55+.45*sin(vPStudioWaterWorld.x*.46+vPStudioWaterWorld.z*.39+uPStudioWaterTime*1.6));',
        'if(uPStudioWaterMode<.5){diffuseColor.rgb=mix(diffuseColor.rgb,depthColor,.68);diffuseColor.rgb*=.96+.045*ripple;diffuseColor.rgb=mix(diffuseColor.rgb,uPStudioWaterFoam,clamp(foamBand*.62,0.0,.62));}',
        'else{float flow=.5+.5*sin(vPStudioWaterUV.y*110.0-uPStudioWaterTime*3.5+sin(vPStudioWaterUV.x*24.0)*2.2);diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.58,.88,.91),smoothstep(.74,.98,flow)*.45);}'
      ].join('\n'));
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <normal_fragment_maps>',[
        'vec3 rippleN=normalize(vec3(.13*cos(vPStudioWaterWorld.x*1.6+uPStudioWaterTime*1.8),1.0,.12*sin(vPStudioWaterWorld.z*1.4-uPStudioWaterTime*1.35)));',
        'normal=normalize(normal+(rippleN-vec3(0.0,1.0,0.0))*.10);'
      ].join('\n'));
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <roughnessmap_fragment>',
        'roughnessFactor=clamp(roughnessFactor+.035*(.5+.5*sin(vPStudioWaterWorld.x*2.0+vPStudioWaterWorld.z*1.7+uPStudioWaterTime)),.035,.34);');
    };
    material.customProgramCacheKey = () => 'pstudio-water-hq-v2-'+(waterfall?'fall':'surface')+(oldKey?oldKey():'');
    material.userData.pstudioWaterHQ = u;
    material.roughness = waterfall ? 0.12 : 0.075;
    material.metalness = 0.015;
    material.transparent = false; material.depthWrite = true;
    if ('clearcoat' in material) material.clearcoat = 0.9;
    water.add(material);
    return material;
  }

  function configureFoliage(material, object) {
    if (!material || material.userData.pstudioFoliageHQ) return material;
    if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial && !material.isMeshToonMaterial) return material;
    object?.geometry?.computeBoundingBox?.();
    const b=object?.geometry?.boundingBox, height=Math.max(.1,b?b.max.y-b.min.y:10), base=b?b.min.y:0;
    const u={time:{value:0},strength:{value:.42},height:{value:height},base:{value:base}};
    const old=material.onBeforeCompile, oldKey=material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      if(old)old.call(this,shader,renderer);
      Object.assign(shader.uniforms,{uPStudioWindTime:u.time,uPStudioWindStrength:u.strength,uPStudioFoliageHeight:u.height,uPStudioFoliageBaseY:u.base});
      shader.vertexShader=addAfter(shader.vertexShader,'#include <common>',[
        'uniform float uPStudioWindTime;','uniform float uPStudioWindStrength;','uniform float uPStudioFoliageHeight;','uniform float uPStudioFoliageBaseY;'
      ].join('\n'));
      shader.vertexShader=addAfter(shader.vertexShader,'#include <begin_vertex>',[
        'float fh=clamp((position.y-uPStudioFoliageBaseY)/max(.1,uPStudioFoliageHeight),0.0,1.0);',
        'float bend=pow(fh,1.55);',
        'float gust=sin(uPStudioWindTime*1.08+position.x*.24+position.z*.19);',
        'float detail=sin(uPStudioWindTime*2.47+position.x*1.9-position.z*1.57);',
        'transformed.x+=(gust*.34+detail*.045)*bend*uPStudioWindStrength;',
        'transformed.z+=(gust*.19+detail*.025)*bend*uPStudioWindStrength;'
      ].join('\n'));
    };
    material.customProgramCacheKey=()=>'pstudio-foliage-wind-v2-'+(oldKey?oldKey():'');
    material.userData.pstudioFoliageHQ=u;
    material.side=T()?.DoubleSide??material.side;
    if(material.alphaMap)material.alphaTest=Math.max(material.alphaTest||0,.28);
    foliage.add(material);
    return material;
  }

  function configureUnderwater(material) {
    if(!material || material.userData.pstudioCausticsHQ)return material;
    if(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial)return material;
    const u={time:{value:0},strength:{value:.30}},old=material.onBeforeCompile,oldKey=material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      if(old)old.call(this,shader,renderer);
      shader.uniforms.uPStudioCausticTime=u.time;shader.uniforms.uPStudioCausticStrength=u.strength;
      shader.vertexShader=addAfter(shader.vertexShader,'#include <common>','varying vec3 vPStudioCausticWorld;');
      shader.vertexShader=addAfter(shader.vertexShader,'#include <worldpos_vertex>','vPStudioCausticWorld=(modelMatrix*vec4(transformed,1.0)).xyz;');
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <common>','varying vec3 vPStudioCausticWorld;uniform float uPStudioCausticTime;uniform float uPStudioCausticStrength;');
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <color_fragment>',[
        'vec2 cuv=vPStudioCausticWorld.xz*.29;',
        'float ca=sin(cuv.x+sin(cuv.y+uPStudioCausticTime*.34)*2.1);',
        'float cb=sin(cuv.y*1.31-sin(cuv.x*.83-uPStudioCausticTime*.28)*1.8);',
        'float lines=pow(max(0.0,1.0-abs(ca*cb)),11.0);',
        'diffuseColor.rgb+=vec3(.16,.43,.39)*lines*.30*uPStudioCausticStrength;'
      ].join('\n'));
    };
    material.customProgramCacheKey=()=>'pstudio-underwater-caustics-v1-'+(oldKey?oldKey():'');
    material.userData.pstudioCausticsHQ=u;caustics.add(material);return material;
  }

  function configureParallax(material) {
    if(!material || material.userData.pstudioParallaxHQ || !material.normalMap || !material.map)return material;
    if(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial)return material;
    const previousCompile=material.onBeforeCompile,previousKey=material.customProgramCacheKey?.bind(material);
    const scale={value:Math.max(0,Math.min(.035,Number(material.userData.pstudioParallaxScale)||.012))};
    material.onBeforeCompile=function(shader,renderer){
      if(previousCompile)previousCompile.call(this,shader,renderer);
      shader.uniforms.uPStudioParallaxScale=scale;
      shader.vertexShader=addAfter(shader.vertexShader,'#include <common>','varying vec3 vPStudioParallaxViewPosition;');
      shader.vertexShader=addAfter(shader.vertexShader,'#include <project_vertex>','vPStudioParallaxViewPosition=-mvPosition.xyz;');
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <common>',[
        'uniform float uPStudioParallaxScale;',
        'varying vec3 vPStudioParallaxViewPosition;'
      ].join('\n'));
      const mapChunk=[
        '#ifdef USE_MAP',
        'vec2 pStudioParallaxUv=vMapUv;',
        '#ifdef USE_NORMALMAP',
        'vec3 pStudioN=normalize(vNormal);',
        'vec3 pStudioDp1=dFdx(vPStudioParallaxViewPosition);',
        'vec3 pStudioDp2=dFdy(vPStudioParallaxViewPosition);',
        'vec2 pStudioDu1=dFdx(vMapUv);',
        'vec2 pStudioDu2=dFdy(vMapUv);',
        'vec3 pStudioDp2perp=cross(pStudioDp2,pStudioN);',
        'vec3 pStudioDp1perp=cross(pStudioN,pStudioDp1);',
        'vec3 pStudioT=pStudioDp2perp*pStudioDu1.x+pStudioDp1perp*pStudioDu2.x;',
        'vec3 pStudioB=pStudioDp2perp*pStudioDu1.y+pStudioDp1perp*pStudioDu2.y;',
        'float pStudioInvMax=inversesqrt(max(dot(pStudioT,pStudioT),dot(pStudioB,pStudioB))+1e-8);',
        'mat3 pStudioTBN=mat3(pStudioT*pStudioInvMax,pStudioB*pStudioInvMax,pStudioN);',
        'vec3 pStudioViewTS=normalize(transpose(pStudioTBN)*normalize(-vPStudioParallaxViewPosition));',
        'vec2 pStudioOffset=(pStudioViewTS.xy/max(abs(pStudioViewTS.z),.18))*uPStudioParallaxScale;',
        'float pStudioLayer=0.0;',
        'const float pStudioLayers=8.0;',
        'vec2 pStudioStep=pStudioOffset/pStudioLayers;',
        'for(int pStudioI=0;pStudioI<8;pStudioI++){',
        'float pStudioHeight=texture2D(normalMap,vNormalMapUv+(pStudioParallaxUv-vMapUv)).a;',
        'if(pStudioLayer>=(1.0-pStudioHeight))break;',
        'pStudioParallaxUv-=pStudioStep;',
        'pStudioLayer+=1.0/pStudioLayers;',
        '}',
        '#endif',
        'vec4 sampledDiffuseColor=texture2D(map,pStudioParallaxUv);',
        '#ifdef DECODE_VIDEO_TEXTURE',
        'sampledDiffuseColor=sRGBTransferEOTF(sampledDiffuseColor);',
        '#endif',
        'diffuseColor*=sampledDiffuseColor;',
        '#endif'
      ].join('\n');
      shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',mapChunk);
    };
    material.customProgramCacheKey=()=>'pstudio-parallax-alpha-height-v2-'+(previousKey?previousKey():'');
    material.userData.pstudioParallaxHQ={scale:scale.value,heightSource:'normalTexture alpha',steps:8};
    parallaxMaterials.add(material);
    return material;
  }

  function configureObject(object) {
    if(!object?.isMesh||!object.material)return;
    const name=String(object.name||'');
    const mats=Array.isArray(object.material)?object.material:[object.material], out=[];
    for(const m of mats){
      if(!m){out.push(m);continue;}
      const tag=name+' '+String(m.name||'');
      if(WATER.test(tag)){const c=m.clone();configureWater(c,object,/waterfall|cascade|spray|foam/i.test(name));out.push(c);}
      else if(UNDER.test(name)){configureUnderwater(m);out.push(m);}
      else if(LEAF.test(name)||/detailed.*foliage/i.test(m.name||'')){configureFoliage(m,object);out.push(m);}
      else if(/wood|timber|bark|plank|carpentry|joinery|dock|pier|ship|junk|pagoda|bridge|rock|limestone|cliff|stone|roof|tile/i.test(tag)){
        const c=m.clone();
        if(/wood|timber|bark|plank|carpentry|joinery|dock|pier|ship|junk|pagoda|bridge/i.test(tag)){if('roughness'in c)c.roughness=Math.max(.56,Number(c.roughness)||.68);if('metalness'in c)c.metalness=Math.min(.08,Number(c.metalness)||0);if(c.normalScale)c.normalScale.set(.78,.78);}
        configureParallax(c);out.push(c);
      } else out.push(m);
    }
    object.material=Array.isArray(object.material)?out:out[0];
  }

  function update(time) {
    const t=Number(time)||0;
    for(const m of water){const u=m.userData.pstudioWaterHQ;if(u)u.time.value=t;}
    for(const m of foliage){const u=m.userData.pstudioFoliageHQ;if(u)u.time.value=t;}
    for(const m of caustics){const u=m.userData.pstudioCausticsHQ;if(u)u.time.value=t;}
  }

  function createVolumetricFogPass(FX,Three) {
    if(!FX?.ShaderPass||!Three?.DepthTexture)return null;
    const shader={
      uniforms:{
        tDiffuse:{value:null},tDepth:{value:null},uInverseProjection:{value:new Three.Matrix4()},
        uCameraWorld:{value:new Three.Matrix4()},uFogColor:{value:new Three.Color('#b9d8d9')},
        uFogDensity:{value:.012},uHeightFalloff:{value:.018},uBaseHeight:{value:0},
        uTime:{value:0},uSunDirection:{value:new Three.Vector3(-.35,.82,-.44).normalize()}
      },
      vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:[
        'uniform sampler2D tDiffuse;uniform sampler2D tDepth;',
        'uniform mat4 uInverseProjection;uniform mat4 uCameraWorld;',
        'uniform vec3 uFogColor;uniform vec3 uSunDirection;',
        'uniform float uFogDensity;uniform float uHeightFalloff;uniform float uBaseHeight;uniform float uTime;',
        'varying vec2 vUv;',
        'float noise3(vec3 p){return .5+.5*sin(p.x*.73+sin(p.y*.51+p.z*.91)*1.7+uTime*.025);}',
        'void main(){',
        'vec4 col=texture2D(tDiffuse,vUv);float z=texture2D(tDepth,vUv).x;',
        'if(z>=.99999||uFogDensity<=.00001){gl_FragColor=col;return;}',
        'vec4 q=uInverseProjection*vec4(vUv*2.0-1.0,z*2.0-1.0,1.0);vec3 vp=q.xyz/max(1e-6,q.w);',
        'vec3 origin=uCameraWorld[3].xyz;vec3 endp=(uCameraWorld*vec4(vp,1.0)).xyz;',
        'vec3 ray=endp-origin;float len=length(ray);vec3 dir=ray/max(len,1e-5);',
        'float optical=0.0;vec3 scatter=vec3(0.0);const int STEPS=12;float ds=len/float(STEPS);',
        'for(int i=0;i<STEPS;i++){float f=(float(i)+.5)/float(STEPS);vec3 p=origin+dir*(len*f);',
        'float h=max(0.0,p.y-uBaseHeight);float density=uFogDensity*exp(-h*uHeightFalloff);density*=mix(.76,1.12,noise3(p*.07));',
        'float seg=density*ds;float trans=exp(-optical);float phase=.72+.28*pow(max(dot(-dir,normalize(uSunDirection)),0.0),3.0);',
        'scatter+=uFogColor*trans*(1.0-exp(-seg))*phase;optical+=seg;}',
        'float trans=exp(-optical);gl_FragColor=vec4(col.rgb*trans+scatter,col.a);}'
      ].join('\n')
    };
    const pass=new FX.ShaderPass(shader);pass.enabled=false;
    const render=pass.render.bind(pass);
    pass.render=function(renderer,writeBuffer,readBuffer,delta,mask){this.uniforms.tDepth.value=readBuffer?.depthTexture||null;render(renderer,writeBuffer,readBuffer,delta,mask);};
    return pass;
  }

  window.PStudioEnvironmentFX={
    configureObject,configureWater,configureFoliage,configureUnderwater,configureParallax,update,createVolumetricFogPass,
    releaseMaterial(material){water.delete(material);foliage.delete(material);caustics.delete(material);parallaxMaterials.delete(material);},
    getStats:()=>({waterMaterials:water.size,foliageMaterials:foliage.size,causticMaterials:caustics.size,parallaxMaterials:parallaxMaterials.size})
  };
})();