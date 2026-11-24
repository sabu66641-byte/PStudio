/* PStudio isolated 3D renderer.
 * This module only owns the additional WebGL canvas; the existing 2D renderer is untouched.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('game-3d-canvas');
  if (!canvas) return;
  let renderer = null;
  let composer=null,bloomPass=null,ssaoPass=null,gtaoPass=null,ssrPass=null,outputPass=null,taaPass=null,smaaPass=null,volumetricFogPass=null,volumetricCloudPass=null,contactShadowPass=null;
  let bloomEnabled=false,ssaoEnabled=false,bloomStrength=0.45,volumetricFogEnabled=false,volumetricCloudsEnabled=false,contactShadowsEnabled=false,contactShadowsRequested=null,temporalAAEnabled=false;
  function readSavedQualityPreset(){
    try{
      const saved=window.localStorage?.getItem('pstudio-render-quality')||'auto';
      return ['auto','mobile','balanced','high','ultra'].includes(saved)?saved:'auto';
    }catch(_){return 'auto';}
  }
  let ssrEnabled=false,qualityAOEnabled=false,qualityPreset=readSavedQualityPreset();
  let csm=null,adaptiveQualityEnabled=true,adaptiveQualityLevel=2,adaptiveFrameEMA=0,adaptiveSlowFrames=0,adaptiveFastFrames=0,adaptiveLastChange=0;
  let gpuTimerGl=null,gpuTimerExtension=null,gpuTimerQueries=[],lastGpuRenderDurationMs=0,lastGpuTimerTimestamp=0,adaptiveMetricSource='cpu-render-submission';
  let parallelShaderCompileSupported=false,modelPreparationPending=0,stagedTextureUploads=0;
  let shaderCompileQueue=Promise.resolve();
  let worldFrustum=null,worldFrustumMatrix=null,worldFrustumSphere=null;
  let gpuInstanceFrustumCullingEnabled=true;
  let occlusionRaycaster=null,occlusionEnabled=true,occlusionCursor=0,occlusionFrame=0;
  let lastProbeCameraPosition=null;
  let hdrTexture=null,hdrEnvironmentTarget=null,hdrShowBackground=false,bakedLightProbe=null,bakedLightProbeVolume=null,bakedGIBounces=0;
  const worldChunks=new Map(),objectChunkAssignments=new Map();
  const worldRenderConfig={maxDrawDistance:2400,lodDistances:[25,70,150],shadowDistance:900,probeBlendCount:4};
  let particleClock=0,lastRenderDurationMs=0;
  const waterMaterials=new Set();
  let waterDepthTarget=null,waterDepthMaterial=null,waterDepthPrepassFailed=false;
  const instancedBatches=new Map();
  let pmremGenerator = null, environmentTarget = null;
  let scene = null;
  let camera = null;
  let primitiveGroup = null;
  let modelGroup = null;
  let selectionGroup = null;
  const modelCache = new Map();
  const modelPromises = new Map();
  let gltfWorker=null,gltfWorkerSequence=0,sharedKTX2Loader=null,gltfWorkerCapabilitiesPromise=null;
  const gltfWorkerPending=new Map();

  const modelRevisions = new Map();
  const modelInstances = new Map();
  const modelInstancePromises = new Map();
  const virtualTextures = new Map();
  const virtualTextureAtlases = new Map();
  const virtualTexturePageCache = new Map();
  const virtualTexturePending = new Set();
  const virtualTextureQueue = [];
  let virtualTexturePumpScheduled=false,virtualTextureTileUploads=0,virtualTextureRequests=0;
  const CLUSTER_GRID_X=16,CLUSTER_GRID_Y=9,CLUSTER_GRID_Z=16;
  const CLUSTER_MAX_LIGHTS=96,CLUSTER_MAX_PER_CELL=24;
  let clusteredLightingEnabled=true,clusteredLightingActive=false,clusteredLightingResources=null;
  let clusteredLightingLastUpdate=0,clusteredLightingLastSignature='',clusteredLightingUpdatedClusters=0;
  let clusteredLightSet=new Set();
  let modelBuildGeneration=0;
  const modelLoadErrors = new Map();
  const modelBuildErrors = new Map();
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
  let scenePresetTexture=null,scenePresetTarget=null,scenePresetSignature='',scenePresetUsesPhysicalSky=false;
  let activeEnvironmentPreset='day';
  let physicalSky=null;
  let moonMesh=null,moonSurfaceTexture=null,moonDirection=null,moonLightDirection=null,moonIntensity=0;
  let sunMesh=null,sunSurfaceTexture=null,sunDirection=null,sunViewDirection=null,sunIntensity=0,sunAngularRadius=1.2,sunGlareStrength=0,moonGlareStrength=0;
  let adaptiveUltraTouchMode=false;
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

  function clampEditorOrbitPitch(value){
    const pitch=Number(value)||0;
    if(window.PStudioEngine?.isRunning?.())return Math.max(-1.35,Math.min(1.35,pitch));
    const horizontal=Math.hypot(cameraBase[0]-cameraTarget[0],cameraBase[2]-cameraTarget[2]);
    const baseElevation=Math.atan2(cameraBase[1]-cameraTarget[1],Math.max(1e-6,horizontal));
    // Allow an almost full vertical orbit while staying just clear of the lookAt pole singularities.
    const maxElevation=Math.PI/2-0.002;
    const minPitch=baseElevation-maxElevation;
    const maxPitch=baseElevation+maxElevation;
    return Math.max(minPitch,Math.min(maxPitch,pitch));
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
      if(pointerMode==='pinch'&&activePointers.size>=2){const pts=[...activePointers.values()];const distance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);const midpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};if(!pinchGestureMode&&pinchGestureStart){const zoomDelta=Math.abs(distance-pinchGestureStart.distance);const panDelta=Math.hypot(midpoint.x-pinchGestureStart.midpoint.x,midpoint.y-pinchGestureStart.midpoint.y);if(Math.max(zoomDelta,panDelta)>5)pinchGestureMode=zoomDelta>panDelta*1.15?'zoom':'pan';}if(pinchGestureMode==='zoom'&&pinchDistance>0){zoom=clampCameraZoom(zoom*(pinchDistance/Math.max(1,distance)));updateCameraZoomReadout();}else if(pinchGestureMode==='pan'&&pinchMidpoint)panCamera(midpoint.x-pinchMidpoint.x,midpoint.y-pinchMidpoint.y);pinchDistance=distance;pinchMidpoint=midpoint;}
      else if(pointerMode==='orbit'){
        const dx=e.clientX-pointerStart.x,dy=e.clientY-pointerStart.y;
        orbitYaw+=dx*0.006;orbitPitch=clampEditorOrbitPitch(orbitPitch+dy*0.006);pointerStart={x:e.clientX,y:e.clientY};
      }else if(pointerMode==='pan'){panCamera(e.clientX-pointerStart.x,e.clientY-pointerStart.y);pointerStart={x:e.clientX,y:e.clientY};}
      else if(pointerMode==='locked-object'&&dragInfo&&Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)>6){
        // When model manipulation is locked, dragging over the model orbits the camera.
        pointerMode='orbit';dragInfo=null;lastObjectTap=null;
        const dx=e.clientX-pointerStart.x,dy=e.clientY-pointerStart.y;
        orbitYaw+=dx*0.006;orbitPitch=clampEditorOrbitPitch(orbitPitch+dy*0.006);
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
    interactionSurface.addEventListener('wheel',e=>{zoom=clampCameraZoom(zoom*Math.exp(e.deltaY*0.00075));updateCameraZoomReadout();scheduleCameraUpdate();e.preventDefault();},{passive:false});
    interactionSurface.addEventListener('contextmenu',e=>e.preventDefault());
  }
  const CAMERA_ZOOM_MIN=0.012,CAMERA_ZOOM_MAX=256;
  function clampCameraZoom(value){return Math.max(CAMERA_ZOOM_MIN,Math.min(CAMERA_ZOOM_MAX,Number(value)||1));}
  function updateCameraZoomReadout(){
    const output=document.getElementById('camera-zoom-level');
    if(output)output.textContent=Math.round((1/zoom)*100)+'%';
  }
  function adjustCameraZoom(factor){
    const multiplier=Number(factor);
    if(!Number.isFinite(multiplier)||multiplier<=0)return{zoom,displayPercent:Math.round((1/zoom)*100)};
    zoom=clampCameraZoom(zoom*multiplier);updateCameraZoomReadout();scheduleCameraUpdate();
    return{zoom,displayPercent:Math.round((1/zoom)*100)};
  }
  const QUALITY_PROFILES={
    mobile:{pixelRatio:1,shadowSize:1024,shadowMode:'pcf',ao:false,ssr:false,clouds:false,atmosphere:false,contactShadows:false},
    balanced:{pixelRatio:1.5,shadowSize:2048,shadowMode:'pcf',ao:false,ssr:false,clouds:false,atmosphere:false,contactShadows:false},
    high:{pixelRatio:2,shadowSize:3072,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true},
    ultra:{pixelRatio:2.1,shadowSize:4096,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true}
  };
  function qualityHardwareCapabilities(){
    let maxTextureSize=Number(renderer?.capabilities?.maxTextureSize)||0;
    if(!maxTextureSize){
      try{const gl=renderer?.getContext?.();maxTextureSize=Number(gl?.getParameter?.(gl.MAX_TEXTURE_SIZE))||0;}catch(_){}
    }
    if(!maxTextureSize)maxTextureSize=4096;
    return{
      memoryGiB:deviceMemoryGiB(),
      cpuCores:Math.max(1,Number(window.navigator?.hardwareConcurrency)||4),
      maxTextureSize,
      touch:Number(window.navigator?.maxTouchPoints||0)>0,
      pixelRatio:Math.max(1,Number(window.devicePixelRatio)||1)
    };
  }
  function resolveQualityPreset(name){
    if(name!=='auto')return QUALITY_PROFILES[name]?name:'balanced';
    const hardware=qualityHardwareCapabilities();
    const {memoryGiB,cpuCores,maxTextureSize,touch}=hardware;
    // Choose the strongest sensible starting tier, then adapt from real frame timing.
    if(memoryGiB<=2||cpuCores<=2||maxTextureSize<2048)return 'mobile';
    if(memoryGiB<=3||cpuCores<4||maxTextureSize<4096||(touch&&memoryGiB<=4))return 'balanced';
    if(memoryGiB>=8&&cpuCores>=8&&maxTextureSize>=8192)return 'ultra';
    return 'high';
  }

  function resolveShadowMapSize(requested){
    let maxTextureSize=4096;
    try{
      const gl=renderer?.getContext?.();
      const queried=Number(gl?.getParameter?.(gl.MAX_TEXTURE_SIZE));
      if(Number.isFinite(queried)&&queried>0)maxTextureSize=queried;
    }catch(_){}
    const memory=deviceMemoryGiB();
    const memoryCap=qualityPreset==='auto'?(memory<=2?1024:memory<=4?2048:4096):(memory<=4?2048:memory<=6?3072:4096);
    const hardwareCap=Math.max(512,Math.min(maxTextureSize,memoryCap));
    const requestedSize=Math.max(512,Math.floor(Number(requested)||2048));
    return Math.min(requestedSize,hardwareCap);
  }

  function resolveQualityRenderPixelRatio(selected,adaptiveLevel=2,adaptive=true){
    const hardware=qualityHardwareCapabilities();
    const dpr=Math.max(.6,Number(hardware.pixelRatio)||1);
    const level=Math.max(0,Math.min(2,Math.floor(Number(adaptiveLevel)||0)));
    if(selected==='ultra'){
      // Ultra renders at 2x the effective Maximum-tier pixel ratio on both axes.
      // Limit the drawing buffer to the GPU texture edge and a device-aware pixel budget.
      const requested=Math.min(dpr,QUALITY_PROFILES.maximum.pixelRatio)*2;
      const rect=canvas?.getBoundingClientRect?.()||{};
      const width=Math.max(0,Number(rect.width)||0),height=Math.max(0,Number(rect.height)||0);
      if(width<=0||height<=0)return requested;
      const memory=hardware.memoryGiB;
      const pixelBudget=memory<=2?9500000:memory<=4?14000000:memory<=6?20000000:28000000;
      const textureCap=hardware.maxTextureSize/Math.max(width,height);
      const pixelCap=Math.sqrt(pixelBudget/(width*height));
      return Math.max(.6,Math.min(requested,textureCap,pixelCap));
    }
    const profile=QUALITY_PROFILES[selected]||QUALITY_PROFILES.balanced;
    const scale=adaptive
      ?(selected==='maximum'?[.66,.78,.94][level]:[.68,.84,1][level])
      :1;
    return Math.min(dpr,profile.pixelRatio*scale);
  }

  function applyQualityPreset(name='auto'){
    memorySafetyApplied=false;
    qualityPreset=QUALITY_PROFILES[name]?name:'auto';
    adaptiveQualityFrameEMAReset();
    const selected=resolveQualityPreset(qualityPreset);
    const isTouchDevice=Number(window.navigator?.maxTouchPoints||0)>0;
    const hardware=qualityHardwareCapabilities();
    adaptiveMaximumTouchMode=qualityPreset==='maximum'&&isTouchDevice&&
      (hardware.memoryGiB<=6||hardware.cpuCores<=6||hardware.maxTextureSize<8192);
    adaptiveQualityEnabled=qualityPreset==='auto'||qualityPreset==='ultra'||adaptiveMaximumTouchMode;
    // Ultra keeps its 2x Maximum-tier output resolution. Adaptive levels tune costly effects
    // around it; GPU texture and device memory limits remain authoritative.
    adaptiveQualityLevel=2;
    if(adaptiveMaximumTouchMode)adaptiveQualityLevel=1;
    if(qualityPreset==='auto'&&selected==='mobile'&&isTouchDevice&&deviceMemoryGiB()>2)adaptiveQualityLevel=1;
    const baseProfile=QUALITY_PROFILES[selected],profile=baseProfile;
    const effectsEnabled=!memorySafetyApplied;
    qualityAOEnabled=effectsEnabled&&profile.ao&&!!ssaoPass;ssaoEnabled=qualityAOEnabled;
    ssrEnabled=effectsEnabled&&profile.ssr&&!!ssrPass;
    contactShadowsEnabled=!!contactShadowPass&&!memorySafetyApplied&&(contactShadowsRequested===null?(effectsEnabled&&!!profile.contactShadows):contactShadowsRequested);
    if(contactShadowPass){contactShadowPass.enabled=contactShadowsEnabled;contactShadowPass.setQuality?.(selected,adaptiveQualityLevel);}
    if(taaPass&&!temporalAAEnabled)taaPass.sampleLevel=adaptiveQualityEnabled?(adaptiveQualityLevel>=2?2:adaptiveQualityLevel===1?1:0):(selected==='ultra'?2:selected==='high'?1:0);
    if(smaaPass)smaaPass.enabled=!taaPass;
    if(renderer){
      const initialAdaptiveScale=adaptiveQualityEnabled?(selected==='ultra'?[0.66,0.78,0.94][adaptiveQualityLevel]:[0.68,0.84,1][adaptiveQualityLevel]):1;
      renderer.setPixelRatio(Math.min(Math.max(0.6,Number(window.devicePixelRatio)||1),profile.pixelRatio*initialAdaptiveScale));composer?.setPixelRatio?.(renderer.getPixelRatio());
      renderer.shadowMap.enabled=true;
      renderer.shadowMap.type=profile.shadowMode==='vsm'&&effectsEnabled?window.THREE.VSMShadowMap:window.THREE.PCFSoftShadowMap;
      renderer.shadowMap.needsUpdate=true;
      const lights=csm?.lights?.length?csm.lights:(keyLight?[keyLight]:[]);
      const requestedShadow=adaptiveUltraTouchMode?[1536,2048,3072][adaptiveQualityLevel]:Math.min(4096,profile.shadowSize);
      for(const light of lights)if(light?.shadow){const size=resolveShadowMapSize(csm?requestedShadow:Math.min(requestedShadow,profile.shadowSize));light.shadow.mapSize.set(size,size);light.shadow.dispose?.();light.shadow.radius=profile.shadowMode==='vsm'&&effectsEnabled?2.2:2;light.shadow.bias=-0.00004;light.shadow.normalBias=0.008;light.shadow.needsUpdate=true;}
      if(csm){csm.maxFar=worldRenderConfig.shadowDistance;csm.updateFrustums?.();}
      volumetricCloudsEnabled=!!(effectsEnabled&&profile.clouds&&volumetricCloudPass&&activeEnvironmentPreset!=='studio');
      if(volumetricCloudPass){volumetricCloudPass.enabled=volumetricCloudsEnabled;volumetricCloudPass.setQuality?.(selected,adaptiveQualityLevel);}
      volumetricFogEnabled=!!(effectsEnabled&&profile.atmosphere&&volumetricFogPass);
      if(volumetricFogPass){volumetricFogPass.enabled=volumetricFogEnabled;volumetricFogPass.setQuality?.(selected,adaptiveQualityLevel);}
      if(contactShadowPass){contactShadowPass.enabled=contactShadowsEnabled;contactShadowPass.setQuality?.(selected,adaptiveQualityLevel);}
      if(gtaoPass?.updateGtaoMaterial){const level=adaptiveQualityEnabled?adaptiveQualityLevel:2;const aoSamples=selected==='ultra'?[12,20,32][level]:[8,12,16][level];const pdSamples=selected==='ultra'?[14,22,32][level]:[12,18,24][level];gtaoPass.updateGtaoMaterial({radius:selected==='ultra'?0.72:0.52,thickness:selected==='ultra'?0.16:0.12,distanceExponent:1.5,scale:selected==='ultra'?1.0:0.85,samples:aoSamples,screenSpaceRadius:false});gtaoPass.updatePdMaterial?.({rings:selected==='ultra'?3:2,samples:pdSamples,radius:selected==='ultra'?9:8});}
      lastSize={width:0,height:0};resize();
    }
    try{window.PStudioEvents?.emit('render.quality.changed',{requested:qualityPreset,active:selected,profile,adaptive:adaptiveUltraTouchMode});}catch(_){}
    try{window.localStorage?.setItem('pstudio-render-quality',qualityPreset);}catch(_){}
    try{window.dispatchEvent(new CustomEvent('pstudio-quality-state-changed',{detail:{requested:qualityPreset,active:selected,adaptiveLevel:adaptiveQualityLevel,adaptiveEnabled:adaptiveQualityEnabled,safetyLimited:memorySafetyApplied}}));}catch(_){}
    return{preset:selected,...profile,adaptiveLevel:adaptiveQualityLevel};
  }
  function adaptiveQualityFrameEMAReset(){adaptiveFrameEMA=0;adaptiveSlowFrames=0;adaptiveFastFrames=0;}
  function applyAdaptiveQuality(){
    if(!adaptiveQualityEnabled||!renderer)return;
    const now=window.performance?.now?.()??Date.now();
    const hasRecentGpuSample=!!gpuTimerGl&&lastGpuRenderDurationMs>0&&now-lastGpuTimerTimestamp<1500;
    adaptiveMetricSource=hasRecentGpuSample?'gpu-timer-query':'cpu-render-submission';
    const ms=hasRecentGpuSample?lastGpuRenderDurationMs:(Number(lastRenderDurationMs)||0);
    adaptiveFrameEMA=adaptiveFrameEMA?adaptiveFrameEMA*0.9+ms*0.1:ms;
    if(adaptiveFrameEMA>19){adaptiveSlowFrames++;adaptiveFastFrames=0;}
    else if(adaptiveFrameEMA<15){adaptiveFastFrames++;adaptiveSlowFrames=0;}
    else{adaptiveSlowFrames=Math.max(0,adaptiveSlowFrames-1);adaptiveFastFrames=0;}
    if(now-adaptiveLastChange<1800)return;
    let changed=false;
    if(adaptiveSlowFrames>=35&&adaptiveQualityLevel>0){adaptiveQualityLevel--;changed=true;}
    else if(adaptiveFastFrames>=150&&adaptiveQualityLevel<2){adaptiveQualityLevel++;changed=true;}
    if(!changed)return;
    adaptiveLastChange=now;adaptiveQualityFrameEMAReset();
    const selected=resolveQualityPreset(qualityPreset),base=QUALITY_PROFILES[selected];
    const scale=base.pixelRatio*(selected==='ultra'?[0.66,0.78,0.94][adaptiveQualityLevel]:[0.68,0.84,1][adaptiveQualityLevel]);
    const safeScale=memorySafetyApplied?Math.min(scale,0.8):scale;
    renderer.setPixelRatio(Math.min(Math.max(0.6,Number(window.devicePixelRatio)||1),safeScale));composer?.setPixelRatio?.(renderer.getPixelRatio());
    const effects=!memorySafetyApplied;
    qualityAOEnabled=effects&&base.ao&&!!ssaoPass;ssaoEnabled=qualityAOEnabled;ssrEnabled=effects&&base.ssr&&!!ssrPass;
    volumetricCloudsEnabled=effects&&!!base.clouds&&!!volumetricCloudPass&&activeEnvironmentPreset!=='studio';
    volumetricFogEnabled=effects&&!!base.atmosphere&&!!volumetricFogPass;
    contactShadowsEnabled=!!contactShadowPass&&!memorySafetyApplied&&(contactShadowsRequested===null?(effects&&!!base.contactShadows):contactShadowsRequested);
    if(contactShadowPass){contactShadowPass.enabled=contactShadowsEnabled;contactShadowPass.setQuality?.(selected,adaptiveQualityLevel);}
    if(volumetricCloudPass){volumetricCloudPass.enabled=volumetricCloudsEnabled;volumetricCloudPass.setQuality?.(selected,adaptiveQualityLevel);}
    if(volumetricFogPass){volumetricFogPass.enabled=volumetricFogEnabled;volumetricFogPass.setQuality?.(selected,adaptiveQualityLevel);}
    if(gtaoPass?.updateGtaoMaterial){const aoSamples=selected==='ultra'?[12,20,32][adaptiveQualityLevel]:[8,12,16][adaptiveQualityLevel];const pdSamples=selected==='ultra'?[14,22,32][adaptiveQualityLevel]:[12,18,24][adaptiveQualityLevel];gtaoPass.updateGtaoMaterial({radius:selected==='ultra'?0.72:0.52,thickness:selected==='ultra'?0.16:0.12,distanceExponent:1.5,scale:selected==='ultra'?1.0:0.85,samples:aoSamples,screenSpaceRadius:false});gtaoPass.updatePdMaterial?.({rings:selected==='ultra'?3:2,samples:pdSamples,radius:selected==='ultra'?9:8});}
    if(taaPass&&!temporalAAEnabled){taaPass.sampleLevel=adaptiveQualityLevel;taaPass.accumulateIndex=-1;}
    const shadowSizes=adaptiveUltraTouchMode?[1536,2048,3072]:qualityPreset==='ultra'?[1024,2048,4096]:[1024,1536,2048];
    const mapSize=resolveShadowMapSize(shadowSizes[adaptiveQualityLevel]);
    const lights=csm?.lights?.length?csm.lights:(keyLight?[keyLight]:[]);
    for(const light of lights)if(light?.shadow){light.shadow.mapSize.set(mapSize,mapSize);light.shadow.dispose?.();light.shadow.needsUpdate=true;}
    lastSize={width:0,height:0};resize();
    try{window.PStudioEvents?.emit('render.quality.adapted',{level:adaptiveQualityLevel,scale,renderTimeMs:adaptiveFrameEMA,source:adaptiveMetricSource,requested:qualityPreset});}catch(_){}
    try{window.dispatchEvent(new CustomEvent('pstudio-quality-state-changed',{detail:{requested:qualityPreset,active:selected,adaptiveLevel:adaptiveQualityLevel,adaptiveEnabled:adaptiveQualityEnabled,safetyLimited:memorySafetyApplied}}));}catch(_){}
  }

  function ensureRenderer(){
    if(renderer)return true;
    if(!window.THREE||!window.THREE.WebGLRenderer)return false;
    const T=window.THREE;
    const deviceGiB=deviceMemoryGiB();
    renderer=new T.WebGLRenderer({canvas,antialias:deviceGiB>=6,alpha:false,powerPreference:deviceGiB>=4?'high-performance':'low-power',preserveDrawingBuffer:false});
    try{
      const memoryGiB=deviceGiB;
      const gpuBudget=Math.floor(Math.max(192,Math.min(2048,memoryGiB*256))*1024*1024);
      const cpuBudget=Math.floor(Math.max(384,Math.min(2048,memoryGiB*192))*1024*1024);
      window.PStudioResources?.setBudget?.('gpu',gpuBudget);
      window.PStudioResources?.setBudget?.('cpu',cpuBudget);
    }catch(error){console.warn('[PStudio] Device-aware resource budget setup failed; existing budgets remain active.',error);}

    try{const gl=renderer.getContext(),extension=gl.getExtension?.('EXT_disjoint_timer_query_webgl2');parallelShaderCompileSupported=!!gl.getExtension?.('KHR_parallel_shader_compile');if(extension&&typeof gl.createQuery==='function'&&typeof gl.getQueryParameter==='function'){gpuTimerGl=gl;gpuTimerExtension=extension;}else{gpuTimerGl=null;gpuTimerExtension=null;}}catch(error){gpuTimerGl=null;gpuTimerExtension=null;parallelShaderCompileSupported=false;console.warn('[PStudio] GPU timing/parallel shader extensions unavailable; CPU timing fallback will be used.',error);}
    if(renderer.info)renderer.info.autoReset=false;
    renderer.outputColorSpace=T.SRGBColorSpace;
    renderer.toneMapping=T.ACESFilmicToneMapping;
    renderer.toneMappingExposure=1.12;
    renderer.setClearColor(0x171d26,1);
    if(T.DepthTexture&&T.WebGLRenderTarget&&T.MeshDepthMaterial){
      const size=renderer.getDrawingBufferSize(new T.Vector2());
      waterDepthTarget=new T.WebGLRenderTarget(Math.max(1,size.x),Math.max(1,size.y),{depthBuffer:true,stencilBuffer:false});
      waterDepthTarget.texture.generateMipmaps=false;
      waterDepthTarget.depthTexture=new T.DepthTexture(Math.max(1,size.x),Math.max(1,size.y),T.UnsignedIntType);
      waterDepthTarget.depthTexture.format=T.DepthFormat;
      waterDepthTarget.depthTexture.minFilter=T.NearestFilter;
      waterDepthTarget.depthTexture.magFilter=T.NearestFilter;
      waterDepthMaterial=new T.MeshDepthMaterial({depthPacking:T.BasicDepthPacking});
      waterDepthMaterial.colorWrite=false;waterDepthMaterial.depthWrite=true;waterDepthMaterial.side=T.DoubleSide;
    }
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
      if(FX.GTAOPass){gtaoPass=new FX.GTAOPass(scene,camera,Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight));if(FX.GTAOPass.OUTPUT?.Default!==undefined)gtaoPass.output=FX.GTAOPass.OUTPUT.Default;gtaoPass.enabled=false;composer.addPass(gtaoPass);ssaoPass=gtaoPass;}
      else if(FX.SSAOPass){ssaoPass=new FX.SSAOPass(scene,camera,Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight));ssaoPass.kernelRadius=8;ssaoPass.minDistance=0.001;ssaoPass.maxDistance=0.12;ssaoPass.enabled=false;composer.addPass(ssaoPass);}
      if(FX.SSRPass){try{ssrPass=new FX.SSRPass({renderer,scene,camera,width:Math.max(1,canvas.clientWidth),height:Math.max(1,canvas.clientHeight),selects:null});ssrPass.enabled=false;ssrPass.thickness=0.018;ssrPass.maxDistance=28;ssrPass.opacity=0.72;ssrPass.blur=true;composer.addPass(ssrPass);}catch(error){ssrPass=null;console.warn('[PStudio] SSR unavailable:',error);}}
      contactShadowPass=window.PStudioEnvironmentFX?.createContactShadowPass?.(FX,T)||null;if(contactShadowPass){contactShadowPass.enabled=false;composer.addPass(contactShadowPass);}
      if(FX.UnrealBloomPass){bloomPass=new FX.UnrealBloomPass(new T.Vector2(Math.max(1,canvas.clientWidth),Math.max(1,canvas.clientHeight)),bloomStrength,0.35,0.84);bloomPass.enabled=false;composer.addPass(bloomPass);}
      volumetricCloudPass=window.PStudioEnvironmentFX?.createVolumetricCloudPass?.(FX,T)||null;if(volumetricCloudPass){volumetricCloudPass.enabled=false;composer.addPass(volumetricCloudPass);}
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
        const materials=Array.isArray(child.material)?child.material:[child.material];
        for(const material of materials){window.PStudioEnvironmentFX?.releaseMaterial?.(material);material?.dispose?.();}
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
      if(waterDepthTarget){const size=renderer.getDrawingBufferSize(new window.THREE.Vector2());waterDepthTarget.setSize(Math.max(1,size.x),Math.max(1,size.y));}
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
  function renderWaterDepthPrepass(){
    const fx=window.PStudioEnvironmentFX,stats=fx?.getStats?.();
    const needsDepth=Number(stats?.waterMaterials)>0||volumetricFogEnabled||volumetricCloudsEnabled||contactShadowsEnabled;
    if(!waterDepthTarget||!waterDepthMaterial||!needsDepth){
      fx?.setSceneDepthTexture?.(null,1,1,camera?.near,camera?.far);return false;
    }
    const T=window.THREE,size=renderer.getDrawingBufferSize(new T.Vector2());
    if(waterDepthTarget.width!==Math.max(1,size.x)||waterDepthTarget.height!==Math.max(1,size.y))waterDepthTarget.setSize(Math.max(1,size.x),Math.max(1,size.y));
    const hidden=[];
    scene.traverse(object=>{
      if(!object.isMesh||!object.visible)return;
      const name=String(object.name||'');
      const mats=Array.isArray(object.material)?object.material:[object.material];
      const transparent=mats.some(material=>material&&(material.transparent||(Number.isFinite(material.opacity)&&material.opacity<.999)||material.alphaMap||(material.alphaTest||0)>.001));
      const omit=object.userData?.pstudioWaterSurface||!!object.userData?.pstudioWindPart||object.userData?.pstudioFoliageLOD!==undefined||transparent||/(?:sky|cloud|tree|foliage|grass|wildflower|atmosphere[_ -]?dome|PStudio_Foliage_GPU|PStudio_GPU_Instances_Foliage)/i.test(name);
      if(omit){hidden.push(object);object.visible=false;}
    });
    const previousTarget=renderer.getRenderTarget(),previousOverride=scene.overrideMaterial,previousAutoClear=renderer.autoClear;
    const previousShadowAutoUpdate=renderer.shadowMap?.autoUpdate;
    try{
      scene.overrideMaterial=waterDepthMaterial;
      if(renderer.shadowMap)renderer.shadowMap.autoUpdate=false;
      renderer.setRenderTarget(waterDepthTarget);renderer.autoClear=true;renderer.clear(true,true,true);
      renderer.render(scene,camera);
    }catch(error){
      waterDepthPrepassFailed=true;
      fx?.setSceneDepthTexture?.(null,1,1,camera.near,camera.far);
      console.warn('[PStudio] Water depth prepass failed; edge-depth fallback will be used.',error);
      return false;
    }finally{
      scene.overrideMaterial=previousOverride;
      for(const object of hidden)object.visible=true;
      renderer.setRenderTarget(previousTarget);renderer.autoClear=previousAutoClear;
      if(renderer.shadowMap)renderer.shadowMap.autoUpdate=previousShadowAutoUpdate;
    }
    fx?.setSceneDepthTexture?.(waterDepthTarget.depthTexture,size.x,size.y,camera.near,camera.far);
    waterDepthPrepassFailed=false;
    return true;
  }

  function hideStaticSkyForVolumetrics(){
    if(!volumetricCloudsEnabled||!scene)return[];
    const hidden=[];
    scene.traverse(object=>{
      if(!object.isMesh||!object.visible)return;
      if(!/(?:sky[_ -]?dome|cloudbank|cumulus|cirrus|atmosphere[_ -]?dome)/i.test(String(object.name||'')))return;
      hidden.push({object,visible:object.visible});
      object.visible=false;
    });
    return hidden;
  }
  function restoreStaticSky(hidden){
    for(const entry of hidden||[])entry.object.visible=entry.visible;
  }

  let lastMemorySampleAt=0,memorySafetyApplied=false,lastMemoryPressure=0;
  function memorySnapshot(){
    const perfMemory=window.performance?.memory||null;
    const used=Number(perfMemory?.usedJSHeapSize)||0;
    const limit=Number(perfMemory?.jsHeapSizeLimit)||0;
    const modelBytes=[...modelCache.values()].reduce((sum,asset)=>sum+(Number(asset.memoryEstimateBytes)||0),0);
    const modelBudget=modelRuntimeBudgetBytes();
    const resources=window.PStudioResources?.stats?.()||null;
    const virtualTexturePageTableBytes=[...virtualTextures.values()].reduce((sum,record)=>sum+(record.pageTableData?.byteLength||0),0);
    const virtualTextureAtlasBytes=[...virtualTextureAtlases.values()].reduce((sum,atlas)=>sum+(atlas.bytes||0),0);
    const clusteredLightingBytes=Number(clusteredLightingResources?.bytes)||0;
    const auxiliaryGpuBytes=virtualTextureAtlasBytes+virtualTexturePageTableBytes+clusteredLightingBytes;
    const auxiliaryCpuBytes=virtualTexturePageTableBytes+clusteredLightingBytes;
    const gpuBytes=(Number(resources?.gpuBytes)||0)+auxiliaryGpuBytes,gpuBudget=Number(resources?.gpuBudgetBytes)||0;
    const cpuBytes=(Number(resources?.cpuBytes)||0)+auxiliaryCpuBytes,cpuBudget=Number(resources?.cpuBudgetBytes)||0;
    const heapRatio=limit>0?used/limit:0;
    const modelRatio=modelBudget>0?modelBytes/modelBudget:0;
    const gpuRatio=gpuBudget>0?gpuBytes/gpuBudget:0;
    const cpuRatio=cpuBudget>0?cpuBytes/cpuBudget:0;
    return{
      deviceMemoryGiB:deviceMemoryGiB(),
      usedJSHeapBytes:used||null,
      jsHeapLimitBytes:limit||null,
      heapPressure:heapRatio||null,
      modelEstimateBytes:modelBytes,
      modelBudgetBytes:modelBudget,
      modelPressure:modelRatio,
      estimatedGpuBytes:gpuBytes,
      gpuBudgetBytes:gpuBudget,
      gpuPressure:gpuRatio,
      cpuResourceBytes:cpuBytes,
      cpuBudgetBytes:cpuBudget,
      cpuResourcePressure:cpuRatio,
      auxiliaryGpuBytes,
      auxiliaryCpuBytes,
      virtualTextureAtlasBytes,
      virtualTexturePageTableBytes,
      clusteredLightingBytes,
      rendererMemory:renderer?.info?.memory?{geometries:renderer.info.memory.geometries||0,textures:renderer.info.memory.textures||0}:null,
      resources,
      modelPreparationPending,
      stagedTextureUploads,
      safetyMode:memorySafetyApplied
    };
  }
  function sampleMemoryPressure(){
    const now=window.performance?.now?.()??Date.now();
    if(now-lastMemorySampleAt<2500)return;
    lastMemorySampleAt=now;
    const snapshot=memorySnapshot();
    const pressure=Math.max(Number(snapshot.heapPressure)||0,Number(snapshot.modelPressure)||0,Number(snapshot.gpuPressure)||0,Number(snapshot.cpuResourcePressure)||0);
    lastMemoryPressure=pressure;
    if(pressure>=.82&&!memorySafetyApplied){
      memorySafetyApplied=true;
      try{window.dispatchEvent(new CustomEvent('pstudio-quality-state-changed',{detail:{requested:qualityPreset,active:resolveQualityPreset(qualityPreset),adaptiveLevel:adaptiveQualityLevel,safetyLimited:true}}));}catch(_){}
      // Drop only expensive screen-space effects and render scale; never dispose retained scene assets.
      const current=renderer?.getPixelRatio?.()||1;
      renderer?.setPixelRatio?.(Math.max(.65,current*.82));
      composer?.setPixelRatio?.(renderer?.getPixelRatio?.()||1);
      qualityAOEnabled=false;ssrEnabled=false;volumetricCloudsEnabled=false;volumetricFogEnabled=false;
      if(ssaoPass)ssaoPass.enabled=false;if(ssrPass)ssrPass.enabled=false;
      if(volumetricCloudPass)volumetricCloudPass.enabled=false;if(volumetricFogPass)volumetricFogPass.enabled=false;
      const cache=window.PStudioResources?.stats?.();
      contactShadowsEnabled=false;if(contactShadowPass)contactShadowPass.enabled=false;
      if(cache){
        window.PStudioResources.trim?.('cpu',Math.floor(cache.cpuBudgetBytes*.72));
        window.PStudioResources.trim?.('gpu',Math.floor(cache.gpuBudgetBytes*.72));
      }
    }
    try{window.dispatchEvent(new CustomEvent('pstudio-memory-snapshot',{detail:{...snapshot,pressure,memorySafetyApplied}}));}catch(_){}
  }

  function gridMaterials(grid){
    return Array.isArray(grid?.material)?grid.material:(grid?.material?[grid.material]:[]);
  }
  function disposeGrid(grid){
    grid?.geometry?.dispose?.();
    for(const material of gridMaterials(grid))material?.dispose?.();
  }
  function gridDivisionsForDistance(baseDivisions,distance){
    const base=Math.max(8,Math.floor(Number(baseDivisions)||100));
    if(base<64)return base;
    if(distance>700)return 16;
    if(distance>430)return 24;
    if(distance>250)return 40;
    return base;
  }
  function updateEditorGridPresentation(){
    if(!camera||!gridCache.size||!window.THREE)return;
    const T=window.THREE;
    for(const [key,entry] of gridCache){
      let grid=entry;
      const baseSize=Math.max(1,Number(grid.userData?.pstudioGridBaseSize)||500);
      const baseDivisions=Math.max(8,Number(grid.userData?.pstudioGridBaseDivisions)||100);
      const distance=camera.position.distanceTo(grid.position);
      const divisions=gridDivisionsForDistance(baseDivisions,distance);
      if(divisions!==(Number(grid.userData?.pstudioGridDivisions)||baseDivisions)){
        const next=new T.GridHelper(baseSize,divisions,0x718093,0x3b4856);
        next.position.copy(grid.position);
        next.userData={...grid.userData,pstudioGridDivisions:divisions};
        gridGroup.remove(grid);disposeGrid(grid);gridGroup.add(next);gridCache.set(key,next);grid=next;
      }
      const farScale=Math.max(1,Math.min(3,distance/240));
      grid.scale.setScalar(farScale);
      const opacity=distance>900?.14:distance>520?.19:distance>280?.25:distance>140?.32:.42;
      for(const material of gridMaterials(grid)){
        material.transparent=true;
        material.opacity=opacity;
        material.depthWrite=false;
        material.toneMapped=false;
      }
    }
  }
  function drawFrame(){
    if(!renderer||!scene||!camera)return;
    if(physicalSky?.visible)physicalSky.position.copy(camera.position);
    updateMoonSkyMesh();
    updateSunSkyMesh();
    updateEditorGridPresentation();
    updateClusteredLighting();
    renderer.info?.reset?.();pollGpuTimerQueries();
    const started=window.performance?.now?.()??Date.now(),gpuQuery=beginGpuTimerQuery();
    const hiddenStaticSky=[];
    try{
      renderWaterDepthPrepass();
      if(volumetricCloudsEnabled)hiddenStaticSky.push(...hideStaticSkyForVolumetrics());
      const solarBloomActive=(qualityPreset==='high'||qualityPreset==='ultra')&&sunGlareStrength>0.01;
      const lunarBloomActive=(qualityPreset==='high'||qualityPreset==='ultra')&&moonGlareStrength>0.01;
      if(composer&&(bloomEnabled||solarBloomActive||lunarBloomActive||ssaoEnabled||ssrEnabled||volumetricFogEnabled||volumetricCloudsEnabled||contactShadowsEnabled||!!taaPass?.enabled||!!smaaPass?.enabled)){
        if(bloomPass){const celestialGlare=Math.max(sunGlareStrength,moonGlareStrength*.72);bloomPass.enabled=bloomEnabled||solarBloomActive||lunarBloomActive;bloomPass.strength=Math.max(bloomEnabled?bloomStrength:0.08,celestialGlare*.72);bloomPass.threshold=Math.max(.62,.84-celestialGlare*.18);}
        if(ssaoPass)ssaoPass.enabled=ssaoEnabled;
        if(ssrPass)ssrPass.enabled=ssrEnabled;
        const syncPostFXUniforms=(pass,required,update)=>{
          if(!pass||!camera)return;
          const uniforms=pass.uniforms;
          const ready=!!uniforms&&required.every(name=>uniforms[name]&&Object.prototype.hasOwnProperty.call(uniforms[name],'value'));
          if(!ready){pass.enabled=false;return;}
          update(uniforms);
        };
        if(volumetricFogPass){
          volumetricFogPass.enabled=volumetricFogEnabled;
          syncPostFXUniforms(volumetricFogPass,['uInverseProjection','uCameraWorld','uTime','uFogColor','tDepth'],u=>{
            u.uInverseProjection.value.copy(camera.projectionMatrixInverse);u.uCameraWorld.value.copy(camera.matrixWorld);u.uTime.value=particleClock;
            if(scene.fog?.color)u.uFogColor.value.copy(scene.fog.color);u.tDepth.value=waterDepthTarget?.depthTexture||null;
          });
        }
        if(contactShadowPass){
          contactShadowPass.enabled=contactShadowsEnabled&&!waterDepthPrepassFailed&&!!waterDepthTarget?.depthTexture;
          syncPostFXUniforms(contactShadowPass,['uInverseProjection','uProjection','uViewMatrix','uLightDirectionWorld','uIntensity','uMaxDistance','uThickness','uDepthBias','uSteps','tDepth'],u=>{
            camera.updateMatrixWorld();
            u.uInverseProjection.value.copy(camera.projectionMatrixInverse);
            u.uProjection.value.copy(camera.projectionMatrix);
            u.uViewMatrix.value.copy(camera.matrixWorldInverse);
            u.tDepth.value=waterDepthTarget?.depthTexture||null;
          });
        }
        if(volumetricCloudPass){
          volumetricCloudPass.enabled=volumetricCloudsEnabled;
          syncPostFXUniforms(volumetricCloudPass,['uInverseProjection','uCameraWorld','uTime','tDepth'],u=>{
            u.uInverseProjection.value.copy(camera.projectionMatrixInverse);u.uCameraWorld.value.copy(camera.matrixWorld);u.uTime.value=particleClock;u.tDepth.value=waterDepthTarget?.depthTexture||null;
          });
        }
        composer.render();
      }else{
        if(ssaoPass)ssaoPass.enabled=false;
        if(ssrPass)ssrPass.enabled=false;if(contactShadowPass)contactShadowPass.enabled=false;
        renderer.render(scene,camera);
      }
    }finally{
      restoreStaticSky(hiddenStaticSky);
      lastRenderDurationMs=Math.max(0,(window.performance?.now?.()??Date.now())-started);
      endGpuTimerQuery(gpuQuery);
      const now=window.performance?.now?.()??Date.now();
      sampleMemoryPressure();
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
  function updateGpuParticleSystems(){
    const ratio=renderer?.getPixelRatio?.()||1;
    const update=system=>{const uniforms=system?.uniforms;if(!uniforms?.uTime||!uniforms?.uPixelRatio)return false;uniforms.uTime.value=particleClock;uniforms.uPixelRatio.value=ratio;return true;};
    for(const emitter of particleEmitters.values())update(emitter?.system);
    for(const effect of particleBursts.values())update(effect?.system);
  }

  function configureWaterMaterial(material,object=null) {
    if(window.PStudioEnvironmentFX?.configureWater)return window.PStudioEnvironmentFX.configureWater(material,object,false);
    const uniforms={uPStudioTime:{value:0},uPStudioWaveAmplitude:{value:0.075}};
    material.onBeforeCompile=shader=>{
      shader.uniforms.uPStudioTime=uniforms.uPStudioTime;
      shader.uniforms.uPStudioWaveAmplitude=uniforms.uPStudioWaveAmplitude;
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nuniform vec4 uPStudioFrustumPlanes[6];\nuniform vec3 uPStudioFrustumCenter;\nuniform float uPStudioFrustumRadius;\nuniform float uPStudioFrustumEnabled;\n');
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
    if(physicalSky)physicalSky.visible=false;
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
    const T=window.THREE,size=Math.max(32,Math.min(128,Math.floor(Number(o.resolution)||(qualityPreset==='ultra'?128:qualityPreset==='high'?96:64))));
    const previous=bakedLightProbeVolume,previousSingle=bakedLightProbe,previousBounces=bakedGIBounces;
    const maxBounces=Math.max(0,Math.min(4,Math.floor(Number(o.bounces??(qualityPreset==='ultra'?3:2)))));
    const bounceStrength=Math.max(0,Math.min(0.8,Number.isFinite(Number(o.bounceStrength))?Number(o.bounceStrength):0.42));
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
      bakedLightProbe=null;finalProbes.pstudioGrid=Object.freeze({min:Object.freeze({x:Number(min.x),y:Number(min.y),z:Number(min.z)}),max:Object.freeze({x:Number(max.x),y:Number(max.y),z:Number(max.z)}),dims:Object.freeze(dims.slice()),layout:'x-fastest'});bakedLightProbeVolume=finalProbes;bakedGIBounces=completedBounces;
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
  function bakeEnvironmentGI(options={}){
    if(!ensureRenderer())throw new Error('The 3D renderer is not available.');
    const T=window.THREE,bounds=new T.Box3();
    if(modelGroup){
      modelGroup.updateMatrixWorld(true);
      modelGroup.traverse(object=>{
        if(!object.isMesh||!object.geometry)return;
        const name=String(object.name||'');
        if(object.userData?.pstudioWaterSurface||/(?:water|waterfall|cascade|foam|spray|sky|cloud|atmosphere|mist|cirrus)/i.test(name))return;
        const objectBounds=new T.Box3().setFromObject(object);
        if(!objectBounds.isEmpty()&&[objectBounds.min.x,objectBounds.min.y,objectBounds.min.z,objectBounds.max.x,objectBounds.max.y,objectBounds.max.z].every(Number.isFinite))bounds.union(objectBounds);
      });
    }
    if(bounds.isEmpty()){bounds.min.set(-12,0,-12);bounds.max.set(12,8,12);}
    const min=options.min||{x:bounds.min.x-1,y:bounds.min.y-0.5,z:bounds.min.z-1};
    const max=options.max||{x:bounds.max.x+1,y:Math.max(bounds.max.y+0.5,min.y+2),z:bounds.max.z+1};
    return bakeLightProbeVolume({
      ...options,
      min,max,
      xCount:options.xCount??4,
      yCount:options.yCount??2,
      zCount:options.zCount??4,
      resolution:options.resolution??(qualityPreset==='ultra'?128:96),
      bounces:options.bounces??(qualityPreset==='ultra'?3:2),
      bounceStrength:options.bounceStrength??0.42
    });
  }
  function updateDirectionalShadowAnchor(target){if(!camera)return;if(csm)return;if(!keyLight?.shadow)return;const sh=keyLight.shadow,extent=Math.min(240,worldRenderConfig.shadowDistance),texel=extent*2/Math.max(1,sh.mapSize.x),x=Math.round(target.x/texel)*texel,z=Math.round(target.z/texel)*texel,anchor=new window.THREE.Vector3(x,target.y,z);keyLight.position.set(x+5,target.y+9,z+6);keyLight.target.position.copy(anchor);keyLight.target.updateMatrixWorld();sh.camera.left=-extent;sh.camera.right=extent;sh.camera.top=extent;sh.camera.bottom=-extent;sh.camera.near=.5;sh.camera.far=extent*3;sh.camera.updateProjectionMatrix();sh.needsUpdate=true;}
  function isWithinWorldDrawDistance(object,maxDistance){
    if(!object||!camera||!window.THREE)return false;
    const T=window.THREE;
    object.updateWorldMatrix?.(true,false);
    const scaleVector=object.getWorldScale?.(new T.Vector3())||new T.Vector3(1,1,1);
    const scale=Math.max(Math.abs(scaleVector.x),Math.abs(scaleVector.y),Math.abs(scaleVector.z),0.001);
    let localCenter=object.userData?.pstudioBoundsCenter||null;
    let radius=Math.max(0,Number(object.userData?.pstudioBoundsRadius)||0);
    if(!localCenter?.isVector3&&object.geometry){
      if(!object.geometry.boundingSphere)object.geometry.computeBoundingSphere?.();
      localCenter=object.geometry.boundingSphere?.center||null;
      if(!radius)radius=Math.max(0,Number(object.geometry.boundingSphere?.radius)||0);
    }
    const center=localCenter?.isVector3
      ?localCenter.clone().applyMatrix4(object.matrixWorld)
      :object.getWorldPosition(new T.Vector3());
    const cameraPosition=camera.getWorldPosition(new T.Vector3());
    const edgeDistance=Math.max(0,cameraPosition.distanceTo(center)-radius*scale);
    return edgeDistance<=Math.max(0,Number(maxDistance)||0);
  }
  function getOcclusionOwner(hit){return hit?.object?.userData?.instanceOwnerIds?.[hit.instanceId]??hit?.object?.userData?.ownerId??null;}
  function updateOcclusionVisibility(){
    if(!occlusionEnabled||!occlusionRaycaster||!camera)return;
    const hasHighComplexityModel=[...modelInstances.values()].some(instance=>instance.occlusionEligible===false&&isOwnerChunkActive(instance.ownerId));
    if(hasHighComplexityModel){
      for(const mesh of meshCache.values()){
        const active=isOwnerChunkActive(mesh.userData.ownerId)&&isWithinWorldDrawDistance(mesh,worldRenderConfig.maxDrawDistance);
        mesh.userData.pstudioOccluded=false;mesh.visible=active;
      }
      for(const batch of instancedBatches.values())for(const source of batch.userData.instanceSources||[])source.mesh.userData.pstudioOccluded=false;
      for(const instance of modelInstances.values())if(instance.occlusionEligible===false){
        const active=isOwnerChunkActive(instance.ownerId)&&isWithinWorldDrawDistance(instance.root,worldRenderConfig.maxDrawDistance);
        instance.root.userData.pstudioOccluded=false;instance.root.visible=!instance.preparing&&active;
      }
      occlusionCursor=0;return;
    }
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
  function modelCameraDistance(instance){
    if(!camera||!instance?.root)return Infinity;
    const T=window.THREE;
    instance.root.updateWorldMatrix(true,false);
    const center=(instance.localBoundsCenter?.clone?.()||new T.Vector3()).applyMatrix4(instance.root.matrixWorld);
    const scale=instance.root.getWorldScale(new T.Vector3());
    const radius=Math.max(0,Number(instance.root.userData?.pstudioBoundsRadius)||0)*Math.max(Math.abs(scale.x),Math.abs(scale.y),Math.abs(scale.z));
    return Math.max(0,camera.position.distanceTo(center)-radius*0.2);
  }
  function objectCameraDistance(object){
    if(!camera||!object)return Infinity;
    const T=window.THREE;object.updateWorldMatrix(true,false);
    if(object.isInstancedMesh){
      if(!object.boundingSphere)object.computeBoundingSphere?.();
      const sphere=object.boundingSphere;
      if(sphere){
        const center=sphere.center.clone().applyMatrix4(object.matrixWorld);
        const scale=object.getWorldScale(new T.Vector3());
        const radius=Math.max(0,Number(sphere.radius)||0)*Math.max(Math.abs(scale.x),Math.abs(scale.y),Math.abs(scale.z));
        return Math.max(0,camera.position.distanceTo(center)-radius*0.2);
      }
    }
    const geometry=object.geometry;
    if(!geometry?.boundingSphere)geometry?.computeBoundingSphere?.();
    const center=geometry?.boundingSphere?.center?.clone?.()||new T.Vector3();
    center.applyMatrix4(object.matrixWorld);
    const scale=object.getWorldScale(new T.Vector3());
    const radius=Math.max(0,Number(geometry?.boundingSphere?.radius)||0)*Math.max(Math.abs(scale.x),Math.abs(scale.y),Math.abs(scale.z));
    return Math.max(0,camera.position.distanceTo(center)-radius*0.2);
  }
  function updateModelLOD(instance){
    if(!instance?.root||!camera)return;
    const distance=modelCameraDistance(instance);
    const updateBatchedAutoLOD=()=>{
      for(const entry of instance.foliageBatches||[]){
        if(entry.isTree&&Number.isInteger(entry.level)&&instance.activeLOD!==null)continue;
        if(!entry.isTree&&entry.mesh.userData.pstudioAutoLOD?.length>1)applyAutoLOD(entry.mesh,objectCameraDistance(entry.mesh));
      }
    };
    if(instance.lodLevels?.length>1){
      const lodScale=qualityPreset==='mobile'?0.62:qualityPreset==='balanced'?0.82:(adaptiveQualityEnabled?[0.62,0.82,1.0][adaptiveQualityLevel]:1.0);
      const distances=worldRenderConfig.lodDistances.map(value=>value*lodScale);
      const index=distances.findIndex(value=>distance<value);
      const selected=instance.lodLevels[Math.min(index<0?distances.length:index,instance.lodLevels.length-1)];
      if(instance.activeLOD!==selected.level){
        for(const level of instance.lodLevels)for(const entry of level.entries)entry.object.visible=level.level===selected.level&&entry.visible;
        instance.activeLOD=selected.level;
      }
      for(const entry of instance.foliageBatches||[])if(entry.isTree&&Number.isInteger(entry.level))entry.mesh.visible=entry.level===selected.level;
      updateBatchedAutoLOD();
      return;
    }
    for(const object of instance.meshes||[])if(!object.userData.pstudioBatchedIntoStaticInstance&&object.userData.pstudioAutoLOD?.length>1)applyAutoLOD(object,objectCameraDistance(object));
    updateBatchedAutoLOD();
  }
  function enableGPUFrustumCullingForBatch(batch){
    if(!batch?.isInstancedMesh||batch.userData?.pstudioGPUFrustumConfigured)return false;
    const T=window.THREE,oldMaterial=batch.material;
    if(!oldMaterial||Array.isArray(oldMaterial))return false;
    const material=oldMaterial.clone();
    const previousCompile=material.onBeforeCompile;
    const previousKey=material.customProgramCacheKey?.bind(material);
    if(!batch.geometry.boundingSphere)batch.geometry.computeBoundingSphere?.();
    const uniforms={
      planes:Array.from({length:6},()=>new T.Vector4()),
      center:{value:batch.geometry.boundingSphere?.center?.clone?.()||new T.Vector3()},
      radius:{value:Number(batch.geometry.boundingSphere?.radius)||0},
      enabled:{value:gpuInstanceFrustumCullingEnabled?1:0}
    };
    material.onBeforeCompile=function(shader,rendererRef){
      if(typeof previousCompile==='function')previousCompile.call(this,shader,rendererRef);
      shader.uniforms.uPStudioFrustumPlanes={value:uniforms.planes};
      shader.uniforms.uPStudioFrustumCenter=uniforms.center;
      shader.uniforms.uPStudioFrustumRadius=uniforms.radius;
      shader.uniforms.uPStudioFrustumEnabled=uniforms.enabled;
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nuniform vec4 uPStudioFrustumPlanes[6];\nuniform vec3 uPStudioFrustumCenter;\nuniform float uPStudioFrustumRadius;\nuniform float uPStudioFrustumEnabled;\n');
      const cullingCode='#include <project_vertex>\n#ifdef USE_INSTANCING\nif(uPStudioFrustumEnabled>0.5){\n  mat4 pstudioWorldInstance=modelMatrix*instanceMatrix;\n  vec3 pstudioWorldCenter=(pstudioWorldInstance*vec4(uPStudioFrustumCenter,1.0)).xyz;\n  float pstudioWorldScale=max(length(pstudioWorldInstance[0].xyz),max(length(pstudioWorldInstance[1].xyz),length(pstudioWorldInstance[2].xyz)));\n  float pstudioWorldRadius=uPStudioFrustumRadius*pstudioWorldScale;\n  bool pstudioInsideFrustum=true;\n  for(int pstudioPlane=0;pstudioPlane<6;pstudioPlane++){\n    if(dot(uPStudioFrustumPlanes[pstudioPlane].xyz,pstudioWorldCenter)+uPStudioFrustumPlanes[pstudioPlane].w < -pstudioWorldRadius){pstudioInsideFrustum=false;}\n  }\n  if(!pstudioInsideFrustum)gl_Position=vec4(2.0,2.0,2.0,1.0);\n}\n#endif\n';
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',cullingCode);
    };
    material.customProgramCacheKey=function(){return(previousKey?previousKey():'')+'|pstudio-gpu-instance-frustum-v1';};
    material.userData.pstudioGPUFrustumUniforms=uniforms;
    batch.material=material;
    batch.userData.pstudioGPUFrustumConfigured=true;
    return true;
  }
  function updateGPUInstanceFrustumPlanes(){
    const update=batch=>{
      const uniforms=batch?.material?.userData?.pstudioGPUFrustumUniforms;
      if(!uniforms?.enabled||!Object.prototype.hasOwnProperty.call(uniforms.enabled,'value')||!Array.isArray(uniforms.planes)||uniforms.planes.length<6)return;
      uniforms.enabled.value=gpuInstanceFrustumCullingEnabled?1:0;
      if(worldFrustum)for(let i=0;i<6;i++)uniforms.planes[i]?.copy?.(worldFrustum.planes[i]);
    };
    for(const batch of instancedBatches.values())update(batch);
    for(const instance of modelInstances.values())for(const entry of instance.foliageBatches||[])update(entry.mesh);
  }

  function createClusterDataTexture(data,width,height,name){
    const T=window.THREE,texture=new T.DataTexture(data,width,height,T.RGBAFormat,T.FloatType);
    texture.name=name;texture.magFilter=T.NearestFilter;texture.minFilter=T.NearestFilter;
    texture.generateMipmaps=false;texture.flipY=false;texture.unpackAlignment=1;
    texture.colorSpace=T.NoColorSpace;texture.needsUpdate=true;return texture;
  }
  function ensureClusteredLightingResources(){
    if(clusteredLightingResources)return clusteredLightingResources;
    if(!renderer||!renderer.capabilities?.isWebGL2)return null;
    const clusterCount=CLUSTER_GRID_X*CLUSTER_GRID_Y*CLUSTER_GRID_Z,indexWidth=CLUSTER_MAX_PER_CELL+1;
    const lightData=new Float32Array(3*CLUSTER_MAX_LIGHTS*4),clusterData=new Float32Array(indexWidth*clusterCount*4);
    let lightTexture=null,clusterTexture=null;
    try{
      lightTexture=createClusterDataTexture(lightData,3,CLUSTER_MAX_LIGHTS,'PStudio_Clustered_PointLight_Data');
      clusterTexture=createClusterDataTexture(clusterData,indexWidth,clusterCount,'PStudio_Clustered_Light_Lists');
      renderer.initTexture(lightTexture);renderer.initTexture(clusterTexture);
    }catch(error){
      lightTexture?.dispose?.();clusterTexture?.dispose?.();
      console.warn('[PStudio] Clustered lighting float textures are unavailable; native point lights remain enabled.',error);
      return null;
    }
    clusteredLightingResources={lightData,clusterData,lightTexture,clusterTexture,clusterCount,indexWidth,lightCount:0,bytes:lightData.byteLength+clusterData.byteLength};
    return clusteredLightingResources;
  }
  function setupClusteredLightingMaterial(material){
    if(!material||material.userData?.pstudioClusterLightingSetup)return false;
    if(!material.isMeshStandardMaterial&&!material.isMeshPhysicalMaterial)return false;
    const resources=ensureClusteredLightingResources();if(!resources)return false;
    const previousCompile=material.onBeforeCompile,previousKey=material.customProgramCacheKey?.bind(material);
    const uniforms={
      lights:resources.lightTexture,clusters:resources.clusterTexture,
      viewport:new window.THREE.Vector2(1,1),
      grid:new window.THREE.Vector3(CLUSTER_GRID_X,CLUSTER_GRID_Y,CLUSTER_GRID_Z),
      near:{value:camera?.near||0.1},far:{value:camera?.far||worldRenderConfig.maxDrawDistance},enabled:{value:clusteredLightingEnabled?1:0}
    };
    material.onBeforeCompile=function(shader,rendererRef){
      if(typeof previousCompile==='function')previousCompile.call(this,shader,rendererRef);
      shader.uniforms.uPStudioClusterLights={value:uniforms.lights};
      shader.uniforms.uPStudioClusterIndices={value:uniforms.clusters};
      shader.uniforms.uPStudioClusterViewport={value:uniforms.viewport};
      shader.uniforms.uPStudioClusterGrid={value:uniforms.grid};
      shader.uniforms.uPStudioClusterNear=uniforms.near;
      shader.uniforms.uPStudioClusterFar=uniforms.far;
      shader.uniforms.uPStudioClusterEnabled=uniforms.enabled;
      const declarations=[
        'uniform sampler2D uPStudioClusterLights;',
        'uniform sampler2D uPStudioClusterIndices;',
        'uniform vec2 uPStudioClusterViewport;',
        'uniform vec3 uPStudioClusterGrid;',
        'uniform float uPStudioClusterNear;',
        'uniform float uPStudioClusterFar;',
        'uniform float uPStudioClusterEnabled;'
      ].join('\n');
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+declarations);
      const lighting=[
        'if(uPStudioClusterEnabled>0.5){',
        '  float pstudioDepth=max(uPStudioClusterNear,-vViewPosition.z);',
        '  float pstudioLogRange=max(0.0001,log(uPStudioClusterFar/uPStudioClusterNear));',
        '  vec2 pstudioTile=clamp(floor(gl_FragCoord.xy/uPStudioClusterViewport*uPStudioClusterGrid.xy),vec2(0.0),uPStudioClusterGrid.xy-vec2(1.0));',
        '  float pstudioSlice=clamp(floor(log(pstudioDepth/uPStudioClusterNear)/pstudioLogRange*uPStudioClusterGrid.z),0.0,uPStudioClusterGrid.z-1.0);',
        '  float pstudioCluster=(pstudioSlice*uPStudioClusterGrid.y+pstudioTile.y)*uPStudioClusterGrid.x+pstudioTile.x;',
        '  float pstudioClusterV=(pstudioCluster+0.5)/(uPStudioClusterGrid.x*uPStudioClusterGrid.y*uPStudioClusterGrid.z);',
        '  float pstudioLightCount=floor(texture2D(uPStudioClusterIndices,vec2(0.5/25.0,pstudioClusterV)).r+0.5);',
        '  for(int pstudioLightSlot=0;pstudioLightSlot<24;pstudioLightSlot++){',
        '    if(float(pstudioLightSlot)>=pstudioLightCount)break;',
        '    float pstudioLightIndex=floor(texture2D(uPStudioClusterIndices,vec2((float(pstudioLightSlot)+1.5)/25.0,pstudioClusterV)).r+0.5);',
        '    float pstudioLightV=(pstudioLightIndex+0.5)/96.0;',
        '    vec4 pstudioLightPositionRange=texture2D(uPStudioClusterLights,vec2(0.5/3.0,pstudioLightV));',
        '    vec4 pstudioLightColorIntensity=texture2D(uPStudioClusterLights,vec2(1.5/3.0,pstudioLightV));',
        '    vec4 pstudioLightDecay=texture2D(uPStudioClusterLights,vec2(2.5/3.0,pstudioLightV));',
        '    vec3 pstudioLightVector=pstudioLightPositionRange.xyz-geometryPosition;',
        '    float pstudioLightDistance=length(pstudioLightVector);',
        '    vec3 pstudioLightDirection=pstudioLightVector/max(0.0001,pstudioLightDistance);',
        '    float pstudioLightAttenuation=getDistanceAttenuation(pstudioLightDistance,pstudioLightPositionRange.w,pstudioLightDecay.r);',
        '    float pstudioNdotL=max(dot(normalize(geometryNormal),pstudioLightDirection),0.0);',
        '    vec3 pstudioIncident=pstudioLightColorIntensity.rgb*pstudioLightColorIntensity.a*pstudioLightAttenuation;',
        '    reflectedLight.directDiffuse+=pstudioIncident*pstudioNdotL*BRDF_Lambert(diffuseColor.rgb);',
        '  }',
        '}'
      ].join('\n');
      shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>','#include <lights_fragment_begin>\n'+lighting);
    };
    material.customProgramCacheKey=function(){return(previousKey?previousKey():'')+'|pstudio-clustered-forward-v1';};
    material.userData.pstudioClusterLightingSetup=true;
    material.userData.pstudioClusterLightingUniforms=uniforms;
    return true;
  }
  function clusteredDepthSlice(depth,near,far){
    return Math.max(0,Math.min(CLUSTER_GRID_Z-1,Math.floor(Math.log(Math.max(near,Math.min(far,depth))/near)/Math.log(far/near)*CLUSTER_GRID_Z)));
  }
  function updateClusteredLighting(force=false){
    const resources=ensureClusteredLightingResources();
    if(!resources||!camera){
      clusteredLightingActive=false;clusteredLightSet.clear();
      for(const light of dynamicLights.values())if(light.isPointLight)light.visible=true;
      return false;
    }
    const now=window.performance?.now?.()??Date.now();
    camera.updateMatrixWorld(true);
    const T=window.THREE,lights=[],signatureParts=[];
    for(const light of dynamicLights.values()){
      if(!light.isPointLight)continue;
      light.updateWorldMatrix(true,false);
      const position=light.getWorldPosition(new T.Vector3()).applyMatrix4(camera.matrixWorldInverse);
      const range=Math.max(camera.near,Number(light.distance)||worldRenderConfig.maxDrawDistance);
      const color=light.color;
      signatureParts.push(
        Number(position.x.toFixed(2)),Number(position.y.toFixed(2)),Number(position.z.toFixed(2)),
        Number(range.toFixed(2)),Number(light.intensity.toFixed(2)),
        Number(color.r.toFixed(2)),Number(color.g.toFixed(2)),Number(color.b.toFixed(2))
      );
      if(light.intensity>0&&lights.length<CLUSTER_MAX_LIGHTS)lights.push({light,position,range});
    }
    const signature=signatureParts.join('|')+'|'+[
      Number(camera.position.x.toFixed(2)),Number(camera.position.y.toFixed(2)),Number(camera.position.z.toFixed(2)),
      Number(camera.quaternion.x.toFixed(3)),Number(camera.quaternion.y.toFixed(3)),
      Number(camera.quaternion.z.toFixed(3)),Number(camera.quaternion.w.toFixed(3))
    ].join(',');
    if(!force&&now-clusteredLightingLastUpdate<100&&signature===clusteredLightingLastSignature){
      clusteredLightingActive=clusteredLightingEnabled;
      for(const light of dynamicLights.values())if(light.isPointLight)light.visible=!(clusteredLightingActive&&clusteredLightSet.has(light));
      return clusteredLightingActive;
    }
    clusteredLightingLastUpdate=now;clusteredLightingLastSignature=signature;
    const near=Math.max(0.001,camera.near),far=Math.max(near*1.01,Math.min(camera.far||worldRenderConfig.maxDrawDistance,worldRenderConfig.maxDrawDistance*2));
    resources.lightData.fill(0);resources.clusterData.fill(0);
    const counts=new Uint8Array(resources.clusterCount),width=resources.indexWidth;
    const projection=camera.projectionMatrix.elements;
    const clusterPush=(x,y,z,index)=>{
      const cluster=(z*CLUSTER_GRID_Y+y)*CLUSTER_GRID_X+x,count=counts[cluster];
      resources.clusterData[(cluster*width+count+1)*4]=index;
      counts[cluster]=count+1;
    };
    resources.lightCount=lights.length;
    clusteredLightSet=new Set();
    for(let index=0;index<lights.length;index++){
      const entry=lights[index],light=entry.light,position=entry.position,depth=-position.z,range=entry.range,base=index*12;
      resources.lightData[base]=position.x;resources.lightData[base+1]=position.y;resources.lightData[base+2]=position.z;resources.lightData[base+3]=range;
      resources.lightData[base+4]=light.color.r;resources.lightData[base+5]=light.color.g;resources.lightData[base+6]=light.color.b;resources.lightData[base+7]=Math.max(0,light.intensity);
      resources.lightData[base+8]=Math.max(0.01,Number(light.decay)||2);
      if(depth+range<near||depth-range>far)continue;
      let minX=0,maxX=CLUSTER_GRID_X-1,minY=0,maxY=CLUSTER_GRID_Y-1;
      if(depth-range>near){
        const clipW=-position.z;
        if(clipW>0){
          const centerX=(position.x*projection[0])/clipW,centerY=(position.y*projection[5])/clipW;
          const radiusX=Math.abs(projection[0]*range/Math.max(near,depth-range)),radiusY=Math.abs(projection[5]*range/Math.max(near,depth-range));
          minX=Math.max(0,Math.floor(((centerX-radiusX)*0.5+0.5)*CLUSTER_GRID_X));
          maxX=Math.min(CLUSTER_GRID_X-1,Math.floor(((centerX+radiusX)*0.5+0.5)*CLUSTER_GRID_X));
          minY=Math.max(0,Math.floor(((centerY-radiusY)*0.5+0.5)*CLUSTER_GRID_Y));
          maxY=Math.min(CLUSTER_GRID_Y-1,Math.floor(((centerY+radiusY)*0.5+0.5)*CLUSTER_GRID_Y));
          if(maxX<minX||maxY<minY)continue;
        }
      }
      const minZ=clusteredDepthSlice(Math.max(near,depth-range),near,far),maxZ=clusteredDepthSlice(Math.min(far,depth+range),near,far);
      let fitsEveryCluster=true;
      for(let z=minZ;z<=maxZ&&fitsEveryCluster;z++)for(let y=minY;y<=maxY&&fitsEveryCluster;y++)for(let x=minX;x<=maxX;x++){
        const cluster=(z*CLUSTER_GRID_Y+y)*CLUSTER_GRID_X+x;
        if(counts[cluster]>=CLUSTER_MAX_PER_CELL){fitsEveryCluster=false;break;}
      }
      // Keep an overflowing light in Three.js' native path rather than silently dropping it.
      if(!fitsEveryCluster)continue;
      clusteredLightSet.add(light);
      for(let z=minZ;z<=maxZ;z++)for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)clusterPush(x,y,z,index);
    }
    for(let cluster=0;cluster<resources.clusterCount;cluster++)resources.clusterData[(cluster*width)*4]=counts[cluster];
    resources.lightTexture.needsUpdate=true;resources.clusterTexture.needsUpdate=true;
    const viewport=renderer.getDrawingBufferSize(new T.Vector2());
    const active=clusteredLightingEnabled;
    clusteredLightingActive=active;
    for(const light of dynamicLights.values())if(light.isPointLight)light.visible=!(active&&clusteredLightSet.has(light));
    const updateMaterial=material=>{
      const uniforms=material?.userData?.pstudioClusterLightingUniforms;
      if(!uniforms?.viewport?.set||!uniforms.near||!uniforms.far||!uniforms.enabled||
        !['near','far','enabled'].every(key=>Object.prototype.hasOwnProperty.call(uniforms[key],'value')))return;
      uniforms.viewport.set(viewport.x,viewport.y);uniforms.near.value=near;uniforms.far.value=far;uniforms.enabled.value=active?1:0;
    };
    for(const instance of modelInstances.values())for(const material of instance.materialDefaults.keys())updateMaterial(material);
    for(const mesh of meshCache.values())updateMaterial(mesh.material);
    clusteredLightingUpdatedClusters=counts.reduce((sum,count)=>sum+(count>0?1:0),0);
    return active;
  }

  function updateWorldVisibility(){
    if(!camera)return;updateWorldChunkStates();const max=worldRenderConfig.maxDrawDistance,T=window.THREE;
    if(!worldFrustum){worldFrustum=new T.Frustum();worldFrustumMatrix=new T.Matrix4();worldFrustumSphere=new T.Sphere();}
    camera.updateMatrixWorld(true);
    worldFrustumMatrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    worldFrustum.setFromProjectionMatrix(worldFrustumMatrix);
    updateGPUInstanceFrustumPlanes();
    for(const mesh of meshCache.values()){const active=isOwnerChunkActive(mesh.userData.ownerId)&&isWithinWorldDrawDistance(mesh,max);mesh.visible=active&&!mesh.userData.pstudioOccluded;if(active)applyAutoLOD(mesh,objectCameraDistance(mesh));}
    for(const instance of modelInstances.values()){
      const active=isOwnerChunkActive(instance.ownerId)&&isWithinWorldDrawDistance(instance.root,max);
      const isSelected=String(instance.ownerId)===String(selectedOwnerId);
      instance.root.visible=!instance.preparing&&active&&(isSelected||instance.occlusionEligible===false||!instance.root.userData.pstudioOccluded);
      if(!active)continue;
      updateModelStreamingChunks(instance);
      updateModelLOD(instance);
      requestVisibleVirtualTextureTiles(instance);
    }
    updateOcclusionVisibility();
    for(const batch of instancedBatches.values()){
      const sources=batch.userData.instanceSources||[],dummy=new T.Object3D(),owners=[],keys=[];let count=0;
      for(const source of sources){
        const mesh=source.mesh;
        if(!isWithinWorldDrawDistance(mesh,max)||!isOwnerChunkActive(mesh.userData.ownerId)||mesh.userData.pstudioOccluded)continue;
        dummy.position.copy(mesh.position);dummy.quaternion.copy(mesh.quaternion);dummy.scale.copy(mesh.scale);dummy.updateMatrix();
        batch.setMatrixAt(count,dummy.matrix);owners[count]=mesh.userData.ownerId;keys[count]=source.sourceKey;count++;
      }
      batch.count=count;batch.userData.instanceOwnerIds=owners;batch.userData.instanceSourceKeys=keys;
      batch.instanceMatrix.needsUpdate=true;batch.visible=count>0;if(count)batch.computeBoundingSphere();
    }
    updateProbeVolumeBlend();updateDirectionalShadowAnchor(new window.THREE.Vector3(cameraTarget[0],cameraTarget[1],cameraTarget[2]));
  }

  function frameCameraToModel(instance){
    if(!instance?.root||!camera||!window.THREE)return false;
    const T=window.THREE;
    instance.root.updateMatrixWorld(true);
    const localCenter=instance.localBoundsCenter?.isVector3?instance.localBoundsCenter:instance.root.userData?.pstudioBoundsCenter;
    let center,radius;
    if(localCenter?.isVector3){
      center=localCenter.clone().applyMatrix4(instance.root.matrixWorld);
      const worldScale=instance.root.getWorldScale(new T.Vector3());
      radius=Math.max(0.25,Number(instance.root.userData?.pstudioBoundsRadius)||0.25)*
        Math.max(Math.abs(worldScale.x),Math.abs(worldScale.y),Math.abs(worldScale.z));
    }else{
      const bounds=new T.Box3().setFromObject(instance.root);
      if(bounds.isEmpty())return false;
      const sphere=bounds.getBoundingSphere(new T.Sphere());
      center=sphere.center;
      radius=Number.isFinite(sphere.radius)?Math.max(0.25,sphere.radius):0.25;
    }
    const oldTarget=new T.Vector3(cameraTarget[0],cameraTarget[1],cameraTarget[2]);
    const direction=new T.Vector3(cameraBase[0],cameraBase[1],cameraBase[2]).sub(oldTarget);
    if(direction.lengthSq()<1e-8)direction.set(6,5,8);
    direction.normalize();
    const verticalFov=(camera.fov||55)*Math.PI/180;
    const horizontalFov=2*Math.atan(Math.tan(verticalFov/2)*Math.max(0.1,camera.aspect||1));
    const limitingFov=Math.max(0.12,Math.min(verticalFov,horizontalFov));
    const distance=Math.max(0.75,(radius/Math.sin(limitingFov/2))*1.16);
    cameraTarget=[center.x,center.y,center.z];
    cameraBase=[center.x+direction.x*distance,center.y+direction.y*distance,center.z+direction.z*distance];
    cameraFocusOwnerId=String(instance.ownerId);
    cameraPan?.set(0,0,0);
    zoom=1;updateCameraZoomReadout();
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
    const collisionTargets=[primitiveGroup];
    for(const child of modelGroup.children){
      if(child.userData?.pstudioHighComplexity)continue;
      child.updateWorldMatrix(true,true);
      collisionTargets.push(child);
    }
    cameraCollisionRaycaster.set(target,direction);
    cameraCollisionRaycaster.near=0.04;
    cameraCollisionRaycaster.far=distance;
    const hits=cameraCollisionRaycaster.intersectObjects(collisionTargets,true);
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
    orbitPitch=clampEditorOrbitPitch(orbitPitch);
    const target = new T.Vector3(cameraTarget[0], cameraTarget[1], cameraTarget[2]).add(cameraPan || new T.Vector3());
    const offset = new T.Vector3(cameraBase[0], cameraBase[1], cameraBase[2]).sub(target).multiplyScalar(zoom);
    const worldUp=new T.Vector3(0,1,0);
    offset.applyAxisAngle(worldUp,orbitYaw);
    if(window.PStudioEngine?.isRunning?.()){
      // Keep the established gameplay camera rotation path unchanged.
      const right=new T.Vector3(1,0,0).applyAxisAngle(worldUp,orbitYaw);
      offset.applyAxisAngle(right,orbitPitch);
    }else{
      // Editor orbit uses spherical coordinates so the camera can reach both vertical poles.
      const baseElevation=Math.atan2(offset.y,Math.max(1e-6,Math.hypot(offset.x,offset.z)));
      const azimuth=Math.atan2(offset.x,offset.z);
      const radius=offset.length();
      const elevation=baseElevation-orbitPitch;
      const horizontal=radius*Math.cos(elevation);
      offset.set(Math.sin(azimuth)*horizontal,Math.sin(elevation)*radius,Math.cos(azimuth)*horizontal);
    }
    const desiredPosition = target.clone().add(offset);
    const desiredDistance=desiredPosition.distanceTo(target);
    const requiredFar=Math.max(1600,Math.min(1000000,desiredDistance+worldRenderConfig.maxDrawDistance+64));
    if(Math.abs(camera.far-requiredFar)>Math.max(1,camera.far*0.02)){camera.far=requiredFar;camera.updateProjectionMatrix();}
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
    for(const instance of modelInstances.values())updateModelLOD(instance);
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
    const complexInstance=[...modelInstances.values()].find(instance=>String(instance.ownerId)===String(selectedOwnerId)&&instance.occlusionEligible===false);
    if(complexInstance){
      complexInstance.root.updateMatrixWorld(true);
      const bounds=new T.Box3().setFromObject(complexInstance.root);
      if(bounds.isEmpty()){disposeGroup(selectionGroup);selectionSignature='';return;}
      const signature=String(selectedOwnerId)+':bounds:'+complexInstance.root.uuid;
      let helper=selectionGroup.children.find(child=>child.userData?.pstudioBoundsSelectionHelper);
      if(signature!==selectionSignature||!helper){
        disposeGroup(selectionGroup);
        helper=new T.Box3Helper(bounds,0xffffff);
        helper.material.depthTest=false;helper.renderOrder=10;
        helper.userData.isSelectionOutline=true;helper.userData.pstudioBoundsSelectionHelper=true;
        selectionGroup.add(helper);selectionSignature=signature;
      }else{helper.box.copy(bounds);helper.updateMatrixWorld(true);}
      return;
    }
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
        enableGPUFrustumCullingForBatch(batch);
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
    if (mesh.material) {
      const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
      for(const material of materials){waterMaterials.delete(material);window.PStudioEnvironmentFX?.releaseMaterial?.(material);material?.dispose?.();}
      mesh.material=null;
    }
    mesh.userData.pstudioLODToken=(mesh.userData.pstudioLODToken||0)+1;
    const lods=mesh.userData.pstudioAutoLOD||[];
    if(lods.length){for(const level of lods)if(level.owned){level.geometry.userData.pstudioBVHDisposed=true;level.geometry.userData.pstudioBVHToken=(level.geometry.userData.pstudioBVHToken||0)+1;level.geometry.disposeBoundsTree?.();level.geometry.dispose?.();}if(!lightmapped&&!mesh.userData.pstudioLightmapOriginalGeometryOwned){lods[0]?.geometry?.disposeBoundsTree?.();lods[0]?.geometry?.dispose?.();}}
    else if(!lightmapped)currentGeometry?.dispose?.();
    mesh.getRenderTarget?.()?.dispose?.();
  }

  function disposeModelAsset(asset) {
    if(!asset?.scene)return;
    if(asset.assetKey)releaseVirtualTexturesForAsset(asset.assetKey);
    const geometries=new Set(),ownedLODs=new Set(),materials=new Set(),textures=new Set(),imageBitmaps=new Set();
    asset.scene.traverse(object=>{
      if(!object.isMesh)return;
      if(object.geometry){
        object.geometry.userData=object.geometry.userData||{};
        object.geometry.userData.pstudioBVHDisposed=true;
        object.geometry.userData.pstudioBVHToken=(object.geometry.userData.pstudioBVHToken||0)+1;
        object.geometry.userData.pstudioLODDisposed=true;
        object.geometry.userData.pstudioLODToken=(object.geometry.userData.pstudioLODToken||0)+1;
        for(const level of object.geometry.userData.pstudioAutoLODLevels||[])if(level?.owned&&level.geometry)ownedLODs.add(level.geometry);
        object.geometry.disposeBoundsTree?.();
        geometries.add(object.geometry);
      }
      for(const material of (Array.isArray(object.material)?object.material:[object.material]))if(material)materials.add(material);
    });
    materials.forEach(material=>{
      for(const value of Object.values(material))if(value?.isTexture){
        textures.add(value);
        const image=value.source?.data??value.image;
        if(typeof ImageBitmap!=='undefined'&&image instanceof ImageBitmap)imageBitmaps.add(image);
      }
    });
    geometries.forEach(geometry=>geometry.dispose());
    for(const geometry of ownedLODs){
      geometry.userData=geometry.userData||{};
      geometry.userData.pstudioBVHDisposed=true;
      geometry.userData.pstudioBVHToken=(geometry.userData.pstudioBVHToken||0)+1;
      geometry.disposeBoundsTree?.();
      geometry.dispose?.();
    }
    textures.forEach(texture=>texture.dispose());
    materials.forEach(material=>material.dispose());
    imageBitmaps.forEach(bitmap=>{try{bitmap.close();}catch(_){}});
  }

  function deviceMemoryGiB(){
    const value=Number(window.navigator?.deviceMemory);
    return Number.isFinite(value)&&value>0?Math.max(1,Math.min(16,value)):4;
  }
  function modelRuntimeBudgetBytes(){
    return Math.floor(deviceMemoryGiB()*1024*1024*1024*0.58);
  }
  function modelCpuHeapBudgetBytes(){
    const jsHeapLimit=Number(window.performance?.memory?.jsHeapSizeLimit)||0;
    const deviceBudget=deviceMemoryGiB()*1024*1024*1024*.25;
    return Math.floor(jsHeapLimit>0?Math.min(deviceBudget,jsHeapLimit*.72):deviceBudget);
  }
  function dispatchModelLoadProgress(detail){
    try{window.dispatchEvent(new CustomEvent('pstudio-model-load-progress',{detail}));}catch(_){}
    try{window.PStudioEvents?.emit?.('model.load.progress',detail);}catch(_){}
  }
  function dispatchModelLoadError(detail){
    const payload={name:String(detail?.name||''),stage:String(detail?.stage||'unknown'),error:String(detail?.error||'Unknown model loading error.'),stack:String(detail?.stack||'').slice(0,5000),retryable:detail?.retryable!==false};
    try{window.dispatchEvent(new CustomEvent('pstudio-model-error',{detail:payload}));}catch(_){}
    try{window.PStudioEvents?.emit?.('model.load.error',payload);}catch(_){}
    return payload;
  }
  function disposeWorkerPacket(packet){
    const closed=new Set();
    for(const image of packet?.images||[]){
      const bitmap=image?.bitmap;
      if(!bitmap||closed.has(bitmap))continue;
      closed.add(bitmap);
      try{bitmap.close?.();}catch(_){}
    }
  }

  function getGLTFWorker(){
    if(typeof window.Worker!=='function')return null;
    if(gltfWorker)return gltfWorker;
    try{
      const worker=new window.Worker('/static/pstudio_gltf_worker.js',{type:'module',name:'PStudio-GLTF-Parser'});
      worker.onmessage=event=>{
        const message=event.data||{};
        const pending=gltfWorkerPending.get(message.id);
        if(!pending)return;
        if(message.progress){pending.onProgress?.(message.progress);return;}
        gltfWorkerPending.delete(message.id);
        if(message.ok)pending.resolve(message.result);
        else{
          const error=new Error(String(message.error||'Worker GLTF parsing failed.'));
          error.code=String(message.code||'');
          pending.reject(error);
        }
      };
      worker.onerror=event=>{
        const error=new Error(event?.message||'GLTF parsing Worker failed to load.');
        error.code='PSTUDIO_WORKER_UNAVAILABLE';
        for(const pending of gltfWorkerPending.values())pending.reject(error);
        gltfWorkerPending.clear();
        if(gltfWorker===worker)gltfWorker=null;
        try{worker.terminate();}catch(_){}
      };
      worker.onmessageerror=()=>{
        const error=new Error('GLTF Worker returned a message that could not be deserialized.');
        error.code='PSTUDIO_WORKER_TRANSPORT';
        for(const pending of gltfWorkerPending.values())pending.reject(error);
        gltfWorkerPending.clear();
      };
      gltfWorker=worker;
      return worker;
    }catch(error){
      console.warn('[PStudio] GLTF worker is unavailable; main-thread parser fallback will be used.',error);
      return null;
    }
  }
  function getWorkerTextureSupport(){
    const has=name=>{try{return !!renderer?.extensions?.has?.(name);}catch(_){return false;}};
    return{
      webgl2:!!renderer?.capabilities?.isWebGL2,
      astc:has('WEBGL_compressed_texture_astc'),
      etc1:has('WEBGL_compressed_texture_etc1'),
      etc2:has('WEBGL_compressed_texture_etc'),
      dxt:has('WEBGL_compressed_texture_s3tc'),
      bptc:has('EXT_texture_compression_bptc'),
      pvrtc:has('WEBGL_compressed_texture_pvrtc')||has('WEBKIT_WEBGL_compressed_texture_pvrtc')
    };
  }
  async function parseGLBInWorker(blob,name){
    const worker=getGLTFWorker();
    if(!worker){const error=new Error('GLTF parsing Worker is unavailable.');error.code='PSTUDIO_WORKER_UNAVAILABLE';throw error;}
    dispatchModelLoadProgress({name,stage:'worker-read',loaded:0,total:blob.size,progress:0});
    const id=++gltfWorkerSequence;
    return await new Promise((resolve,reject)=>{
      gltfWorkerPending.set(id,{resolve,reject,onProgress:detail=>dispatchModelLoadProgress({name,...detail})});
      try{
        // Blob structured cloning shares its backing storage; the full ArrayBuffer is created inside the Worker.
        worker.postMessage({id,op:'parse-glb',blob,assetKey:name,textureSupport:getWorkerTextureSupport()});
        dispatchModelLoadProgress({name,stage:'worker-parse-start',loaded:blob.size,total:blob.size,progress:0});
      }catch(error){
        gltfWorkerPending.delete(id);
        error.code=error.code||'PSTUDIO_WORKER_TRANSPORT';
        reject(error);
      }
    });
  }
  function hydrateTypedArray(record){
    if(!record?.buffer||!Number.isSafeInteger(record.length)||record.length<0)throw new Error('Worker geometry attribute data is invalid.');
    const constructors={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array};
    const Constructor=constructors[record.type];
    if(!Constructor)throw new Error('Unsupported worker geometry array type: '+record.type);
    return new Constructor(record.buffer,Number(record.byteOffset)||0,record.length);
  }
  function colorFromArray(value){return Array.isArray(value)?new window.THREE.Color().setRGB(value[0],value[1],value[2]):0xffffff;}
  function hydrateBufferAttribute(record){
    if(!record)return null;
    const attribute=new window.THREE.BufferAttribute(hydrateTypedArray(record.data),record.itemSize,!!record.normalized);
    attribute.name=String(record.name||'');
    if(record.gpuType!==undefined)attribute.gpuType=record.gpuType;
    return attribute;
  }
  async function hydrateGLTFWorkerPacket(packet,name){
    const T=window.THREE;
    if(!packet||!Array.isArray(packet.nodes)||!packet.nodes.length)throw new Error('GLTF Worker returned an empty scene packet.');
    const yieldFrame=()=>new Promise(resolve=>window.requestAnimationFrame(()=>resolve()));
    const notify=(stage,loaded,total)=>dispatchModelLoadProgress({name,stage,loaded,total,progress:total?loaded/total:1});
    let count=0;
    const checkpoint=async(stage,total)=>{
      count++;
      if((count&31)===0){notify(stage,count,total);await yieldFrame();}
    };

    const imageMap=new Map();
    for(const image of packet.images||[]){
      if(!image.bitmap)throw new Error('Worker returned an image without transferable pixel data.');
      imageMap.set(image.id,image.bitmap);
    }
    const textures=new Array((packet.textures||[]).length),virtualTextureIds=new Set();
    for(let i=0;i<textures.length;i++){
      const desc=packet.textures[i],image=imageMap.get(desc.imageId);
      let texture;
      if(desc.compressed){
        const mipmaps=(desc.mipmaps||[]).map(mipmap=>({
          data:hydrateTypedArray(mipmap.data),width:mipmap.width,height:mipmap.height,
          ...(mipmap.depth?{depth:mipmap.depth}:{})
        }));
        if(!mipmaps.length)throw new Error('Compressed texture '+i+' has no mip levels.');
        texture=desc.array
          ? new T.CompressedArrayTexture(mipmaps,desc.width,desc.height,desc.depth,desc.format,desc.type)
          : new T.CompressedTexture(mipmaps,desc.width,desc.height,desc.format,desc.type);
      }else{
        if(!image)throw new Error('Texture '+i+' references a missing decoded image.');
        texture=new T.Texture(image);
      }
      texture.name=desc.name||'';
      texture.mapping=desc.mapping??T.UVMapping;
      texture.channel=Number(desc.channel)||0;
      texture.wrapS=desc.wrapS??T.ClampToEdgeWrapping;
      texture.wrapT=desc.wrapT??T.ClampToEdgeWrapping;
      texture.magFilter=desc.magFilter??T.LinearFilter;
      texture.minFilter=desc.minFilter??T.LinearMipmapLinearFilter;
      if(desc.format!==undefined)texture.format=desc.format;
      if(desc.type!==undefined)texture.type=desc.type;
      texture.colorSpace=desc.colorSpace==='srgb'?T.SRGBColorSpace:desc.colorSpace==='srgb-linear'?(T.LinearSRGBColorSpace||T.NoColorSpace):T.NoColorSpace;
      texture.generateMipmaps=desc.generateMipmaps!==false;
      texture.premultiplyAlpha=!!desc.premultiplyAlpha;
      texture.flipY=!!desc.flipY;
      texture.unpackAlignment=desc.unpackAlignment||4;
      texture.anisotropy=Math.max(1,Math.min(16,Number(desc.anisotropy)||1));
      texture.offset.fromArray(desc.offset||[0,0]);
      texture.repeat.fromArray(desc.repeat||[1,1]);
      texture.center.fromArray(desc.center||[0,0]);
      texture.rotation=Number(desc.rotation)||0;
      texture.matrixAutoUpdate=desc.matrixAutoUpdate!==false;
      if(Array.isArray(desc.matrix))texture.matrix.fromArray(desc.matrix);
      if(desc.userData)texture.userData=desc.userData;
      if(desc.virtual){
        const virtualRecord=registerVirtualTextureSource(texture,name,desc.virtual);
        if(virtualRecord){texture.userData.pstudioVirtualTexture=virtualRecord;virtualTextureIds.add(virtualRecord.id);}
      }
      texture.needsUpdate=true;
      textures[i]=texture;
      await checkpoint('scene-hydrate-textures',i+1,textures.length);
    }
    notify('scene-hydrate-textures',textures.length,textures.length);

    const materials=new Array((packet.materials||[]).length);
    for(let i=0;i<materials.length;i++){
      const desc=packet.materials[i],params={};
      const color=value=>Array.isArray(value)?new T.Color().setRGB(value[0],value[1],value[2]):undefined;
      if(desc.color)params.color=color(desc.color);
      if(desc.emissive)params.emissive=color(desc.emissive);
      for(const key of ['roughness','metalness','opacity','alphaTest','transparent','depthWrite','depthTest','side','vertexColors','flatShading','wireframe','blending','toneMapped','premultipliedAlpha','displacementScale','displacementBias','emissiveIntensity','shininess','clearcoat','clearcoatRoughness','ior','transmission','thickness','attenuationDistance','sheen','sheenRoughness','iridescence','iridescenceIOR','anisotropy','specularIntensity']){
        if(desc[key]!==undefined&&desc[key]!==null)params[key]=desc[key];
      }
      if(desc.specular)params.specular=color(desc.specular);
      if(desc.attenuationColor)params.attenuationColor=color(desc.attenuationColor);
      if(desc.sheenColor)params.sheenColor=color(desc.sheenColor);
      if(desc.specularColor)params.specularColor=color(desc.specularColor);
      if(Array.isArray(desc.iridescenceThicknessRange))params.iridescenceThicknessRange=desc.iridescenceThicknessRange;
      if(Array.isArray(desc.normalScale))params.normalScale=new T.Vector2(...desc.normalScale);
      const Constructors={MeshPhysicalMaterial:T.MeshPhysicalMaterial,MeshStandardMaterial:T.MeshStandardMaterial,MeshBasicMaterial:T.MeshBasicMaterial,MeshLambertMaterial:T.MeshLambertMaterial,MeshPhongMaterial:T.MeshPhongMaterial,MeshToonMaterial:T.MeshToonMaterial,LineBasicMaterial:T.LineBasicMaterial,PointsMaterial:T.PointsMaterial};
      const Constructor=Constructors[desc.type]||T.MeshStandardMaterial;
      const material=new Constructor(params);
      material.name=desc.name||'';
      material.userData=desc.userData||{};
      for(const [slot,textureId] of Object.entries(desc.textureSlots||{})){
        if(textures[textureId])material[slot]=textures[textureId];
      }
      materials[i]=material;
      await checkpoint('scene-hydrate-materials',i+1,materials.length);
    }
    notify('scene-hydrate-materials',materials.length,materials.length);

    const geometries=new Array((packet.geometries||[]).length);
    for(let i=0;i<geometries.length;i++){
      const desc=packet.geometries[i],geometry=new T.BufferGeometry();
      geometry.name=desc.name||'';
      for(const [attributeName,attributeDesc] of Object.entries(desc.attributes||{})){
        const attribute=hydrateBufferAttribute(attributeDesc);
        if(attribute)geometry.setAttribute(attributeName,attribute);
      }
      for(const [attributeName,list] of Object.entries(desc.morphAttributes||{})){
        geometry.morphAttributes[attributeName]=list.map(hydrateBufferAttribute).filter(Boolean);
      }
      geometry.morphTargetsRelative=!!desc.morphTargetsRelative;
      if(desc.index)geometry.setIndex(hydrateBufferAttribute(desc.index));
      for(const group of desc.groups||[])geometry.addGroup(group.start,group.count,group.materialIndex);
      geometry.setDrawRange(desc.drawRange?.start||0,desc.drawRange?.count<0?Infinity:(desc.drawRange?.count??Infinity));
      if(desc.boundingBox){geometry.boundingBox=new T.Box3(new T.Vector3(...desc.boundingBox.min),new T.Vector3(...desc.boundingBox.max));}
      if(desc.boundingSphere){geometry.boundingSphere=new T.Sphere(new T.Vector3(...desc.boundingSphere.center),desc.boundingSphere.radius);}
      if(desc.userData)geometry.userData=desc.userData;
      geometries[i]=geometry;
      await checkpoint('scene-hydrate-geometry',i+1,geometries.length);
    }
    notify('scene-hydrate-geometry',geometries.length,geometries.length);

    const nodes=new Array(packet.nodes.length);
    for(let i=0;i<packet.nodes.length;i++){
      const desc=packet.nodes[i],geometry=desc.geometryId===null?null:geometries[desc.geometryId];
      const sourceMaterialIds=desc.materialIds||[];
      const nodeMaterials=sourceMaterialIds.map(id=>id===null||id===undefined?undefined:(materials[id]||undefined));
      const material=sourceMaterialIds.length>1?nodeMaterials:(nodeMaterials[0]||null);
      let object;
      switch(desc.kind){
        case 'Mesh': object=new T.Mesh(geometry,material);break;
        case 'SkinnedMesh': object=new T.SkinnedMesh(geometry,material);break;
        case 'InstancedMesh': object=new T.InstancedMesh(geometry,material,desc.instanceCount||1);break;
        case 'Points': object=new T.Points(geometry,material);break;
        case 'LineSegments': object=new T.LineSegments(geometry,material);break;
        case 'LineLoop': object=new T.LineLoop(geometry,material);break;
        case 'Line': object=new T.Line(geometry,material);break;
        case 'Bone': object=new T.Bone();break;
        case 'PerspectiveCamera': object=new T.PerspectiveCamera(desc.fov,desc.aspect,desc.near,desc.far);break;
        case 'OrthographicCamera': object=new T.OrthographicCamera(desc.left,desc.right,desc.top,desc.bottom,desc.near,desc.far);break;
        case 'DirectionalLight': object=new T.DirectionalLight(colorFromArray(desc.color),desc.intensity??1);break;
        case 'PointLight': object=new T.PointLight(colorFromArray(desc.color),desc.intensity??1,desc.distance??0,desc.decay??2);break;
        case 'SpotLight': object=new T.SpotLight(colorFromArray(desc.color),desc.intensity??1,desc.distance??0,desc.angle??Math.PI/3,desc.penumbra??0,desc.decay??2);break;
        case 'HemisphereLight': object=new T.HemisphereLight(colorFromArray(desc.color),colorFromArray(desc.groundColor),desc.intensity??1);break;
        case 'AmbientLight': object=new T.AmbientLight(colorFromArray(desc.color),desc.intensity??1);break;
        case 'Group': object=new T.Group();break;
        default: object=new T.Group();break;
      }
      object.name=desc.name||'';
      object.position.fromArray(desc.position||[0,0,0]);
      object.quaternion.fromArray(desc.quaternion||[0,0,0,1]);
      object.scale.fromArray(desc.scale||[1,1,1]);
      if(desc.matrix&&desc.matrixAutoUpdate===false){object.matrix.fromArray(desc.matrix);object.matrixAutoUpdate=false;}
      object.visible=desc.visible!==false;
      object.renderOrder=desc.renderOrder||0;
      object.frustumCulled=desc.frustumCulled!==false;
      object.castShadow=!!desc.castShadow;
      object.receiveShadow=!!desc.receiveShadow;
      object.userData=desc.userData||{};
      if(desc.morphTargetInfluences&&object.morphTargetInfluences)for(let j=0;j<Math.min(desc.morphTargetInfluences.length,object.morphTargetInfluences.length);j++)object.morphTargetInfluences[j]=desc.morphTargetInfluences[j];
      if(desc.morphTargetDictionary)object.morphTargetDictionary=desc.morphTargetDictionary;
      if(desc.instances&&object.isInstancedMesh){
        const matrices=hydrateTypedArray(desc.instances.matrix);
        if(matrices.length!==object.instanceMatrix.array.length)throw new Error('InstancedMesh matrix buffer length mismatch.');
        object.instanceMatrix.array.set(matrices);object.instanceMatrix.needsUpdate=true;
        if(desc.instances.color){object.instanceColor=new T.InstancedBufferAttribute(hydrateTypedArray(desc.instances.color),3);object.instanceColor.needsUpdate=true;}
        object.computeBoundingBox?.();object.computeBoundingSphere?.();
      }
      if(desc.zoom!==undefined&&object.isCamera)object.zoom=desc.zoom;
      if(desc.filmGauge!==undefined&&object.isPerspectiveCamera)object.filmGauge=desc.filmGauge;
      if(desc.filmOffset!==undefined&&object.isPerspectiveCamera)object.filmOffset=desc.filmOffset;
      if(desc.focus!==undefined&&object.isPerspectiveCamera)object.focus=desc.focus;
      if(desc.view&&object.isCamera)object.view=desc.view;
      object.userData.pstudioWorkerNodeId=desc.id;
      nodes[desc.id]=object;
      await checkpoint('scene-hydrate-nodes',i+1,nodes.length);
    }
    notify('scene-hydrate-nodes',nodes.length,nodes.length);

    for(let i=0;i<packet.nodes.length;i++){
      const desc=packet.nodes[i],object=nodes[i];
      for(const childId of desc.children||[])if(nodes[childId]&&nodes[childId].parent!==object)object.add(nodes[childId]);
      if(desc.target>=0&&object.isLight&&nodes[desc.target])object.target=nodes[desc.target];
    }
    for(const desc of packet.nodes){
      if(!desc.skeleton)continue;
      const mesh=nodes[desc.id],bones=desc.skeleton.bones.map(id=>nodes[id]).filter(Boolean);
      if(!mesh?.isSkinnedMesh||!bones.length)continue;
      const inverses=(desc.skeleton.boneInverses||[]).map(value=>new T.Matrix4().fromArray(value));
      const skeleton=new T.Skeleton(bones,inverses);
      const bindMatrix=new T.Matrix4().fromArray(desc.skeleton.bindMatrix);
      mesh.bind(skeleton,bindMatrix);
      mesh.bindMode=desc.skeleton.bindMode||'attached';
      if(desc.skeleton.bindMatrixInverse)mesh.bindMatrixInverse.fromArray(desc.skeleton.bindMatrixInverse);
    }
    const root=nodes[packet.rootIndex]||nodes[0];
    if(!root)throw new Error('GLTF Worker scene root could not be rebuilt.');
    const animations=(packet.animations||[]).map(data=>T.AnimationClip.parse(data));
    root.updateMatrixWorld(true);
    return {scene:root,animations,packetTimings:packet.timings||null,virtualTextureIds:[...virtualTextureIds]};
  }
  async function parseGLTFOnMainThread(blob,name){
    const loader=new window.PStudioGLTFLoader();
    if(window.PStudioMeshoptDecoder)loader.setMeshoptDecoder(window.PStudioMeshoptDecoder);
    let draco=null;
    if(window.PStudioDRACOLoader){
      draco=new window.PStudioDRACOLoader();
      draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
      draco.setWorkerLimit(Math.max(1,Math.min(2,deviceMemoryGiB()<=2?1:2)));
      loader.setDRACOLoader(draco);
    }
    if(window.PStudioKTX2Loader&&renderer){
      try{
        if(!sharedKTX2Loader){
          sharedKTX2Loader=new window.PStudioKTX2Loader();
          sharedKTX2Loader.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/');
          sharedKTX2Loader.setWorkerLimit(Math.max(1,Math.min(2,deviceMemoryGiB()<=2?1:2)));
          sharedKTX2Loader.detectSupport(renderer);
        }
        loader.setKTX2Loader(sharedKTX2Loader);
      }catch(error){console.warn('[PStudio] KTX2 support could not be initialized:',error);}
    }
    const url=URL.createObjectURL(blob);
    try{
      return await new Promise((resolve,reject)=>loader.load(url,resolve,event=>{
        const loaded=Number(event?.loaded)||0,total=Number(event?.total)||blob.size;
        dispatchModelLoadProgress({name,stage:'main-thread-fetch',loaded,total,progress:total?loaded/total:0});
      },reject));
    }finally{
      URL.revokeObjectURL(url);
      draco?.dispose?.();
    }
  }

  function requestGLTFWorkerMessage(op,payload={},transferList=[]){
    const worker=getGLTFWorker();
    if(!worker){const error=new Error('GLTF Worker is unavailable.');error.code='PSTUDIO_WORKER_UNAVAILABLE';return Promise.reject(error);}
    const id=++gltfWorkerSequence;
    return new Promise((resolve,reject)=>{
      gltfWorkerPending.set(id,{resolve,reject});
      try{worker.postMessage({id,op,...payload},transferList);}
      catch(error){gltfWorkerPending.delete(id);reject(error);}
    });
  }
  function getGLTFWorkerCapabilities(){
    if(gltfWorkerCapabilitiesPromise)return gltfWorkerCapabilitiesPromise;
    gltfWorkerCapabilitiesPromise=requestGLTFWorkerMessage('capabilities').then(value=>value||{}).catch(error=>{
      gltfWorkerCapabilitiesPromise=null;
      return{offscreenCanvas:false,createImageBitmap:false,error:String(error?.message||error)};
    });
    return gltfWorkerCapabilitiesPromise;
  }

  function initializeVirtualTextureAtlas(colorSpace){
    const key=colorSpace===window.THREE.SRGBColorSpace?'srgb':'linear';
    if(virtualTextureAtlases.has(key))return virtualTextureAtlases.get(key);
    if(!renderer||typeof renderer.copyTextureToTexture!=='function')return null;
    const T=window.THREE,memory=deviceMemoryGiB(),size=memory>=8?4096:memory<=2?1024:2048,pageSize=256,pagesPerAxis=size/pageSize;
    const data=new Uint8Array(size*size*4);
    const texture=new T.DataTexture(data,size,size,T.RGBAFormat,T.UnsignedByteType);
    texture.name='PStudio_VT_Atlas_'+key;
    texture.colorSpace=key==='srgb'?T.SRGBColorSpace:T.NoColorSpace;
    texture.magFilter=T.LinearFilter;texture.minFilter=T.LinearFilter;
    texture.generateMipmaps=false;texture.flipY=false;texture.unpackAlignment=1;texture.needsUpdate=true;
    try{renderer.initTexture(texture);texture.image.data=null;}
    catch(error){texture.dispose();console.warn('[PStudio] Virtual texture atlas init failed:',error);return null;}
    const atlas={key,size,pageSize,pagesPerAxis,capacity:pagesPerAxis*pagesPerAxis,texture,slots:new Array(pagesPerAxis*pagesPerAxis).fill(null),clock:0,bytes:size*size*4};
    virtualTextureAtlases.set(key,atlas);
    return atlas;
  }
  function registerVirtualTextureSource(texture,assetKey,virtualInfo){
    if(!texture?.isTexture||!virtualInfo?.workerImageKey)return null;
    const sourceId=String(virtualInfo.workerImageKey),colorKey=texture.colorSpace===window.THREE.SRGBColorSpace?'srgb':'linear';
    const id=sourceId+'@'+colorKey;
    if(virtualTextures.has(id))return virtualTextures.get(id);
    const atlas=initializeVirtualTextureAtlas(texture.colorSpace);
    if(!atlas)return null;
    const width=Math.max(1,Number(virtualInfo.sourceWidth)||0),height=Math.max(1,Number(virtualInfo.sourceHeight)||0);
    const tileSize=Math.max(64,Math.min(256,Number(virtualInfo.pageSize)||256));
    const columns=Math.ceil(width/tileSize),rows=Math.ceil(height/tileSize);
    const maxSize=Number(renderer?.capabilities?.maxTextureSize)||4096;
    if(columns>maxSize||rows>maxSize)return null;
    const data=new Uint8Array(columns*rows*4);
    const pageTable=new window.THREE.DataTexture(data,columns,rows,window.THREE.RGBAFormat,window.THREE.UnsignedByteType);
    pageTable.name='PStudio_VT_PageTable_'+id;
    pageTable.magFilter=window.THREE.NearestFilter;pageTable.minFilter=window.THREE.NearestFilter;
    pageTable.generateMipmaps=false;pageTable.flipY=false;pageTable.unpackAlignment=1;
    pageTable.colorSpace=window.THREE.NoColorSpace;pageTable.needsUpdate=true;
    try{renderer.initTexture(pageTable);}catch(error){pageTable.dispose();return null;}
    const record={
      id,sourceId,assetKey:String(assetKey),workerImageKey:sourceId,sourceWidth:width,sourceHeight:height,
      tileSize,tileColumns:columns,tileRows:rows,pageTableData:data,pageTableTexture:pageTable,
      atlas,colorSpace:texture.colorSpace,lastScanAt:0,lastCameraPosition:null,pages:new Set(),
      requestCount:0,residentCount:0
    };
    virtualTextures.set(id,record);
    texture.userData=texture.userData||{};
    texture.userData.pstudioVirtualTexture=record;
    return record;
  }
  function virtualTexturePageKey(record,x,y){return record.id+'|'+x+'|'+y;}
  function scheduleVirtualTexturePump(){
    if(virtualTexturePumpScheduled||!virtualTextureQueue.length||!renderer)return;
    virtualTexturePumpScheduled=true;
    window.requestAnimationFrame(async()=>{
      virtualTexturePumpScheduled=false;
      const job=virtualTextureQueue.shift();
      if(!job)return;
      virtualTexturePending.delete(job.key);
      const record=virtualTextures.get(job.recordId);
      if(record&&record.assetKey===job.assetKey){
        try{
          const result=await requestGLTFWorkerMessage('extract-tile',{
            textureId:record.workerImageKey,x:job.x*record.tileSize,y:job.y*record.tileSize,
            width:record.tileSize,height:record.tileSize
          });
          if(!virtualTextures.has(record.id))return;
          const T=window.THREE,width=Math.max(1,Math.min(record.tileSize,Number(result.width)||record.tileSize));
          const height=Math.max(1,Math.min(record.tileSize,Number(result.height)||record.tileSize));
          let pixels=new Uint8Array(result.buffer);
          if(width!==record.tileSize||height!==record.tileSize){
            const padded=new Uint8Array(record.tileSize*record.tileSize*4);
            for(let y=0;y<record.tileSize;y++)for(let x=0;x<record.tileSize;x++){
              const source=(Math.min(height-1,y)*width+Math.min(width-1,x))*4,target=(y*record.tileSize+x)*4;
              padded[target]=pixels[source];padded[target+1]=pixels[source+1];padded[target+2]=pixels[source+2];padded[target+3]=pixels[source+3];
            }
            pixels=padded;
          }
          const atlas=record.atlas,key=virtualTexturePageKey(record,job.x,job.y);
          let slotIndex=virtualTexturePageCache.get(key);
          if(slotIndex===undefined){
            slotIndex=atlas.slots.findIndex(slot=>slot===null);
            if(slotIndex<0){
              slotIndex=0;
              for(let i=1;i<atlas.slots.length;i++)if(atlas.slots[i].lastUsed<atlas.slots[slotIndex].lastUsed)slotIndex=i;
              const previous=atlas.slots[slotIndex];
              if(previous){
                const parts=previous.key.split('|'),oldRecord=virtualTextures.get(parts[0]);
                if(oldRecord){
                  const oldPageIndex=(Number(parts[2])*oldRecord.tileColumns+Number(parts[1]))*4;
                  oldRecord.pageTableData[oldPageIndex+2]=0;oldRecord.pageTableTexture.needsUpdate=true;
                  oldRecord.pages.delete(previous.key);oldRecord.residentCount=Math.max(0,oldRecord.residentCount-1);
                }
                virtualTexturePageCache.delete(previous.key);
              }
            }
            virtualTexturePageCache.set(key,slotIndex);
            atlas.slots[slotIndex]={key,lastUsed:++atlas.clock};
          }
          atlas.slots[slotIndex].lastUsed=++atlas.clock;
          const tile=new T.DataTexture(pixels,record.tileSize,record.tileSize,T.RGBAFormat,T.UnsignedByteType);
          tile.name='PStudio_VT_TileUpload';tile.colorSpace=record.colorSpace||T.NoColorSpace;
          tile.magFilter=T.LinearFilter;tile.minFilter=T.LinearFilter;tile.generateMipmaps=false;tile.flipY=false;tile.unpackAlignment=1;tile.needsUpdate=true;
          const slotX=slotIndex%atlas.pagesPerAxis,slotY=Math.floor(slotIndex/atlas.pagesPerAxis);
          renderer.copyTextureToTexture(new T.Vector2(slotX*record.tileSize,slotY*record.tileSize),tile,atlas.texture,0);
          tile.dispose();
          const pageIndex=(job.y*record.tileColumns+job.x)*4;
          record.pageTableData[pageIndex]=slotX;record.pageTableData[pageIndex+1]=slotY;
          record.pageTableData[pageIndex+2]=255;record.pageTableData[pageIndex+3]=255;
          record.pageTableTexture.needsUpdate=true;
          record.pages.add(key);record.residentCount++;record.requestCount++;virtualTextureTileUploads++;
          try{window.PStudioEvents?.emit('render.virtual-texture.page-uploaded',{id:record.id,x:job.x,y:job.y,slotX,slotY});}catch(_){}
        }catch(error){console.warn('[PStudio] Virtual texture tile stream failed:',error);}
      }
      scheduleVirtualTexturePump();
    });
  }
  function requestVirtualTexturePage(record,x,y,priority=0){
    if(!record)return false;
    const tx=Math.max(0,Math.min(record.tileColumns-1,Math.floor(x))),ty=Math.max(0,Math.min(record.tileRows-1,Math.floor(y)));
    const pageIndex=(ty*record.tileColumns+tx)*4;
    if(record.pageTableData[pageIndex+2]===255)return false;
    const key=virtualTexturePageKey(record,tx,ty);
    if(virtualTexturePending.has(key))return false;
    virtualTexturePending.add(key);
    virtualTextureQueue.push({key,recordId:record.id,assetKey:record.assetKey,x:tx,y:ty,priority});
    virtualTextureQueue.sort((a,b)=>b.priority-a.priority);
    virtualTextureRequests++;scheduleVirtualTexturePump();return true;
  }
  function virtualTextureWrap(value,mode){
    const T=window.THREE;
    if(mode===T.RepeatWrapping)return value-Math.floor(value);
    if(mode===T.MirroredRepeatWrapping){const cell=Math.floor(value),fraction=value-cell;return Math.abs(cell%2)===1?1-fraction:fraction;}
    return Math.max(0,Math.min(0.999999,value));
  }
  const VIRTUAL_TEXTURE_UV_VARYINGS={
    map:'vMapUv',alphaMap:'vAlphaMapUv',aoMap:'vAoMapUv',bumpMap:'vBumpMapUv',
    normalMap:'vNormalMapUv',displacementMap:'vDisplacementMapUv',emissiveMap:'vEmissiveMapUv',
    lightMap:'vLightMapUv',metalnessMap:'vMetalnessMapUv',roughnessMap:'vRoughnessMapUv',
    specularMap:'vSpecularMapUv',clearcoatMap:'vClearcoatMapUv',clearcoatNormalMap:'vClearcoatNormalMapUv',
    clearcoatRoughnessMap:'vClearcoatRoughnessMapUv',iridescenceMap:'vIridescenceMapUv',
    iridescenceThicknessMap:'vIridescenceThicknessMapUv',sheenColorMap:'vSheenColorMapUv',
    sheenRoughnessMap:'vSheenRoughnessMapUv',specularColorMap:'vSpecularColorMapUv',
    specularIntensityMap:'vSpecularIntensityMapUv',transmissionMap:'vTransmissionMapUv',
    thicknessMap:'vThicknessMapUv',anisotropyMap:'vAnisotropyMapUv'
  };
  function setupVirtualTextureMaterial(material){
    if(!material||material.userData?.pstudioVTShaderSetup)return false;
    const slots=[];
    for(const [slot] of Object.entries(VIRTUAL_TEXTURE_UV_VARYINGS)){
      const texture=material[slot],record=texture?.userData?.pstudioVirtualTexture;
      if(record?.pageTableTexture&&record.atlas?.texture)slots.push({slot,texture,record});
    }
    if(!slots.length)return false;
    const previousCompile=material.onBeforeCompile,previousKey=material.customProgramCacheKey?.bind(material);
    const uniforms={};
    for(const entry of slots){
      const u={
        atlas:entry.record.atlas.texture,pageTable:entry.record.pageTableTexture,
        sourceSize:new window.THREE.Vector2(entry.record.sourceWidth,entry.record.sourceHeight),
        tileCount:new window.THREE.Vector2(entry.record.tileColumns,entry.record.tileRows),
        atlasSize:entry.record.atlas.size,pageSize:entry.record.tileSize,
        wrapS:entry.texture.wrapS===window.THREE.RepeatWrapping?1:entry.texture.wrapS===window.THREE.MirroredRepeatWrapping?2:0,
        wrapT:entry.texture.wrapT===window.THREE.RepeatWrapping?1:entry.texture.wrapT===window.THREE.MirroredRepeatWrapping?2:0
      };
      uniforms[entry.slot]=u;
    }
    material.onBeforeCompile=function(shader,rendererRef){
      if(typeof previousCompile==='function')previousCompile.call(this,shader,rendererRef);
      let fragmentCode='',vertexCode='';
      for(const entry of slots){
        const slot=entry.slot,u=uniforms[slot],prefix='uPStudioVT_'+slot+'_';
        shader.uniforms[prefix+'atlas']={value:u.atlas};
        shader.uniforms[prefix+'pageTable']={value:u.pageTable};
        shader.uniforms[prefix+'sourceSize']={value:u.sourceSize};
        shader.uniforms[prefix+'tileCount']={value:u.tileCount};
        shader.uniforms[prefix+'atlasSize']={value:u.atlasSize};
        shader.uniforms[prefix+'pageSize']={value:u.pageSize};
        shader.uniforms[prefix+'wrapS']={value:u.wrapS};
        shader.uniforms[prefix+'wrapT']={value:u.wrapT};
        let code='uniform sampler2D '+prefix+'atlas;uniform sampler2D '+prefix+'pageTable;uniform vec2 '+prefix+'sourceSize;uniform vec2 '+prefix+'tileCount;uniform float '+prefix+'atlasSize;uniform float '+prefix+'pageSize;uniform float '+prefix+'wrapS;uniform float '+prefix+'wrapT;\n';
        code+='float '+prefix+'wrap(float v,float mode){if(mode<0.5)return clamp(v,0.0,0.999999);if(mode<1.5)return fract(v);float cell=floor(v);float f=fract(v);return mod(abs(cell),2.0)>0.5?1.0-f:f;}\n';
        const vertexSample=slot==='displacementMap';
        const footprint='(max(length(dFdx(uv*'+prefix+'sourceSize)),length(dFdy(uv*'+prefix+'sourceSize)))>1.5)';
        code+='vec4 '+prefix+'sample(vec2 uv){vec2 wrapped=vec2('+prefix+'wrap(uv.x,'+prefix+'wrapS),'+prefix+'wrap(uv.y,'+prefix+'wrapT));vec2 pixel=wrapped*'+prefix+'sourceSize;';
        if(!vertexSample)code+='if('+footprint+')return texture2D('+slot+',uv);';
        code+='vec2 tile=floor(pixel/'+prefix+'pageSize);vec4 page=texture2D('+prefix+'pageTable,(tile+vec2(0.5))/'+prefix+'tileCount);if(page.b<0.5)return texture2D('+slot+',uv);vec2 slotXY=floor(page.rg*255.0+0.5);vec2 local=clamp(mod(pixel,'+prefix+'pageSize),vec2(0.5),vec2('+prefix+'pageSize-0.5));vec2 atlasUV=(slotXY*'+prefix+'pageSize+local)/'+prefix+'atlasSize;return texture2D('+prefix+'atlas,atlasUV);}\n';
        if(vertexSample)vertexCode+=code;else fragmentCode+=code;
      }
      if(vertexCode)shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\n'+vertexCode);
      if(fragmentCode)shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+fragmentCode);
      for(const entry of slots){
        const slot=entry.slot,uv=VIRTUAL_TEXTURE_UV_VARYINGS[slot];
        const pattern=new RegExp('texture2D\\s*\\(\\s*'+slot+'\\s*,\\s*'+uv+'\\s*\\)','g');
        const replacement='uPStudioVT_'+slot+'_sample('+uv+')';
        if(slot==='displacementMap')shader.vertexShader=shader.vertexShader.replace(pattern,replacement);
        else shader.fragmentShader=shader.fragmentShader.replace(pattern,replacement);
      }
    };
    material.customProgramCacheKey=function(){return(previousKey?previousKey():'')+'|pstudio-virtual-texture-v1:'+slots.map(entry=>entry.slot).sort().join(',');};
    material.userData.pstudioVTUniforms=uniforms;
    material.userData.pstudioVTShaderSetup=true;
    return true;
  }

  function requestVisibleVirtualTextureTiles(instance){
    if(!camera||!instance?.root?.visible)return;
    const now=window.performance?.now?.()??Date.now();
    if(now-(instance.lastVirtualTextureScanAt||0)<700)return;
    if(instance.lastVirtualTextureCamera?.distanceToSquared(camera.position)<0.36&&now-(instance.lastVirtualTextureScanAt||0)<1500)return;
    instance.lastVirtualTextureScanAt=now;
    if(!instance.lastVirtualTextureCamera)instance.lastVirtualTextureCamera=new window.THREE.Vector3();
    instance.lastVirtualTextureCamera.copy(camera.position);
    const T=window.THREE,viewProjection=new T.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    const objects=[...(instance.meshes||[]),...(instance.foliageBatches||[]).map(entry=>entry.mesh)];
    let sampled=0;
    for(const object of objects){
      if(sampled>=900||!object.visible||!object.geometry||!object.material)continue;
      let parent=object.parent,visible=true;
      while(parent&&parent!==instance.root){if(!parent.visible){visible=false;break;}parent=parent.parent;}
      if(!visible)continue;
      object.updateWorldMatrix(true,false);
      const mvp=viewProjection.clone().multiply(object.matrixWorld),position=object.geometry.attributes.position,index=object.geometry.index;
      if(!position)continue;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){
        if(!material)continue;
        for(const slot of Object.keys(VIRTUAL_TEXTURE_UV_VARYINGS)){
          const texture=material[slot],record=texture?.userData?.pstudioVirtualTexture;
          if(!record||!texture)continue;
          const channel=Number(texture.channel)||0,uv=object.geometry.attributes[channel===0?'uv':'uv'+channel]||object.geometry.attributes.uv;
          if(!uv)continue;
          if(texture.matrixAutoUpdate)texture.updateMatrix();
          const count=index?index.count:position.count,triangleCount=Math.floor(count/3);
          const stride=Math.max(1,Math.ceil(triangleCount/Math.max(1,Math.floor((900-sampled)/Math.max(1,materials.length)))));
          const p0=new T.Vector3(),p1=new T.Vector3(),p2=new T.Vector3(),center=new T.Vector3(),clip=new T.Vector4(),uvCenter=new T.Vector2();
          for(let tri=0;tri<triangleCount&&sampled<900;tri+=stride){
            const base=tri*3,a=index?index.getX(base):base,b=index?index.getX(base+1):base+1,c=index?index.getX(base+2):base+2;
            p0.fromBufferAttribute(position,a);p1.fromBufferAttribute(position,b);p2.fromBufferAttribute(position,c);
            center.copy(p0).add(p1).add(p2).multiplyScalar(1/3);
            clip.set(center.x,center.y,center.z,1).applyMatrix4(mvp);sampled++;
            if(clip.w<=0||Math.abs(clip.x)>clip.w||Math.abs(clip.y)>clip.w||clip.z< -clip.w||clip.z>clip.w)continue;
            uvCenter.set((uv.getX(a)+uv.getX(b)+uv.getX(c))/3,(uv.getY(a)+uv.getY(b)+uv.getY(c))/3).applyMatrix3(texture.matrix);
            const u=virtualTextureWrap(uvCenter.x,texture.wrapS),v=virtualTextureWrap(uvCenter.y,texture.wrapT);
            const tx=Math.floor(u*record.sourceWidth/record.tileSize),ty=Math.floor(v*record.sourceHeight/record.tileSize);
            const priority=1-Math.min(1,Math.hypot(clip.x/clip.w,clip.y/clip.w)/1.4142);
            requestVirtualTexturePage(record,tx,ty,priority);
          }
        }
      }
    }
  }
  function releaseVirtualTexturesForAsset(assetKey){
    const key=String(assetKey||'');
    for(const [id,record] of virtualTextures){
      if(record.assetKey!==key)continue;
      for(const pageKey of record.pages){
        const slotIndex=virtualTexturePageCache.get(pageKey);
        if(slotIndex!==undefined){record.atlas.slots[slotIndex]=null;virtualTexturePageCache.delete(pageKey);}
      }
      for(let i=0;i<record.pageTableData.length;i+=4)record.pageTableData[i+2]=0;
      record.pageTableTexture?.dispose?.();virtualTextures.delete(id);
    }
    for(let i=virtualTextureQueue.length-1;i>=0;i--){
      if(virtualTextureQueue[i].assetKey===key){virtualTexturePending.delete(virtualTextureQueue[i].key);virtualTextureQueue.splice(i,1);}
    }
    if(gltfWorker)requestGLTFWorkerMessage('release-asset',{assetKey:key}).catch(()=>{});
  }

  function requestModelAsset(name) {
    const assetName=String(name||'');
    if(modelCache.has(assetName))return Promise.resolve(modelCache.get(assetName));
    if(modelPromises.has(assetName))return modelPromises.get(assetName);
    const revision=modelRevisions.get(assetName)||0;
    const promise=(async()=>{
      let loadStage='blob-read',gltf=null,workerPacket=null,assetRecord=null;
      try{
        if(!window.PStudioGLTFLoader)throw new Error('GLTFLoader is unavailable. Check the Three.js module connection.');
        if(!window.PStudioAssetStore)throw new Error('3D asset storage is unavailable.');
        const blob=await window.PStudioAssetStore.get(assetName,{cache:false});
        if(!blob)throw new Error('Model asset not found: '+assetName+' (import a .glb or .gltf file first)');
        const metadata=await window.PStudioAssetStore.getMetadata?.(assetName)||null;
        const estimatedRuntimeBytes=Math.max(Number(metadata?.estimatedRuntimeBytes)||0,Number(blob.size)||0);
        const estimatedCpuBytes=Math.max(Number(metadata?.estimatedCpuBytes)||0,Number(blob.size)||0);
        const safeBudget=modelRuntimeBudgetBytes(),cpuBudget=modelCpuHeapBudgetBytes();
        if(estimatedRuntimeBytes>safeBudget||estimatedCpuBytes>cpuBudget){
          const needed=(estimatedRuntimeBytes/1024/1024).toFixed(0),budget=(safeBudget/1024/1024).toFixed(0);
          const cpuNeeded=(estimatedCpuBytes/1024/1024).toFixed(0),cpuSafe=(cpuBudget/1024/1024).toFixed(0);
          const error=new Error('この端末ではモデル展開時のメモリ負荷が安全目安を超えます（全体推定 '+needed+'MiB / '+budget+'MiB、CPU側 '+cpuNeeded+'MiB / '+cpuSafe+'MiB）。元のモデルはIndexedDBに保存済みです。メモリに余裕のある端末、またはモデルのテクスチャ・メッシュ構成を見直して再試行してください。');
          error.code='PSTUDIO_MODEL_MEMORY_BUDGET';
          throw error;
        }
        const isJSONGLTF=/\.gltf$/i.test(assetName)||String(blob.type||'').toLowerCase().includes('gltf+json');
        const decodeStarted=window.performance?.now?.()??Date.now();
        dispatchModelLoadProgress({name:assetName,stage:'scene-decode-start',loaded:0,total:blob.size,progress:0});
        if(isJSONGLTF){
          // JSON glTF has no GLB header; parse its bundled Blob URL through the standard loader.
          loadStage='main-thread-gltf-json';
          dispatchModelLoadProgress({name:assetName,stage:'main-thread-gltf-json-start',loaded:0,total:blob.size,progress:0});
          gltf=await parseGLTFOnMainThread(blob,assetName);
        }else{
          loadStage='worker-parse';
          dispatchModelLoadProgress({name:assetName,stage:'worker-glb-parse',loaded:0,total:blob.size,progress:0});
          try{
            workerPacket=await parseGLBInWorker(blob,assetName);
            dispatchModelLoadProgress({name:assetName,stage:'worker-glb-parsed',loaded:blob.size,total:blob.size,progress:1,durationMs:workerPacket.timings?.totalWorkerMs??null});
            loadStage='worker-hydrate';
            gltf=await hydrateGLTFWorkerPacket(workerPacket,assetName);
            workerPacket=null;
          }catch(workerError){
            const message=String(workerError?.message||workerError);
            const invalidGLB=/Invalid GLB buffer|GLB 2\.0 header validation failed|GLB JSON chunk is invalid/i.test(message);
            const memoryFailure=/out of memory|memory allocation|allocation failed|exceeded.{0,24}memory/i.test(message);
            if(invalidGLB||memoryFailure)throw workerError;
            dispatchModelLoadProgress({name:assetName,stage:'main-thread-parser-fallback',reason:message,failedStage:loadStage});
            disposeWorkerPacket(workerPacket);
            workerPacket=null;
            requestGLTFWorkerMessage('release-asset',{assetKey:assetName}).catch(()=>{});
            loadStage='main-thread-fallback';
            gltf=await parseGLTFOnMainThread(blob,assetName);
          }
        }
        if(!gltf?.scene)throw new Error('The model file contains no scene: '+assetName);
        if((modelRevisions.get(assetName)||0)!==revision){
          disposeModelAsset({scene:gltf.scene,assetKey:assetName});
          return null;
        }
        dispatchModelLoadProgress({name:assetName,stage:'scene-decoded',loaded:blob.size,total:blob.size,progress:1,durationMs:Math.max(0,(window.performance?.now?.()??Date.now())-decodeStarted)});
        assetRecord={scene:gltf.scene,animations:gltf.animations||[],memoryEstimateBytes:estimatedRuntimeBytes,gpuEstimateBytes:Number(metadata?.estimatedGpuBytes)||0,assetKey:assetName,virtualTextureIds:gltf.virtualTextureIds||[]};
        modelCache.set(assetName,assetRecord);
        if(window.PStudioResources?.register){
          try{
            window.PStudioResources.register('model-gpu',assetName,assetRecord,{
              category:'gpu',
              sizeBytes:Math.max(Number(metadata?.estimatedGpuBytes)||0,Math.ceil(blob.size*1.6)),
              metadata:{sourceBytes:blob.size,estimatedRuntimeBytes,estimate:'GLB metadata geometry plus decoded texture and GPU allocation'},
              dispose:disposeModelAsset,
              onEvict:()=>{
                if(modelCache.get(assetName)===assetRecord)modelCache.delete(assetName);
                modelCollisionCache.delete(assetName);
                for(const cacheKey of transformedCollisionCache.keys())if(cacheKey.startsWith(assetName+'|'))transformedCollisionCache.delete(cacheKey);
              }
            });
          }catch(resourceError){
            if(modelCache.get(assetName)===assetRecord)modelCache.delete(assetName);
            disposeModelAsset(assetRecord);
            assetRecord=null;
            throw new Error('モデルは解析できましたが、リソース管理への登録に失敗しました: '+String(resourceError?.message||resourceError));
          }
        }
        modelLoadErrors.delete(assetName);
        dispatchModelLoadProgress({name:assetName,stage:'ready',loaded:blob.size,total:blob.size,progress:1});
        return assetRecord;
      }catch(error){
        const message=String(error?.message||error);
        if(workerPacket)disposeWorkerPacket(workerPacket);
        if((modelRevisions.get(assetName)||0)===revision){
          if(assetRecord&&modelCache.get(assetName)===assetRecord)modelCache.delete(assetName);
          if(assetRecord)try{disposeModelAsset(assetRecord);}catch(disposeError){console.warn('[PStudio] Failed model cleanup:',disposeError);}
          releaseVirtualTexturesForAsset(assetName);
          modelLoadErrors.set(assetName,message);
          console.error('[PStudio] Model load failed:',assetName,'at',loadStage,error);
          dispatchModelLoadError({name:assetName,stage:loadStage,error:message,retryable:error?.code!=='PSTUDIO_MODEL_MEMORY_BUDGET'});
        }
        return null;
      }
    })().then(asset=>{
      if(asset)modelLoadErrors.delete(assetName);
      if(asset&&renderer&&lastCommands){
        try{render(lastCommands);}catch(error){
          console.error('[PStudio] Model render failed:',assetName,error);
          dispatchModelLoadError({name:assetName,stage:'first-render',error:error?.message||String(error),retryable:true});
        }
      }
      return asset;
    }).finally(()=>{
      if(modelPromises.get(assetName)===promise)modelPromises.delete(assetName);
    });
    modelPromises.set(assetName,promise);
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
    object.geometry=working;object.userData.pstudioLightmapGeometry=true;markModelGeometryChanged(object);
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
    if(object.userData.pstudioLightmapGeometry&&object.userData.pstudioLightmapOriginalGeometry){object.geometry.userData.pstudioBVHDisposed=true;object.geometry.userData.pstudioBVHToken=(object.geometry.userData.pstudioBVHToken||0)+1;object.geometry.disposeBoundsTree?.();object.geometry.dispose?.();object.geometry=object.userData.pstudioLightmapOriginalGeometry;markModelGeometryChanged(object);object.userData.pstudioLightmapOriginalGeometry=null;object.userData.pstudioLightmapGeometry=false;object.userData.pstudioLightmapOriginalGeometryOwned=false;changed=true;}
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
      object.geometry=working;working=null;object.userData.pstudioLightmapGeometry=true;markModelGeometryChanged(object);
      if(oldGeometry!==source&&oldGeometry!==object.geometry){oldGeometry.userData.pstudioBVHDisposed=true;oldGeometry.userData.pstudioBVHToken=(oldGeometry.userData.pstudioBVHToken||0)+1;oldGeometry.disposeBoundsTree?.();oldGeometry.dispose?.();}
      oldTexture?.dispose?.();object.userData.pstudioLightmapTexture=texture;object.userData.pstudioLightmapId=id;object.userData.pstudioLightmapBakedMatrix=bakedMatrix;baked.push(id);allocatedBytes+=perTextureBytes;
    }catch(error){working?.dispose?.();texture?.dispose?.();failed.push({id,error:String(error?.message||error)});}
    if((baked.length+failed.length)%4===0)await new Promise(resolve=>requestAnimationFrame(resolve));}
    if(renderer&&scene)drawFrame();return{baked:baked.length,failed,meshes:baked,resolution,allocatedBytes,budgetBytes:budget,format:'linear-half-float-rgba',uvLayout:'non-overlapping-per-triangle-atlas',lighting:'spatial-sh-probe-irradiance'};
  }
  function scheduleGeometryBVH(geometry){
    if(!geometry?.computeBoundsTree||geometry.boundsTree||geometry.userData?.pstudioBVHScheduled||
      geometry.userData?.pstudioBVHDisposed||geometry.userData?.pstudioBVHFailed||geometry.userData?.pstudioBVHSkippedSmall)return false;
    geometry.userData=geometry.userData||{};
    const elementCount=Number(geometry.index?.count)||Number(geometry.attributes?.position?.count)||0;
    if(elementCount<768){geometry.userData.pstudioBVHSkippedSmall=true;return false;}
    geometry.userData.pstudioBVHScheduled=true;
    geometry.userData.pstudioBVHDisposed=false;
    const token=(geometry.userData.pstudioBVHToken||0)+1;
    geometry.userData.pstudioBVHToken=token;
    const build=()=>{
      if(geometry.userData.pstudioBVHToken!==token||geometry.userData.pstudioBVHDisposed){
        geometry.userData.pstudioBVHScheduled=false;return;
      }
      if(!geometry.boundsTree){
        try{geometry.computeBoundsTree({maxLeafTris:12});}
        catch(error){
          geometry.userData.pstudioBVHFailed=true;
          console.warn('[PStudio] BVH build skipped; this geometry will use standard raycasting.',error);
        }
      }
      geometry.userData.pstudioBVHScheduled=false;
    };
    if(window.requestIdleCallback)window.requestIdleCallback(build,{timeout:1500});
    else window.setTimeout(build,0);
    return true;
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
    const uniforms=material?.userData?.pstudioProbeUniforms,volume=bakedLightProbeVolume;if(!uniforms||!volume?.length)return;
    const center=new window.THREE.Vector3();object.getWorldPosition(center);
    const grid=volume.pstudioGrid;
    if(grid?.layout==='x-fastest'&&Array.isArray(grid.dims)&&grid.dims.length===3&&grid.min&&grid.max){
      const dims=grid.dims.map(Number),valid=dims.every(v=>Number.isInteger(v)&&v>=2&&v<=4);
      const boundsValid=['x','y','z'].every(axis=>Number.isFinite(Number(grid.min[axis]))&&Number.isFinite(Number(grid.max[axis]))&&Number(grid.max[axis])>Number(grid.min[axis]));
      if(valid&&boundsValid&&volume.length>=dims[0]*dims[1]*dims[2]){
        const axis=(value,min,max,count)=>{const n=Math.max(0,Math.min(1,(value-min)/(max-min)))*(count-1);const lo=Math.floor(n);return{lo,hi:Math.min(count-1,lo+1),t:n-lo};};
        const x=axis(center.x,Number(grid.min.x),Number(grid.max.x),dims[0]);
        const y=axis(center.y,Number(grid.min.y),Number(grid.max.y),dims[1]);
        const z=axis(center.z,Number(grid.min.z),Number(grid.max.z),dims[2]);
        const volumeIndex=(ix,iy,iz)=>(iz*dims[1]+iy)*dims[0]+ix;
        for(let i=0;i<9;i++){
          const out=uniforms[i];out.set(0,0,0);
          for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
            const ix=dx?x.hi:x.lo,iy=dy?y.hi:y.lo,iz=dz?z.hi:z.lo;
            const wx=dx?x.t:1-x.t,wy=dy?y.t:1-y.t,wz=dz?z.t:1-z.t;
            const weight=wx*wy*wz,item=volume[volumeIndex(ix,iy,iz)];
            const coeff=item?.light?.sh?.coefficients?.[i];
            if(coeff&&weight>0)out.addScaledVector(coeff,weight*(Number(item.baseIntensity)||0));
          }
        }
        return;
      }
    }
    // Sparse or legacy probe collections retain the inverse-distance fallback.
    const near=volume.map(item=>({item,d:item.position.distanceToSquared(center)})).sort((a,b)=>a.d-b.d).slice(0,Math.min(4,volume.length));let sum=0;
    for(const entry of near){entry.w=1/Math.max(0.25,entry.d);sum+=entry.w;}
    for(let i=0;i<9;i++){const out=uniforms[i];out.set(0,0,0);for(const entry of near){const coeff=entry.item.light.sh.coefficients[i];if(coeff)out.addScaledVector(coeff,entry.w/Math.max(1e-8,sum)*entry.item.baseIntensity);}}
  }
  function bindObjectProbeLighting(object){if(!object?.isMesh)return;const mats=Array.isArray(object.material)?object.material:[object.material];for(const m of mats)setupLightingMaterial(m);object.onBeforeRender=(r,s,c,g,m)=>updateObjectProbeUniforms(object,m);}
  function hasNamedLODParent(object){
    let node=object;while(node){if(/(?:^|[ _-])LOD[0-9]+(?:$|[ _-])/i.test(String(node.name||'')))return true;node=node.parent;}return false;
  }
  const autoLODQueue=[];
  const autoLODGeometryJobs=new WeakMap();
  let autoLODPumpScheduled=false;
  function scheduleAutoLODPump(){
    if(autoLODPumpScheduled||!autoLODQueue.length)return;
    autoLODPumpScheduled=true;
    const pump=deadline=>{
      autoLODPumpScheduled=false;
      const job=autoLODQueue[0];
      if(!job)return;
      const {geometry,token,count,levels,specs,modifier}=job;
      if(geometry.userData?.pstudioLODToken!==token||geometry.userData?.pstudioLODDisposed){
        if(geometry.userData?.pstudioLODToken===token)geometry.userData.pstudioAutoLODGenerating=false;
        job.done=true;
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
          else{
            lod.computeBoundingSphere?.();
            lod.computeVertexNormals?.();
            levels.push({geometry:lod,distance:spec.distance,owned:true});
          }
        }catch(error){
          console.warn('[PStudio] Automatic LOD generation skipped:',error);
          job.failed=true;
          job.nextSpec=specs.length;
        }
      }
      geometry.userData.pstudioAutoLODLevels=levels;
      if(job.nextSpec<specs.length){scheduleAutoLODPump();return;}
      if(geometry.userData.pstudioLODToken===token&&!geometry.userData.pstudioLODDisposed){
        geometry.userData.pstudioAutoLODGenerating=false;
        job.done=true;
        try{window.PStudioEvents?.emit('render.lod.generated',{trianglesBefore:geometry.index?.count/3||count/3,levels:levels.length,sharedGeometry:true});}catch(_){}
      }else{
        for(const level of levels)if(level.owned)level.geometry.dispose?.();
        job.done=true;
      }
      autoLODQueue.shift();scheduleAutoLODPump();
    };
    if(typeof window.requestIdleCallback==='function')window.requestIdleCallback(pump);
    else window.setTimeout(()=>pump(null),250);
  }
  function scheduleAutoLOD(object,geometry){
    const Modifier=window.PStudioSimplifyModifier,pos=geometry?.attributes?.position,count=pos?.count||0;
    if(!Modifier||!geometry||count<240||count>16000||hasNamedLODParent(object)||object.isSkinnedMesh||geometry.userData?.pstudioLODDisposed)return false;
    geometry.userData=geometry.userData||{};
    const existing=autoLODGeometryJobs.get(geometry);
    if(existing){
      object.userData.pstudioAutoLOD=existing.levels;
      object.userData.pstudioAutoLODBaseGeometry=geometry;
      object.userData.pstudioAutoLODGenerating=!existing.done;
      return true;
    }
    const token=(geometry.userData.pstudioLODToken||0)+1;
    geometry.userData.pstudioLODToken=token;
    const levels=[{geometry,distance:0,owned:false}];
    const job={
      geometry,token,count,levels,
      specs:[
        {keep:0.58,distance:worldRenderConfig.lodDistances[0]||25},
        {keep:0.3,distance:worldRenderConfig.lodDistances[1]||70}
      ],
      nextSpec:0,modifier:new Modifier(),done:false,failed:false
    };
    autoLODGeometryJobs.set(geometry,job);
    geometry.userData.pstudioAutoLODLevels=levels;
    geometry.userData.pstudioAutoLODGenerating=true;
    object.userData.pstudioLODToken=token;
    object.userData.pstudioAutoLOD=levels;
    object.userData.pstudioAutoLODBaseGeometry=geometry;
    object.userData.pstudioAutoLODGenerating=true;
    autoLODQueue.push(job);
    scheduleAutoLODPump();
    return true;
  }
  function markModelGeometryChanged(object){
    const root=object?.userData.modelRoot;
    if(root?.userData)root.userData.pstudioGeometryRevision=(Number(root.userData.pstudioGeometryRevision)||0)+1;
  }
  function applyAutoLOD(object,distance){
    const baseGeometry=object?.userData?.pstudioAutoLODBaseGeometry||object?.geometry;
    const levels=object?.userData?.pstudioAutoLOD||baseGeometry?.userData?.pstudioAutoLODLevels;
    if(!object||!levels||levels.length<2)return;
    let selected=0;
    for(let i=1;i<levels.length;i++)if(distance>=levels[i].distance)selected=i;
    if(object.userData.pstudioActiveAutoLOD===selected)return;
    object.geometry=levels[selected].geometry;
    markModelGeometryChanged(object);
    object.userData.pstudioActiveAutoLOD=selected;
    if(object.isInstancedMesh)object.computeBoundingSphere?.();
  }

  async function buildModelStreamingChunks(root){
    const T=window.THREE,settings=root.userData?.pstudioStreamingConfig||{};
    const cellSize=Math.max(48,Math.min(256,Number(settings.cellSize)||96));
    const configuredLoad=Number(settings.loadDistance),configuredUnload=Number(settings.unloadDistance);
    const loadDistance=Number.isFinite(configuredLoad)&&configuredLoad>0?Math.max(96,Math.min(10000,configuredLoad)):300;
    const unloadDistance=Number.isFinite(configuredUnload)&&configuredUnload>0
      ?Math.max(loadDistance+16,Math.min(12000,configuredUnload)):Math.max(loadDistance+40,340);
    const groups=new Map(),chunks=[];
    root.updateMatrixWorld(true);
    const inverseRoot=root.matrixWorld.clone().invert();
    let processed=0;
    for(const child of [...root.children]){
      const name=String(child.name||'');
      const streamable=/^PStudioInstance_/i.test(name)||/(?:^|[_ -])Wind[_ -]?Tree/i.test(name)||/Wind_Grass|Wildflower_Cover/i.test(name);
      if(!streamable)continue;
      const bounds=new T.Box3().setFromObject(child).applyMatrix4(inverseRoot);
      if(!bounds.isEmpty()){
        const center=bounds.getCenter(new T.Vector3());
        const cellX=Math.floor(center.x/cellSize),cellZ=Math.floor(center.z/cellSize);
        const id=cellX+':'+cellZ;
        if(!groups.has(id))groups.set(id,{id,cellX,cellZ,children:[],bounds:new T.Box3()});
        const group=groups.get(id);
        group.children.push(child);group.bounds.union(bounds);
      }
      if(++processed%2===0)await nextPreparationFrame();
    }
    for(const group of groups.values()){
      const chunk=new T.Group();
      chunk.name='PStudio_StreamChunk_'+group.id.replace(':','_');
      chunk.position.set((group.cellX+.5)*cellSize,0,(group.cellZ+.5)*cellSize);
      const sphere=group.bounds.getBoundingSphere(new T.Sphere());
      chunk.userData.ownerId=root.userData.ownerId;
      chunk.userData.pstudioStreamChunkId=group.id;
      chunk.userData.pstudioStreamBoundsCenter=sphere.center.clone().sub(chunk.position);
      chunk.userData.pstudioStreamRadius=Math.max(cellSize*.74,sphere.radius);
      chunk.userData.pstudioStreamLoadDistance=loadDistance;
      chunk.userData.pstudioStreamUnloadDistance=unloadDistance;
      chunk.userData.pstudioStreamActive=false;chunk.visible=false;
      root.add(chunk);root.updateMatrixWorld(true);
      for(let i=0;i<group.children.length;i++){
        chunk.attach(group.children[i]);
        if(i>0&&i%64===0)await nextPreparationFrame();
      }
      chunks.push(chunk);
      await nextPreparationFrame();
    }
    root.updateMatrixWorld(true);
    return chunks;
  }
  function updateModelStreamingChunks(instance){
    if(!instance?.streamChunks?.length||!camera)return;
    const T=window.THREE;
    instance.root.updateWorldMatrix(true,false);
    const factor=qualityPreset==='mobile' ? 0.72 : qualityPreset==='balanced' ? 0.86 : (adaptiveQualityEnabled ? [0.72,0.86,1.0][adaptiveQualityLevel] : 1.0);
    const cameraPosition=camera.getWorldPosition(new T.Vector3());
    const rootScale=instance.root.getWorldScale(new T.Vector3());
    const scale=Math.max(Math.abs(rootScale.x),Math.abs(rootScale.y),Math.abs(rootScale.z));
    for(const chunk of instance.streamChunks){
      chunk.updateWorldMatrix(true,false);
      const localCenter=chunk.userData.pstudioStreamBoundsCenter;
      const center=localCenter?.isVector3?localCenter.clone().applyMatrix4(chunk.matrixWorld):chunk.getWorldPosition(new T.Vector3());
      const radius=(Number(chunk.userData.pstudioStreamRadius)||0)*scale;
      const distance=Math.max(0,cameraPosition.distanceTo(center)-radius);
      const wasActive=chunk.userData.pstudioStreamActive===true;
      const threshold=wasActive?chunk.userData.pstudioStreamUnloadDistance:chunk.userData.pstudioStreamLoadDistance;
      const inCameraFrustum=!!worldFrustum?.intersectsSphere?.(new T.Sphere(center,radius));
      const active=inCameraFrustum||distance<=threshold*factor;
      chunk.visible=active;
      chunk.userData.pstudioStreamActive=active;
    }
  }

  function collectAnimatedNodeTargets(animations){
    const targets=new Set(),T=window.THREE;
    for(const clip of animations||[])for(const track of clip?.tracks||[]){
      const trackName=String(track?.name||'');
      let nodeName='';
      try{
        const parsed=T.PropertyBinding?.parseTrackName?.(trackName)||T.PropertyBinding?.parse?.(trackName);
        nodeName=String(parsed?.nodeName||'');
      }catch(_){}
      if(!nodeName){
        const match=trackName.match(/^(.+?)(?:\.|\/)(?:position|quaternion|rotation|scale|weights|morphTargetInfluences)(?:\[|$)/i);
        if(match)nodeName=match[1];
      }
      if(nodeName)targets.add(nodeName);
      else targets.add('*');
    }
    return targets;
  }
  function hasAnimatedAncestor(object,root,targets){
    if(targets.has('*'))return true;
    let node=object;
    while(node){
      if(targets.has(String(node.name||''))||targets.has(String(node.uuid||'')))return true;
      if(node===root)break;
      node=node.parent;
    }
    return false;
  }
  function isBatchHierarchyVisible(object,root){
    let node=object;
    while(node){
      if(node.visible===false&&!node.userData?.pstudioStreamChunkId)return false;
      if(node===root)return true;
      node=node.parent;
    }
    return false;
  }
  function supportsGenericStaticInstancing(material,T){
    return !!material&&!material.transparent&&Number(material.opacity??1)>=0.999&&
      Number(material.transmission??0)<=0&&Number(material.thickness??0)<=0&&
      material.depthWrite!==false&&material.blending===T.NormalBlending&&
      !material.isShaderMaterial&&!material.isRawShaderMaterial&&
      !material.userData?.pstudioNoInstancing&&!material.userData?.pstudioNoBatching;
  }
  const staticBatchOriginalRaycast=new WeakMap();
  const skipStaticBatchSourceRaycast=()=>{};
  async function buildFoliageInstanceBatches(root,animations=[]){
    const T=window.THREE,groups=new Map(),batches=[],objects=[];
    const animatedTargets=collectAnimatedNodeTargets(animations);
    const stack=[root];
    let visited=0;
    while(stack.length){
      const object=stack.pop();
      objects.push(object);
      for(let i=object.children.length-1;i>=0;i--)stack.push(object.children[i]);
      if(++visited%192===0)await nextPreparationFrame();
    }
    root.updateMatrixWorld(true);
    for(const object of objects){
      if(!object.isMesh||object.isSkinnedMesh||object.isInstancedMesh)continue;
      const objectName=String(object.name||'');
      const windRole=object.userData?.pstudioWindPart;
      const isWindPart=windRole==='leaf'||windRole==='branch'||windRole==='trunk';
      const isTree=/(?:^|[_ -])Wind[_ -]?Tree/i.test(objectName)||isWindPart;
      const isModularPart=/^PStudioInstance_/i.test(objectName)||object.userData?.pstudioInstanceBatch===true;
      const isGeneric=!isTree&&!isModularPart;
      if(isGeneric){
        const morphTargets=Object.values(object.geometry?.morphAttributes||{}).some(list=>Array.isArray(list)&&list.length>0);
        if(Array.isArray(object.material)||bakedLightProbeVolume?.length||hasAnimatedAncestor(object,root,animatedTargets)||
          !isBatchHierarchyVisible(object,root)||object.children.length>0||hasNamedLODParent(object)||
          object.morphTargetInfluences?.length||morphTargets||object.frustumCulled===false||
          object.customDepthMaterial||object.customDistanceMaterial||
          object.userData?.pstudioNoInstancing||object.userData?.pstudioNoBatching||
          object.userData?.pstudioWaterSurface||object.userData?.pstudioWaterDetail||
          object.userData?.pstudioWindPart)continue;
      }
      const materials=Array.isArray(object.material)?object.material:[object.material];
      if(materials.length!==1||!object.geometry||!materials[0])continue;
      if(isGeneric&&!supportsGenericStaticInstancing(materials[0],T))continue;
      let levelMatch=objectName.match(/LOD([0-9]+)/i);
      let parent=object.parent;
      while(!levelMatch&&parent&&parent!==root){levelMatch=String(parent.name||'').match(/LOD([0-9]+)/i);parent=parent.parent;}
      const level=levelMatch?Number(levelMatch[1]):(isWindPart?0:null);
      let streamParent=object.parent;
      while(streamParent&&streamParent!==root&&!streamParent.userData?.pstudioStreamChunkId)streamParent=streamParent.parent;
      if(!streamParent||streamParent===root)streamParent=root;
      const chunkId=streamParent.userData?.pstudioStreamChunkId||'GLOBAL';
      const optionKey=[
        object.renderOrder||0,
        object.layers?.mask??1,
        object.castShadow?1:0,
        object.receiveShadow?1:0
      ].join(':');
      const kind=isTree?'TREE':isModularPart?'MARKED_STATIC':'GENERIC_STATIC';
      const key=object.geometry.uuid+'|'+materials[0].uuid+'|'+(level===null?'STATIC':'LOD'+level)+'|'+chunkId+'|'+kind+'|'+optionKey;
      if(!groups.has(key))groups.set(key,{
        sources:[],level,isTree,isGeneric,parent:streamParent,
        castShadow:!!object.castShadow,receiveShadow:!!object.receiveShadow,
        renderOrder:object.renderOrder||0,layersMask:object.layers?.mask??1
      });
      groups.get(key).sources.push(object);
    }
    const matrix=new T.Matrix4();
    let groupIndex=0,totalInstancedSources=0,genericInstancedSources=0;
    for(const group of groups.values()){
      const sources=group.sources,level=group.level,parent=group.parent;
      if(sources.length<3)continue;
      parent.updateWorldMatrix(true,true);
      const inverseParent=parent.matrixWorld.clone().invert();
      const first=sources[0],batch=new T.InstancedMesh(first.geometry,first.material,sources.length);
      batch.name='PStudio_GPU_Instances_'+(group.isTree?'Foliage_Level'+level:group.isGeneric?'Generic_Static':'Architecture_Static');
      batch.castShadow=group.castShadow;
      batch.receiveShadow=group.receiveShadow;
      batch.frustumCulled=true;
      batch.renderOrder=group.renderOrder;
      batch.layers.mask=group.layersMask;
      batch.userData.ownerId=root.userData.ownerId;
      batch.userData.modelRoot=root;
      batch.userData.pstudioStreamChunkId=parent.userData?.pstudioStreamChunkId||null;
      batch.userData.pstudioFoliageLOD=level;
      batch.userData.pstudioInstanceBatch=!group.isTree;
      batch.userData.pstudioGenericStaticInstances=!!group.isGeneric;
      batch.userData.pstudioAutoLOD=first.userData.pstudioAutoLOD||first.geometry.userData?.pstudioAutoLODLevels||null;
      batch.userData.pstudioAutoLODBaseGeometry=first.userData.pstudioAutoLODBaseGeometry||first.geometry;
      batch.userData.instanceOwnerIds=new Array(sources.length).fill(root.userData.ownerId);
      batch.userData.pstudioFoliageSources=sources;
      batch.visible=level===null||level===0;
      parent.add(batch);
      for(let i=0;i<sources.length;i++){
        const source=sources[i];
        source.updateWorldMatrix(true,false);
        matrix.multiplyMatrices(inverseParent,source.matrixWorld);
        batch.setMatrixAt(i,matrix);
        source.visible=false;
        if(group.isGeneric){
          source.userData.pstudioBatchedIntoStaticInstance=true;
          if(!staticBatchOriginalRaycast.has(source))staticBatchOriginalRaycast.set(source,source.raycast);
          source.raycast=skipStaticBatchSourceRaycast;
        }
        if(i>0&&i%128===0)await nextPreparationFrame();
      }
      batch.instanceMatrix.setUsage(group.isTree?T.DynamicDrawUsage:T.StaticDrawUsage);
      batch.instanceMatrix.needsUpdate=true;
      batch.computeBoundingSphere();
      enableGPUFrustumCullingForBatch(batch);
      batches.push({mesh:batch,sources,level,isTree:group.isTree,isGeneric:!!group.isGeneric,parent});
      totalInstancedSources+=sources.length;
      if(group.isGeneric)genericInstancedSources+=sources.length;
      if(++groupIndex%2===0)await nextPreparationFrame();
    }
    if(totalInstancedSources){
      try{window.PStudioEvents?.emit('render.instances.batched',{
        totalSources:totalInstancedSources,genericStaticSources:genericInstancedSources,
        batchCount:batches.length,estimatedDrawCallsSaved:totalInstancedSources-batches.length
      });}catch(_){}
    }
    return batches;
  }
  function updateFoliageInstanceBatches(instance){
    const entries=instance?.animatedFoliageBatches;
    if(!entries?.length)return;
    const T=window.THREE,root=instance.root,matrix=new T.Matrix4();
    for(const entry of entries){
      if(!entry.mesh.visible||!(entry.parent||root).visible)continue;
      const batch=entry.mesh,parent=entry.parent||root;parent.updateWorldMatrix(true,false);
      const inverseParent=parent.matrixWorld.clone().invert();
      for(let i=0;i<entry.sources.length;i++){const source=entry.sources[i];source.updateWorldMatrix(true,false);matrix.multiplyMatrices(inverseParent,source.matrixWorld);batch.setMatrixAt(i,matrix);}
      batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();
    }
  }

  async function cloneModelHierarchyAsync(sourceRoot){
    const pairs=[],clones=new Map();
    const rootClone=sourceRoot.clone(false);
    pairs.push({source:sourceRoot,clone:rootClone});
    clones.set(sourceRoot,rootClone);
    for(let cursor=0;cursor<pairs.length;cursor++){
      const pair=pairs[cursor];
      for(const child of pair.source.children){
        const childClone=child.clone(false);
        pair.clone.add(childClone);
        clones.set(child,childClone);
        pairs.push({source:child,clone:childClone});
      }
      if((cursor+1)%64===0)await nextPreparationFrame();
    }
    for(let i=0;i<pairs.length;i++){
      const {source,clone}=pairs[i];
      if(source.isSkinnedMesh&&source.skeleton){
        const bones=source.skeleton.bones.map(bone=>clones.get(bone));
        if(bones.every(Boolean)){
          const inverses=source.skeleton.boneInverses.map(matrix=>matrix.clone());
          const skeleton=new window.THREE.Skeleton(bones,inverses);
          clone.bind(skeleton,source.bindMatrix.clone());
          clone.bindMode=source.bindMode;
          clone.bindMatrixInverse.copy(source.bindMatrixInverse);
        }
      }
      if((i+1)%96===0)await nextPreparationFrame();
    }
    const T=window.THREE;
    for(let i=0;i<pairs.length;i++){
      const {clone}=pairs[i];
      if(clone.matrixAutoUpdate)clone.updateMatrix();
      if(clone.parent)clone.matrixWorld.multiplyMatrices(clone.parent.matrixWorld,clone.matrix);
      else clone.matrixWorld.copy(clone.matrix);
      clone.matrixWorldNeedsUpdate=false;
      if((i+1)%192===0)await nextPreparationFrame();
    }
    return{root:rootClone,pairs};
  }

  async function createModelInstanceAsync(key,ownerId,name,asset,resourceLease=null,onPhase=()=>{}){
    const T=window.THREE;
    onPhase('hierarchy-clone');
    const {root:clone,pairs}=await cloneModelHierarchyAsync(asset.scene);
    onPhase('material-and-shader-setup');
    const materialDefaults=new Map(),materialClones=new Map(),meshes=[],geometryOriginals=new Map(),normalGeometryClones=new Map();
    let environmentQuality=null;
    for(let i=0;i<pairs.length;i++){
      const {clone:object}=pairs[i],extras=object.userData||{};
      if(extras.pstudioAutoPlayAnimation&&!clone.userData.pstudioAutoPlayAnimation)clone.userData.pstudioAutoPlayAnimation=extras.pstudioAutoPlayAnimation;
      if(extras.pstudioStreamingConfig&&!clone.userData.pstudioStreamingConfig)clone.userData.pstudioStreamingConfig=extras.pstudioStreamingConfig;
      if(extras.pstudioEnvironmentQuality&&!environmentQuality)environmentQuality=extras.pstudioEnvironmentQuality;
      object.userData.ownerId=ownerId;
      object.userData.modelRoot=clone;
      if(object.isMesh&&object.material){
        meshes.push(object);
        object.frustumCulled=!(object.isSkinnedMesh||(object.morphTargetInfluences?.length>0));
        scheduleAutoLOD(object,object.geometry);
        scheduleGeometryBVH(object.geometry);
        object.castShadow=true;object.receiveShadow=true;
        const cloneMaterial=material=>{
          const windRole=String(object.userData?.pstudioWindPart||'');
          const waterDetailRole=String(object.userData?.pstudioWaterDetail||'');
          const roleKey=[windRole?'wind:'+windRole:'',waterDetailRole?'water-detail:'+waterDetailRole:''].filter(Boolean).join('|');
          const cacheKey=roleKey?(material.uuid+'|pstudio-role:'+roleKey):material;
          let copy=materialClones.get(cacheKey);
          if(copy)return copy;
          copy=material.clone();setupLightingMaterial(copy);
          materialDefaults.set(copy,{
            roughness:Number.isFinite(material.roughness)?material.roughness:0.72,
            metalness:Number.isFinite(material.metalness)?material.metalness:0.04,
            color:material.color?.clone?.()||null,
            emissive:material.emissive?.clone?.()||null,
            emissiveIntensity:Number.isFinite(material.emissiveIntensity)?material.emissiveIntensity:1,
            side:material.side??T.FrontSide
          });
          materialClones.set(cacheKey,copy);
          return copy;
        };
        object.material=Array.isArray(object.material)?object.material.map(cloneMaterial):cloneMaterial(object.material);
        window.PStudioEnvironmentFX?.configureObject?.(object);
        for(const configured of (Array.isArray(object.material)?object.material:[object.material])){
          if(configured&&!materialDefaults.has(configured))materialDefaults.set(configured,{
            roughness:Number.isFinite(configured.roughness)?configured.roughness:0.72,
            metalness:Number.isFinite(configured.metalness)?configured.metalness:0.04
          });
        }
        bindObjectProbeLighting(object);
        for(const configured of (Array.isArray(object.material)?object.material:[object.material]))if(configured){setupVirtualTextureMaterial(configured);setupClusteredLightingMaterial(configured);}
      }
      if((i+1)%96===0){
        dispatchModelLoadProgress({name,stage:'instance-clone-and-materials',loaded:i+1,total:pairs.length,progress:(i+1)/pairs.length});
        await nextPreparationFrame();
      }
    }
    clone.updateMatrixWorld(true);
    onPhase('bounds-and-lod-build');
    const bounds=new T.Box3(),inverseRoot=clone.matrixWorld.clone().invert(),relativeMatrix=new T.Matrix4();
    for(let i=0;i<pairs.length;i++){
      const object=pairs[i].clone;
      if(object.isMesh&&object.geometry){
        if(!object.geometry.boundingBox)object.geometry.computeBoundingBox?.();
        if(object.geometry.boundingBox){
          relativeMatrix.multiplyMatrices(inverseRoot,object.matrixWorld);
          bounds.union(object.geometry.boundingBox.clone().applyMatrix4(relativeMatrix));
        }
      }
      if((i+1)%128===0)await nextPreparationFrame();
    }
    if(bounds.isEmpty())bounds.setFromCenterAndSize(new T.Vector3(),new T.Vector3(1,1,1));
    const modelSphere=bounds.getBoundingSphere(new T.Sphere());
    clone.userData.pstudioBoundsRadius=Number.isFinite(modelSphere.radius)?modelSphere.radius:0;
    clone.userData.pstudioBoundsCenter=modelSphere.center.clone();
    clone.userData.pstudioHighComplexity=meshes.length>256;
    onPhase('streaming-chunk-build');
    const streamChunks=await buildModelStreamingChunks(clone);
    onPhase('gpu-instancing-build');
    const foliageBatches=await buildFoliageInstanceBatches(clone,asset.animations||[]);
    for(const entry of foliageBatches){
      const sourceMaterials=Array.isArray(entry.sources?.[0]?.material)?entry.sources[0].material:[entry.sources?.[0]?.material];
      const batchMaterials=Array.isArray(entry.mesh?.material)?entry.mesh.material:[entry.mesh?.material];
      for(let i=0;i<batchMaterials.length;i++){
        const sourceMaterial=sourceMaterials[i]||sourceMaterials[0],batchMaterial=batchMaterials[i];
        const defaults=sourceMaterial&&materialDefaults.get(sourceMaterial);
        if(defaults&&batchMaterial)materialDefaults.set(batchMaterial,{...defaults});
      }
    }
    const lodMap=new Map();
    for(let i=0;i<pairs.length;i++){
      const object=pairs[i].clone;
      const match=String(object.name||'').match(/(?:^|[ _-])LOD([0-9]+)(?:$|[ _-])/i);
      if(match){
        const level=Number(match[1]);
        if(!lodMap.has(level))lodMap.set(level,[]);
        lodMap.get(level).push({object,visible:object.visible});
      }
      if((i+1)%192===0)await nextPreparationFrame();
    }
    const lodLevels=[...lodMap.entries()].sort((a,b)=>a[0]-b[0]).map(([level,entries])=>({level,entries}));
    onPhase('animation-initialization');
    const mixer=asset.animations.length?new T.AnimationMixer(clone):null;
    const autoClipName=String(clone.userData?.pstudioAutoPlayAnimation||'');
    const autoClip=autoClipName?asset.animations.find(item=>item.name===autoClipName)||asset.animations.find(item=>item.name.toLowerCase().includes(autoClipName.toLowerCase())):null;
    if(mixer&&autoClip){const action=mixer.clipAction(autoClip);action.reset().setLoop(T.LoopRepeat,Infinity).play();}
    return{
      key,ownerId,name,root:clone,meshes,mixer,animations:asset.animations,
      materialDefaults,lodLevels,localBoundsCenter:modelSphere.center.clone(),
      activeLOD:null,activeClip:autoClip?.name||null,activeLoop:true,speed:1,
      resourceLease,materialStateSignature:null,foliageBatches,streamChunks,geometryOriginals,normalGeometryClones,
      preparing:true,preparationCancelled:false,environmentQuality,occlusionEligible:meshes.length<=256,
      animatedFoliageBatches:foliageBatches.filter(entry=>entry.isTree)
    };
  }

  function nextPreparationFrame(){return new Promise(resolve=>window.requestAnimationFrame(()=>resolve()));}
  function collectModelTextures(root){
    const textures=new Set();
    const visit=(value,depth=0)=>{
      if(!value||depth>3)return;
      if(value.isTexture){textures.add(value);return;}
      if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}
      if(typeof value==='object'&&Object.prototype.hasOwnProperty.call(value,'value'))visit(value.value,depth+1);
    };
    root.traverse(object=>{
      if(!object.isMesh||!object.material)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){
        if(!material)continue;
        for(const value of Object.values(material))visit(value);
        for(const value of Object.values(material.uniforms||{}))visit(value);
        for(const slot of Object.keys(VIRTUAL_TEXTURE_UV_VARYINGS)){
          const record=material[slot]?.userData?.pstudioVirtualTexture;
          if(record){visit(record.atlas?.texture);visit(record.pageTableTexture);}
        }
      }
    });
    return [...textures];
  }
  function modelObjectEffectivelyVisible(object,root){
    let node=object;
    while(node){
      if(node.visible===false)return false;
      if(node===root)return true;
      node=node.parent;
    }
    return false;
  }
  function getModelVisibilityDiagnostics(instance){
    const root=instance?.root,T=window.THREE;
    if(!root||!T)return null;
    root.updateWorldMatrix(true,false);
    const center=(instance.localBoundsCenter?.clone?.()||new T.Vector3()).applyMatrix4(root.matrixWorld);
    const rootScale=root.getWorldScale(new T.Vector3());
    const radius=(Number(root.userData?.pstudioBoundsRadius)||0)*Math.max(Math.abs(rootScale.x),Math.abs(rootScale.y),Math.abs(rootScale.z));
    const cameraPosition=camera?.getWorldPosition(new T.Vector3())||new T.Vector3();
    const cameraDistanceToBounds=camera?Math.max(0,cameraPosition.distanceTo(center)-radius):null;
    let visibleMeshes=0,totalMeshes=0;
    root.traverse(object=>{
      if(!object.isMesh||!object.geometry)return;
      totalMeshes++;
      if(modelObjectEffectivelyVisible(object,root))visibleMeshes++;
    });
    const streamChunks=instance.streamChunks||[];
    const activeStreamChunks=streamChunks.filter(chunk=>chunk.userData?.pstudioStreamActive===true).length;
    return{
      ownerId:String(instance.ownerId),rootVisible:!!root.visible,preparing:!!instance.preparing,
      withinDrawDistance:camera?isWithinWorldDrawDistance(root,worldRenderConfig.maxDrawDistance):null,
      boundsInCameraFrustum:!!(camera&&worldFrustum?.intersectsSphere?.(new T.Sphere(center,radius))),
      cameraDistanceToBounds,maxDrawDistance:worldRenderConfig.maxDrawDistance,
      boundsRadius:radius,meshCount:totalMeshes,visibleMeshes,
      streamChunkCount:streamChunks.length,activeStreamChunks
    };
  }
  async function prepareModelInstance(instance){
    if(!instance)return;
    modelPreparationPending++;
    try{
      await nextPreparationFrame();
      if(instance.preparationCancelled)return;
      const textures=collectModelTextures(instance.root);
      let uploaded=0;
      for(const texture of textures){
        if(instance.preparationCancelled)return;
        try{renderer?.initTexture?.(texture);stagedTextureUploads++;}
        catch(error){console.warn('[PStudio] Staged texture upload deferred to normal renderer path:',error);}
        uploaded++;
        dispatchModelLoadProgress({name:instance.name,stage:'gpu-textures',loaded:uploaded,total:textures.length,progress:textures.length?uploaded/textures.length:1});
        if(uploaded<textures.length)await nextPreparationFrame();
      }
      if(instance.preparationCancelled)return;
      if(parallelShaderCompileSupported&&typeof renderer?.compileAsync==='function'&&scene&&camera){
        const compile=async()=>{
          if(instance.preparationCancelled||modelInstances.get(instance.key)!==instance)return;
          dispatchModelLoadProgress({name:instance.name,stage:'shader-precompile',progress:0});
          await renderer.compileAsync(instance.root,camera,scene);
        };
        const queued=shaderCompileQueue.then(compile,compile);
        shaderCompileQueue=queued.catch(error=>console.warn('[PStudio] Parallel shader precompile was skipped:',error));
        await queued;
      }
      if(instance.preparationCancelled||modelInstances.get(instance.key)!==instance)return;
      instance.preparing=false;
      dispatchModelLoadProgress({name:instance.name,stage:'prepared',loaded:textures.length,total:textures.length,progress:1});
      window.requestAnimationFrame(()=>{
        if(instance.preparationCancelled||modelInstances.get(instance.key)!==instance)return;
        try{
          if(lastCommands)render(lastCommands);else{updateWorldVisibility();drawFrame();}
          const diagnostics=getModelVisibilityDiagnostics(instance);
          try{window.dispatchEvent(new CustomEvent('pstudio-model-visibility',{detail:{name:instance.name,...diagnostics}}));}catch(_){}
        }catch(error){
          console.error('[PStudio] Prepared model render failed:',error);
          dispatchModelLoadError({name:instance.name,stage:'scene-render',error:String(error?.message||error),stack:error?.stack||'',retryable:true});
        }
      });
    }catch(error){
      const message=String(error?.message||error);
      console.warn('[PStudio] Model preparation used deferred renderer fallback:',error);
      if(!instance.preparationCancelled&&modelInstances.get(instance.key)===instance){
        // The model was hidden while its GPU preparation was pending. If shader
        // compilation fails, release that gate and explicitly redraw the idle editor.
        instance.preparing=false;
        dispatchModelLoadProgress({name:instance.name,stage:'gpu-preparation-fallback',reason:message});
        if(!window.PStudioEngine?.isRunning?.()){
          window.requestAnimationFrame(()=>{
            if(instance.preparationCancelled||modelInstances.get(instance.key)!==instance)return;
            try{if(lastCommands)render(lastCommands);else{updateWorldVisibility();drawFrame();}}
            catch(renderError){
              console.error('[PStudio] Model fallback render failed:',instance.name,renderError);
              dispatchModelLoadError({name:instance.name,stage:'gpu-preparation-fallback-render',error:renderError?.message||String(renderError),retryable:true});
            }
          });
        }
      }
    }finally{modelPreparationPending=Math.max(0,modelPreparationPending-1);}
  }

  function createMoonSurfaceTexture(T){
    const canvas=document.createElement('canvas');
    canvas.width=1024;canvas.height=512;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Canvas 2D context is unavailable for the lunar surface texture.');
    let seed=0x4d4f4f4e;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const image=context.createImageData(canvas.width,canvas.height);
    for(let i=0;i<image.data.length;i+=4){
      const noise=(random()-.5)*24;
      const tone=174+noise;
      image.data[i]=tone*.96;image.data[i+1]=tone*.99;image.data[i+2]=Math.min(255,tone+12);image.data[i+3]=255;
    }
    context.putImageData(image,0,0);
    for(let i=0;i<220;i++){
      const x=random()*canvas.width,y=28+random()*(canvas.height-56);
      const radius=4+Math.pow(random(),2)*26;
      const shadow=context.createRadialGradient(x-radius*.22,y-radius*.22,radius*.08,x,y,radius);
      shadow.addColorStop(0,'rgba(57,69,88,0.12)');
      shadow.addColorStop(.68,'rgba(70,82,101,0.19)');
      shadow.addColorStop(.9,'rgba(238,243,250,0.18)');
      shadow.addColorStop(1,'rgba(244,247,252,0.02)');
      context.fillStyle=shadow;context.beginPath();context.arc(x,y,radius,0,Math.PI*2);context.fill();
    }
    context.save();
    for(let i=0;i<620;i++){
      const x=random()*canvas.width,y=18+random()*(canvas.height-36),radius=.55+random()*3.2;
      context.fillStyle='rgba(55,67,86,'+(0.025+random()*.055).toFixed(3)+')';
      context.beginPath();context.arc(x,y,radius,0,Math.PI*2);context.fill();
    }
    context.restore();
    const texture=new T.CanvasTexture(canvas);
    texture.colorSpace=T.SRGBColorSpace;
    texture.wrapS=T.RepeatWrapping;texture.wrapT=T.ClampToEdgeWrapping;
    texture.anisotropy=Math.min(4,renderer?.capabilities?.getMaxAnisotropy?.()||1);
    texture.needsUpdate=true;
    return texture;
  }
  function ensureMoonMesh(T){
    if(!scene)return null;
    if(moonMesh?.parent===scene)return moonMesh;
    if(!moonSurfaceTexture)moonSurfaceTexture=createMoonSurfaceTexture(T);
    if(!moonDirection)moonDirection=new T.Vector3();
    if(!moonLightDirection)moonLightDirection=new T.Vector3();
    if(!moonMesh){
      const geometry=new T.SphereGeometry(1,48,32);
      const material=new T.ShaderMaterial({
        uniforms:{
          uMoonMap:{value:moonSurfaceTexture},
          uLightDirectionWorld:{value:new T.Vector3(0,-1,0)},
          uMoonIntensity:{value:1},
      uMoonGlare:{value:0}
        },
        vertexShader:`varying vec2 vMoonUv;
varying vec3 vMoonNormalWorld;
void main(){
  vMoonUv=uv;
  vMoonNormalWorld=normalize(mat3(modelMatrix)*normal);
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}`,
        fragmentShader:`uniform sampler2D uMoonMap;
uniform vec3 uLightDirectionWorld;
uniform float uMoonIntensity;
uniform float uMoonGlare;
varying vec2 vMoonUv;
varying vec3 vMoonNormalWorld;
void main(){
  vec3 normal=normalize(vMoonNormalWorld);
  vec3 lightDirection=normalize(uLightDirectionWorld);
  float ndl=dot(normal,lightDirection);
  float illumination=0.11+max(ndl,0.0)*1.28;
  float terminator=smoothstep(-0.12,0.08,ndl);
  vec3 lunar=texture2D(uMoonMap,vMoonUv).rgb;
  vec3 color=lunar*illumination;
  color*=mix(0.32,1.0,terminator);
  color*=uMoonIntensity;
  color+=vec3(0.34,0.46,0.68)*uMoonGlare*0.24;
  gl_FragColor=vec4(color,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
        depthTest:true,depthWrite:false,transparent:false,fog:false
      });
      moonMesh=new T.Mesh(geometry,material);
      moonMesh.name='PStudioMoonSphere';
      moonMesh.frustumCulled=false;
      moonMesh.renderOrder=1;
    }else if(moonMesh.parent)moonMesh.parent.remove(moonMesh);
    scene.add(moonMesh);
    return moonMesh;
  }
  function configureMoonSky(T,profile){
    moonIntensity=Math.max(0,Math.min(1.5,Number(profile.moonIntensity)||0));
    if(profile.name!=='night'||moonIntensity<=.001){
      if(moonMesh)moonMesh.visible=false;
      return false;
    }
    let mesh=null;
    try{mesh=ensureMoonMesh(T);}
    catch(error){
      if(moonMesh)moonMesh.visible=false;
      console.warn('[PStudio] Lunar sphere setup failed; retaining the procedural night sky without the moon.',error);
      return false;
    }
    if(!mesh)return false;
    moonDirection.set(
      Number.isFinite(Number(profile.moonDirectionX))?Number(profile.moonDirectionX):.38,
      Number.isFinite(Number(profile.moonDirectionY))?Number(profile.moonDirectionY):.88,
      Number.isFinite(Number(profile.moonDirectionZ))?Number(profile.moonDirectionZ):.27
    );
    if(moonDirection.lengthSq()<1e-8)moonDirection.set(.38,.88,.27);
    moonDirection.normalize();
    const phase=Math.max(0,Math.min(1,Number.isFinite(Number(profile.moonPhase))?Number(profile.moonPhase):.84));
    const phaseAngle=Math.acos(2*phase-1);
    const tangent=new T.Vector3().crossVectors(new T.Vector3(0,1,0),moonDirection);
    if(tangent.lengthSq()<1e-8)tangent.set(1,0,0).cross(moonDirection);
    tangent.normalize();
    moonLightDirection.copy(moonDirection).negate().multiplyScalar(Math.cos(phaseAngle))
      .addScaledVector(tangent,Math.sin(phaseAngle)).normalize();
    mesh.material.uniforms.uLightDirectionWorld.value.copy(moonLightDirection);
    mesh.material.uniforms.uMoonIntensity.value=moonIntensity;
    mesh.material.uniforms.uMoonGlare.value=0;
    moonGlareStrength=0;
    mesh.visible=true;
    return true;
  }
  function updateMoonSkyMesh(){
    if(!moonMesh||!camera)return;
    const hdrBackgroundVisible=!!(hdrTexture&&hdrShowBackground);
    moonMesh.visible=activeEnvironmentPreset==='night'&&moonIntensity>.001&&!hdrBackgroundVisible;
    if(!moonMesh.visible||!moonDirection)return;
    const distance=Math.max(camera.near+2,camera.far*.88);
    const radius=distance*Math.tan(1.9*Math.PI/180);
    moonMesh.position.copy(camera.position).addScaledVector(moonDirection,distance);
    moonMesh.scale.setScalar(radius);
    if(!sunViewDirection)sunViewDirection=new window.THREE.Vector3();
    camera.getWorldDirection(sunViewDirection);
    const viewAlignment=Math.max(0,Math.min(1,sunViewDirection.dot(moonDirection)));
    const focus=Math.max(0,Math.min(1,(viewAlignment-Math.cos(9*Math.PI/180))/(1-Math.cos(9*Math.PI/180))));
    const targetGlow=focus*0.48;
    moonGlareStrength+=(targetGlow-moonGlareStrength)*0.075;
    if(moonMesh.material?.uniforms?.uMoonGlare)moonMesh.material.uniforms.uMoonGlare.value=moonGlareStrength;
  }

  function createSunSurfaceTexture(T){
    const canvas=document.createElement('canvas');
    canvas.width=512;canvas.height=256;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Canvas 2D context is unavailable for the solar photosphere texture.');
    let seed=0x53554e32;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const image=context.createImageData(canvas.width,canvas.height);
    for(let y=0;y<canvas.height;y++){
      for(let x=0;x<canvas.width;x++){
        const u=x/canvas.width,v=y/canvas.height;
        const broad=Math.sin(u*31+Math.sin(v*13)*2.1)*Math.cos(v*19+u*7);
        const medium=Math.sin(u*137+Math.cos(v*67))*Math.sin(v*91+u*43);
        const fine=(random()-.5)*.22;
        const granulation=Math.max(0,Math.min(1,.53+broad*.12+medium*.15+fine));
        const value=188+granulation*59;
        const i=(y*canvas.width+x)*4;
        image.data[i]=value;image.data[i+1]=value;image.data[i+2]=value;image.data[i+3]=255;
      }
    }
    context.putImageData(image,0,0);
    context.save();
    context.globalCompositeOperation='screen';
    for(let i=0;i<420;i++){
      const x=random()*canvas.width,y=random()*canvas.height,radius=.5+random()*4.2;
      const glow=context.createRadialGradient(x,y,0,x,y,radius);
      glow.addColorStop(0,'rgba(255,255,255,'+(0.07+random()*.13)+')');
      glow.addColorStop(1,'rgba(255,255,255,0)');
      context.fillStyle=glow;
      context.beginPath();context.arc(x,y,radius,0,Math.PI*2);context.fill();
    }
    context.restore();
    for(let i=0;i<7;i++){
      const x=42+random()*(canvas.width-84),y=24+random()*(canvas.height-48);
      const radius=3+random()*6;
      const spot=context.createRadialGradient(x,y,radius*.12,x,y,radius);
      spot.addColorStop(0,'rgba(45,32,25,0.26)');
      spot.addColorStop(.72,'rgba(74,52,37,0.13)');
      spot.addColorStop(1,'rgba(74,52,37,0)');
      context.fillStyle=spot;context.beginPath();context.arc(x,y,radius,0,Math.PI*2);context.fill();
    }
    const texture=new T.CanvasTexture(canvas);
    texture.generateMipmaps=true;
    texture.minFilter=T.LinearMipmapLinearFilter;
    texture.magFilter=T.LinearFilter;
    texture.anisotropy=Math.min(4,renderer?.capabilities?.getMaxAnisotropy?.()||1);
    texture.needsUpdate=true;
    return texture;
  }
  function ensureSunMesh(T){
    if(!scene)return null;
    if(sunMesh?.parent===scene)return sunMesh;
    if(!sunSurfaceTexture)sunSurfaceTexture=createSunSurfaceTexture(T);
    if(!sunDirection)sunDirection=new T.Vector3();
    if(!sunMesh){
      const geometry=new T.SphereGeometry(1,48,32);
      const material=new T.ShaderMaterial({
        uniforms:{
          uSunMap:{value:sunSurfaceTexture},
          uSunColor:{value:new T.Color('#FFF4DD')},
          uSunIntensity:{value:1.12},
          uSolarGlare:{value:0}
        },
        vertexShader:[
          'varying vec2 vSunUv;',
          'varying vec3 vSunNormalWorld;',
          'varying vec3 vSunWorldPosition;',
          'void main(){',
          'vSunUv=uv;',
          'vSunNormalWorld=normalize(mat3(modelMatrix)*normal);',
          'vSunWorldPosition=(modelMatrix*vec4(position,1.0)).xyz;',
          'gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
          '}'
        ].join('\n'),
        fragmentShader:[
          'uniform sampler2D uSunMap;',
          'uniform vec3 uSunColor;',
          'uniform float uSunIntensity;',
          'uniform float uSolarGlare;',
          'varying vec2 vSunUv;',
          'varying vec3 vSunNormalWorld;',
          'varying vec3 vSunWorldPosition;',
          'void main(){',
          'vec3 normal=normalize(vSunNormalWorld);',
          'vec3 viewDirection=normalize(cameraPosition-vSunWorldPosition);',
          'float facing=clamp(dot(normal,viewDirection),0.0,1.0);',
          'float limb=.68+.32*sqrt(facing);',
          'float granulation=texture2D(uSunMap,vSunUv).r;',
          'float surface=mix(.91,1.075,granulation);',
          'float hotCore=pow(facing,16.0);',
          'vec3 color=mix(uSunColor*.78,vec3(1.0,.985,.91),hotCore*.34);',
          'color*=limb*surface*uSunIntensity;',
          'color+=uSunColor*hotCore*(.12+uSolarGlare*.82);',
          'gl_FragColor=vec4(color,1.0);',
          '#include <colorspace_fragment>',
          '}'
        ].join('\n'),
        depthTest:true,depthWrite:false,transparent:false,fog:false,toneMapped:false
      });
      sunMesh=new T.Mesh(geometry,material);
      sunMesh.name='PStudioSunSphere';
      sunMesh.frustumCulled=false;
      sunMesh.renderOrder=1;
    }else if(sunMesh.parent)sunMesh.parent.remove(sunMesh);
    scene.add(sunMesh);
    return sunMesh;
  }
  function configureSunSky(T,profile){
    const isDaylight=profile.name==='day'||profile.name==='dusk';
    sunIntensity=Math.max(0,Math.min(2,Number(profile.sunIntensity)||0));
    sunAngularRadius=Math.max(.2,Math.min(4,Number(profile.sunAngularRadius)||1.2));
    if(!isDaylight||sunIntensity<=.001||Number(profile.sunRadius)<=0){
      if(sunMesh)sunMesh.visible=false;
      sunGlareStrength=0;
      return false;
    }
    let mesh=null;
    try{mesh=ensureSunMesh(T);}
    catch(error){
      if(sunMesh)sunMesh.visible=false;
      console.warn('[PStudio] Solar sphere setup failed; atmospheric scattering remains visible.',error);
      return false;
    }
    if(!mesh)return false;
    if(!sunViewDirection)sunViewDirection=new T.Vector3();
    sunDirection.set(
      Number.isFinite(Number(profile.skySunX))?Number(profile.skySunX):-Number(profile.lightX||0),
      Number.isFinite(Number(profile.skySunY))?Number(profile.skySunY):-Number(profile.lightY||-1),
      Number.isFinite(Number(profile.skySunZ))?Number(profile.skySunZ):-Number(profile.lightZ||0)
    );
    if(sunDirection.lengthSq()<1e-8)sunDirection.set(.35,.89,.28);
    sunDirection.normalize();
    mesh.material.uniforms.uSunColor.value.set(profile.sunColor||profile.atmosphereSunColor||profile.lightColor||'#FFF4DD');
    mesh.material.uniforms.uSunIntensity.value=sunIntensity;
    mesh.visible=true;
    return true;
  }
  function updateSunSkyMesh(){
    if(!sunMesh||!camera)return;
    const hdrBackgroundVisible=!!(hdrTexture&&hdrShowBackground);
    sunMesh.visible=(activeEnvironmentPreset==='day'||activeEnvironmentPreset==='dusk')&&sunIntensity>.001&&!hdrBackgroundVisible;
    if(!sunMesh.visible||!sunDirection)return;
    const distance=Math.max(camera.near+2,camera.far*.88);
    const radius=distance*Math.tan(sunAngularRadius*Math.PI/180);
    sunMesh.position.copy(camera.position).addScaledVector(sunDirection,distance);
    sunMesh.scale.setScalar(radius);
    if(!sunViewDirection)sunViewDirection=new window.THREE.Vector3();
    camera.getWorldDirection(sunViewDirection);
    const alignment=Math.max(0,Math.min(1,sunViewDirection.dot(sunDirection)));
    const normalized=Math.max(0,Math.min(1,(alignment-Math.cos(10*Math.PI/180))/(1-Math.cos(10*Math.PI/180))));
    const targetGlare=normalized*normalized*(3-2*normalized)*0.92;
    sunGlareStrength+=(targetGlare-sunGlareStrength)*0.075;
    const glareUniform=sunMesh.material?.uniforms?.uSolarGlare;
    if(glareUniform)glareUniform.value=sunGlareStrength;
  }

  function createProceduralSkyTexture(T,profile){
    const canvas=document.createElement('canvas');
    const width=2048,height=1024;
    canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Canvas 2D context is unavailable for procedural sky generation.');
    const name=String(profile.name||'day');
    const palettes={
      day:[[0,'#174879'],[.12,'#246BA8'],[.3,'#4C95C9'],[.43,'#82B8D8'],[.485,'#C4DDE6'],[.51,'#DCE5E2'],[.55,'#879998'],[.68,'#4B595A'],[1,'#313B3D']],
      dusk:[[0,'#151B43'],[.14,'#332653'],[.29,'#71345F'],[.39,'#B74E5A'],[.465,'#ED7957'],[.495,'#FFB46D'],[.525,'#D27C65'],[.6,'#584052'],[1,'#1A2032']],
      night:[[0,'#01040B'],[.16,'#030918'],[.32,'#071326'],[.43,'#101C30'],[.49,'#142137'],[.515,'#142033'],[.57,'#090F1C'],[1,'#010309']],
      studio:[[0,'#334456'],[.18,'#526A80'],[.36,'#8097A8'],[.47,'#AABAC4'],[.505,'#BBC6C9'],[.55,'#65727B'],[1,'#29343E']]
    };
    const gradient=context.createLinearGradient(0,0,0,height);
    for(const [stop,color] of (palettes[name]||palettes.day))gradient.addColorStop(stop,color);
    context.fillStyle=gradient;context.fillRect(0,0,width,height);

    let seed=(name==='night'?0x73a9d1:name==='dusk'?0x36d91b:name==='studio'?0x492731:0x19c0ffee)>>>0;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const directionUv=(x,y,z)=>{
      const length=Math.hypot(x,y,z)||1;
      const ny=Math.max(-1,Math.min(1,y/length));
      const u=((Math.atan2(z,x)/(Math.PI*2)+0.5)%1+1)%1;
      return{x:u*width,y:Math.acos(ny)/Math.PI*height};
    };

    if(name==='night'){
      // A dark, periodic starfield with a structured Milky Way rather than a smooth painted stripe.
      // Four seeded noise octaves create clouds, filaments and dark molecular dust lanes.
      const makeNoiseGrid=(gridWidth,gridHeight)=>{
        const values=new Float32Array(gridWidth*gridHeight);
        for(let i=0;i<values.length;i++)values[i]=random();
        return{width:gridWidth,height:gridHeight,values};
      };
      const noiseGrids=[makeNoiseGrid(48,24),makeNoiseGrid(96,48),makeNoiseGrid(192,96),makeNoiseGrid(384,192)];
      const sampleNoise=(grid,u,v)=>{
        const gx=u*grid.width,gy=Math.max(0,Math.min(grid.height-1,v*(grid.height-1)));
        const x0=Math.floor(gx)%grid.width,x1=(x0+1)%grid.width;
        const y0=Math.floor(gy),y1=Math.min(grid.height-1,y0+1);
        const fx=gx-Math.floor(gx),fy=gy-y0;
        const sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
        const a=grid.values[y0*grid.width+x0],b=grid.values[y0*grid.width+x1];
        const c=grid.values[y1*grid.width+x0],d=grid.values[y1*grid.width+x1];
        return(a+(b-a)*sx)+((c+(d-c)*sx)-(a+(b-a)*sx))*sy;
      };
      const clamp01=value=>Math.max(0,Math.min(1,value));

      // Render the nebula at half resolution, then upscale before the texture mipmaps are built.
      const galaxyCanvas=document.createElement('canvas');
      const galaxyWidth=1024,galaxyHeight=512;
      galaxyCanvas.width=galaxyWidth;galaxyCanvas.height=galaxyHeight;
      const galaxyContext=galaxyCanvas.getContext('2d');
      if(galaxyContext){
        const image=galaxyContext.createImageData(galaxyWidth,galaxyHeight),pixels=image.data;
        for(let y=0;y<galaxyHeight;y++){
          const v=y/(galaxyHeight-1);
          for(let x=0;x<galaxyWidth;x++){
            const u=x/galaxyWidth,angle=u*Math.PI*2;
            const broad=sampleNoise(noiseGrids[0],u,v);
            const medium=sampleNoise(noiseGrids[1],u,v);
            const fine=sampleNoise(noiseGrids[2],u,v);
            const micro=sampleNoise(noiseGrids[3],u,v);
            // A curved, seam-safe galactic plane with turbulent edge displacement.
            let center=.315+.115*Math.sin(angle-.72)+.035*Math.sin(angle*2+1.1);
            center+=(broad-.5)*.045+(medium-.5)*.018;
            const bandWidth=.032+.025*broad;
            const distance=Math.abs(v-center);
            const core=Math.exp(-Math.pow(distance/bandWidth,2)*1.55);
            const haze=Math.exp(-Math.pow(distance/(bandWidth*3.15),2));
            const structure=clamp01((medium*.48+fine*.34+micro*.18-.27)*1.65);
            const knots=clamp01((fine*.62+micro*.38-.49)*2.15);
            const dust=clamp01((fine*.54+micro*.46-.61)*2.25)*core;
            const filaments=core*(.10+structure*.75+knots*.22);
            const outerHaze=haze*(.025+broad*.055);
            const intensity=clamp01((filaments+outerHaze)*(1-dust*.68)*1.34);
            const warm=clamp01(.48+.36*Math.sin(angle*1.4+.4)+.28*(medium-.5));
            const cold=1-warm;
            const offset=(y*galaxyWidth+x)*4;
            pixels[offset]=Math.round(intensity*(20+105*warm+24*knots));
            pixels[offset+1]=Math.round(intensity*(34+64*warm+26*structure));
            pixels[offset+2]=Math.round(intensity*(66+69*cold+29*structure));
            pixels[offset+3]=255;
          }
        }
        galaxyContext.putImageData(image,0,0);
        context.save();
        context.globalCompositeOperation='screen';
        context.globalAlpha=.96;
        context.imageSmoothingEnabled=true;
        context.drawImage(galaxyCanvas,0,0,width,height);
        context.restore();
      }

      // Very faint wide-angle airglow keeps the black sky from becoming a flat void.
      const airglow=context.createRadialGradient(width*.72,height*.29,8,width*.72,height*.29,height*.55);
      airglow.addColorStop(0,'rgba(51,65,104,0.105)');
      airglow.addColorStop(.42,'rgba(27,39,73,0.055)');
      airglow.addColorStop(1,'rgba(2,5,15,0)');
      context.save();
      context.globalCompositeOperation='screen';
      context.fillStyle=airglow;
      context.fillRect(0,0,width,height);
      context.restore();

      // A cool lunar aureole is painted into the panorama; the solid moon itself remains
      // a separate sphere so its shape, terminator and crater relief remain correct.
      const moonUv=directionUv(
        Number.isFinite(Number(profile.moonDirectionX))?Number(profile.moonDirectionX):.38,
        Number.isFinite(Number(profile.moonDirectionY))?Number(profile.moonDirectionY):.88,
        Number.isFinite(Number(profile.moonDirectionZ))?Number(profile.moonDirectionZ):.27
      );
      const moonGlow=Math.max(0,Math.min(1.5,Number(profile.moonGlow)||0));
      if(moonGlow>.001){
        const moonAura=context.createRadialGradient(moonUv.x,moonUv.y,2,moonUv.x,moonUv.y,height*(.055+moonGlow*.07));
        moonAura.addColorStop(0,'rgba(170,199,242,'+(0.15*moonGlow)+')');
        moonAura.addColorStop(.2,'rgba(117,153,211,'+(0.105*moonGlow)+')');
        moonAura.addColorStop(.58,'rgba(83,119,181,'+(0.045*moonGlow)+')');
        moonAura.addColorStop(1,'rgba(42,66,112,0)');
        context.save();context.globalCompositeOperation='screen';
        context.fillStyle=moonAura;context.fillRect(moonUv.x-width*.08,moonUv.y-height*.1,width*.16,height*.2);
        context.restore();
      }

      // Fine stars dominate; only a tiny fraction are bright enough to bloom or sparkle.
      // Density and brightness rise gently inside the galactic band.
      const starBrightness=Math.max(.75,Math.min(1.8,Number(profile.starBrightness)||1));
      for(let i=0;i<8200;i++){
        const x=random()*width,y=8+random()*height*.485,u=x/width,v=y/height;
        const angle=u*Math.PI*2;
        const galacticCenterY=.315+.115*Math.sin(angle-.72)+.035*Math.sin(angle*2+1.1);
        const band=Math.exp(-Math.pow((v-galacticCenterY)/.092,2));
        const roll=random();
        const radius=roll>.997?2.7+random()*1.35:roll>.955?1.05+random()*.72:.26+Math.pow(random(),2)*.82;
        const alpha=Math.min(.98,(.115+random()*.50+band*.18)*(radius>1.7?1.2:1)*starBrightness);
        const tint=random();
        const color=tint>.91?'190,211,255':tint>.73?'211,225,255':tint<.075?'255,220,180':'236,241,250';
        if(radius>1.45){
          const halo=context.createRadialGradient(x,y,0,x,y,radius*5.2);
          halo.addColorStop(0,'rgba('+color+','+(alpha*.30).toFixed(3)+')');
          halo.addColorStop(1,'rgba('+color+',0)');
          context.fillStyle=halo;
          context.fillRect(x-radius*5.2,y-radius*5.2,radius*10.4,radius*10.4);
        }
        context.beginPath();context.arc(x,y,radius,0,Math.PI*2);
        context.fillStyle='rgba('+color+','+alpha.toFixed(3)+')';
        context.fill();
        if(radius>2.8&&random()>.72){
          context.strokeStyle='rgba('+color+','+(alpha*.28).toFixed(3)+')';
          context.lineWidth=.65;
          context.beginPath();
          context.moveTo(x-radius*2.1,y);context.lineTo(x+radius*2.1,y);
          context.moveTo(x,y-radius*2.1);context.lineTo(x,y+radius*2.1);
          context.stroke();
        }
      }
      // A restrained second layer of very faint pinprick stars adds depth without changing
      // the established Milky Way palette or the existing 8,200-star distribution.
      for(let i=0;i<1500;i++){
        const x=random()*width,y=4+random()*height*.49;
        const tint=random();
        const color=tint>.9?'190,211,255':tint>.72?'211,225,255':tint<.07?'255,220,180':'236,241,250';
        const radius=.1+random()*.25;
        const alpha=(.035+random()*.075)*starBrightness;
        context.fillStyle='rgba('+color+','+alpha.toFixed(3)+')';
        context.fillRect(x,y,radius,radius);
      }

    }else{
      const sun=directionUv(
        Number.isFinite(Number(profile.skySunX))?Number(profile.skySunX):-Number(profile.lightX||0),
        Number.isFinite(Number(profile.skySunY))?Number(profile.skySunY):-Number(profile.lightY||-1),
        Number.isFinite(Number(profile.skySunZ))?Number(profile.skySunZ):-Number(profile.lightZ||0)
      );
      const dusk=name==='dusk';
      const sunRadius=Math.max(6,Number(profile.sunRadius)||10);
      const glowStrength=Math.max(0,Math.min(1,Number(profile.sunGlow)||.45));
      const horizonGlow=context.createRadialGradient(sun.x,sun.y,2,sun.x,sun.y,(dusk?height*.19:height*.16));
      horizonGlow.addColorStop(0,dusk?'rgba(255,166,105,0.22)':'rgba(255,238,196,0.22)');
      horizonGlow.addColorStop(.24,dusk?'rgba(250,112,91,0.10)':'rgba(159,210,245,0.10)');
      horizonGlow.addColorStop(1,'rgba(255,255,255,0)');
      context.fillStyle=horizonGlow;context.fillRect(0,0,width,height);
      if(dusk){
        // Layered afterglow follows the horizon rather than creating a giant circular wash.
        const bandY=Math.max(height*.44,Math.min(height*.56,sun.y));
        const horizonBand=context.createLinearGradient(0,bandY-height*.12,0,bandY+height*.19);
        horizonBand.addColorStop(0,'rgba(121,56,103,0)');
        horizonBand.addColorStop(.22,'rgba(175,71,100,0.035)');
        horizonBand.addColorStop(.46,'rgba(235,104,89,0.16)');
        horizonBand.addColorStop(.61,'rgba(255,174,111,0.24)');
        horizonBand.addColorStop(.78,'rgba(207,91,105,0.10)');
        horizonBand.addColorStop(1,'rgba(77,45,83,0)');
        context.save();context.globalCompositeOperation='screen';
        context.fillStyle=horizonBand;context.fillRect(0,bandY-height*.12,width,height*.31);
        const horizonMask=context.createRadialGradient(sun.x,bandY,4,sun.x,bandY,width*.42);
        horizonMask.addColorStop(0,'rgba(255,204,145,0.28)');
        horizonMask.addColorStop(.28,'rgba(255,144,113,0.17)');
        horizonMask.addColorStop(1,'rgba(255,105,112,0)');
        context.fillStyle=horizonMask;context.fillRect(0,bandY-height*.15,width,height*.36);
        context.restore();
      }

      if(name==='day'||name==='dusk'){
      // Soft, broken cloud banks and fine cirrus stop the sky from reading as a flat gradient.
      context.save();
      context.globalCompositeOperation='screen';
      for(let i=0;i<(dusk?112:92);i++){
        const x=random()*width,y=height*(dusk?.29:.18)+random()*height*(dusk?.18:.25);
        const rx=55+random()*(dusk?190:150),ry=4+random()*(dusk?17:11);
        context.save();context.translate(x,y);context.rotate((random()-.5)*.18);context.scale(1,ry/rx);
        const cloud=context.createRadialGradient(0,0,2,0,0,rx);
        if(dusk){
          cloud.addColorStop(0,'rgba(255,178,148,0.16)');
          cloud.addColorStop(.46,'rgba(225,130,134,0.09)');
          cloud.addColorStop(1,'rgba(190,117,163,0)');
        }else{
          cloud.addColorStop(0,'rgba(246,252,255,0.15)');
          cloud.addColorStop(.5,'rgba(220,239,250,0.075)');
          cloud.addColorStop(1,'rgba(210,232,247,0)');
        }
        context.fillStyle=cloud;
        context.beginPath();
        context.arc(0,0,rx,0,Math.PI*2);
        context.arc(-rx*.52,-ry*.34,rx*.47,0,Math.PI*2);
        context.arc(rx*.43,-ry*.18,rx*.42,0,Math.PI*2);
        context.arc(rx*.08,ry*.24,rx*.38,0,Math.PI*2);
        context.fill();
        context.restore();
      }
      context.lineCap='round';context.lineJoin='round';
      for(let i=0;i<(dusk?112:148);i++){
        const x=random()*width,y=height*(.12+random()*.34),length=60+random()*360;
        context.beginPath();context.moveTo(x,y);
        context.bezierCurveTo(x+length*.24,y+(random()-.5)*9,x+length*.68,y+(random()-.5)*15,x+length,y+(random()-.5)*8);
        context.lineWidth=1+random()*(dusk?7:5);
        context.strokeStyle=dusk?'rgba(255,184,151,0.35)':'rgba(241,250,255,0.32)';
        context.globalAlpha=.12+random()*.22;
        context.shadowColor=dusk?'rgba(255,153,123,0.22)':'rgba(235,248,255,0.24)';
        context.shadowBlur=7+random()*18;
        context.stroke();
      }
      context.restore();
      }

      const glowRadius=sunRadius*(dusk?8:10);
      const halo=context.createRadialGradient(sun.x,sun.y,1,sun.x,sun.y,glowRadius);
      halo.addColorStop(0,dusk?'rgba(255,230,190,'+(0.30*glowStrength)+')':'rgba(255,250,226,'+(0.48*glowStrength)+')');
      halo.addColorStop(.12,dusk?'rgba(255,161,105,'+(0.21*glowStrength)+')':'rgba(255,229,178,'+(0.22*glowStrength)+')');
      halo.addColorStop(.42,dusk?'rgba(239,117,91,'+(0.08*glowStrength)+')':'rgba(174,220,249,'+(0.09*glowStrength)+')');
      halo.addColorStop(1,'rgba(255,255,255,0)');
      context.fillStyle=halo;context.fillRect(sun.x-glowRadius,sun.y-glowRadius,glowRadius*2,glowRadius*2);
      // The photosphere itself is rendered by PStudioSunSphere; this panorama retains only the atmospheric halo.
    }

    const texture=new T.CanvasTexture(canvas);
    texture.mapping=T.EquirectangularReflectionMapping;
    texture.colorSpace=T.SRGBColorSpace;
    texture.generateMipmaps=true;
    texture.minFilter=T.LinearMipmapLinearFilter;
    texture.magFilter=T.LinearFilter;
    texture.anisotropy=Math.min(16,renderer?.capabilities?.getMaxAnisotropy?.()||1);
    texture.needsUpdate=true;
    texture.userData=texture.userData||{};
    texture.userData.pstudioAtmosphere={preset:name,width,height,nightStars:name==='night'?9700:0,nightPrimaryStars:name==='night'?8200:0,proceduralCloudLayers:name==='day'||name==='dusk'};
    return texture;
  }
  function enhancePhysicalSkyShader(sky,Three){
    const material=sky?.material;
    if(!material||material.userData?.pstudioAtmosphereEnhanced)return !!material;
    const marker='gl_FragColor = vec4( retColor, 1.0 );';
    const uniformMarker='uniform vec3 up;';
    const source=String(material.fragmentShader||'');
    if(!source.includes(marker)||!source.includes(uniformMarker)){
      console.warn('[PStudio] Physical sky shader enhancement hook was not found; native Sky.js scattering remains active.');
      return false;
    }
    material.uniforms.pStudioAtmosphereExposure={value:.45};
    material.uniforms.pStudioTwilightStrength={value:0};
    const enhancement=[
      'retColor*=pStudioAtmosphereExposure;',
      'float pStudioHorizonBand=exp(-abs(direction.y)*10.0);',
      'float pStudioTwilight=smoothstep(-0.10,0.10,vSunDirection.y)*(1.0-smoothstep(0.12,0.48,vSunDirection.y))*pStudioTwilightStrength;',
      'float pStudioSunAlignment=max(dot(direction,vSunDirection),0.0);',
      'float pStudioSolarHalo=pow(pStudioSunAlignment,18.0);',
      'vec3 pStudioWarmHorizon=mix(vec3(0.96,0.22,0.12),vec3(1.0,0.53,0.24),smoothstep(-0.12,0.34,direction.y));',
      'retColor=mix(retColor,pStudioWarmHorizon,pStudioHorizonBand*pStudioTwilight*0.42);',
      'retColor+=vec3(1.0,0.34,0.16)*pStudioSolarHalo*pStudioTwilight*0.13;',
      'retColor+=vec3(0.36,0.53,0.82)*pow(pStudioSunAlignment,24.0)*smoothstep(0.42,0.86,vSunDirection.y)*0.018;'
    ].join('\n');
    const shaderWithUniforms=source.replace(uniformMarker,uniformMarker+'\nuniform float pStudioAtmosphereExposure;\nuniform float pStudioTwilightStrength;');
    material.fragmentShader=shaderWithUniforms.replace(marker,enhancement+'\n'+marker);
    material.needsUpdate=true;
    material.userData.pstudioAtmosphereEnhanced=true;
    return true;
  }
  function updatePhysicalSkyPreset(T,profile){
    if(!window.PStudioSky||!scene)return false;
    try{
      if(!physicalSky){
        physicalSky=new window.PStudioSky();
        physicalSky.name='PStudioPhysicalSky';
        enhancePhysicalSkyShader(physicalSky,T);
        physicalSky.scale.setScalar(450000);
        physicalSky.frustumCulled=false;
        if(physicalSky.material){physicalSky.material.depthWrite=false;physicalSky.material.fog=false;}
        scene.add(physicalSky);
      }
      const uniforms=physicalSky.material?.uniforms;
      if(!uniforms?.sunPosition?.value||!uniforms?.turbidity||!uniforms?.rayleigh||!uniforms?.mieCoefficient||!uniforms?.mieDirectionalG)return false;
      uniforms.turbidity.value=Math.max(0,Math.min(20,Number.isFinite(Number(profile.skyTurbidity))?Number(profile.skyTurbidity):2.4));
      uniforms.rayleigh.value=Math.max(0,Math.min(4,Number.isFinite(Number(profile.skyRayleigh))?Number(profile.skyRayleigh):2.0));
      uniforms.mieCoefficient.value=Math.max(0,Math.min(0.1,Number.isFinite(Number(profile.skyMieCoefficient))?Number(profile.skyMieCoefficient):0.005));
      uniforms.mieDirectionalG.value=Math.max(0,Math.min(0.99,Number.isFinite(Number(profile.skyMieDirectionalG))?Number(profile.skyMieDirectionalG):0.8));
      const sunDirection=new T.Vector3(
        Number.isFinite(Number(profile.skySunX))?Number(profile.skySunX):-Number(profile.lightX||0),
        Number.isFinite(Number(profile.skySunY))?Number(profile.skySunY):-Number(profile.lightY||-1),
        Number.isFinite(Number(profile.skySunZ))?Number(profile.skySunZ):-Number(profile.lightZ||0)
      );
      if(sunDirection.lengthSq()<1e-8)sunDirection.set(0,1,0);
      sunDirection.normalize();
      uniforms.sunPosition.value.copy(sunDirection).multiplyScalar(450000);
      if(uniforms.pStudioAtmosphereExposure)uniforms.pStudioAtmosphereExposure.value=Math.max(.1,Math.min(1,Number(profile.skyExposure)||.45));
      if(uniforms.pStudioTwilightStrength)uniforms.pStudioTwilightStrength.value=Math.max(0,Math.min(1,Number(profile.twilightStrength)||0));
      physicalSky.visible=true;
      if(camera)physicalSky.position.copy(camera.position);
      return true;
    }catch(error){
      console.warn('[PStudio] Physical sky setup failed; the procedural panorama environment will be used.',error);
      physicalSky?.parent?.remove?.(physicalSky);physicalSky=null;
      return false;
    }
  }
  function createPhysicalSkyEnvironmentTarget(T){
    if(!physicalSky||!pmremGenerator)return null;
    const probe=physicalSky.clone();
    probe.visible=true;probe.position.set(0,0,0);
    const skyScene=new T.Scene();
    skyScene.add(probe);
    try{return pmremGenerator.fromScene(skyScene,0.04);}
    finally{skyScene.remove(probe);}
  }
  function applySceneEnvironmentPreset(T,presetName,hasCustomEnvironment=false){
    const api=window.PStudioSceneEnvironment;
    const profile=api?.getPreset?.(presetName)||{
      name:'day',skyTop:'#347CB7',skyMid:'#79BCE0',horizon:'#D7EDF7',ground:'#89977A',
      fogColor:'#B9D9E8',fogNear:55,fogFar:1450,lightColor:'#FFF1D6',
      lightIntensity:2.35,lightX:-0.35,lightY:-0.89,lightZ:-0.28,
      hemisphereSky:'#D9EEFF',hemisphereGround:'#68725C',hemisphereIntensity:0.95,
      environmentIntensity:0.8,sunX:0.72,sunY:0.29,sunRadius:17,sunGlow:0.68,sunIntensity:1.12,sunAngularRadius:1.2,sunColor:'#FFF4DC',cloudDensity:0.9,cloudCoverage:0.49,cloudDetail:0.82,cloudBase:46,cloudTop:142,skySunX:0.35,skySunY:0.89,skySunZ:0.28,moonDirectionX:0.38,moonDirectionY:0.88,moonDirectionZ:0.27,moonIntensity:0.78,skyTurbidity:2.2,skyRayleigh:2.15,skyMieCoefficient:0.0048,skyMieDirectionalG:0.82,skyExposure:0.45,twilightStrength:0,atmosphereSunColor:'#FFF4DF',fogDensity:0.0018,fogHeightFalloff:0.018,fogBaseHeight:0,fogAnisotropy:0.42
    };
    activeEnvironmentPreset=String(profile.name||'day');
    configureMoonSky(T,profile);
    configureSunSky(T,profile);
    const cloudTier=QUALITY_PROFILES[resolveQualityPreset(qualityPreset)];
    const cloudTierActive=!memorySafetyApplied;
    volumetricCloudsEnabled=activeEnvironmentPreset!=='studio'&&!!(cloudTier?.clouds&&cloudTierActive&&volumetricCloudPass);
    if(volumetricCloudPass){volumetricCloudPass.enabled=volumetricCloudsEnabled;volumetricCloudPass.setQuality?.(resolveQualityPreset(qualityPreset),adaptiveQualityLevel);}
    const signature=String(profile.name||'day');
    const changed=signature!==scenePresetSignature;
    if(changed){
      let nextTexture=null,nextTarget=null;
      try{nextTexture=createProceduralSkyTexture(T,profile);}
      catch(error){console.warn('[PStudio] Procedural atmosphere texture creation failed; a solid horizon fallback will be used.',error);}
      // The physical Sky shader is retained for high-dynamic-range environment lighting,
      // but the editor background always uses the authored panorama to avoid exposure blowout.
      const physicalSkyReady=profile.name!=='night'&&updatePhysicalSkyPreset(T,profile);
      if(physicalSkyReady&&pmremGenerator){
        try{nextTarget=createPhysicalSkyEnvironmentTarget(T);}
        catch(error){console.warn('[PStudio] Physical sky PMREM generation failed; using the matching procedural environment.',error);}
      }
      scenePresetUsesPhysicalSky=!!(physicalSkyReady&&nextTarget);
      if(!nextTarget&&nextTexture&&pmremGenerator){
        try{nextTarget=pmremGenerator.fromEquirectangular(nextTexture);}
        catch(error){console.warn('[PStudio] Procedural sky PMREM generation failed; using the equirectangular texture directly.',error);}
      }
      scenePresetTarget?.dispose?.();
      scenePresetTexture?.dispose?.();
      scenePresetTexture=nextTexture;scenePresetTarget=nextTarget;scenePresetSignature=signature;
    }
    const hdrBackgroundVisible=!!(hdrTexture&&hdrShowBackground);
    if(physicalSky)physicalSky.visible=false;
    if(!hdrBackgroundVisible){
      if(scenePresetTexture)scene.background=scenePresetTexture;
      else scene.background=new T.Color(profile.horizon||profile.skyMid||'#79BCE0');
    }
    if(!hasCustomEnvironment){
      if(environmentSignature){
        environmentTarget?.dispose?.();environmentTarget=null;
        environmentTexture?.dispose?.();environmentTexture=null;
        environmentSignature='';
      }
      if(environmentTarget){environmentTarget.dispose?.();environmentTarget=null;}
      if(hdrEnvironmentTarget)scene.environment=hdrEnvironmentTarget.texture;
      else if(scenePresetTarget?.texture)scene.environment=scenePresetTarget.texture;
      else if(scenePresetTexture)scene.environment=scenePresetTexture;
      if('environmentIntensity' in scene)scene.environmentIntensity=profile.environmentIntensity;
    }
    if(!(scene.fog instanceof T.Fog))scene.fog=new T.Fog(profile.fogColor,profile.fogNear,profile.fogFar);
    else{scene.fog.color.set(profile.fogColor);scene.fog.near=profile.fogNear;scene.fog.far=profile.fogFar;}
    if(hemisphereLight){
      hemisphereLight.color.set(profile.hemisphereSky);
      hemisphereLight.groundColor.set(profile.hemisphereGround);
      hemisphereLight.intensity=profile.hemisphereIntensity;
    }
    if(csm){
      if(csm.lightDirection)csm.lightDirection.set(profile.lightX,profile.lightY,profile.lightZ).normalize();
      for(const light of csm.lights||[]){light.color.set(profile.lightColor);light.intensity=profile.lightIntensity;light.castShadow=true;}
      if(changed)csm.updateFrustums?.();
    }else if(keyLight){
      keyLight.position.set(-profile.lightX*80,-profile.lightY*80,-profile.lightZ*80);
      keyLight.color.set(profile.lightColor);
      keyLight.intensity=profile.lightIntensity;
      keyLight.castShadow=true;
    }
    const skySunDirection=[
      Number.isFinite(Number(profile.skySunX))?Number(profile.skySunX):-Number(profile.lightX||0),
      Number.isFinite(Number(profile.skySunY))?Number(profile.skySunY):-Number(profile.lightY||-1),
      Number.isFinite(Number(profile.skySunZ))?Number(profile.skySunZ):-Number(profile.lightZ||0)
    ];
    const atmosphericLightDirection=[-Number(profile.lightX||0),-Number(profile.lightY||-1),-Number(profile.lightZ||0)];
    window.PStudioEnvironmentFX?.configureAtmosphere?.({
      sunDirection:skySunDirection,
      lightDirection:atmosphericLightDirection,
      sunColor:profile.atmosphereSunColor||profile.lightColor,
      fogColor:profile.fogColor,
      fogAmbientColor:profile.hemisphereSky||profile.fogColor,
      fogDensity:Number.isFinite(Number(profile.fogDensity))?Number(profile.fogDensity):0.0018,
      fogHeightFalloff:Number.isFinite(Number(profile.fogHeightFalloff))?Number(profile.fogHeightFalloff):0.018,
      fogBaseHeight:Number.isFinite(Number(profile.fogBaseHeight))?Number(profile.fogBaseHeight):0,
      fogAnisotropy:Number.isFinite(Number(profile.fogAnisotropy))?Number(profile.fogAnisotropy):0.42,
      cloudDensity:Number.isFinite(Number(profile.cloudDensity))?Number(profile.cloudDensity):0.78,
      cloudCoverage:Number.isFinite(Number(profile.cloudCoverage))?Number(profile.cloudCoverage):0.48,
      cloudDetail:Number.isFinite(Number(profile.cloudDetail))?Number(profile.cloudDetail):0.58,
      cloudBase:Number.isFinite(Number(profile.cloudBase))?Number(profile.cloudBase):54,
      cloudTop:Number.isFinite(Number(profile.cloudTop))?Number(profile.cloudTop):108
    });
    return profile;
  }

  function applyModelMaterial(instance, state) {
    if(!instance?.materialDefaults)return;
    const overrides=Array.isArray(state?.modelOverrides)?state.modelOverrides:[];
    const geometryTargets=[
      ...(instance.meshes||[]).filter(object=>!object.userData.pstudioBatchedIntoStaticInstance),
      ...(instance.foliageBatches||[]).map(entry=>entry.mesh)
    ];
    const normalGeometrySignature=overrides.some(item=>item.recomputeNormals===true)
      ?Number(instance.root?.userData?.pstudioGeometryRevision)||0
      :'';
    const signature=JSON.stringify(state?{
      roughness:state.roughness??null,
      metalness:state.metalness??null,
      modelOverrides:overrides.map(item=>[
        item.name,item.roughness??null,item.metalness??null,item.color??null,
        item.doubleSide??null,item.recomputeNormals??null,item.emissive??null,item.emissiveIntensity??null
      ]),
      normalGeometrySignature
    }:null);
    if(instance.materialStateSignature===signature)return;
    for(const entry of instance.foliageBatches||[]){
      if(!entry.isGeneric||!entry.sources?.length)continue;
      const needsPerNodeMaterials=overrides.some(item=>item.name!=='*'&&
        entry.sources.some(source=>source.name===item.name||(
          (Array.isArray(source.material)?source.material:[source.material]).some(material=>material?.name===item.name)
        )));
      if(needsPerNodeMaterials&&!entry.disabledForObjectOverride){
        entry.disabledForObjectOverride=true;
        entry.mesh.visible=false;
        for(const source of entry.sources){
          source.visible=true;
          source.userData.pstudioBatchedIntoStaticInstance=false;
          const originalRaycast=staticBatchOriginalRaycast.get(source);
          if(originalRaycast){source.raycast=originalRaycast;staticBatchOriginalRaycast.delete(source);}
        }
      }else if(!needsPerNodeMaterials&&entry.disabledForObjectOverride){
        entry.disabledForObjectOverride=false;
        entry.mesh.visible=true;
        for(const source of entry.sources){
          source.visible=false;
          source.userData.pstudioBatchedIntoStaticInstance=true;
          if(!staticBatchOriginalRaycast.has(source))staticBatchOriginalRaycast.set(source,source.raycast);
          source.raycast=skipStaticBatchSourceRaycast;
        }
      }
    }
    instance.materialStateSignature=signature;
    const materialTargets=geometryTargets;
    const desiredNormalTargets=new Set();
    for(const object of materialTargets){
      if(!object.material)continue;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      const matching=overrides.filter(item=>item.name==='*'||item.name===object.name||materials.some(material=>material?.name===item.name));
      if(matching.some(item=>item.recomputeNormals===true)&&object.geometry?.isBufferGeometry&&object.geometry.attributes?.position){
        desiredNormalTargets.add(object);
        const original=object.userData?.pstudioLightmapGeometry?object.geometry:(object.geometry?.userData?.pstudioNormalSourceGeometry||object.geometry);
        instance.geometryOriginals?.set(object,original);
        let normalized=instance.normalGeometryClones?.get(original);
        if(!normalized){
          normalized=original.clone();
          normalized.computeVertexNormals();
          if(normalized.attributes?.tangent)normalized.deleteAttribute('tangent');
          normalized.userData=normalized.userData||{};
          normalized.userData.pstudioNormalSourceGeometry=original;
          scheduleGeometryBVH(normalized);
          instance.normalGeometryClones?.set(original,normalized);
        }
        object.geometry=normalized;
      }
      for(const material of materials){
        const defaults=instance.materialDefaults.get(material);if(!defaults)continue;
        material.roughness=defaults.roughness;
        material.metalness=defaults.metalness;
        if(defaults.color&&material.color)material.color.copy(defaults.color);
        if(defaults.emissive&&material.emissive)material.emissive.copy(defaults.emissive);
        if(Number.isFinite(defaults.emissiveIntensity))material.emissiveIntensity=defaults.emissiveIntensity;
        material.side=defaults.side;
        const override=overrides.find(item=>item.name===object.name||item.name===material.name)||overrides.find(item=>item.name==='*');
        if(!override)continue;
        if(Number.isFinite(override.roughness))material.roughness=Math.max(0,Math.min(1,override.roughness));
        if(Number.isFinite(override.metalness))material.metalness=Math.max(0,Math.min(1,override.metalness));
        if(override.color&&material.color)material.color.set(override.color);
        if(typeof override.doubleSide==='boolean')material.side=override.doubleSide?window.THREE.DoubleSide:(defaults.side??window.THREE.FrontSide);
        if(override.emissive&&material.emissive)material.emissive.set(override.emissive);
        if(Number.isFinite(override.emissiveIntensity)&&material.emissive)material.emissiveIntensity=Math.max(0,Math.min(8,override.emissiveIntensity));
      }
    }
    for(const [object,original] of [...(instance.geometryOriginals||new Map()).entries()]){
      if(desiredNormalTargets.has(object))continue;
      const normalized=instance.normalGeometryClones?.get(original);
      if(normalized&&object.geometry===normalized)object.geometry=original;
      instance.geometryOriginals.delete(object);
    }
    const activeOriginals=new Set([...(instance.geometryOriginals?.values()||[])]);
    for(const [original,normalized] of [...(instance.normalGeometryClones||new Map()).entries()]){
      if(activeOriginals.has(original))continue;
      normalized.disposeBoundsTree?.();
      normalized.dispose?.();
      instance.normalGeometryClones.delete(original);
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
    instance.mixer.update(Math.max(0,Math.min(0.1,Number(dt)||0)));updateFoliageInstanceBatches(instance);
  }

  function removeModelInstance(key) {
    const instance=modelInstances.get(key);
    if(!instance) return;
    instance.preparationCancelled=true;instance.preparing=false;
    if(instance.mixer) instance.mixer.stopAllAction();
    if(instance.root.parent) instance.root.parent.remove(instance.root);
    const disposedMaterials=new Set();
    instance.root.traverse(object=>{
      if(!object.isMesh)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials)if(material)disposedMaterials.add(material);
      if(object.userData.pstudioLightmapOriginalMaterial){const originals=Array.isArray(object.userData.pstudioLightmapOriginalMaterial)?object.userData.pstudioLightmapOriginalMaterial:[object.userData.pstudioLightmapOriginalMaterial];for(const material of originals)if(material)disposedMaterials.add(material);}
      object.userData.pstudioLightmapTexture?.dispose?.();if(object.userData.pstudioLightmapGeometry){object.geometry.userData.pstudioBVHDisposed=true;object.geometry.userData.pstudioBVHToken=(object.geometry.userData.pstudioBVHToken||0)+1;object.geometry?.disposeBoundsTree?.();object.geometry?.dispose?.();}
      object.userData.pstudioLODToken=(object.userData.pstudioLODToken||0)+1;
    });
    disposedMaterials.forEach(material=>{window.PStudioEnvironmentFX?.releaseMaterial?.(material);material.dispose();});
    for(const geometry of instance.normalGeometryClones?.values?.()||[]){geometry.disposeBoundsTree?.();geometry.dispose?.();}
    instance.normalGeometryClones?.clear?.();instance.geometryOriginals?.clear?.();
    modelInstances.delete(key);
    modelBuildErrors.delete(key);
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
    for(const material of waterMaterials){const u=material.userData?.pstudioWaterUniforms;if(u?.uPStudioTime&&Object.prototype.hasOwnProperty.call(u.uPStudioTime,'value'))u.uPStudioTime.value=particleClock;}window.PStudioEnvironmentFX?.update?.(particleClock);
    const usedMeshes=new Set(),usedGrids=new Set(),usedModels=new Set(),usedLights=new Set(),usedEmitters=new Set(),stoppedEmitters=new Set(),preservedOwners=new Set();
    const pendingFrameInstances=[];
    let cameraCommand=null,environment=null,cameraOwnerId=null;
    for (const [ownerId,list] of commandsByObject.entries()) {
      if(!isOwnerChunkActive(ownerId)){preservedOwners.add(ownerId);continue;}
      let ownerMaterial=null;
      const modelOverrides=list.filter(command=>command.type==='model_material').map(d=>({name:String(d.name),roughness:Number(d.roughness),metalness:Number(d.metalness),color:d.color?String(d.color):null,doubleSide:typeof d.doubleSide==='boolean'?d.doubleSide:undefined,recomputeNormals:typeof d.recomputeNormals==='boolean'?d.recomputeNormals:undefined,emissive:d.emissive?String(d.emissive):null,emissiveIntensity:Number.isFinite(Number(d.emissiveIntensity))?Math.max(0,Math.min(8,Number(d.emissiveIntensity))):undefined}));
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
          if(!asset) { if(!modelLoadErrors.has(d.name))requestModelAsset(d.name); continue; }
          if(!instance || instance.name!==d.name) {
            if(instance)removeModelInstance(key);
            if(modelBuildErrors.has(key)){usedModels.add(key);continue;}
            if(!modelInstancePromises.has(key)){
              const buildGeneration=modelBuildGeneration;
              const assetRevision=modelRevisions.get(d.name)||0;
              let buildPhase='resource-retain';
              let resourceLease=null;
              try{
                // Pin the source asset before the first async yield in hierarchy cloning.
                resourceLease=window.PStudioResources?.retain?.('model-gpu',d.name)||null;
              }catch(error){
                const message=String(error?.message||error);
                modelBuildErrors.set(key,message);
                console.error('[PStudio] Failed to retain model asset before instance build:',d.name,error);
                dispatchModelLoadError({name:d.name,stage:'instance-build',error:message,retryable:true});
                usedModels.add(key);
                continue;
              }
              const build=(async()=>{
                const created=await createModelInstanceAsync(key,ownerId,d.name,asset,resourceLease,phase=>{buildPhase=phase;});
                buildPhase='request-validation';
                if(!created?.root)throw new Error('3D model instance creation returned no scene root.');
                created.root.visible=false;
                const latest=lastCommands?.get(ownerId)||[];
                const stillRequested=latest.some(command=>command.type==='model'&&command.name===d.name);
                if(!stillRequested||modelBuildGeneration!==buildGeneration||(modelRevisions.get(d.name)||0)!==assetRevision){
                  created.preparationCancelled=true;
                  for(const material of created.materialDefaults.keys())material.dispose?.();
                  created.resourceLease?.release?.();
                  resourceLease?.release?.();
                  return null;
                }
                modelBuildErrors.delete(key);
                modelInstances.set(key,created);
                modelGroup.add(created.root);
                buildPhase='gpu-preparation-scheduling';
                prepareModelInstance(created);
                if(lastCommands){
                  buildPhase='initial-scene-render';
                  try{render(lastCommands);}
                  catch(renderError){
                    const renderMessage=String(renderError?.message||renderError);
                    console.error('[PStudio] Model instance was built, but the first scene render failed:',d.name,renderError);
                    dispatchModelLoadError({name:d.name,stage:'instance-render',error:renderMessage,stack:renderError?.stack||'',retryable:true});
                  }
                }
                return created;
              })().catch(error=>{
                resourceLease?.release?.();
                const message=String(error?.message||error);
                const detailedMessage='['+buildPhase+'] '+message;
                modelBuildErrors.set(key,detailedMessage);
                console.error('[PStudio] Asynchronous model instance build failed at '+buildPhase+':',d.name,error);
                dispatchModelLoadError({name:d.name,stage:'instance-build',error:detailedMessage,stack:error?.stack||'',retryable:true});
                return null;
              }).finally(()=>{if(modelInstancePromises.get(key)===build)modelInstancePromises.delete(key);});
              modelInstancePromises.set(key,build);
            }
            usedModels.add(key);
            continue;
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
          const baseSize=Math.max(1,Number(d.size)||500),baseDivisions=Math.max(8,Number(d.divisions)||100);
          const signature=String(baseSize)+':'+String(baseDivisions);
          const gridPosition=new T.Vector3(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);
          const distance=camera?camera.position.distanceTo(gridPosition):0;
          const divisions=gridDivisionsForDistance(baseDivisions,distance);
          if(!grid||grid.userData.signature!==signature){
            if(grid){gridGroup.remove(grid);disposeGrid(grid);}
            grid=new T.GridHelper(baseSize,divisions,0x718093,0x3b4856);
            grid.userData.signature=signature;
            grid.userData.pstudioGridBaseSize=baseSize;
            grid.userData.pstudioGridBaseDivisions=baseDivisions;
            grid.userData.pstudioGridDivisions=divisions;
            gridCache.set(key,grid);
            gridGroup.add(grid);
          }
          grid.position.copy(gridPosition);
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
            material=new T.MeshPhysicalMaterial({
              color:d.color||'#4f9fc2',roughness:0.075,metalness:0,
              transmission:0.82,ior:1.333,thickness:1.35,
              attenuationColor:new T.Color('#a5d9eb'),attenuationDistance:7.5,
              clearcoat:1,clearcoatRoughness:0.035,side:T.DoubleSide,
              transparent:false,depthWrite:true
            });
            setupLightingMaterial(material);
            material=configureWaterMaterial(material);
          }else if(shaderMode==='custom'){
            material=new T.ShaderMaterial({uniforms:{uColor:{value:new T.Color(d.color||'#d1d5db')}},vertexShader,fragmentShader:fragmentShader||'uniform vec3 uColor; varying vec2 vUv; void main(){gl_FragColor=vec4(uColor,1.0);}',side:T.DoubleSide});
          }else if(shaderMode==='toon')material=new T.MeshToonMaterial({color:d.color||'#d1d5db',side:T.DoubleSide});
          else if(shaderMode==='unlit')material=new T.MeshBasicMaterial({color:d.color||'#d1d5db',side:T.DoubleSide});
          else if(shaderMode==='normal')material=new T.MeshNormalMaterial({side:T.DoubleSide});
          else material=new T.MeshStandardMaterial({color:d.color||'#d1d5db',roughness:d.type==='terrain'?0.92:0.72,metalness:0.04,wireframe:shaderMode==='wireframe',side:d.type==='terrain'?T.DoubleSide:T.FrontSide});
          mesh=new T.Mesh(geometry,material);if(d.type==='terrain')window.PStudioEnvironmentFX?.configureTerrain?.(material,mesh);setupLightingMaterial(material);bindObjectProbeLighting(mesh);setupClusteredLightingMaterial(material);scheduleAutoLOD(mesh,geometry);
          mesh.castShadow=d.type!=='plane'&&d.type!=='water';
          mesh.receiveShadow=true;
          mesh.userData.signature=signature;mesh.userData.shader=shaderMode;mesh.userData.fragmentShader=fragmentShader;mesh.userData.primitiveType=d.type;
          if(d.type==='water'){
            mesh.userData.pstudioWaterSurface=true;
            geometry.computeBoundingBox?.();
            const bounds=geometry.boundingBox,waterUniforms=material.userData?.pstudioWaterHQ;
            if(bounds&&waterUniforms?.bounds)waterUniforms.bounds.value.set(bounds.min.x,bounds.min.z,Math.max(.001,bounds.max.x-bounds.min.x),Math.max(.001,bounds.max.z-bounds.min.z));
          }
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
    for(const [key,grid] of gridCache){if(!usedGrids.has(key)){gridGroup.remove(grid);disposeGrid(grid);gridCache.delete(key);}}
    for(const [key,instance] of modelInstances){if(!usedModels.has(key)&&!preservedOwners.has(instance.ownerId))removeModelInstance(key);else if(preservedOwners.has(instance.ownerId))instance.root.visible=false;}
    applySceneEnvironmentPreset(T,environment?.preset||'day',!!(environment?.environmentSky&&environment?.environmentGround));
    if(environment){
      if(environment.background){if(physicalSky)physicalSky.visible=false;scene.background=new T.Color(environment.background);hdrShowBackground=false;}
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
    modelBuildGeneration++;modelInstancePromises.clear();modelBuildErrors.clear();
    activeCameraOwnerId=null;
    for(const key of [...modelInstances.keys()])removeModelInstance(key);
    for(const batch of instancedBatches.values()){if(batch.parent)batch.parent.remove(batch);batch.geometry?.dispose?.();batch.material?.dispose?.();}instancedBatches.clear();
    for(const mesh of meshCache.values())disposeMesh(mesh);
    meshCache.clear();
    waterMaterials.clear();
    for(const grid of gridCache.values()){gridGroup.remove(grid);disposeGrid(grid);}
    gridCache.clear();
    disposeGroup(selectionGroup);
    for(const emitter of particleEmitters.values())disposeGpuParticleSystem(emitter.system);particleEmitters.clear();
    for(const effect of particleBursts.values())disposeGpuParticleSystem(effect.system);particleBursts.clear();
    particleClock=0;
    selectionSignature='';
    if(renderer)drawFrame();
  }

  function retryModelAsset(name){
    const assetName=String(name||'').trim();
    if(!assetName)return false;
    if(modelPromises.has(assetName))return true;
    modelLoadErrors.delete(assetName);
    let referenced=false;
    if(lastCommands){
      for(const [ownerId,list] of lastCommands){
        for(let i=0;i<list.length;i++){
          const command=list[i];
          if(command?.type!=='model'||String(command.name)!==assetName)continue;
          referenced=true;
          modelBuildErrors.delete(String(ownerId)+':'+i);
        }
      }
      if(referenced){
        try{render(lastCommands);return true;}
        catch(error){dispatchModelLoadError({name:assetName,stage:'retry-render',error:error?.message||String(error),retryable:true});return false;}
      }
    }
    requestModelAsset(assetName);
    return true;
  }
  function getModelStatus(name){
    const assetName=String(name||''),error=modelLoadErrors.get(assetName)||null;
    const instances=[...modelInstances.values()].filter(instance=>instance.name===assetName);
    let buildError=null;
    if(lastCommands)for(const [ownerId,list] of lastCommands)for(let i=0;i<list.length;i++){
      const command=list[i];
      if(command?.type==='model'&&String(command.name)===assetName&&modelBuildErrors.has(String(ownerId)+':'+i))buildError=modelBuildErrors.get(String(ownerId)+':'+i);
    }
    const state=error?'error':buildError?'instance-error':modelPromises.has(assetName)?'loading':instances.some(instance=>instance.preparing)?'preparing':instances.length?'ready':'not-loaded';
    return{name:assetName,state,error:error||buildError,instances:instances.length,preparing:instances.filter(instance=>instance.preparing).length,visibility:instances.map(getModelVisibilityDiagnostics).filter(Boolean)};
  }

  function invalidateAsset(name) {
    const key=String(name);
    modelLoadErrors.delete(key);
    for(const [instanceKey,instance] of modelInstances)if(instance.name===key)modelBuildErrors.delete(instanceKey);
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
    adjustZoom:adjustCameraZoom,
    getZoom:()=>({distanceMultiplier:zoom,displayPercent:Math.round((1/zoom)*100)}),
    retryModelAsset,
    getModelStatus,
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
    setContactShadows:(enabled,options={})=>{
      contactShadowsRequested=enabled===null||enabled===undefined?null:!!enabled;
      const selected=resolveQualityPreset(qualityPreset),profile=QUALITY_PROFILES[selected];
      contactShadowsEnabled=!!contactShadowPass&&!memorySafetyApplied&&(contactShadowsRequested===null?!!profile.contactShadows:contactShadowsRequested);
      if(contactShadowPass){
        const u=contactShadowPass.uniforms||{};
        if(Number.isFinite(options.intensity)&&u.uIntensity)u.uIntensity.value=Math.max(0,Math.min(.85,options.intensity));
        if(Number.isFinite(options.maxDistance)&&u.uMaxDistance)u.uMaxDistance.value=Math.max(.1,Math.min(2.5,options.maxDistance));
        if(Number.isFinite(options.thickness)&&u.uThickness)u.uThickness.value=Math.max(.01,Math.min(.3,options.thickness));
        contactShadowPass.setQuality?.(selected,adaptiveQualityLevel);
        contactShadowPass.enabled=contactShadowsEnabled;
      }
      if(renderer&&scene&&camera)drawFrame();
      return{enabled:contactShadowsEnabled,available:!!contactShadowPass,requested:contactShadowsRequested};
    },
    setVolumetricFog:(enabled,options={})=>{volumetricFogEnabled=!!enabled;if(volumetricFogPass){const u=volumetricFogPass.uniforms;if(u){if(options.color&&u.uFogColor?.value?.set)u.uFogColor.value.set(options.color);if(Number.isFinite(options.density)&&u.uFogDensity&&Object.prototype.hasOwnProperty.call(u.uFogDensity,'value'))u.uFogDensity.value=Math.max(0,Math.min(.08,options.density));if(Number.isFinite(options.heightFalloff)&&u.uHeightFalloff&&Object.prototype.hasOwnProperty.call(u.uHeightFalloff,'value'))u.uHeightFalloff.value=Math.max(0,Math.min(.2,options.heightFalloff));if(Number.isFinite(options.baseHeight)&&u.uBaseHeight&&Object.prototype.hasOwnProperty.call(u.uBaseHeight,'value'))u.uBaseHeight.value=options.baseHeight;}}if(renderer&&scene&&camera)drawFrame();return{enabled:volumetricFogEnabled,available:!!volumetricFogPass};},
    setVolumetricClouds:(enabled,options={})=>{volumetricCloudsEnabled=!!enabled&&!!volumetricCloudPass&&activeEnvironmentPreset!=='studio';if(volumetricCloudPass){const u=volumetricCloudPass.uniforms;if(u){if(Number.isFinite(options.base)&&u.uCloudBase&&Object.prototype.hasOwnProperty.call(u.uCloudBase,'value'))u.uCloudBase.value=options.base;if(Number.isFinite(options.top)&&u.uCloudTop&&Object.prototype.hasOwnProperty.call(u.uCloudTop,'value'))u.uCloudTop.value=Math.max((Number(u.uCloudBase?.value)||0)+1,options.top);if(Number.isFinite(options.density)&&u.uCloudDensity&&Object.prototype.hasOwnProperty.call(u.uCloudDensity,'value'))u.uCloudDensity.value=Math.max(0,Math.min(2,options.density));if(Number.isFinite(options.scale)&&u.uCloudScale&&Object.prototype.hasOwnProperty.call(u.uCloudScale,'value'))u.uCloudScale.value=Math.max(.0005,Math.min(.05,options.scale));if(Number.isFinite(options.atmosphereStrength)&&u.uAtmosphereStrength&&Object.prototype.hasOwnProperty.call(u.uAtmosphereStrength,'value'))u.uAtmosphereStrength.value=Math.max(0,Math.min(1,options.atmosphereStrength));if(Number.isFinite(options.coverage)&&u.uCloudCoverage)u.uCloudCoverage.value=Math.max(0,Math.min(1,options.coverage));if(Number.isFinite(options.detail)&&u.uCloudDetail)u.uCloudDetail.value=Math.max(0,Math.min(1,options.detail));if(Number.isFinite(options.steps)&&u.uCloudSteps)u.uCloudSteps.value=Math.max(8,Math.min(40,Math.floor(options.steps)));if(Number.isFinite(options.windX)&&Number.isFinite(options.windZ)&&u.uCloudWind?.set)u.uCloudWind.value.set(Math.max(-4,Math.min(4,options.windX)),Math.max(-4,Math.min(4,options.windZ)));}}if(renderer&&scene&&camera)drawFrame();return{enabled:volumetricCloudsEnabled,available:!!volumetricCloudPass};},
    getQualityPreset:()=>({requested:qualityPreset,active:resolveQualityPreset(qualityPreset),adaptiveEnabled:adaptiveQualityEnabled,adaptiveLevel:adaptiveQualityLevel,safetyLimited:memorySafetyApplied,hardware:qualityHardwareCapabilities()}),
    getMemoryStats:memorySnapshot,
    getStats:()=>renderer?{
      calls:renderer.info?.render?.calls||0,
      contactShadows:{enabled:contactShadowsEnabled,available:!!contactShadowPass,steps:contactShadowPass?.uniforms?.uSteps?.value||0},
      triangles:renderer.info?.render?.triangles||0,
      points:renderer.info?.render?.points||0,
      geometries:renderer.info?.memory?.geometries||0,
      textures:renderer.info?.memory?.textures||0,
      instancedBatches:instancedBatches.size,
      clusteredLighting:{enabled:clusteredLightingEnabled,active:clusteredLightingActive,available:!!clusteredLightingResources,pointLights:clusteredLightingResources?.lightCount||0,clusteredPointLights:clusteredLightSet.size,nativeFallbackPointLights:[...dynamicLights.values()].filter(light=>light.isPointLight&&light.visible).length,updatedClusters:clusteredLightingUpdatedClusters,grid:[CLUSTER_GRID_X,CLUSTER_GRID_Y,CLUSTER_GRID_Z],maxLightsPerCluster:CLUSTER_MAX_PER_CELL,mode:'cpu-cluster-assignment-gpu-brdf'},
      virtualTexturing:{textures:virtualTextures.size,queuedPages:virtualTextureQueue.length,residentPages:virtualTexturePageCache.size,requestedPages:virtualTextureRequests,uploadedPages:virtualTextureTileUploads,atlasBytes:[...virtualTextureAtlases.values()].reduce((sum,atlas)=>sum+atlas.bytes,0),atlasCount:virtualTextureAtlases.size},
      gpuInstanceFrustumCulling:{enabled:gpuInstanceFrustumCullingEnabled,mode:'vertex-shader-sphere-test',primitiveBatches:[...instancedBatches.values()].filter(batch=>batch.userData?.pstudioGPUFrustumConfigured).length,modelBatches:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.foliageBatches||[]).filter(entry=>entry.mesh.userData?.pstudioGPUFrustumConfigured).length,0)},
      instancedInstances:[...instancedBatches.values()].reduce((sum,batch)=>sum+batch.count,0),foliageInstancedBatches:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.foliageBatches?.filter(entry=>entry.isTree).length||0),0),modelInstancedBatches:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.foliageBatches?.filter(entry=>!entry.isTree).length||0),0),modelStreamChunks:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.streamChunks?.length||0),0),activeModelStreamChunks:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.streamChunks?.filter(chunk=>chunk.userData.pstudioStreamActive!==false).length||0),0),foliageInstancedInstances:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.foliageBatches||[]).reduce((n,entry)=>n+entry.sources.length,0),0),
      gpuParticleSystems:particleEmitters.size+particleBursts.size,
      models:modelInstances.size,
      modelPreparationPending,
      stagedTextureUploads,
      parallelShaderCompileSupported,
      frustumCulledMeshes:[...modelInstances.values()].reduce((sum,instance)=>sum+instance.meshes.filter(mesh=>mesh.frustumCulled).length,0),
      renderTimeMs:Number(lastRenderDurationMs.toFixed(2)),gpuRenderTimeMs:lastGpuRenderDurationMs?Number(lastGpuRenderDurationMs.toFixed(2)):null,timingSource:adaptiveMetricSource,gpuTimerQuerySupported:!!gpuTimerExtension,quality:resolveQualityPreset(qualityPreset),adaptive:{enabled:adaptiveQualityEnabled,level:adaptiveQualityLevel,frameEMA:Number(adaptiveFrameEMA.toFixed(2)),source:adaptiveMetricSource},gi:{probeCount:bakedLightProbeVolume?.length||0,bounces:bakedGIBounces,objectLocalSH:true,uvLightmappedMeshes:lightmapTargets().filter(({object})=>!!object.userData.pstudioLightmapTexture).length,pendingLightmaps:pendingLightmaps.size,bvhAvailable:!!window.PStudioBVH},csm:{enabled:!!csm,cascades:csm?.cascades||0,shadowDistance:worldRenderConfig.shadowDistance},environmentFX:window.PStudioEnvironmentFX?.getStats?.()||null,memory:{deviceMemoryGiB:deviceMemoryGiB(),modelEstimateBytes:[...modelCache.values()].reduce((sum,asset)=>sum+(Number(asset.memoryEstimateBytes)||0),0),jsHeapUsedBytes:Number(window.performance?.memory?.usedJSHeapSize)||null,jsHeapLimitBytes:Number(window.performance?.memory?.jsHeapSizeLimit)||null,resourceCache:window.PStudioResources?.stats?.()||null,clusteredLightingBytes:clusteredLightingResources?.bytes||0,virtualTextureAtlasBytes:[...virtualTextureAtlases.values()].reduce((sum,atlas)=>sum+atlas.bytes,0)},volumetricClouds:{available:!!volumetricCloudPass,enabled:volumetricCloudsEnabled},waterDepthPrepass:{available:!!waterDepthTarget,failed:waterDepthPrepassFailed},temporalAA:{available:!!taaPass,enabled:!!taaPass?.enabled,accumulating:!!taaPass?.accumulate},volumetricFog:{available:!!volumetricFogPass,enabled:volumetricFogEnabled}
    }:null,
    loadEnvironmentHDR,
    bakeLightProbe,
    clearLightProbe:()=>{let changed=false;if(bakedLightProbe){scene?.remove(bakedLightProbe);bakedLightProbe=null;changed=true;}if(bakedLightProbeVolume){for(const item of bakedLightProbeVolume){scene?.remove(item.light);item.light.dispose?.();}bakedLightProbeVolume=null;bakedGIBounces=0;changed=true;}if(changed)drawFrame();return changed;},
    bakeLightProbeVolume,bakeEnvironmentGI,bakeUVLightmaps,saveLightmaps,loadLightmaps,clearLightmaps,setWorldRenderConfig,registerWorldChunk,assignObjectToChunk,unregisterWorldChunk,
    isOwnerChunkActive,
    setGPUInstanceFrustumCulling:enabled=>{gpuInstanceFrustumCullingEnabled=!!enabled;updateGPUInstanceFrustumPlanes();return gpuInstanceFrustumCullingEnabled;},
    setClusteredLighting:enabled=>{clusteredLightingEnabled=!!enabled;updateClusteredLighting(true);return{enabled:clusteredLightingEnabled,available:!!clusteredLightingResources,active:clusteredLightingActive};},
    setOcclusionCulling:enabled=>{occlusionEnabled=!!enabled;for(const mesh of meshCache.values()){mesh.userData.pstudioOccluded=false;mesh.visible=true;}for(const instance of modelInstances.values()){instance.root.userData.pstudioOccluded=false;instance.root.visible=true;}for(const batch of instancedBatches.values())for(const source of batch.userData.instanceSources||[])source.mesh.userData.pstudioOccluded=false;return occlusionEnabled;},
    getWorldStats:()=>({chunks:worldChunks.size,activeChunks:[...worldChunks.values()].filter(c=>c.active).length,loadingChunks:[...worldChunks.values()].filter(c=>c.loading).length,chunkErrors:[...worldChunks.values()].filter(c=>c.error).map(c=>({id:c.id,error:c.error})),assignedObjects:objectChunkAssignments.size,config:{...worldRenderConfig,lodDistances:worldRenderConfig.lodDistances.slice()}}),
    isAvailable: () => !!window.THREE,
    getModelError: name => modelLoadErrors.get(name) || null,
    invalidateAsset
  };
  window.addEventListener('resize', resize);
})();