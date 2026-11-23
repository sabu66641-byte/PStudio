/* PStudio Environment FX: water, foliage, underwater caustics and volumetric depth fog. */
(() => {
  'use strict';
  const T = () => window.THREE;
  const water = new Set(), waterDetailMaterials = new Set(), foliage = new Set(), caustics = new Set(), parallaxMaterials = new Set(), triplanarMaterials = new Set(), terrainMaterials = new Set(), cloudPasses = new Set(), fogPasses = new Set();
  const has = (text, re) => re.test(String(text || ''));
  const addAfter = (source, token, code) => source.includes(token) ? source.replace(token, token + '\n' + code) : source;
  const WATER = /water|river|lake|ocean|sea|lagoon|cascade|waterfall|foam|spray/i;
  const LEAF = /tree|foliage|leaf|leaves|canopy|grass|meadow|wildflower|pine|bush|shrub/i;
  const UNDER = /submerged|underwater|reef|riverbed|seabed|waterbed/i;

  function configureWaterDetail(material,object) {
    if(!material || material.userData.pstudioWaterDetailHQ)return material;
    if(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial)return material;
    const role=String(object?.userData?.pstudioWaterDetail||'micro-ripple');
    const type=role==='spray-particles'?2:role==='shoreline-foam'?1:0;
    const u={time:{value:0},type:{value:type},strength:{value:type === 0 ? 0.72 : type === 1 ? 0.54 : 0.38}};
    const old=material.onBeforeCompile,oldKey=material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      if(old)old.call(this,shader,renderer);
      Object.assign(shader.uniforms,{uPStudioWaterDetailTime:u.time,uPStudioWaterDetailType:u.type,uPStudioWaterDetailStrength:u.strength});
      shader.vertexShader=addAfter(shader.vertexShader,'#include <common>',[
        'uniform float uPStudioWaterDetailTime;',
        'uniform float uPStudioWaterDetailType;',
        'varying vec3 vPStudioWaterDetailWorld;'
      ].join('\n'));
      shader.vertexShader=addAfter(shader.vertexShader,'#include <begin_vertex>',[
        'float detailWave=sin(position.x*1.7+position.z*1.13+uPStudioWaterDetailTime*1.7);',
        'float detailWave2=sin(position.x*.71-position.z*1.91-uPStudioWaterDetailTime*1.13);',
        'float detailMove=mix(.009,.002,uPStudioWaterDetailType);',
        'transformed.y+=detailMove*(detailWave*.65+detailWave2*.35);'
      ].join('\n'));
      shader.vertexShader=addAfter(shader.vertexShader,'#include <project_vertex>',[
        'vec4 pStudioDetailWorld=modelMatrix*vec4(transformed,1.0);',
        '#ifdef USE_INSTANCING',
        'pStudioDetailWorld=modelMatrix*instanceMatrix*vec4(transformed,1.0);',
        '#endif',
        'vPStudioWaterDetailWorld=pStudioDetailWorld.xyz;'
      ].join('\n'));
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <common>',[
        'uniform float uPStudioWaterDetailTime;',
        'uniform float uPStudioWaterDetailType;',
        'uniform float uPStudioWaterDetailStrength;',
        'varying vec3 vPStudioWaterDetailWorld;'
      ].join('\n'));
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <color_fragment>',[
        'float detailPhase=vPStudioWaterDetailWorld.x*.47+vPStudioWaterDetailWorld.z*.39+uPStudioWaterDetailTime*(1.1+uPStudioWaterDetailType*.35);',
        'float glint=pow(max(0.0,sin(detailPhase)*.5+.5),uPStudioWaterDetailType<.5?8.0:4.0);',
        'float detailPulse=.82+.18*(.5+.5*sin(detailPhase*1.37));',
        'diffuseColor.rgb+=vec3(.035,.105,.12)*glint*uPStudioWaterDetailStrength;',
        'diffuseColor.a*=mix(detailPulse,.72+.28*glint,uPStudioWaterDetailType>.5?1.0:.0);'
      ].join('\n'));
    };
    material.customProgramCacheKey=()=>'pstudio-water-detail-hq-v1-'+role+(oldKey?oldKey():'');
    material.userData.pstudioWaterDetailHQ=u;
    material.transparent=true;
    material.depthWrite=false;
    material.side=T()?.DoubleSide??material.side;
    material.roughness=Math.max(.12,Number(material.roughness)||.24);
    waterDetailMaterials.add(material);
    if(object){object.renderOrder=type===2?5:3;object.userData.pstudioTransparentDetail=true;}
    return material;
  }

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
      mode:{value:waterfall?1:0},reflection:{value:new Three.Color('#b8d9e8')},absorption:{value:0.19}
    };
    const old = material.onBeforeCompile, oldKey = material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile = function(shader, renderer) {
      if (old) old.call(this,shader,renderer);
      Object.assign(shader.uniforms,{
        uPStudioWaterTime:u.time,uPStudioWaterAmplitude:u.amplitude,uPStudioWaterBounds:u.bounds,
        uPStudioWaterShallow:u.shallow,uPStudioWaterDeep:u.deep,uPStudioWaterFoam:u.foam,uPStudioWaterMode:u.mode,
        uPStudioSceneDepth:u.sceneDepth,uPStudioWaterViewport:u.viewport,uPStudioCameraNear:u.near,uPStudioCameraFar:u.far,uPStudioSceneDepthValid:u.sceneDepthValid,
        uPStudioWaterReflectionTint:u.reflection,uPStudioWaterAbsorption:u.absorption
      });
      shader.vertexShader = addAfter(shader.vertexShader,'#include <common>',[
        'uniform float uPStudioWaterTime;','uniform float uPStudioWaterAmplitude;',
        'varying vec3 vPStudioWaterWorld;','varying vec3 vPStudioWaterLocal;','varying vec2 vPStudioWaterUV;','varying vec4 vPStudioWaterClip;'
      ].join('\n'));
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',[
        'float wp1=position.x*.071+position.z*.043+uPStudioWaterTime*.92;',
        'float wp2=position.x*.137-position.z*.091-uPStudioWaterTime*.67;',
        'float wp3=position.x*.31+position.z*.22+uPStudioWaterTime*1.43;',
        'float wp4=position.x*.49-position.z*.37+uPStudioWaterTime*2.07;',
         'float wp5=position.x*.018+position.z*.026+uPStudioWaterTime*.23;',
        'float wx=uPStudioWaterAmplitude*(.071*.52*cos(wp1)+.137*.27*cos(wp2)+.31*.14*cos(wp3)+.49*.07*cos(wp4)+.018*.18*cos(wp5));',
        'float wz=uPStudioWaterAmplitude*(.043*.52*cos(wp1)-.091*.27*cos(wp2)+.22*.14*cos(wp3)-.37*.07*cos(wp4)+.026*.18*cos(wp5));',
        'objectNormal=normalize(vec3(-wx,1.0,-wz));'
      ].join('\n'));
      shader.vertexShader = addAfter(shader.vertexShader,'#include <begin_vertex>',[
        'float wp1=position.x*.071+position.z*.043+uPStudioWaterTime*.92;',
        'float wp2=position.x*.137-position.z*.091-uPStudioWaterTime*.67;',
        'float wp3=position.x*.31+position.z*.22+uPStudioWaterTime*1.43;',
        'float wp4=position.x*.49-position.z*.37+uPStudioWaterTime*2.07;',
        'transformed.y+=uPStudioWaterAmplitude*(.52*sin(wp1)+.27*sin(wp2)+.14*sin(wp3)+.07*sin(wp4));'
      ].join('\n'));
      shader.vertexShader = addAfter(shader.vertexShader,'#include <worldpos_vertex>',[
        'vPStudioWaterWorld=(modelMatrix*vec4(transformed,1.0)).xyz;','vPStudioWaterLocal=position;','vPStudioWaterUV=uv;'
      ].join('\n'));
      shader.vertexShader = addAfter(shader.vertexShader,'#include <project_vertex>','vPStudioWaterClip=gl_Position;');
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <common>',[
        'uniform float uPStudioWaterTime;','uniform vec4 uPStudioWaterBounds;',
        'uniform vec3 uPStudioWaterShallow;','uniform vec3 uPStudioWaterDeep;','uniform vec3 uPStudioWaterFoam;',
        'uniform float uPStudioWaterMode;','uniform vec3 uPStudioWaterReflectionTint;','uniform float uPStudioWaterAbsorption;','uniform sampler2D uPStudioSceneDepth;','uniform vec2 uPStudioWaterViewport;','uniform float uPStudioCameraNear;','uniform float uPStudioCameraFar;','uniform float uPStudioSceneDepthValid;','varying vec3 vPStudioWaterWorld;','varying vec3 vPStudioWaterLocal;','varying vec2 vPStudioWaterUV;','varying vec4 vPStudioWaterClip;'
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
        'depth=1.0-exp(-waterThickness*uPStudioWaterAbsorption);',
        'float shorelineFoam=1.0-smoothstep(.035,.95,waterThickness);',
        'float foamNoise=.5+.5*sin(vPStudioWaterWorld.x*.61+vPStudioWaterWorld.z*.47+uPStudioWaterTime*1.8)*sin(vPStudioWaterWorld.z*.83-vPStudioWaterWorld.x*.39-uPStudioWaterTime*1.13);',
         'foamBand=max(foamBand*.22,shorelineFoam*(.52+.48*foamNoise));',
        '}',
        'float variation=.5+.5*sin(vPStudioWaterWorld.x*.043+sin(vPStudioWaterWorld.z*.037)*1.8);',
        'vec3 depthColor=mix(uPStudioWaterShallow,uPStudioWaterDeep,clamp(depth*.88+variation*.12,0.0,1.0));',
        'float ripple=sin(vPStudioWaterWorld.x*1.85+vPStudioWaterWorld.z*1.31+uPStudioWaterTime*2.0)*sin(vPStudioWaterWorld.z*1.63-vPStudioWaterWorld.x*.74-uPStudioWaterTime*1.43);',
         'float crestFoam=smoothstep(.91,.995,.5+.5*sin(vPStudioWaterWorld.x*.31+vPStudioWaterWorld.z*.27+uPStudioWaterTime*1.22))*.11;',
         'foamBand=max(foamBand,crestFoam);',
        'if(uPStudioWaterMode<.5){diffuseColor.rgb=mix(diffuseColor.rgb,depthColor,.68);diffuseColor.rgb*=.96+.045*ripple;diffuseColor.rgb=mix(diffuseColor.rgb,uPStudioWaterFoam,clamp(foamBand*.62,0.0,.62));}',
        'else{float flow=.5+.5*sin(vPStudioWaterUV.y*110.0-uPStudioWaterTime*3.5+sin(vPStudioWaterUV.x*24.0)*2.2);diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.58,.88,.91),smoothstep(.74,.98,flow)*.45);}'
      ].join('\n'));
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <normal_fragment_maps>',[
        'float microA=sin(vPStudioWaterWorld.x*1.72+vPStudioWaterWorld.z*1.31+uPStudioWaterTime*2.4);',
        'float microB=sin(vPStudioWaterWorld.z*1.94-vPStudioWaterWorld.x*.83-uPStudioWaterTime*1.8);',
        'float crossRipple=sin((vPStudioWaterWorld.x+vPStudioWaterWorld.z)*3.1+uPStudioWaterTime*2.9);',
        'vec3 rippleN=normalize(vec3(.095*microA+.028*crossRipple,1.0,.09*microB-.024*crossRipple));',
        'normal=normalize(normal+(rippleN-vec3(0.0,1.0,0.0))*.18);',
         'float viewFacing=clamp(dot(normalize(normal),normalize(vViewPosition)),0.0,1.0);',
         'float fresnel=pow(1.0-viewFacing,5.0);',
         'float crest=.5+.5*sin(vPStudioWaterWorld.x*.31+vPStudioWaterWorld.z*.27+uPStudioWaterTime*1.22);',
         'diffuseColor.rgb=mix(diffuseColor.rgb,uPStudioWaterReflectionTint,clamp(fresnel*.28,0.0,.28));',
         'diffuseColor.rgb+=uPStudioWaterReflectionTint*pow(max(crest,0.0),18.0)*.012;'
      ].join('\n'));
      shader.fragmentShader = addAfter(shader.fragmentShader,'#include <roughnessmap_fragment>',
        'roughnessFactor=clamp(roughnessFactor+.035*(.5+.5*sin(vPStudioWaterWorld.x*2.0+vPStudioWaterWorld.z*1.7+uPStudioWaterTime)),.035,.34);');
    };
    material.customProgramCacheKey = () => 'pstudio-water-hq-v3-'+(waterfall?'fall':'surface')+(oldKey?oldKey():'');
    material.userData.pstudioWaterHQ = u;
    if(object?.userData)object.userData.pstudioWaterSurface=true;
    material.roughness = waterfall ? 0.12 : 0.075;
    material.metalness = 0.015;
    material.transparent = false; material.depthWrite = true;
    if ('clearcoat' in material) material.clearcoat = 0.9;
    water.add(material);
    return material;
  }

  function configureFoliage(material,object) {
    if(!material || material.userData.pstudioFoliageHQ)return material;
    if(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial&&!material.isMeshToonMaterial)return material;
    object?.geometry?.computeBoundingBox?.();
    const b=object?.geometry?.boundingBox,height=Math.max(.1,b?b.max.y-b.min.y:10),base=b?b.min.y:0;
    const role=String(object?.userData?.pstudioWindPart||'foliage');
    const authored=Number(object?.userData?.pstudioWindWeight);
    const fallback=role === 'trunk' ? 0.12 : role === 'branch' ? 0.42 : role === 'leaf' ? 0.88 : 0.34;
    const strength=Number.isFinite(authored)?Math.max(0,Math.min(1,authored)):fallback;
    const u={time:{value:0},strength:{value:strength},height:{value:height},base:{value:base},direction:{value:new (T().Vector2)(.83,.56).normalize()}};
    const old=material.onBeforeCompile,oldKey=material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      if(old)old.call(this,shader,renderer);
      Object.assign(shader.uniforms,{
        uPStudioWindTime:u.time,uPStudioWindStrength:u.strength,
        uPStudioFoliageHeight:u.height,uPStudioFoliageBaseY:u.base,
        uPStudioWindDirection:u.direction
      });
      shader.vertexShader=addAfter(shader.vertexShader,'#include <common>',[
        'uniform float uPStudioWindTime;',
        'uniform float uPStudioWindStrength;',
        'uniform float uPStudioFoliageHeight;',
        'uniform float uPStudioFoliageBaseY;',
        'uniform vec2 uPStudioWindDirection;'
      ].join('\n'));
      shader.vertexShader=addAfter(shader.vertexShader,'#include <begin_vertex>',[
        'vec4 pstudioWindWorld=modelMatrix*vec4(transformed,1.0);',
        '#ifdef USE_INSTANCING',
        'pstudioWindWorld=modelMatrix*instanceMatrix*vec4(transformed,1.0);',
        '#endif',
        'float foliageHeight01=clamp((position.y-uPStudioFoliageBaseY)/max(.1,uPStudioFoliageHeight),0.0,1.0);',
        'float foliageBend=pow(foliageHeight01,1.42);',
        'float worldPhase=dot(pstudioWindWorld.xz,normalize(uPStudioWindDirection));',
        'float broadGust=sin(uPStudioWindTime*.78+worldPhase*.047);',
        'float secondaryGust=sin(uPStudioWindTime*1.31+worldPhase*.113+position.y*.39);',
        'float leafFlutter=sin(uPStudioWindTime*3.25+worldPhase*.31+position.y*1.7+position.x*1.1);',
        'float sway=(broadGust*.23+secondaryGust*.052+leafFlutter*.014)*foliageBend*uPStudioWindStrength;',
        'transformed.x+=sway*uPStudioWindDirection.x;',
        'transformed.z+=sway*uPStudioWindDirection.y;',
        'transformed.y+=leafFlutter*.006*foliageBend*uPStudioWindStrength;'
      ].join('\n'));
    };
    material.customProgramCacheKey=()=>'pstudio-foliage-wind-hq-v3-'+role+(oldKey?oldKey():'');
    material.userData.pstudioFoliageHQ={role,strength,height,base,wind:'world-phased-multi-frequency'};
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
    const authoredScale=Number(material.userData?.pstudioTriplanarScale);
    const scaleValue=Number.isFinite(authoredScale)&&authoredScale>0?Math.max(.005,Math.min(.5,authoredScale)):(/meadow|grass|groundcover|terrace/i.test(name)?0.115:0.082);
    const authoredSharpness=Number(material.userData?.pstudioTriplanarSharpness);
    const authoredNormalWeight=Number(material.userData?.pstudioTriplanarNormalWeight);
    const u={scale:{value:scaleValue},sharpness:{value:Number.isFinite(authoredSharpness)?Math.max(1,Math.min(12,authoredSharpness)):4.0},normalWeight:{value:Number.isFinite(authoredNormalWeight)?Math.max(0,Math.min(1,authoredNormalWeight)):.72}};
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


  function configureTerrain(material,object,options={}) {
    if(!material||material.userData?.pstudioTerrainHQ)return material;
    if(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial)return material;
    object?.geometry?.computeBoundingBox?.();
    const bounds=object?.geometry?.boundingBox;
    const localMin=Number.isFinite(bounds?.min?.y)?bounds.min.y:0;
    const localMax=Number.isFinite(bounds?.max?.y)?bounds.max.y:1;
    const worldBase=(Number(object?.position?.y)||0)+localMin;
    const heightRange=Math.max(.001,localMax-localMin);
    const read=(name,fallback,min,max)=>{
      const value=Number(options[name]??material.userData?.['pstudioTerrain'+name[0].toUpperCase()+name.slice(1)]);
      return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
    };
    const u={
      heightMin:{value:worldBase},heightRange:{value:heightRange},
      detailScale:{value:read('detailScale',.16,.005,2)},
      snowLine:{value:read('snowLine',1.08,0,1.5)},
      wetness:{value:read('wetness',.035,0,.8)},
      rockThreshold:{value:read('rockThreshold',.38,.08,.92)}
    };
    const old=material.onBeforeCompile,oldKey=material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      if(old)old.call(this,shader,renderer);
      Object.assign(shader.uniforms,{
        uPStudioTerrainHeightMin:u.heightMin,uPStudioTerrainHeightRange:u.heightRange,
        uPStudioTerrainDetailScale:u.detailScale,uPStudioTerrainSnowLine:u.snowLine,
        uPStudioTerrainWetness:u.wetness,uPStudioTerrainRockThreshold:u.rockThreshold
      });
      shader.vertexShader=addAfter(shader.vertexShader,'#include <common>',[
        'varying vec3 vPStudioTerrainWorldPosition;','varying vec3 vPStudioTerrainWorldNormal;'
      ].join('\n'));
      shader.vertexShader=addAfter(shader.vertexShader,'#include <begin_vertex>',[
        'vec4 pStudioTerrainWorld=modelMatrix*vec4(transformed,1.0);',
        '#ifdef USE_INSTANCING',
        'pStudioTerrainWorld=modelMatrix*instanceMatrix*vec4(transformed,1.0);',
        '#endif','vPStudioTerrainWorldPosition=pStudioTerrainWorld.xyz;'
      ].join('\n'));
      shader.vertexShader=addAfter(shader.vertexShader,'#include <defaultnormal_vertex>',
        'vPStudioTerrainWorldNormal=normalize(transpose(mat3(viewMatrix))*transformedNormal);');
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <common>',[
        'uniform float uPStudioTerrainHeightMin;','uniform float uPStudioTerrainHeightRange;',
        'uniform float uPStudioTerrainDetailScale;','uniform float uPStudioTerrainSnowLine;',
        'uniform float uPStudioTerrainWetness;','uniform float uPStudioTerrainRockThreshold;',
        'varying vec3 vPStudioTerrainWorldPosition;','varying vec3 vPStudioTerrainWorldNormal;',
        'float pStudioTerrainHash(vec3 p){p=fract(p*.3183099+vec3(.1,.13,.17));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}',
        'float pStudioTerrainNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);float a=pStudioTerrainHash(i);float b=pStudioTerrainHash(i+vec3(1,0,0));float c=pStudioTerrainHash(i+vec3(0,1,0));float d=pStudioTerrainHash(i+vec3(1,1,0));float e=pStudioTerrainHash(i+vec3(0,0,1));float f1=pStudioTerrainHash(i+vec3(1,0,1));float g=pStudioTerrainHash(i+vec3(0,1,1));float h=pStudioTerrainHash(i+vec3(1,1,1));return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y),mix(mix(e,f1,f.x),mix(g,h,f.x),f.y),f.z);}',
        'float pStudioTerrainFbm(vec3 p){float n=0.0,a=.55;for(int i=0;i<3;i++){n+=pStudioTerrainNoise(p)*a;p=p*2.03+vec3(7.1,3.7,5.3);a*=.5;}return n/.9625;}'
      ].join('\n'));
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <color_fragment>',[
        'float pStudioElevation=clamp((vPStudioTerrainWorldPosition.y-uPStudioTerrainHeightMin)/uPStudioTerrainHeightRange,0.0,1.0);',
        'float pStudioSlope=1.0-clamp(abs(normalize(vPStudioTerrainWorldNormal).y),0.0,1.0);',
        'float pStudioNoiseValue=pStudioTerrainFbm(vPStudioTerrainWorldPosition*uPStudioTerrainDetailScale);',
        'float pStudioRock=smoothstep(uPStudioTerrainRockThreshold,uPStudioTerrainRockThreshold+.28,pStudioSlope+(pStudioNoiseValue-.5)*.16);',
        'float pStudioGrass=(1.0-pStudioRock)*(1.0-smoothstep(.46,.9,pStudioElevation))*(.72+.28*pStudioNoiseValue);',
        'float pStudioSoil=(1.0-pStudioRock)*(1.0-smoothstep(.12,.78,pStudioElevation))*(.16+.28*pStudioNoiseValue);',
        'float pStudioSnow=smoothstep(uPStudioTerrainSnowLine,uPStudioTerrainSnowLine+.12,pStudioElevation)*(1.0-smoothstep(.12,.62,pStudioSlope));',
        'vec3 pStudioTerrainBase=diffuseColor.rgb;',
        'vec3 pStudioTerrainLayer=mix(pStudioTerrainBase,pStudioTerrainBase*vec3(.78,1.055,.76),pStudioGrass*.42);',
        'pStudioTerrainLayer=mix(pStudioTerrainLayer,pStudioTerrainBase*vec3(1.08,.88,.70),pStudioSoil*.34);',
        'pStudioTerrainLayer=mix(pStudioTerrainLayer,pStudioTerrainBase*vec3(.72,.76,.81),pStudioRock*.48);',
        'pStudioTerrainLayer=mix(pStudioTerrainLayer,mix(vec3(.78,.84,.91),vec3(.98,.99,1.0),pStudioNoiseValue),pStudioSnow);',
        'pStudioTerrainLayer*=1.0-uPStudioTerrainWetness*(.06+.08*pStudioNoiseValue);',
        'diffuseColor.rgb=mix(pStudioTerrainBase,pStudioTerrainLayer,.82);'
      ].join('\n'));
      shader.fragmentShader=addAfter(shader.fragmentShader,'#include <roughnessmap_fragment>',
        'roughnessFactor=clamp(roughnessFactor+pStudioRock*.12-uPStudioTerrainWetness*(.05+.12*pStudioNoiseValue),.12,1.0);');
    };
    material.customProgramCacheKey=()=>'pstudio-terrain-layered-pbr-v1-'+(oldKey?oldKey():'');
    material.userData.pstudioTerrainHQ=u;
    if(T()?.DoubleSide!==undefined)material.side=T().DoubleSide;
    terrainMaterials.add(material);
    return material;
  }

  function configureObject(object) {
    if(!object?.isMesh||!object.material)return;
    const name=String(object.name||'');
    const mats=Array.isArray(object.material)?object.material:[object.material],out=[];
    for(const m of mats){
      if(!m){out.push(m);continue;}
      const tag=name+' '+String(m.name||'');
      if(object.userData?.pstudioWaterDetail){const c=m.userData.pstudioWaterDetailHQ?m:m.clone();configureWaterDetail(c,object);out.push(c);}
      else if(WATER.test(tag)){const c=m.clone();configureWater(c,object,/waterfall|cascade|spray|foam/i.test(name));out.push(c);}
      else if(UNDER.test(name)){configureUnderwater(m);out.push(m);}
      else if(object.userData?.pstudioWindPart==='leaf'||object.userData?.pstudioWindPart==='branch'||object.userData?.pstudioWindPart==='trunk'){configureFoliage(m,object);out.push(m);}
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
    const setTime=(collection,recordKey)=>{
      for(const material of collection){
        const record=material?.userData?.[recordKey],uniform=record?.time;
        if(!uniform||!Object.prototype.hasOwnProperty.call(uniform,'value')){collection.delete(material);continue;}
        uniform.value=t;
      }
    };
    setTime(water,'pstudioWaterHQ');
    setTime(waterDetailMaterials,'pstudioWaterDetailHQ');
    setTime(foliage,'pstudioFoliageHQ');
    setTime(caustics,'pstudioCausticsHQ');
    for(const pass of cloudPasses){const uniform=pass?.uniforms?.uTime;if(uniform&&Object.prototype.hasOwnProperty.call(uniform,'value'))uniform.value=t;}
    for(const pass of fogPasses){const uniform=pass?.uniforms?.uTime;if(uniform&&Object.prototype.hasOwnProperty.call(uniform,'value'))uniform.value=t;}
  }

  function createVolumetricCloudPass(FX,Three) {
    if(!FX?.ShaderPass||!Three?.DepthTexture)return null;
    const shader={
      uniforms:{
        tDiffuse:{value:null},tDepth:{value:null},uInverseProjection:{value:new Three.Matrix4()},
        uCameraWorld:{value:new Three.Matrix4()},uFogColor:{value:new Three.Color('#bfe2eb')},
        uSunDirection:{value:new Three.Vector3(-.42,.78,-.46).normalize()},
        uSunColor:{value:new Three.Color('#fff0d4')},uTime:{value:0},
        uCloudBase:{value:54},uCloudTop:{value:108},uCloudDensity:{value:.78},
        uCloudScale:{value:.0095},uCloudCoverage:{value:.48},uCloudDetail:{value:.58},
        uCloudWind:{value:new Three.Vector2(-.8,.32)},uCloudSteps:{value:24},
        uCloudLightSteps:{value:1},uAtmosphereStrength:{value:.96}
      },
      vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:[
        'uniform sampler2D tDiffuse;uniform sampler2D tDepth;',
        'uniform mat4 uInverseProjection;uniform mat4 uCameraWorld;',
        'uniform vec3 uFogColor;uniform vec3 uSunDirection;uniform vec3 uSunColor;',
        'uniform float uTime;uniform float uCloudBase;uniform float uCloudTop;uniform float uCloudDensity;',
        'uniform float uCloudScale;uniform float uCloudCoverage;uniform float uCloudDetail;',
        'uniform vec2 uCloudWind;uniform float uCloudSteps;uniform float uCloudLightSteps;uniform float uAtmosphereStrength;',
        'varying vec2 vUv;',
        'float pHash(vec3 p){p=fract(p*.3183099+vec3(.1,.17,.13));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}',
        'float pNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);',
        'float n000=pHash(i);float n100=pHash(i+vec3(1,0,0));float n010=pHash(i+vec3(0,1,0));float n110=pHash(i+vec3(1,1,0));',
        'float n001=pHash(i+vec3(0,0,1));float n101=pHash(i+vec3(1,0,1));float n011=pHash(i+vec3(0,1,1));float n111=pHash(i+vec3(1,1,1));',
        'return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);}',
        'float pFbm(vec3 p){float n=0.0;float a=.55;for(int i=0;i<3;i++){n+=pNoise(p)*a;p=p*2.03+vec3(7.1,3.7,5.3);a*=.5;}return n/.9625;}',
        'float pCloudDensity(vec3 worldPosition){',
        'float height=clamp((worldPosition.y-uCloudBase)/max(1.0,uCloudTop-uCloudBase),0.0,1.0);',
        'float vertical=smoothstep(.012,.16,height)*(1.0-smoothstep(.62,.985,height));',
        'vec3 q=worldPosition*uCloudScale+vec3(uCloudWind.x*uTime*.0008,0.0,uCloudWind.y*uTime*.0008);',
        'vec3 warp=vec3(pNoise(q*.52+vec3(17.0,3.0,9.0)),pNoise(q*.52+vec3(4.0,19.0,2.0)),pNoise(q*.52+vec3(9.0,7.0,21.0)))-.5;',
        'float body=pFbm(q+warp*.52);float detail=pNoise(q*4.15+vec3(12.0,5.0,7.0));',
        'float erosion=(1.0-detail)*uCloudDetail*.16;',
        'float threshold=mix(.68,.34,clamp(uCloudCoverage,0.0,1.0));',
        'float billow=smoothstep(threshold-.18,threshold+.13,body-erosion+(.5-height)*.045);',
        'return billow*vertical*uCloudDensity*1.25;',
        '}',
        'float pHenyeyGreenstein(float cosineAngle,float g){float g2=g*g;return (1.0-g2)/(12.5663706*pow(max(.001,1.0+g2-2.0*g*cosineAngle),1.5));}',
        'void main(){',
        'vec4 source=texture2D(tDiffuse,vUv);float depth=texture2D(tDepth,vUv).x;',
        'if(depth<.99999||uCloudDensity<=.001||uAtmosphereStrength<=.001){gl_FragColor=source;return;}',
        'vec4 clip=vec4(vUv*2.0-1.0,1.0,1.0);vec4 viewH=uInverseProjection*clip;',
        'vec3 viewRay=normalize(viewH.xyz/max(abs(viewH.w),1e-5));',
        'vec3 ray=normalize(mat3(uCameraWorld)*viewRay);vec3 origin=uCameraWorld[3].xyz;',
        'if(ray.y<=.012){gl_FragColor=source;return;}',
        'float t0=(uCloudBase-origin.y)/ray.y;float t1=(uCloudTop-origin.y)/ray.y;',
        'float begin=max(0.0,min(t0,t1));float finish=min(max(t0,t1),5200.0);',
        'if(finish<=begin){gl_FragColor=source;return;}',
        'float steps=clamp(uCloudSteps,8.0,40.0);float stepLength=(finish-begin)/steps;',
        'float jitter=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);',
        'float transmittance=1.0;vec3 scattering=vec3(0.0);vec3 sun=normalize(uSunDirection);',
        'float phase=pHenyeyGreenstein(dot(-ray,sun),.68);',
        'for(int i=0;i<40;i++){if(float(i)>=steps||transmittance<.018)break;',
        'float travel=begin+(float(i)+jitter)*stepLength;vec3 p=origin+ray*travel;',
        'float density=pCloudDensity(p);if(density<=.002)continue;',
        'float lightOptical=0.0;',
        'for(int j=0;j<2;j++){if(float(j)>=uCloudLightSteps)break;',
        'vec3 lightPoint=p+sun*(10.0+float(j)*18.0);',
        'lightOptical+=pCloudDensity(lightPoint)*(10.0+float(j)*18.0)*.012;',
        '}',
        'float lightTransmittance=exp(-lightOptical*1.35);',
        'float extinction=density*stepLength*.018;',
        'float alpha=1.0-exp(-extinction);',
        'float powder=1.0-exp(-density*1.7);',
        'float forwardScatter=clamp(phase*2.2,0.0,1.65);',
        'vec3 ambient=mix(uFogColor*vec3(.48,.58,.72),vec3(.74,.81,.9),clamp(ray.y*.5+.45,0.0,1.0));',
        'vec3 direct=uSunColor*(.38+forwardScatter*1.25)*lightTransmittance;',
        'float silverLining=pow(clamp(1.0-lightTransmittance,0.0,1.0),.42)*.18;',
        'vec3 cloudLight=ambient*(.58+.22*pow(1.0-pow(1.0-pow(1.0-density,2.0),2.0),2.0))+direct*pow(powder,.72)+uSunColor*silverLining;',
        'scattering+=cloudLight*(alpha*transmittance);transmittance*=1.0-alpha;',
        '}',
        'vec3 result=source.rgb*transmittance+scattering*uAtmosphereStrength;',
        'gl_FragColor=vec4(result,source.a);',
        '}'
      ].join('\n')
    };
    const pass=new FX.ShaderPass(shader);
    const originalRender=pass.render.bind(pass);
    pass.enabled=false;
    pass.setQuality=(preset='high',adaptiveLevel=2)=>{
      const base={mobile:8,balanced:14,high:26,ultra:36,cinematic:40}[String(preset)]||26;
      const level=Math.max(0,Math.min(2,Math.floor(Number(adaptiveLevel)||0)));
      const factor=[.58,.78,1][level];
      const steps=Math.max(8,Math.min(40,Math.round(base*factor)));
      const lightSteps=preset==='ultra'||preset==='cinematic'?2:1;
      pass.uniforms.uCloudSteps.value=steps;
      pass.uniforms.uCloudLightSteps.value=lightSteps;
      pass.userData=pass.userData||{};
      pass.userData.pstudioCloudQuality={preset,adaptiveLevel:level,steps,lightSteps};
      return {...pass.userData.pstudioCloudQuality};
    };
    pass.configureAtmosphere=(settings={})=>{
      const uniforms=pass.uniforms;
      const direction=settings.lightDirection||settings.sunDirection;
      if(Array.isArray(direction)&&direction.length>=3&&direction.slice(0,3).every(Number.isFinite)){
        uniforms.uSunDirection.value.set(direction[0],direction[1],direction[2]).normalize();
      }
      if(settings.sunColor&&uniforms.uSunColor.value?.set)uniforms.uSunColor.value.set(settings.sunColor);
      if(settings.fogColor&&uniforms.uFogColor.value?.set)uniforms.uFogColor.value.set(settings.fogColor);
      if(Number.isFinite(Number(settings.cloudDensity)))uniforms.uCloudDensity.value=Math.max(0,Math.min(2,Number(settings.cloudDensity)));
      return true;
    };
    pass.setQuality('high',2);
    pass.render=function(renderer,writeBuffer,readBuffer,delta,mask){
      const depth=this.uniforms?.tDepth;
      if(depth&&Object.prototype.hasOwnProperty.call(depth,'value'))depth.value=readBuffer?.depthTexture||depth.value;
      originalRender(renderer,writeBuffer,readBuffer,delta,mask);
    };
    cloudPasses.add(pass);
    return pass;
  }

  function createVolumetricFogPass(FX,Three) {
    if(!FX?.ShaderPass||!Three?.DepthTexture)return null;
    const shader={
      uniforms:{
        tDiffuse:{value:null},tDepth:{value:null},uInverseProjection:{value:new Three.Matrix4()},
        uCameraWorld:{value:new Three.Matrix4()},uFogColor:{value:new Three.Color('#b9d8d9')},
        uFogAmbientColor:{value:new Three.Color('#d9eeff')},uSunColor:{value:new Three.Color('#fff1d6')},
        uSunDirection:{value:new Three.Vector3(-.35,.82,-.44).normalize()},
        uFogDensity:{value:.0018},uHeightFalloff:{value:.018},uBaseHeight:{value:0},
        uFogAnisotropy:{value:.42},uFogSteps:{value:16},uTime:{value:0}
      },
      vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:[
        'uniform sampler2D tDiffuse;uniform sampler2D tDepth;',
        'uniform mat4 uInverseProjection;uniform mat4 uCameraWorld;',
        'uniform vec3 uFogColor;uniform vec3 uFogAmbientColor;uniform vec3 uSunColor;uniform vec3 uSunDirection;',
        'uniform float uFogDensity;uniform float uHeightFalloff;uniform float uBaseHeight;uniform float uFogAnisotropy;uniform float uFogSteps;uniform float uTime;',
        'varying vec2 vUv;',
        'float noise3(vec3 p){return .5+.5*sin(p.x*.73+sin(p.y*.51+p.z*.91)*1.7+uTime*.025);}',
        'float henyeyGreenstein(float mu,float g){float g2=g*g;return (1.0-g2)/(12.5663706*pow(max(.001,1.0+g2-2.0*g*mu),1.5));}',
        'void main(){',
        'vec4 col=texture2D(tDiffuse,vUv);float z=texture2D(tDepth,vUv).x;',
        'if(z>=.99999||uFogDensity<=.000001){gl_FragColor=col;return;}',
        'vec4 q=uInverseProjection*vec4(vUv*2.0-1.0,z*2.0-1.0,1.0);vec3 vp=q.xyz/max(1e-6,q.w);',
        'vec3 origin=uCameraWorld[3].xyz;vec3 endp=(uCameraWorld*vec4(vp,1.0)).xyz;',
        'vec3 ray=endp-origin;float len=length(ray);vec3 dir=ray/max(len,1e-5);',
        'vec3 sun=normalize(uSunDirection);float cosine=dot(-dir,sun);',
        'float phase=henyeyGreenstein(cosine,clamp(uFogAnisotropy,0.0,.88));',
        'float steps=clamp(uFogSteps,6.0,24.0);float ds=len/steps;',
        'float optical=0.0;vec3 scatter=vec3(0.0);',
        'for(int i=0;i<24;i++){if(float(i)>=steps)break;',
        'float f=(float(i)+.5)/steps;vec3 p=origin+dir*(len*f);',
        'float h=p.y-uBaseHeight;',
        'float vertical=exp(-max(h,0.0)*uHeightFalloff);',
        'float groundHaze=1.0+.24*exp(-abs(h)*.022);',
        'float detail=mix(noise3(p*.035),noise3(p*.11),.32);',
        'float density=uFogDensity*vertical*groundHaze*mix(.82,1.14,detail);',
        'float segment=density*ds;float trans=exp(-optical);',
        'float segmentAlpha=1.0-exp(-segment);',
        'float sunForward=pow(max(cosine,0.0),5.0);',
        'vec3 ambient=uFogAmbientColor*.52+uFogColor*.48;',
        'vec3 direct=uSunColor*(phase*4.0+sunForward*.38);',
        'vec3 lighting=ambient+direct;',
        'scatter+=lighting*trans*segmentAlpha;',
        'optical+=segment;',
        'if(optical>8.0)break;',
        '}',
        'float trans=exp(-optical);',
        'vec3 fogged=col.rgb*trans+scatter;',
        'gl_FragColor=vec4(fogged,col.a);',
        '}'
      ].join('\n')
    };
    const pass=new FX.ShaderPass(shader);
    pass.enabled=false;
    pass.setQuality=(preset='high',adaptiveLevel=2)=>{
      const base={mobile:8,balanced:10,high:16,ultra:24}[String(preset)]||16;
      const level=Math.max(0,Math.min(2,Math.floor(Number(adaptiveLevel)||0)));
      const steps=Math.max(6,Math.min(24,Math.round(base*[.62,.82,1][level])));
      pass.uniforms.uFogSteps.value=steps;
      pass.userData=pass.userData||{};
      pass.userData.pstudioFogQuality={preset,adaptiveLevel:level,steps};
      return {...pass.userData.pstudioFogQuality};
    };
    const render=pass.render.bind(pass);
    pass.render=function(renderer,writeBuffer,readBuffer,delta,mask){
      const depth=this.uniforms?.tDepth;
      if(depth&&Object.prototype.hasOwnProperty.call(depth,'value'))depth.value=readBuffer?.depthTexture||null;
      render(renderer,writeBuffer,readBuffer,delta,mask);
    };
    pass.setQuality('high',2);
    fogPasses.add(pass);
    return pass;
  }

  window.PStudioEnvironmentFX={
    configureObject,configureTerrain,configureWater,configureFoliage,configureUnderwater,configureParallax,configureTriplanar,update,createVolumetricFogPass,createVolumetricCloudPass,
    configureAtmosphere(settings={}){
      const direction=settings.lightDirection||settings.sunDirection;
      const applyDirection=uniform=>{
        if(!uniform?.value?.set||!Array.isArray(direction)||direction.length<3||!direction.slice(0,3).every(Number.isFinite))return;
        uniform.value.set(direction[0],direction[1],direction[2]).normalize();
      };
      const applyColor=(uniform,value)=>{if(value&&uniform?.value?.set)uniform.value.set(value);};
      for(const pass of cloudPasses){
        const u=pass?.uniforms;if(!u)continue;
        applyDirection(u.uSunDirection);applyColor(u.uSunColor,settings.sunColor);applyColor(u.uFogColor,settings.fogColor);
      }
      for(const pass of fogPasses){
        const u=pass?.uniforms;if(!u)continue;
        applyDirection(u.uSunDirection);
        applyColor(u.uSunColor,settings.sunColor);
        applyColor(u.uFogColor,settings.fogColor);
        applyColor(u.uFogAmbientColor,settings.fogAmbientColor);
        if(Number.isFinite(Number(settings.fogDensity)))u.uFogDensity.value=Math.max(0,Math.min(.08,Number(settings.fogDensity)));
        if(Number.isFinite(Number(settings.fogHeightFalloff)))u.uHeightFalloff.value=Math.max(0,Math.min(.2,Number(settings.fogHeightFalloff)));
        if(Number.isFinite(Number(settings.fogBaseHeight)))u.uBaseHeight.value=Number(settings.fogBaseHeight);
        if(Number.isFinite(Number(settings.fogAnisotropy)))u.uFogAnisotropy.value=Math.max(0,Math.min(.88,Number(settings.fogAnisotropy)));
      }
      return true;
    },
    setSceneDepthTexture(texture,width,height,near,far){for(const material of water){const u=material?.userData?.pstudioWaterHQ;if(!u?.sceneDepth||!u?.viewport?.set||!u?.near||!u?.far||!u?.sceneDepthValid)continue;if(!['sceneDepth','near','far','sceneDepthValid'].every(key=>Object.prototype.hasOwnProperty.call(u[key],'value')))continue;u.sceneDepth.value=texture||null;u.viewport.value.set(Math.max(1,width||1),Math.max(1,height||1));u.near.value=Math.max(.001,near||.1);u.far.value=Math.max(u.near.value+1,far||1600);u.sceneDepthValid.value=texture?1:0;}},
    releaseMaterial(material){water.delete(material);waterDetailMaterials.delete(material);foliage.delete(material);caustics.delete(material);parallaxMaterials.delete(material);triplanarMaterials.delete(material);terrainMaterials.delete(material);},
    getStats:()=>({waterMaterials:water.size,waterDetailMaterials:waterDetailMaterials.size,foliageMaterials:foliage.size,causticMaterials:caustics.size,parallaxMaterials:parallaxMaterials.size,triplanarMaterials:triplanarMaterials.size,terrainMaterials:terrainMaterials.size,cloudPasses:cloudPasses.size,fogPasses:fogPasses.size})
  };
})();