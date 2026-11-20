/* PStudio isolated 3D renderer.
 * This module only owns the additional WebGL canvas; the existing 2D renderer is untouched.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('game-3d-canvas');
  if (!canvas) return;
  let renderer = null;
  let composer=null,bloomPass=null,ssaoPass=null,gtaoPass=null,ssrPass=null,outputPass=null,taaPass=null,smaaPass=null,volumetricFogPass=null;
  let bloomEnabled=false,ssaoEnabled=false,bloomStrength=0.45,volumetricFogEnabled=false,temporalAAEnabled=false;
  let ssrEnabled=false,qualityAOEnabled=false,qualityPreset='auto';
  let csm=null,adaptiveQualityEnabled=true,adaptiveQualityLevel=2,adaptiveFrameEMA=0,adaptiveSlowFrames=0,adaptiveFastFrames=0,adaptiveLastChange=0;
  let gpuTimerGl=null,gpuTimerExtension=null,gpuTimerQueries=[],lastGpuRenderDurationMs=0,lastGpuTimerTimestamp=0,adaptiveMetricSource='cpu-render-submission';
  let occlusionRaycaster=null,occlusionEnabled=true,occlusionCursor=0,occlusionFrame=0;
  let lastProbeCameraPosition=null;
  let hdrTexture=null,hdrEnvironmentTarget=null,hdrShowBackground=false,bakedLightProbe=null,bakedLightProbeVolume=null,bakedGIBounces=0;
  const worldChunks=new Map(),objectChunkAssignments=new Map();
  const worldRenderConfig={maxDrawDistance:2400,lodDistances:[25,70,150],shadowDistance:900,probeBlendCount:4};
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
  let interactionSurface = null;
  let cameraCommandSignature = null;
  let cameraFocusOwnerId = null;
  const pendingCameraFrames = new Set();
  let cameraUpdateRaf = 0;
  let lastOcclusionUpdate = 0;
  const DOUBLE_TAP_MS = 500;
  const DOUBLE_TAP_DISTANCE = 40;

  // Coalesce high-frequency touch/mouse events into one camera update per display frame.
  function scheduleCameraUpdate(excludedOwnerId = activeCameraOwnerId) {
    if (cameraUpdateRaf) return;
    cameraUpdateRaf = window.requestAnimationFrame(() => {
      cameraUpdateRaf = 0;
      updateCamera(1 / 60, excludedOwnerId);
    });
  }

  function setupControls() {
    if (controlsReady) return;
    controlsReady = true;
    raycaster = new window.THREE.Raycaster();
    cameraCollisionRaycaster = new window.THREE.Raycaster();
    pointerNdc = new window.THREE.Vector2();
    interactionSurface = canvas.parentElement || canvas;
    interactionSurface.style.touchAction = 'none';
    canvas.style.touchAction = 'none';
    interactionSurface.addEventListener('pointerdown', e => {
      if (!renderer || !camera) return;
      if (e.target?.closest?.('.touch-controls, #game-ui-overlay, button, input, select, textarea')) return;
      activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(activePointers.size===2){const pts=[...activePointers.values()];pinchDistance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);pinchMidpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};pinchGestureStart={distance:pinchDistance,midpoint:{...pinchMidpoint}};pinchGestureMode=null;pointerMode='pinch';dragInfo=null;lastObjectTap=null;try{interactionSurface.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      if(e.button===1 || e.button===2 || (e.button===0 && e.shiftKey)){pointerMode='pan';pointerStart={x:e.clientX,y:e.clientY};lastObjectTap=null;try{interactionSurface.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      // During Play, pointer drags control the third-person camera rather than editing scene objects.
      if(window.PStudioEngine?.isRunning?.()){
        pointerMode='orbit';
        pointerStart={x:e.clientX,y:e.clientY};
        lastObjectTap=null;
        try{interactionSurface.setPointerCapture(e.pointerId)}catch(_){}
        e.preventDefault();
        return;
      }
      const rect=canvas.getBoundingClientRect();
      const insideCanvas=e.clientX>=rect.left&&e.clientX<=rect.right&&e.clientY>=rect.top&&e.clientY<=rect.bottom&&rect.width>0&&rect.height>0;
      let hit=null;
      if(insideCanvas){
        pointerNdc.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
        raycaster.setFromCamera(pointerNdc,camera);
        hit=raycaster.intersectObjects([primitiveGroup,modelGroup].filter(Boolean),true).find(h=>h.object.userData.ownerId!==undefined||h.object.userData.instanceOwnerIds?.[h.instanceId]!==undefined);
      }
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
      try{interactionSurface.setPointerCapture(e.pointerId)}catch(_){} e.preventDefault();
    });
    interactionSurface.addEventListener('pointermove',e=>{
      if(!pointerMode||!renderer)return;
      if(lastObjectTap&&Math.hypot(e.clientX-lastObjectTap.x,e.clientY-lastObjectTap.y)>DOUBLE_TAP_DISTANCE)lastObjectTap=null;
      if(activePointers.has(e.pointerId))activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointerMode==='pinch'&&activePointers.size>=2){const pts=[...activePointers.values()];const distance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);const midpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};if(!pinchGestureMode&&pinchGestureStart){const zoomDelta=Math.abs(distance-pinchGestureStart.distance);const panDelta=Math.hypot(midpoint.x-pinchGestureStart.midpoint.x,midpoint.y-pinchGestureStart.midpoint.y);if(Math.max(zoomDelta,panDelta)>5)pinchGestureMode=zoomDelta>panDelta*1.15?'zoom':'pan';}if(pinchGestureMode==='zoom'&&pinchDistance>0)zoom=Math.max(0.25,Math.min(4,zoom*(distance/Math.max(1,pinchDistance))));else if(pinchGestureMode==='pan'&&pinchMidpoint)panCamera(midpoint.x-pinchMidpoint.x,midpoint.y-pinchMidpoint.y);pinchDistance=distance;pinchMidpoint=midpoint;}
      else if(pointerMode==='orbit'){
        const dx=e.clientX-pointerStart.x,dy=e.clientY-pointerStart.y;
        orbitYaw+=dx*0.006;orbitPitch=Math.max(-1.35,Math.min(1.35,orbitPitch+dy*0.006));pointerStart={x:e.clientX,y:e.clientY};
      }else if(pointerMode==='pan'){panCamera(e.clientX-pointerStart.x,e.clientY-pointerStart.y);pointerStart={x:e.clientX,y:e.clientY};}
      else if(pointerMode==='locked-object'&&dragInfo&&Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)>6){
        // When model manipulation is locked, dragging over the model orbits the camera.
        pointerMode='orbit';dragInfo=null;lastObjectTap=null;
        const dx=e.clientX-pointerStart.x,dy=e.clientY-pointerStart.y;
        orbitYaw+=dx*0.006;orbitPitch=Math.max(-1.35,Math.min(1.35,orbitPitch+dy*0.006));
        pointerStart={x:e.clientX,y:e.clientY};
      }else if(pointerMode==='object-pending'&&dragInfo&&Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)>6){pointerMode='object';}else if(pointerMode==='object'&&dragInfo){
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
      if(pointerMode==='orbit' || pointerMode==='pinch' || pointerMode==='pan') scheduleCameraUpdate();
      e.preventDefault();
    });
    const end=e=>{if(activePointers.has(e.pointerId)){if(pointerMode==='object-pending'||pointerMode==='locked-object'){lastObjectTap={ownerId:dragInfo?.ownerId||selectedOwnerId,time:Date.now(),x:e.clientX,y:e.clientY};}else if(pointerMode!=='double-tap')lastObjectTap=null;}activePointers.delete(e.pointerId);if(activePointers.size===1){const remaining=[...activePointers.values()][0];pointerMode='orbit';pointerStart={x:remaining.x,y:remaining.y};}else if(activePointers.size===0){pointerMode=null;dragInfo=null;pointerStart=null;pinchDistance=0;pinchMidpoint=null;pinchGestureStart=null;pinchGestureMode=null;}};
    interactionSurface.addEventListener('pointerup',end);interactionSurface.addEventListener('pointercancel',end);
    interactionSurface.addEventListener('wheel',e=>{zoom=Math.max(0.25,Math.min(4,zoom*Math.exp(e.deltaY*0.00075)));scheduleCameraUpdate();e.preventDefault();},{passive:false});
    interactionSurface.addEventListener('contextmenu',e=>e.preventDefault());
  }
  const QUALITY_PROFILES={
    mobile:{pixelRatio:1,shadowSize:1024,shadowMode:'pcf',ao:false,ssr:false},
    balanced:{pixelRatio:1.5,shadowSize:2048,shadowMode:'pcf',ao:false,ssr:false},
    high:{pixelRatio:2,shadowSize:3072,shadowMode:'vsm',ao:true,ssr:true},
    ultra:{pixelRatio:2,shadowSize:4096,shadowMode:'vsm',ao:true,ssr:true}
  };
  function resolveQualityPreset(name){if(name!=='auto')return QUALITY_PROFILES[name]?name:'balanced';return Number(window.navigator?.maxTouchPoints||0)>0?'mobile':Number(window.innerWidth||0)<760?'balanced':'high';}
  function applyQualityPreset(name='auto'){
    qualityPreset=QUALITY_PROFILES[name]?name:'auto';adaptiveQualityEnabled=qualityPreset==='auto';adaptiveQualityLevel=2;adaptiveFrameEMA=0;adaptiveSlowFrames=0;adaptiveFastFrames=0;
    const selected=resolveQualityPreset(qualityPreset),profile=QUALITY_PROFILES[selected];qualityAOEnabled=profile.ao&&!!ssaoPass;ssrEnabled=profile.ssr&&!!ssrPass;if(taaPass&&!temporalAAEnabled)taaPass.sampleLevel=selected==='ultra'?2:selected==='high'?1:0;if(smaaPass)smaaPass.enabled=!taaPass;
    if(renderer){
      renderer.setPixelRatio(Math.min(Math.max(0.6,Number(window.devicePixelRatio)||1),profile.pixelRatio));composer?.setPixelRatio?.(renderer.getPixelRatio());
      renderer.shadowMap.enabled=true;renderer.shadowMap.type=profile.shadowMode==='vsm'?window.THREE.VSMShadowMap:window.THREE.PCFSoftShadowMap;renderer.shadowMap.needsUpdate=true;
      const lights=csm?.lights?.length?csm.lights:(keyLight?[keyLight]:[]);
      for(const light of lights)if(light?.shadow){const size=csm?Math.min(2048,profile.shadowSize):profile.shadowSize;light.shadow.mapSize.set(size,size);light.shadow.dispose?.();light.shadow.radius=profile.shadowMode==='vsm'?4:3;light.shadow.bias=-0.00008;light.shadow.normalBias=0.018;light.shadow.needsUpdate=true;}
      if(csm){csm.maxFar=worldRenderConfig.shadowDistance;csm.updateFrustums?.();}lastSize={width:0,height:0};resize();
    }
    try{window.PStudioEvents?.emit('render.quality.changed',{requested:qualityPreset,active:selected,profile});}catch(_){}
    return{preset:selected,...profile,adaptiveLevel:adaptiveQualityLevel};
  }
  function applyAdaptiveQuality(){
    if(!adaptiveQualityEnabled||qualityPreset!=='auto'||!renderer)return;
    const now=window.performance?.now?.()??Date.now();const hasRecentGpuSample=!!gpuTimerGl&&lastGpuRenderDurationMs>0&&now-lastGpuTimerTimestamp<1500;adaptiveMetricSource=hasRecentGpuSample?'gpu-timer-query':'cpu-render-submission';const ms=hasRecentGpuSample?lastGpuRenderDurationMs:(Number(lastRenderDurationMs)||0);adaptiveFrameEMA=adaptiveFrameEMA?adaptiveFrameEMA*0.9+ms*0.1:ms;
    if(adaptiveFrameEMA>23){adaptiveSlowFrames++;adaptiveFastFrames=0;}else if(adaptiveFrameEMA<13){adaptiveFastFrames++;adaptiveSlowFrames=0;}else{adaptiveSlowFrames=Math.max(0,adaptiveSlowFrames-1);adaptiveFastFrames=0;}
    if(now-adaptiveLastChange<1800)return;
    let changed=false;if(adaptiveSlowFrames>=35&&adaptiveQualityLevel>0){adaptiveQualityLevel--;changed=true;}else if(adaptiveFastFrames>=150&&adaptiveQualityLevel<2){adaptiveQualityLevel++;changed=true;}if(!changed)return;
    adaptiveLastChange=now;adaptiveSlowFrames=0;adaptiveFastFrames=0;
    const base=QUALITY_PROFILES[resolveQualityPreset('auto')],scale=base.pixelRatio*[0.68,0.84,1][adaptiveQualityLevel];
    renderer.setPixelRatio(Math.min(Math.max(0.6,Number(window.devicePixelRatio)||1),scale));composer?.setPixelRatio?.(renderer.getPixelRatio());
    const effects=adaptiveQualityLevel>=1;qualityAOEnabled=effects&&base.ao&&!!ssaoPass;ssrEnabled=effects&&base.ssr&&!!ssrPass;
    const mapSize=[1024,1536,2048][adaptiveQualityLevel],lights=csm?.lights?.length?csm.lights:(keyLight?[keyLight]:[]);
    for(const light of lights)if(light?.shadow){light.shadow.mapSize.set(mapSize,mapSize);light.shadow.dispose?.();light.shadow.needsUpdate=true;}
    lastSize={width:0,height:0};resize();try{window.PStudioEvents?.emit('render.quality.adapted',{level:adaptiveQualityLevel,scale,renderTimeMs:adaptiveFrameEMA,source:adaptiveMetricSource});}catch(_){}
  }

  function ensureRenderer(){
    if(renderer)return true;
    if(!window.THREE||!window.THREE.WebGLRenderer)return false;
    const T=window.THREE;
    renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
    try{const gl=renderer.getContext(),extension=gl.getExtension?.('EXT_disjoint_timer_query_webgl2');if(extension&&typeof gl.createQuery==='function'&&typeof gl.getQueryParameter==='function'){gpuTimerGl=gl;gpuTimerExtension=extension;}else{gpuTimerGl=null;gpuTimerExtension=null;}}catch(error){gpuTimerGl=null;gpuTimerExtension=null;console.warn('[PStudio] GPU timing extension unavailable; CPU timing fallback will be used.',error);}
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
    const CSM=window.PStudioCSM;if(CSM){try{csm=new CSM({maxFar:worldRenderConfig.shadowDistance,cascades:3,mode:'practical',parent:scene,shadowMapSize:2048,lightDirection:new T.Vector3(-5,-9,-6).normalize(),camera});csm.fade=true;keyLight=csm.lights?.[0]||null;}catch(error){csm=null;console.warn('[PStudio] CSM initialization failed; using single-cascade fallback:',error);}}
    const FX=window.PStudioPostFX;
    if(FX?.EffectComposer&&FX?.RenderPass&&FX?.OutputPass){
      composer=new FX.EffectComposer(renderer);composer.setPixelRatio?.(renderer.getPixelRatio());
      if(FX.TAARenderPass){taaPass=new FX.TAARenderPass(scene,camera);taaPass.accumulate=false;taaPass.sampleLevel=1;taaPass.enabled=true;composer.addPass(taaPass);}
      else composer.addPass(new FX.RenderPass(scene,camera));
      for(const target of [composer.renderTarget1,composer.renderTarget2]){if(target){target.depthBuffer=true;if(T.DepthTexture&&!target.depthTexture)target.depthTexture=new T.DepthTexture(Math.max(1,canvas.width),Math.max(1,canvas.height),T.UnsignedIntType);}}
      volumetricFogPass=window.PStudioEnvironmentFX?.createVolumetricFogPass?.(FX,T)||null;if(volumetricFogPass)composer.addPass(volumetricFogPass);
      if(!taaPass&&FX.SMAAPass){smaaPass=new FX.SMAAPass(Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight));composer.addPass(smaaPass);}
      if(FX.GTAOPass){gtaoPass=new FX.GTAOPass(scene,camera,Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight));if(FX.GTAOPass.OUTPUT?.Denoise!==undefined)gtaoPass.output=FX.GTAOPass.OUTPUT.Denoise;gtaoPass.enabled=false;composer.addPass(gtaoPass);ssaoPass=gtaoPass;}
      else if(FX.SSAOPass){ssaoPass=new FX.SSAOPass(scene,camera,Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight));ssaoPass.kernelRadius=8;ssaoPass.minDistance=0.001;ssaoPass.maxDistance=0.12;ssaoPass.enabled=false;composer.addPass(ssaoPass);}
      if(FX.SSRPass){try{ssrPass=new FX.SSRPass({renderer,scene,camera,width:Math.max(1,canvas.clientWidth),height:Math.max(1,canvas.clientHeight),selects:null});ssrPass.enabled=false;ssrPass.thickness=0.018;ssrPass.maxDistance=28;ssrPass.opacity=0.72;ssrPass.blur=true;composer.addPass(ssrPass);}catch(error){ssrPass=null;console.warn('[PStudio] SSR unavailable:',error);}}
      if(FX.UnrealBloomPass){bloomPass=new FX.UnrealBloomPass(new T.Vector2(Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight)),bloomStrength,0.35,0.84);bloomPass.enabled=false;composer.addPass(bloomPass);}
      outputPass=new FX.OutputPass();composer.addPass(outputPass);
    }
    primitiveGroup=new T.Group();modelGroup=new T.Group();gridGroup=new T.Group();selectionGroup=new T.Group();scene.add(primitiveGroup,modelGroup,gridGroup,selectionGroup);
    cameraPan=new T.Vector3();
    hemisphereLight=new T.HemisphereLight(0xeaf2ff,0x394150,0.9);scene.add(hemisphereLight);
    if(!csm){keyLight=new T.DirectionalLight(0xfff3df,2.8);keyLight.position.set(5,9,6);keyLight.castShadow=true;keyLight.shadow.mapSize.set(2048,2048);keyLight.shadow.camera.left=-32;keyLight.shadow.camera.right=32;keyLight.shadow.camera.top=32;keyLight.shadow.camera.bottom=-32;keyLight.shadow.camera.near=0.5;keyLight.shadow.camera.far=100;keyLight.shadow.camera.updateProjectionMatrix();keyLight.shadow.bias=-0.00008;keyLight.shadow.normalBias=0.018;scene.add(keyLight,keyLight.target);}
    occlusionRaycaster=new T.Raycaster();occlusionRaycaster.firstHitOnly=true;applyQualityPreset(qualityPreset);setupControls();return true;
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

  function pollGpuTimerQueries(){
    if(!gpuTimerGl||!gpuTimerExtension)return;
    try{
      const disjoint=!!gpuTimerGl.getParameter(gpuTimerExtension.GPU_DISJOINT_EXT);
      if(disjoint){for(const entry of gpuTimerQueries)gpuTimerGl.deleteQuery(entry.query);gpuTimerQueries.length=0;return;}
      const now=window.performance?.now?.()??Date.now();
      for(let i=gpuTimerQueries.length-1;i>=0;i--){
        const entry=gpuTimerQueries[i],available=gpuTimerGl.getQueryParameter(entry.query,gpuTimerGl.QUERY_RESULT_AVAILABLE);
        if(available){
          const nanoseconds=Number(gpuTimerGl.getQueryParameter(entry.query,gpuTimerGl.QUERY_RESULT));
          if(Number.isFinite(nanoseconds)&&nanoseconds>0){lastGpuRenderDurationMs=nanoseconds/1e6;lastGpuTimerTimestamp=now;}
          gpuTimerGl.deleteQuery(entry.query);gpuTimerQueries.splice(i,1);
        }else if(now-entry.submittedAt>2000){gpuTimerGl.deleteQuery(entry.query);gpuTimerQueries.splice(i,1);}
      }
    }catch(error){
      for(const entry of gpuTimerQueries){try{gpuTimerGl.deleteQuery(entry.query);}catch(_){}}
      gpuTimerQueries.length=0;gpuTimerGl=null;gpuTimerExtension=null;
      console.warn('[PStudio] GPU timer queries disabled; CPU timing fallback will be used.',error);
    }
  }
  function beginGpuTimerQuery(){
    if(!gpuTimerGl||!gpuTimerExtension)return null;
    let query=null;
    try{query=gpuTimerGl.createQuery();if(!query)return null;gpuTimerGl.beginQuery(gpuTimerExtension.TIME_ELAPSED_EXT,query);return query;}
    catch(error){if(query){try{gpuTimerGl.deleteQuery(query);}catch(_){}}gpuTimerGl=null;gpuTimerExtension=null;console.warn('[PStudio] GPU timer query start failed; CPU timing fallback will be used.',error);return null;}
  }
  function endGpuTimerQuery(query){
    if(!query||!gpuTimerGl||!gpuTimerExtension)return;
    try{
      gpuTimerGl.endQuery(gpuTimerExtension.TIME_ELAPSED_EXT);
      gpuTimerQueries.push({query,submittedAt:window.performance?.now?.()??Date.now()});
      while(gpuTimerQueries.length>8){const oldest=gpuTimerQueries.shift();gpuTimerGl.deleteQuery(oldest.query);}
    }catch(error){try{gpuTimerGl.deleteQuery(query);}catch(_){}gpuTimerGl=null;gpuTimerExtension=null;console.warn('[PStudio] GPU timer query end failed; CPU timing fallback will be used.',error);}
  }
  function drawFrame(){
    if(!renderer||!scene||!camera)return;
    renderer.info?.reset?.();pollGpuTimerQueries();
    const started=window.performance?.now?.()??Date.now(),gpuQuery=beginGpuTimerQuery();
    try{
      if(composer&&(bloomEnabled||ssaoEnabled||ssrEnabled||volumetricFogEnabled||!!taaPass?.enabled||!!smaaPass?.enabled)){
        if(bloomPass){bloomPass.enabled=bloomEnabled;bloomPass.strength=bloomStrength;}
        if(ssaoPass)ssaoPass.enabled=ssaoEnabled;
        if(ssrPass)ssrPass.enabled=ssrEnabled;
        if(volumetricFogPass){volumetricFogPass.enabled=volumetricFogEnabled;const u=volumetricFogPass.uniforms;if(u&&camera){u.uInverseProjection.value.copy(camera.projectionMatrixInverse);u.uCameraWorld.value.copy(camera.matrixWorld);u.uTime.value=particleClock;if(scene.fog?.color)u.uFogColor.value.copy(scene.fog.color);}}
        composer.render();
      }else{
        if(ssaoPass)ssaoPass.enabled=false;
        if(ssrPass)ssrPass.enabled=false;
        renderer.render(scene,camera);
      }
    }finally{
      lastRenderDurationMs=Math.max(0,(window.performance?.now?.()??Date.now())-started);
      endGpuTimerQuery(gpuQuery);
      const now=window.performance?.now?.()??Date.now();
      const hasRecentGpuSample=!!gpuTimerGl&&lastGpuRenderDurationMs>0&&now-lastGpuTimerTimestamp<1500;
      adaptiveMetricSource=hasRecentGpuSample?'gpu-timer-query':'cpu-render-submission';
      applyAdaptiveQuality();
    }
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

  function configureWaterMaterial(material,object=null) {
    if(window.PStudioEnvironmentFX?.configureWater)return window.PStudioEnvironmentFX.configureWater(material,object,false);
    const uniforms={uPStudioTime:{value:0},uPStudioWaveAmplitude:{value:0.075}};
    material.onBeforeCompile=shader=>{
      shader.uniforms.uPStudioTime=uniforms.uPStudioTime;
      shader.uniforms.uPStudioWaveAmplitude=uniforms.uPStudioWaveAmplitude;
      shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
uniform float uPStudioTime;
uniform float uPStudioWaveAmplitude;
`);
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
float pstudioWaveA=sin(position.x*0.42+position.z*0.27+uPStudioTime*0.82);
float pstudioWaveB=sin(position.x*0.78-position.z*0.51-uPStudioTime*0.57);
transformed.y+=uPStudioWaveAmplitude*pstudioWaveA+uPStudioWaveAmplitude*0.34*pstudioWaveB;
`);
    };
    material.customProgramCacheKey=()=>'pstudio-water-waves-fallback-v2';
    material.userData.pstudioWaterUniforms=uniforms;waterMaterials.add(material);return material;
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
    if(window.PStudioEngine?.isRunning?.())throw new Error('Stop Play before baking static global illumination.');
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


  function purgeWorldChunkRuntime(chunkId){
    const owners=new Set([...objectChunkAssignments].filter(([,id])=>id===chunkId).map(([owner])=>owner));
    for(const [key,mesh] of [...meshCache])if(owners.has(String(mesh.userData.ownerId))){disposeMesh(mesh);meshCache.delete(key);}
    for(const [key,instance] of [...modelInstances])if(owners.has(String(instance.ownerId)))removeModelInstance(key);
  }
  function beginWorldChunkLoad(chunk){
    if(chunk.loading||chunk.active)return;const token=++chunk.generation;chunk.loading=true;chunk.error=null;
    Promise.all(chunk.assets.map(name=>requestModelAsset(name))).then(async()=>{if(token!==chunk.generation){if(!chunk.active&&!chunk.loading)releaseChunkAssetCache(chunk);return;}if(typeof chunk.onLoad==='function')await chunk.onLoad({id:chunk.id,assets:chunk.assets.slice()});if(token!==chunk.generation){if(!chunk.active&&!chunk.loading)releaseChunkAssetCache(chunk);return;}
      chunk.loading=false;chunk.active=true;chunk.lastLoadedAt=Date.now();try{window.PStudioEvents?.emit('world.chunk.loaded',{id:chunk.id,assetCount:chunk.assets.length});window.PStudioEvents?.emit('world.chunk.resumed',{id:chunk.id});}catch(_){}
    }).catch(error=>{if(token===chunk.generation){chunk.loading=false;chunk.active=false;chunk.error=String(error?.message||error);try{window.PStudioEvents?.emit('world.chunk.loadFailed',{id:chunk.id,error:chunk.error});}catch(_){}}});
  }
  function releaseChunkAssetCache(chunk){
    const protectedAssets=new Set();
    for(const other of worldChunks.values())if(other.id!==chunk.id&&(other.active||other.loading))for(const name of other.assets||[])protectedAssets.add(name);
    for(const name of chunk.assets||[]){
      if(protectedAssets.has(name))continue;
      let removed=false;
      try{removed=window.PStudioResources?.remove?.('model-gpu',name,{reason:'chunk-unloaded'})||false;}catch(_){continue;}
      if(!removed&&!([...modelInstances.values()].some(instance=>instance.name===name))){
        const asset=modelCache.get(name);if(asset){disposeModelAsset(asset);modelCache.delete(name);}
      }
    }
  }
  function endWorldChunkLoad(chunk){
    chunk.generation++;chunk.loading=false;chunk.active=false;try{window.PStudioEvents?.emit('world.chunk.suspended',{id:chunk.id,reason:'distance'});}catch(_){}purgeWorldChunkRuntime(chunk.id);releaseChunkAssetCache(chunk);
    try{const result=chunk.onUnload?.({id:chunk.id,assets:chunk.assets.slice()});if(result?.catch)result.catch(error=>console.warn('[PStudio] Chunk unload callback failed:',error));}catch(error){console.warn('[PStudio] Chunk unload callback failed:',error);}
    window.PStudioResources?.trim?.('gpu');try{window.PStudioEvents?.emit('world.chunk.unloaded',{id:chunk.id});}catch(_){}
  }
  function registerWorldChunk(id,o={}){
    const key=String(id||'').trim();if(!key||key.length>128)throw new TypeError('Invalid world chunk id.');
    const loadDistance=Math.max(1,Number(o.loadDistance)||800),unloadDistance=Math.max(loadDistance,Number(o.unloadDistance)||loadDistance*1.2),coordinate=v=>Number.isFinite(Number(v))?Number(v):0,old=worldChunks.get(key);
    const chunk={id:key,x:coordinate(o.x),y:coordinate(o.y),z:coordinate(o.z),loadDistance,unloadDistance,active:old?.active??(o.active===true),loading:false,generation:old?.generation||0,assets:Array.isArray(o.assets)?[...new Set(o.assets.map(String))]:[],onLoad:typeof o.onLoad==='function'?o.onLoad:old?.onLoad,onUnload:typeof o.onUnload==='function'?o.onUnload:old?.onUnload,error:null,lastLoadedAt:old?.lastLoadedAt||0};
    worldChunks.set(key,chunk);return{id:key,loadDistance,unloadDistance,active:chunk.active,assetCount:chunk.assets.length};
  }
  function assignObjectToChunk(ownerId,chunkId){const id=String(chunkId);if(!worldChunks.has(id))throw new Error('World chunk is not registered: '+id);objectChunkAssignments.set(String(ownerId),id);return true;}
  function unregisterWorldChunk(id){const key=String(id),chunk=worldChunks.get(key);if(!chunk)return false;if(chunk.active||chunk.loading)endWorldChunkLoad(chunk);worldChunks.delete(key);for(const [owner,chunkId] of objectChunkAssignments)if(chunkId===key)objectChunkAssignments.delete(owner);return true;}
  function isOwnerChunkActive(ownerId){const chunk=worldChunks.get(objectChunkAssignments.get(String(ownerId)));return !chunk||chunk.active;}
  function updateWorldChunkStates(){
    if(!camera)return;for(const chunk of worldChunks.values()){const d=camera.position.distanceTo(new window.THREE.Vector3(chunk.x,chunk.y,chunk.z));if((chunk.active||chunk.loading)&&d>chunk.unloadDistance)endWorldChunkLoad(chunk);else if(!chunk.active&&!chunk.loading&&d<chunk.loadDistance)beginWorldChunkLoad(chunk);}
  }
  function setWorldRenderConfig(o={}){if(Number.isFinite(Number(o.maxDrawDistance)))worldRenderConfig.maxDrawDistance=Math.max(50,Math.min(20000,Number(o.maxDrawDistance)));if(Number.isFinite(Number(o.shadowDistance))){worldRenderConfig.shadowDistance=Math.max(64,Math.min(4000,Number(o.shadowDistance)));if(csm){csm.maxFar=worldRenderConfig.shadowDistance;csm.updateFrustums?.();}}if(Array.isArray(o.lodDistances)&&o.lodDistances.length){const a=o.lodDistances.slice(0,8).map(Number);if(a.every(Number.isFinite)&&a.every((v,i)=>v>0&&(i===0||v>a[i-1])))worldRenderConfig.lodDistances=a;}if(Number.isFinite(Number(o.probeBlendCount)))worldRenderConfig.probeBlendCount=Math.max(1,Math.min(8,Math.floor(Number(o.probeBlendCount))));return{...worldRenderConfig,lodDistances:worldRenderConfig.lodDistances.slice()};}
  function updateProbeVolumeBlend(){if(bakedLightProbeVolume&&camera)lastProbeCameraPosition=camera.position.clone();}
  async function bakeLightProbeVolume(o={}){
    if(!ensureRenderer())throw new Error('The 3D renderer is not available.');
    const generator=window.PStudioPostFX?.LightProbeGenerator;
    if(!generator?.fromCubeRenderTarget)throw new Error('LightProbeGenerator is unavailable.');
    const min=o.min||{x:-12,y:0,z:-12},max=o.max||{x:12,y:8,z:12};
    for(const axis of ['x','y','z'])if(!Number.isFinite(Number(min[axis]))||!Number.isFinite(Number(max[axis]))||Number(max[axis])<=Number(min[axis]))throw new RangeError('Probe volume bounds must be finite and max must exceed min on every axis.');
    const dims=['x','y','z'].map(axis=>Math.max(2,Math.min(4,Math.floor(Number(o[axis+'Count'])||2))));
    const positions=[];
    for(let z=0;z<dims[2];z++)for(let y=0;y<dims[1];y++)for(let x=0;x<dims[0];x++)positions.push(new window.THREE.Vector3(
      Number(min.x)+(Number(max.x)-Number(min.x))*x/(dims[0]-1),
      Number(min.y)+(Number(max.y)-Number(min.y))*y/(dims[1]-1),
      Number(min.z)+(Number(max.z)-Number(min.z))*z/(dims[2]-1)
    ));
    if(positions.length>32)throw new RangeError('A probe volume is limited to 32 samples.');
    const T=window.THREE,size=Math.max(32,Math.min(128,Math.floor(Number(o.resolution)||64)));
    const previous=bakedLightProbeVolume,previousSingle=bakedLightProbe,previousBounces=bakedGIBounces;
    const maxBounces=Math.max(0,Math.min(4,Math.floor(Number(o.bounces??2))));
    const bounceStrength=Math.max(0,Math.min(0.8,Number.isFinite(Number(o.bounceStrength))?Number(o.bounceStrength):0.35));
    const intensity=Math.max(0,Math.min(3,Number.isFinite(Number(o.intensity))?Number(o.intensity):1));
    const minBounceEnergy=Math.max(0,Math.min(0.1,Number.isFinite(Number(o.minBounceEnergy))?Number(o.minBounceEnergy):0.0005));
    const allocated=new Set(),oldAuto=renderer.shadowMap.autoUpdate,oldEnvironment=scene.environment,oldBackground=scene.background;
    let directProbes=[],sourceProbes=[],finalProbes=[],completedBounces=0,lastBounceEnergy=0;
    renderer.shadowMap.autoUpdate=true;
    if(previousSingle)scene.remove(previousSingle);
    const capture=async(position,sources,includeDirect,probeIntensity)=>{
      const target=new T.WebGLCubeRenderTarget(size,{format:T.RGBAFormat,type:T.HalfFloatType,generateMipmaps:true,minFilter:T.LinearMipmapLinearFilter});
      let cube=null;
      const temporary=[],hiddenLights=[],environmentBefore=scene.environment,backgroundBefore=scene.background;
      const clearColorBefore=renderer.getClearColor(new T.Color()).clone(),clearAlphaBefore=renderer.getClearAlpha();
      try{
        cube=new T.CubeCamera(0.1,Math.max(50,Number(o.far)||500),target);cube.position.copy(position);
        if(sources.length){
          const nearest=sources.map(item=>({item,d:item.position.distanceToSquared(position)})).sort((x,y)=>x.d-y.d).slice(0,4);
          let sum=0;for(const entry of nearest){entry.weight=1/Math.max(1,entry.d);sum+=entry.weight;}
          for(const entry of nearest){
            const light=entry.item.light;light.intensity=entry.item.baseIntensity*bounceStrength*entry.weight/Math.max(1e-8,sum);
            light.userData.pstudioBounceSource=true;scene.add(light);temporary.push(light);
          }
        }
        if(!includeDirect){
          scene.environment=null;scene.background=new T.Color(0x000000);renderer.setClearColor(0x000000,1);
          scene.traverse(object=>{if(object.isLight&&!object.userData?.pstudioBounceSource){hiddenLights.push([object,object.visible]);object.visible=false;}});
        }
        scene.add(cube);cube.update(renderer,scene);scene.remove(cube);
        const light=generator.fromCubeRenderTarget(renderer,target);light.position.copy(position);
        const item={position:position.clone(),light,baseIntensity:probeIntensity};allocated.add(item);return item;
      }finally{
        if(cube)scene.remove(cube);target.dispose();
        for(const light of temporary){scene.remove(light);delete light.userData.pstudioBounceSource;}
        for(const [light,visible] of hiddenLights)light.visible=visible;
        scene.environment=environmentBefore;scene.background=backgroundBefore;renderer.setClearColor(clearColorBefore,clearAlphaBefore);
      }
    };
    try{
      // Pass 0 captures the scene's direct and environment illumination.
      for(const position of positions){const direct=await capture(position,[],true,1);for(const coefficient of direct.light.sh.coefficients)coefficient.multiplyScalar(intensity);directProbes.push(direct);await new Promise(resolve=>requestAnimationFrame(resolve));}
      finalProbes=directProbes;sourceProbes=directProbes;
      // Subsequent passes disable direct emitters and feed only the previous
      // bounce field back through the scene's materials.
      for(let pass=1;pass<=maxBounces&&bounceStrength>0;pass++){
        const next=[];
        for(const position of positions){next.push(await capture(position,sourceProbes,false,1));await new Promise(resolve=>requestAnimationFrame(resolve));}
        let energy=0;
        for(let i=0;i<next.length;i++){
          const incoming=next[i].light.sh.coefficients,outgoing=finalProbes[i].light.sh.coefficients;
          for(let k=0;k<9;k++){energy+=incoming[k].length();outgoing[k].add(incoming[k]);}
        }
        lastBounceEnergy=energy;completedBounces=pass;
        for(const item of sourceProbes)if(!directProbes.includes(item)){item.light.dispose?.();allocated.delete(item);}
        sourceProbes=next;
        if(energy<=minBounceEnergy)break;
      }
      for(const item of sourceProbes)if(!directProbes.includes(item)){item.light.dispose?.();allocated.delete(item);}
      bakedLightProbe=null;bakedLightProbeVolume=finalProbes;bakedGIBounces=completedBounces;
      for(const mesh of meshCache.values())bindObjectProbeLighting(mesh);
      for(const instance of modelInstances.values())instance.root.traverse(bindObjectProbeLighting);
      updateProbeVolumeBlend();renderer.setRenderTarget(null);drawFrame();
      for(const item of previous||[])item.light.dispose?.();
      if(previousSingle)previousSingle.dispose?.();
      for(const item of [...allocated])if(!finalProbes.includes(item)){item.light.dispose?.();allocated.delete(item);}
      return{baked:true,probes:finalProbes.length,kind:'iterative-multibounce-diffuse-sh-gi',bounces:completedBounces,bounceStrength,resolution:size,lastBounceEnergy:Number(lastBounceEnergy.toFixed(6)),note:'直接光・環境光は初回のみ捕捉し、後続パスでは前段の拡散バウンスだけを材料へ戻します。SHプローブによる近似であり、動的レイトレーシングや完全な物理GIではありません。'};
    }catch(error){
      for(const item of allocated)item.light.dispose?.();
      bakedLightProbeVolume=previous;bakedLightProbe=previousSingle;bakedGIBounces=previousBounces;
      if(previousSingle)scene.add(previousSingle);
      for(const mesh of meshCache.values())bindObjectProbeLighting(mesh);
      for(const instance of modelInstances.values())instance.root.traverse(bindObjectProbeLighting);
      updateProbeVolumeBlend();
      throw error;
    }finally{
      scene.environment=oldEnvironment;scene.background=oldBackground;
      renderer.shadowMap.autoUpdate=oldAuto;renderer.setRenderTarget(null);
    }
  }
  function updateDirectionalShadowAnchor(target){if(!camera)return;if(csm)return;if(!keyLight?.shadow)return;const sh=keyLight.shadow,extent=Math.min(240,worldRenderConfig.shadowDistance),texel=extent*2/Math.max(1,sh.mapSize.x),x=Math.round(target.x/texel)*texel,z=Math.round(target.z/texel)*texel,anchor=new window.THREE.Vector3(x,target.y,z);keyLight.position.set(x+5,target.y+9,z+6);keyLight.target.position.copy(anchor);keyLight.target.updateMatrixWorld();sh.camera.left=-extent;sh.camera.right=extent;sh.camera.top=extent;sh.camera.bottom=-extent;sh.camera.near=.5;sh.camera.far=extent*3;sh.camera.updateProjectionMatrix();sh.needsUpdate=true;}
  function isWithinWorldDrawDistance(object,maxDistance){let radius=Number(object.userData?.pstudioBoundsRadius)||0;if(!radius&&object.geometry){if(!object.geometry.boundingSphere)object.geometry.computeBoundingSphere();radius=object.geometry.boundingSphere?.radius||0;}const scale=object.scale?Math.max(Math.abs(object.scale.x),Math.abs(object.scale.y),Math.abs(object.scale.z)):1;return camera.position.distanceTo(object.position)<=maxDistance+radius*scale;}
  function getOcclusionOwner(hit){return hit?.object?.userData?.instanceOwnerIds?.[hit.instanceId]??hit?.object?.userData?.ownerId??null;}
  function updateOcclusionVisibility(){
    if(!occlusionEnabled||!occlusionRaycaster||!camera)return;
    const now=window.performance?.now?.()??Date.now();
    if(now-lastOcclusionUpdate<180)return;
    lastOcclusionUpdate=now;
    occlusionFrame++;
    const candidates=[];for(const mesh of meshCache.values())if(mesh.parent===primitiveGroup&&isOwnerChunkActive(mesh.userData.ownerId)&&isWithinWorldDrawDistance(mesh,worldRenderConfig.maxDrawDistance))candidates.push({object:mesh,owner:mesh.userData.ownerId});
    for(const batch of instancedBatches.values())for(const source of batch.userData.instanceSources||[])if(isOwnerChunkActive(source.mesh.userData.ownerId))candidates.push({object:source.mesh,owner:source.mesh.userData.ownerId,instancedSource:source});
    for(const instance of modelInstances.values())if(isOwnerChunkActive(instance.ownerId)&&isWithinWorldDrawDistance(instance.root,worldRenderConfig.maxDrawDistance))candidates.push({object:instance.root,owner:instance.ownerId,instance});
    if(!candidates.length){occlusionCursor=0;return;}
    primitiveGroup.updateMatrixWorld(true);modelGroup.updateMatrixWorld(true);
    const limit=Math.min(8,candidates.length);
    for(let n=0;n<limit;n++){
      const c=candidates[occlusionCursor++%candidates.length],object=c.object,center=new window.THREE.Vector3();
      if(String(c.owner)===String(selectedOwnerId)){
        object.userData.pstudioOccluded=false;
        object.visible=true;
        continue;
      }
      if(!c.instancedSource){object.visible=true;if(object.isMesh)scheduleGeometryBVH(object.geometry);else object.traverse?.(child=>{if(child.isMesh)scheduleGeometryBVH(child.geometry);});}else scheduleGeometryBVH(object.geometry);
      let radius=Math.max(0.2,Number(object.userData?.pstudioBoundsRadius)||0.5);
      if(c.instance?.localBoundsCenter){center.copy(c.instance.localBoundsCenter);object.localToWorld(center);}
      else if(c.instancedSource){object.updateMatrixWorld(true);object.geometry?.computeBoundingSphere?.();if(object.geometry?.boundingSphere){center.copy(object.geometry.boundingSphere.center).applyMatrix4(object.matrixWorld);radius=Math.max(radius,object.geometry.boundingSphere.radius*(object.scale.length()/Math.sqrt(3)));}else object.getWorldPosition(center);}
      else if(object.isMesh){object.geometry?.computeBoundingSphere?.();if(object.geometry?.boundingSphere){center.copy(object.geometry.boundingSphere.center).applyMatrix4(object.matrixWorld);radius=Math.max(radius,object.geometry.boundingSphere.radius*(object.scale.length()/Math.sqrt(3)));}else object.getWorldPosition(center);}
      else object.getWorldPosition(center);
      const ray=center.clone().sub(camera.position),distance=ray.length();if(distance<3){object.userData.pstudioOccluded=false;object.visible=true;continue;}
      occlusionRaycaster.set(camera.position,ray.normalize());occlusionRaycaster.near=0.05;occlusionRaycaster.far=Math.max(0.1,distance-radius*0.5);
      const blocker=occlusionRaycaster.intersectObjects([primitiveGroup,modelGroup],true).find(hit=>{
        const owner=getOcclusionOwner(hit);if(owner===null||String(owner)===String(c.owner))return false;
        const mats=Array.isArray(hit.object.material)?hit.object.material:[hit.object.material];
        if(hit.object.userData?.primitiveType==='water'||mats.some(m=>m?.transparent||m?.transmission>0))return false;
        return hit.distance<distance-radius*0.5;
      });
      object.userData.pstudioOccluded=!!blocker;if(!c.instancedSource)object.visible=!blocker;
    }
    if(occlusionCursor>=candidates.length)occlusionCursor=0;
  }
  function updateWorldVisibility(){
    if(!camera)return;updateWorldChunkStates();const max=worldRenderConfig.maxDrawDistance;
    for(const mesh of meshCache.values()){const active=isOwnerChunkActive(mesh.userData.ownerId)&&isWithinWorldDrawDistance(mesh,max);mesh.visible=active&&!mesh.userData.pstudioOccluded;if(active)applyAutoLOD(mesh,camera.position.distanceTo(mesh.position));}
    for(const instance of modelInstances.values()){
      const d=camera.position.distanceTo(instance.root.position),active=isOwnerChunkActive(instance.ownerId)&&isWithinWorldDrawDistance(instance.root,max);
      const isSelected=String(instance.ownerId)===String(selectedOwnerId);
      instance.root.visible=active&&(isSelected||!instance.root.userData.pstudioOccluded);
      if(!active)continue;
      if(instance.lodLevels?.length>1){const idx=worldRenderConfig.lodDistances.findIndex(v=>d<v),selected=instance.lodLevels[Math.min(idx<0?worldRenderConfig.lodDistances.length:idx,instance.lodLevels.length-1)];if(instance.activeLOD!==selected.level){for(const level of instance.lodLevels)for(const entry of level.entries)entry.object.visible=level.level===selected.level&&entry.visible;instance.activeLOD=selected.level;}}
      else for(const object of instance.meshes||[])if(object.userData.pstudioAutoLOD)applyAutoLOD(object,d);
    }
    updateOcclusionVisibility();
    for(const batch of instancedBatches.values()){const sources=batch.userData.instanceSources||[],dummy=new window.THREE.Object3D(),owners=[],keys=[];let count=0;for(const source of sources){if(!isWithinWorldDrawDistance(source.mesh,max)||!isOwnerChunkActive(source.mesh.userData.ownerId)||source.mesh.userData.pstudioOccluded)continue;dummy.position.copy(source.mesh.position);dummy.quaternion.copy(source.mesh.quaternion);dummy.scale.copy(source.mesh.scale);dummy.updateMatrix();batch.setMatrixAt(count,dummy.matrix);owners[count]=source.mesh.userData.ownerId;keys[count]=source.sourceKey;count++;}batch.count=count;batch.userData.instanceOwnerIds=owners;batch.userData.instanceSourceKeys=keys;batch.instanceMatrix.needsUpdate=true;batch.visible=count>0;if(count)batch.computeBoundingSphere();}
    updateProbeVolumeBlend();updateDirectionalShadowAnchor(new window.THREE.Vector3(cameraTarget[0],cameraTarget[1],cameraTarget[2]));
  }

  function frameCameraToModel(instance){
    if(!instance?.root||!camera||!window.THREE)return false;
    const T=window.THREE;
    instance.root.updateMatrixWorld(true);
    const bounds=new T.Box3().setFromObject(instance.root);
    if(bounds.isEmpty())return false;
    const sphere=bounds.getBoundingSphere(new T.Sphere());
    const radius=Number.isFinite(sphere.radius)?Math.max(0.25,sphere.radius):0.25;
    const oldTarget=new T.Vector3(cameraTarget[0],cameraTarget[1],cameraTarget[2]);
    const direction=new T.Vector3(cameraBase[0],cameraBase[1],cameraBase[2]).sub(oldTarget);
    if(direction.lengthSq()<1e-8)direction.set(6,5,8);
    direction.normalize();
    const verticalFov=(camera.fov||55)*Math.PI/180;
    const horizontalFov=2*Math.atan(Math.tan(verticalFov/2)*Math.max(0.1,camera.aspect||1));
    const limitingFov=Math.max(0.12,Math.min(verticalFov,horizontalFov));
    const distance=Math.max(0.75,(radius/Math.sin(limitingFov/2))*1.16);
    const center=sphere.center;
    cameraTarget=[center.x,center.y,center.z];
    cameraBase=[center.x+direction.x*distance,center.y+direction.y*distance,center.z+direction.z*distance];
    cameraFocusOwnerId=String(instance.ownerId);
    cameraPan?.set(0,0,0);
    zoom=1;
    cameraSmoothing=0;
    smoothedTarget=null;
    smoothedPosition=null;
    return true;
  }

  function frameObject(ownerId){
    const id=String(ownerId);
    const instance=[...modelInstances.values()].find(item=>String(item.ownerId)===id);
    if(!instance){
      pendingCameraFrames.add(id);
      return {pending:true,framed:false};
    }
    const framed=frameCameraToModel(instance);
    if(framed)updateCamera(1/60,activeCameraOwnerId);
    return {pending:false,framed};
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
    // A single center ray is substantially cheaper than five recursive scene raycasts
    // on every touch-move, while still preventing the camera from crossing solid geometry.
    primitiveGroup.updateMatrixWorld(true);
    modelGroup.updateMatrixWorld(true);
    cameraCollisionRaycaster.set(target,direction);
    cameraCollisionRaycaster.near=0.04;
    cameraCollisionRaycaster.far=distance;
    const hits=cameraCollisionRaycaster.intersectObjects([primitiveGroup,modelGroup],true);
    const hit=hits.find(item=>{
      const ownerId=item.object?.userData?.ownerId;
      const isCameraFocus=ownerId!==undefined&&ownerId!==null&&cameraFocusOwnerId!==null&&String(ownerId)===String(cameraFocusOwnerId);
      return !isCameraFocus&&(ownerId===undefined||ownerId===null||ownerId!==excludedOwnerId);
    });
    const safeDistance=hit?Math.max(CAMERA_MIN_DISTANCE,hit.distance-CAMERA_CLEARANCE):distance;
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
    if (cameraUpdateRaf) { window.cancelAnimationFrame(cameraUpdateRaf); cameraUpdateRaf = 0; }
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
    camera.position.copy(collisionSafePosition);camera.lookAt(smoothedTarget);if(csm){csm.maxFar=worldRenderConfig.shadowDistance;csm.update();}
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
    applyPendingLightmaps();
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
    for(const instance of modelInstances.values())for(const mesh of instance.meshes||[])if(mesh.userData.ownerId===selectedOwnerId)meshes.push(mesh);
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
    if(mesh.userData?.pstudioAutoLODGenerating||mesh.userData?.pstudioAutoLOD?.length>1)return null;
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
        batch.userData.modelRoot=items[0].mesh.userData.modelRoot||items[0].mesh.parent;
        batch.userData.instanceOwnerIds=new Array(items.length).fill(batch.userData.ownerId);
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
    mesh.userData?.pstudioLightmapTexture?.dispose?.();
    const currentGeometry=mesh.geometry,lightmapped=!!mesh.userData?.pstudioLightmapGeometry;
    if(currentGeometry?.userData){currentGeometry.userData.pstudioBVHDisposed=true;currentGeometry.userData.pstudioBVHToken=(currentGeometry.userData.pstudioBVHToken||0)+1;}
    currentGeometry?.disposeBoundsTree?.();
    if(lightmapped)currentGeometry?.dispose?.();
    if(mesh.userData?.pstudioLightmapOriginalGeometryOwned){
      const original=mesh.userData.pstudioLightmapOriginalGeometry;
      if(original?.userData){original.userData.pstudioBVHDisposed=true;original.userData.pstudioBVHToken=(original.userData.pstudioBVHToken||0)+1;}
      original?.disposeBoundsTree?.();original?.dispose?.();
    }
    if (mesh.parent) mesh.parent.remove(mesh);
    if(mesh.userData?.pstudioLightmapOriginalMaterial){const originals=Array.isArray(mesh.userData.pstudioLightmapOriginalMaterial)?mesh.userData.pstudioLightmapOriginalMaterial:[mesh.userData.pstudioLightmapOriginalMaterial];for(const material of originals)material?.dispose?.();}
    if (mesh.material) { waterMaterials.delete(mesh.material); for(const material of (Array.isArray(mesh.material)?mesh.material:[mesh.material]))window.PStudioEnvironmentFX?.releaseMaterial?.(material); }
    mesh.userData.pstudioLODToken=(mesh.userData.pstudioLODToken||0)+1;
    const lods=mesh.userData.pstudioAutoLOD||[];
    if(lods.length){for(const level of lods)if(level.owned){level.geometry.userData.pstudioBVHDisposed=true;level.geometry.userData.pstudioBVHToken=(level.geometry.userData.pstudioBVHToken||0)+1;level.geometry.disposeBoundsTree?.();level.geometry.dispose?.();}if(!lightmapped&&!mesh.userData.pstudioLightmapOriginalGeometryOwned){lods[0]?.geometry?.disposeBoundsTree?.();lods[0]?.geometry?.dispose?.();}}
    else if(!lightmapped)currentGeometry?.dispose?.();
    if (mesh.material) mesh.material.dispose();
    mesh.getRenderTarget?.()?.dispose?.();
  }

  function disposeModelAsset(asset) {
    if(!asset?.scene)return;
    const geometries=new Set(),materials=new Set(),textures=new Set();
    asset.scene.traverse(object=>{
      if(!object.isMesh)return;
      if(object.geometry){object.geometry.userData.pstudioBVHDisposed=true;object.geometry.userData.pstudioBVHToken=(object.geometry.userData.pstudioBVHToken||0)+1;object.geometry.disposeBoundsTree?.();geometries.add(object.geometry);}
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


  const pendingLightmaps=new Map();let lightmapDatabasePromise=null;
  function openLightmapDatabase(){
    if(lightmapDatabasePromise)return lightmapDatabasePromise;
    if(!window.indexedDB)return Promise.reject(new Error('IndexedDB is unavailable.'));
    lightmapDatabasePromise=new Promise((resolve,reject)=>{const q=indexedDB.open('PStudioLightmaps',1);q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('lightmaps'))q.result.createObjectStore('lightmaps',{keyPath:'name'});};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error||new Error('Could not open lightmap storage.'));q.onblocked=()=>reject(new Error('Lightmap storage is blocked by another tab.'));});
    return lightmapDatabasePromise;
  }
  function lightmapTargets(){
    const out=[];for(const [key,object] of meshCache)if(object?.isMesh&&object.parent===primitiveGroup&&object.geometry)out.push({id:'primitive:'+key,object});
    for(const [key,instance] of modelInstances){const root=instance.root;root.traverse(object=>{if(!object.isMesh||!object.geometry)return;const path=[];let node=object;while(node&&node!==root){const parent=node.parent;if(!parent)break;path.push(parent.children.indexOf(node));node=parent;}if(node===root)out.push({id:'model:'+key+':'+path.reverse().join('.'),object});});}
    return out;
  }
  function lightmapGeometryFingerprint(geometry){
    const position=geometry?.attributes?.position,normal=geometry?.attributes?.normal;if(!position)return '';
    let hash=2166136261;
    const mix=array=>{if(!array)return;for(let i=0;i<array.length;i++){const value=Math.round(Number(array[i])*10000)|0;hash=Math.imul(hash^value,16777619);}};
    mix(position.array);mix(normal?.array);mix(geometry.index?.array);
    return position.count+':'+(geometry.index?.count||0)+':'+(hash>>>0).toString(16);
  }
  function lightmapMatrixMatches(object,stored){
    if(!Array.isArray(stored)||stored.length!==16)return true;
    if(object.updateWorldMatrix)object.updateWorldMatrix(true,false);else object.updateMatrixWorld(true);const current=object.matrixWorld.elements;
    for(let i=0;i<16;i++)if(Math.abs(current[i]-Number(stored[i]))>1e-4)return false;
    return true;
  }
  function cloneLightmapMaterial(object,texture){
    const original=object.userData.pstudioLightmapOriginalMaterial||object.material,current=object.material;
    const clone=m=>{const c=m.clone();c.lightMap=texture;c.lightMapIntensity=1;c.needsUpdate=true;return c;};
    const next=Array.isArray(original)?original.map(clone):clone(original);
    if(!object.userData.pstudioLightmapOriginalMaterial)object.userData.pstudioLightmapOriginalMaterial=original;
    object.material=next;
    const currentMaterials=Array.isArray(current)?current:[current],originalMaterials=Array.isArray(original)?original:[original];
    for(let i=0;i<currentMaterials.length;i++)if(currentMaterials[i]&&currentMaterials[i]!==originalMaterials[i])currentMaterials[i].dispose?.();
  }
  function installLightmap(object,record){
    const sourceGeometry=object.userData.pstudioLightmapOriginalGeometry||object.userData.pstudioAutoLOD?.[0]?.geometry||object.geometry;
    if(!sourceGeometry?.attributes?.position||!record.uv2||!record.pixels||!Number.isInteger(record.width)||!Number.isInteger(record.height)||record.width<1||record.height<1||record.width>2048||record.height>2048||record.pixels.length!==record.width*record.height*4||(record.fingerprint&&lightmapGeometryFingerprint(sourceGeometry)!==record.fingerprint)||!lightmapMatrixMatches(object,record.matrixWorld))return false;
    const working=sourceGeometry.index?sourceGeometry.toNonIndexed():sourceGeometry.clone(),position=working.attributes.position;
    if(!position||position.count!==record.vertexCount||record.uv2.length!==position.count*2){working.dispose();return false;}
    working.setAttribute('uv2',new window.THREE.BufferAttribute(new Float32Array(record.uv2),2));
    const half=record.pixelType==='half',texture=new window.THREE.DataTexture(half?new Uint16Array(record.pixels):new Float32Array(record.pixels),record.width,record.height,window.THREE.RGBAFormat,half?window.THREE.HalfFloatType:window.THREE.FloatType);
    texture.name='PStudioLightmap:'+record.id;texture.magFilter=window.THREE.NearestFilter;texture.minFilter=window.THREE.NearestFilter;texture.generateMipmaps=false;texture.flipY=false;texture.needsUpdate=true;
    try{cloneLightmapMaterial(object,texture);}catch(error){texture.dispose();working.dispose();throw error;}
    const oldGeometry=object.geometry,oldTexture=object.userData.pstudioLightmapTexture;
    if(!object.userData.pstudioLightmapOriginalGeometry){object.userData.pstudioLightmapOriginalGeometry=sourceGeometry;object.userData.pstudioLightmapOriginalGeometryOwned=String(record.id).startsWith('primitive:');}
    if(object.userData.pstudioAutoLOD?.length){
      object.userData.pstudioLODToken=(object.userData.pstudioLODToken||0)+1;
      for(const level of object.userData.pstudioAutoLOD)if(level.owned){level.geometry.userData.pstudioBVHDisposed=true;level.geometry.userData.pstudioBVHToken=(level.geometry.userData.pstudioBVHToken||0)+1;level.geometry.disposeBoundsTree?.();level.geometry.dispose?.();}
      object.userData.pstudioAutoLOD=null;object.userData.pstudioAutoLODGenerating=false;
    }
    object.geometry=working;object.userData.pstudioLightmapGeometry=true;
    if(oldGeometry!==sourceGeometry&&oldGeometry!==working){oldGeometry.userData.pstudioBVHDisposed=true;oldGeometry.userData.pstudioBVHToken=(oldGeometry.userData.pstudioBVHToken||0)+1;oldGeometry.disposeBoundsTree?.();oldGeometry.dispose?.();}
    oldTexture?.dispose?.();object.userData.pstudioLightmapTexture=texture;object.userData.pstudioLightmapId=record.id;object.userData.pstudioLightmapBakedMatrix=record.matrixWorld?Array.from(record.matrixWorld):null;return true;
  }
  function applyPendingLightmaps(){
    if(!pendingLightmaps.size)return{applied:0,skipped:0,pending:0};
    const byId=new Map(lightmapTargets().map(t=>[t.id,t.object]));let applied=0,skipped=0;
    for(const [id,record] of [...pendingLightmaps]){const object=byId.get(id);if(!object)continue;try{if(installLightmap(object,record)){pendingLightmaps.delete(id);applied++;}else{pendingLightmaps.delete(id);skipped++;console.warn('[PStudio] Skipped incompatible lightmap:',id);}}catch(error){pendingLightmaps.delete(id);skipped++;console.warn('[PStudio] Could not apply lightmap:',id,error);}}
    return{applied,skipped,pending:pendingLightmaps.size};
  }
  function clearObjectLightmap(object){
    if(!object?.userData)return false;let changed=false;
    if(object.userData.pstudioLightmapTexture){object.userData.pstudioLightmapTexture.dispose();object.userData.pstudioLightmapTexture=null;changed=true;}
    if(object.userData.pstudioLightmapGeometry&&object.userData.pstudioLightmapOriginalGeometry){object.geometry.userData.pstudioBVHDisposed=true;object.geometry.userData.pstudioBVHToken=(object.geometry.userData.pstudioBVHToken||0)+1;object.geometry.disposeBoundsTree?.();object.geometry.dispose?.();object.geometry=object.userData.pstudioLightmapOriginalGeometry;object.userData.pstudioLightmapOriginalGeometry=null;object.userData.pstudioLightmapGeometry=false;object.userData.pstudioLightmapOriginalGeometryOwned=false;changed=true;}
    if(object.userData.pstudioLightmapOriginalMaterial){const current=Array.isArray(object.material)?object.material:[object.material];for(const m of current)m?.dispose?.();object.material=object.userData.pstudioLightmapOriginalMaterial;object.userData.pstudioLightmapOriginalMaterial=null;changed=true;}
    delete object.userData.pstudioLightmapId;delete object.userData.pstudioLightmapBakedMatrix;return changed;
  }
  function clearLightmaps(){let count=0;for(const {object} of lightmapTargets())if(clearObjectLightmap(object))count++;pendingLightmaps.clear();if(renderer&&scene)drawFrame();return{cleared:count};}
  async function saveLightmaps(name='default'){
    const key=String(name||'default').trim();if(!key||key.length>128)throw new TypeError('Invalid lightmap name.');
    const records=[];for(const {id,object} of lightmapTargets()){
      const t=object.userData.pstudioLightmapTexture,g=object.geometry;
      if(t?.image?.data&&g?.attributes?.uv2){
        if(object.updateWorldMatrix)object.updateWorldMatrix(true,false);else object.updateMatrixWorld(true);
        const sourceGeometry=object.userData.pstudioLightmapOriginalGeometry||g;
        records.push({id,width:t.image.width,height:t.image.height,vertexCount:g.attributes.position.count,fingerprint:lightmapGeometryFingerprint(sourceGeometry),matrixWorld:Array.from(object.userData.pstudioLightmapBakedMatrix||object.matrixWorld.elements),pixelType:t.type===window.THREE.HalfFloatType?'half':'float',uv2:new Float32Array(g.attributes.uv2.array),pixels:t.type===window.THREE.HalfFloatType?new Uint16Array(t.image.data):new Float32Array(t.image.data)});
      }
    }
    if(!records.length)throw new Error('No baked lightmaps to save.');const db=await openLightmapDatabase();
    await new Promise((resolve,reject)=>{const tx=db.transaction('lightmaps','readwrite');tx.objectStore('lightmaps').put({name:key,schema:1,records,updatedAt:Date.now()});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('Lightmap save failed.'));tx.onabort=()=>reject(tx.error||new Error('Lightmap save aborted.'));});
    return{name:key,meshes:records.length};
  }
  async function loadLightmaps(name='default'){
    const key=String(name||'default').trim(),db=await openLightmapDatabase(),data=await new Promise((resolve,reject)=>{const tx=db.transaction('lightmaps','readonly'),q=tx.objectStore('lightmaps').get(key);q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>reject(q.error||new Error('Lightmap load failed.'));});
    if(!data||data.schema!==1||!Array.isArray(data.records))throw new Error('Lightmap set not found or unsupported.');
    pendingLightmaps.clear();for(const item of data.records)pendingLightmaps.set(item.id,item);const status=applyPendingLightmaps();if(renderer&&scene)drawFrame();
    return{name:key,meshes:data.records.length,...status};
  }
  function addProbeSH(item,weight,normal,target){
    const c=item.light.sh.coefficients,w=weight*item.baseIntensity,x=normal.x,y=normal.y,z=normal.z;
    target.x+=c[0].x*.886227*w+c[1].x*1.023327*y*w+c[2].x*1.023327*z*w+c[3].x*1.023327*x*w+c[4].x*.858086*x*y*w+c[5].x*.858086*y*z*w+c[6].x*.247708*(3*z*z-1)*w+c[7].x*.858086*x*z*w+c[8].x*.429043*(x*x-y*y)*w;
    target.y+=c[0].y*.886227*w+c[1].y*1.023327*y*w+c[2].y*1.023327*z*w+c[3].y*1.023327*x*w+c[4].y*.858086*x*y*w+c[5].y*.858086*y*z*w+c[6].y*.247708*(3*z*z-1)*w+c[7].y*.858086*x*z*w+c[8].y*.429043*(x*x-y*y)*w;
    target.z+=c[0].z*.886227*w+c[1].z*1.023327*y*w+c[2].z*1.023327*z*w+c[3].z*1.023327*x*w+c[4].z*.858086*x*y*w+c[5].z*.858086*y*z*w+c[6].z*.247708*(3*z*z-1)*w+c[7].z*.858086*x*z*w+c[8].z*.429043*(x*x-y*y)*w;
  }
  function evaluateProbeSH(position,normal,target=new window.THREE.Vector3()){
    const volume=bakedLightProbeVolume;target.set(0,0,0);if(!volume?.length)return target;
    let p0=null,p1=null,p2=null,p3=null,d0=Infinity,d1=Infinity,d2=Infinity,d3=Infinity;
    for(const item of volume){const d=item.position.distanceToSquared(position);
      if(d<d0){p3=p2;d3=d2;p2=p1;d2=d1;p1=p0;d1=d0;p0=item;d0=d;}
      else if(d<d1){p3=p2;d3=d2;p2=p1;d2=d1;p1=item;d1=d;}
      else if(d<d2){p3=p2;d3=d2;p2=item;d2=d;}
      else if(d<d3){p3=item;d3=d;}
    }
    const w0=p0?1/Math.max(.25,d0):0,w1=p1?1/Math.max(.25,d1):0,w2=p2?1/Math.max(.25,d2):0,w3=p3?1/Math.max(.25,d3):0,sum=w0+w1+w2+w3;
    if(sum<=0)return target;
    if(p0)addProbeSH(p0,w0/sum,normal,target);if(p1)addProbeSH(p1,w1/sum,normal,target);if(p2)addProbeSH(p2,w2/sum,normal,target);if(p3)addProbeSH(p3,w3/sum,normal,target);
    return target.set(Math.max(0,target.x),Math.max(0,target.y),Math.max(0,target.z));
  }
  const halfFloatScratch=new Float32Array(1),halfUintScratch=new Uint32Array(halfFloatScratch.buffer);
  function floatToHalf(value){
    halfFloatScratch[0]=value;const bits=halfUintScratch[0],sign=(bits>>>16)&0x8000,exp=(bits>>>23)&0xff,mantissa=bits&0x7fffff;
    if(exp===255)return sign|(mantissa?0x7e00:0x7c00);
    let halfExp=exp-127+15;
    if(halfExp>=31)return sign|0x7bff;
    if(halfExp<=0){if(halfExp<-10)return sign;const m=(mantissa|0x800000)>>(1-halfExp);return sign|((m+0x1000)>>13);}
    return sign|(halfExp<<10)|((mantissa+0x1000)>>13);
  }
  function packHalfFloat(values){const packed=new Uint16Array(values.length);for(let i=0;i<values.length;i++)packed[i]=floatToHalf(values[i]);return packed;}
  function createLightmapUVGeometry(source,resolution){
    const T=window.THREE,g=source.index?source.toNonIndexed():source.clone(),p=g.attributes.position;
    if(!p||p.count<3||p.count%3!==0){g.dispose();throw new Error('Invalid triangle mesh topology.');}if(!g.attributes.normal)g.computeVertexNormals();
    const triangles=p.count/3,grid=Math.ceil(Math.sqrt(triangles)),cell=1/grid,pad=Math.max(2,Math.ceil(resolution*cell*.025));
    if(resolution/grid<6){g.dispose();throw new Error('Lightmap resolution is too low for this mesh.');}
    const uv=new Float32Array(p.count*2);for(let i=0;i<triangles;i++){const col=i%grid,row=Math.floor(i/grid),x0=col*cell+pad/resolution,y0=row*cell+pad/resolution,x1=(col+1)*cell-pad/resolution,y1=(row+1)*cell-pad/resolution,k=i*6;uv[k]=x0;uv[k+1]=y0;uv[k+2]=x1;uv[k+3]=y0;uv[k+4]=x0;uv[k+5]=y1;}
    g.setAttribute('uv2',new T.BufferAttribute(uv,2));return{geometry:g,uv2:uv,triangles,grid};
  }
  async function bakeLightmapPixels(object,g,info,resolution,bakedMatrix){
    const T=window.THREE,p=g.attributes.position,n=g.attributes.normal,matrix=new T.Matrix4().fromArray(bakedMatrix),nm=new T.Matrix3().getNormalMatrix(matrix),wp=[],wn=[];
    for(let i=0;i<p.count;i++){wp.push(new T.Vector3().fromBufferAttribute(p,i).applyMatrix4(matrix));wn.push(new T.Vector3().fromBufferAttribute(n,i).applyMatrix3(nm).normalize());}
    const data=new Float32Array(resolution*resolution*4),cell=resolution/info.grid,pad=Math.max(2,Math.ceil(resolution*.025/info.grid)),usable=Math.max(1,cell-2*pad);
    const point=new T.Vector3(),normal=new T.Vector3(),light=new T.Vector3();
    for(let tri=0;tri<info.triangles;tri++){const col=tri%info.grid,row=Math.floor(tri/info.grid),x0=Math.ceil(col*cell+pad),y0=Math.ceil(row*cell+pad),x1=Math.floor((col+1)*cell-pad),y1=Math.floor((row+1)*cell-pad),a=wp[tri*3],b=wp[tri*3+1],c=wp[tri*3+2],na=wn[tri*3],nb=wn[tri*3+1],nc=wn[tri*3+2];
      for(let y=y0;y<y1;y++){
        for(let x=x0;x<x1;x++){const wb=(x+.5-(col*cell+pad))/usable,wc=(y+.5-(row*cell+pad))/usable,wa=1-wb-wc;if(wa<0||wb<0||wc<0)continue;
          point.set(a.x*wa+b.x*wb+c.x*wc,a.y*wa+b.y*wb+c.y*wc,a.z*wa+b.z*wb+c.z*wc);
          normal.set(na.x*wa+nb.x*wb+nc.x*wc,na.y*wa+nb.y*wb+nc.y*wc,na.z*wa+nb.z*wb+nc.z*wc).normalize();
          evaluateProbeSH(point,normal,light);const k=(y*resolution+x)*4;data[k]=light.x;data[k+1]=light.y;data[k+2]=light.z;data[k+3]=1;}
        if((y-y0+1)%24===0)await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      if((tri+1)%16===0)await new Promise(resolve=>requestAnimationFrame(resolve));
    }return data;
  }
  async function bakeUVLightmaps(options={}){
    if(!ensureRenderer())throw new Error('3D renderer unavailable.');if(window.PStudioEngine?.isRunning?.())throw new Error('Stop Play before baking static UV lightmaps.');if(!bakedLightProbeVolume?.length)throw new Error('Run bakeLightProbeVolume() before baking UV lightmaps.');
    const T=window.THREE,resolution=Math.max(128,Math.min(2048,Math.floor(Number(options.resolution)||512))),ownerFilter=Array.isArray(options.ownerIds)?new Set(options.ownerIds.map(String)):null,targets=lightmapTargets().filter(({object})=>{const materials=Array.isArray(object.material)?object.material:[object.material];return !object.isSkinnedMesh&&!object.isInstancedMesh&&!object.morphTargetInfluences?.length&&!Object.keys(object.geometry?.morphAttributes||{}).length&&object.geometry?.attributes?.position&&materials.length>0&&materials.every(material=>material&&'lightMap' in material)&&(!ownerFilter||ownerFilter.has(String(object.userData.ownerId)));});
    if(!targets.length)throw new Error('No eligible static meshes.');
    const deviceMemory=Math.max(1,Number(window.navigator?.deviceMemory)||4);
    const budget=Math.max(8*1024*1024,Math.min(256*1024*1024,Number(options.maxBytes)||deviceMemory*16*1024*1024));
    const perTextureBytes=resolution*resolution*8;
    const baked=[],failed=[];let allocatedBytes=0;
    for(const {id,object} of targets){if(allocatedBytes+perTextureBytes>budget){failed.push({id,error:'Lightmap memory budget exceeded; reduce resolution or increase maxBytes.'});continue;}let working=null,texture=null;try{
      const source=object.userData.pstudioLightmapOriginalGeometry||object.userData.pstudioAutoLOD?.[0]?.geometry||object.geometry,info=createLightmapUVGeometry(source,resolution);working=info.geometry;
      if(object.updateWorldMatrix)object.updateWorldMatrix(true,false);else object.updateMatrixWorld(true);const bakedMatrix=Array.from(object.matrixWorld.elements);
      const pixels=await bakeLightmapPixels(object,working,info,resolution,bakedMatrix),oldGeometry=object.geometry,oldTexture=object.userData.pstudioLightmapTexture;
      const packedPixels=packHalfFloat(pixels);texture=new T.DataTexture(packedPixels,resolution,resolution,T.RGBAFormat,T.HalfFloatType);
      texture.name='PStudioLightmap:'+id;texture.magFilter=T.NearestFilter;texture.minFilter=T.NearestFilter;texture.generateMipmaps=false;texture.flipY=false;texture.needsUpdate=true;
      cloneLightmapMaterial(object,texture);
      if(!object.userData.pstudioLightmapOriginalGeometry){object.userData.pstudioLightmapOriginalGeometry=source;object.userData.pstudioLightmapOriginalGeometryOwned=id.startsWith('primitive:');}
      if(object.userData.pstudioAutoLOD?.length){object.userData.pstudioLODToken=(object.userData.pstudioLODToken||0)+1;for(const level of object.userData.pstudioAutoLOD)if(level.owned){level.geometry.userData.pstudioBVHDisposed=true;level.geometry.userData.pstudioBVHToken=(level.geometry.userData.pstudioBVHToken||0)+1;level.geometry.disposeBoundsTree?.();level.geometry.dispose?.();}object.userData.pstudioAutoLOD=null;object.userData.pstudioAutoLODGenerating=false;}
      object.geometry=working;working=null;object.userData.pstudioLightmapGeometry=true;
      if(oldGeometry!==source&&oldGeometry!==object.geometry){oldGeometry.userData.pstudioBVHDisposed=true;oldGeometry.userData.pstudioBVHToken=(oldGeometry.userData.pstudioBVHToken||0)+1;oldGeometry.disposeBoundsTree?.();oldGeometry.dispose?.();}
      oldTexture?.dispose?.();object.userData.pstudioLightmapTexture=texture;object.userData.pstudioLightmapId=id;object.userData.pstudioLightmapBakedMatrix=bakedMatrix;baked.push(id);allocatedBytes+=perTextureBytes;
    }catch(error){working?.dispose?.();texture?.dispose?.();failed.push({id,error:String(error?.message||error)});}
    if((baked.length+failed.length)%4===0)await new Promise(resolve=>requestAnimationFrame(resolve));}
    if(renderer&&scene)drawFrame();return{baked:baked.length,failed,meshes:baked,resolution,allocatedBytes,budgetBytes:budget,format:'linear-half-float-rgba',uvLayout:'non-overlapping-per-triangle-atlas',lighting:'spatial-sh-probe-irradiance'};
  }
  function scheduleGeometryBVH(geometry){
    if(!geometry?.computeBoundsTree||geometry.boundsTree||geometry.userData?.pstudioBVHScheduled||geometry.userData?.pstudioBVHDisposed)return false;
    geometry.userData=geometry.userData||{};geometry.userData.pstudioBVHScheduled=true;geometry.userData.pstudioBVHDisposed=false;const token=(geometry.userData.pstudioBVHToken||0)+1;geometry.userData.pstudioBVHToken=token;
    const build=()=>{if(geometry.userData.pstudioBVHToken!==token||geometry.userData.pstudioBVHDisposed){geometry.userData.pstudioBVHScheduled=false;return;}if(!geometry.boundsTree)try{geometry.computeBoundsTree({maxLeafTris:12});}catch(error){console.warn('[PStudio] BVH build skipped:',error);}geometry.userData.pstudioBVHScheduled=false;};
    if(window.requestIdleCallback)window.requestIdleCallback(build,{timeout:1500});else window.setTimeout(build,0);return true;
  }

  function setupLightingMaterial(material){
    if(!material||(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial))return material;
    if(csm&&!material.userData.pstudioCSMSetup){try{csm.setupMaterial(material);material.userData.pstudioCSMSetup=true;}catch(error){console.warn('[PStudio] CSM material setup failed:',error);}}
    // Keep native GLTF material shaders untouched until an SH probe volume is baked.
    if(!bakedLightProbeVolume?.length)return material;
    if(material.userData.pstudioProbeShaderSetup)return material;
    const oldCompile=material.onBeforeCompile,oldKey=material.customProgramCacheKey?.bind(material),probeUniforms=Array.from({length:9},()=>new window.THREE.Vector3());
    material.onBeforeCompile=function(shader,rendererRef){if(typeof oldCompile==='function')oldCompile.call(this,shader,rendererRef);shader.uniforms.uPStudioSH={value:probeUniforms};
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
uniform vec3 uPStudioSH[9];
vec3 pstudioEvaluateSH(vec3 n){float x=n.x,y=n.y,z=n.z;vec3 value=uPStudioSH[0]*0.886227+uPStudioSH[1]*(1.023327*y)+uPStudioSH[2]*(1.023327*z)+uPStudioSH[3]*(1.023327*x)+uPStudioSH[4]*(0.858086*x*y)+uPStudioSH[5]*(0.858086*y*z)+uPStudioSH[6]*(0.247708*(3.0*z*z-1.0))+uPStudioSH[7]*(0.858086*x*z)+uPStudioSH[8]*(0.429043*(x*x-y*y));return max(value,vec3(0.0));}`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',`#include <lights_fragment_begin>
reflectedLight.indirectDiffuse += pstudioEvaluateSH(normalize(transpose(mat3(viewMatrix))*geometry.normal))*BRDF_Lambert(diffuseColor.rgb);`);
      material.userData.pstudioProbeUniforms=probeUniforms;};
    material.customProgramCacheKey=function(){return(oldKey?oldKey():'')+'|pstudio-object-sh-v1';};material.userData.pstudioProbeShaderSetup=true;return material;
  }
  function updateObjectProbeUniforms(object,material){
    const uniforms=material?.userData?.pstudioProbeUniforms,volume=bakedLightProbeVolume;if(!uniforms||!volume?.length)return;const center=new window.THREE.Vector3();object.getWorldPosition(center);
    const near=volume.map(item=>({item,d:item.position.distanceToSquared(center)})).sort((a,b)=>a.d-b.d).slice(0,Math.min(4,volume.length));let sum=0;for(const e of near){e.w=1/Math.max(0.25,e.d);sum+=e.w;}
    for(let i=0;i<9;i++){const out=uniforms[i];out.set(0,0,0);for(const e of near){const coeff=e.item.light.sh.coefficients[i];if(coeff)out.addScaledVector(coeff,e.w/Math.max(1e-8,sum)*e.item.baseIntensity);}}
  }
  function bindObjectProbeLighting(object){if(!object?.isMesh)return;const mats=Array.isArray(object.material)?object.material:[object.material];for(const m of mats)setupLightingMaterial(m);object.onBeforeRender=(r,s,c,g,m)=>updateObjectProbeUniforms(object,m);}
  function hasNamedLODParent(object){
    let node=object;while(node){if(/(?:^|[ _-])LOD[0-9]+(?:$|[ _-])/i.test(String(node.name||'')))return true;node=node.parent;}return false;
  }
  const autoLODQueue=[];
  let autoLODPumpScheduled=false;
  function scheduleAutoLODPump(){
    if(autoLODPumpScheduled||!autoLODQueue.length)return;
    autoLODPumpScheduled=true;
    const pump=deadline=>{
      autoLODPumpScheduled=false;
      const job=autoLODQueue[0];
      if(!job)return;
      const {object,geometry,token,count,levels,specs,modifier}=job;
      if(object.userData.pstudioLODToken!==token||object.geometry!==geometry){
        if(object.userData.pstudioLODToken===token)object.userData.pstudioAutoLODGenerating=false;
        autoLODQueue.shift();scheduleAutoLODPump();return;
      }
      if(deadline&&typeof deadline.timeRemaining==='function'&&deadline.timeRemaining()<8){
        scheduleAutoLODPump();return;
      }
      const spec=specs[job.nextSpec++];
      if(spec){
        try{
          const lod=modifier.modify(geometry,Math.max(1,Math.floor(count*(1-spec.keep))));
          if(!lod?.attributes?.position||lod.attributes.position.count>=count*0.94)lod?.dispose?.();
          else{lod.computeBoundingSphere?.();lod.computeVertexNormals?.();levels.push({geometry:lod,distance:spec.distance,owned:true});}
        }catch(error){console.warn('[PStudio] Automatic LOD generation skipped:',error);job.nextSpec=specs.length;}
      }
      if(job.nextSpec<specs.length){scheduleAutoLODPump();return;}
      if(object.userData.pstudioLODToken===token&&object.geometry===geometry){
        object.userData.pstudioAutoLOD=levels.length>1?levels:null;
        object.userData.pstudioAutoLODGenerating=false;
        try{window.PStudioEvents?.emit('render.lod.generated',{trianglesBefore:geometry.index?.count/3||count/3,levels:levels.length});}catch(_){}
      }else for(const level of levels)if(level.owned)level.geometry.dispose?.();
      autoLODQueue.shift();scheduleAutoLODPump();
    };
    if(typeof window.requestIdleCallback==='function')window.requestIdleCallback(pump);
    else window.setTimeout(()=>pump(null),250);
  }
  function scheduleAutoLOD(object,geometry){
    const Modifier=window.PStudioSimplifyModifier,pos=geometry?.attributes?.position,count=pos?.count||0;
    if(!Modifier||!geometry||count<240||count>16000||hasNamedLODParent(object)||object.isSkinnedMesh)return false;
    const token=(object.userData.pstudioLODToken||0)+1;object.userData.pstudioLODToken=token;
    object.userData.pstudioAutoLOD=[{geometry,distance:0,owned:false}];object.userData.pstudioAutoLODGenerating=true;
    autoLODQueue.push({object,geometry,token,count,levels:[{geometry,distance:0,owned:false}],specs:[{keep:0.58,distance:worldRenderConfig.lodDistances[0]||25},{keep:0.3,distance:worldRenderConfig.lodDistances[1]||70}],nextSpec:0,modifier:new Modifier()});
    scheduleAutoLODPump();
    return true;
  }
  function applyAutoLOD(object,distance){
    const levels=object?.userData?.pstudioAutoLOD;if(!levels?.length)return;
    let selected=0;for(let i=1;i<levels.length;i++)if(distance>=levels[i].distance)selected=i;
    if(object.userData.pstudioActiveAutoLOD===selected)return;
    object.geometry=levels[selected].geometry;object.userData.pstudioActiveAutoLOD=selected;
  }
  function buildFoliageInstanceBatches(root){
    const T=window.THREE,groups=new Map(),batches=[];
    root.updateMatrixWorld(true);
    root.traverse(object=>{
      if(!object.isMesh||object.isSkinnedMesh||!/(?:^|[_ -])Wind[_ -]?Tree/i.test(String(object.name||'')))return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      if(materials.length!==1||!object.geometry||!materials[0])return;
      const key=object.geometry.uuid+'|'+materials[0].uuid;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(object);
    });
    const inverseRoot=root.matrixWorld.clone().invert(),matrix=new T.Matrix4();
    for(const sources of groups.values()){
      if(sources.length<4)continue;
      const first=sources[0],batch=new T.InstancedMesh(first.geometry,first.material,sources.length);
      batch.name='PStudio_Foliage_GPU_Instances';batch.castShadow=true;batch.receiveShadow=true;
      batch.frustumCulled=true;batch.userData.ownerId=root.userData.ownerId;
      batch.userData.pstudioFoliageSources=sources;
      root.add(batch);
      for(let i=0;i<sources.length;i++){sources[i].updateWorldMatrix(true,false);matrix.multiplyMatrices(inverseRoot,sources[i].matrixWorld);batch.setMatrixAt(i,matrix);sources[i].visible=false;}
      batch.instanceMatrix.setUsage(T.DynamicDrawUsage);batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();
      batches.push({mesh:batch,sources});
    }
    return batches;
  }
  function updateFoliageInstanceBatches(instance){
    if(!instance?.foliageBatches?.length)return;
    const T=window.THREE,root=instance.root;root.updateMatrixWorld(true);
    const inverseRoot=root.matrixWorld.clone().invert(),matrix=new T.Matrix4();
    for(const entry of instance.foliageBatches){
      const batch=entry.mesh;
      for(let i=0;i<entry.sources.length;i++){const source=entry.sources[i];source.updateWorldMatrix(true,false);matrix.multiplyMatrices(inverseRoot,source.matrixWorld);batch.setMatrixAt(i,matrix);}
      batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();
    }
  }

  function createModelInstance(key, ownerId, name, asset) {
    const T=window.THREE;
    const clone=window.PStudioSkeletonUtils?.clone
      ? window.PStudioSkeletonUtils.clone(asset.scene)
      : asset.scene.clone(true);
    const materialDefaults=new Map(),materialClones=new Map(),meshes=[];
    clone.userData.ownerId=ownerId;
    clone.traverse(object=>{
      object.userData.ownerId=ownerId;
      object.userData.modelRoot=clone;
      if(object.isMesh && object.material){
        meshes.push(object);
        scheduleAutoLOD(object,object.geometry);
        object.castShadow=true;
        object.receiveShadow=true;
        const cloneMaterial=material=>{
          let copy=materialClones.get(material);
          if(copy)return copy;
          copy=material.clone();setupLightingMaterial(copy);
          materialDefaults.set(copy,{
            roughness:Number.isFinite(material.roughness)?material.roughness:0.72,
            metalness:Number.isFinite(material.metalness)?material.metalness:0.04
          });
          materialClones.set(material,copy);
          return copy;
        };
        object.material=Array.isArray(object.material)
          ? object.material.map(cloneMaterial)
          : cloneMaterial(object.material);
        window.PStudioEnvironmentFX?.configureObject?.(object);
        for(const configured of (Array.isArray(object.material)?object.material:[object.material]))if(configured&&!materialDefaults.has(configured))materialDefaults.set(configured,{roughness:Number.isFinite(configured.roughness)?configured.roughness:0.72,metalness:Number.isFinite(configured.metalness)?configured.metalness:0.04});
        bindObjectProbeLighting(object);
      }
    });
    clone.updateMatrixWorld(true);
    const foliageBatches=buildFoliageInstanceBatches(clone);updateFoliageInstanceBatches({root:clone,foliageBatches});
    const modelBounds=new T.Box3().setFromObject(clone),modelSphere=modelBounds.getBoundingSphere(new T.Sphere());
    clone.userData.pstudioBoundsRadius=Number.isFinite(modelSphere.radius)?modelSphere.radius:0;clone.userData.pstudioBoundsCenter=modelSphere.center.clone();
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
    const instance={key,ownerId,name,root:clone,meshes,mixer,animations:asset.animations,materialDefaults,lodLevels,localBoundsCenter:modelSphere.center.clone(),activeLOD:null,activeClip:null,activeLoop:true,speed:1,resourceLease,materialStateSignature:null,foliageBatches};
    modelInstances.set(key,instance);
    modelGroup.add(clone);
    return instance;
  }

  function applyModelMaterial(instance, state) {
    if(!instance?.materialDefaults)return;
    const signature=JSON.stringify(state?{
      roughness:state.roughness??null,
      metalness:state.metalness??null,
      modelOverrides:(state.modelOverrides||[]).map(item=>[item.name,item.roughness??null,item.metalness??null,item.color??null])
    }:null);
    if(instance.materialStateSignature===signature)return;
    instance.materialStateSignature=signature;
    for(const object of instance.meshes||[]){
      if(!object.material)continue;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){const defaults=instance.materialDefaults.get(material);if(!defaults)continue;
        material.roughness=state&&Number.isFinite(state.roughness)?state.roughness:defaults.roughness;material.metalness=state&&Number.isFinite(state.metalness)?state.metalness:defaults.metalness;
        const override=state?.modelOverrides?.find(item=>item.name==='*'||item.name===object.name||item.name===material.name);
        if(override){if(Number.isFinite(override.roughness))material.roughness=Math.max(0,Math.min(1,override.roughness));if(Number.isFinite(override.metalness))material.metalness=Math.max(0,Math.min(1,override.metalness));if(override.color&&material.color)material.color.set(override.color);}
      }
    }
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
      instance.mixer.update(Math.max(0,Math.min(0.1,Number(dt)||0)));updateFoliageInstanceBatches(instance);
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
    const disposedMaterials=new Set();
    instance.root.traverse(object=>{
      if(!object.isMesh)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials)if(material)disposedMaterials.add(material);
      if(object.userData.pstudioLightmapOriginalMaterial){const originals=Array.isArray(object.userData.pstudioLightmapOriginalMaterial)?object.userData.pstudioLightmapOriginalMaterial:[object.userData.pstudioLightmapOriginalMaterial];for(const material of originals)if(material)disposedMaterials.add(material);}
      object.userData.pstudioLightmapTexture?.dispose?.();if(object.userData.pstudioLightmapGeometry){object.geometry.userData.pstudioBVHDisposed=true;object.geometry.userData.pstudioBVHToken=(object.geometry.userData.pstudioBVHToken||0)+1;object.geometry?.disposeBoundsTree?.();object.geometry?.dispose?.();}
      object.userData.pstudioLODToken=(object.userData.pstudioLODToken||0)+1;for(const level of object.userData.pstudioAutoLOD||[])if(level.owned)level.geometry.dispose?.();
    });
    disposedMaterials.forEach(material=>{window.PStudioEnvironmentFX?.releaseMaterial?.(material);material.dispose();});
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
    for(const material of waterMaterials){const u=material.userData?.pstudioWaterUniforms;if(u)u.uPStudioTime.value=particleClock;}window.PStudioEnvironmentFX?.update?.(particleClock);
    const usedMeshes=new Set(),usedGrids=new Set(),usedModels=new Set(),usedLights=new Set(),usedEmitters=new Set(),stoppedEmitters=new Set(),preservedOwners=new Set();
    const pendingFrameInstances=[];
    let cameraCommand=null,environment=null,cameraOwnerId=null;
    let defaultBackground=0x171d26;
    if(hdrTexture&&hdrShowBackground)scene.background=hdrTexture;
    else if(scene.background?.isColor)scene.background.set(defaultBackground);
    else scene.background=new T.Color(defaultBackground);
    scene.fog=null;
    if(hemisphereLight) hemisphereLight.intensity=1.15;
    if(keyLight&&!csm){keyLight.position.set(5,9,6);keyLight.intensity=2.4;}
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
          if(pendingCameraFrames.has(String(ownerId))){
            pendingCameraFrames.delete(String(ownerId));
            pendingFrameInstances.push(instance);
          }
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
          mesh=new T.Mesh(geometry,material);setupLightingMaterial(material);bindObjectProbeLighting(mesh);scheduleAutoLOD(mesh,geometry);
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
      if(stoppedEmitters.has(key)||(!usedEmitters.has(key)&&![...preservedOwners].some(owner=>key.startsWith(String(owner)+':')))){disposeGpuParticleSystem(emitter.system);particleEmitters.delete(key);}
    }
    for(const key of stoppedEmitters){const emitter=particleEmitters.get(key);if(emitter){disposeGpuParticleSystem(emitter.system);particleEmitters.delete(key);}}
    for(const [key,effect] of particleBursts){if(particleClock>=effect.expiresAt){disposeGpuParticleSystem(effect.system);particleBursts.delete(key);}}
    updateGpuParticleSystems();
    for(const [key,light] of dynamicLights){if(!usedLights.has(key)&&![...preservedOwners].some(owner=>key.startsWith(String(owner)+':'))){scene.remove(light);if(light.target)scene.remove(light.target);dynamicLights.delete(key);}}
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
        if(csm){if(Number.isFinite(environment.lightX)||Number.isFinite(environment.lightY)||Number.isFinite(environment.lightZ)){const dir=csm.lightDirection||new T.Vector3(-5,-9,-6);dir.set(Number.isFinite(environment.lightX)?environment.lightX:dir.x,Number.isFinite(environment.lightY)?environment.lightY:dir.y,Number.isFinite(environment.lightZ)?environment.lightZ:dir.z).normalize();csm.updateFrustums?.();}if(Number.isFinite(environment.lightIntensity))for(const light of csm.lights||[])light.intensity=Math.max(0,environment.lightIntensity);}
        else{if(Number.isFinite(environment.lightX))keyLight.position.x=environment.lightX;if(Number.isFinite(environment.lightY))keyLight.position.y=environment.lightY;if(Number.isFinite(environment.lightZ))keyLight.position.z=environment.lightZ;if(Number.isFinite(environment.lightIntensity))keyLight.intensity=environment.lightIntensity;}
      }
    }
    const nextCameraSignature=cameraCommand
      ? [cameraCommand.x,cameraCommand.y,cameraCommand.z,cameraCommand.targetX,cameraCommand.targetY,cameraCommand.targetZ,cameraCommand.smoothing??0,cameraOwnerId??''].join('|')
      : 'default';
    if(nextCameraSignature!==cameraCommandSignature){
      cameraTarget=cameraCommand?[cameraCommand.targetX,cameraCommand.targetY,cameraCommand.targetZ]:[0,0,0];
      cameraBase=cameraCommand?[cameraCommand.x,cameraCommand.y,cameraCommand.z]:[6,5,8];
      cameraSmoothing=cameraCommand?Math.max(0,Math.min(30,Number(cameraCommand.smoothing)||0)):0;
      activeCameraOwnerId=cameraOwnerId;
      cameraPan?.set(0,0,0);
      if(!cameraSmoothing){smoothedTarget=null;smoothedPosition=null;}
      cameraFocusOwnerId=null;
      cameraCommandSignature=nextCameraSignature;
    }
    for(const instance of pendingFrameInstances)frameCameraToModel(instance);
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
    frameObject,
    setSelected: id => {
      selectedOwnerId = id || null;
      if(id!==null&&id!==undefined)cameraFocusOwnerId=String(id);
      refreshSelectionOutline();
      if(renderer&&scene&&camera)drawFrame();
    },
    getCameraBasis,
    getModelCollisionTriangles,
    setPostProcessing:(bloom,ssao,strength,ssr)=>{bloomEnabled=!!bloom;ssaoEnabled=!!ssao;bloomStrength=Math.max(0,Math.min(2,Number(strength)||0.45));if(ssr!==undefined)ssrEnabled=!!ssr;if(renderer&&scene&&camera)drawFrame();},
    setQualityPreset:applyQualityPreset,setAdaptiveQuality:enabled=>{adaptiveQualityEnabled=!!enabled&&qualityPreset==='auto';adaptiveSlowFrames=0;adaptiveFastFrames=0;return adaptiveQualityEnabled;},
    setTemporalAA:enabled=>{const next=!!enabled,fx=window.PStudioEnvironmentFX?.getStats?.()||{};if(next&&(Number(fx.waterMaterials)||0)+(Number(fx.foliageMaterials)||0)>0)return{enabled:false,reason:'Three.js r160 TAARenderPass has no motion-vector reprojection; freeze animated water/foliage before enabling temporal accumulation.'};if(!taaPass)return{enabled:false,reason:'TAARenderPass is unavailable.'};temporalAAEnabled=next;taaPass.accumulate=next;taaPass.accumulateIndex=-1;if(!next)taaPass.sampleLevel=resolveQualityPreset(qualityPreset)==='ultra'?2:resolveQualityPreset(qualityPreset)==='high'?1:0;if(renderer&&scene&&camera)drawFrame();return{enabled:temporalAAEnabled,mode:next?'static-scene-temporal-accumulation':'per-frame-spatial-supersampling'};},
    setVolumetricFog:(enabled,options={})=>{volumetricFogEnabled=!!enabled;if(volumetricFogPass){const u=volumetricFogPass.uniforms;if(u){if(options.color)u.uFogColor.value.set(options.color);if(Number.isFinite(options.density))u.uFogDensity.value=Math.max(0,Math.min(.08,options.density));if(Number.isFinite(options.heightFalloff))u.uHeightFalloff.value=Math.max(0,Math.min(.2,options.heightFalloff));if(Number.isFinite(options.baseHeight))u.uBaseHeight.value=options.baseHeight;}}if(renderer&&scene&&camera)drawFrame();return{enabled:volumetricFogEnabled,available:!!volumetricFogPass};},
    getQualityPreset:()=>({requested:qualityPreset,active:resolveQualityPreset(qualityPreset),adaptiveEnabled:adaptiveQualityEnabled,adaptiveLevel:adaptiveQualityLevel}),
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
      renderTimeMs:Number(lastRenderDurationMs.toFixed(2)),gpuRenderTimeMs:lastGpuRenderDurationMs?Number(lastGpuRenderDurationMs.toFixed(2)):null,timingSource:adaptiveMetricSource,gpuTimerQuerySupported:!!gpuTimerExtension,quality:resolveQualityPreset(qualityPreset),adaptive:{enabled:adaptiveQualityEnabled,level:adaptiveQualityLevel,frameEMA:Number(adaptiveFrameEMA.toFixed(2)),source:adaptiveMetricSource},gi:{probeCount:bakedLightProbeVolume?.length||0,bounces:bakedGIBounces,objectLocalSH:true,uvLightmappedMeshes:lightmapTargets().filter(({object})=>!!object.userData.pstudioLightmapTexture).length,pendingLightmaps:pendingLightmaps.size,bvhAvailable:!!window.PStudioBVH},csm:{enabled:!!csm,cascades:csm?.cascades||0,shadowDistance:worldRenderConfig.shadowDistance},environmentFX:window.PStudioEnvironmentFX?.getStats?.()||null,temporalAA:{available:!!taaPass,enabled:!!taaPass?.enabled,accumulating:!!taaPass?.accumulate},volumetricFog:{available:!!volumetricFogPass,enabled:volumetricFogEnabled}
    }:null,
    loadEnvironmentHDR,
    bakeLightProbe,
    clearLightProbe:()=>{let changed=false;if(bakedLightProbe){scene?.remove(bakedLightProbe);bakedLightProbe=null;changed=true;}if(bakedLightProbeVolume){for(const item of bakedLightProbeVolume){scene?.remove(item.light);item.light.dispose?.();}bakedLightProbeVolume=null;bakedGIBounces=0;changed=true;}if(changed)drawFrame();return changed;},
    bakeLightProbeVolume,bakeUVLightmaps,saveLightmaps,loadLightmaps,clearLightmaps,setWorldRenderConfig,registerWorldChunk,assignObjectToChunk,unregisterWorldChunk,
    isOwnerChunkActive,
    setOcclusionCulling:enabled=>{occlusionEnabled=!!enabled;for(const mesh of meshCache.values()){mesh.userData.pstudioOccluded=false;mesh.visible=true;}for(const instance of modelInstances.values()){instance.root.userData.pstudioOccluded=false;instance.root.visible=true;}for(const batch of instancedBatches.values())for(const source of batch.userData.instanceSources||[])source.mesh.userData.pstudioOccluded=false;return occlusionEnabled;},
    getWorldStats:()=>({chunks:worldChunks.size,activeChunks:[...worldChunks.values()].filter(c=>c.active).length,loadingChunks:[...worldChunks.values()].filter(c=>c.loading).length,chunkErrors:[...worldChunks.values()].filter(c=>c.error).map(c=>({id:c.id,error:c.error})),assignedObjects:objectChunkAssignments.size,config:{...worldRenderConfig,lodDistances:worldRenderConfig.lodDistances.slice()}}),
    isAvailable: () => !!window.THREE,
    getModelError: name => modelLoadErrors.get(name) || null,
    invalidateAsset
  };
  window.addEventListener('resize', resize);
})();