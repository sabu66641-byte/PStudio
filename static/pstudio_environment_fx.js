/* PStudio Environment FX: water, foliage, underwater caustics and volumetric depth fog. */
(() => {
  'use strict';
  const T = () => window.THREE;
  const water = new Set(), waterDetailMaterials = new Set(), foliage = new Set(), toonMaterials = new Set(), outlineMaterialCache = new Map(), caustics = new Set(), parallaxMaterials = new Set(), triplanarMaterials = new Set(), cloudPasses = new Set();
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
        'float wp1=position.x*.071+position.z*.043+uPStudioWaterTime*.92;',
        'float wp2=position.x*.137-position.z*.091-uPStudioWaterTime*.67;',
        'float wp3=position.x*.31+position.z*.22+uPStudioWaterTime*1.43;',
        'float wp4=position.x*.49-position.z*.37+uPStudioWaterTime*2.07;',
        'float wx=uPStudioWaterAmplitude*(.071*.52*cos(wp1)+.137*.27*cos(wp2)+.31*.14*cos(wp3)+.49*.07*cos(wp4));',
        'float wz=uPStudioWaterAmplitude*(.043*.52*cos(wp1)-.091*.27*cos(wp2)+.22*.14*cos(wp3)-.37*.07*cos(wp4));',
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
        'float microA=sin(vPStudioWaterWorld.x*1.72+vPStudioWaterWorld.z*1.31+uPStudioWaterTime*2.4);',
        'float microB=sin(vPStudioWaterWorld.z*1.94-vPStudioWaterWorld.x*.83-uPStudioWaterTime*1.8);',
        'float crossRipple=sin((vPStudioWaterWorld.x+vPStudioWaterWorld.z)*3.1+uPStudioWaterTime*2.9);',
        'vec3 rippleN=normalize(vec3(.095*microA+.028*crossRipple,1.0,.09*microB-.024*crossRipple));',
        'normal=normalize(normal+(rippleN-vec3(0.0,1.0,0.0))*.13);'
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

  function configureFoliage(material,object,settings={}) {
    if(!material)return material;
    const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number(value)||0));
    const existing=material.userData?.pstudioFoliageHQ;
    if(!existing&&Object.prototype.hasOwnProperty.call(settings,'windStrength')&&Number(settings.windStrength)<=0)return material;
    if(existing){
      if(Number.isFinite(Number(settings.windStrength)))existing.strength.value=clamp(settings.windStrength,0,2.5);
      if(Number.isFinite(Number(settings.windSpeed)))existing.speed.value=clamp(settings.windSpeed,0,4);
      return material;
    }
    if(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial&&!material.isMeshToonMaterial)return material;
    object?.geometry?.computeBoundingBox?.();
    const b=object?.geometry?.boundingBox,height=Math.max(.1,b?b.max.y-b.min.y:10),base=b?b.min.y:0;
    const role=String(object?.userData?.pstudioWindPart||'foliage');
    const authored=Number(object?.userData?.pstudioWindWeight);
    const fallback=role === 'trunk' ? 0.12 : role === 'branch' ? 0.42 : role === 'leaf' ? 0.88 : 0.34;
    const strength=Number.isFinite(Number(settings.windStrength))?clamp(settings.windStrength,0,2.5):(Number.isFinite(authored)?Math.max(0,Math.min(1,authored)):fallback);
    const speed=Number.isFinite(Number(settings.windSpeed))?clamp(settings.windSpeed,0,4):1;
    const u={time:{value:0},strength:{value:strength},speed:{value:speed},height:{value:height},base:{value:base},direction:{value:new (T().Vector2)(.83,.56).normalize()}};
    const old=material.onBeforeCompile,oldKey=material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile=function(shader,renderer){
      if(old)old.call(this,shader,renderer);
      Object.assign(shader.uniforms,{
        uPStudioWindTime:u.time,uPStudioWindStrength:u.strength,uPStudioWindSpeed:u.speed,
        uPStudioFoliageHeight:u.height,uPStudioFoliageBaseY:u.base,
        uPStudioWindDirection:u.direction
      });
      shader.vertexShader=addAfter(shader.vertexShader,'#include <common>',[
        'uniform float uPStudioWindTime;',
        'uniform float uPStudioWindStrength;',
        'uniform float uPStudioWindSpeed;',
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
        'float broadGust=sin(uPStudioWindTime*uPStudioWindSpeed*.78+worldPhase*.047);',
        'float secondaryGust=sin(uPStudioWindTime*uPStudioWindSpeed*1.31+worldPhase*.113+position.y*.39);',
        'float leafFlutter=sin(uPStudioWindTime*uPStudioWindSpeed*3.25+worldPhase*.31+position.y*1.7+position.x*1.1);',
        'float sway=(broadGust*.23+secondaryGust*.052+leafFlutter*.014)*foliageBend*uPStudioWindStrength;',
        'transformed.x+=sway*uPStudioWindDirection.x;',
        'transformed.z+=sway*uPStudioWindDirection.y;',
        'transformed.y+=leafFlutter*.006*foliageBend*uPStudioWindStrength;'
      ].join('\n'));
    };
    material.customProgramCacheKey=()=>'pstudio-foliage-wind-hq-v3-'+role+(oldKey?oldKey():'');
    material.userData.pstudioFoliageHQ={role,strength:u.strength,speed:u.speed,height,base,wind:'world-phased-multi-frequency'};
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



  function releaseOutline(object) {
    const record=object?.userData?.pstudioOutlineShell;
    if(!record)return;
    if(record.mesh?.parent)record.mesh.parent.remove(record.mesh);
    const cached=outlineMaterialCache.get(record.key);
    if(cached){
      cached.refs=Math.max(0,cached.refs-1);
      if(cached.refs===0){if(Array.isArray(cached.material))cached.material.forEach(item=>item?.dispose?.());else cached.material.dispose?.();outlineMaterialCache.delete(record.key);}
    }
    delete object.userData.pstudioOutlineShell;
  }

  function configureOutline(object,settings={}) {
    const Three=T();
    if(!Three||!object?.isMesh||!object.geometry)return;
    const enabled=settings.enabled!==false;
    const width=Math.max(0.005,Math.min(0.45,Number(settings.width)||0));
    if(!enabled||width<=0){releaseOutline(object);return;}
    const color=String(settings.color||'#182235');
    const sourceMaterials=Array.isArray(object.material)?object.material:[settings.sourceMaterial||object.material];
    const materialStates=sourceMaterials.map(sourceMaterial=>{
      const useAlphaTextures=!!(sourceMaterial&&(sourceMaterial.alphaTest>0||sourceMaterial.transparent||sourceMaterial.alphaHash));
      return {sourceMaterial,useAlphaTextures,map:useAlphaTextures?(sourceMaterial?.map||null):null,alphaMap:useAlphaTextures?(sourceMaterial?.alphaMap||null):null};
    });
    const cacheKey=JSON.stringify([color,width.toFixed(4),materialStates.map(state=>({map:state.map?.uuid||'',alphaMap:state.alphaMap?.uuid||'',alphaTest:state.sourceMaterial?.alphaTest||0,opacity:state.sourceMaterial?.opacity??1,transparent:!!state.sourceMaterial?.transparent,alphaHash:!!state.sourceMaterial?.alphaHash,alphaToCoverage:!!state.sourceMaterial?.alphaToCoverage,vertexColors:!!state.sourceMaterial?.vertexColors}))]);
    const currentOutline=object.userData?.pstudioOutlineShell;
    if(currentOutline?.key===cacheKey){
      currentOutline.mesh.geometry=object.geometry;
      if(object.isInstancedMesh){currentOutline.mesh.count=object.count;currentOutline.mesh.instanceMatrix=object.instanceMatrix;if(object.instanceColor)currentOutline.mesh.instanceColor=object.instanceColor;}
      if(object.isSkinnedMesh&&object.skeleton)currentOutline.mesh.bind(object.skeleton,object.bindMatrix);
      return;
    }
    releaseOutline(object);
    let cached=outlineMaterialCache.get(cacheKey);
    if(!cached){
      const materials=materialStates.map(({sourceMaterial,useAlphaTextures,map,alphaMap})=>{
        const material=new Three.MeshBasicMaterial({
          color,map,alphaMap,alphaTest:sourceMaterial?.alphaTest||0,
          transparent:!!(useAlphaTextures&&sourceMaterial?.transparent),opacity:sourceMaterial?.opacity??1,
          alphaToCoverage:!!sourceMaterial?.alphaToCoverage,alphaHash:!!sourceMaterial?.alphaHash,
          vertexColors:!!sourceMaterial?.vertexColors,
          side:Three.BackSide,depthWrite:false,depthTest:true,
          toneMapped:false,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1
        });
        material.onBeforeCompile=function(shader){
          shader.uniforms.uPStudioOutlineExpansion={value:width};
          shader.vertexShader=addAfter(shader.vertexShader,'#include <common>',[
            'uniform float uPStudioOutlineExpansion;',
            '#if !defined(USE_ENVMAP) && !defined(USE_SKINNING)',
            'attribute vec3 normal;',
            '#endif'
          ].join('\n'));
          shader.vertexShader=addAfter(shader.vertexShader,'#include <skinning_vertex>',[
            '#if !defined(USE_ENVMAP) && !defined(USE_SKINNING)',
            'vec3 objectNormal = normal;',
            '#endif',
            'transformed+=normalize(objectNormal)*uPStudioOutlineExpansion;'
          ].join('\n'));
          if(useAlphaTextures)shader.fragmentShader=addAfter(shader.fragmentShader,'#include <color_fragment>','diffuseColor.rgb=vec3(1.0);');
        };
        material.customProgramCacheKey=()=>'pstudio-backface-outline-shell-v1';
        return material;
      });
      const material=Array.isArray(object.material)?materials:materials[0];
      cached={material,refs:0};
      outlineMaterialCache.set(cacheKey,cached);
    }
    cached.refs++;
    const shell=object.isInstancedMesh
      ?new Three.InstancedMesh(object.geometry,cached.material,object.count)
      :object.isSkinnedMesh&&object.skeleton
        ?new Three.SkinnedMesh(object.geometry,cached.material)
        :new Three.Mesh(object.geometry,cached.material);
    if(shell.isInstancedMesh){shell.instanceMatrix=object.instanceMatrix;if(object.instanceColor)shell.instanceColor=object.instanceColor;shell.count=object.count;}
    if(shell.isSkinnedMesh&&object.skeleton){
      shell.bind(object.skeleton,object.bindMatrix);
      shell.bindMode=object.bindMode;
    }
    shell.position.set(0,0,0);shell.quaternion.set(0,0,0,1);shell.scale.set(1,1,1);
    shell.frustumCulled=object.frustumCulled;
    shell.castShadow=false;shell.receiveShadow=false;
    shell.raycast=()=>{};
    shell.renderOrder=(Number(object.renderOrder)||0)-0.1;
    shell.userData.pstudioOutlineShell=true;
    object.add(shell);
    object.userData.pstudioOutlineShell={key:cacheKey,mesh:shell};
  }

  function configureToon(material,settings={},object=null) {
    const Three=T();
    if(!Three||!material||(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial))return material;
    const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number.isFinite(Number(value))?Number(value):0));
    const defaults={
      shadowColor:'#46516f',midColor:'#9eafd0',highlightColor:'#ffffff',
      shadowThreshold:.32,highlightThreshold:.68,
      rimColor:'#b8dcff',rimIntensity:.42,rimPower:2.6,
      outlineColor:'#182235',outlineWidth:.12,
      sssColor:'#f0a5a0',sssIntensity:.12,
      enabled:true,windStrength:0,windSpeed:1
    };
    const value=Object.assign({},defaults,settings||{});
    let record=material.userData?.pstudioToonHQ;
    if(!record){
      if(!material.userData)material.userData={};
      const u={
        enabled:{value:0},
        shadowColor:{value:new Three.Color(defaults.shadowColor)},
        midColor:{value:new Three.Color(defaults.midColor)},
        highlightColor:{value:new Three.Color(defaults.highlightColor)},
        shadowThreshold:{value:defaults.shadowThreshold},
        highlightThreshold:{value:defaults.highlightThreshold},
        rimColor:{value:new Three.Color(defaults.rimColor)},
        rimIntensity:{value:defaults.rimIntensity},
        rimPower:{value:defaults.rimPower},
        outlineColor:{value:new Three.Color(defaults.outlineColor)},
        outlineWidth:{value:defaults.outlineWidth},
        sssColor:{value:new Three.Color(defaults.sssColor)},
        sssIntensity:{value:defaults.sssIntensity}
      };
      const previousCompile=material.onBeforeCompile,previousKey=material.customProgramCacheKey?.bind(material);
      material.onBeforeCompile=function(shader,renderer){
        if(previousCompile)previousCompile.call(this,shader,renderer);
        Object.assign(shader.uniforms,{
          uPStudioToonEnabled:u.enabled,
          uPStudioToonShadowColor:u.shadowColor,uPStudioToonMidColor:u.midColor,
          uPStudioToonHighlightColor:u.highlightColor,
          uPStudioToonShadowThreshold:u.shadowThreshold,uPStudioToonHighlightThreshold:u.highlightThreshold,
          uPStudioToonRimColor:u.rimColor,uPStudioToonRimIntensity:u.rimIntensity,uPStudioToonRimPower:u.rimPower,
          uPStudioToonOutlineColor:u.outlineColor,uPStudioToonOutlineWidth:u.outlineWidth,
          uPStudioToonSSSColor:u.sssColor,uPStudioToonSSSIntensity:u.sssIntensity
        });
        shader.fragmentShader=addAfter(shader.fragmentShader,'#include <common>',[
          'uniform float uPStudioToonEnabled;',
          'uniform vec3 uPStudioToonShadowColor;',
          'uniform vec3 uPStudioToonMidColor;',
          'uniform vec3 uPStudioToonHighlightColor;',
          'uniform float uPStudioToonShadowThreshold;',
          'uniform float uPStudioToonHighlightThreshold;',
          'uniform vec3 uPStudioToonRimColor;',
          'uniform float uPStudioToonRimIntensity;',
          'uniform float uPStudioToonRimPower;',
          'uniform vec3 uPStudioToonOutlineColor;',
          'uniform float uPStudioToonOutlineWidth;',
          'uniform vec3 uPStudioToonSSSColor;',
          'uniform float uPStudioToonSSSIntensity;'
        ].join('\n'));
        shader.fragmentShader=addAfter(shader.fragmentShader,'#include <lights_fragment_end>',[
          'float pStudioToonRim=0.0;',
          'if(uPStudioToonEnabled>0.5){',
          'float pStudioToonDirect=max(0.0,dot(reflectedLight.directDiffuse,vec3(0.2126,0.7152,0.0722)));',
          'float pStudioToonIndirect=max(0.0,dot(reflectedLight.indirectDiffuse,vec3(0.2126,0.7152,0.0722)));',
          'float pStudioToonBase=max(0.025,dot(max(diffuseColor.rgb,vec3(0.0)),vec3(0.2126,0.7152,0.0722)));',
          'float pStudioToonLight=clamp((pStudioToonDirect+pStudioToonIndirect)/pStudioToonBase,0.0,1.0);',
          'vec3 pStudioToonRamp=mix(uPStudioToonShadowColor,uPStudioToonMidColor,smoothstep(uPStudioToonShadowThreshold-0.015,uPStudioToonShadowThreshold+0.015,pStudioToonLight));',
          'pStudioToonRamp=mix(pStudioToonRamp,uPStudioToonHighlightColor,smoothstep(uPStudioToonHighlightThreshold-0.015,uPStudioToonHighlightThreshold+0.015,pStudioToonLight));',
          'reflectedLight.directDiffuse*=pStudioToonRamp;',
          'reflectedLight.indirectDiffuse*=pStudioToonRamp;',
          'float pStudioToonNdotV=clamp(dot(normalize(normal),normalize(-vViewPosition)),0.0,1.0);',
          'pStudioToonRim=pow(1.0-pStudioToonNdotV,max(0.5,uPStudioToonRimPower))*uPStudioToonRimIntensity;',
          'float pStudioToonSubsurface=pow(1.0-pStudioToonLight,2.0)*uPStudioToonSSSIntensity;',
          'reflectedLight.indirectDiffuse+=uPStudioToonSSSColor*pStudioToonSubsurface;',
          '}',
        ].join('\n'));
        shader.fragmentShader=addAfter(shader.fragmentShader,'#include <opaque_fragment>',[
          'if(uPStudioToonEnabled>0.5){',
          'gl_FragColor.rgb+=uPStudioToonRimColor*pStudioToonRim*0.82;',
          '}'
        ].join('\n'));
      };
      material.customProgramCacheKey=()=>'pstudio-npr-toon-v1'+(previousKey?previousKey():'');
      record=material.userData.pstudioToonHQ={uniforms:u,enabled:false,outlineMode:'expanded-backface-shell',version:1};
      toonMaterials.add(material);
      material.needsUpdate=true;
    }
    const u=record.uniforms;
    u.enabled.value=value.enabled===false?0:1;
    u.shadowColor.value.set(value.shadowColor);
    u.midColor.value.set(value.midColor);
    u.highlightColor.value.set(value.highlightColor);
    u.shadowThreshold.value=clamp(value.shadowThreshold,0.02,0.95);
    u.highlightThreshold.value=Math.max(u.shadowThreshold.value+0.02,clamp(value.highlightThreshold,0.05,0.99));
    u.rimColor.value.set(value.rimColor);
    u.rimIntensity.value=clamp(value.rimIntensity,0,4);
    u.rimPower.value=clamp(value.rimPower,0.5,8);
    u.outlineColor.value.set(value.outlineColor);
    u.outlineWidth.value=clamp(value.outlineWidth,0.005,0.45);
    u.sssColor.value.set(value.sssColor);
    u.sssIntensity.value=clamp(value.sssIntensity,0,1.5);
    record.enabled=u.enabled.value>0.5;
    if(object)configureOutline(object,{enabled:record.enabled,color:value.outlineColor,width:value.outlineWidth,sourceMaterial:material});
    if(object&&settings&&Object.prototype.hasOwnProperty.call(settings,'windStrength'))configureFoliage(material,object,{windStrength:value.windStrength,windSpeed:value.windSpeed});
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
  }

  function configureAtmosphere(settings={}) {
    const source=settings&&typeof settings==='object'?settings:{};
    const direction=Array.isArray(source.sunDirection)?source.sunDirection:null;
    const density=Number(source.cloudDensity);
    const fogColor=source.fogColor;
    for(const pass of cloudPasses){
      const uniforms=pass?.uniforms;
      if(direction&&uniforms?.uSunDirection?.value?.set){
        uniforms.uSunDirection.value.set(
          Number(direction[0])||0,
          Number.isFinite(Number(direction[1]))?Number(direction[1]):1,
          Number(direction[2])||0
        ).normalize();
      }
      if(Number.isFinite(density)&&uniforms?.uCloudDensity){
        uniforms.uCloudDensity.value=Math.max(0,Math.min(1,density));
      }
      if(fogColor&&uniforms?.uFogColor?.value?.set)uniforms.uFogColor.value.set(fogColor);
    }
    return {cloudPasses:cloudPasses.size,cloudDensity:Number.isFinite(density)?Math.max(0,Math.min(1,density)):null};
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
        'float sunGlow=pow(max(dot(ray,normalize(uSunDirection)),0.0),38.0);',
        'vec3 skyColor=source.rgb+vec3(.23,.20,.13)*sunGlow;',
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
    pass.render=function(renderer,writeBuffer,readBuffer,delta,mask){const depth=this.uniforms?.tDepth;if(depth&&Object.prototype.hasOwnProperty.call(depth,'value')&&!depth.value)depth.value=readBuffer?.depthTexture||null;originalRender(renderer,writeBuffer,readBuffer,delta,mask);};
    cloudPasses.add(pass);
    return pass;
  }

  function createScaledFullscreenPass(Three,shader,compositeFragment,initialScale=1){
    if(!Three?.ShaderMaterial||!Three?.WebGLRenderTarget||!Three?.Scene||!Three?.OrthographicCamera||!Three?.PlaneGeometry||!Three?.Mesh)return null;
    const geometry=new Three.PlaneGeometry(2,2);
    const camera=new Three.OrthographicCamera(-1,1,1,-1,0,1);
    const processScene=new Three.Scene();
    const processMaterial=new Three.ShaderMaterial({
      uniforms:shader.uniforms,
      vertexShader:shader.vertexShader,
      fragmentShader:shader.fragmentShader,
      depthTest:false,depthWrite:false,transparent:false,toneMapped:false
    });
    const processMesh=new Three.Mesh(geometry,processMaterial);
    processScene.add(processMesh);
    const target=new Three.WebGLRenderTarget(1,1,{
      format:Three.RGBAFormat,
      minFilter:Three.LinearFilter,
      magFilter:Three.LinearFilter,
      depthBuffer:false,
      stencilBuffer:false
    });
    target.texture.generateMipmaps=false;
    const compositeScene=new Three.Scene();
    const compositeMaterial=new Three.ShaderMaterial({
      uniforms:{
        tDiffuse:{value:null},
        tEffect:{value:target.texture},
        uIntensity:{value:1}
      },
      vertexShader:shader.vertexShader,
      fragmentShader:compositeFragment,
      depthTest:false,depthWrite:false,transparent:false,toneMapped:false
    });
    compositeScene.add(new Three.Mesh(geometry,compositeMaterial));
    let resolutionScale=Math.max(.2,Math.min(1,Number(initialScale)||1));
    let lastWidth=1,lastHeight=1;
    const pass={
      enabled:false,
      needsSwap:true,
      clear:false,
      renderToScreen:false,
      uniforms:shader.uniforms,
      setResolutionScale(value){
        const next=Math.max(.2,Math.min(1,Number(value)||1));
        if(Math.abs(next-resolutionScale)<.001)return resolutionScale;
        resolutionScale=next;
        this.setSize(lastWidth,lastHeight);
        return resolutionScale;
      },
      getResolutionScale(){return resolutionScale;},
      getTargetSize(){return{width:target.width,height:target.height};},
      setSize(width,height){
        lastWidth=Math.max(1,Math.floor(Number(width)||1));
        lastHeight=Math.max(1,Math.floor(Number(height)||1));
        const scaledWidth=Math.max(1,Math.round(lastWidth*resolutionScale));
        const scaledHeight=Math.max(1,Math.round(lastHeight*resolutionScale));
        if(target.width!==scaledWidth||target.height!==scaledHeight)target.setSize(scaledWidth,scaledHeight);
      },
      render(renderer,writeBuffer,readBuffer){
        if(!readBuffer?.texture)return;
        const uniforms=this.uniforms;
        if(uniforms.tDiffuse)uniforms.tDiffuse.value=readBuffer.texture;
        if(uniforms.tDepth&&!uniforms.tDepth.value)uniforms.tDepth.value=readBuffer.depthTexture||null;
        const previousAutoClear=renderer.autoClear;
        try{
          renderer.autoClear=true;
          renderer.setRenderTarget(target);
          renderer.render(processScene,camera);
          compositeMaterial.uniforms.tDiffuse.value=readBuffer.texture;
          compositeMaterial.uniforms.tEffect.value=target.texture;
          compositeMaterial.uniforms.uIntensity.value=Number(uniforms.uIntensity?.value)||0;
          renderer.setRenderTarget(this.renderToScreen?null:writeBuffer);
          renderer.render(compositeScene,camera);
        }finally{
          renderer.autoClear=previousAutoClear;
        }
      },
      dispose(){
        target.dispose?.();
        geometry.dispose?.();
        processMaterial.dispose?.();
        compositeMaterial.dispose?.();
      }
    };
    pass.setSize(1,1);
    return pass;
  }

  function createGodRaysPass(FX,Three) {
    if(!FX?.ShaderPass||!Three?.Vector2)return null;
    const shader={
      uniforms:{
        tDiffuse:{value:null},
        uLightPosition:{value:new Three.Vector2(.5,.78)},
        uIntensity:{value:0},
        uDensity:{value:.92},
        uDecay:{value:.965},
        uWeight:{value:.82},
        uThreshold:{value:.58},
        uSamples:{value:16}
      },
      vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:[
        'uniform sampler2D tDiffuse;uniform vec2 uLightPosition;',
        'uniform float uDensity;uniform float uDecay;uniform float uWeight;uniform float uThreshold;uniform float uSamples;',
        'varying vec2 vUv;',
        'void main(){',
        'vec2 delta=(vUv-uLightPosition)*(uDensity/max(1.0,uSamples));',
        'vec2 coord=vUv;float illuminationDecay=1.0;vec3 shafts=vec3(0.0);',
        'for(int i=0;i<32;i++){if(float(i)>=uSamples)break;coord-=delta;',
        'vec3 sampleColor=texture2D(tDiffuse,clamp(coord,vec2(.001),vec2(.999))).rgb;',
        'float luminance=dot(sampleColor,vec3(.2126,.7152,.0722));',
        'float bright=smoothstep(uThreshold,uThreshold+.38,luminance);',
        'shafts+=sampleColor*bright*illuminationDecay;illuminationDecay*=uDecay;}',
        'gl_FragColor=vec4(shafts*(uWeight/max(1.0,uSamples)),1.0);',
        '}'
      ].join('\n')
    };
    const composite=[
      'uniform sampler2D tDiffuse;uniform sampler2D tEffect;uniform float uIntensity;',
      'varying vec2 vUv;',
      'void main(){vec4 source=texture2D(tDiffuse,vUv);vec3 rays=texture2D(tEffect,vUv).rgb;',
      'gl_FragColor=vec4(source.rgb+rays*uIntensity,source.a);}'
    ].join('\n');
    const pass=createScaledFullscreenPass(Three,shader,composite,.5);
    if(!pass)return null;
    pass.setSamples=value=>{shader.uniforms.uSamples.value=Math.max(4,Math.min(32,Math.round(Number(value)||16)));return shader.uniforms.uSamples.value;};
    pass.getStats=()=>({
      resolutionScale:pass.getResolutionScale(),
      samples:shader.uniforms.uSamples.value,
      decay:shader.uniforms.uDecay.value
    });
    return pass;
  }

  function createVolumetricFogPass(FX,Three) {
    if(!FX?.ShaderPass||!Three?.DepthTexture)return null;
    const shader={
      uniforms:{
        tDiffuse:{value:null},tDepth:{value:null},
        uInverseProjection:{value:new Three.Matrix4()},
        uCameraWorld:{value:new Three.Matrix4()},
        uFogColor:{value:new Three.Color('#b9d8d9')},
        uFogDensity:{value:.012},uHeightFalloff:{value:.018},uBaseHeight:{value:0},
        uTime:{value:0},uSunDirection:{value:new Three.Vector3(-.35,.82,-.44).normalize()},
        uSteps:{value:10}
      },
      vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:[
        'uniform sampler2D tDiffuse;uniform sampler2D tDepth;',
        'uniform mat4 uInverseProjection;uniform mat4 uCameraWorld;',
        'uniform vec3 uFogColor;uniform vec3 uSunDirection;',
        'uniform float uFogDensity;uniform float uHeightFalloff;uniform float uBaseHeight;uniform float uTime;uniform float uSteps;',
        'varying vec2 vUv;',
        'float noise3(vec3 p){return .5+.5*sin(p.x*.73+sin(p.y*.51+p.z*.91)*1.7+uTime*.025);}',
        'void main(){',
        'vec4 col=texture2D(tDiffuse,vUv);float z=texture2D(tDepth,vUv).x;',
        'if(z>=.99999||uFogDensity<=.00001){gl_FragColor=col;return;}',
        'vec4 q=uInverseProjection*vec4(vUv*2.0-1.0,z*2.0-1.0,1.0);vec3 vp=q.xyz/max(1e-6,q.w);',
        'vec3 origin=uCameraWorld[3].xyz;vec3 endp=(uCameraWorld*vec4(vp,1.0)).xyz;',
        'vec3 ray=endp-origin;float len=length(ray);vec3 dir=ray/max(len,1e-5);',
        'float optical=0.0;vec3 scatter=vec3(0.0);const int MAX_STEPS=24;float count=clamp(uSteps,4.0,24.0);float ds=len/count;',
        'for(int i=0;i<MAX_STEPS;i++){if(float(i)>=count)break;float f=(float(i)+.5)/count;vec3 p=origin+dir*(len*f);',
        'float h=max(0.0,p.y-uBaseHeight);float density=uFogDensity*exp(-h*uHeightFalloff);',
        'density*=mix(.84,1.08,noise3(p*.07));',
        'float seg=density*ds;float trans=exp(-optical);',
        'float cosTheta=max(dot(-dir,normalize(uSunDirection)),0.0);',
        'float phase=.58+.42*pow(cosTheta,8.0);',
        'scatter+=uFogColor*trans*(1.0-exp(-seg))*phase;optical+=seg;}',
        'float trans=exp(-optical);gl_FragColor=vec4(col.rgb*trans+scatter,col.a);}',
      ].join('\n')
    };
    const composite=[
      'uniform sampler2D tDiffuse;uniform sampler2D tEffect;',
      'varying vec2 vUv;',
      'void main(){gl_FragColor=texture2D(tEffect,vUv);}'
    ].join('\n');
    const pass=createScaledFullscreenPass(Three,shader,composite,.5);
    if(!pass)return null;
    pass.setStepCount=value=>{shader.uniforms.uSteps.value=Math.max(4,Math.min(24,Math.round(Number(value)||10)));return shader.uniforms.uSteps.value;};
    pass.getStats=()=>({
      resolutionScale:pass.getResolutionScale(),
      steps:shader.uniforms.uSteps.value,
      heightFalloff:shader.uniforms.uHeightFalloff.value
    });
    return pass;
  }

  window.PStudioEnvironmentFX={
    configureObject,configureWater,configureFoliage,configureUnderwater,configureParallax,configureTriplanar,update,configureAtmosphere,createGodRaysPass,createVolumetricFogPass,createVolumetricCloudPass,
    setSceneDepthTexture(texture,width,height,near,far){for(const material of water){const u=material?.userData?.pstudioWaterHQ;if(!u?.sceneDepth||!u?.viewport?.set||!u?.near||!u?.far||!u?.sceneDepthValid)continue;if(!['sceneDepth','near','far','sceneDepthValid'].every(key=>Object.prototype.hasOwnProperty.call(u[key],'value')))continue;u.sceneDepth.value=texture||null;u.viewport.value.set(Math.max(1,width||1),Math.max(1,height||1));u.near.value=Math.max(.001,near||.1);u.far.value=Math.max(u.near.value+1,far||1600);u.sceneDepthValid.value=texture?1:0;}},
    configureToon,
    releaseObject(object){releaseOutline(object);},
    releaseMaterial(material){water.delete(material);waterDetailMaterials.delete(material);foliage.delete(material);toonMaterials.delete(material);caustics.delete(material);parallaxMaterials.delete(material);triplanarMaterials.delete(material);},
    getStats:()=>({waterMaterials:water.size,waterDetailMaterials:waterDetailMaterials.size,foliageMaterials:foliage.size,toonMaterials:toonMaterials.size,causticMaterials:caustics.size,parallaxMaterials:parallaxMaterials.size,triplanarMaterials:triplanarMaterials.size,cloudPasses:cloudPasses.size})
  };
})();