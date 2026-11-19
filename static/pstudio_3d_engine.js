/* PStudio isolated 3D renderer.
 * This module only owns the additional WebGL canvas; the existing 2D renderer is untouched.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('game-3d-canvas');
  if (!canvas) return;
  let renderer = null;
  let composer=null,bloomPass=null,ssaoPass=null,gtaoPass=null,ssrPass=null,outputPass=null;
  let bloomEnabled=false,ssaoEnabled=false,bloomStrength=0.45;
  let ssrEnabled=false,qualityAOEnabled=false,qualityPreset='auto';
  let hdrTexture=null,hdrEnvironmentTarget=null,hdrShowBackground=false,bakedLightProbe=null,bakedLightProbeVolume=null;
  const worldChunks=new Map(),objectChunkAssignments=new Map();
  const worldRenderConfig={maxDrawDistance:2400,lodDistances:[25,70,150],shadowDistance:180,probeBlendCount:4};
  let particleClock=0,lastRenderDurationMs=0;
  const waterMaterials=new Set();
  const instancedBatches=new Map();
  let pmremGenerator = null, environmentTarget = null;
  let scene = null;
  let camera = null;
  let primitiveGroup = null;
  let modelGroup = null;
  let selectionGroup = null;
  const modelCache = new Map();
  const modelPromises = new Map();
  const modelRevisions = new Map();
  const modelInstances = new Map();
  const modelLoadErrors = new Map();
  let lastCommands = null;
  let selectedOwnerId = null;
  let selectionSignature = '';
  let gridGroup = null;
  let hemisphereLight = null;
  let keyLight = null;
  const dynamicLights = new Map();
  const particleBursts = new Map();
  const particleEmitters = new Map();
  const modelCollisionCache = new Map();
  const transformedCollisionCache = new Map();
  let environmentTexture = null;
  let environmentSignature = '';
  const meshCache = new Map();
  const gridCache = new Map();
  let lastSize = { width: 0, height: 0 };
  let orbitYaw = 0, orbitPitch = 0, zoom = 1, pointerMode = null, pointerStart = null, dragInfo = null;
  let raycaster = null, cameraCollisionRaycaster = null, pointerNdc = null, controlsReady = false;
  const activePointers = new Map();
  let pinchDistance = 0;
  let pinchGestureStart = null;
  let pinchGestureMode = null;
  let cameraTarget = [0, 0, 0];
  let cameraBase = [6, 5, 8];
  let activeCameraOwnerId = null;
  let cameraPan = null;
  let cameraSmoothing = 0;
  let smoothedTarget = null;
  let smoothedPosition = null;
  let pinchMidpoint = null;
  let lastObjectTap = null;
  const DOUBLE_TAP_MS = 500;
  const DOUBLE_TAP_DISTANCE = 40;

  function setupControls() {
    if (controlsReady) return;
    controlsReady = true;
    raycaster = new window.THREE.Raycaster();
    cameraCollisionRaycaster = new window.THREE.Raycaster();
    pointerNdc = new window.THREE.Vector2();
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => {
      if (!renderer || !camera) return;
      activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(activePointers.size===2){const pts=[...activePointers.values()];pinchDistance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);pinchMidpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};pinchGestureStart={distance:pinchDistance,midpoint:{...pinchMidpoint}};pinchGestureMode=null;pointerMode='pinch';dragInfo=null;lastObjectTap=null;try{canvas.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      if(e.button===1 || e.button===2 || (e.button===0 && e.shiftKey)){pointerMode='pan';pointerStart={x:e.clientX,y:e.clientY};lastObjectTap=null;try{canvas.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      // During Play, pointer drags control the third-person camera rather than editing scene objects.
      if(window.PStudioEngine?.isRunning?.()){
        pointerMode='orbit';
        pointerStart={x:e.clientX,y:e.clientY};
        lastObjectTap=null;
        try{canvas.setPointerCapture(e.pointerId)}catch(_){}
        e.preventDefault();
        return;
      }
      const rect=canvas.getBoundingClientRect();
      pointerNdc.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
      raycaster.setFromCamera(pointerNdc,camera);
      const hit=raycaster.intersectObjects([primitiveGroup,modelGroup].filter(Boolean),true).find(h=>h.object.userData.ownerId!==undefined||h.object.userData.instanceOwnerIds?.[h.instanceId]!==undefined);
      pointerStart={x:e.clientX,y:e.clientY};
      if(hit){
        const sourceKey=hit.object.userData.instanceSourceKeys?.[hit.instanceId];
        const mesh=(sourceKey&&meshCache.get(sourceKey))||hit.object.userData.modelRoot||hit.object;
        const ownerId=mesh.userData.ownerId??hit.object.userData.instanceOwnerIds?.[hit.instanceId];
        window.PStudioSceneInteraction?.select?.(ownerId);
        const now=Date.now(),tap=lastObjectTap;
        const isDoubleTap=!!(tap&&tap.ownerId===ownerId&&now-tap.time<=DOUBLE_TAP_MS&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)<=DOUBLE_TAP_DISTANCE);
        if(isDoubleTap){
          lastObjectTap=null;
          window.PStudioSceneInteraction?.toggleManipulation?.(ownerId);
          refreshSelectionOutline();
          if(renderer&&scene&&camera)drawFrame();
          pointerMode='double-tap';dragInfo=null;
        }else{
          const enabled=window.PStudioSceneInteraction?.isManipulationEnabled?.(ownerId)!==false;
          if(!enabled){pointerMode='locked-object';dragInfo={ownerId};}
          else{
            const normal=new window.THREE.Vector3();
            camera.getWorldDirection(normal);
            const plane=new window.THREE.Plane().setFromNormalAndCoplanarPoint(normal,mesh.position);
            const point=new window.THREE.Vector3();
            if(raycaster.ray.intersectPlane(plane,point)){pointerMode='object-pending';dragInfo={mesh,ownerId,plane,startPoint:point,startPosition:mesh.position.clone()};}
            else {pointerMode='orbit';dragInfo=null;}
          }
        }
      }else{pointerMode='orbit';dragInfo=null;lastObjectTap=null;}
      try{canvas.setPointerCapture(e.pointerId)}catch(_){} e.preventDefault();
    });
    canvas.addEventListener('pointermove',e=>{
      if(!pointerMode||!renderer)return;
      if(lastObjectTap&&Math.hypot(e.clientX-lastObjectTap.x,e.clientY-lastObjectTap.y)>DOUBLE_TAP_DISTANCE)lastObjectTap=null;
      if(activePointers.has(e.pointerId))activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointerMode==='pinch'&&activePointers.size>=2){const pts=[...activePointers.values()];const distance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);const midpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};if(!pinchGestureMode&&pinchGestureStart){const zoomDelta=Math.abs(distance-pinchGestureStart.distance);const panDelta=Math.hypot(midpoint.x-pinchGestureStart.midpoint.x,midpoint.y-pinchGestureStart.midpoint.y);if(Math.max(zoomDelta,panDelta)>5)pinchGestureMode=zoomDelta>panDelta*1.15?'zoom':'pan';}if(pinchGestureMode==='zoom'&&pinchDistance>0)zoom=Math.max(0.25,Math.min(4,zoom*(distance/Math.max(1,pinchDistance))));else if(pinchGestureMode==='pan'&&pinchMidpoint)panCamera(midpoint.x-pinchMidpoint.x,midpoint.y-pinchMidpoint.y);pinchDistance=distance;pinchMidpoint=midpoint;}
      else if(pointerMode==='orbit'){
        const dx=e.clientX-pointerStart.x,dy=e.clientY-pointerStart.y;
        orbitYaw+=dx*0.006;orbitPitch=Math.max(-1.35,Math.min(1.35,orbitPitch+dy*0.006));pointerStart={x:e.clientX,y:e.clientY};
      }else if(pointerMode==='pan'){panCamera(e.clientX-pointerStart.x,e.clientY-pointerStart.y);pointerStart={x:e.clientX,y:e.clientY};}else if(pointerMode==='object-pending'&&dragInfo&&Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)>6){pointerMode='object';}else if(pointerMode==='object'&&dragInfo){
        const rect=canvas.getBoundingClientRect();pointerNdc.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);raycaster.setFromCamera(pointerNdc,camera);
        const point=new window.THREE.Vector3();
        if(raycaster.ray.intersectPlane(dragInfo.plane,point)){
          const pos=dragInfo.startPosition.clone().add(point.sub(dragInfo.startPoint));
          dragInfo.mesh.position.copy(pos);
          window.PStudioSceneInteraction?.moveWorld?.(dragInfo.ownerId,pos.x,pos.y,pos.z);
          refreshSelectionOutline();
          drawFrame();
        }
      }
      if(pointerMode==='orbit' || pointerMode==='pinch' || pointerMode==='pan') updateCamera();
      e.preventDefault();
    });
    const end=e=>{if(activePointers.has(e.pointerId)){if(pointerMode==='object-pending'||pointerMode==='locked-object'){lastObjectTap={ownerId:dragInfo?.ownerId||selectedOwnerId,time:Date.now(),x:e.clientX,y:e.clientY};}else if(pointerMode!=='double-tap')lastObjectTap=null;}activePointers.delete(e.pointerId);if(activePointers.size===1){const remaining=[...activePointers.values()][0];pointerMode='orbit';pointerStart={x:remaining.x,y:remaining.y};}else if(activePointers.size===0){pointerMode=null;dragInfo=null;pointerStart=null;pinchDistance=0;pinchMidpoint=null;pinchGestureStart=null;pinchGestureMode=null;}};
    canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
    canvas.addEventListener('wheel',e=>{zoom=Math.max(0.25,Math.min(4,zoom*Math.exp(e.deltaY*0.00075)));updateCamera();e.preventDefault();},{passive:false});
    canvas.addEventListener('contextmenu',e=>e.preventDefault());
  }
  const QUALITY_PROFILES={
    mobile:{pixelRatio:1,shadowSize:1024,shadowMode:'pcf',ao:false,ssr:false},
    balanced:{pixelRatio:1.5,shadowSize:2048,shadowMode:'pcf',ao:false,ssr:false},
    high:{pixelRatio:2,shadowSize:3072,shadowMode:'vsm',ao:true,ssr:true},
    ultra:{pixelRatio:2,shadowSize:4096,shadowMode:'vsm',ao:true,ssr:true}
  };
  function resolveQualityPreset(name){if(name!=='auto')return QUALITY_PROFILES[name]?name:'balanced';return Number(window.navigator?.maxTouchPoints||0)>0||Number(window.innerWidth||0)<760?'balanced':'high';}
  function applyQualityPreset(name='auto'){
    qualityPreset=QUALITY_PROFILES[name]?name:'auto';
    const selected=resolveQualityPreset(qualityPreset),profile=QUALITY_PROFILES[selected];
    qualityAOEnabled=profile.ao&&!!ssaoPass;ssrEnabled=profile.ssr&&!!ssrPass;
    if(renderer){
      renderer.setPixelRatio(Math.min(Math.max(1,Number(window.devicePixelRatio)||1),profile.pixelRatio));
      composer?.setPixelRatio?.(renderer.getPixelRatio());
      renderer.shadowMap.enabled=true;
      renderer.shadowMap.type=profile.shadowMode==='vsm'?window.THREE.VSMShadowMap:window.THREE.PCFSoftShadowMap;
      renderer.shadowMap.needsUpdate=true;
      if(keyLight?.shadow){keyLight.shadow.mapSize.set(profile.shadowSize,profile.shadowSize);keyLight.shadow.radius=profile.shadowMode==='vsm'?4:3;if('blurSamples' in keyLight.shadow)keyLight.shadow.blurSamples=profile.shadowMode==='vsm'?8:4;keyLight.shadow.bias=-0.00008;keyLight.shadow.normalBias=0.018;keyLight.shadow.needsUpdate=true;}
      lastSize={width:0,height:0};resize();
    }
    try{window.PStudioEvents?.emit('render.quality.changed',{requested:qualityPreset,active:selected,profile});}catch(_){}
    return {preset:selected,...profile};
  }

  function ensureRenderer(){
    if(renderer)return true;
    if(!window.THREE||!window.THREE.WebGLRenderer)return false;
    const T=window.THREE;
    renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
    if(renderer.info)renderer.info.autoReset=false;
    renderer.outputColorSpace=T.SRGBColorSpace;
    renderer.toneMapping=T.ACESFilmicToneMapping;
    renderer.toneMappingExposure=1.12;
    renderer.setClearColor(0x171d26,1);
    if('useLegacyLights' in renderer)renderer.useLegacyLights=false;
    scene=new T.Scene();scene.background=new T.Color(0x171d26);
    if(T.PMREMGenerator){
      pmremGenerator=new T.PMREMGenerator(renderer);pmremGenerator.compileEquirectangularShader?.();
      if(window.PStudioRoomEnvironment){const room=new window.PStudioRoomEnvironment();environmentTarget=pmremGenerator.fromScene(room,0.04);scene.environment=environmentTarget.texture;room.dispose?.();}
    }
    camera=new T.PerspectiveCamera(55,16/9,0.1,1600);camera.position.set(6,5,8);camera.lookAt(0,0,0);
    const FX=window.PStudioPostFX;
    if(FX?.EffectComposer&&FX?.RenderPass&&FX?.OutputPass){
      composer=new FX.EffectComposer(renderer);composer.setPixelRatio?.(renderer.getPixelRatio());composer.addPass(new FX.RenderPass(scene,camera));
      if(FX.GTAOPass){gtaoPass=new FX.GTAOPass(scene,camera,Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight));if(FX.GTAOPass.OUTPUT?.Denoise!==undefined)gtaoPass.output=FX.GTAOPass.OUTPUT.Denoise;gtaoPass.enabled=false;composer.addPass(gtaoPass);ssaoPass=gtaoPass;}
      else if(FX.SSAOPass){ssaoPass=new FX.SSAOPass(scene,camera,Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight));ssaoPass.kernelRadius=8;ssaoPass.minDistance=0.001;ssaoPass.maxDistance=0.12;ssaoPass.enabled=false;composer.addPass(ssaoPass);}
      if(FX.SSRPass){try{ssrPass=new FX.SSRPass({renderer,scene,camera,width:Math.max(1,canvas.clientWidth),height:Math.max(1,canvas.clientHeight),selects:null});ssrPass.enabled=false;ssrPass.thickness=0.018;ssrPass.maxDistance=28;ssrPass.opacity=0.72;ssrPass.blur=true;composer.addPass(ssrPass);}catch(error){ssrPass=null;console.warn('[PStudio] SSR unavailable:',error);}}
      if(FX.UnrealBloomPass){bloomPass=new FX.UnrealBloomPass(new T.Vector2(Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight)),bloomStrength,0.35,0.84);bloomPass.enabled=false;composer.addPass(bloomPass);}
      outputPass=new FX.OutputPass();composer.addPass(outputPass);
    }
    primitiveGroup=new T.Group();modelGroup=new T.Group();gridGroup=new T.Group();selectionGroup=new T.Group();scene.add(primitiveGroup,modelGroup,gridGroup,selectionGroup);
    cameraPan=new T.Vector3();
    hemisphereLight=new T.HemisphereLight(0xeaf2ff,0x394150,0.9);scene.add(hemisphereLight);
    keyLight=new T.DirectionalLight(0xfff3df,2.8);keyLight.position.set(5,9,6);keyLight.castShadow=true;
    keyLight.shadow.mapSize.set(2048,2048);keyLight.shadow.camera.left=-32;keyLight.shadow.camera.right=32;keyLight.shadow.camera.top=32;keyLight.shadow.camera.bottom=-32;keyLight.shadow.camera.near=0.5;keyLight.shadow.camera.far=100;keyLight.shadow.camera.updateProjectionMatrix();keyLight.shadow.bias=-0.00008;keyLight.shadow.normalBias=0.018;
    scene.add(keyLight,keyLight.target);applyQualityPreset(qualityPreset);setupControls();return true;
  }

  function disposeGroup(group) {
    while (group.children.length) {
      const child = group.children[group.children.length - 1];
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    }
  }

  function resize() {
    if (!renderer) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (width !== lastSize.width || height !== lastSize.height) {
      renderer.setSize(width, height, false);composer?.setSize(width,height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastSize = { width, height };
    }
  }

  function drawFrame(){
    if(!renderer||!scene||!camera)return;
    renderer.info?.reset?.();
    const started=window.performance?.now?.()??Date.now();
    if(composer&&(bloomEnabled||ssaoEnabled||ssrEnabled)){
      if(bloomPass){bloomPass.enabled=bloomEnabled;bloomPass.strength=bloomStrength;}
      if(ssaoPass)ssaoPass.enabled=ssaoEnabled;
      if(ssrPass)ssrPass.enabled=ssrEnabled;
      composer.render();
    }else{
      if(ssaoPass)ssaoPass.enabled=false;
      if(ssrPass)ssrPass.enabled=false;
      renderer.render(scene,camera);
    }
    lastRenderDurationMs=Math.max(0,(window.performance?.now?.()??Date.now())-started);
  }

  function createGpuParticleSystem(capacity,color,size=0.085){
    const T=window.THREE,count=Math.max(1,Math.floor(capacity)),geometry=new T.BufferGeometry();
    const origins=new Float32Array(count*3),velocities=new Float32Array(count*3),births=new Float32Array(count),lifetimes=new Float32Array(count);
    geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(count*3),3));
    geometry.setAttribute('aOrigin',new T.BufferAttribute(origins,3));
    geometry.setAttribute('aVelocity',new T.BufferAttribute(velocities,3));
    geometry.setAttribute('aBirth',new T.BufferAttribute(births,1));
    geometry.setAttribute('aLife',new T.BufferAttribute(lifetimes,1));
    const uniforms={uTime:{value:particleClock},uColor:{value:new T.Color(color||'#ffffff')},uSize:{value:size},uPixelRatio:{value:renderer?.getPixelRatio?.()||1},uGravity:{value:2.4}};
    const material=new T.ShaderMaterial({uniforms,transparent:true,depthWrite:false,blending:T.AdditiveBlending,
      vertexShader:`attribute vec3 aOrigin;attribute vec3 aVelocity;attribute float aBirth;attribute float aLife;
uniform float uTime;uniform float uSize;uniform float uPixelRatio;uniform float uGravity;varying float vAlpha;
void main(){float age=max(0.0,uTime-aBirth);float alive=1.0-step(aLife,age);vec3 p=aOrigin+aVelocity*age+vec3(0.0,-0.5*uGravity*age*age,0.0);vec4 mvPosition=modelViewMatrix*vec4(p,1.0);gl_Position=projectionMatrix*mvPosition;gl_PointSize=clamp(uSize*uPixelRatio*(280.0/max(0.1,-mvPosition.z)),1.0,40.0);vAlpha=alive*(1.0-smoothstep(aLife*0.68,aLife,age));}`,
      fragmentShader:`uniform vec3 uColor;varying float vAlpha;void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);if(r>1.0||vAlpha<=0.002)discard;float soft=1.0-smoothstep(0.18,1.0,r);gl_FragColor=vec4(uColor,vAlpha*soft);\n#include <tonemapping_fragment>
#include <colorspace_fragment>}`
    });
    const points=new T.Points(geometry,material);points.frustumCulled=false;points.renderOrder=3;geometry.setDrawRange(0,count);
    return{points,geometry,material,uniforms,capacity:count,cursor:0};
  }
  function spawnGpuParticle(system,origin,velocity,lifetime){
    const i=system.cursor%system.capacity;system.cursor=(system.cursor+1)%system.capacity;const a=system.geometry.attributes;
    a.aOrigin.setXYZ(i,origin[0],origin[1],origin[2]);a.aVelocity.setXYZ(i,velocity[0],velocity[1],velocity[2]);a.aBirth.setX(i,particleClock);a.aLife.setX(i,Math.max(0.05,Number(lifetime)||1));
    a.aOrigin.needsUpdate=true;a.aVelocity.needsUpdate=true;a.aBirth.needsUpdate=true;a.aLife.needsUpdate=true;
  }
  function disposeGpuParticleSystem(system){if(!system)return;if(system.points.parent)system.points.parent.remove(system.points);system.geometry.dispose();system.material.dispose();}
  function updateGpuParticleSystems(){const ratio=renderer?.getPixelRatio?.()||1;for(const emitter of particleEmitters.values()){emitter.system.uniforms.uTime.value=particleClock;emitter.system.uniforms.uPixelRatio.value=ratio;}for(const effect of particleBursts.values()){effect.system.uniforms.uTime.value=particleClock;effect.system.uniforms.uPixelRatio.value=ratio;}}

  function configureWaterMaterial(material) {
    const uniforms={uPStudioTime:{value:0},uPStudioWaveAmplitude:{value:0.075}};
    material.onBeforeCompile=shader=>{
      shader.uniforms.uPStudioTime=uniforms.uPStudioTime;
      shader.uniforms.uPStudioWaveAmplitude=uniforms.uPStudioWaveAmplitude;
      shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
uniform float uPStudioTime;
uniform float uPStudioWaveAmplitude;
`);
      shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>',`#include <beginnormal_vertex>
float pstudioPhaseA=position.x*0.42+position.z*0.27+uPStudioTime*0.82;
float pstudioPhaseB=position.x*0.78-position.z*0.51-uPStudioTime*0.57;
float pstudioDx=uPStudioWaveAmplitude*0.42*cos(pstudioPhaseA)+uPStudioWaveAmplitude*0.34*0.78*cos(pstudioPhaseB);
float pstudioDz=uPStudioWaveAmplitude*0.27*cos(pstudioPhaseA)-uPStudioWaveAmplitude*0.34*0.51*cos(pstudioPhaseB);
objectNormal=normalize(vec3(-pstudioDx,1.0,-pstudioDz));
`);
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
float pstudioWaveA=sin(position.x*0.42+position.z*0.27+uPStudioTime*0.82);
float pstudioWaveB=sin(position.x*0.78-position.z*0.51-uPStudioTime*0.57);
transformed.y+=uPStudioWaveAmplitude*pstudioWaveA+uPStudioWaveAmplitude*0.34*pstudioWaveB;
`);
    };
    material.customProgramCacheKey=()=>'pstudio-water-waves-v1';
    material.userData.pstudioWaterUniforms=uniforms;
    waterMaterials.add(material);
    return material;
  }

  async function loadEnvironmentHDR(url,options={}) {
    if(!ensureRenderer())throw new Error('The 3D renderer is not available.');
    if(!window.PStudioHDRLoader)throw new Error('RGBE/HDR loader is unavailable.');
    const address=String(url||'').trim();
    if(!address)throw new TypeError('An HDR environment URL is required.');
    const T=window.THREE,loader=new window.PStudioHDRLoader();
    if(loader.setDataType&&T.HalfFloatType!==undefined)loader.setDataType(T.HalfFloatType);
    const texture=await loader.loadAsync(address);
    texture.mapping=T.EquirectangularReflectionMapping;
    texture.colorSpace=T.LinearSRGBColorSpace||T.NoColorSpace;
    if(!pmremGenerator)pmremGenerator=new T.PMREMGenerator(renderer);
    const nextTarget=pmremGenerator.fromEquirectangular(texture);
    const previousTarget=hdrEnvironmentTarget||environmentTarget,previousTexture=hdrTexture;
    hdrEnvironmentTarget=nextTarget;environmentTarget=nextTarget;hdrTexture=texture;
    scene.environment=nextTarget.texture;
    hdrShowBackground=options.background!==false;
    if(hdrShowBackground)scene.background=texture;
    scene.environmentIntensity=Math.max(0,Math.min(5,Number.isFinite(Number(options.intensity))?Number(options.intensity):1));
    if(previousTarget&&previousTarget!==nextTarget)previousTarget.dispose?.();
    if(previousTexture&&previousTexture!==texture)previousTexture.dispose?.();
    if(renderer&&scene&&camera)drawFrame();
    return{loaded:true,width:texture.image?.width||0,height:texture.image?.height||0};
  }

  function bakeLightProbe(options={}) {
    if(!ensureRenderer())throw new Error('The 3D renderer is not available.');
    const generator=window.PStudioPostFX?.LightProbeGenerator;
    if(!generator?.fromCubeRenderTarget)throw new Error('LightProbeGenerator is unavailable.');
    const T=window.THREE,size=Math.max(32,Math.min(256,Math.floor(Number(options.resolution)||128)));
    const target=new T.WebGLCubeRenderTarget(size,{format:T.RGBAFormat,type:T.HalfFloatType,generateMipmaps:true,minFilter:T.LinearMipmapLinearFilter});
    const cubeCamera=new T.CubeCamera(0.1,Math.max(50,Number(options.far)||300),target);
    cubeCamera.position.set(Number(options.x)||0,Number(options.y)||1.5,Number(options.z)||0);
    if(bakedLightProbe)scene.remove(bakedLightProbe);
    if(bakedLightProbeVolume){for(const item of bakedLightProbeVolume)scene.remove(item.light);bakedLightProbeVolume=null;}
    const oldAutoUpdate=renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate=true;
    try{
      scene.add(cubeCamera);
      cubeCamera.update(renderer,scene);
      scene.remove(cubeCamera);
      bakedLightProbe=generator.fromCubeRenderTarget(renderer,target);
      bakedLightProbe.intensity=Math.max(0,Math.min(3,Number.isFinite(Number(options.intensity))?Number(options.intensity):1));
      scene.add(bakedLightProbe);
      renderer.setRenderTarget(null);
      drawFrame();
      return{baked:true,resolution:size,kind:'global-diffuse-light-probe',note:'単一のグローバル照明プローブです。面ごとのライトマップではありません。'};
    }finally{
      scene.remove(cubeCamera);
      renderer.shadowMap.autoUpdate=oldAutoUpdate;
      target.dispose();
    }
  }


  function registerWorldChunk(id,o={}){const key=String(id||'').trim();if(!key||key.length>128)throw new TypeError('Invalid world chunk id.');const loadDistance=Math.max(1,Number(o.loadDistance)||800),unloadDistance=Math.max(loadDistance,Number(o.unloadDistance)||loadDistance*1.2),coordinate=v=>Number.isFinite(Number(v))?Number(v):0;worldChunks.set(key,{id:key,x:coordinate(o.x),y:coordinate(o.y),z:coordinate(o.z),loadDistance,unloadDistance,active:worldChunks.get(key)?.active??true});return{id:key,loadDistance,unloadDistance};}
  function assignObjectToChunk(ownerId,chunkId){const id=String(chunkId);if(!worldChunks.has(id))throw new Error('World chunk is not registered: '+id);objectChunkAssignments.set(String(ownerId),id);return true;}
  function unregisterWorldChunk(id){const key=String(id);if(!worldChunks.delete(key))return false;for(const [owner,chunk] of objectChunkAssignments)if(chunk===key)objectChunkAssignments.delete(owner);return true;}
  function isOwnerChunkActive(ownerId){const chunk=worldChunks.get(objectChunkAssignments.get(String(ownerId)));return !chunk||chunk.active;}
  function updateWorldChunkStates(){if(!camera)return;for(const c of worldChunks.values()){const d=camera.position.distanceTo(new window.THREE.Vector3(c.x,c.y,c.z));if(c.active&&d>c.unloadDistance)c.active=false;else if(!c.active&&d<c.loadDistance)c.active=true;}}
  function setWorldRenderConfig(o={}){if(Number.isFinite(Number(o.maxDrawDistance)))worldRenderConfig.maxDrawDistance=Math.max(50,Math.min(20000,Number(o.maxDrawDistance)));if(Number.isFinite(Number(o.shadowDistance)))worldRenderConfig.shadowDistance=Math.max(32,Math.min(1000,Number(o.shadowDistance)));if(Array.isArray(o.lodDistances)&&o.lodDistances.length){const a=o.lodDistances.slice(0,8).map(Number);if(a.every(Number.isFinite)&&a.every((v,i)=>v>0&&(i===0||v>a[i-1])))worldRenderConfig.lodDistances=a;}if(Number.isFinite(Number(o.probeBlendCount)))worldRenderConfig.probeBlendCount=Math.max(1,Math.min(8,Math.floor(Number(o.probeBlendCount))));return{...worldRenderConfig,lodDistances:worldRenderConfig.lodDistances.slice()};}
  function updateProbeVolumeBlend(){if(!bakedLightProbeVolume||!camera)return;const n=Math.min(worldRenderConfig.probeBlendCount,bakedLightProbeVolume.length),near=bakedLightProbeVolume.map(item=>({item,d:item.position.distanceToSquared(camera.position)})).sort((a,b)=>a.d-b.d).slice(0,n);let sum=0;for(const e of near){e.w=1/Math.max(1,e.d);sum+=e.w;}const active=new Set(near.map(e=>e.item));for(const e of near)e.item.light.intensity=e.item.baseIntensity*e.w/Math.max(1e-8,sum);for(const item of bakedLightProbeVolume)if(!active.has(item))item.light.intensity=0;}
  async function bakeLightProbeVolume(o={}) {
    if(!ensureRenderer())throw new Error('The 3D renderer is not available.');
    const generator=window.PStudioPostFX?.LightProbeGenerator;if(!generator?.fromCubeRenderTarget)throw new Error('LightProbeGenerator is unavailable.');
    const min=o.min||{x:-12,y:0,z:-12},max=o.max||{x:12,y:8,z:12};
    for(const axis of ['x','y','z'])if(!Number.isFinite(Number(min[axis]))||!Number.isFinite(Number(max[axis]))||Number(max[axis])<=Number(min[axis]))throw new RangeError('Probe volume bounds must be finite and max must exceed min on every axis.');
    const dims=['x','y','z'].map(a=>Math.max(2,Math.min(4,Math.floor(Number(o[a+'Count'])||2)))),positions=[];
    for(let z=0;z<dims[2];z++)for(let y=0;y<dims[1];y++)for(let x=0;x<dims[0];x++)positions.push(new window.THREE.Vector3(Number(min.x)+(Number(max.x)-Number(min.x))*x/(dims[0]-1),Number(min.y)+(Number(max.y)-Number(min.y))*y/(dims[1]-1),Number(min.z)+(Number(max.z)-Number(min.z))*z/(dims[2]-1)));
    if(positions.length>32)throw new RangeError('A probe volume is limited to 32 samples.');
    const T=window.THREE,size=Math.max(32,Math.min(128,Math.floor(Number(o.resolution)||64))),previous=bakedLightProbeVolume,previousSingle=bakedLightProbe,newVolume=[];
    for(const item of previous||[])scene.remove(item.light);if(previousSingle)scene.remove(previousSingle);
    const oldAuto=renderer.shadowMap.autoUpdate;renderer.shadowMap.autoUpdate=true;
    try{
      for(const position of positions){const target=new T.WebGLCubeRenderTarget(size,{format:T.RGBAFormat,type:T.HalfFloatType,generateMipmaps:true,minFilter:T.LinearMipmapLinearFilter}),cube=new T.CubeCamera(.1,Math.max(50,Number(o.far)||500),target);cube.position.copy(position);
        try{scene.add(cube);cube.update(renderer,scene);scene.remove(cube);const light=generator.fromCubeRenderTarget(renderer,target);light.position.copy(position);newVolume.push({position,light,baseIntensity:Math.max(0,Math.min(3,Number.isFinite(Number(o.intensity))?Number(o.intensity):1))});}
        finally{scene.remove(cube);target.dispose();}
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      bakedLightProbe=null;bakedLightProbeVolume=newVolume;for(const item of newVolume)scene.add(item.light);updateProbeVolumeBlend();renderer.setRenderTarget(null);drawFrame();
      return{baked:true,probes:newVolume.length,kind:'camera-local-spatial-irradiance-volume',resolution:size,note:'カメラ位置に応じて近傍プローブをブレンドする近似方式です。オブジェクト単位の完全なマルチバウンスGIではありません。'};
    }catch(error){for(const item of newVolume){scene.remove(item.light);item.light.dispose?.();}bakedLightProbeVolume=previous;bakedLightProbe=previousSingle;for(const item of previous||[])scene.add(item.light);if(previousSingle)scene.add(previousSingle);throw error;}
    finally{renderer.shadowMap.autoUpdate=oldAuto;renderer.setRenderTarget(null);}
  }
  function updateDirectionalShadowAnchor(target){if(!keyLight?.shadow||!camera)return;const sh=keyLight.shadow,extent=worldRenderConfig.shadowDistance,texel=extent*2/Math.max(1,sh.mapSize.x),x=Math.round(target.x/texel)*texel,z=Math.round(target.z/texel)*texel,anchor=new window.THREE.Vector3(x,target.y,z);keyLight.position.set(x+5,target.y+9,z+6);keyLight.target.position.copy(anchor);keyLight.target.updateMatrixWorld();sh.camera.left=-extent;sh.camera.right=extent;sh.camera.top=extent;sh.camera.bottom=-extent;sh.camera.near=.5;sh.camera.far=extent*3;sh.camera.updateProjectionMatrix();sh.needsUpdate=true;}
  function updateWorldVisibility(){if(!camera)return;updateWorldChunkStates();const max=worldRenderConfig.maxDrawDistance;for(const mesh of meshCache.values())mesh.visible=isOwnerChunkActive(mesh.userData.ownerId)&&camera.position.distanceTo(mesh.position)<=max;
    for(const instance of modelInstances.values()){const d=camera.position.distanceTo(instance.root.position),active=isOwnerChunkActive(instance.ownerId)&&d<=max;instance.root.visible=active;if(!active||!instance.lodLevels||instance.lodLevels.length<2)continue;const idx=worldRenderConfig.lodDistances.findIndex(v=>d<v),selected=instance.lodLevels[Math.min(idx<0?worldRenderConfig.lodDistances.length:idx,instance.lodLevels.length-1)];if(instance.activeLOD!==selected.level){for(const level of instance.lodLevels)for(const entry of level.entries)entry.object.visible=level.level===selected.level&&entry.visible;instance.activeLOD=selected.level;}}
    for(const batch of instancedBatches.values()){const sources=batch.userData.instanceSources||[],dummy=new window.THREE.Object3D(),owners=[],keys=[];let count=0;for(const source of sources){const d=camera.position.distanceTo(source.mesh.position);if(d>max||!isOwnerChunkActive(source.mesh.userData.ownerId))continue;dummy.position.copy(source.mesh.position);dummy.quaternion.copy(source.mesh.quaternion);dummy.scale.copy(source.mesh.scale);dummy.updateMatrix();batch.setMatrixAt(count,dummy.matrix);owners[count]=source.mesh.userData.ownerId;keys[count]=source.sourceKey;count++;}batch.count=count;batch.userData.instanceOwnerIds=owners;batch.userData.instanceSourceKeys=keys;batch.instanceMatrix.needsUpdate=true;batch.visible=count>0;if(count)batch.computeBoundingSphere();}
    updateProbeVolumeBlend();updateDirectionalShadowAnchor(new window.THREE.Vector3(cameraTarget[0],cameraTarget[1],cameraTarget[2]));
  }

  function panCamera(dx, dy) {
    if (!camera || !window.THREE) return;
    const T = window.THREE;
    const target = new T.Vector3(cameraTarget[0], cameraTarget[1], cameraTarget[2]).add(cameraPan || new T.Vector3());
    const distance = camera.position.distanceTo(target);
    const scale = Math.max(0.001, distance * 0.00125);
    const right = new T.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new T.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    cameraPan.addScaledVector(right, -dx * scale);
    cameraPan.addScaledVector(up, dy * scale);
  }

  const CAMERA_CLEARANCE = 0.28;
  const CAMERA_MIN_DISTANCE = 0.42;

  function resolveCameraCollision(target, desiredPosition, excludedOwnerId) {
    if(!cameraCollisionRaycaster||!primitiveGroup||!modelGroup)return desiredPosition;
    const offset=desiredPosition.clone().sub(target);
    const distance=offset.length();
    if(distance<=CAMERA_MIN_DISTANCE)return desiredPosition;
    const direction=offset.multiplyScalar(1/distance);
    const worldUp=new window.THREE.Vector3(0,1,0);
    let right=new window.THREE.Vector3().crossVectors(direction,worldUp);
    if(right.lengthSq()<1e-8)right.set(1,0,0);
    else right.normalize();
    const up=new window.THREE.Vector3().crossVectors(right,direction).normalize();
    const side=0.22,vertical=0.16;
    const origins=[
      target.clone(),
      target.clone().addScaledVector(right,side),
      target.clone().addScaledVector(right,-side),
      target.clone().addScaledVector(up,vertical),
      target.clone().addScaledVector(up,-vertical)
    ];
    // Raycaster reads matrixWorld; refresh it after the runtime moved this frame's objects.
    primitiveGroup.updateMatrixWorld(true);
    modelGroup.updateMatrixWorld(true);
    let safeDistance=distance;
    const roots=[primitiveGroup,modelGroup];
    for(const origin of origins){
      cameraCollisionRaycaster.set(origin,direction);
      cameraCollisionRaycaster.near=0.04;
      cameraCollisionRaycaster.far=safeDistance;
      const hits=cameraCollisionRaycaster.intersectObjects(roots,true);
      const hit=hits.find(item=>{
        const ownerId=item.object?.userData?.ownerId;
        return ownerId===undefined||ownerId===null||ownerId!==excludedOwnerId;
      });
      if(hit){
        safeDistance=Math.min(safeDistance,Math.max(CAMERA_MIN_DISTANCE,hit.distance-CAMERA_CLEARANCE));
      }
    }
    return target.clone().addScaledVector(direction,safeDistance);
  }

  function getCameraBasis() {
    let direction;
    if(camera&&window.THREE){
      direction=new window.THREE.Vector3();
      camera.getWorldDirection(direction);
    }else{
      const offset=new window.THREE.Vector3(
        cameraBase[0]-cameraTarget[0],
        cameraBase[1]-cameraTarget[1],
        cameraBase[2]-cameraTarget[2]
      );
      offset.applyAxisAngle(new window.THREE.Vector3(0,1,0),orbitYaw);
      direction=offset.negate();
    }
    direction.y=0;
    if(direction.lengthSq()<1e-8)direction.set(0,0,-1);
    direction.normalize();
    return {
      forwardX:direction.x,
      forwardZ:direction.z,
      rightX:-direction.z,
      rightZ:direction.x
    };
  }

  function updateCamera(deltaTime = 1 / 60, excludedOwnerId = activeCameraOwnerId) {
    if (!renderer || !camera || !window.THREE) return;
    const T = window.THREE;
    const target = new T.Vector3(cameraTarget[0], cameraTarget[1], cameraTarget[2]).add(cameraPan || new T.Vector3());
    const offset = new T.Vector3(cameraBase[0], cameraBase[1], cameraBase[2]).sub(target).multiplyScalar(zoom);
    offset.applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    const right = new T.Vector3(1, 0, 0).applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    offset.applyAxisAngle(right, orbitPitch);
    const desiredPosition = target.clone().add(offset);
    if (!smoothedTarget || !smoothedPosition) {
      smoothedTarget = target.clone();
      smoothedPosition = desiredPosition.clone();
    }
    if (cameraSmoothing > 0) {
      const dt = Math.max(0, Math.min(0.1, Number(deltaTime) || 0));
      const alpha = 1 - Math.exp(-cameraSmoothing * dt);
      smoothedTarget.lerp(target, alpha);
      smoothedPosition.lerp(desiredPosition, alpha);
    } else {
      smoothedTarget.copy(target);
      smoothedPosition.copy(desiredPosition);
    }
    const collisionSafePosition=resolveCameraCollision(target,smoothedPosition,excludedOwnerId);
    camera.position.copy(collisionSafePosition);
    camera.lookAt(smoothedTarget);
    for(const instance of modelInstances.values()){
      if(!instance.lodLevels||instance.lodLevels.length<2)continue;
      const distance=camera.position.distanceTo(instance.root.position);
      const targetIndex=worldRenderConfig.lodDistances.findIndex(v=>distance<v);
      const selected=instance.lodLevels[Math.min(targetIndex<0?worldRenderConfig.lodDistances.length:targetIndex,instance.lodLevels.length-1)];
      if(instance.activeLOD===selected.level)continue;
      for(const level of instance.lodLevels){
        const visible=level.level===selected.level;
        for(const entry of level.entries)entry.object.visible=visible&&entry.visible;
      }
      instance.activeLOD=selected.level;
    }
    updateWorldVisibility();
    resize();
    drawFrame();
  }

  function refreshSelectionOutline() {
    if (!selectionGroup || !window.THREE) return;
    const canManipulate = selectedOwnerId
      && window.PStudioSceneInteraction?.isManipulationEnabled?.(selectedOwnerId) !== false;
    if (!selectedOwnerId || !primitiveGroup || !canManipulate) {
      if(selectionGroup.children.length)disposeGroup(selectionGroup);
      selectionSignature='';
      return;
    }
    const T = window.THREE;
    const meshes = [];
    for(const mesh of meshCache.values()){if(mesh.isMesh&&mesh.userData.ownerId===selectedOwnerId)meshes.push(mesh);}
    if (modelGroup) modelGroup.traverse(object => { if (object.isMesh && object.userData.ownerId === selectedOwnerId) meshes.push(object); });
    const signature=selectedOwnerId+':'+meshes.map(mesh=>mesh.uuid+':'+mesh.geometry?.uuid).join('|');
    if(signature!==selectionSignature){
      disposeGroup(selectionGroup);
      for (const mesh of meshes) {
        if(!mesh.geometry)continue;
        const edges = mesh.geometry.type === 'SphereGeometry' ? new T.WireframeGeometry(mesh.geometry) : new T.EdgesGeometry(mesh.geometry, 1);
        const material = new T.LineDashedMaterial({
          color: 0xffffff, dashSize: 0.12, gapSize: 0.08,
          transparent: true, opacity: 0.98, depthTest: false
        });
        const outline = new T.LineSegments(edges, material);
        outline.computeLineDistances();
        outline.renderOrder = 10;
        outline.userData.isSelectionOutline = true;
        outline.userData.sourceMesh = mesh;
        selectionGroup.add(outline);
      }
      selectionSignature=signature;
    }
    for(const outline of selectionGroup.children){
      const mesh=outline.userData.sourceMesh;
      if(!mesh)continue;
      mesh.updateWorldMatrix(true,false);
      mesh.matrixWorld.decompose(outline.position,outline.quaternion,outline.scale);
      outline.scale.multiplyScalar(1.015);
    }
  }
  function geometrySignature(d) {
    const n = v => Math.max(0.001, Number(v) || 0.001);
    switch (d.type) {
      case 'cube': return ['cube',n(d.size)].join(':');
      case 'box': return ['box',n(d.width),n(d.height),n(d.depth)].join(':');
      case 'sphere': return ['sphere',n(d.radius)].join(':');
      case 'plane': return ['plane',n(d.width),n(d.depth)].join(':');
      case 'cylinder': return ['cylinder',n(d.radius),n(d.height)].join(':');
      case 'cone': return ['cone',n(d.radius),n(d.height)].join(':');
      case 'capsule': return ['capsule',n(d.radius),Math.max(n(d.radius)*2,n(d.height))].join(':');
      case 'terrain': return ['terrain',n(d.width),n(d.depth),Math.max(2,Number(d.segments)||2),n(d.height)].join(':');
      case 'water': {const preset=resolveQualityPreset(qualityPreset),segments=preset==='ultra'?96:preset==='high'?72:48;return ['water',n(d.width),n(d.depth),segments].join(':');}
      default: return null;
    }
  }

  function getInstanceBatchKey(mesh){
    const type=mesh.userData?.primitiveType;
    if(!['cube','box','sphere','cylinder','cone','capsule'].includes(type))return null;
    const material=mesh.material;
    if(!material?.color||(!material.isMeshStandardMaterial&&!material.isMeshBasicMaterial&&!material.isMeshToonMaterial))return null;
    if(material.transparent||material.wireframe||material.transmission>0)return null;
    return [mesh.userData.signature,material.type,material.color.getHexString(),Number(material.roughness??0).toFixed(3),Number(material.metalness??0).toFixed(3)].join('|');
  }

  function updateInstancedBatches(){
    if(!window.THREE||!primitiveGroup)return;
    const T=window.THREE,groups=new Map(),desired=new Set(),batchedSources=new Set();
    for(const [sourceKey,mesh] of meshCache){
      if(mesh?.userData?.ownerId===undefined||mesh?.userData?.ownerId===null)continue;
      const key=getInstanceBatchKey(mesh);
      if(!key)continue;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({sourceKey,mesh});
    }
    const dummy=new T.Object3D();
    for(const [batchKey,items] of groups){
      if(items.length<3)continue;
      desired.add(batchKey);
      let batch=instancedBatches.get(batchKey);
      if(!batch||batch.userData.capacity<items.length){
        if(batch){primitiveGroup.remove(batch);batch.geometry.dispose();batch.material.dispose();}
        batch=new T.InstancedMesh(items[0].mesh.geometry.clone(),items[0].mesh.material.clone(),items.length);
        batch.userData.isPStudioInstanceBatch=true;
        batch.userData.capacity=items.length;
        batch.instanceMatrix.setUsage(T.DynamicDrawUsage);
        batch.castShadow=true;batch.receiveShadow=true;
        instancedBatches.set(batchKey,batch);primitiveGroup.add(batch);
      }
      batch.count=items.length;
      const ownerIds=new Array(items.length),sourceKeys=new Array(items.length);
      for(let i=0;i<items.length;i++){
        const source=items[i].mesh;
        dummy.position.copy(source.position);dummy.quaternion.copy(source.quaternion);dummy.scale.copy(source.scale);dummy.updateMatrix();
        batch.setMatrixAt(i,dummy.matrix);
        ownerIds[i]=source.userData.ownerId;sourceKeys[i]=items[i].sourceKey;
        batchedSources.add(items[i].sourceKey);
        if(source.parent===primitiveGroup)primitiveGroup.remove(source);
      }
      batch.userData.instanceOwnerIds=ownerIds;
      batch.userData.instanceSourceKeys=sourceKeys;
      batch.userData.instanceSources=items;
      batch.instanceMatrix.needsUpdate=true;
      batch.computeBoundingSphere();
    }
    for(const [key,batch] of instancedBatches){
      if(desired.has(key))continue;
      primitiveGroup.remove(batch);batch.geometry.dispose();batch.material.dispose();instancedBatches.delete(key);
    }
    for(const [sourceKey,mesh] of meshCache){
      if(!batchedSources.has(sourceKey)&&mesh.parent!==primitiveGroup)primitiveGroup.add(mesh);
    }
  }

  function createGeometry(d) {
    const T=window.THREE;
    switch (d.type) {
      case 'cube': return new T.BoxGeometry(d.size,d.size,d.size);
      case 'box': return new T.BoxGeometry(d.width,d.height,d.depth);
      case 'sphere': return new T.SphereGeometry(d.radius,24,16);
      case 'plane': return new T.PlaneGeometry(d.width,d.depth);
      case 'water': {const q=resolveQualityPreset(qualityPreset),segments=q==='ultra'?96:q==='high'?72:48;const g=new T.PlaneGeometry(d.width,d.depth,segments,segments);g.rotateX(-Math.PI/2);return g;}
      case 'terrain': {
        const g=new T.BufferGeometry(),vertices=[],indices=[],segments=Math.max(2,Math.min(96,Math.floor(d.segments)||2));
        for(let iz=0;iz<=segments;iz++)for(let ix=0;ix<=segments;ix++){const x=(ix/segments-.5)*d.width,z=(iz/segments-.5)*d.depth;const y=d.height*(Math.sin(x*.18)*Math.cos(z*.16)*.5+Math.sin((x+z)*.07)*.15);vertices.push(x,y,z);}
        for(let iz=0;iz<segments;iz++)for(let ix=0;ix<segments;ix++){const a=iz*(segments+1)+ix,b=a+1,c=a+segments+1,e=c+1;indices.push(a,c,b,b,c,e);}
        g.setAttribute('position',new T.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();return g;
      }
      case 'cylinder': return new T.CylinderGeometry(d.radius,d.radius,d.height,24);
      case 'cone': return new T.ConeGeometry(d.radius,d.height,24);
      case 'capsule': {
        const radius=Math.min(d.radius,d.height/2);
        const cylinderLength=Math.max(0.001,d.height-radius*2);
        const points=[];
        for(let i=0;i<=8;i++){
          const angle=(Math.PI/2)*(i/8);
          points.push(new T.Vector2(radius*Math.sin(angle),-cylinderLength/2-radius*Math.cos(angle)));
        }
        points.push(new T.Vector2(radius,cylinderLength/2));
        for(let i=1;i<=8;i++){
          const angle=Math.PI/2+(Math.PI/2)*(i/8);
          points.push(new T.Vector2(radius*Math.sin(angle),cylinderLength/2-radius*Math.cos(angle)));
        }
        return new T.LatheGeometry(points,24);
      }
      default: return null;
    }
  }

  function disposeMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.material) waterMaterials.delete(mesh.material);
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
    mesh.getRenderTarget?.()?.dispose?.();
  }

  function disposeModelAsset(asset) {
    if(!asset?.scene)return;
    const geometries=new Set(),materials=new Set(),textures=new Set();
    asset.scene.traverse(object=>{
      if(!object.isMesh)return;
      if(object.geometry)geometries.add(object.geometry);
      for(const material of (Array.isArray(object.material)?object.material:[object.material]))if(material)materials.add(material);
    });
    materials.forEach(material=>{
      for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    });
    geometries.forEach(geometry=>geometry.dispose());
    textures.forEach(texture=>texture.dispose());
    materials.forEach(material=>material.dispose());
  }

  function requestModelAsset(name) {
    if (modelCache.has(name)) return Promise.resolve(modelCache.get(name));
    if (modelPromises.has(name)) return modelPromises.get(name);
    const revision=modelRevisions.get(name)||0;
    const promise=(async()=>{
      if (!window.PStudioGLTFLoader) throw new Error('GLTFLoader is unavailable. Check the Three.js module connection.');
      if (!window.PStudioAssetStore) throw new Error('3D asset storage is unavailable.');
      const blob=await window.PStudioAssetStore.get(name);
      if (!blob) throw new Error('Model asset not found: '+name+' (import a .glb or .gltf file first)');
      const loader=new window.PStudioGLTFLoader();
      const source=name.toLowerCase().endsWith('.gltf') ? await blob.text() : await blob.arrayBuffer();
      const gltf=await new Promise((resolve,reject)=>loader.parse(source,'',resolve,reject));
      if (!gltf || !gltf.scene) throw new Error('The model file contains no scene: '+name);
      if((modelRevisions.get(name)||0)!==revision){disposeModelAsset({scene:gltf.scene});return null;}
      const asset={scene:gltf.scene,animations:gltf.animations||[]};
      modelCache.set(name,asset);
      if(window.PStudioResources?.register){
        window.PStudioResources.register('model-gpu',name,asset,{
          category:'gpu',
          sizeBytes:Math.max(blob.size*2,blob.size+1024),
          metadata:{sourceBytes:blob.size,estimate:'decoded model and GPU allocation'},
          dispose:disposeModelAsset,
          onEvict:()=>{
            if(modelCache.get(name)===asset)modelCache.delete(name);
            modelCollisionCache.delete(name);
            for(const cacheKey of transformedCollisionCache.keys())if(cacheKey.startsWith(name+'|'))transformedCollisionCache.delete(cacheKey);
          }
        });
      }
      return asset;
    })().catch(error=>{
      const message=String(error?.message||error);
      if((modelRevisions.get(name)||0)===revision){
        modelLoadErrors.set(name,message);
        console.error('[PStudio] Model load failed:',name,error);
        window.dispatchEvent(new CustomEvent('pstudio-model-error',{detail:{name,error:message}}));
      }
      return null;
    }).then(asset=>{
      if(asset)modelLoadErrors.delete(name);
      if(asset && renderer && lastCommands) {
        try { render(lastCommands); } catch(error) { console.error('[PStudio] Model render failed:',error); }
      }
      return asset;
    }).finally(()=>{
      if(modelPromises.get(name)===promise&&modelCache.has(name))modelPromises.delete(name);
    });
    modelPromises.set(name,promise);
    return promise;
  }

  function createModelInstance(key, ownerId, name, asset) {
    const T=window.THREE;
    const clone=window.PStudioSkeletonUtils?.clone
      ? window.PStudioSkeletonUtils.clone(asset.scene)
      : asset.scene.clone(true);
    const materialDefaults=new Map();
    clone.userData.ownerId=ownerId;
    clone.traverse(object=>{
      object.userData.ownerId=ownerId;
      object.userData.modelRoot=clone;
      if(object.isMesh && object.material){
        object.castShadow=true;
        object.receiveShadow=true;
        const cloneMaterial=material=>{
          const copy=material.clone();
          materialDefaults.set(copy,{
            roughness:Number.isFinite(material.roughness)?material.roughness:0.72,
            metalness:Number.isFinite(material.metalness)?material.metalness:0.04
          });
          return copy;
        };
        object.material=Array.isArray(object.material)
          ? object.material.map(cloneMaterial)
          : cloneMaterial(object.material);
      }
    });
    const lodMap=new Map();
    clone.traverse(object=>{
      const match=String(object.name||'').match(/(?:^|[ _-])LOD([0-9]+)(?:$|[ _-])/i);
      if(!match)return;
      const level=Number(match[1]);
      if(!lodMap.has(level))lodMap.set(level,[]);
      lodMap.get(level).push({object,visible:object.visible});
    });
    const lodLevels=[...lodMap.entries()]
      .sort((a,b)=>a[0]-b[0])
      .map(([level,entries])=>({level,entries}));
    const mixer=asset.animations.length ? new T.AnimationMixer(clone) : null;
    const resourceLease=window.PStudioResources?.retain?.('model-gpu',name)||null;
    const instance={key,ownerId,name,root:clone,mixer,animations:asset.animations,materialDefaults,lodLevels,activeLOD:null,activeClip:null,activeLoop:true,speed:1,resourceLease};
    modelInstances.set(key,instance);
    modelGroup.add(clone);
    return instance;
  }

  function applyModelMaterial(instance, state) {
    if(!instance?.materialDefaults)return;
    instance.root.traverse(object=>{
      if(!object.isMesh||!object.material)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){const defaults=instance.materialDefaults.get(material);if(!defaults)continue;
        material.roughness=state&&Number.isFinite(state.roughness)?state.roughness:defaults.roughness;material.metalness=state&&Number.isFinite(state.metalness)?state.metalness:defaults.metalness;
        const override=state?.modelOverrides?.find(item=>item.name==='*'||item.name===object.name||item.name===material.name);
        if(override){if(Number.isFinite(override.roughness))material.roughness=Math.max(0,Math.min(1,override.roughness));if(Number.isFinite(override.metalness))material.metalness=Math.max(0,Math.min(1,override.metalness));if(override.color&&material.color)material.color.set(override.color);}
      }
    });
  }

  function updateModelIK(instance, ik) {
    if(!ik||!instance?.root)return;const T=window.THREE;let root=null,end=null;
    instance.root.traverse(object=>{if(object.isBone&&object.name===ik.rootBone)root=object;if(object.isBone&&object.name===ik.endBone)end=object;});if(!root||!end||root===end)return;
    const target=new T.Vector3(...ik.target),weight=Math.max(0,Math.min(1,Number(ik.weight)||0));if(weight<=0)return;
    for(let iteration=0;iteration<Math.max(1,Math.min(20,ik.iterations||8));iteration++){
      let joint=end.parent,changed=false;while(joint&&joint!==root.parent){
        if(joint.isBone){instance.root.updateMatrixWorld(true);const jointPos=new T.Vector3(),endPos=new T.Vector3();joint.getWorldPosition(jointPos);end.getWorldPosition(endPos);const from=endPos.sub(jointPos).normalize(),to=target.clone().sub(jointPos).normalize();if(from.lengthSq()>0.5&&to.lengthSq()>0.5){const worldDelta=new T.Quaternion().setFromUnitVectors(from,to),parentQuat=new T.Quaternion();if(joint.parent)joint.parent.getWorldQuaternion(parentQuat);const localDelta=parentQuat.clone().invert().multiply(worldDelta).multiply(parentQuat);const desired=joint.quaternion.clone().premultiply(localDelta);joint.quaternion.slerp(desired,weight);joint.updateMatrixWorld(true);changed=true;}}
        if(joint===root)break;joint=joint.parent;
      }
      if(!changed)break;instance.root.updateMatrixWorld(true);const endPos=new T.Vector3();end.getWorldPosition(endPos);if(endPos.distanceToSquared(target)<0.0004)break;
    }
  }

  function updateModelAnimation(instance, state, dt) {
    if(!instance.mixer) return;
    if(state.speed !== undefined) instance.speed=state.speed;
    if(state.blend){
      const findClip=name=>instance.animations.find(item=>item.name.toLowerCase()===String(name).toLowerCase())||instance.animations.find(item=>item.name.toLowerCase().includes(String(name).toLowerCase()));
      const clipA=findClip(state.blend.first),clipB=findClip(state.blend.second);
      if(clipA&&clipB){
        const signature=clipA.name+'|'+clipB.name;
        if(instance.activeBlend!==signature){for(const action of instance.blendActions||[])action.fadeOut(0.12);const actionA=instance.mixer.clipAction(clipA),actionB=instance.mixer.clipAction(clipB);actionA.reset().setLoop(window.THREE.LoopRepeat,Infinity).setEffectiveWeight(1-state.blend.weight).fadeIn(0.12).play();actionB.reset().setLoop(window.THREE.LoopRepeat,Infinity).setEffectiveWeight(state.blend.weight).fadeIn(0.12).play();instance.blendActions=[actionA,actionB];instance.activeBlend=signature;instance.activeClip=null;}
        instance.blendActions[0].setEffectiveWeight(1-state.blend.weight);instance.blendActions[1].setEffectiveWeight(state.blend.weight);
      }
    }else if(instance.activeBlend){for(const action of instance.blendActions||[])action.fadeOut(0.12);instance.activeBlend=null;instance.blendActions=[];}
    if(state.stop){
      instance.mixer.stopAllAction();
      instance.activeClip=null;instance.activeBlend=null;instance.blendActions=[];
    }
    if(state.layers){
      const active=new Set();
      for(const layer of state.layers){const clip=instance.animations.find(item=>item.name.toLowerCase()===String(layer.clip).toLowerCase())||instance.animations.find(item=>item.name.toLowerCase().includes(String(layer.clip).toLowerCase()));if(!clip)continue;active.add(clip.name);if(!instance.layerActions)instance.layerActions=new Map();let action=instance.layerActions.get(clip.name);if(!action){action=instance.mixer.clipAction(clip);action.reset();action.setLoop(window.THREE.LoopRepeat,Infinity);if(layer.additive)action.blendMode=window.THREE.AdditiveAnimationBlendMode;action.play();instance.layerActions.set(clip.name,action);}action.enabled=true;action.setEffectiveWeight(Math.max(0,Math.min(1,layer.weight)));}
      if(instance.layerActions)for(const [name,action] of instance.layerActions){if(!active.has(name)){action.fadeOut(0.12);instance.layerActions.delete(name);}}
    }else if(instance.layerActions){for(const action of instance.layerActions.values())action.fadeOut(0.12);instance.layerActions.clear();}
    if(state.blend){
      instance.mixer.timeScale=instance.speed;
      instance.mixer.update(Math.max(0,Math.min(0.1,Number(dt)||0)));
      return;
    }
    if(state.clipName){
      const requested=state.clipName.toLowerCase();
      const clip=instance.animations.find(item=>item.name.toLowerCase()===requested)
        || instance.animations.find(item=>item.name.toLowerCase().includes(requested));
      const existingAction=clip ? instance.mixer.existingAction(clip) : null;
      const completedOneShot=!!(clip && state.loop===false && existingAction && !existingAction.isRunning());
      if(clip && (instance.activeClip!==clip.name || instance.activeLoop!==state.loop || completedOneShot)){
        const previousClip=instance.animations.find(item=>item.name===instance.activeClip);
        const previousAction=previousClip ? instance.mixer.existingAction(previousClip) : null;
        const action=instance.mixer.clipAction(clip);
        action.reset();
        action.enabled=true;
        action.setEffectiveWeight(1);
        action.setLoop(state.loop===false ? window.THREE.LoopOnce : window.THREE.LoopRepeat, state.loop===false ? 1 : Infinity);
        action.clampWhenFinished=state.loop===false;
        if(previousAction && previousAction!==action){
          if(previousAction.isRunning()){
            previousAction.crossFadeTo(action,0.18,false);
          }else{
            previousAction.stopFading();
            previousAction.fadeOut(0.12);
            action.fadeIn(0.12);
          }
        }else{
          action.fadeIn(0.12);
        }
        action.play();
        instance.activeClip=clip.name;
        instance.activeLoop=state.loop!==false;
      } else if(!clip) {
        const warningKey=instance.name+':'+state.clipName;
        if(!modelLoadErrors.has(warningKey)){
          modelLoadErrors.set(warningKey,'animation clip not found');
          console.warn('[PStudio] Animation clip not found:',state.clipName,'in',instance.name);
        }
      }
    }
    instance.mixer.timeScale=instance.speed;
    instance.mixer.update(Math.max(0,Math.min(0.1,Number(dt)||0)));
  }

  function removeModelInstance(key) {
    const instance=modelInstances.get(key);
    if(!instance) return;
    if(instance.mixer) instance.mixer.stopAllAction();
    if(instance.root.parent) instance.root.parent.remove(instance.root);
    instance.root.traverse(object=>{
      if(!object.isMesh||!object.material)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      materials.forEach(material=>material.dispose());
    });
    modelInstances.delete(key);
    instance.resourceLease?.release?.();
  }

  function render(commandsByObject) {
    if (!ensureRenderer()) throw new Error('Three.js could not be loaded. The 3D view needs an internet connection.');
    const T = window.THREE;
    lastCommands=commandsByObject;
    bloomEnabled=false;ssaoEnabled=qualityAOEnabled;bloomStrength=0.45;
    let frameDelta=1/60;
    for(const commandList of commandsByObject.values()){const timing=commandList.find(item=>Number.isFinite(item.dt));if(timing){frameDelta=Math.max(0,Math.min(0.1,Number(timing.dt)||1/60));break;}}
    particleClock+=frameDelta;
    for(const material of waterMaterials){const u=material.userData?.pstudioWaterUniforms;if(u)u.uPStudioTime.value=particleClock;}
    const usedMeshes=new Set(),usedGrids=new Set(),usedModels=new Set(),usedLights=new Set(),usedEmitters=new Set(),stoppedEmitters=new Set(),preservedOwners=new Set();
    let cameraCommand=null,environment=null,cameraOwnerId=null;
    let defaultBackground=0x171d26;
    if(hdrTexture&&hdrShowBackground)scene.background=hdrTexture;
    else if(scene.background?.isColor)scene.background.set(defaultBackground);
    else scene.background=new T.Color(defaultBackground);
    scene.fog=null;
    if(hemisphereLight) hemisphereLight.intensity=1.15;
    if(keyLight){keyLight.position.set(5,9,6);keyLight.intensity=2.4;}
    for (const [ownerId,list] of commandsByObject.entries()) {
      if(!isOwnerChunkActive(ownerId)){preservedOwners.add(ownerId);continue;}
      let ownerMaterial=null;
      const modelOverrides=list.filter(command=>command.type==='model_material').map(d=>({name:String(d.name),roughness:Number(d.roughness),metalness:Number(d.metalness),color:d.color?String(d.color):null}));
      if(modelOverrides.length)ownerMaterial={modelOverrides};
      for (let commandIndex=0;commandIndex<list.length;commandIndex++) {
        const d=list[commandIndex];
        const key=String(ownerId)+':'+commandIndex;
        if (d.type==='camera') { cameraCommand=d; cameraOwnerId=d.cameraOwnerId??ownerId; continue; }
        if (d.type==='environment') { environment=Object.assign(environment||{},d); continue; }
      if(d.type==='postfx'){bloomEnabled=bloomEnabled||!!d.bloom;ssaoEnabled=ssaoEnabled||!!d.ssao;const strength=Number(d.strength);if(Number.isFinite(strength))bloomStrength=Math.max(0,Math.min(2,strength));continue;}
      if(d.type==='model_material')continue;
        if(d.type==='particle_emitter_stop'){stoppedEmitters.add(String(ownerId)+':'+String(d.emitterId));continue;}
        if(d.type==='particle_emitter'){
          const emitterKey=String(ownerId)+':'+String(d.emitterId);
          const capacity=Math.max(1,Math.min(1200,Math.floor(Number(d.maxCount)||100)));
          let emitter=particleEmitters.get(emitterKey);
          if(!emitter||emitter.capacity!==capacity){
            if(emitter)disposeGpuParticleSystem(emitter.system);
            const system=createGpuParticleSystem(capacity,d.color,0.085);
            primitiveGroup.add(system.points);
            emitter={system,capacity,accumulator:0,config:d};
            particleEmitters.set(emitterKey,emitter);
          }
          emitter.config=d;
          emitter.system.uniforms.uColor.value.set(d.color||'#ffffff');
          const dt=Math.max(0,Math.min(0.1,Number(d.dt)||frameDelta));
          emitter.accumulator+=Math.max(0,Number(d.rate)||0)*dt;
          const spawn=Math.min(capacity,Math.floor(emitter.accumulator));
          emitter.accumulator-=spawn;
          for(let n=0;n<spawn;n++){
            const angle=Math.random()*Math.PI*2,speed=Math.max(0,Number(d.speed)||1);
            spawnGpuParticle(emitter.system,[Number(d.x)||0,Number(d.y)||0,Number(d.z)||0],
              [Math.cos(angle)*speed*(0.3+Math.random()*0.7),(0.3+Math.random())*speed,Math.sin(angle)*speed*(0.3+Math.random()*0.7)],
              Number(d.lifetime)||1);
          }
          usedEmitters.add(emitterKey);continue;
        }
        if(d.type==='particles'){
          const burstKey=String(d.burstId);
          if(!particleBursts.has(burstKey)){
            if(particleBursts.size>=64){const oldestKey=particleBursts.keys().next().value;const oldest=particleBursts.get(oldestKey);disposeGpuParticleSystem(oldest.system);particleBursts.delete(oldestKey);}
            const count=Math.max(1,Math.min(400,Number(d.count)||1));
            const system=createGpuParticleSystem(count,d.color,0.095);
            primitiveGroup.add(system.points);
            const origin=[Number(d.x)||0,Number(d.y)||0,Number(d.z)||0],speed=Number(d.speed)||1,lifetime=Number(d.lifetime)||1;
            for(let i=0;i<count;i++){
              const theta=Math.random()*Math.PI*2,u=Math.random()*2-1,v=(0.25+Math.random()*0.75)*speed;
              spawnGpuParticle(system,origin,[Math.cos(theta)*Math.sqrt(1-u*u)*v,(u*0.8+0.35)*v,Math.sin(theta)*Math.sqrt(1-u*u)*v],lifetime);
            }
            particleBursts.set(burstKey,{system,expiresAt:particleClock+lifetime});
          }
          continue;
        }
        if(d.type==='light'){
          let light=dynamicLights.get(key);
          if(!light||light.userData.kind!==d.kind){if(light){scene.remove(light);if(light.target)scene.remove(light.target);}light=d.kind==='spot'?new T.SpotLight(d.color||0xffffff,Number(d.intensity)||0,Number(d.distance)||0,Number(d.angle)||Math.PI/5,0.35,1):new T.PointLight(d.color||0xffffff,Number(d.intensity)||0,Number(d.distance)||0,2);light.userData.kind=d.kind;light.castShadow=false;dynamicLights.set(key,light);scene.add(light);if(light.target)scene.add(light.target);}
          light.position.set(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);light.color.set(d.color||0xffffff);light.intensity=Math.max(0,Number(d.intensity)||0);if(d.distance!==undefined)light.distance=Math.max(0,Number(d.distance)||0);if(d.angle!==undefined&&light.angle!==undefined)light.angle=Number(d.angle);
          if(light.target){light.target.position.set(Number(d.targetX)||0,Number(d.targetY)||0,Number(d.targetZ)||0);light.target.updateMatrixWorld();}
          usedLights.add(key);continue;
        }
        if (d.type==='material') { ownerMaterial=Object.assign(ownerMaterial||{},{roughness:d.roughness===undefined?(ownerMaterial?.roughness??0.72):Math.max(0,Math.min(1,Number(d.roughness)||0)),metalness:d.metalness===undefined?(ownerMaterial?.metalness??0.04):Math.max(0,Math.min(1,Number(d.metalness)||0)),shader:d.shader||ownerMaterial?.shader||'standard',fragmentShader:d.fragmentShader||ownerMaterial?.fragmentShader||''}); continue; }
        if (d.type==='animation') continue;
        if (d.type==='model') {
          let instance=modelInstances.get(key);
          let asset=modelCache.get(d.name);
          if(!asset) { requestModelAsset(d.name); continue; }
          if(!instance || instance.name!==d.name) {
            if(instance)removeModelInstance(key);
            instance=createModelInstance(key,ownerId,d.name,asset);
          }
          instance.ownerId=ownerId;
          instance.root.position.set(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);
          instance.root.rotation.set(Number(d.rotationX)||0,Number(d.rotationY)||0,Number(d.rotationZ)||0);
          instance.root.scale.setScalar(Math.max(0.001,Number(d.scale)||1));
          applyModelMaterial(instance,ownerMaterial);
          const animState={loop:true,layers:[]};
          for(const item of list){
            if(item.type==='animation'){
              if(item.stop)animState.stop=true;
              if(item.clipName!==undefined){animState.clipName=item.clipName;animState.loop=item.loop!==false;}
              if(item.speed!==undefined)animState.speed=Number(item.speed);
            }else if(item.type==='animation_blend'){
              animState.blend={first:item.first,second:item.second,weight:Math.max(0,Math.min(1,Number(item.weight)||0))};
            }else if(item.type==='animation_layer'){
              animState.layers.push({clip:item.clip,weight:item.weight,additive:item.additive});
            }else if(item.type==='ik'){
              if(!animState.iks)animState.iks=[];animState.iks.push(item);
            }else if(item.type==='locomotion'){
              animState.locomotion=item;
            }
          }
          if(animState.locomotion&&!animState.clipName){
            const locomotion=animState.locomotion;
            const previousClip=instance.animations.find(item=>item.name===instance.activeClip);
            const previousAction=previousClip?instance.mixer?.existingAction(previousClip):null;
            const oneShotPlaying=instance.activeLoop===false&&previousAction?.isRunning();
            if(oneShotPlaying){
              animState.clipName=instance.activeClip;
              animState.loop=false;
            }else{
              const landSequence=Number(locomotion.landSequence)||0;
              if(locomotion.land&&landSequence>0&&landSequence!==instance.lastLandSequence){
                animState.clipName=locomotion.land;
                animState.loop=false;
                instance.lastLandSequence=landSequence;
              }else{
                const speed=Math.max(0,Number(locomotion.speed)||0);
                const firstAvailable=(...names)=>names.find(name=>typeof name==='string'&&name.trim().length>0)||'';
                if(!locomotion.grounded){
                  animState.clipName=(Number(locomotion.velocityY)||0)>0.12
                    ?firstAvailable(locomotion.jump,locomotion.fall,locomotion.idle)
                    :firstAvailable(locomotion.fall,locomotion.jump,locomotion.idle);
                }else if(speed>3.8){
                  animState.clipName=firstAvailable(locomotion.run,locomotion.walk,locomotion.idle);
                }else if(speed>0.18){
                  animState.clipName=firstAvailable(locomotion.walk,locomotion.run,locomotion.idle);
                }else{
                  animState.clipName=firstAvailable(locomotion.idle,locomotion.walk,locomotion.run);
                }
                animState.loop=true;
              }
            }
          }
          updateModelAnimation(instance,animState,d.dt);
          for(const ik of animState.iks||[])updateModelIK(instance,ik);
          usedModels.add(key);
          continue;
        }
        if (d.type==='grid') {
          let grid=gridCache.get(key);
          const signature=String(d.size)+':'+String(d.divisions);
          if(!grid||grid.userData.signature!==signature){
            if(grid){gridGroup.remove(grid);grid.geometry.dispose();grid.material.dispose();}
            grid=new T.GridHelper(d.size,d.divisions,0x7b8797,0x394352);
            grid.userData.signature=signature;
            gridCache.set(key,grid);
            gridGroup.add(grid);
          }
          grid.position.set(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);
          usedGrids.add(key);
          continue;
        }
        const signature=geometrySignature(d);
        if(!signature)continue;
        let mesh=meshCache.get(key);
        const shaderMode=ownerMaterial?.shader||'standard';
        const fragmentShader=ownerMaterial?.fragmentShader||'';
        if(!mesh||mesh.userData.signature!==signature||mesh.userData.shader!==shaderMode||mesh.userData.fragmentShader!==fragmentShader){
          if(mesh)disposeMesh(mesh);
          const geometry=createGeometry(d);
          if(!geometry)continue;
          const vertexShader='varying vec2 vUv;\nvoid main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
          let material;
          if(d.type==='water'){
            material=configureWaterMaterial(new T.MeshPhysicalMaterial({
              color:d.color||'#4f9fc2',roughness:0.075,metalness:0,
              transmission:0.82,ior:1.333,thickness:1.35,
              attenuationColor:new T.Color('#a5d9eb'),attenuationDistance:7.5,
              clearcoat:1,clearcoatRoughness:0.035,side:T.DoubleSide,
              transparent:false,depthWrite:true
            }));
          }else if(shaderMode==='custom'){
            material=new T.ShaderMaterial({uniforms:{uColor:{value:new T.Color(d.color||'#d1d5db')}},vertexShader,fragmentShader:fragmentShader||'uniform vec3 uColor; varying vec2 vUv; void main(){gl_FragColor=vec4(uColor,1.0);}',side:T.DoubleSide});
          }else if(shaderMode==='toon')material=new T.MeshToonMaterial({color:d.color||'#d1d5db',side:T.DoubleSide});
          else if(shaderMode==='unlit')material=new T.MeshBasicMaterial({color:d.color||'#d1d5db',side:T.DoubleSide});
          else if(shaderMode==='normal')material=new T.MeshNormalMaterial({side:T.DoubleSide});
          else material=new T.MeshStandardMaterial({color:d.color||'#d1d5db',roughness:d.type==='terrain'?0.92:0.72,metalness:0.04,wireframe:shaderMode==='wireframe',side:d.type==='terrain'?T.DoubleSide:T.FrontSide});
          mesh=new T.Mesh(geometry,material);
          mesh.castShadow=d.type!=='plane'&&d.type!=='water';
          mesh.receiveShadow=true;
          mesh.userData.signature=signature;mesh.userData.shader=shaderMode;mesh.userData.fragmentShader=fragmentShader;mesh.userData.primitiveType=d.type;
          meshCache.set(key,mesh);primitiveGroup.add(mesh);
        }
        if(d.color&&mesh.material.color&&mesh.material.color.getStyle()!==new T.Color(d.color).getStyle())mesh.material.color.set(d.color);
        if(mesh.material.uniforms?.uColor&&d.color)mesh.material.uniforms.uColor.value.set(d.color);
        if(d.type!=='water'){
          if('roughness' in mesh.material)mesh.material.roughness=ownerMaterial?ownerMaterial.roughness:(d.type==='terrain'?0.92:0.72);
          if('metalness' in mesh.material)mesh.material.metalness=ownerMaterial?ownerMaterial.metalness:0.04;
        }else mesh.material.transmission=Math.max(0.18,Math.min(0.98,Number(d.opacity)||0.82));
        mesh.userData.ownerId=ownerId;
        mesh.position.set(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);
        const baseRotationX=d.type==='plane'?-Math.PI/2:0;
        mesh.rotation.set(baseRotationX+(Number(d.rotationX)||0),Number(d.rotationY)||0,Number(d.rotationZ)||0);
        usedMeshes.add(key);
      }
    }
    for(const [key,mesh] of meshCache){if(!usedMeshes.has(key)&&!preservedOwners.has(mesh.userData.ownerId)){disposeMesh(mesh);meshCache.delete(key);}else if(preservedOwners.has(mesh.userData.ownerId))mesh.visible=false;}
    updateInstancedBatches();
    for(const [key,emitter] of particleEmitters){
      if(stoppedEmitters.has(key)||!usedEmitters.has(key)){disposeGpuParticleSystem(emitter.system);particleEmitters.delete(key);}
    }
    for(const key of stoppedEmitters){const emitter=particleEmitters.get(key);if(emitter){disposeGpuParticleSystem(emitter.system);particleEmitters.delete(key);}}
    for(const [key,effect] of particleBursts){if(particleClock>=effect.expiresAt){disposeGpuParticleSystem(effect.system);particleBursts.delete(key);}}
    updateGpuParticleSystems();
    for(const [key,light] of dynamicLights){if(!usedLights.has(key)){scene.remove(light);if(light.target)scene.remove(light.target);dynamicLights.delete(key);}}
    for(const [key,grid] of gridCache){if(!usedGrids.has(key)){gridGroup.remove(grid);grid.geometry.dispose();grid.material.dispose();gridCache.delete(key);}}
    for(const [key,instance] of modelInstances){if(!usedModels.has(key)&&!preservedOwners.has(instance.ownerId))removeModelInstance(key);else if(preservedOwners.has(instance.ownerId))instance.root.visible=false;}
    if(environment){
      if(environment.background){scene.background=new T.Color(environment.background);hdrShowBackground=false;}
      if(environment.environmentSky&&environment.environmentGround){
        const signature=environment.environmentSky+'|'+environment.environmentGround;
        if(signature!==environmentSignature){const c=document.createElement('canvas');c.width=512;c.height=256;const cx=c.getContext('2d'),g=cx.createLinearGradient(0,0,0,256);g.addColorStop(0,environment.environmentSky);g.addColorStop(1,environment.environmentGround);cx.fillStyle=g;cx.fillRect(0,0,512,256);environmentTexture?.dispose?.();environmentTexture=new T.CanvasTexture(c);environmentTexture.mapping=T.EquirectangularReflectionMapping;environmentTexture.colorSpace=T.SRGBColorSpace;environmentTexture.needsUpdate=true;if(pmremGenerator){const nextTarget=pmremGenerator.fromEquirectangular(environmentTexture);environmentTarget?.dispose?.();environmentTarget=nextTarget;hdrEnvironmentTarget=null;scene.environment=environmentTarget.texture;}else scene.environment=environmentTexture;environmentSignature=signature;}
        if('environmentIntensity' in scene)scene.environmentIntensity=Math.max(0,Number(environment.environmentIntensity)||0);
      }
      if(environment.fogColor){
        const near=Math.max(0,Number(environment.fogNear)||0);
        const far=Math.max(near+0.01,Number(environment.fogFar)||100);
        scene.fog=new T.Fog(environment.fogColor,near,far);
      }
      if(keyLight){
        if(Number.isFinite(environment.lightX))keyLight.position.x=environment.lightX;
        if(Number.isFinite(environment.lightY))keyLight.position.y=environment.lightY;
        if(Number.isFinite(environment.lightZ))keyLight.position.z=environment.lightZ;
        if(Number.isFinite(environment.lightIntensity))keyLight.intensity=environment.lightIntensity;
      }
    }
    cameraTarget = cameraCommand
      ? [cameraCommand.targetX, cameraCommand.targetY, cameraCommand.targetZ]
      : [0, 0, 0];
    cameraBase = cameraCommand
      ? [cameraCommand.x, cameraCommand.y, cameraCommand.z]
      : [6, 5, 8];
    cameraSmoothing = cameraCommand ? Math.max(0, Math.min(30, Number(cameraCommand.smoothing) || 0)) : 0;
    activeCameraOwnerId=cameraOwnerId;
    if(!cameraSmoothing){smoothedTarget=null;smoothedPosition=null;}
    refreshSelectionOutline();
    updateCamera(cameraCommand?.dt ?? 1 / 60,cameraOwnerId);
  }
  function clear() {
    if (!renderer) return;
    activeCameraOwnerId=null;
    for(const key of [...modelInstances.keys()])removeModelInstance(key);
    for(const batch of instancedBatches.values()){if(batch.parent)batch.parent.remove(batch);batch.geometry?.dispose?.();batch.material?.dispose?.();}instancedBatches.clear();
    for(const mesh of meshCache.values())disposeMesh(mesh);
    meshCache.clear();
    waterMaterials.clear();
    for(const grid of gridCache.values()){gridGroup.remove(grid);grid.geometry.dispose();grid.material.dispose();}
    gridCache.clear();
    disposeGroup(selectionGroup);
    for(const emitter of particleEmitters.values())disposeGpuParticleSystem(emitter.system);particleEmitters.clear();
    for(const effect of particleBursts.values())disposeGpuParticleSystem(effect.system);particleBursts.clear();
    particleClock=0;
    selectionSignature='';
    if(renderer)drawFrame();
  }

  function invalidateAsset(name) {
    const key=String(name);
    modelCollisionCache.delete(key);for(const cacheKey of transformedCollisionCache.keys())if(cacheKey.startsWith(key+'|'))transformedCollisionCache.delete(cacheKey);
    modelRevisions.set(key,(modelRevisions.get(key)||0)+1);
    const cachedAsset=modelCache.get(key);
    modelCache.delete(key);
    modelPromises.delete(key);
    modelLoadErrors.delete(key);
    for(const [instanceKey,instance] of modelInstances){
      if(instance.name===key)removeModelInstance(instanceKey);
    }
    const managed=window.PStudioResources?.remove?.('model-gpu',key,{force:true,reason:'asset-invalidated'})||false;
    if(cachedAsset&&!managed)disposeModelAsset(cachedAsset);
    if(renderer&&lastCommands){
      try{render(lastCommands);}catch(error){console.error('[PStudio] Asset refresh failed:',error);}
    }
  }
  function getModelCollisionTriangles(command){
    const asset=modelCache.get(command.name);if(!asset)return null;let local=modelCollisionCache.get(command.name);
    if(!local){const T=window.THREE;asset.scene.updateMatrixWorld(true);const vertices=[];let total=0;asset.scene.traverse(mesh=>{if(total>=4000||!mesh.isMesh||!mesh.geometry?.attributes?.position)return;const pos=mesh.geometry.attributes.position,index=mesh.geometry.index,count=index?index.count:pos.count,world=mesh.matrixWorld;const stride=Math.max(1,Math.ceil((count/3)/4000));for(let tri=0;tri+2<count&&total<4000;tri+=3*stride){for(let k=0;k<3;k++){const vi=index?index.getX(tri+k):tri+k;const v=new T.Vector3().fromBufferAttribute(pos,vi).applyMatrix4(world);vertices.push(v.x,v.y,v.z);}total++;}});local=vertices;modelCollisionCache.set(command.name,local);}
    const T=window.THREE,pos=new T.Vector3(Number(command.x)||0,Number(command.y)||0,Number(command.z)||0),rot=new T.Euler(Number(command.rotationX)||0,Number(command.rotationY)||0,Number(command.rotationZ)||0),sc=new T.Vector3().setScalar(Math.max(0.001,Number(command.scale)||1)),matrix=new T.Matrix4().compose(pos,new T.Quaternion().setFromEuler(rot),sc),signature=[command.name,pos.x,pos.y,pos.z,rot.x,rot.y,rot.z,sc.x].join('|');
    if(transformedCollisionCache.has(signature))return transformedCollisionCache.get(signature);
    const result=[];for(let i=0;i+8<local.length;i+=9)for(let j=0;j<9;j+=3){const v=new T.Vector3(local[i+j],local[i+j+1],local[i+j+2]).applyMatrix4(matrix);result.push(v.x,v.y,v.z);}
    transformedCollisionCache.set(signature,result);if(transformedCollisionCache.size>24)transformedCollisionCache.delete(transformedCollisionCache.keys().next().value);return result;
  }
  window.PStudio3D = {
    render,
    clear,
    setSelected: id => { selectedOwnerId = id || null; refreshSelectionOutline(); if (renderer && scene && camera) drawFrame(); },
    getCameraBasis,
    getModelCollisionTriangles,
    setPostProcessing:(bloom,ssao,strength,ssr)=>{bloomEnabled=!!bloom;ssaoEnabled=!!ssao;bloomStrength=Math.max(0,Math.min(2,Number(strength)||0.45));if(ssr!==undefined)ssrEnabled=!!ssr;if(renderer&&scene&&camera)drawFrame();},
    setQualityPreset:applyQualityPreset,
    getQualityPreset:()=>({requested:qualityPreset,active:resolveQualityPreset(qualityPreset)}),
    getStats:()=>renderer?{
      calls:renderer.info?.render?.calls||0,
      triangles:renderer.info?.render?.triangles||0,
      points:renderer.info?.render?.points||0,
      geometries:renderer.info?.memory?.geometries||0,
      textures:renderer.info?.memory?.textures||0,
      instancedBatches:instancedBatches.size,
      instancedInstances:[...instancedBatches.values()].reduce((sum,batch)=>sum+batch.count,0),
      gpuParticleSystems:particleEmitters.size+particleBursts.size,
      models:modelInstances.size,
      renderTimeMs:Number(lastRenderDurationMs.toFixed(2)),
      quality:resolveQualityPreset(qualityPreset)
    }:null,
    loadEnvironmentHDR,
    bakeLightProbe,
    clearLightProbe:()=>{let changed=false;if(bakedLightProbe){scene?.remove(bakedLightProbe);bakedLightProbe=null;changed=true;}if(bakedLightProbeVolume){for(const item of bakedLightProbeVolume){scene?.remove(item.light);item.light.dispose?.();}bakedLightProbeVolume=null;changed=true;}if(changed)drawFrame();return changed;},
    bakeLightProbeVolume,setWorldRenderConfig,registerWorldChunk,assignObjectToChunk,unregisterWorldChunk,
    getWorldStats:()=>({chunks:worldChunks.size,activeChunks:[...worldChunks.values()].filter(c=>c.active).length,assignedObjects:objectChunkAssignments.size,config:{...worldRenderConfig,lodDistances:worldRenderConfig.lodDistances.slice()}}),
    isAvailable: () => !!window.THREE,
    getModelError: name => modelLoadErrors.get(name) || null,
    invalidateAsset
  };
  window.addEventListener('resize', resize);
})();