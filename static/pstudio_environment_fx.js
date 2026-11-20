/* PStudio Environment FX: water, foliage, underwater caustics and volumetric depth fog. */
(() => {
  'use strict';
  const T = () => window.THREE;
  const water = new Set(), foliage = new Set(), caustics = new Set(), parallaxMaterials = new Set(), triplanarMaterials = new Set(), cloudPasses = new Set();
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
      sceneDepth:{value:null},viewport:{value:new Three.Vector2(1,1)},near:{value:.1},far:{value:1600},sceneDepthValid:{value:0},
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
        uPStudioWaterShallow:u.shallow,uPStudioWaterDeep:u.deep,uPStudioWaterFoam:u.foam,uPStudioWaterMode:u.mode,
        uPStudioSceneDepth:u.sceneDepth,uPStudioWaterViewport:u.viewport,uPStudioCameraNear:u.near,uPStudioCameraFar:u.far,uPStudioSceneDepthValid:u.sceneDepthValid
      });
      shader.vertexShader = addAfter(shader.vertexShader,'#include <common>',[
        'uniform float uPStudioWaterTime;','uniform float uPStudioWaterAmplitude;',
        'varying vec3 vPStudioWaterWorld;','varying vec3 vPStudioWaterLocal;','varying vec2 vPStudioWaterUV;','varying vec4 vPStudioWaterClip;'
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
      shader.vertexShader = addAfter(shader.vertexShader,'#include <project_vertex>','vPStudioWaterClip=gl_Position;');
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <common>',[
        'uniform float uPStudioWaterTime;','uniform vec4 uPStudioWaterBounds;',
        'uniform vec3 uPStudioWaterShallow;','uniform vec3 uPStudioWaterDeep;','uniform vec3 uPStudioWaterFoam;',
        'uniform float uPStudioWaterMode;','uniform sampler2D uPStudioSceneDepth;','uniform vec2 uPStudioWaterViewport;','uniform float uPStudioCameraNear;','uniform float uPStudioCameraFar;','uniform float uPStudioSceneDepthValid;','varying vec3 vPStudioWaterWorld;','varying vec3 vPStudioWaterLocal;','varying vec2 vPStudioWaterUV;','varying vec4 vPStudioWaterClip;'
      ].join('\n'));
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <color_fragment>',[
        'vec2 wuv=(vPStudioWaterLocal.xz-uPStudioWaterBounds.xy)/max(uPStudioWaterBounds.zw,vec2(.001));',
        'vec2 wed=min(wuv,vec2(1.0)-wuv);float edge=clamp(min(wed.x,wed.y),0.0,.5);',
        'float depth=smoothstep(.012,.34,edge);',
        'float foamBand=(1.0-smoothstep(.018,.092,edge))*(.55+.45*sin(vPStudioWaterWorld.x*.46+vPStudioWaterWorld.z*.39+uPStudioWaterTime*1.6));',
        'if(uPStudioSceneDepthValid>.5){',
        'float sceneRaw=texture2D(uPStudioSceneDepth,gl_FragCoord.xy/max(uPStudioWaterViewport,vec2(1.0))).x;',
        'float waterRaw=gl_FragCoord.z;',
        'float sceneZ=sceneRaw*2.0-1.0;float waterZ=waterRaw*2.0-1.0;',
        'float sceneLinear=(2.0*uPStudioCameraNear*uPStudioCameraFar)/max(1e-5,uPStudioCameraFar+uPStudioCameraNear-sceneZ*(uPStudioCameraFar-uPStudioCameraNear));',
        'float waterLinear=(2.0*uPStudioCameraNear*uPStudioCameraFar)/max(1e-5,uPStudioCameraFar+uPStudioCameraNear-waterZ*(uPStudioCameraFar-uPStudioCameraNear));',
        'float waterThickness=max(0.0,sceneLinear-waterLinear);',
        'depth=smoothstep(.18,10.0,waterThickness);',
        'float shorelineFoam=1.0-smoothstep(.035,.95,waterThickness);',
        'foamBand=max(foamBand*.22,shorelineFoam*(.58+.42*sin(vPStudioWaterWorld.x*.61+vPStudioWaterWorld.z*.47+uPStudioWaterTime*1.8)));',
        '}',
        'float variation=.5+.5*sin(vPStudioWaterWorld.x*.043+sin(vPStudioWaterWorld.z*.037)*1.8);',
        'vec3 depthColor=mix(uPStudioWaterShallow,uPStudioWaterDeep,clamp(depth*.88+variation*.12,0.0,1.0));',
        'float ripple=sin(vPStudioWaterWorld.x*1.85+vPStudioWaterWorld.z*1.31+uPStudioWaterTime*2.0)*sin(vPStudioWaterWorld.z*1.63-vPStudioWaterWorld.x*.74-uPStudioWaterTime*1.43);',
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
    if(object?.userData)object.userData.pstudioWaterSurface=true;
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

  function configureTriplanar(material,object) {
    if(!material || material.userData.pstudioTriplanarHQ || !material.map)return material;
    if(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial)return material;
    const name=String(object?.name||'');
    const scaleValue=/meadow|grass|groundcover|terrace/i.test(name)?0.115:0.082;
    const u={scale:{value:scaleValue},sharpness:{value:4.0},normalWeight:{value:0.72}};
    const old=material.onBeforeCompile,oldKey=material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      if(old)old.call(this,shader,renderer);
      shader.uniforms.uPStudioTriplanarScale=u.scale;
      shader.uniforms.uPStudioTriplanarSharpness=u.sharpness;
      shader.uniforms.uPStudioTriplanarNormalWeight=u.normalWeight;
      shader.vertexShader=addAfter(shader.vertexShader,'#include <common>',[
        'varying vec3 vPStudioTriWorldPosition;',
        'varying vec3 vPStudioTriWorldNormal;'
      ].join('\n'));
      shader.vertexShader=addAfter(shader.vertexShader,'#include <begin_vertex>',[
        'vec4 pStudioTriWorld=modelMatrix*vec4(transformed,1.0);',
        '#ifdef USE_INSTANCING',
        'pStudioTriWorld=modelMatrix*instanceMatrix*vec4(transformed,1.0);',
        'vPStudioTriWorldNormal=normalize(mat3(modelMatrix*instanceMatrix)*objectNormal);',
        '#else',
        'vPStudioTriWorldNormal=normalize(mat3(modelMatrix)*objectNormal);',
        '#endif',
        'vPStudioTriWorldPosition=pStudioTriWorld.xyz;'
      ].join('\n'));
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <common>',[
        'uniform float uPStudioTriplanarScale;',
        'uniform float uPStudioTriplanarSharpness;',
        'uniform float uPStudioTriplanarNormalWeight;',
        'varying vec3 vPStudioTriWorldPosition;',
        'varying vec3 vPStudioTriWorldNormal;',
        'vec3 pStudioTriWeights(vec3 n){vec3 w=pow(abs(normalize(n)),vec3(uPStudioTriplanarSharpness));return w/max(w.x+w.y+w.z,1e-5);}'
      ].join('\n'));
      shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',[
        '#ifdef USE_MAP',
        'vec3 pStudioTriW=pStudioTriWeights(vPStudioTriWorldNormal);',
        'vec2 pStudioTriX=vPStudioTriWorldPosition.zy*uPStudioTriplanarScale;',
        'vec2 pStudioTriY=vPStudioTriWorldPosition.xz*uPStudioTriplanarScale;',
        'vec2 pStudioTriZ=vPStudioTriWorldPosition.xy*uPStudioTriplanarScale;',
        'vec4 pStudioTriColor=texture2D(map,pStudioTriX)*pStudioTriW.x+texture2D(map,pStudioTriY)*pStudioTriW.y+texture2D(map,pStudioTriZ)*pStudioTriW.z;',
        'diffuseColor*=pStudioTriColor;',
        '#endif'
      ].join('\n'));
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <normal_fragment_maps>',[
        '#ifdef USE_NORMALMAP',
        'vec3 pStudioTriWn=pStudioTriWeights(vPStudioTriWorldNormal);',
        'vec3 pStudioN_X=texture2D(normalMap,vPStudioTriWorldPosition.zy*uPStudioTriplanarScale).xyz*2.0-1.0;',
        'vec3 pStudioN_Y=texture2D(normalMap,vPStudioTriWorldPosition.xz*uPStudioTriplanarScale).xyz*2.0-1.0;',
        'vec3 pStudioN_Z=texture2D(normalMap,vPStudioTriWorldPosition.xy*uPStudioTriplanarScale).xyz*2.0-1.0;',
        'pStudioN_X.xy*=normalScale;pStudioN_Y.xy*=normalScale;pStudioN_Z.xy*=normalScale;',
        'vec3 pStudioWorldN_X=normalize(vec3(sign(vPStudioTriWorldNormal.x)*pStudioN_X.z,pStudioN_X.y,pStudioN_X.x));',
        'vec3 pStudioWorldN_Y=normalize(vec3(pStudioN_Y.x,sign(vPStudioTriWorldNormal.y)*pStudioN_Y.z,pStudioN_Y.y));',
        'vec3 pStudioWorldN_Z=normalize(vec3(pStudioN_Z.x,pStudioN_Z.y,sign(vPStudioTriWorldNormal.z)*pStudioN_Z.z));',
        'vec3 pStudioTriNormal=normalize(pStudioWorldN_X*pStudioTriWn.x+pStudioWorldN_Y*pStudioTriWn.y+pStudioWorldN_Z*pStudioTriWn.z);',
        'normal=normalize(mix(normal,normalize(mat3(viewMatrix)*pStudioTriNormal),uPStudioTriplanarNormalWeight));',
        '#endif'
      ].join('\n'));
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <roughnessmap_fragment>',[
        '#ifdef USE_ROUGHNESSMAP',
        'vec3 pStudioTriWr=pStudioTriWeights(vPStudioTriWorldNormal);',
        'float pStudioR=texture2D(roughnessMap,vPStudioTriWorldPosition.zy*uPStudioTriplanarScale).g*pStudioTriWr.x+texture2D(roughnessMap,vPStudioTriWorldPosition.xz*uPStudioTriplanarScale).g*pStudioTriWr.y+texture2D(roughnessMap,vPStudioTriWorldPosition.xy*uPStudioTriplanarScale).g*pStudioTriWr.z;',
        'roughnessFactor=pStudioR;',
        '#endif'
      ].join('\n'));
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <metalnessmap_fragment>',[
        '#ifdef USE_METALNESSMAP',
        'vec3 pStudioTriWm=pStudioTriWeights(vPStudioTriWorldNormal);',
        'float pStudioM=texture2D(metalnessMap,vPStudioTriWorldPosition.zy*uPStudioTriplanarScale).b*pStudioTriWm.x+texture2D(metalnessMap,vPStudioTriWorldPosition.xz*uPStudioTriplanarScale).b*pStudioTriWm.y+texture2D(metalnessMap,vPStudioTriWorldPosition.xy*uPStudioTriplanarScale).b*pStudioTriWm.z;',
        'metalnessFactor=pStudioM;',
        '#endif'
      ].join('\n'));
    };
    material.customProgramCacheKey=()=>'pstudio-world-triplanar-pbr-v1-'+(oldKey?oldKey():'');
    material.userData.pstudioTriplanarHQ={scale:scaleValue,sharpness:4.0,normalWeight:.72,projection:'world-space'};
    triplanarMaterials.add(material);
    return material;
  }

  function configureObject(object) {
    if(!object?.isMesh||!object.material)return;
    const name=String(object.name||'');
    const mats=Array.isArray(object.material)?object.material:[object.material],out=[];
    for(const m of mats){
      if(!m){out.push(m);continue;}
      const tag=name+' '+String(m.name||'');
      if(WATER.test(tag)){const c=m.clone();configureWater(c,object,/waterfall|cascade|spray|foam/i.test(name));out.push(c);}
      else if(UNDER.test(name)){configureUnderwater(m);out.push(m);}
      else if(object.userData?.pstudioWindPart==='leaf'||object.userData?.pstudioWindPart==='branch'){out.push(m);}
      else if(m.userData?.pstudioSurfaceMode==='triplanar-pbr'||m.userData?.pstudioRole==='grass'||m.userData?.pstudioRole==='rock'||/limestone|cliff|escarpment|terrain|groundcover|meadow|terraced_emerald|rockface|stonewall/i.test(tag)){const c=m.clone();configureTriplanar(c,object);out.push(c);}
      else if(/leaf|foliage|canopy|wildflower|bush|shrub|needle/i.test(tag)){const c=m.clone();configureFoliage(c,object);out.push(c);}
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
    for(const m of caustics){const u=m.userData.pstudioCausticsHQ;if(u)u.time.value=t;}for(const pass of cloudPasses)if(pass.uniforms?.uTime)pass.uniforms.uTime.value=t;
  }

  function createVolumetricCloudPass(FX,Three) {
    if(!FX?.ShaderPass||!Three?.DepthTexture)return null;
    const shader={
      uniforms:{
        tDiffuse:{value:null},tDepth:{value:null},uInverseProjection:{value:new Three.Matrix4()},
        uCameraWorld:{value:new Three.Matrix4()},uFogColor:{value:new Three.Color('#bfe2eb')},
        uSunDirection:{value:new Three.Vector3(-.42,.78,-.46).normalize()},uTime:{value:0},
        uCloudBase:{value:54},uCloudTop:{value:108},uCloudDensity:{value:.78},uCloudScale:{value:.0095},
        uAtmosphereStrength:{value:.96}
      },
      vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:[
        'uniform sampler2D tDiffuse;uniform sampler2D tDepth;',
        'uniform mat4 uInverseProjection;uniform mat4 uCameraWorld;',
        'uniform vec3 uFogColor;uniform vec3 uSunDirection;',
        'uniform float uTime;uniform float uCloudBase;uniform float uCloudTop;uniform float uCloudDensity;uniform float uCloudScale;uniform float uAtmosphereStrength;',
        'varying vec2 vUv;',
        'float pHash(vec3 p){p=fract(p*.3183099+vec3(.1,.17,.13));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}',
        'float pNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);',
        'float n000=pHash(i);float n100=pHash(i+vec3(1,0,0));float n010=pHash(i+vec3(0,1,0));float n110=pHash(i+vec3(1,1,0));',
        'float n001=pHash(i+vec3(0,0,1));float n101=pHash(i+vec3(1,0,1));float n011=pHash(i+vec3(0,1,1));float n111=pHash(i+vec3(1,1,1));',
        'return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);}',
        'float pFbm(vec3 p){float n=0.0;float a=.56;for(int i=0;i<4;i++){n+=pNoise(p)*a;p=p*2.03+vec3(7.1,3.7,5.3);a*=.5;}return n/1.0625;}',
        'void main(){',
        'vec4 source=texture2D(tDiffuse,vUv);float depth=texture2D(tDepth,vUv).x;',
        'vec4 clip=vec4(vUv*2.0-1.0,1.0,1.0);vec4 viewH=uInverseProjection*clip;vec3 viewRay=normalize(viewH.xyz/max(abs(viewH.w),1e-5));',
        'vec3 ray=normalize(mat3(uCameraWorld)*viewRay);vec3 origin=uCameraWorld[3].xyz;',
        'float horizon=pow(1.0-clamp(max(ray.y,0.0),0.0,1.0),3.2);',
        'vec3 atmosphere=mix(vec3(.22,.55,.76),uFogColor,horizon);',
        'float sunGlow=pow(max(dot(ray,normalize(uSunDirection)),0.0),38.0);',
        'vec3 skyColor=atmosphere+vec3(.23,.20,.13)*sunGlow;',
        'if(depth<.99999){gl_FragColor=source;return;}',
        'float cloudAlpha=0.0;vec3 cloudColor=vec3(0.0);',
        'if(ray.y>.025){float t0=(uCloudBase-origin.y)/ray.y;float t1=(uCloudTop-origin.y)/ray.y;',
        'float begin=max(0.0,min(t0,t1));float finish=max(t0,t1);',
        'if(finish>begin){float span=finish-begin;float stepLen=span/22.0;float trans=1.0;',
        'for(int i=0;i<22;i++){float t=begin+(float(i)+.5)*stepLen;vec3 p=origin+ray*t;',
        'vec3 q=p*uCloudScale+vec3(-uTime*.006,0.0,uTime*.0028);',
        'float large=pFbm(q);float detail=pFbm(q*3.1+vec3(12.0,4.0,7.0));',
        'float vertical=smoothstep(uCloudBase,uCloudBase+9.0,p.y)*(1.0-smoothstep(uCloudTop-14.0,uCloudTop,p.y));',
        'float density=smoothstep(.49,.72,large+detail*.12)*vertical*uCloudDensity;',
        'float alpha=1.0-exp(-density*stepLen*.028);',
        'float light=.64+.36*pow(max(dot(normalize(uSunDirection),normalize(vec3(.22,.72,.31))),0.0),2.0);',
        'vec3 lit=mix(vec3(.48,.66,.72),vec3(.98,1.0,.97),clamp(light+detail*.15,0.0,1.0));',
        'cloudColor+=lit*alpha*trans;trans*=1.0-alpha;if(trans<.025)break;',
        '}cloudAlpha=1.0-trans;}}',
        'vec3 finalSky=mix(skyColor,cloudColor,cloudAlpha)+vec3(.23,.2,.16)*sunGlow*.22;',
        'gl_FragColor=vec4(mix(source.rgb,finalSky,clamp(uAtmosphereStrength,0.0,1.0)),source.a);',
        '}'
      ].join('\n')
    };
    const pass=new FX.ShaderPass(shader);
    const originalRender=pass.render.bind(pass);
    pass.enabled=false;
    pass.render=function(renderer,writeBuffer,readBuffer,delta,mask){if(!this.uniforms.tDepth.value)this.uniforms.tDepth.value=readBuffer?.depthTexture||null;originalRender(renderer,writeBuffer,readBuffer,delta,mask);};
    cloudPasses.add(pass);
    return pass;
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
    configureObject,configureWater,configureFoliage,configureUnderwater,configureParallax,configureTriplanar,update,createVolumetricFogPass,createVolumetricCloudPass,
    setSceneDepthTexture(texture,width,height,near,far){for(const material of water){const u=material.userData?.pstudioWaterHQ;if(!u)continue;u.sceneDepth.value=texture||null;u.viewport.value.set(Math.max(1,width||1),Math.max(1,height||1));u.near.value=Math.max(.001,near||.1);u.far.value=Math.max(u.near.value+1,far||1600);u.sceneDepthValid.value=texture?1:0;}},
    releaseMaterial(material){water.delete(material);foliage.delete(material);caustics.delete(material);parallaxMaterials.delete(material);triplanarMaterials.delete(material);},
    getStats:()=>({waterMaterials:water.size,foliageMaterials:foliage.size,causticMaterials:caustics.size,parallaxMaterials:parallaxMaterials.size,triplanarMaterials:triplanarMaterials.size,cloudPasses:cloudPasses.size})
  };
})();