/* PStudio isolated 3D renderer.
 * This module only owns the additional WebGL canvas; the existing 2D renderer is untouched.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('game-3d-canvas');
  if (!canvas) return;
  let renderer = null;
  let productionRendererBridge = null;
  let productionRendererPromotionStarted = false;
  let productionRendererPromotionPromise = null;
  let productionRendererFallbackRequested = false;
  let lastWebGPUBridgePixelRatio = 0;
  let productionWebGPUCompileStage = null;
  let productionWebGPUBlockers = [];
  let productionPendingCommands = null;
  let productionPendingRenderRevision = 0;
  let rendererInitializationFailed=false;
  let postProcessingFailed=false,postProcessingFailureReason='';
  let composer=null,bloomPass=null,ssaoPass=null,gtaoPass=null,ssrPass=null,outputPass=null,taaPass=null,smaaPass=null,volumetricFogPass=null,volumetricCloudPass=null,contactShadowPass=null,godRaysPass=null;
  let bloomEnabled=false,ssaoEnabled=false,bloomStrength=0.45,volumetricFogEnabled=false,volumetricCloudsEnabled=false,contactShadowsEnabled=false,contactShadowsRequested=null,temporalAAEnabled=false,godRaysEnabled=false,godRaysFallbackEnabled=false,godRaysIntensity=0;
  function readSavedQualityPreset(){
    try{
      const saved=window.localStorage?.getItem('pstudio-render-quality')||'auto';
      // Before Ultra 2x existed, the saved "ultra" value represented today's Maximum tier.
      const migrated=saved==='ultra'?'maximum':saved;
      return ['auto','mobile','balanced','high','maximum','ultra'].includes(migrated)?migrated:'auto';
    }catch(_){return 'auto';}
  }
  let ssrEnabled=false,qualityAOEnabled=false,qualityPreset=readSavedQualityPreset();
  let csm=null,adaptiveQualityEnabled=true,adaptiveQualityLevel=2,adaptiveFrameEMA=0,adaptiveSlowFrames=0,adaptiveFastFrames=0,adaptiveLastChange=0;
  let dynamicResolutionScale=1,dynamicResolutionSlowSamples=0,dynamicResolutionFastSamples=0,dynamicResolutionLastChange=0,dynamicResolutionLastSampleAt=0,dynamicResolutionMetricSource='unavailable';
  const frameIntervalSamples=[],cpuRenderSamples=[],gpuRenderSamples=[];
  let lastFrameRenderStats={calls:0,triangles:0,points:0,geometries:0,textures:0};
  let lastDrawFrameStartedAt=0,lastFrameIntervalMs=0,lastFrameIntervalSampleAt=0,lastPerformanceEmitAt=0,performanceMonitorEnabled=false;
  let gpuTimerGl=null,gpuTimerExtension=null,gpuTimerQueries=[],lastGpuRenderDurationMs=0,lastGpuTimerTimestamp=0,adaptiveMetricSource='cpu-render-submission';
  let parallelShaderCompileSupported=false,modelPreparationPending=0,stagedTextureUploads=0;
  let shaderCompileQueue=Promise.resolve();
  let worldFrustum=null,worldFrustumMatrix=null,worldFrustumSphere=null;
  let gpuInstanceFrustumCullingEnabled=true;
  let occlusionRaycaster=null,occlusionEnabled=true,occlusionCursor=0,occlusionFrame=0;
  let lastProbeCameraPosition=null;
  let probeVolumeGeneration=0,probeRadianceCacheHits=0,probeRadianceCacheMisses=0,probeRadianceCacheRecomputes=0;
  const objectProbeRadianceCache=new WeakMap();
  let dynamicGIEnabled=false,dynamicGIStatus='disabled',dynamicProbeCache=[],dynamicProbeDirty=null,dynamicProbeCursor=0,dynamicProbeSignature='',lastDynamicProbeSignatureAt=0,lastDynamicProbeUpdateAt=0,dynamicProbeUpdates=0,probeCaptureActive=false,dynamicProbeCaptureInFlight=false,probeBakeInFlight=false;
  let dynamicProbeSnapshots=[],dynamicProbeFadeLastPublishAt=0;
  let hdrTexture=null,hdrEnvironmentTarget=null,hdrShowBackground=false,bakedLightProbe=null,bakedLightProbeVolume=null,bakedGIBounces=0;
  const worldChunks=new Map(),objectChunkAssignments=new Map();
  const worldRenderConfig={maxDrawDistance:2400,lodDistances:[25,70,150],shadowDistance:900,probeBlendCount:4,maxConcurrentChunkLoads:4};
  let worldStreamingInterests=[];
  let particleClock=0,lastRenderDurationMs=0;
  const RENDER_METRIC_HISTORY=120;
  const DYNAMIC_PROBE_UPDATE_INTERVAL_MS=900;
  const renderingFrameBudgetController=window.PStudioRenderingBudget?.createPStudioFrameBudgetController?.()||null;
  const renderingFrameBudget=renderingFrameBudgetController?.state||{source:'unavailable',measuredMs:null,targetFrameMs:16.67,resourcePressure:0,scale:1,mirrorIntervalFrames:1,mirrorResolutionScale:1,giCaptureAllowed:true,giCadenceMultiplier:1,cloudStepScale:1,fogStepScale:1,contactShadowStepScale:1,revision:0};
  let frameBudgetCurrentPosition=null,frameBudgetPreviousPosition=null,frameBudgetCurrentDirection=null,frameBudgetPreviousDirection=null,frameBudgetCameraValid=false,lastFrameBudgetEventRevision=-1;
  function dynamicProbeCaptureIntervalMs(renderMs,gpuFresh){
    const helper=window.PStudioRenderingGI?.dynamicProbeCaptureIntervalMs;
    return typeof helper==='function'?helper(renderMs,gpuFresh):DYNAMIC_PROBE_UPDATE_INTERVAL_MS;
  }
  const waterMaterials=new Set();
  let mirrorWaterFrameCounter=0;
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
  let clusteredLightingLastUpdate=0,clusteredLightingLastSignature='',clusteredLightingUpdatedClusters=0,clusteredLightingSnapshotRevision=0;
  let clusteredLightSet=new Set();
  let modelBuildGeneration=0;
  const modelLoadErrors = new Map();
  const modelBuildErrors = new Map();
  let lastCommands = null;
  let selectedOwnerId = null;
  let selectionSignature = '';
  let gridGroup = null;
  let editorHelperGroup=null,editorAxesHelper=null,editorOriginMarker=null;
  let editorOverlayVisibility={grid:true,axes:false,origin:true};
  let hemisphereLight = null;
  let keyLight = null;
  const dynamicLights = new Map();
  const particleBursts = new Map();
  const particleEmitters = new Map();
  const trailEffects = new Map();
  const modelCollisionCache = new Map();
  const transformedCollisionCache = new Map();
  let environmentTexture = null;
  let environmentSignature = '';
  let scenePresetTexture=null,scenePresetTarget=null,scenePresetSignature='',scenePresetUsesPhysicalSky=false;
  let activeEnvironmentPreset='day';
  let physicalSky=null;
  let moonMesh=null,moonSurfaceTexture=null,moonDirection=null,moonLightDirection=null,moonIntensity=0;
  let nightTwinkleStars=null;
  let sunMesh=null,sunSurfaceTexture=null,sunDirection=null,sunViewDirection=null,sunIntensity=0,sunAngularRadius=1.2,sunGlareStrength=0,moonGlareStrength=0;
  let adaptiveMaximumTouchMode=false,adaptiveUltraTouchMode=false,adaptiveTouchPostFxBudget=false;
  const meshCache = new Map();
  const gridCache = new Map();
  let lastSize = { width: 0, height: 0 };
  let orbitYaw = 0, orbitPitch = 0, zoom = 1, pointerMode = null, pointerStart = null, dragInfo = null;
  let raycaster = null, cameraCollisionRaycaster = null, pointerNdc = null, controlsReady = false;
  const activePointers = new Map();
  let pinchDistance = 0;
  let pinchGestureStart = null;
  let pinchGestureMode = null;
  let cameraShakeState=null;
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
    maximum:{pixelRatio:2.1,shadowSize:4096,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true},
    ultra:{pixelRatio:4.2,shadowSize:8192,shadowMode:'vsm',ao:true,ssr:true,clouds:true,atmosphere:true,contactShadows:true}
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
    if(memoryGiB>=8&&cpuCores>=8&&maxTextureSize>=8192)return 'maximum';
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
    const memoryCap=qualityPreset==='ultra'
      ?(memory<=2?2048:memory<=4?3072:memory<=8?6144:8192)
      :qualityPreset==='auto'?(memory<=2?1024:memory<=4?2048:4096):(memory<=4?2048:memory<=6?3072:4096);
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
      // Adaptive Ultra must change the actual drawing-buffer resolution, not only
      // shadow/AO settings. Level 2 preserves the full 2x Maximum target; lower
      // levels trade resolution for frame time on constrained devices.
      const adaptiveScale=adaptive?[0.35,0.65,1][level]:1;
      // A constrained touch device must not allocate a desktop-class Ultra drawing buffer.
      const mobilePixelRatioCap=adaptiveTouchPostFxBudget?[.8,1.0,1.2][level]:Infinity;
      const targetRatio=Math.min(requested*adaptiveScale,mobilePixelRatioCap);
      const rect=canvas?.getBoundingClientRect?.()||{};
      const width=Math.max(0,Number(rect.width)||0),height=Math.max(0,Number(rect.height)||0);
      if(width<=0||height<=0)return targetRatio;
      const memory=hardware.memoryGiB;
      const pixelBudget=memory<=2?9500000:memory<=4?14000000:memory<=6?20000000:28000000;
      const textureCap=hardware.maxTextureSize/Math.max(width,height);
      const pixelCap=Math.sqrt(pixelBudget/(width*height));
      return Math.max(.6,Math.min(targetRatio,textureCap,pixelCap));
    }
    const profile=QUALITY_PROFILES[selected]||QUALITY_PROFILES.balanced;
    const scale=adaptive
      ?(selected==='maximum'?[.66,.78,.94][level]:[.68,.84,1][level])
      :1;
    const mobilePixelRatioCap=adaptiveTouchPostFxBudget?[.72,.9,1.05][level]:Infinity;
    return Math.min(dpr,profile.pixelRatio*scale,mobilePixelRatioCap);
  }

  function effectiveRenderPixelRatio(selected=resolveQualityPreset(qualityPreset),level=adaptiveQualityLevel,adaptive=adaptiveQualityEnabled){
    const base=resolveQualityRenderPixelRatio(selected,level,adaptive);
    const memorySafe=memorySafetyApplied?Math.min(base,0.8):base;
    return Math.max(0.45,memorySafe*dynamicResolutionScale);
  }
  function applyEffectiveRenderScale(){
    if(!renderer)return 0;
    const ratio=effectiveRenderPixelRatio();
    renderer.setPixelRatio(ratio);composer?.setPixelRatio?.(renderer.getPixelRatio());
    return ratio;
  }
  function resetPostProcessingFailure(){
    postProcessingFailed=false;
    postProcessingFailureReason='';
  }
  function applyQualityPreset(name='auto'){
    memorySafetyApplied=false;
    resetPostProcessingFailure();
    qualityPreset=QUALITY_PROFILES[name]?name:'auto';
    dynamicResolutionScale=1;dynamicResolutionSlowSamples=0;dynamicResolutionFastSamples=0;dynamicResolutionLastChange=0;dynamicResolutionLastSampleAt=0;dynamicResolutionMetricSource='unavailable';
    adaptiveQualityFrameEMAReset();
    const selected=resolveQualityPreset(qualityPreset);
    const isTouchDevice=Number(window.navigator?.maxTouchPoints||0)>0;
    const hardware=qualityHardwareCapabilities();
    adaptiveMaximumTouchMode=qualityPreset==='maximum'&&isTouchDevice&&
      (hardware.memoryGiB<=6||hardware.cpuCores<=6||hardware.maxTextureSize<8192);
    adaptiveUltraTouchMode=qualityPreset==='ultra'&&isTouchDevice&&
      (hardware.memoryGiB<=6||hardware.cpuCores<=6||hardware.maxTextureSize<8192);
    adaptiveTouchPostFxBudget=adaptiveMaximumTouchMode||adaptiveUltraTouchMode;
    adaptiveQualityEnabled=qualityPreset==='auto'||qualityPreset==='ultra'||adaptiveMaximumTouchMode;
    // Ultra retains its 2x Maximum output target. Constrained touch devices begin one
    // adaptive rung lower so the premium effects do not stall the editor during startup.
    adaptiveQualityLevel=2;
    if(adaptiveMaximumTouchMode||adaptiveUltraTouchMode)adaptiveQualityLevel=1;
    if(qualityPreset==='auto'&&selected==='mobile'&&isTouchDevice&&deviceMemoryGiB()>2)adaptiveQualityLevel=1;
    const baseProfile=QUALITY_PROFILES[selected],profile=baseProfile;
    const effectsEnabled=!memorySafetyApplied;
    const premiumEffectsEnabled=effectsEnabled&&!adaptiveTouchPostFxBudget;
    qualityAOEnabled=premiumEffectsEnabled&&profile.ao&&!!ssaoPass;ssaoEnabled=qualityAOEnabled;
    ssrEnabled=premiumEffectsEnabled&&profile.ssr&&!!ssrPass;
    contactShadowsEnabled=!!contactShadowPass&&premiumEffectsEnabled&&(contactShadowsRequested===null?!!profile.contactShadows:contactShadowsRequested);
    if(contactShadowPass){contactShadowPass.enabled=contactShadowsEnabled;contactShadowPass.setQuality?.(selected,adaptiveQualityLevel);}
    if(taaPass&&!temporalAAEnabled)taaPass.sampleLevel=adaptiveQualityEnabled?(adaptiveQualityLevel>=2?2:adaptiveQualityLevel===1?1:0):(['maximum','ultra'].includes(selected)?2:selected==='high'?1:0);
    if(smaaPass)smaaPass.enabled=!taaPass;
    if(renderer){
      applyEffectiveRenderScale();
      renderer.shadowMap.enabled=true;
      renderer.shadowMap.type=profile.shadowMode==='vsm'&&effectsEnabled?window.THREE.VSMShadowMap:window.THREE.PCFSoftShadowMap;
      renderer.shadowMap.needsUpdate=true;
      const lights=csm?.lights?.length?csm.lights:(keyLight?[keyLight]:[]);
      const requestedShadow=adaptiveUltraTouchMode?[1024,1536,2048][adaptiveQualityLevel]:adaptiveMaximumTouchMode?[768,1024,1536][adaptiveQualityLevel]:qualityPreset==='ultra'?[3072,4096,8192][adaptiveQualityLevel]:Math.min(4096,profile.shadowSize);
      for(const light of lights)if(light?.shadow){const size=resolveShadowMapSize(csm?requestedShadow:Math.min(requestedShadow,profile.shadowSize));light.shadow.mapSize.set(size,size);light.shadow.dispose?.();light.shadow.radius=profile.shadowMode==='vsm'&&effectsEnabled?(qualityPreset==='ultra'?1.9:2.5):2;light.shadow.bias=-0.00003;light.shadow.normalBias=0.006;light.shadow.needsUpdate=true;}
      if(csm){csm.maxFar=worldRenderConfig.shadowDistance;csm.updateFrustums?.();}
      volumetricCloudsEnabled=!!(premiumEffectsEnabled&&profile.clouds&&volumetricCloudPass&&activeEnvironmentPreset!=='studio');
      if(volumetricCloudPass){volumetricCloudPass.enabled=volumetricCloudsEnabled;volumetricCloudPass.setQuality?.(selected,adaptiveQualityLevel);}
      volumetricFogEnabled=!!(premiumEffectsEnabled&&profile.atmosphere&&volumetricFogPass);
      if(volumetricFogPass){volumetricFogPass.enabled=volumetricFogEnabled;volumetricFogPass.setQuality?.(selected,adaptiveQualityLevel);}
      if(contactShadowPass){contactShadowPass.enabled=contactShadowsEnabled;contactShadowPass.setQuality?.(selected,adaptiveQualityLevel);}
      if(gtaoPass?.updateGtaoMaterial){const level=adaptiveQualityEnabled?adaptiveQualityLevel:2;const aoSamples=selected==='ultra'?[16,28,40][level]:selected==='maximum'?[12,20,32][level]:[8,12,16][level];const pdSamples=selected==='ultra'?[20,32,44][level]:selected==='maximum'?[14,22,32][level]:[12,18,24][level];gtaoPass.updateGtaoMaterial({radius:selected==='ultra'?0.92:selected==='maximum'?0.72:0.52,thickness:selected==='ultra'?0.2:selected==='maximum'?0.16:0.12,distanceExponent:1.5,scale:selected==='ultra'?1.12:selected==='maximum'?1.0:0.85,samples:aoSamples,screenSpaceRadius:false});gtaoPass.updatePdMaterial?.({rings:selected==='ultra'?4:selected==='maximum'?3:2,samples:pdSamples,radius:selected==='ultra'?10:selected==='maximum'?9:8});}
      lastSize={width:0,height:0};resize();
    }
    try{window.PStudioEvents?.emit('render.quality.changed',{requested:qualityPreset,active:selected,profile,adaptive:adaptiveQualityEnabled,outputMultiplier:qualityPreset==='ultra'?2:1});}catch(_){}
    try{window.localStorage?.setItem('pstudio-render-quality',qualityPreset);}catch(_){}
    try{window.dispatchEvent(new CustomEvent('pstudio-quality-state-changed',{detail:{requested:qualityPreset,active:selected,adaptiveLevel:adaptiveQualityLevel,adaptiveEnabled:adaptiveQualityEnabled,safetyLimited:memorySafetyApplied}}));}catch(_){}
    return{preset:selected,...profile,adaptiveLevel:adaptiveQualityLevel};
  }
  function adaptiveQualityFrameEMAReset(){adaptiveFrameEMA=0;adaptiveSlowFrames=0;adaptiveFastFrames=0;}
  function updateDynamicResolutionFromMetrics(now,hasRecentGpuSample){
    if(!adaptiveQualityEnabled||!renderer)return false;
    let sampleMs=0,sampleAt=0,source='unavailable';
    if(hasRecentGpuSample&&Number.isFinite(lastGpuRenderDurationMs)&&lastGpuRenderDurationMs>0&&lastGpuTimerTimestamp>0){
      sampleMs=lastGpuRenderDurationMs;
      sampleAt=lastGpuTimerTimestamp;
      source='gpu-timer-query';
    }else{
      const pageVisible=typeof document==='undefined'||document.visibilityState!=='hidden';
      const frameInterval=Number(lastFrameIntervalMs)||0;
      // Frame pacing is the fallback when timer queries are absent, disjoint or stale.
      // Ignore background-tab pauses, initial frames and long scheduling stalls.
      if(!pageVisible||!lastFrameIntervalSampleAt||now-lastFrameIntervalSampleAt>250||frameInterval<1||frameInterval>100){
        dynamicResolutionMetricSource='unavailable';
        return false;
      }
      sampleMs=frameInterval;
      sampleAt=lastFrameIntervalSampleAt;
      source='frame-interval-fallback';
    }
    if(!sampleAt||sampleAt===dynamicResolutionLastSampleAt)return false;
    dynamicResolutionLastSampleAt=sampleAt;
    dynamicResolutionMetricSource=source;
    const touch=Number(window.navigator?.maxTouchPoints||0)>0;
    const targetMs=(touch||adaptiveMaximumTouchMode||adaptiveUltraTouchMode)?20:16.67;
    if(sampleMs>targetMs*1.06){dynamicResolutionSlowSamples++;dynamicResolutionFastSamples=0;}
    else if(sampleMs<targetMs*0.78){dynamicResolutionFastSamples++;dynamicResolutionSlowSamples=0;}
    else{dynamicResolutionSlowSamples=Math.max(0,dynamicResolutionSlowSamples-1);dynamicResolutionFastSamples=0;}
    if(now-dynamicResolutionLastChange<900)return false;
    let next=dynamicResolutionScale;
    if(dynamicResolutionSlowSamples>=8&&dynamicResolutionScale>0.55)next=Math.max(0.55,dynamicResolutionScale-0.05);
    else if(dynamicResolutionFastSamples>=45&&dynamicResolutionScale<1)next=Math.min(1,dynamicResolutionScale+0.025);
    if(Math.abs(next-dynamicResolutionScale)<0.001)return false;
    dynamicResolutionScale=next;dynamicResolutionLastChange=now;dynamicResolutionSlowSamples=0;dynamicResolutionFastSamples=0;
    applyEffectiveRenderScale();lastSize={width:0,height:0};resize();
    try{window.PStudioEvents?.emit('render.dynamic-resolution.changed',{
      scale:Number(dynamicResolutionScale.toFixed(3)),
      gpuTimeMs:source==='gpu-timer-query'?Number(sampleMs.toFixed(2)):null,
      frameIntervalMs:source==='frame-interval-fallback'?Number(sampleMs.toFixed(2)):null,
      targetMs,source
    });}catch(_){}
    return true;
  }
  function applyAdaptiveQuality(){
    if(!adaptiveQualityEnabled||!renderer)return;
    const now=window.performance?.now?.()??Date.now();
    const hasRecentGpuSample=!!gpuTimerGl&&lastGpuRenderDurationMs>0&&now-lastGpuTimerTimestamp<1500;
    updateDynamicResolutionFromMetrics(now,hasRecentGpuSample);
    const fallbackFrameMs=Math.max(Number(lastRenderDurationMs)||0,Number(lastFrameIntervalMs)||0);
    adaptiveMetricSource=hasRecentGpuSample?'gpu-timer-query':lastFrameIntervalMs>0?'frame-interval-fallback':'cpu-render-submission';
    // GPU timer queries are unavailable on some mobile browsers. In that case,
    // use observed frame cadence as well as CPU submission time so GPU-bound
    // Ultra scenes can still step down their real render resolution.
    const ms=hasRecentGpuSample?lastGpuRenderDurationMs:fallbackFrameMs;
    adaptiveFrameEMA=adaptiveFrameEMA?adaptiveFrameEMA*0.9+ms*0.1:ms;
    if(adaptiveFrameEMA>19){adaptiveSlowFrames++;adaptiveFastFrames=0;}
    else if(adaptiveFrameEMA<15){adaptiveFastFrames++;adaptiveSlowFrames=0;}
    else{adaptiveSlowFrames=Math.max(0,adaptiveSlowFrames-1);adaptiveFastFrames=0;}
    if(now-adaptiveLastChange<1800)return;
    let changed=false;
    if(adaptiveSlowFrames>=(adaptiveTouchPostFxBudget?6:35)&&adaptiveQualityLevel>0){adaptiveQualityLevel--;changed=true;}
    else if(adaptiveFastFrames>=(adaptiveTouchPostFxBudget?90:150)&&adaptiveQualityLevel<2){adaptiveQualityLevel++;changed=true;}
    if(!changed)return;
    adaptiveLastChange=now;adaptiveQualityFrameEMAReset();
    const selected=resolveQualityPreset(qualityPreset),base=QUALITY_PROFILES[selected];
    const safeScale=applyEffectiveRenderScale();
    const effects=!memorySafetyApplied&&!adaptiveTouchPostFxBudget;
    qualityAOEnabled=effects&&base.ao&&!!ssaoPass;ssaoEnabled=qualityAOEnabled;ssrEnabled=effects&&base.ssr&&!!ssrPass;
    volumetricCloudsEnabled=effects&&!!base.clouds&&!!volumetricCloudPass&&activeEnvironmentPreset!=='studio';
    volumetricFogEnabled=effects&&!!base.atmosphere&&!!volumetricFogPass;
    contactShadowsEnabled=!!contactShadowPass&&effects&&(contactShadowsRequested===null?!!base.contactShadows:contactShadowsRequested);
    if(contactShadowPass){contactShadowPass.enabled=contactShadowsEnabled;contactShadowPass.setQuality?.(selected,adaptiveQualityLevel);}
    if(volumetricCloudPass){volumetricCloudPass.enabled=volumetricCloudsEnabled;volumetricCloudPass.setQuality?.(selected,adaptiveQualityLevel);}
    if(volumetricFogPass){volumetricFogPass.enabled=volumetricFogEnabled;volumetricFogPass.setQuality?.(selected,adaptiveQualityLevel);}
    if(gtaoPass?.updateGtaoMaterial){const aoSamples=selected==='ultra'?[16,28,40][adaptiveQualityLevel]:selected==='maximum'?[12,20,32][adaptiveQualityLevel]:[8,12,16][adaptiveQualityLevel];const pdSamples=selected==='ultra'?[20,32,44][adaptiveQualityLevel]:selected==='maximum'?[14,22,32][adaptiveQualityLevel]:[12,18,24][adaptiveQualityLevel];gtaoPass.updateGtaoMaterial({radius:selected==='ultra'?0.92:selected==='maximum'?0.72:0.52,thickness:selected==='ultra'?0.2:selected==='maximum'?0.16:0.12,distanceExponent:1.5,scale:selected==='ultra'?1.12:selected==='maximum'?1.0:0.85,samples:aoSamples,screenSpaceRadius:false});gtaoPass.updatePdMaterial?.({rings:selected==='ultra'?4:selected==='maximum'?3:2,samples:pdSamples,radius:selected==='ultra'?10:selected==='maximum'?9:8});}
    if(taaPass&&!temporalAAEnabled){taaPass.sampleLevel=adaptiveQualityLevel;taaPass.accumulateIndex=-1;}
    const shadowSizes=adaptiveUltraTouchMode?[1024,1536,2048]:adaptiveMaximumTouchMode?[768,1024,1536]:qualityPreset==='ultra'?[3072,4096,8192]:qualityPreset==='maximum'?[1024,2048,4096]:[1024,1536,2048];
    const mapSize=resolveShadowMapSize(shadowSizes[adaptiveQualityLevel]);
    const lights=csm?.lights?.length?csm.lights:(keyLight?[keyLight]:[]);
    for(const light of lights)if(light?.shadow){light.shadow.mapSize.set(mapSize,mapSize);light.shadow.dispose?.();light.shadow.needsUpdate=true;}
    lastSize={width:0,height:0};resize();
    try{window.PStudioEvents?.emit('render.quality.adapted',{level:adaptiveQualityLevel,scale:safeScale,renderTimeMs:adaptiveFrameEMA,source:adaptiveMetricSource,requested:qualityPreset});}catch(_){}
    try{window.dispatchEvent(new CustomEvent('pstudio-quality-state-changed',{detail:{requested:qualityPreset,active:selected,adaptiveLevel:adaptiveQualityLevel,adaptiveEnabled:adaptiveQualityEnabled,safetyLimited:memorySafetyApplied}}));}catch(_){}
  }

  function ensureRenderer(){
    if(renderer)return true;
    if(rendererInitializationFailed)return false;
    if(!window.THREE||!window.THREE.WebGLRenderer)return false;
    const T=window.THREE;
    const webgpuModuleAvailable=typeof window.PStudioWebGPURenderer==='function';
    const tslModuleAvailable=!!window.PStudioTSL;
    const failRendererInitialization=error=>{
      rendererInitializationFailed=true;
      window.PStudio3DError=error;
      window.PStudioRenderingRuntime=Object.freeze({
        threeRevision:String(T.REVISION||'unknown'),
        productionBackend:'webgl2',
        webgl2:false,
        webgpuModuleAvailable,
        tslModuleAvailable,
        tslNodesEnabled:false,
        migration:window.PStudioRenderingMigration?.getPStudioWebGPUMigrationStatus?.({navigatorRef:window.navigator})||null,
        error:String(error?.message||error)
      });
      console.error('[PStudio] Three.js r187 WebGL2 renderer initialization failed:',error);
      try{window.dispatchEvent(new CustomEvent('pstudio-renderer-failed',{detail:{message:String(error?.message||error)}}));}catch(_){}
      return false;
    };
    // r187 uses WeakRef and FinalizationRegistry inside WebGL resource tracking.
    // Do not polyfill FinalizationRegistry: a retaining fallback would undermine
    // renderer resource lifetime and can turn model imports into memory leaks.
    if(typeof WeakRef!=='function'||typeof FinalizationRegistry!=='function'){
      return failRendererInitialization(new Error('Three.js r187 requires WeakRef and FinalizationRegistry. Update the browser/WebView to use the WebGL 2 renderer.'));
    }
    const deviceGiB=deviceMemoryGiB();
    try{
      renderer=new T.WebGLRenderer({canvas,antialias:deviceGiB>=6,alpha:false,powerPreference:deviceGiB>=4?'high-performance':'low-power',preserveDrawingBuffer:false});
      if(renderer.capabilities?.isWebGL2!==true){
        renderer.dispose?.();
        renderer=null;
        throw new Error('Three.js r187 requires WebGL 2. This browser or GPU does not expose a compatible WebGL 2 context.');
      }
    }catch(error){
      renderer?.dispose?.();
      renderer=null;
      return failRendererInitialization(error);
    }
    window.PStudioRenderingRuntime=Object.freeze({
      threeRevision:String(T.REVISION||'unknown'),
      productionBackend:'webgl2',
      webgl2:renderer.capabilities?.isWebGL2===true,
      webgpuModuleAvailable,
      tslModuleAvailable,
      tslNodesEnabled:false,
      migration:window.PStudioRenderingMigration?.getPStudioWebGPUMigrationStatus?.({navigatorRef:window.navigator})||null
    });
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
godRaysPass=window.PStudioEnvironmentFX?.createGodRaysPass?.(FX,T)||null;if(godRaysPass){godRaysPass.enabled=false;composer.addPass(godRaysPass);}
      outputPass=new FX.OutputPass();composer.addPass(outputPass);
    }
    primitiveGroup=new T.Group();modelGroup=new T.Group();gridGroup=new T.Group();selectionGroup=new T.Group();editorHelperGroup=new T.Group();
    editorOverlayVisibility=readEditorOverlayVisibility();
    editorAxesHelper=new T.AxesHelper(3.2);editorAxesHelper.renderOrder=2;editorHelperGroup.add(editorAxesHelper);
    editorOriginMarker=new T.Mesh(new T.SphereGeometry(0.075,12,8),new T.MeshBasicMaterial({color:0xe8edf5,transparent:true,opacity:0.9,depthWrite:false}));editorOriginMarker.renderOrder=3;editorHelperGroup.add(editorOriginMarker);
    scene.add(primitiveGroup,modelGroup,gridGroup,selectionGroup,editorHelperGroup);applyEditorOverlayVisibility();
    cameraPan=new T.Vector3();
    hemisphereLight=new T.HemisphereLight(0xeaf2ff,0x394150,0.9);scene.add(hemisphereLight);
    if(!csm){keyLight=new T.DirectionalLight(0xfff3df,2.8);keyLight.position.set(5,9,6);keyLight.castShadow=true;keyLight.shadow.mapSize.set(2048,2048);keyLight.shadow.camera.left=-32;keyLight.shadow.camera.right=32;keyLight.shadow.camera.top=32;keyLight.shadow.camera.bottom=-32;keyLight.shadow.camera.near=0.5;keyLight.shadow.camera.far=100;keyLight.shadow.camera.updateProjectionMatrix();keyLight.shadow.bias=-0.00008;keyLight.shadow.normalBias=0.018;scene.add(keyLight,keyLight.target);}
    occlusionRaycaster=new T.Raycaster();occlusionRaycaster.firstHitOnly=true;applyQualityPreset(qualityPreset);setupControls();return true;
  }

  function getPStudioGodRaysSettings(){
    if(!camera||!window.THREE)return{enabled:true,intensity:godRaysIntensity,lightPosition:[0.5,0.78]};
    camera.updateMatrixWorld?.(true);
    const Three=window.THREE;
    const sunDirection=keyLight?.position?.clone?.()||new Three.Vector3(5,9,6);
    if(sunDirection.lengthSq()<1e-8)sunDirection.set(5,9,6);else sunDirection.normalize();
    const sunWorld=camera.position.clone().addScaledVector(sunDirection,1000);
    const sunScreen=sunWorld.project(camera);
    const x=Number(sunScreen.x)*0.5+0.5,y=Number(sunScreen.y)*0.5+0.5;
    return{
      enabled:true,intensity:godRaysIntensity,
      lightPosition:[Number.isFinite(x)?x:0.5,Number.isFinite(y)?y:0.78]
    };
  }

  function getPStudioContactShadowSettings(){
    const uniforms=contactShadowPass?.uniforms||{};
    const direction=uniforms.uLightDirectionWorld?.value;
    return{
      enabled:true,
      intensity:Number(uniforms.uIntensity?.value??0.42),
      maxDistance:Number(uniforms.uMaxDistance?.value??0.82),
      thickness:Number(uniforms.uThickness?.value??0.075),
      depthBias:Number(uniforms.uDepthBias?.value??0.018),
      steps:Number(uniforms.uSteps?.value??12),
      fadeStart:Number(uniforms.uFadeStart?.value??28),
      fadeEnd:Number(uniforms.uFadeEnd?.value??105),
      lightDirectionWorld:direction?.toArray?.()||[Number(direction?.x??0.35),Number(direction?.y??0.82),Number(direction?.z??0.44)]
    };
  }

  function getPStudioVolumetricFogSettings(){
    const uniforms=volumetricFogPass?.uniforms||{};
    const toArray=(value,fallback)=>value?.toArray?.()||fallback;
    return{
      enabled:true,
      fogColor:toArray(uniforms.uFogColor?.value,[0.725,0.847,0.851]),
      fogAmbientColor:toArray(uniforms.uFogAmbientColor?.value,[0.851,0.933,1]),
      sunColor:toArray(uniforms.uSunColor?.value,[1,0.945,0.839]),
      sunDirection:toArray(uniforms.uSunDirection?.value,[-0.35,0.82,-0.44]),
      density:Number(uniforms.uFogDensity?.value??0.0018),
      heightFalloff:Number(uniforms.uHeightFalloff?.value??0.018),
      baseHeight:Number(uniforms.uBaseHeight?.value??0),
      anisotropy:Number(uniforms.uFogAnisotropy?.value??0.42),
      steps:Number(uniforms.uFogSteps?.value??16),
      time:Number(particleClock)||0
    };
  }

  function getPStudioVolumetricCloudSettings(){
    const uniforms=volumetricCloudPass?.uniforms||{};
    const toArray=(value,fallback)=>value?.toArray?.()||fallback;
    return{
      enabled:true,
      fogColor:toArray(uniforms.uFogColor?.value,[0.75,0.886,0.922]),
      sunColor:toArray(uniforms.uSunColor?.value,[1,0.941,0.831]),
      sunDirection:toArray(uniforms.uSunDirection?.value,[-0.42,0.78,-0.46]),
      time:Number(particleClock)||0,
      cloudBase:Number(uniforms.uCloudBase?.value??54),
      cloudTop:Number(uniforms.uCloudTop?.value??108),
      density:Number(uniforms.uCloudDensity?.value??0.78),
      scale:Number(uniforms.uCloudScale?.value??0.0095),
      coverage:Number(uniforms.uCloudCoverage?.value??0.48),
      detail:Number(uniforms.uCloudDetail?.value??0.58),
      wind:toArray(uniforms.uCloudWind?.value,[-0.8,0.32]),
      steps:Number(uniforms.uCloudSteps?.value??34),
      lightSteps:Number(uniforms.uCloudLightSteps?.value??2),
      atmosphereStrength:Number(uniforms.uAtmosphereStrength?.value??0.96)
    };
  }

  function getProductionWebGPUFeatureBlockers(commandsByObject=null){
    const blockers=[];
    const add=(id,message)=>{if(!blockers.some(item=>item.id===id))blockers.push({id,message});};
    const fx=window.PStudioEnvironmentFX?.getStats?.()||{};
    const supportsClusteredTSL=window.PStudioRenderingMigration?.supportsPStudioTSLClusteredLighting===true;
    const supportsSurfaceTSL=window.PStudioRenderingMigration?.supportsPStudioTSLSurfaceFeatures===true;
    const supportsWaterTSL=window.PStudioRenderingMigration?.supportsPStudioTSLWater===true;
    const supportsSelectedAOTSL=qualityAOEnabled
      ?window.PStudioRenderingMigration?.supportsPStudioTSLGTAO===true
      :window.PStudioRenderingMigration?.supportsPStudioTSLSSAO===true;
    const supportsSSRNode=window.PStudioRenderingMigration?.supportsPStudioTSLSSR===true;
    const supportsGodRaysNode=window.PStudioRenderingMigration?.supportsPStudioTSLGodRays===true;
    const supportsContactShadowsNode=window.PStudioRenderingMigration?.supportsPStudioTSLContactShadows===true;
    const supportsCausticsTSL=window.PStudioRenderingMigration?.supportsPStudioTSLCaustics===true;
    if(!supportsWaterTSL&&(waterMaterials.size>0||Number(fx.waterMaterials)>0))add('water','水面TSLアダプターが利用できません。');
    if(!supportsSurfaceTSL&&Number(fx.waterDetailMaterials)>0)add('water-detail','水面マイクロリップル／詳細材質のTSL移植モジュールが利用できません。');
    if(!supportsSurfaceTSL&&(Number(fx.foliageMaterials)>0||Number(fx.foliageTranslucencyMaterials)>0))add('foliage','植生の風変形・透過シェーダーのTSL移植が未完了です。');
    if(!supportsSurfaceTSL&&(Number(fx.terrainMaterials)>0||Number(fx.triplanarMaterials)>0))add('terrain','地形・トライプラナーPBRのTSL移植が未完了です。');
    if(!supportsSurfaceTSL&&Number(fx.parallaxMaterials)>0)add('parallax','パララックスマッピングのTSL移植が未完了です。');
    let hasLegacyMirrorWater=false;
    scene?.traverse?.(object=>{if(object?.userData?.pstudioMirrorWater)hasLegacyMirrorWater=true;});
    if(hasLegacyMirrorWater&&!supportsWaterTSL)add('mirror-water','Mirror Water用TSL ReflectorNodeが利用できません。');
    const activeClusterLighting=clusteredLightingActive||clusteredLightSet.size>0;
    const hasReflectorCamera=waterMaterials.size>0||Number(fx.waterMaterials)>0||hasLegacyMirrorWater;
    if(activeClusterLighting&&!supportsClusteredTSL)add('clustered-lighting','クラスタ照明のTSL／Storage Bufferアダプターが利用できません。');
    else if(activeClusterLighting&&hasReflectorCamera)add('clustered-lighting-reflector-camera','反射カメラ別のクラスタ照明データ更新が未完了です。');
    else if(activeClusterLighting)add('clustered-lighting-pbr-parity','現行TSLクラスタ照明は拡散寄与までです。PBRスペキュラ・影・全反射カメラの一致検証が終わるまでWebGL2を維持します。');
    if(bakedLightProbe||bakedLightProbeVolume?.length)add('static-gi-probe-capture','既存の静的SHプローブ生成はWebGL CubeCamera経路です。WebGPUキャプチャと係数の同等性検証が未完了です。');
    if(Number(fx.causticMaterials)>0&&!supportsCausticsTSL)add('caustics','水中コースティクスのTSL移植が未完了です。');
    if(Number(fx.toonMaterials)>0)add('toon','トゥーンシェーディングのTSL移植が未完了です。');
    if(volumetricFogEnabled){
      if(window.PStudioRenderingMigration?.supportsPStudioTSLVolumetricFog!==true)add('volumetric-fog-tsl','体積フォグのTSLノード機能が利用できません。');
      else add('volumetric-fog-parity','体積フォグTSLは実装済みですが、実機WebGPUでの散乱・深度・色差パリティ検証が未完了のためWebGL2を維持します。');
    }
    if(volumetricCloudsEnabled){
      if(window.PStudioRenderingMigration?.supportsPStudioTSLVolumetricClouds!==true)add('volumetric-clouds-tsl','体積雲のTSLノード機能が利用できません。');
      else add('volumetric-clouds-parity','体積雲TSLは実装済みですが、実機WebGPUでのノイズ・多重散乱・深度パリティ検証が未完了のためWebGL2を維持します。');
    }
    if(contactShadowsEnabled&&!supportsContactShadowsNode)add('contact-shadows','コンタクトシャドウのTSL深度レイマーチアダプターが利用できません。');
    if((ssaoEnabled||qualityAOEnabled)&&!supportsSelectedAOTSL)add('ambient-occlusion','選択中のGTAO／SSAO TSLアダプターが利用できません。');
    if(ssrEnabled&&!supportsSSRNode)add('screen-space-reflections','SSRのTSLアダプターが利用できません。');
    if(godRaysEnabled&&!supportsGodRaysNode)add('god-rays','God RaysのTSL RenderPipelineアダプターが利用できません。');
    if(dynamicGIEnabled||probeCaptureActive)add('dynamic-gi','動的SH GIキャプチャのWebGPU移植が未完了です。');
    if(particleEmitters.size>0||particleBursts.size>0)add('gpu-particles','GPUパーティクルのTSL／Compute Shader移植が未完了です。');
    if(trailEffects.size>0)add('trails','トレイルVFXのTSL移植が未完了です。');
    if(csm&&window.PStudioRenderingMigration?.supportsPStudioTSLCSM!==true)add('cascaded-shadow-maps','TSL CSMShadowNodeの移行モジュールが利用できません。');
    if(commandsByObject&&typeof commandsByObject.values==='function'){
      for(const list of commandsByObject.values()){
        for(const command of list||[]){
          const type=String(command?.type||'');
          const unsupportedDrawCommand =
            ['particles','particle_emitter','particle_emitter_stop','trail','toon_material'].includes(type)
            || (type==='water'&&!supportsWaterTSL)
            || (type==='terrain'&&!supportsSurfaceTSL);
          if(unsupportedDrawCommand){
            add('unported-command-'+type,'未移植の描画コマンドがシーンに含まれています: '+type);
          }else if(type==='material'&&String(command?.shader||'')==='custom'){
            add('custom-shader-command','独自GLSLマテリアルはTSL移植後に有効化してください。');
          }else if(type==='model_material'&&command?.toon&&command.toon.enabled!==false){
            add('toon-model-material','モデルのトゥーンマテリアルはTSL移植後に有効化してください。');
          }else if(type==='postfx'&&(
            (command?.ssao&&!supportsSelectedAOTSL)
            ||(command?.gtao&&!window.PStudioRenderingMigration?.supportsPStudioTSLGTAO)
            ||(command?.ssr&&!supportsSSRNode)
          )){
            add('postfx-command','未対応のポストプロセス機能がシーンに含まれています。');
          }
        }
      }
    }
    return blockers;
  }

  function publishProductionRendererRuntime(snapshot={}){
    const backend=snapshot.backend==='webgpu'?'webgpu':'webgl2';
    const previous=window.PStudioRenderingRuntime||{};
    window.PStudioRenderingRuntime=Object.freeze({
      ...previous,
      activeSceneBackend:backend,
      webgpuSceneSessionReady:backend==='webgpu'&&snapshot.state==='ready',
      productionBridgeState:String(snapshot.state||'idle'),
      productionBridgeStage:snapshot.stage||null,
      productionBridgeBlockers:Object.freeze([...(snapshot.blockers||productionWebGPUBlockers||[])])
    });
    try{
      window.dispatchEvent(new CustomEvent('pstudio-production-renderer-state-changed',{detail:{
        backend,state:snapshot.state||'idle',stage:snapshot.stage||null,
        blockers:snapshot.blockers||productionWebGPUBlockers||[]
      }}));
    }catch(_){}
  }

  function requestProductionWebGPUMigration(options={}){
    if(!renderer||!scene||!camera)return Promise.resolve(false);
    if(productionRendererPromotionPromise)return productionRendererPromotionPromise;
    if(!window.PStudioProductionRenderingBridgeFactory)return Promise.resolve(false);

    const existingState=productionRendererBridge?.getState?.();
    if(options.retry===true&&productionRendererBridge&&
       (existingState?.state==='fallback'||existingState?.state==='failed')){
      try{productionRendererBridge.dispose();}catch(_){}
      productionRendererBridge=null;
      productionRendererFallbackRequested=false;
    }

    if(!productionRendererBridge){
      try{
        const factory=window.PStudioProductionRenderingBridgeFactory;
        productionRendererBridge=factory({
          legacyCanvas:canvas,scene,camera,documentRef:document,navigatorRef:window.navigator,
          csm:csm?{
            enabled:true,
            cascades:csm.cascades||3,
            maxFar:csm.maxFar||worldRenderConfig.shadowDistance,
            mode:csm.mode||'practical',
            lightMargin:csm.lightMargin,
            lightDirection:csm.lightDirection?.clone?.()||null,
            lightIntensity:csm.lightIntensity,
            fade:csm.fade===true,
            shadowMapSize:csm.shadowMapSize||2048,
            shadowBias:csm.shadowBias,
            lightNear:csm.lightNear,
            lightFar:csm.lightFar,
            legacyLights:csm.lights,
            lightColor:keyLight?.color?.clone?.()||null,
            normalBias:keyLight?.shadow?.normalBias,
            shadowRadius:keyLight?.shadow?.radius
          }:null,
          pipelineOptions:{
            bloom:bloomEnabled?{enabled:true,strength:bloomStrength}:false,
            ambientOcclusion:(ssaoEnabled||qualityAOEnabled)?{enabled:true,mode:qualityAOEnabled?'gtao':'ssao',strength:0.82}:false,
            ssr:ssrEnabled?{enabled:true,quality:0.72,reflectNonMetals:true}:false,
            godRays:godRaysEnabled?getPStudioGodRaysSettings():false,
            contactShadows:contactShadowsEnabled?getPStudioContactShadowSettings():false,
            volumetricFog:volumetricFogEnabled?getPStudioVolumetricFogSettings():false,
            volumetricClouds:volumetricCloudsEnabled?getPStudioVolumetricCloudSettings():false
          },
          configureRenderer:webgpuRenderer=>{
            webgpuRenderer.outputColorSpace=window.THREE.SRGBColorSpace;
            webgpuRenderer.toneMapping=window.THREE.ACESFilmicToneMapping;
            webgpuRenderer.toneMappingExposure=1.12;
            if(webgpuRenderer.shadowMap)webgpuRenderer.shadowMap.enabled=true;
            const rect=canvas.getBoundingClientRect();
            const width=Math.max(1,Math.floor(rect.width||canvas.clientWidth||1));
            const height=Math.max(1,Math.floor(rect.height||canvas.clientHeight||1));
            const ratio=Math.max(0.5,Math.min(4.5,Number(renderer.getPixelRatio?.())||1));
            webgpuRenderer.setPixelRatio?.(ratio);
            webgpuRenderer.setSize(width,height,false);
          },
          environmentProfile:window.PStudioSceneEnvironment?.getPreset?.(activeEnvironmentPreset)||undefined,
          getClusteredLightingSnapshot:getPStudioClusteredLightingSnapshot,
          clusteredLightingOptions:{grid:{x:CLUSTER_GRID_X,y:CLUSTER_GRID_Y,z:CLUSTER_GRID_Z},maxLights:CLUSTER_MAX_LIGHTS,maxPerCell:CLUSTER_MAX_PER_CELL},
          canPromote:()=>{
            const blockers=getProductionWebGPUFeatureBlockers();
            productionWebGPUBlockers=blockers;
            return{allowed:blockers.length===0,blockers};
          },
          onStageChange:(stage,details)=>{
            productionWebGPUCompileStage=stage==='converting-materials'||stage==='compiling'?stage:null;
            if(stage==='failed'||stage==='ready'||stage==='disposed')productionWebGPUCompileStage=null;
            publishProductionRendererRuntime({
              state:stage==='failed'?'failed':'initializing-webgpu',
              backend:'webgl2',stage,blockers:productionWebGPUBlockers
            });
          },
          onStateChange:snapshot=>{
            if(snapshot.state==='ready'&&snapshot.backend==='webgpu'){
              productionWebGPUCompileStage=null;
              productionRendererFallbackRequested=false;
            }else if(snapshot.state==='ready'&&snapshot.backend==='webgl2'){
              productionWebGPUCompileStage=null;
              productionRendererFallbackRequested=false;
              window.requestAnimationFrame(()=>{
                if(productionRendererBridge?.getState?.().backend==='webgl2'&&renderer&&scene&&camera)drawFrame();
              });
            }else if(snapshot.state==='fallback'||snapshot.state==='failed'||snapshot.state==='disposed'){
              productionWebGPUCompileStage=null;
            }
            productionWebGPUBlockers=snapshot.blockers||productionWebGPUBlockers;
            publishProductionRendererRuntime(snapshot);
            if(snapshot.state==='ready'&&productionPendingCommands){
              const revision=productionPendingRenderRevision;
              window.requestAnimationFrame(()=>{
                if(productionWebGPUCompileStage!==null||!productionPendingCommands||revision!==productionPendingRenderRevision)return;
                const pending=productionPendingCommands;
                productionPendingCommands=null;
                try{render(pending);}catch(error){console.error('[PStudio] Deferred scene update after renderer promotion failed.',error);}
              });
            }
          }
        });
      }catch(error){
        productionWebGPUBlockers=[{id:'bridge-construction',message:String(error?.message||error)}];
        publishProductionRendererRuntime({state:'failed',backend:'webgl2',blockers:productionWebGPUBlockers});
        return Promise.resolve(false);
      }
    }

    productionWebGPUBlockers=productionRendererBridge.evaluate?.().blockers||productionWebGPUBlockers;
    productionRendererPromotionPromise=Promise.resolve()
      .then(()=>productionRendererBridge.initialize())
      .catch(error=>{
        productionWebGPUCompileStage=null;
        productionWebGPUBlockers=[{id:'webgpu-initialization',message:String(error?.message||error)}];
        console.warn('[PStudio] WebGPU scene promotion failed; the existing WebGL2 renderer remains active.',error);
        publishProductionRendererRuntime({state:'failed',backend:'webgl2',blockers:productionWebGPUBlockers});
        return false;
      })
      .finally(()=>{productionRendererPromotionPromise=null;});
    return productionRendererPromotionPromise;
  }

  function fallbackFromWebGPUForUnsupportedFeatures(commandsByObject){
    if(!productionRendererBridge||productionRendererFallbackRequested)return;
    if(productionRendererBridge.getState?.().backend!=='webgpu')return;
    const blockers=getProductionWebGPUFeatureBlockers(commandsByObject);
    if(!blockers.length)return;
    productionRendererFallbackRequested=true;
    productionWebGPUBlockers=blockers;
    const error=new Error('The active scene enabled a feature that has not completed its WebGPU/TSL port.');
    error.code='PSTUDIO_WEBGPU_FEATURE_NOT_PORTED';
    error.details=blockers;
    productionRendererBridge.useFallback(error).catch(fallbackError=>{
      productionRendererFallbackRequested=false;
      console.error('[PStudio] WebGL2 recovery after an unsupported WebGPU feature failed.',fallbackError);
    });
  }

  function renderingBackendStatus(){
    let migration=null;
    try{
      migration=window.PStudioRenderingMigration?.getPStudioWebGPUMigrationStatus?.({navigatorRef:window.navigator,scene})||null;
    }catch(error){
      migration={productionReady:false,error:String(error?.message||error)};
    }
    const bridge=productionRendererBridge?.getState?.()||null;
    const active=bridge?.backend==='webgpu'?'webgpu':'webgl2';
    return Object.freeze({
      active,
      target:'webgpu-tsl',
      webgpuAvailable:!!migration?.webgpuAvailable,
      productionReady:false,
      sceneSessionReady:active==='webgpu'&&bridge?.state==='ready',
      sceneReady:migration?.sceneReady??null,
      promotionState:bridge?.state||'not-started',
      promotionStage:bridge?.stage||null,
      promotionBlockers:bridge?.blockers||productionWebGPUBlockers,
      blockers:migration?.blockers||[]
    });
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
    const bridgePixelRatio=Number(renderer.getPixelRatio?.())||1;
    const bridgeRatioChanged=!!productionRendererBridge&&Math.abs(bridgePixelRatio-lastWebGPUBridgePixelRatio)>.001;
    if (width !== lastSize.width || height !== lastSize.height || bridgeRatioChanged) {
      // A hidden scene canvas may have had a zero-sized DOM rect when Ultra was selected.
      // Re-evaluate its 2x target against the now-visible buffer dimensions before resizing.
      if(qualityPreset==='ultra'){
        const safeRatio=effectiveRenderPixelRatio('ultra',adaptiveQualityLevel,adaptiveQualityEnabled);
        if(Math.abs(safeRatio-renderer.getPixelRatio())>.001){
          renderer.setPixelRatio(safeRatio);
          composer?.setPixelRatio?.(safeRatio);
        }
      }
      renderer.setSize(width, height, false);composer?.setSize(width,height);
      if(waterDepthTarget){const size=renderer.getDrawingBufferSize(new window.THREE.Vector2());waterDepthTarget.setSize(Math.max(1,size.x),Math.max(1,size.y));}
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if(productionRendererBridge){
        productionRendererBridge.resize(width,height,bridgePixelRatio);
        lastWebGPUBridgePixelRatio=bridgePixelRatio;
      }
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
          if(Number.isFinite(nanoseconds)&&nanoseconds>0){lastGpuRenderDurationMs=nanoseconds/1e6;lastGpuTimerTimestamp=now;pushMetricSample(gpuRenderSamples,lastGpuRenderDurationMs);}
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

  function mirrorWaterResolutionScale(){
    const hardware=qualityHardwareCapabilities();
    const base=memorySafetyApplied||adaptiveTouchPostFxBudget||(hardware.touch&&adaptiveQualityLevel===0)?0.86:1.0;
    return base*(renderingFrameBudgetController?renderingFrameBudget.mirrorResolutionScale:1);
  }
  function configureMirrorWaterMaterial(material){
    const T=window.THREE;
    const hadForeignHook =
      (Object.prototype.hasOwnProperty.call(material,'onBeforeCompile')&&typeof material.onBeforeCompile==='function')
      || (Object.prototype.hasOwnProperty.call(material,'customProgramCacheKey')&&typeof material.customProgramCacheKey==='function');
    const uniforms={
      uMirrorReflection:{value:null},
      uMirrorTextureMatrix:{value:new T.Matrix4()},
      uMirrorReflectivity:{value:1.0},
      uMirrorWaveStrength:{value:0.05},
      uMirrorTime:{value:0}
    };
    material.userData.pstudioMirrorUniforms=uniforms;
    material.onBeforeCompile=shader=>{
      Object.assign(shader.uniforms,uniforms);
      shader.vertexShader='uniform mat4 uMirrorTextureMatrix;\nvarying vec4 vPStudioMirrorCoord;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvPStudioMirrorCoord = uMirrorTextureMatrix * vec4(position, 1.0);'
      );
      shader.fragmentShader='uniform sampler2D uMirrorReflection;\nuniform float uMirrorReflectivity;\nuniform float uMirrorWaveStrength;\nuniform float uMirrorTime;\nvarying vec4 vPStudioMirrorCoord;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\n'+
        'vec2 pStudioMirrorUv = vPStudioMirrorCoord.xy / max(vPStudioMirrorCoord.w, 0.0001);\n'+
        'vec2 pStudioMirrorRipple = vec2(sin(pStudioMirrorUv.y * 190.0 + uMirrorTime * 0.65), cos(pStudioMirrorUv.x * 170.0 - uMirrorTime * 0.52)) * (0.008 * uMirrorWaveStrength);\n'+
        'vec2 pStudioMirrorSampleUv = pStudioMirrorUv + pStudioMirrorRipple;\n'+
        'float pStudioMirrorInside = step(0.0, pStudioMirrorSampleUv.x) * step(pStudioMirrorSampleUv.x, 1.0) * step(0.0, pStudioMirrorSampleUv.y) * step(pStudioMirrorSampleUv.y, 1.0);\n'+
        'vec3 pStudioMirrorSample = texture2D(uMirrorReflection, clamp(pStudioMirrorSampleUv, 0.001, 0.999)).rgb;\n'+
        'float pStudioMirrorFresnel = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 5.0);\n'+
        'float pStudioMirrorAmount = clamp(uMirrorReflectivity, 0.0, 1.0) * pStudioMirrorInside;\n'+
        'vec3 pStudioMirrorTinted = pStudioMirrorSample;\n'+
        'gl_FragColor.rgb = mix(gl_FragColor.rgb, pStudioMirrorTinted, pStudioMirrorAmount);'
      );
    };
    material.customProgramCacheKey=()=> 'pstudio-planar-mirror-water-v2';
    material.userData.pstudioMirrorUniforms=uniforms;
    const features=new Set(Array.isArray(material.userData.pstudioTSLFeatures)?material.userData.pstudioTSLFeatures:[]);
    features.add('water');
    material.userData.pstudioTSLPortVersion=1;
    material.userData.pstudioTSLPortHasForeignHook=hadForeignHook;
    material.userData.pstudioTSLFeatures=[...features];
    material.userData.pstudioWaterTSLSettings={
      mirrorOnly:true,amplitude:0,waveStrength:0.05,
      shallow:'#0b3d52',deep:'#0b3d52',foam:'#0b3d52',
      reflectivity:1,reflectionResolutionScale:0.5,absorption:0.01
    };
    material.pstudioTSLPortApprovedCompileHook=material.onBeforeCompile;
    material.pstudioTSLPortApprovedCacheKey=material.customProgramCacheKey;
    return material;
  }
  function createMirrorWaterState(material){
    const T=window.THREE;
    const options={format:T.RGBAFormat,type:T.UnsignedByteType,minFilter:T.LinearFilter,magFilter:T.LinearFilter,depthBuffer:true,stencilBuffer:false};
    const target=new T.WebGLRenderTarget(1,1,options);
    target.texture.generateMipmaps=false;
    target.depthTexture=new T.DepthTexture(1,1);
    target.depthTexture.format=T.DepthFormat;
    target.depthTexture.type=T.UnsignedIntType;
    return{
      target,
      cloudTarget:null,
      reflectionCamera:camera?.clone?.()||new T.PerspectiveCamera(),
      textureMatrix:new T.Matrix4(),
      biasMatrix:new T.Matrix4().set(
        0.5,0,0,0.5,
        0,0.5,0,0.5,
        0,0,0.5,0.5,
        0,0,0,1
      ),
      plane:new T.Plane(),
      reflectivity:1.0,
      waveStrength:0.05,
      hasRendered:false,
      material
    };
  }
  function renderMirrorWaterReflections(){
    if(!renderer||!scene||!camera)return 0;
    const T=window.THREE,mirrors=[];
    scene.traverse(object=>{
      if(object?.isMesh&&object.visible&&object.userData?.pstudioMirrorWater)mirrors.push(object);
    });
    if(!mirrors.length)return 0;
    mirrorWaterFrameCounter++;
    const touch=Number(window.navigator?.maxTouchPoints||0)>0;
    const updateInterval=renderingFrameBudgetController
      ?Math.max(1,Math.floor(Number(renderingFrameBudget.mirrorIntervalFrames)||1))
      :touch?(memorySafetyApplied||adaptiveQualityLevel===0?3:2):1;
    const forceRefresh=mirrors.some(mesh=>!mesh.userData.pstudioMirrorWater.hasRendered);
    if(mirrorWaterFrameCounter%updateInterval!==0&&!forceRefresh)return mirrors.length;
    const size=renderer.getDrawingBufferSize(new T.Vector2());
    const scale=mirrorWaterResolutionScale();
    // Match the active 3D drawing buffer exactly whenever the GPU supports it.
    // This keeps sky gradients, cloud filaments, stars and sun/moon discs sharp in reflections.
    const maxEdge=Math.max(128,Number(renderer.capabilities?.maxTextureSize)||2048);
    const width=Math.max(128,Math.min(maxEdge,Math.floor(size.x*scale)));
    const height=Math.max(128,Math.min(maxEdge,Math.floor(size.y*scale)));
    const previousTarget=renderer.getRenderTarget();
    const previousClipping=renderer.clippingPlanes;
    const previousLocalClipping=renderer.localClippingEnabled;
    const previousAutoClear=renderer.autoClear;
    const previousShadowAutoUpdate=renderer.shadowMap?.autoUpdate;
    const previousXrEnabled=renderer.xr?.enabled;
    const hidden=[];
    const hide=object=>{if(object&&object.visible){hidden.push([object,object.visible]);object.visible=false;}};
    try{
      scene.traverse(object=>{
        if(object?.userData?.pstudioMirrorWater||object?.userData?.pstudioWaterSurface)hide(object);
      });
      hide(gridGroup);hide(editorHelperGroup);hide(selectionGroup);
      renderer.autoClear=true;
      if(renderer.shadowMap)renderer.shadowMap.autoUpdate=false;
      if(renderer.xr)renderer.xr.enabled=false;
      renderer.localClippingEnabled=true;
      let rendered=0;
      for(const mesh of mirrors){
        const state=mesh.userData.pstudioMirrorWater;
        if(!state)continue;
        try{
          if(state.target.width!==width||state.target.height!==height)state.target.setSize(width,height);
          if(volumetricCloudsEnabled&&volumetricCloudPass?.enabled&&typeof volumetricCloudPass.render==='function'){
            if(!state.cloudTarget)state.cloudTarget=new T.WebGLRenderTarget(width,height,{format:T.RGBAFormat,type:T.UnsignedByteType,minFilter:T.LinearFilter,magFilter:T.LinearFilter,depthBuffer:false,stencilBuffer:false});
            else if(state.cloudTarget.width!==width||state.cloudTarget.height!==height)state.cloudTarget.setSize(width,height);
          }
          mesh.updateWorldMatrix(true,false);
          const normal=new T.Vector3(0,1,0).transformDirection(mesh.matrixWorld).normalize();
          const point=mesh.getWorldPosition(new T.Vector3());
          state.plane.setFromNormalAndCoplanarPoint(normal,point);
          const sourcePosition=camera.getWorldPosition(new T.Vector3());
          if(Math.abs(state.plane.distanceToPoint(sourcePosition))<0.015)continue;
          if(state.plane.distanceToPoint(sourcePosition)<0){
            state.plane.normal.negate();
            state.plane.constant=-state.plane.constant;
          }
          const sourceDirection=camera.getWorldDirection(new T.Vector3());
          const sourceUp=camera.up.clone().applyQuaternion(camera.getWorldQuaternion(new T.Quaternion()));
          const reflectPoint=pointValue=>pointValue.clone().addScaledVector(state.plane.normal,-2*state.plane.distanceToPoint(pointValue));
          const reflectVector=vector=>vector.clone().addScaledVector(state.plane.normal,-2*state.plane.normal.dot(vector));
          const reflectedPosition=reflectPoint(sourcePosition);
          const reflectedTarget=reflectPoint(sourcePosition.clone().add(sourceDirection.multiplyScalar(100)));
          const reflectedUp=reflectVector(sourceUp).normalize();
          const reflectionCamera=state.reflectionCamera;
          reflectionCamera.position.copy(reflectedPosition);
          reflectionCamera.up.copy(reflectedUp);
          reflectionCamera.near=camera.near;reflectionCamera.far=camera.far;
          reflectionCamera.projectionMatrix.copy(camera.projectionMatrix);
          reflectionCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
          reflectionCamera.layers.mask=camera.layers.mask;
          reflectionCamera.lookAt(reflectedTarget);
          reflectionCamera.updateMatrixWorld(true);
          state.textureMatrix.copy(state.biasMatrix)
            .multiply(reflectionCamera.projectionMatrix)
            .multiply(reflectionCamera.matrixWorldInverse)
            .multiply(mesh.matrixWorld);
          const uniforms=mesh.material?.userData?.pstudioMirrorUniforms;
          if(uniforms){
            uniforms.uMirrorTextureMatrix.value.copy(state.textureMatrix);
            uniforms.uMirrorReflectivity.value=state.reflectivity;
            uniforms.uMirrorWaveStrength.value=state.waveStrength;
            uniforms.uMirrorTime.value=particleClock;
          }
          renderer.clippingPlanes=[state.plane.clone()];
          renderer.setRenderTarget(state.target);
          renderer.clear(true,true,true);
          // scene.background retains the active day/dusk/night equirectangular panorama and is
          // drawn from reflectionCamera. Camera-relative moon, sun and twinkling-star geometry
          // is translated with that camera so all three environment presets use this same path.
          const skyOffset=reflectedPosition.clone().sub(sourcePosition);
          const cameraAnchoredSky=[physicalSky,moonMesh,sunMesh,nightTwinkleStars].filter(object=>object?.position);
          const originalSkyPositions=cameraAnchoredSky.map(object=>object.position.clone());
          for(const object of cameraAnchoredSky){object.position.add(skyOffset);object.updateMatrixWorld?.(true);}
          try{renderer.render(scene,reflectionCamera);}
          finally{for(let index=0;index<cameraAnchoredSky.length;index++){cameraAnchoredSky[index].position.copy(originalSkyPositions[index]);cameraAnchoredSky[index].updateMatrixWorld?.(true);}}
          let reflectionTexture=state.target.texture;
          if(volumetricCloudsEnabled&&volumetricCloudPass?.enabled&&state.cloudTarget){
            const cloudUniforms=volumetricCloudPass.uniforms||{};
            if(cloudUniforms.uInverseProjection?.value)cloudUniforms.uInverseProjection.value.copy(reflectionCamera.projectionMatrixInverse);
            if(cloudUniforms.uCameraWorld?.value)cloudUniforms.uCameraWorld.value.copy(reflectionCamera.matrixWorld);
            if(cloudUniforms.uTime?.value!==undefined)cloudUniforms.uTime.value=particleClock;
            if(cloudUniforms.tDepth)cloudUniforms.tDepth.value=state.target.depthTexture;
            const oldRenderToScreen=volumetricCloudPass.renderToScreen;
            volumetricCloudPass.renderToScreen=false;
            try{
              volumetricCloudPass.render(renderer,state.cloudTarget,state.target,1/60,false);
              reflectionTexture=state.cloudTarget.texture;
            }finally{volumetricCloudPass.renderToScreen=oldRenderToScreen;}
          }
          if(uniforms)uniforms.uMirrorReflection.value=reflectionTexture;
          state.hasRendered=true;
          rendered++;
        }catch(error){
          console.warn('[PStudio] Mirror Water reflection update failed; retaining the last valid reflection.',error);
        }
      }
      return rendered;
    }finally{
      for(const [object,visible] of hidden)object.visible=visible;
      renderer.setRenderTarget(previousTarget);
      renderer.clippingPlanes=previousClipping;
      renderer.localClippingEnabled=previousLocalClipping;
      renderer.autoClear=previousAutoClear;
      if(renderer.shadowMap)renderer.shadowMap.autoUpdate=previousShadowAutoUpdate;
      if(renderer.xr)renderer.xr.enabled=previousXrEnabled;
    }
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
      dynamicResolutionScale=Math.max(.55,dynamicResolutionScale*.82);
      applyEffectiveRenderScale();
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

  function readEditorOverlayVisibility(){
    const defaults={grid:true,axes:false,origin:true};
    try{
      const saved=JSON.parse(window.localStorage?.getItem('pstudio-scene-overlays')||'null');
      return{grid:saved?.grid!==false,axes:saved?.axes===true,origin:saved?.origin!==false};
    }catch(_){return defaults;}
  }
  function applyEditorOverlayVisibility(){
    if(gridGroup)gridGroup.visible=editorOverlayVisibility.grid&&!window.PStudioEngine?.isRunning?.();
    if(editorAxesHelper)editorAxesHelper.visible=editorOverlayVisibility.axes;
    if(editorOriginMarker)editorOriginMarker.visible=editorOverlayVisibility.origin;
    if(editorHelperGroup)editorHelperGroup.visible=!window.PStudioEngine?.isRunning?.();
  }
  function setEditorOverlayVisibility(name,visible){
    if(!Object.prototype.hasOwnProperty.call(editorOverlayVisibility,name))return getEditorOverlayVisibility();
    editorOverlayVisibility[name]=!!visible;
    try{window.localStorage?.setItem('pstudio-scene-overlays',JSON.stringify(editorOverlayVisibility));}catch(_){}
    applyEditorOverlayVisibility();
    if(renderer&&scene&&camera)drawFrame();
    return getEditorOverlayVisibility();
  }
  function getEditorOverlayVisibility(){return{...editorOverlayVisibility};}
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
      // Preserve full editor orbit, but do not draw the ground grid from its underside.
      // Otherwise its perspective lines cut across the sky and resemble rendering corruption.
      const belowGridPlane=camera.position.y<=grid.position.y+0.05;
      grid.visible=!belowGridPlane;
      if(belowGridPlane)continue;
      const divisions=gridDivisionsForDistance(baseDivisions,distance);
      if(divisions!==(Number(grid.userData?.pstudioGridDivisions)||baseDivisions)){
        const next=new T.GridHelper(baseSize,divisions,0x718093,0x3b4856);
        next.position.copy(grid.position);
        next.userData={...grid.userData,pstudioGridDivisions:divisions};
        gridGroup.remove(grid);disposeGrid(grid);gridGroup.add(next);gridCache.set(key,next);grid=next;
      }
      const farScale=Math.max(1,Math.min(3,distance/240));
      grid.scale.setScalar(farScale);
      const opacity=distance>900?.10:distance>520?.13:distance>280?.16:distance>140?.19:.22;
      for(const material of gridMaterials(grid)){
        material.transparent=true;
        material.opacity=opacity;
        material.depthWrite=false;
        material.toneMapped=false;
      }
    }
  }
  function pushMetricSample(list,value){
    const sample=Number(value);
    if(!Number.isFinite(sample)||sample<0)return;
    list.push(sample);if(list.length>RENDER_METRIC_HISTORY)list.shift();
  }
  function metricMean(list){return list.length?list.reduce((sum,value)=>sum+value,0)/list.length:null;}
  function metricPercentile(list,p){
    if(!list.length)return null;const sorted=list.slice().sort((a,b)=>a-b);
    return sorted[Math.max(0,Math.min(sorted.length-1,Math.ceil((p/100)*sorted.length)-1))];
  }
  function captureFrameRenderStats(){
    const info=renderer?.info,render=info?.render||{},memory=info?.memory||{};
    lastFrameRenderStats={
      calls:Number(render.calls)||0,triangles:Number(render.triangles)||0,points:Number(render.points)||0,
      geometries:Number(memory.geometries)||0,textures:Number(memory.textures)||0
    };
    return lastFrameRenderStats;
  }
  function performanceStatsSnapshot(){
    const memory=memorySnapshot(),render=lastFrameRenderStats;
    const now=window.performance?.now?.()??Date.now();
    const gpuFresh=!!gpuTimerGl&&lastGpuRenderDurationMs>0&&now-lastGpuTimerTimestamp<1500;
    const meanInterval=metricMean(frameIntervalSamples);
    return{
      fps:meanInterval&&meanInterval>0?Number((1000/meanInterval).toFixed(1)):null,
      frameIntervalMs:lastFrameIntervalMs?Number(lastFrameIntervalMs.toFixed(2)):null,
      frameP95Ms:metricPercentile(frameIntervalSamples,95),
      cpuRenderSubmitMs:Number(lastRenderDurationMs.toFixed(2)),
      cpuRenderP95Ms:metricPercentile(cpuRenderSamples,95),
      gpuRenderMs:gpuFresh?Number(lastGpuRenderDurationMs.toFixed(2)):null,
      gpuRenderP95Ms:gpuFresh?metricPercentile(gpuRenderSamples,95):null,
      gpuFrameBudgetPercent:gpuFresh?Number((lastGpuRenderDurationMs/16.67*100).toFixed(1)):null,
      timingSource:gpuFresh?'gpu-timer-query':'cpu-render-submission',
      postProcessing:{available:!!composer,failed:postProcessingFailed,reason:postProcessingFailureReason||null},
      gpuTimerQuerySupported:!!gpuTimerExtension,
      drawCalls:Number(render.calls)||0,triangles:Number(render.triangles)||0,points:Number(render.points)||0,
      geometries:Number(renderer?.info?.memory?.geometries)||0,
      textures:Number(renderer?.info?.memory?.textures)||0,
      estimatedGpuBytes:memory.estimatedGpuBytes,gpuBudgetBytes:memory.gpuBudgetBytes,
      gpuPressure:memory.gpuPressure,jsHeapUsedBytes:memory.usedJSHeapBytes,
      jsHeapLimitBytes:memory.jsHeapLimitBytes,
      quality:resolveQualityPreset(qualityPreset),adaptiveEnabled:adaptiveQualityEnabled,
      adaptiveLevel:adaptiveQualityLevel,mobilePostFxBudget:adaptiveTouchPostFxBudget,
      renderEffects:{ao:qualityAOEnabled,ssr:ssrEnabled,volumetricClouds:volumetricCloudsEnabled,volumetricFog:volumetricFogEnabled,contactShadows:contactShadowsEnabled},
      dynamicResolutionScale:Number(dynamicResolutionScale.toFixed(3)),dynamicResolutionSource:dynamicResolutionMetricSource,
      frameBudget:{source:renderingFrameBudget.source,scale:Number(renderingFrameBudget.scale.toFixed(3)),mirrorIntervalFrames:renderingFrameBudget.mirrorIntervalFrames,mirrorResolutionScale:Number(renderingFrameBudget.mirrorResolutionScale.toFixed(3)),giCaptureAllowed:renderingFrameBudget.giCaptureAllowed,giCadenceMultiplier:renderingFrameBudget.giCadenceMultiplier,cloudStepScale:Number(renderingFrameBudget.cloudStepScale.toFixed(3)),fogStepScale:Number(renderingFrameBudget.fogStepScale.toFixed(3)),contactShadowStepScale:Number(renderingFrameBudget.contactShadowStepScale.toFixed(3))},
      renderPixelRatio:renderer?.getPixelRatio?.()||null,memorySafety:memorySafetyApplied,
      dynamicGI:{enabled:dynamicGIEnabled,status:dynamicGIStatus,validProbes:dynamicProbeCache.filter(item=>item.valid).length,totalProbes:dynamicProbeCache.length,updates:dynamicProbeUpdates,captureResolution:qualityPreset==='ultra'?192:qualityPreset==='maximum'?128:qualityPreset==='high'?96:64,nextCaptureIntervalMs:dynamicProbeCaptureIntervalMs(gpuFresh?lastGpuRenderDurationMs:lastRenderDurationMs,gpuFresh)},
      note:'FPS is based on renderer redraw intervals. GPU memory is a resource-registry estimate, not a complete hardware VRAM measurement. GPU frame-budget percentage is GPU render time divided by 16.67 ms, not total GPU utilization.'
    };
  }
  function formatMetricBytes(bytes){
    const value=Number(bytes);if(!Number.isFinite(value)||value<0)return '—';
    const units=['B','KB','MB','GB'];let amount=value,index=0;
    while(amount>=1024&&index<units.length-1){amount/=1024;index++;}
    return amount.toFixed(index===0?0:1)+' '+units[index];
  }
  function updatePerformanceMonitor(now=window.performance?.now?.()??Date.now(),force=false){
    if(!performanceMonitorEnabled||(!force&&now-lastPerformanceEmitAt<500))return;
    lastPerformanceEmitAt=now;
    const stats=performanceStatsSnapshot(),panel=document.getElementById('render-stats-overlay');
    const gpu=stats.gpuRenderMs===null?'unavailable':stats.gpuRenderMs.toFixed(2)+' ms';
    const gpuBudget=stats.gpuFrameBudgetPercent===null?'—':stats.gpuFrameBudgetPercent.toFixed(0)+'% of 16.67 ms';
    const heap=stats.jsHeapUsedBytes===null?'unavailable':formatMetricBytes(stats.jsHeapUsedBytes);
    const gpuMemory=formatMetricBytes(stats.estimatedGpuBytes)+' / '+formatMetricBytes(stats.gpuBudgetBytes);
    const rows=[
      'PSTUDIO PERFORMANCE',
      'FPS: '+(stats.fps===null?'—':stats.fps.toFixed(1))+'  |  Frame: '+(stats.frameIntervalMs===null?'—':stats.frameIntervalMs.toFixed(2)+' ms'),
      'Frame P95: '+(stats.frameP95Ms===null?'—':stats.frameP95Ms.toFixed(2)+' ms'),
      'CPU render submit: '+stats.cpuRenderSubmitMs.toFixed(2)+' ms',
      'GPU render: '+gpu+'  ('+gpuBudget+')',
      'Draw calls: '+stats.drawCalls+'  |  Triangles: '+stats.triangles.toLocaleString(),
      'Geometry: '+stats.geometries+'  |  Textures: '+stats.textures,
      'GPU estimate: '+gpuMemory+'  |  JS heap: '+heap,
      'Quality: '+stats.quality.toUpperCase()+'  |  Scale: '+Math.round(stats.dynamicResolutionScale*100)+'%  |  DPR: '+(stats.renderPixelRatio===null?'—':stats.renderPixelRatio.toFixed(2)),
      'Dynamic resolution source: '+stats.dynamicResolutionSource,
      'Shared frame budget: '+stats.frameBudget.scale+'  |  Mirror: '+stats.frameBudget.mirrorIntervalFrames+'f  |  GI: '+(stats.frameBudget.giCaptureAllowed?'allowed':'paused'),
      'Dynamic GI: '+(stats.dynamicGI.enabled?'ON':'OFF')+' / '+stats.dynamicGI.status+' ('+stats.dynamicGI.validProbes+'/'+stats.dynamicGI.totalProbes+')',
      'Timing: '+stats.timingSource+(stats.memorySafety?'  |  MEMORY SAFETY':''),
      'Post FX: '+(stats.postProcessing.failed?'direct-render fallback':'composer available'),
      'FPS is based on renderer redraw intervals; GPU % is a frame-budget ratio.'
    ];
    if(panel)panel.textContent=rows.join(String.fromCharCode(10));
    try{window.dispatchEvent(new CustomEvent('pstudio-render-stats',{detail:stats}));}catch(_){}
  }
  function togglePerformanceMonitor(){
    performanceMonitorEnabled=!performanceMonitorEnabled;
    const panel=document.getElementById('render-stats-overlay'),button=document.getElementById('render-stats-toggle');
    if(panel)panel.hidden=!performanceMonitorEnabled;
    if(button){button.setAttribute('aria-pressed',String(performanceMonitorEnabled));button.classList.toggle('active',performanceMonitorEnabled);}
    if(performanceMonitorEnabled)updatePerformanceMonitor(window.performance?.now?.()??Date.now(),true);
    return performanceMonitorEnabled;
  }
  function ensureNightTwinkleStars(T){
    if(nightTwinkleStars?.parent===scene)return nightTwinkleStars;
    if(!scene)return null;
    const count=56,geometry=new T.BufferGeometry();
    const positions=new Float32Array(count*3),phases=new Float32Array(count),intensities=new Float32Array(count),speeds=new Float32Array(count);
    let seed=0x4e494748;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for(let i=0;i<count;i++){
      const y=.16+random()*.82,angle=random()*Math.PI*2,radius=Math.sqrt(Math.max(0,1-y*y));
      positions[i*3]=Math.cos(angle)*radius;positions[i*3+1]=y;positions[i*3+2]=Math.sin(angle)*radius;
      phases[i]=random()*Math.PI*2;intensities[i]=.42+random()*.58;speeds[i]=.55+random()*.8;
    }
    geometry.setAttribute('position',new T.BufferAttribute(positions,3));
    geometry.setAttribute('aPhase',new T.BufferAttribute(phases,1));
    geometry.setAttribute('aIntensity',new T.BufferAttribute(intensities,1));
    geometry.setAttribute('aSpeed',new T.BufferAttribute(speeds,1));
    const material=new T.ShaderMaterial({
      uniforms:{
        uTime:{value:0},uPointScale:{value:Math.min(1.5,Math.max(1,window.devicePixelRatio||1))},
        uMoonDirectionWorld:{value:new T.Vector3(0,1,0)},uMoonOcclusion:{value:0}
      },
      vertexShader:[
        'attribute float aPhase;','attribute float aIntensity;','attribute float aSpeed;',
        'uniform float uTime;','uniform float uPointScale;','varying float vTwinkle;','varying float vIntensity;','varying vec3 vSkyDirection;',
        'void main(){',
        'float pulse=.58+.42*(.5+.5*sin(uTime*aSpeed+aPhase));',
        'vTwinkle=pulse;vIntensity=aIntensity;vSkyDirection=normalize(position);',
        'vec4 mvPosition=modelViewMatrix*vec4(position,1.0);',
        'gl_Position=projectionMatrix*mvPosition;',
        'gl_PointSize=(2.0+aIntensity*2.8)*uPointScale;',
        '}'
      ].join('\n'),
      fragmentShader:[
        'uniform vec3 uMoonDirectionWorld;','uniform float uMoonOcclusion;',
        'varying float vTwinkle;','varying float vIntensity;','varying vec3 vSkyDirection;',
        'void main(){',
        'vec2 p=gl_PointCoord-vec2(.5);float r=length(p);',
        'float core=exp(-r*r*190.0);',
        'float rays=max(exp(-abs(p.x)*72.0)*exp(-abs(p.y)*8.0),exp(-abs(p.y)*72.0)*exp(-abs(p.x)*8.0));',
        'float hexRay=pow(max(0.0,cos(atan(p.y,p.x)*6.0)),24.0)*smoothstep(.48,.02,r);',
        'float alignment=dot(normalize(vSkyDirection),normalize(uMoonDirectionWorld));',
        'float moonHalo=smoothstep(0.89,0.999,alignment);',
        'float moonDim=1.0-uMoonOcclusion*moonHalo*.58;',
        'float alpha=(core*.92+rays*.16+hexRay*.12)*vTwinkle*vIntensity*moonDim;',
        'if(alpha<.012)discard;',
        'gl_FragColor=vec4(vec3(.72,.83,1.0)*alpha,alpha);',
        '}'
      ].join('\n'),
      transparent:true,depthTest:true,depthWrite:false,blending:T.AdditiveBlending,toneMapped:false
    });
    nightTwinkleStars=new T.Points(geometry,material);
    nightTwinkleStars.name='PStudioNightTwinkleStars';
    nightTwinkleStars.frustumCulled=false;
    nightTwinkleStars.renderOrder=2;
    scene.add(nightTwinkleStars);
    return nightTwinkleStars;
  }
  function updateNightTwinkleStars(){
    if(!nightTwinkleStars||!camera)return;
    const visible=activeEnvironmentPreset==='night'&&!(hdrTexture&&hdrShowBackground);
    nightTwinkleStars.visible=visible;
    if(!visible)return;
    nightTwinkleStars.position.copy(camera.position);
    const distance=Math.max(camera.near+2,camera.far*.96);
    nightTwinkleStars.scale.setScalar(distance);
    if(nightTwinkleStars.material?.uniforms?.uTime)nightTwinkleStars.material.uniforms.uTime.value=(window.performance?.now?.()??Date.now())*.001;
    if(nightTwinkleStars.material?.uniforms?.uMoonDirectionWorld&&moonDirection)nightTwinkleStars.material.uniforms.uMoonDirectionWorld.value.copy(moonDirection);
    if(nightTwinkleStars.material?.uniforms?.uMoonOcclusion)nightTwinkleStars.material.uniforms.uMoonOcclusion.value=moonMesh?.visible?1:0;
  }
  function updateRenderingFrameBudget(){
    if(!renderingFrameBudgetController||!renderer||!camera)return renderingFrameBudget;
    const T=window.THREE,now=window.performance?.now?.()??Date.now();
    if(!frameBudgetCurrentPosition){
      frameBudgetCurrentPosition=new T.Vector3();frameBudgetPreviousPosition=new T.Vector3();
      frameBudgetCurrentDirection=new T.Vector3();frameBudgetPreviousDirection=new T.Vector3();
    }
    camera.getWorldPosition(frameBudgetCurrentPosition);
    camera.getWorldDirection(frameBudgetCurrentDirection);
    const cameraMoving=!frameBudgetCameraValid||
      frameBudgetCurrentPosition.distanceToSquared(frameBudgetPreviousPosition)>0.0004||
      frameBudgetCurrentDirection.dot(frameBudgetPreviousDirection)<0.9997;
    frameBudgetPreviousPosition.copy(frameBudgetCurrentPosition);
    frameBudgetPreviousDirection.copy(frameBudgetCurrentDirection);
    frameBudgetCameraValid=true;
    const gpuFresh=!!gpuTimerGl&&lastGpuRenderDurationMs>0&&now-lastGpuTimerTimestamp<1500;
    const frameFresh=lastFrameIntervalSampleAt>0&&now-lastFrameIntervalSampleAt<250;
    const touch=Number(window.navigator?.maxTouchPoints||0)>0;
    const dynamicScene=dynamicLights.size>0||dynamicGIEnabled||
      volumetricCloudsEnabled||activeEnvironmentPreset==='night'||!!window.PStudioEngine?.isRunning?.()||particleEmitters.size>0||trailEffects.size>0;
    const revision=renderingFrameBudget.revision;
    renderingFrameBudgetController.update(
      gpuFresh?lastGpuRenderDurationMs:0,
      gpuFresh,
      frameFresh?lastFrameIntervalMs:0,
      touch?20:16.67,
      lastMemoryPressure,
      cameraMoving,
      dynamicScene,
      true,
      dynamicGIEnabled
    );
    window.PStudioEnvironmentFX?.setFrameBudget?.(renderingFrameBudget);
    if(renderingFrameBudget.revision!==revision&&renderingFrameBudget.revision!==lastFrameBudgetEventRevision){
      lastFrameBudgetEventRevision=renderingFrameBudget.revision;
      try{window.PStudioEvents?.emit('render.frame-budget.changed',{
        source:renderingFrameBudget.source,scale:Number(renderingFrameBudget.scale.toFixed(3)),
        mirrorIntervalFrames:renderingFrameBudget.mirrorIntervalFrames,
        mirrorResolutionScale:Number(renderingFrameBudget.mirrorResolutionScale.toFixed(3)),
        giCaptureAllowed:renderingFrameBudget.giCaptureAllowed,
        giCadenceMultiplier:renderingFrameBudget.giCadenceMultiplier
      });}catch(_){}
    }
    return renderingFrameBudget;
  }

  function drawFrame(){
    if(!renderer||!scene||!camera)return;
    // Keep the last valid WebGL frame on screen while legacy PBR materials are
    // converted and the WebGPU pipeline is compiled; never render mixed material backends.
    if(productionWebGPUCompileStage==='converting-materials'||productionWebGPUCompileStage==='compiling')return;
    if(productionRendererFallbackRequested&&productionRendererBridge?.getState?.().backend==='webgpu')return;
    const cameraPositionBefore=camera.position.clone(),cameraQuaternionBefore=camera.quaternion.clone();
    applyCameraShake();camera.updateMatrixWorld(true);
    const frameStarted=window.performance?.now?.()??Date.now();
    if(lastDrawFrameStartedAt){
      const interval=frameStarted-lastDrawFrameStartedAt;
      if(interval>0&&interval<2000){lastFrameIntervalMs=interval;lastFrameIntervalSampleAt=frameStarted;pushMetricSample(frameIntervalSamples,interval);}
    }
    lastDrawFrameStartedAt=frameStarted;
    // Update the camera's world matrix before positioning camera-relative celestial meshes.
    camera.updateMatrixWorld(true);
    if(physicalSky?.visible){physicalSky.position.copy(camera.position);physicalSky.updateMatrixWorld(true);}
    updateMoonSkyMesh();
    updateSunSkyMesh();
    if(activeEnvironmentPreset==='night')ensureNightTwinkleStars(window.THREE);
    updateNightTwinkleStars();
    applyEditorOverlayVisibility();
    updateEditorGridPresentation();
    updateClusteredLighting();
    updateRenderingFrameBudget();
    if(productionRendererBridge?.getState?.().backend==='webgpu'){
      const liveBlockers=getProductionWebGPUFeatureBlockers();
      if(liveBlockers.length){
        fallbackFromWebGPUForUnsupportedFeatures();
        return;
      }
      const started=window.performance?.now?.()??Date.now();
      try{
        const clusterSnapshot=getPStudioClusteredLightingSnapshot();
        if(clusterSnapshot)productionRendererBridge.setClusteredLightingSnapshot?.(clusterSnapshot);
        if(godRaysEnabled)productionRendererBridge.setGodRays?.(getPStudioGodRaysSettings());
        productionRendererBridge.setContactShadows?.(contactShadowsEnabled?getPStudioContactShadowSettings():false);
        productionRendererBridge.setVolumetricFog?.(volumetricFogEnabled?getPStudioVolumetricFogSettings():false);
        productionRendererBridge.setVolumetricClouds?.(volumetricCloudsEnabled?getPStudioVolumetricCloudSettings():false);
        if(!productionRendererBridge.render())throw new Error('The WebGPU scene session did not submit a frame.');
      }catch(error){
        productionRendererFallbackRequested=true;
        productionRendererBridge.useFallback(error).catch(fallbackError=>{
          productionRendererFallbackRequested=false;
          console.error('[PStudio] WebGPU frame failure and WebGL2 recovery both failed.',error,fallbackError);
        });
      }finally{
        lastRenderDurationMs=Math.max(0,(window.performance?.now?.()??Date.now())-started);
        pushMetricSample(cpuRenderSamples,lastRenderDurationMs);
        updatePerformanceMonitor(window.performance?.now?.()??Date.now());
      }
      return;
    }
    renderer.info?.reset?.();pollGpuTimerQueries();
    const started=window.performance?.now?.()??Date.now(),gpuQuery=beginGpuTimerQuery();
    const hiddenStaticSky=[];
    try{
      renderWaterDepthPrepass();
      renderMirrorWaterReflections();
      if(volumetricCloudsEnabled)hiddenStaticSky.push(...hideStaticSkyForVolumetrics());
      const solarBloomActive=(qualityPreset==='high'||qualityPreset==='maximum'||qualityPreset==='ultra')&&sunGlareStrength>0.01;
      const lunarBloomActive=(qualityPreset==='high'||qualityPreset==='maximum'||qualityPreset==='ultra')&&moonGlareStrength>0.01;
      if(!postProcessingFailed&&composer&&(bloomEnabled||solarBloomActive||lunarBloomActive||ssaoEnabled||ssrEnabled||volumetricFogEnabled||volumetricCloudsEnabled||contactShadowsEnabled||godRaysEnabled||godRaysFallbackEnabled||!!taaPass?.enabled||!!smaaPass?.enabled)){
        if(bloomPass){const celestialGlare=Math.max(sunGlareStrength,moonGlareStrength*.72);bloomPass.enabled=bloomEnabled||solarBloomActive||lunarBloomActive||godRaysFallbackEnabled;bloomPass.strength=Math.max(bloomEnabled?bloomStrength:0.08,celestialGlare*.72,godRaysFallbackEnabled?0.14+0.18*godRaysIntensity:0);bloomPass.threshold=Math.max(.62,.84-celestialGlare*.18);}
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
        if(godRaysPass){
          godRaysPass.enabled=godRaysEnabled;
          syncPostFXUniforms(godRaysPass,['uLightPosition','uIntensity'],u=>{
            camera.updateMatrixWorld(true);
            const Three=window.THREE;const sunDirection=keyLight?.position?.clone?.()||new Three.Vector3(5,9,6);
            if(sunDirection.lengthSq()<1e-8)sunDirection.set(5,9,6);else sunDirection.normalize();
            const sunWorld=camera.position.clone().addScaledVector(sunDirection,1000);
            const sunScreen=sunWorld.project(camera);
            u.uLightPosition.value.set(sunScreen.x*0.5+0.5,sunScreen.y*0.5+0.5);
            u.uIntensity.value=godRaysIntensity;
          });
        }
        try{composer.render();}catch(initialPostError){
          let postError=initialPostError,recovered=false;
          if(godRaysEnabled&&godRaysPass?.enabled){
            godRaysEnabled=false;godRaysPass.enabled=false;
            godRaysFallbackEnabled=!!bloomPass;
            if(bloomPass){bloomPass.enabled=bloomEnabled||solarBloomActive||lunarBloomActive||godRaysFallbackEnabled;bloomPass.strength=Math.max(bloomEnabled?bloomStrength:0.08,Math.max(sunGlareStrength,moonGlareStrength*.72)*.72,godRaysFallbackEnabled?0.14+0.18*godRaysIntensity:0);}
            try{composer.render();recovered=true;}
            catch(retryError){postError=retryError;}
            if(recovered)console.warn('[PStudio] God Rays shader is unsupported; switching to bloom fallback.',initialPostError);
          }
          if(!recovered){
            postProcessingFailed=true;
            postProcessingFailureReason=String(postError?.message||postError||'Unknown post-processing error').slice(0,240);
            try{
              renderer.setRenderTarget(null);
              renderer.render(scene,camera);
              console.warn('[PStudio] Post-processing failed; direct scene rendering is active until quality settings are reapplied.',postError);
            }catch(fallbackError){
              console.error('[PStudio] Post-processing and direct scene rendering both failed.',postError,fallbackError);
              throw fallbackError;
            }
          }
        }
      }else{
        if(ssaoPass)ssaoPass.enabled=false;
        if(ssrPass)ssrPass.enabled=false;if(contactShadowPass)contactShadowPass.enabled=false;
        renderer.render(scene,camera);
      }
    }finally{
      camera.position.copy(cameraPositionBefore);camera.quaternion.copy(cameraQuaternionBefore);camera.updateMatrixWorld(true);
      restoreStaticSky(hiddenStaticSky);
      lastRenderDurationMs=Math.max(0,(window.performance?.now?.()??Date.now())-started);
      pushMetricSample(cpuRenderSamples,lastRenderDurationMs);
      captureFrameRenderStats();
      // Close the main-scene timer before the off-screen CubeCamera GI capture.
      endGpuTimerQuery(gpuQuery);
      const now=window.performance?.now?.()??Date.now();
      sampleMemoryPressure();
      const hasRecentGpuSample=!!gpuTimerGl&&lastGpuRenderDurationMs>0&&now-lastGpuTimerTimestamp<1500;
      adaptiveMetricSource=hasRecentGpuSample?'gpu-timer-query':'cpu-render-submission';
      applyAdaptiveQuality();
      updatePerformanceMonitor(now);
      // Probe captures remain visible in frame pacing, but must not contaminate render-submit/GPU timings or per-frame render counters.
      void serviceDynamicRadianceCache(now).catch(error=>{dynamicGIStatus='error';console.warn('[PStudio] Dynamic GI capture failed safely:',error);});
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
  const MAX_TRAIL_POINTS=48;
  const MAX_TRAIL_EFFECTS=64;
  function disposeTrailEffect(trail){
    if(!trail)return;
    if(trail.mesh?.parent)trail.mesh.parent.remove(trail.mesh);
    trail.geometry?.dispose?.();
    trail.material?.dispose?.();
  }
  function updateTrailGeometry(trail){
    const T=window.THREE,points=trail.points;
    if(!T||!trail.geometry||points.length<2){trail.geometry?.setDrawRange?.(0,0);return;}
    const positions=trail.geometry.attributes.position;
    const births=trail.geometry.attributes.aBirth;
    const worldUp=new T.Vector3(0,1,0),fallbackAxis=new T.Vector3(1,0,0);
    for(let i=0;i<points.length;i++){
      const previous=points[Math.max(0,i-1)].position;
      const following=points[Math.min(points.length-1,i+1)].position;
      const tangent=following.clone().sub(previous);
      if(tangent.lengthSq()<1e-10)tangent.set(0,0,1);
      else tangent.normalize();
      const view=camera?camera.position.clone().sub(points[i].position).normalize():worldUp.clone();
      let side=tangent.clone().cross(view);
      if(side.lengthSq()<1e-8)side=tangent.clone().cross(worldUp);
      if(side.lengthSq()<1e-8)side=tangent.clone().cross(fallbackAxis);
      side.normalize().multiplyScalar(trail.width*0.5);
      const center=points[i].position;
      const left=center.clone().add(side),right=center.clone().sub(side);
      positions.setXYZ(i*2,left.x,left.y,left.z);
      positions.setXYZ(i*2+1,right.x,right.y,right.z);
      births.setX(i*2,points[i].time);
      births.setX(i*2+1,points[i].time);
    }
    positions.needsUpdate=true;births.needsUpdate=true;
    trail.geometry.setDrawRange(0,(points.length-1)*6);
  }
  function updateTrailEffect(key,command){
    const T=window.THREE;
    if(!T||!scene)return;
    const duration=Math.max(0.05,Math.min(10,Number(command.duration)||0.25));
    const width=Math.max(0.001,Math.min(1,Number(command.width)||0.05));
    let trail=trailEffects.get(key);
    if(!trail){
      if(trailEffects.size>=MAX_TRAIL_EFFECTS){
        const oldestKey=trailEffects.keys().next().value;
        const oldest=trailEffects.get(oldestKey);
        disposeTrailEffect(oldest);trailEffects.delete(oldestKey);
      }
      const geometry=new T.BufferGeometry();
      const position=new T.BufferAttribute(new Float32Array(MAX_TRAIL_POINTS*2*3),3);
      const birth=new T.BufferAttribute(new Float32Array(MAX_TRAIL_POINTS*2),1);
      position.setUsage?.(T.DynamicDrawUsage);birth.setUsage?.(T.DynamicDrawUsage);
      geometry.setAttribute('position',position);geometry.setAttribute('aBirth',birth);
      const indices=[];
      for(let i=0;i<MAX_TRAIL_POINTS-1;i++){const a=i*2,b=a+1,c=a+2,d=a+3;indices.push(a,b,c,b,d,c);}
      geometry.setIndex(indices);
      const material=new T.ShaderMaterial({
        uniforms:{uColor:{value:new T.Color('#ffffff')},uTime:{value:particleClock},uDuration:{value:duration}},
        vertexShader:'attribute float aBirth;varying float vBirth;void main(){vBirth=aBirth;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader:'uniform vec3 uColor;uniform float uTime;uniform float uDuration;varying float vBirth;void main(){float age=max(0.0,uTime-vBirth);float alpha=clamp(1.0-age/max(0.001,uDuration),0.0,1.0);if(alpha<=0.002)discard;gl_FragColor=vec4(uColor,alpha*0.86);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>}',
        transparent:true,depthWrite:false,depthTest:true,side:T.DoubleSide,blending:T.AdditiveBlending,toneMapped:true
      });
      const mesh=new T.Mesh(geometry,material);mesh.frustumCulled=false;mesh.renderOrder=5;scene.add(mesh);
      trail={geometry,material,mesh,points:[],width,duration,lastCalledAt:particleClock,lastSampleAt:-Infinity};
      trailEffects.set(key,trail);
    }
    trail.width=width;trail.duration=duration;trail.lastCalledAt=particleClock;
    trail.material.uniforms.uDuration.value=duration;
    try{trail.material.uniforms.uColor.value.set(String(command.color||'#ffffff'));}catch(_){trail.material.uniforms.uColor.value.set('#ffffff');}
    const position=new T.Vector3(Number(command.x)||0,Number(command.y)||0,Number(command.z)||0);
    const last=trail.points[trail.points.length-1];
    if(!last||last.position.distanceToSquared(position)>0.000025||particleClock-trail.lastSampleAt>=0.025){
      trail.points.push({position,time:particleClock});trail.lastSampleAt=particleClock;
      if(trail.points.length>MAX_TRAIL_POINTS)trail.points.shift();
      updateTrailGeometry(trail);
    }
  }
  function updateTrailEffects(){
    for(const [key,trail] of trailEffects){
      if(particleClock-trail.lastCalledAt>trail.duration){
        disposeTrailEffect(trail);trailEffects.delete(key);continue;
      }
      const time=trail.material?.uniforms?.uTime;
      if(time&&Object.prototype.hasOwnProperty.call(time,'value'))time.value=particleClock;
    }
  }
  function triggerCameraShake(intensity,duration){
    const strength=Math.max(0,Math.min(2,Number(intensity)||0));
    const seconds=Math.max(0,Math.min(8,Number(duration)||0));
    if(!strength||!seconds){cameraShakeState=null;return false;}
    const now=window.performance?.now?.()??Date.now();
    cameraShakeState={startedAt:now,intensity:strength,duration:seconds};
    if(renderer&&scene&&camera)drawFrame();
    return true;
  }
  function applyCameraShake(){
    if(!cameraShakeState||!camera||!window.THREE)return;
    const now=window.performance?.now?.()??Date.now();
    const elapsed=Math.max(0,(now-cameraShakeState.startedAt)/1000);
    const progress=elapsed/cameraShakeState.duration;
    if(progress>=1){cameraShakeState=null;return;}
    const envelope=(1-progress)*(1-progress),amplitude=0.12*cameraShakeState.intensity*envelope;
    const right=new window.THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
    const up=new window.THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion);
    const t=elapsed;
    camera.position.addScaledVector(right,(Math.sin(t*59.3)+0.38*Math.sin(t*91.7+1.4))*amplitude*0.5);
    camera.position.addScaledVector(up,(Math.cos(t*67.1+0.6)+0.32*Math.sin(t*107.3))*amplitude*0.38);
    camera.rotateX(Math.sin(t*43.7)*0.0035*cameraShakeState.intensity*envelope);
    camera.rotateY(Math.cos(t*51.9)*0.003*cameraShakeState.intensity*envelope);
    camera.updateMatrixWorld(true);
  }
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

  function getSHProbeCaptureContext(T=window.THREE){
    const activeBackend=productionRendererBridge?.getState?.().backend||'webgl2';
    if(activeBackend==='webgpu'){
      const captureRenderer=productionRendererBridge?.getRenderer?.();
      if(!captureRenderer||captureRenderer.backend?.isWebGPUBackend!==true){
        throw new Error('The active WebGPU renderer is unavailable for SH probe capture; no WebGL renderer substitution is permitted.');
      }
      if(typeof T?.CubeRenderTarget!=='function')throw new Error('Three.js CubeRenderTarget is unavailable for WebGPU SH capture.');
      return Object.freeze({renderer:captureRenderer,Target:T.CubeRenderTarget,backend:'webgpu'});
    }
    if(!renderer||typeof T?.WebGLCubeRenderTarget!=='function')throw new Error('The WebGL2 SH capture renderer is unavailable.');
    return Object.freeze({renderer,Target:T.WebGLCubeRenderTarget,backend:'webgl2'});
  }

  function suppressProbeLightingForCapture(){
    const snapshots=[],seen=new Set();
    scene?.traverse(object=>{
      if(!object?.isMesh)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){
        if(!material||seen.has(material))continue;
        seen.add(material);
        const legacy=Array.isArray(material.userData?.pstudioProbeUniforms)?material.userData.pstudioProbeUniforms:null;
        const tsl=Array.isArray(material.userData?.pstudioTSLProbeUniforms)?material.userData.pstudioTSLProbeUniforms:null;
        const legacyValues=legacy?.map(uniform=>uniform.clone())||null;
        const tslValues=tsl?.map(uniform=>uniform?.value?.clone?.()||null)||null;
        snapshots.push({legacy,legacyValues,tsl,tslValues});
        for(const uniform of legacy||[])uniform?.set?.(0,0,0);
        for(const uniform of tsl||[])uniform?.value?.set?.(0,0,0);
      }
    });
    return ()=>{
      for(const snapshot of snapshots){
        for(let i=0;i<(snapshot.legacy||[]).length;i++){
          const uniform=snapshot.legacy[i],value=snapshot.legacyValues[i];
          if(value&&uniform?.copy)uniform.copy(value);
        }
        for(let i=0;i<(snapshot.tsl||[]).length;i++){
          const uniform=snapshot.tsl[i],value=snapshot.tslValues[i];
          if(value&&uniform?.value?.copy)uniform.value.copy(value);
        }
      }
    };
  }

  async function bakeLightProbe(options={}){
    if(!ensureRenderer())throw new Error('The 3D renderer is not available.');
    if(window.PStudioEngine?.isRunning?.())throw new Error('Stop Play before baking static global illumination.');
    if(probeBakeInFlight||dynamicProbeCaptureInFlight)throw new Error('Another SH probe capture is already active.');
    const generator=window.PStudioPostFX?.LightProbeGenerator;
    if(!generator?.fromCubeRenderTarget)throw new Error('LightProbeGenerator is unavailable.');
    const T=window.THREE,{renderer:captureRenderer,Target,backend}=getSHProbeCaptureContext(T);
    const size=Math.max(32,Math.min(256,Math.floor(Number(options.resolution)||128)));
    const target=new Target(size,{format:T.RGBAFormat,type:T.HalfFloatType,generateMipmaps:true,minFilter:T.LinearMipmapLinearFilter});
    const cubeCamera=new T.CubeCamera(0.1,Math.max(50,Number(options.far)||300),target);
    cubeCamera.position.set(Number(options.x)||0,Number(options.y)||1.5,Number(options.z)||0);
    const previousSingle=bakedLightProbe,previousVolume=bakedLightProbeVolume,previousBounces=bakedGIBounces;
    const previousCaptureActive=probeCaptureActive,oldTarget=captureRenderer.getRenderTarget?.()||null;
    const oldAutoUpdate=captureRenderer.shadowMap?.autoUpdate,restoreProbeUniforms=suppressProbeLightingForCapture();
    let nextProbe=null;
    probeBakeInFlight=true;probeCaptureActive=true;
    try{
      if(previousSingle)scene.remove(previousSingle);
      if(previousVolume)for(const item of previousVolume)scene.remove(item.light);
      if(captureRenderer.shadowMap)captureRenderer.shadowMap.autoUpdate=true;
      scene.add(cubeCamera);
      cubeCamera.update(captureRenderer,scene);
      scene.remove(cubeCamera);
      nextProbe=await generator.fromCubeRenderTarget(captureRenderer,target);
      if(!nextProbe?.sh?.coefficients||nextProbe.sh.coefficients.length<9){
        throw new Error('The asynchronous SH probe capture returned invalid coefficients.');
      }
      nextProbe.intensity=Math.max(0,Math.min(3,Number.isFinite(Number(options.intensity))?Number(options.intensity):1));
      scene.add(nextProbe);
      bakedLightProbe=nextProbe;bakedLightProbeVolume=null;bakedGIBounces=0;
      updateProbeVolumeBlend();
      for(const item of previousVolume||[])item.light.dispose?.();
      previousSingle?.dispose?.();
      captureRenderer.setRenderTarget?.(oldTarget);
      drawFrame();
      return{baked:true,resolution:size,backend,kind:'global-diffuse-light-probe',note:'単一のグローバル照明プローブです。面ごとのライトマップではありません。'};
    }catch(error){
      if(nextProbe){scene.remove(nextProbe);nextProbe.dispose?.();}
      bakedLightProbe=previousSingle;bakedLightProbeVolume=previousVolume;bakedGIBounces=previousBounces;
      if(previousSingle)scene.add(previousSingle);
      for(const item of previousVolume||[])scene.add(item.light);
      updateProbeVolumeBlend();
      throw error;
    }finally{
      scene.remove(cubeCamera);target.dispose();restoreProbeUniforms();
      if(captureRenderer.shadowMap)captureRenderer.shadowMap.autoUpdate=oldAutoUpdate;
      captureRenderer.setRenderTarget?.(oldTarget);
      probeCaptureActive=previousCaptureActive;probeBakeInFlight=false;
    }
  }


  function purgeWorldChunkRuntime(chunkId){
    const owners=new Set([...objectChunkAssignments].filter(([,id])=>id===chunkId).map(([owner])=>owner));
    for(const [key,mesh] of [...meshCache])if(owners.has(String(mesh.userData.ownerId))){disposeMesh(mesh);meshCache.delete(key);}
    for(const [key,instance] of [...modelInstances])if(owners.has(String(instance.ownerId)))removeModelInstance(key);
  }
  function releaseStaleChunkAssets(chunk,requestedAssets){
    // If a newer generation is already active/loading, retain names it currently uses;
    // release only resources that belonged exclusively to the obsolete request.
    const retained=(chunk.active||chunk.loading)?new Set(chunk.assets||[]):new Set();
    const stale=(requestedAssets||[]).filter(name=>!retained.has(name));
    if(stale.length)releaseChunkAssetCache(chunk,stale);
  }
  function beginWorldChunkLoad(chunk){
    if(chunk.loading||chunk.active)return;
    const token=++chunk.generation;
    const requestedAssets=chunk.assets.slice();
    chunk.loading=true;
    chunk.error=null;
    Promise.all(requestedAssets.map(name=>requestModelAsset(name))).then(async()=>{
      if(token!==chunk.generation){releaseStaleChunkAssets(chunk,requestedAssets);return;}
      if(typeof chunk.onLoad==='function')await chunk.onLoad({id:chunk.id,assets:requestedAssets.slice()});
      if(token!==chunk.generation){releaseStaleChunkAssets(chunk,requestedAssets);return;}
      chunk.loading=false;
      chunk.active=true;
      chunk.lastLoadedAt=Date.now();
      try{
        window.PStudioEvents?.emit('world.chunk.loaded',{id:chunk.id,assetCount:requestedAssets.length});
        window.PStudioEvents?.emit('world.chunk.resumed',{id:chunk.id});
      }catch(_){}
    }).catch(error=>{
      if(token!==chunk.generation){releaseStaleChunkAssets(chunk,requestedAssets);return;}
      chunk.loading=false;
      chunk.active=false;
      chunk.error=String(error?.message||error);
      releaseChunkAssetCache(chunk,requestedAssets);
      try{window.PStudioEvents?.emit('world.chunk.loadFailed',{id:chunk.id,error:chunk.error});}catch(_){}
    });
  }
  function releaseChunkAssetCache(chunk,assetNames=chunk.assets){
    const protectedAssets=new Set();
    for(const other of worldChunks.values())if(other.id!==chunk.id&&(other.active||other.loading))for(const name of other.assets||[])protectedAssets.add(name);
    for(const name of assetNames||[]){
      if(protectedAssets.has(name))continue;
      let removed=false;
      try{removed=window.PStudioResources?.remove?.('model-gpu',name,{reason:'chunk-unloaded'})||false;}catch(_){continue;}
      if(!removed&&!([...modelInstances.values()].some(instance=>instance.name===name))){
        const asset=modelCache.get(name);if(asset){disposeModelAsset(asset);modelCache.delete(name);}
      }
    }
  }
  function endWorldChunkLoad(chunk,preserveAssets=null){
    chunk.generation++;chunk.loading=false;chunk.active=false;try{window.PStudioEvents?.emit('world.chunk.suspended',{id:chunk.id,reason:'distance'});}catch(_){}purgeWorldChunkRuntime(chunk.id);releaseChunkAssetCache(chunk,preserveAssets?chunk.assets.filter(name=>!preserveAssets.has(name)):chunk.assets);
    try{const result=chunk.onUnload?.({id:chunk.id,assets:chunk.assets.slice()});if(result?.catch)result.catch(error=>console.warn('[PStudio] Chunk unload callback failed:',error));}catch(error){console.warn('[PStudio] Chunk unload callback failed:',error);}
    window.PStudioResources?.trim?.('gpu');try{window.PStudioEvents?.emit('world.chunk.unloaded',{id:chunk.id});}catch(_){}
  }
  function registerWorldChunk(id,o={}){
    const key=String(id||'').trim();
    if(!key||key.length>128)throw new TypeError('Invalid world chunk id.');
    const coordinate=v=>Number.isFinite(Number(v))?Number(v):0;
    const loadDistance=Math.max(1,Math.min(200000,Number(o.loadDistance)||800));
    const unloadDistance=Math.max(loadDistance,Math.min(200000,Number(o.unloadDistance)||loadDistance*1.2));
    const assets=Array.isArray(o.assets)?[...new Set(o.assets.map(value=>String(value||'').trim()).filter(Boolean))]:[];
    const old=worldChunks.get(key);
    const assetsChanged=!!old&&(old.assets.length!==assets.length||old.assets.some(value=>!assets.includes(value)));
    // Keep the registry record stable so in-flight promises retain the same object.
    // Asset-set changes invalidate the old generation before the new configuration is assigned.
    if(old&&assetsChanged&&(old.active||old.loading)){const retainedAssets=new Set(old.assets.filter(name=>assets.includes(name)));endWorldChunkLoad(old,retainedAssets);}
    const chunk=old||{id:key,active:o.active===true,loading:false,generation:0,error:null,lastLoadedAt:0,onLoad:null,onUnload:null};
    chunk.x=coordinate(o.x);chunk.y=coordinate(o.y);chunk.z=coordinate(o.z);
    chunk.loadDistance=loadDistance;chunk.unloadDistance=unloadDistance;
    chunk.assets=assets;
    if(typeof o.onLoad==='function')chunk.onLoad=o.onLoad;
    if(typeof o.onUnload==='function')chunk.onUnload=o.onUnload;
    if(assetsChanged)chunk.error=null;
    worldChunks.set(key,chunk);
    return{id:key,loadDistance,unloadDistance,active:chunk.active,loading:chunk.loading,assetCount:chunk.assets.length,generation:chunk.generation};
  }
  function assignObjectToChunk(ownerId,chunkId){
    const owner=String(ownerId||''),id=String(chunkId||'');
    if(!owner)throw new TypeError('World chunk owner ID is required.');
    if(!worldChunks.has(id))throw new Error('World chunk is not registered: '+id);
    objectChunkAssignments.set(owner,id);
    return true;
  }
  function unassignObjectFromChunk(ownerId){
    return objectChunkAssignments.delete(String(ownerId));
  }
  function unregisterWorldChunk(id){
    const key=String(id),chunk=worldChunks.get(key);
    if(!chunk)return false;
    if(chunk.active||chunk.loading)endWorldChunkLoad(chunk);
    worldChunks.delete(key);
    for(const [owner,chunkId] of objectChunkAssignments)if(chunkId===key)objectChunkAssignments.delete(owner);
    return true;
  }
  function isOwnerChunkActive(ownerId){
    const chunk=worldChunks.get(objectChunkAssignments.get(String(ownerId)));
    return !chunk||chunk.active;
  }
  function setWorldStreamingInterests(interests){
    const source=Array.isArray(interests)?interests:[];
    worldStreamingInterests=source.slice(0,128).filter(value=>value&&[value.x,value.y,value.z].every(axis=>Number.isFinite(Number(axis)))).map(value=>({
      id:String(value.id||''),
      x:Number(value.x),y:Number(value.y),z:Number(value.z),
      loadMultiplier:Math.max(0.1,Math.min(4,Number(value.loadMultiplier)||1)),
      unloadMultiplier:Math.max(0.1,Math.min(4,Number(value.unloadMultiplier)||1)),
      priority:Math.max(-1000,Math.min(1000,Math.trunc(Number(value.priority)||0)))
    }));
    worldStreamingInterests.sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
    return worldStreamingInterests.length;
  }
  function clearWorldStreamingInterests(){worldStreamingInterests=[];return true;}
  function updateWorldChunkStates(){
    const interests=worldStreamingInterests;
    const useCameraFallback=interests.length===0&&!!camera;
    const loadCandidates=[];
    let loadingCount=0;
    for(const chunk of worldChunks.values()){
      if(chunk.loading)loadingCount++;
      let shouldStay=false,bestPriority=-Infinity,bestDistance=Infinity,bestNormalized=Infinity;
      if(interests.length){
        for(const interest of interests){
          const dx=chunk.x-interest.x,dy=chunk.y-interest.y,dz=chunk.z-interest.z;
          const distance=Math.hypot(dx,dy,dz);
          const loadRadius=chunk.loadDistance*interest.loadMultiplier;
          const unloadRadius=chunk.unloadDistance*interest.unloadMultiplier;
          if(distance<=unloadRadius)shouldStay=true;
          if(distance<loadRadius){
            const normalized=distance/Math.max(1,loadRadius);
            if(interest.priority>bestPriority||(interest.priority===bestPriority&&normalized<bestNormalized)){
              bestPriority=interest.priority;
              bestDistance=distance;
              bestNormalized=normalized;
            }
          }
        }
      }else if(useCameraFallback){
        const dx=chunk.x-camera.position.x;
        const dy=chunk.y-camera.position.y;
        const dz=chunk.z-camera.position.z;
        const distance=Math.hypot(dx,dy,dz);
        if(distance<=chunk.unloadDistance)shouldStay=true;
        if(distance<chunk.loadDistance){
          bestPriority=0;
          bestDistance=distance;
          bestNormalized=distance/Math.max(1,chunk.loadDistance);
        }
      }
      if((chunk.active||chunk.loading)&&!shouldStay)endWorldChunkLoad(chunk);
      if(!chunk.active&&!chunk.loading&&bestPriority>-Infinity){
        loadCandidates.push({chunk,priority:bestPriority,distance:bestDistance,normalized:bestNormalized});
      }
    }
    loadCandidates.sort((a,b)=>b.priority-a.priority||a.normalized-b.normalized||a.distance-b.distance||String(a.chunk.id).localeCompare(String(b.chunk.id)));
    const configuredLimit=Number(worldRenderConfig.maxConcurrentChunkLoads);
    const maxConcurrent=Math.max(1,Math.min(32,Number.isFinite(configuredLimit)?Math.floor(configuredLimit):4));
    const budget=Math.max(0,maxConcurrent-loadingCount);
    for(let index=0;index<Math.min(budget,loadCandidates.length);index++){
      const candidate=loadCandidates[index];
      beginWorldChunkLoad(candidate.chunk);
      if(candidate.chunk.loading)loadingCount++;
    }
  }
  function setWorldRenderConfig(o={}){
    if(Number.isFinite(Number(o.maxDrawDistance)))worldRenderConfig.maxDrawDistance=Math.max(50,Math.min(20000,Number(o.maxDrawDistance)));
    if(Number.isFinite(Number(o.shadowDistance))){
      worldRenderConfig.shadowDistance=Math.max(64,Math.min(4000,Number(o.shadowDistance)));
      if(csm){csm.maxFar=worldRenderConfig.shadowDistance;csm.updateFrustums?.();}
    }
    if(Array.isArray(o.lodDistances)&&o.lodDistances.length){
      const a=o.lodDistances.slice(0,8).map(Number);
      if(a.every(Number.isFinite)&&a.every((v,i)=>v>0&&(i===0||v>a[i-1])))worldRenderConfig.lodDistances=a;
    }
    if(Number.isFinite(Number(o.probeBlendCount)))worldRenderConfig.probeBlendCount=Math.max(1,Math.min(8,Math.floor(Number(o.probeBlendCount))));
    if(Number.isFinite(Number(o.maxConcurrentChunkLoads)))worldRenderConfig.maxConcurrentChunkLoads=Math.max(1,Math.min(32,Math.floor(Number(o.maxConcurrentChunkLoads))));
    return{...worldRenderConfig,lodDistances:worldRenderConfig.lodDistances.slice()};
  }
  function updateProbeVolumeBlend(){
    if(bakedLightProbeVolume&&camera)lastProbeCameraPosition=camera.position.clone();
    probeVolumeGeneration++;
    dynamicProbeSnapshots=[];dynamicProbeFadeLastPublishAt=0;
    if(bakedLightProbeVolume?.length){
      dynamicProbeCache=bakedLightProbeVolume.map(()=>({coefficients:new Float32Array(27),valid:false,updatedAt:0,smoothedAt:0}));
      dynamicProbeDirty=new Uint8Array(bakedLightProbeVolume.length);dynamicProbeDirty.fill(1);dynamicProbeCursor=0;dynamicProbeSignature='';
      if(dynamicGIEnabled)dynamicGIStatus='waiting-for-dynamic-lights';
    }else{
      dynamicProbeCache=[];dynamicProbeDirty=null;dynamicGIStatus=dynamicGIEnabled?'requires-baked-probes':'disabled';
    }
  }
  function collectDynamicLightSnapshots(){
    const T=window.THREE,snapshots=[];
    for(const [key,light] of [...dynamicLights.entries()].sort((a,b)=>String(a[0]).localeCompare(String(b[0])))){
      const p=light.getWorldPosition&&T?.Vector3?light.getWorldPosition(new T.Vector3()):light.position;
      const x=Number(p?.x),y=Number(p?.y),z=Number(p?.z);
      const q=(value,precision=2)=>Math.round((Number(value)||0)*precision)/precision;
      const position=[Number.isFinite(x)?x:0,Number.isFinite(y)?y:0,Number.isFinite(z)?z:0];
      const distance=Math.max(0,Number(light.distance)||0);
      const color=light.color?.getHexString?.()||'ffffff';
      const signature=[
        q(position[0],2),q(position[1],2),q(position[2],2),
        q(light.intensity,50),q(distance,10),color,
        light.isSpotLight?q(light.angle,100):0,
        light.isSpotLight?q(light.penumbra,100):0
      ].join(',');
      snapshots.push({key:String(key),signature,position,radius:distance});
    }
    return snapshots;
  }
  function dynamicLightCacheSignature(snapshots=collectDynamicLightSnapshots()){
    return snapshots.map(item=>String(item.key)+':'+String(item.signature)).join('|');
  }
  function resetDynamicProbeCache(signature){
    if(!bakedLightProbeVolume?.length)return false;
    dynamicProbeSignature=signature;
    if(dynamicProbeCache.length!==bakedLightProbeVolume.length){
      dynamicProbeCache=bakedLightProbeVolume.map(()=>({coefficients:new Float32Array(27),valid:false,updatedAt:0,smoothedAt:0}));
    }
    dynamicProbeDirty=new Uint8Array(bakedLightProbeVolume.length);dynamicProbeDirty.fill(1);dynamicProbeCursor=0;
    probeVolumeGeneration++;dynamicGIStatus=signature?'updating':'waiting-for-dynamic-lights';
    return true;
  }
  async function serviceDynamicRadianceCache(now){
    if(!dynamicGIEnabled||!bakedLightProbeVolume?.length||!renderer||!scene||probeBakeInFlight||dynamicProbeCaptureInFlight)return;
    if(now-lastDynamicProbeSignatureAt>=600){
      lastDynamicProbeSignatureAt=now;
      const snapshots=collectDynamicLightSnapshots(),signature=dynamicLightCacheSignature(snapshots);
      if(signature!==dynamicProbeSignature){
        const GI=window.PStudioRenderingGI;
        const initial=!dynamicProbeSnapshots.length;
        const affected=typeof GI?.findChangedProbeIndices==='function'
          ?GI.findChangedProbeIndices(bakedLightProbeVolume,dynamicProbeSnapshots,snapshots,0.75)
          :Array.from({length:bakedLightProbeVolume.length},(_,index)=>index);
        dynamicProbeSignature=signature;
        if(signature){
          if(!dynamicProbeDirty||dynamicProbeDirty.length!==bakedLightProbeVolume.length){
            dynamicProbeDirty=new Uint8Array(bakedLightProbeVolume.length);
          }
          if(initial){
            dynamicProbeDirty.fill(1);
          }else{
            for(const index of affected)if(index>=0&&index<dynamicProbeDirty.length)dynamicProbeDirty[index]=1;
          }
          dynamicGIStatus=dynamicProbeDirty.some(Boolean)?'updating':'ready';
        }else{
          dynamicGIStatus='fading-out';
        }
        dynamicProbeSnapshots=snapshots;
      }
    }
    if(!dynamicLights.size){
      const GI=window.PStudioRenderingGI;
      let anyValid=false,changed=false;
      for(const cached of dynamicProbeCache){
        if(!cached?.valid)continue;
        const elapsed=Math.max(0,now-(Number(cached.smoothedAt)||Number(cached.updatedAt)||now));
        if(elapsed>0&&typeof GI?.decaySHCoefficients==='function'){
          const result=GI.decaySHCoefficients(cached.coefficients,elapsed,320,1e-4);
          if(result.changed)changed=true;
          cached.smoothedAt=now;
          if(result.finished){
            cached.valid=false;cached.coefficients.fill(0);changed=true;
          }else anyValid=true;
        }else anyValid=true;
      }
      if(changed&&now-dynamicProbeFadeLastPublishAt>=100){
        dynamicProbeFadeLastPublishAt=now;probeVolumeGeneration++;
      }
      dynamicGIStatus=anyValid?'fading-out':'waiting-for-dynamic-lights';
      return;
    }
    if(!dynamicProbeDirty||!dynamicProbeDirty.length)return;
    if(!dynamicProbeDirty.some(Boolean)){dynamicGIStatus='ready';return;}
    const gpuFresh=!!gpuTimerGl&&lastGpuRenderDurationMs>0&&now-lastGpuTimerTimestamp<1500;
    const recentRenderMs=gpuFresh?lastGpuRenderDurationMs:lastRenderDurationMs;
    if(renderingFrameBudgetController&&!renderingFrameBudget.giCaptureAllowed)return;
    const captureInterval=dynamicProbeCaptureIntervalMs(recentRenderMs,gpuFresh)*
      (renderingFrameBudgetController?Math.max(1,Number(renderingFrameBudget.giCadenceMultiplier)||1):1);
    if(now-lastDynamicProbeUpdateAt<captureInterval)return;
    if(recentRenderMs>(gpuFresh?12:7))return;
    const generator=window.PStudioPostFX?.LightProbeGenerator,T=window.THREE;
    if(!generator?.fromCubeRenderTarget||!T?.CubeCamera){dynamicGIStatus='unavailable';return;}
    const {renderer:captureRenderer,Target}=getSHProbeCaptureContext(T);
    if(typeof Target!=='function'){dynamicGIStatus='unavailable';return;}
    const nextProbe=window.PStudioRenderingGI?.nextDirtyProbeIndex;
    let index=typeof nextProbe==='function'?nextProbe(dynamicProbeDirty,dynamicProbeCursor):-1;
    if(index<0&&!window.PStudioRenderingGI){
      for(let offset=0;offset<dynamicProbeDirty.length;offset++){
        const candidate=(dynamicProbeCursor+offset)%dynamicProbeDirty.length;
        if(dynamicProbeDirty[candidate]){index=candidate;break;}
      }
    }
    if(index<0){dynamicGIStatus='ready';return;}
    const resolveProbeResolution=window.PStudioRenderingGI?.dynamicProbeCaptureResolution;
    const resolution=typeof resolveProbeResolution==='function'?resolveProbeResolution(qualityPreset):(qualityPreset==='ultra'?192:qualityPreset==='maximum'?128:qualityPreset==='high'?96:64);
    const target=new Target(resolution,{format:T.RGBAFormat,type:T.HalfFloatType,generateMipmaps:false,minFilter:T.LinearFilter});
    const cube=new T.CubeCamera(.1,Math.max(50,worldRenderConfig.maxDrawDistance),target);
    const position=bakedLightProbeVolume[index].position,oldTarget=captureRenderer.getRenderTarget?.()||null;
    const oldEnvironment=scene.environment,oldBackground=scene.background;
    const oldClear=captureRenderer.getClearColor?.(new T.Color())?.clone?.()||null;
    const oldClearAlpha=captureRenderer.getClearAlpha?.()??1,oldAutoClear=captureRenderer.autoClear,oldShadowAuto=captureRenderer.shadowMap?.autoUpdate;
    const oldCaptureActive=probeCaptureActive,restoreProbeUniforms=suppressProbeLightingForCapture();
    const dynamicSet=new Set(dynamicLights.values()),hiddenLights=[],savedVisibility=[];
    let capturedLight=null;
    dynamicProbeCaptureInFlight=true;
    try{
      scene.traverse(object=>{
        if(object.isLight){
          if(dynamicSet.has(object)){savedVisibility.push([object,object.visible]);object.visible=true;}
          else if(object.visible){hiddenLights.push([object,object.visible]);object.visible=false;}
        }
        if(!object.isMesh)return;
      });
      probeCaptureActive=true;
      scene.environment=null;scene.background=new T.Color(0x000000);captureRenderer.setClearColor?.(0x000000,1);captureRenderer.autoClear=true;
      if(captureRenderer.shadowMap)captureRenderer.shadowMap.autoUpdate=false;
      cube.position.copy(position);scene.add(cube);cube.update(captureRenderer,scene);scene.remove(cube);
      capturedLight=await generator.fromCubeRenderTarget(captureRenderer,target);
      const coefficients=capturedLight?.sh?.coefficients;
      if(!coefficients||coefficients.length<9)throw new Error('Dynamic SH probe capture returned invalid coefficients.');
      const cached=dynamicProbeCache[index]||{coefficients:new Float32Array(27),valid:false,updatedAt:0,smoothedAt:0};
      const captured=new Float32Array(27);
      for(let i=0;i<9;i++){
        const coefficient=coefficients[i],offset=i*3;
        captured[offset]=Number(coefficient.x)||0;
        captured[offset+1]=Number(coefficient.y)||0;
        captured[offset+2]=Number(coefficient.z)||0;
      }
      const GI=window.PStudioRenderingGI;
      if(cached.valid&&typeof GI?.blendSHCoefficients==='function'){
        const elapsed=Math.max(1,now-(Number(cached.smoothedAt)||Number(cached.updatedAt)||now));
        GI.blendSHCoefficients(cached.coefficients,captured,elapsed,240);
      }else cached.coefficients.set(captured);
      cached.valid=true;cached.updatedAt=now;cached.smoothedAt=now;dynamicProbeCache[index]=cached;dynamicProbeDirty[index]=0;
      dynamicProbeCursor=(index+1)%dynamicProbeDirty.length;dynamicProbeUpdates++;probeVolumeGeneration++;
      dynamicGIStatus=dynamicProbeDirty.some(Boolean)?'updating':'ready';
      capturedLight.dispose?.();capturedLight=null;
      try{window.PStudioEvents?.emit('gi.dynamic-probe.updated',{index,total:dynamicProbeCache.length,resolution,status:dynamicGIStatus});}catch(_){}
    }catch(error){
      capturedLight?.dispose?.();
      dynamicGIStatus='error';console.warn('[PStudio] Dynamic SH probe update skipped:',error);
    }finally{
      scene.remove(cube);target.dispose();restoreProbeUniforms();
      for(const [light,visible] of hiddenLights)light.visible=visible;
      for(const [light,visible] of savedVisibility)light.visible=visible;
      scene.environment=oldEnvironment;scene.background=oldBackground;
      if(oldClear)captureRenderer.setClearColor?.(oldClear,oldClearAlpha);
      captureRenderer.autoClear=oldAutoClear;if(captureRenderer.shadowMap)captureRenderer.shadowMap.autoUpdate=oldShadowAuto;
      captureRenderer.setRenderTarget?.(oldTarget);
      probeCaptureActive=oldCaptureActive;dynamicProbeCaptureInFlight=false;lastDynamicProbeUpdateAt=now;
    }
  }
  async function bakeLightProbeVolume(o={}){
    if(!ensureRenderer())throw new Error('The 3D renderer is not available.');
    if(probeBakeInFlight||dynamicProbeCaptureInFlight)throw new Error('Another SH probe capture is already active.');
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
    const giLimit=qualityPreset==='ultra'?192:128;
    const giDefault=qualityPreset==='ultra'?192:qualityPreset==='maximum'?128:qualityPreset==='high'?96:64;
    const T=window.THREE,{renderer:captureRenderer,Target,backend}=getSHProbeCaptureContext(T);
    const size=Math.max(32,Math.min(giLimit,Math.floor(Number(o.resolution)||giDefault)));
    const previous=bakedLightProbeVolume,previousSingle=bakedLightProbe,previousBounces=bakedGIBounces;
    const maxBounces=Math.max(0,Math.min(4,Math.floor(Number(o.bounces??(qualityPreset==='ultra'?4:qualityPreset==='maximum'?3:2)))));
    const bounceStrength=Math.max(0,Math.min(0.8,Number.isFinite(Number(o.bounceStrength))?Number(o.bounceStrength):0.42));
    const intensity=Math.max(0,Math.min(3,Number.isFinite(Number(o.intensity))?Number(o.intensity):1));
    const minBounceEnergy=Math.max(0,Math.min(0.1,Number.isFinite(Number(o.minBounceEnergy))?Number(o.minBounceEnergy):0.0005));
    const allocated=new Set(),oldAuto=captureRenderer.shadowMap?.autoUpdate,oldTarget=captureRenderer.getRenderTarget?.()||null,oldEnvironment=scene.environment,oldBackground=scene.background;
    const oldCaptureActive=probeCaptureActive,restoreProbeUniforms=suppressProbeLightingForCapture();
    let directProbes=[],sourceProbes=[],finalProbes=[],completedBounces=0,lastBounceEnergy=0;
    probeBakeInFlight=true;probeCaptureActive=true;
    if(captureRenderer.shadowMap)captureRenderer.shadowMap.autoUpdate=true;
    if(previousSingle)scene.remove(previousSingle);
    for(const item of previous||[])scene.remove(item.light);
    const capture=async(position,sources,includeDirect,probeIntensity)=>{
      const target=new Target(size,{format:T.RGBAFormat,type:T.HalfFloatType,generateMipmaps:true,minFilter:T.LinearMipmapLinearFilter});
      let cube=null,capturedLight=null,retainCapturedLight=false;
      const targetBefore=captureRenderer.getRenderTarget?.()||null;
      const temporary=[],hiddenLights=[],environmentBefore=scene.environment,backgroundBefore=scene.background;
      const clearColorBefore=captureRenderer.getClearColor?.(new T.Color())?.clone?.()||null;
      const clearAlphaBefore=captureRenderer.getClearAlpha?.()??1;
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
          scene.environment=null;scene.background=new T.Color(0x000000);captureRenderer.setClearColor?.(0x000000,1);
          scene.traverse(object=>{if(object.isLight&&!object.userData?.pstudioBounceSource){hiddenLights.push([object,object.visible]);object.visible=false;}});
        }
        scene.add(cube);cube.update(captureRenderer,scene);scene.remove(cube);
        capturedLight=await generator.fromCubeRenderTarget(captureRenderer,target);
        if(!capturedLight?.sh?.coefficients||capturedLight.sh.coefficients.length<9)throw new Error('Static SH probe capture returned invalid coefficients.');
        capturedLight.position.copy(position);
        const item={position:position.clone(),light:capturedLight,baseIntensity:probeIntensity};
        allocated.add(item);retainCapturedLight=true;return item;
      }finally{
        if(cube)scene.remove(cube);target.dispose();
        if(!retainCapturedLight)capturedLight?.dispose?.();
        for(const light of temporary){scene.remove(light);delete light.userData.pstudioBounceSource;}
        for(const [light,visible] of hiddenLights)light.visible=visible;
        scene.environment=environmentBefore;scene.background=backgroundBefore;
        if(clearColorBefore)captureRenderer.setClearColor?.(clearColorBefore,clearAlphaBefore);
        captureRenderer.setRenderTarget?.(targetBefore);
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
      updateProbeVolumeBlend();captureRenderer.setRenderTarget?.(null);drawFrame();
      for(const item of previous||[])item.light.dispose?.();
      if(previousSingle)previousSingle.dispose?.();
      for(const item of [...allocated])if(!finalProbes.includes(item)){item.light.dispose?.();allocated.delete(item);}
      return{baked:true,probes:finalProbes.length,kind:'iterative-multibounce-diffuse-sh-gi',bounces:completedBounces,bounceStrength,resolution:size,lastBounceEnergy:Number(lastBounceEnergy.toFixed(6)),note:'直接光・環境光は初回のみ捕捉し、後続パスでは前段の拡散バウンスだけを材料へ戻します。SHプローブによる近似であり、動的レイトレーシングや完全な物理GIではありません。'};
    }catch(error){
      for(const item of allocated)item.light.dispose?.();
      bakedLightProbeVolume=previous;bakedLightProbe=previousSingle;bakedGIBounces=previousBounces;
      if(previousSingle)scene.add(previousSingle);
      for(const item of previous||[])scene.add(item.light);
      for(const mesh of meshCache.values())bindObjectProbeLighting(mesh);
      for(const instance of modelInstances.values())instance.root.traverse(bindObjectProbeLighting);
      updateProbeVolumeBlend();
      throw error;
    }finally{
      scene.environment=oldEnvironment;scene.background=oldBackground;
      if(captureRenderer.shadowMap)captureRenderer.shadowMap.autoUpdate=oldAuto;
      captureRenderer.setRenderTarget?.(oldTarget);
      restoreProbeUniforms();probeCaptureActive=oldCaptureActive;probeBakeInFlight=false;
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
      resolution:options.resolution??(qualityPreset==='ultra'?192:qualityPreset==='maximum'?128:96),
      bounces:options.bounces??(qualityPreset==='ultra'?4:qualityPreset==='maximum'?3:2),
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
    const previousCompile=material.onBeforeCompile,previousKeyIdentity=material.customProgramCacheKey,previousKey=previousKeyIdentity?.bind(material);
    const data=material.userData||(material.userData={});
    const approvedPrevious=data.pstudioTSLPortVersion===1
      &&data.pstudioTSLPortHasForeignHook!==true
      &&material.pstudioTSLPortApprovedCompileHook===previousCompile
      &&material.pstudioTSLPortApprovedCacheKey===previousKeyIdentity;
    const csmOnlyPrevious=data.pstudioCSMOnlyHook===true
      &&data.pstudioProbeShaderSetup!==true
      &&data.pstudioCSMHook===previousCompile
      &&!Object.prototype.hasOwnProperty.call(material,'customProgramCacheKey');
    const ownCompile=Object.prototype.hasOwnProperty.call(material,'onBeforeCompile')&&typeof previousCompile==='function';
    const ownCacheKey=Object.prototype.hasOwnProperty.call(material,'customProgramCacheKey')&&typeof previousKeyIdentity==='function';
    const foreignPrevious=data.pstudioTSLPortHasForeignHook===true
      ||(!approvedPrevious&&!csmOnlyPrevious&&(ownCompile||ownCacheKey));
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
    data.pstudioClusterLightingSetup=true;
    data.pstudioClusterLightingUniforms=uniforms;
    data.pstudioTSLPortVersion=1;
    data.pstudioTSLPortHasForeignHook=foreignPrevious;
    const features=Array.isArray(data.pstudioTSLFeatures)?data.pstudioTSLFeatures:[];
    if(!features.includes('clustered-lighting'))features.push('clustered-lighting');
    data.pstudioTSLFeatures=features;
    material.pstudioTSLPortApprovedCompileHook=material.onBeforeCompile;
    material.pstudioTSLPortApprovedCacheKey=material.customProgramCacheKey;
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
    signatureParts.push(clusteredLightingEnabled?1:0);
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
    clusteredLightingSnapshotRevision++;
    return active;
  }

  function getPStudioClusteredLightingSnapshot(){
    const resources=clusteredLightingResources;
    if(!resources||!camera)return null;
    const near=Math.max(0.001,camera.near);
    const far=Math.max(near*1.01,Math.min(camera.far||worldRenderConfig.maxDrawDistance,worldRenderConfig.maxDrawDistance*2));
    return Object.freeze({
      grid:Object.freeze({x:CLUSTER_GRID_X,y:CLUSTER_GRID_Y,z:CLUSTER_GRID_Z}),
      lightData:resources.lightData,
      clusterData:resources.clusterData,
      lightCount:resources.lightCount,
      clusteredLights:new Set(clusteredLightingEnabled?clusteredLightSet:[]),
      near,far,
      enabled:clusteredLightingEnabled===true,
      revision:clusteredLightingSnapshotRevision
    });
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
      case 'water': {const preset=resolveQualityPreset(qualityPreset),segments=preset==='ultra'?128:preset==='maximum'?96:preset==='high'?72:48;return ['water',n(d.width),n(d.depth),segments].join(':');}
      case 'mirror_water': return ['mirror_water',n(d.width),n(d.depth)].join(':');
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
      case 'water': {const q=resolveQualityPreset(qualityPreset),segments=q==='ultra'?128:q==='maximum'?96:q==='high'?72:48;const g=new T.PlaneGeometry(d.width,d.depth,segments,segments);g.rotateX(-Math.PI/2);return g;}
      case 'mirror_water': {const g=new T.PlaneGeometry(d.width,d.depth,1,1);g.rotateX(-Math.PI/2);return g;}
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
    window.PStudioEnvironmentFX?.releaseObject?.(mesh);
    mesh.userData?.pstudioMirrorWater?.target?.dispose?.();
    mesh.userData?.pstudioMirrorWater?.cloudTarget?.dispose?.();
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
      if(Number.isFinite(desc.iridescenceThicknessMinimum)||Number.isFinite(desc.iridescenceThicknessMaximum)){
        params.iridescenceThicknessMinimum=Number.isFinite(desc.iridescenceThicknessMinimum)?desc.iridescenceThicknessMinimum:100;
        params.iridescenceThicknessMaximum=Number.isFinite(desc.iridescenceThicknessMaximum)?desc.iridescenceThicknessMaximum:400;
      }else if(Array.isArray(desc.iridescenceThicknessRange)){
        // Accept packets produced by older PStudio workers, but hydrate through r187's fields.
        params.iridescenceThicknessMinimum=Number.isFinite(desc.iridescenceThicknessRange[0])?desc.iridescenceThicknessRange[0]:100;
        params.iridescenceThicknessMaximum=Number.isFinite(desc.iridescenceThicknessRange[1])?desc.iridescenceThicknessRange[1]:400;
      }
      if(Array.isArray(desc.normalScale))params.normalScale=new T.Vector2(...desc.normalScale);
      const Constructors={MeshPhysicalMaterial:T.MeshPhysicalMaterial,MeshStandardMaterial:T.MeshStandardMaterial,MeshBasicMaterial:T.MeshBasicMaterial,MeshLambertMaterial:T.MeshLambertMaterial,MeshPhongMaterial:T.MeshPhongMaterial,MeshToonMaterial:T.MeshToonMaterial,LineBasicMaterial:T.LineBasicMaterial,PointsMaterial:T.PointsMaterial};
      const Constructor=Constructors[desc.type]||T.MeshStandardMaterial;
      if(desc.type==='MeshPhysicalMaterial'&&Number.isFinite(desc.diffuseRoughness))params.diffuseRoughness=Math.max(0,Math.min(1,desc.diffuseRoughness));
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
      draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/libs/draco/');
      draco.setWorkerLimit(Math.max(1,Math.min(2,deviceMemoryGiB()<=2?1:2)));
      loader.setDRACOLoader(draco);
    }
    if(window.PStudioKTX2Loader&&renderer){
      try{
        if(!sharedKTX2Loader){
          sharedKTX2Loader=new window.PStudioKTX2Loader();
          sharedKTX2Loader.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/libs/basis/');
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
        try{geometry.computeBoundsTree({targetLeafSize:12});}
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
    if(csm&&!material.userData.pstudioCSMSetup){
      try{
        const hadCustomShaderHook=
          (Object.prototype.hasOwnProperty.call(material,'onBeforeCompile')&&typeof material.onBeforeCompile==='function')||
          (Object.prototype.hasOwnProperty.call(material,'customProgramCacheKey')&&typeof material.customProgramCacheKey==='function');
        csm.setupMaterial(material);
        material.userData.pstudioCSMSetup=true;
        material.userData.pstudioCSMOnlyHook=!hadCustomShaderHook;
        material.userData.pstudioCSMHook=material.onBeforeCompile;
      }catch(error){console.warn('[PStudio] CSM material setup failed:',error);}
    }
    // Keep native GLTF material shaders untouched until an SH probe volume is baked.
    if(!bakedLightProbeVolume?.length)return material;
    if(material.userData.pstudioProbeShaderSetup)return material;
    const oldCompile=material.onBeforeCompile,oldKey=material.customProgramCacheKey?.bind(material),probeUniforms=Array.from({length:9},()=>new window.THREE.Vector3());
    const data=material.userData||(material.userData={});
    const approvedPrevious=data.pstudioTSLPortVersion===1
      &&data.pstudioTSLPortHasForeignHook!==true
      &&material.pstudioTSLPortApprovedCompileHook===oldCompile
      &&material.pstudioTSLPortApprovedCacheKey===material.customProgramCacheKey;
    const csmOnlyPrevious=data.pstudioCSMOnlyHook===true
      &&data.pstudioCSMHook===oldCompile
      &&data.pstudioProbeShaderSetup!==true
      &&!Object.prototype.hasOwnProperty.call(material,'customProgramCacheKey');
    const foreignPrevious=!approvedPrevious&&!csmOnlyPrevious&&(
      (Object.prototype.hasOwnProperty.call(material,'onBeforeCompile')&&typeof oldCompile==='function')
      ||(Object.prototype.hasOwnProperty.call(material,'customProgramCacheKey')&&typeof material.customProgramCacheKey==='function')
    );
    material.onBeforeCompile=function(shader,rendererRef){if(typeof oldCompile==='function')oldCompile.call(this,shader,rendererRef);shader.uniforms.uPStudioSH={value:probeUniforms};
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
uniform vec3 uPStudioSH[9];
vec3 pstudioEvaluateSH(vec3 n){float x=n.x,y=n.y,z=n.z;vec3 value=uPStudioSH[0]*0.886227+uPStudioSH[1]*(1.023327*y)+uPStudioSH[2]*(1.023327*z)+uPStudioSH[3]*(1.023327*x)+uPStudioSH[4]*(0.858086*x*y)+uPStudioSH[5]*(0.858086*y*z)+uPStudioSH[6]*(0.247708*(3.0*z*z-1.0))+uPStudioSH[7]*(0.858086*x*z)+uPStudioSH[8]*(0.429043*(x*x-y*y));return max(value,vec3(0.0));}`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',`#include <lights_fragment_begin>
reflectedLight.indirectDiffuse += pstudioEvaluateSH(normalize(transpose(mat3(viewMatrix))*geometry.normal))*BRDF_Lambert(diffuseColor.rgb);`);
      material.userData.pstudioProbeUniforms=probeUniforms;};
    material.customProgramCacheKey=function(){return(oldKey?oldKey():'')+'|pstudio-object-sh-v1';};
    data.pstudioProbeShaderSetup=true;
    data.pstudioTSLPortVersion=1;
    data.pstudioTSLPortHasForeignHook=foreignPrevious;
    const features=Array.isArray(data.pstudioTSLFeatures)?data.pstudioTSLFeatures:[];
    if(!features.includes('sh-gi'))features.push('sh-gi');
    data.pstudioTSLFeatures=features;
    material.pstudioTSLPortApprovedCompileHook=material.onBeforeCompile;
    material.pstudioTSLPortApprovedCacheKey=material.customProgramCacheKey;
    return material;
  }
  function updateObjectProbeUniforms(object,material){
    const uniforms=material?.userData?.pstudioProbeUniforms;
    const tslUniforms=material?.userData?.pstudioTSLProbeUniforms;
    const volume=bakedLightProbeVolume;
    if((!Array.isArray(uniforms)||uniforms.length<9)&&(!Array.isArray(tslUniforms)||tslUniforms.length<9))return;
    if(!volume?.length||probeCaptureActive)return;
    const publishCoefficients=coefficients=>{
      for(let i=0;i<9;i++){
        const offset=i*3,x=coefficients[offset],y=coefficients[offset+1],z=coefficients[offset+2];
        if(typeof uniforms?.[i]?.set==='function')uniforms[i].set(x,y,z);
        const value=tslUniforms?.[i]?.value;
        if(typeof value?.set==='function')value.set(x,y,z);
      }
    };
    let cache=objectProbeRadianceCache.get(object);
    if(!cache){
      cache={position:new window.THREE.Vector3(),lastPosition:new window.THREE.Vector3(),coefficients:new Float32Array(27),generation:-1,valid:false};
      objectProbeRadianceCache.set(object,cache);probeRadianceCacheMisses++;
    }
    object.getWorldPosition(cache.position);
    const moved=!cache.valid||cache.generation!==probeVolumeGeneration||cache.lastPosition.distanceToSquared(cache.position)>0.0004;
    if(!moved){
      probeRadianceCacheHits++;
      publishCoefficients(cache.coefficients);
      return;
    }
    probeRadianceCacheRecomputes++;cache.coefficients.fill(0);
    const center=cache.position,grid=volume.pstudioGrid;
    const accumulate=(index,weight,coefficientIndex,totals)=>{
      const item=volume[index],coeff=item?.light?.sh?.coefficients?.[coefficientIndex];
      if(coeff&&weight>0){
        const base=weight*(Number(item.baseIntensity)||0);
        totals[0]+=coeff.x*base;totals[1]+=coeff.y*base;totals[2]+=coeff.z*base;
      }
      const dynamic=dynamicProbeCache[index];
      if(dynamic?.valid&&dynamic.coefficients&&weight>0){
        const offset=coefficientIndex*3;
        totals[0]+=dynamic.coefficients[offset]*weight;
        totals[1]+=dynamic.coefficients[offset+1]*weight;
        totals[2]+=dynamic.coefficients[offset+2]*weight;
      }
    };
    if(grid?.layout==='x-fastest'&&Array.isArray(grid.dims)&&grid.dims.length===3&&grid.min&&grid.max){
      const dims=grid.dims.map(Number),valid=dims.every(value=>Number.isInteger(value)&&value>=2&&value<=4);
      const boundsValid=['x','y','z'].every(axis=>Number.isFinite(Number(grid.min[axis]))&&Number.isFinite(Number(grid.max[axis]))&&Number(grid.max[axis])>Number(grid.min[axis]));
      if(valid&&boundsValid&&volume.length>=dims[0]*dims[1]*dims[2]){
        const axis=(value,min,max,count)=>{const n=Math.max(0,Math.min(1,(value-min)/(max-min)))*(count-1);const lo=Math.floor(n);return{lo,hi:Math.min(count-1,lo+1),t:n-lo};};
        const x=axis(center.x,Number(grid.min.x),Number(grid.max.x),dims[0]);
        const y=axis(center.y,Number(grid.min.y),Number(grid.max.y),dims[1]);
        const z=axis(center.z,Number(grid.min.z),Number(grid.max.z),dims[2]);
        const volumeIndex=(ix,iy,iz)=>(iz*dims[1]+iy)*dims[0]+ix;
        for(let i=0;i<9;i++){
          const totals=[0,0,0];
          for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
            const ix=dx?x.hi:x.lo,iy=dy?y.hi:y.lo,iz=dz?z.hi:z.lo;
            accumulate(volumeIndex(ix,iy,iz),(dx?x.t:1-x.t)*(dy?y.t:1-y.t)*(dz?z.t:1-z.t),i,totals);
          }
          const offset=i*3;
          cache.coefficients[offset]=totals[0];cache.coefficients[offset+1]=totals[1];cache.coefficients[offset+2]=totals[2];
        }
      }else{
        const near=volume.map((item,index)=>({item,index,d:item.position.distanceToSquared(center)})).sort((a,b)=>a.d-b.d).slice(0,Math.min(4,volume.length));
        let sum=0;for(const entry of near){entry.weight=1/Math.max(0.25,entry.d);sum+=entry.weight;}
        for(let i=0;i<9;i++){
          const totals=[0,0,0];for(const entry of near)accumulate(entry.index,entry.weight/Math.max(1e-8,sum),i,totals);
          const offset=i*3;cache.coefficients[offset]=totals[0];cache.coefficients[offset+1]=totals[1];cache.coefficients[offset+2]=totals[2];
        }
      }
    }else{
      // Sparse or legacy probe collections retain bounded inverse-distance interpolation.
      const near=volume.map((item,index)=>({item,index,d:item.position.distanceToSquared(center)})).sort((a,b)=>a.d-b.d).slice(0,Math.min(4,volume.length));
      let sum=0;for(const entry of near){entry.weight=1/Math.max(0.25,entry.d);sum+=entry.weight;}
      for(let i=0;i<9;i++){
        const totals=[0,0,0];for(const entry of near)accumulate(entry.index,entry.weight/Math.max(1e-8,sum),i,totals);
        const offset=i*3;cache.coefficients[offset]=totals[0];cache.coefficients[offset+1]=totals[1];cache.coefficients[offset+2]=totals[2];
      }
    }
    cache.lastPosition.copy(center);cache.generation=probeVolumeGeneration;cache.valid=true;
    publishCoefficients(cache.coefficients);
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
    const pump=async deadline=>{
      try{
        const job=autoLODQueue[0];
        if(!job)return;
        const {geometry,token,count,levels,specs,modifier}=job;
        const isCurrent=()=>geometry.userData?.pstudioLODToken===token&&!geometry.userData?.pstudioLODDisposed;
        if(!isCurrent()){
          if(geometry.userData?.pstudioLODToken===token)geometry.userData.pstudioAutoLODGenerating=false;
          job.done=true;
          autoLODQueue.shift();
          return;
        }
        if(deadline&&typeof deadline.timeRemaining==='function'&&deadline.timeRemaining()<8)return;
        const spec=specs[job.nextSpec++];
        if(spec){
          let lod=null;
          try{
            // SimplifyModifier.modify() is asynchronous since r186 because it waits
            // for MeshoptSimplifier.ready. Keep the queue serial while it resolves.
            lod=await modifier.modify(geometry,Math.max(1,Math.floor(count*(1-spec.keep))));
          }catch(error){
            console.warn('[PStudio] Automatic LOD generation skipped:',error);
            job.failed=true;
            job.nextSpec=specs.length;
          }
          if(lod){
            // The source geometry may have been replaced or disposed while meshopt ran.
            // Never attach a result generated from a stale source.
            if(!isCurrent()){
              lod.dispose?.();
              if(geometry.userData?.pstudioLODToken===token)geometry.userData.pstudioAutoLODGenerating=false;
              job.done=true;
              autoLODQueue.shift();
              return;
            }
            if(!lod.attributes?.position||lod.attributes.position.count>=count*0.94)lod.dispose?.();
            else{
              lod.computeBoundingSphere?.();
              lod.computeVertexNormals?.();
              levels.push({geometry:lod,distance:spec.distance,owned:true});
            }
          }
        }
        if(isCurrent())geometry.userData.pstudioAutoLODLevels=levels;
        if(job.nextSpec<specs.length)return;
        if(isCurrent()){
          geometry.userData.pstudioAutoLODGenerating=false;
          job.done=true;
          try{window.PStudioEvents?.emit('render.lod.generated',{trianglesBefore:geometry.index?.count/3||count/3,levels:levels.length,sharedGeometry:true});}catch(_){}
        }else{
          for(const level of levels)if(level.owned)level.geometry.dispose?.();
          job.done=true;
        }
        autoLODQueue.shift();
      }catch(error){
        const failedJob=autoLODQueue[0];
        if(failedJob){
          console.warn('[PStudio] Automatic LOD queue task failed:',error);
          failedJob.failed=true;
          failedJob.nextSpec=failedJob.specs.length;
          failedJob.done=true;
          if(failedJob.geometry.userData?.pstudioLODToken===failedJob.token)failedJob.geometry.userData.pstudioAutoLODGenerating=false;
          autoLODQueue.shift();
        }
      }finally{
        autoLODPumpScheduled=false;
        if(autoLODQueue.length)scheduleAutoLODPump();
      }
    };
    if(typeof window.requestIdleCallback==='function')window.requestIdleCallback(deadline=>{void pump(deadline);},{timeout:1000});
    else window.setTimeout(()=>{void pump(null);},250);
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
            diffuseRoughness:Number.isFinite(material.diffuseRoughness)?material.diffuseRoughness:null,
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
            diffuseRoughness:Number.isFinite(configured.diffuseRoughness)?configured.diffuseRoughness:null,
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
    const clamp01=value=>Math.max(0,Math.min(1,value));
    const smooth01=(a,b,x)=>{const t=clamp01((x-a)/(b-a));return t*t*(3-2*t);};
    const image=context.createImageData(canvas.width,canvas.height);
    const longitudeFields={
      sin5:new Float32Array(canvas.width),cos5:new Float32Array(canvas.width),
      sin9:new Float32Array(canvas.width),cos9:new Float32Array(canvas.width),
      sin13:new Float32Array(canvas.width),cos13:new Float32Array(canvas.width),
      sin43:new Float32Array(canvas.width),cos43:new Float32Array(canvas.width),
      sin11:new Float32Array(canvas.width),cos11:new Float32Array(canvas.width)
    };
    for(let x=0;x<canvas.width;x++){
      const longitude=x/canvas.width*Math.PI*2;
      longitudeFields.sin5[x]=Math.sin(longitude*5);longitudeFields.cos5[x]=Math.cos(longitude*5);
      longitudeFields.sin9[x]=Math.sin(longitude*9);longitudeFields.cos9[x]=Math.cos(longitude*9);
      longitudeFields.sin13[x]=Math.sin(longitude*13);longitudeFields.cos13[x]=Math.cos(longitude*13);
      longitudeFields.sin43[x]=Math.sin(longitude*43);longitudeFields.cos43[x]=Math.cos(longitude*43);
      longitudeFields.sin11[x]=Math.sin(longitude*11);longitudeFields.cos11[x]=Math.cos(longitude*11);
    }
    const latitudeFields=[];
    for(let y=0;y<canvas.height;y++){
      const latitude=(y/(canvas.height-1)-.5)*Math.PI;
      const latitudeWarp=Math.sin(latitude*3.0)*.78+Math.sin(latitude*7.0)*.17;
      const phase57=Math.sin(latitude*57.0),phase69=latitude*69.0;
      latitudeFields.push({
        warpSin:Math.sin(latitudeWarp),warpCos:Math.cos(latitudeWarp),
        lat4Sin:Math.sin(latitude*4.2),lat4Cos:Math.cos(latitude*4.2),
        lat8Sin:Math.sin(latitude*8.0),lat8Cos:Math.cos(latitude*8.0),
        phase57Sin:Math.sin(phase57),phase57Cos:Math.cos(phase57),
        lat69Sin:Math.sin(phase69),lat69Cos:Math.cos(phase69)
      });
    }
    // Precompute spherical harmonics once; the 524k-pixel loop below avoids per-pixel trigonometric calls.
    for(let y=0;y<canvas.height;y++){
      const lat=latitudeFields[y];
      for(let x=0;x<canvas.width;x++){
        const lon=longitudeFields;
        // Integer longitude harmonics keep the lunar surface seamless at the UV seam.
        const continental=((lon.sin5[x]*lat.warpCos+lon.cos5[x]*lat.warpSin)+
          (lon.cos9[x]*lat.lat4Cos+lon.sin9[x]*lat.lat4Sin)*.46+
          (lon.sin13[x]*lat.lat8Cos+lon.cos13[x]*lat.lat8Sin)*.21)/1.67;
        const mare=smooth01(-.30,.48,-continental);
        const shiftedSin43=lon.sin43[x]*lat.phase57Cos+lon.cos43[x]*lat.phase57Sin;
        const latitudeCos69MinusLon11=lat.lat69Cos*lon.cos11[x]+lat.lat69Sin*lon.sin11[x];
        const medium=shiftedSin43*latitudeCos69MinusLon11;
        const micro=random()-.5;
        const tone=clamp01((190-mare*61+continental*8+medium*5+micro*9)/255)*255;
        const i=(y*canvas.width+x)*4;
        image.data[i]=tone*.91;
        image.data[i+1]=tone*.96;
        image.data[i+2]=Math.min(255,tone*1.035+2);
        image.data[i+3]=255;
      }
    }
    context.putImageData(image,0,0);

    // Broad basalt maria have soft, irregular boundaries and a darker, less reflective albedo.
    context.save();context.globalCompositeOperation='multiply';
    for(let i=0;i<22;i++){
      const x=random()*canvas.width,y=30+random()*(canvas.height-60);
      const rx=18+Math.pow(random(),1.4)*78,ry=rx*(.42+random()*.46);
      const rotation=(random()-.5)*.7;
      const basin=context.createRadialGradient(x-rx*.12,y-ry*.12,rx*.08,x,y,rx);
      basin.addColorStop(0,'rgba(42,53,69,0.26)');
      basin.addColorStop(.52,'rgba(57,69,87,0.22)');
      basin.addColorStop(.82,'rgba(91,105,128,0.12)');
      basin.addColorStop(1,'rgba(120,139,166,0)');
      context.fillStyle=basin;context.beginPath();
      context.ellipse(x,y,rx,ry,rotation,0,Math.PI*2);context.fill();
    }
    context.restore();

    // Crater bowls, raised rims and offset shadows give the single texture real relief cues.
    for(let i=0;i<280;i++){
      const x=random()*canvas.width,y=24+random()*(canvas.height-48);
      const radius=2.2+Math.pow(random(),2.1)*27;
      const stretch=.62+random()*.58,rotation=(random()-.5)*.7;
      context.save();context.translate(x,y);context.rotate(rotation);context.scale(1,stretch);
      const shadow=context.createRadialGradient(-radius*.23,-radius*.24,radius*.06,0,0,radius);
      shadow.addColorStop(0,'rgba(22,31,45,0.28)');
      shadow.addColorStop(.43,'rgba(48,59,77,0.18)');
      shadow.addColorStop(.72,'rgba(64,77,97,0.12)');
      shadow.addColorStop(.86,'rgba(205,218,239,0.22)');
      shadow.addColorStop(.94,'rgba(230,237,249,0.18)');
      shadow.addColorStop(1,'rgba(90,108,137,0)');
      context.fillStyle=shadow;context.beginPath();context.arc(0,0,radius,0,Math.PI*2);context.fill();
      context.strokeStyle='rgba(224,233,249,'+(0.055+random()*.075).toFixed(3)+')';
      context.lineWidth=Math.max(.45,radius*.045);
      context.beginPath();context.arc(-radius*.035,-radius*.025,radius*.82,Math.PI*1.03,Math.PI*1.93);context.stroke();
      context.fillStyle='rgba(17,25,39,'+(0.06+random()*.08).toFixed(3)+')';
      context.beginPath();context.ellipse(radius*.08,radius*.12,radius*.23,radius*.16,.25,0,Math.PI*2);context.fill();
      context.restore();
    }

    // A few ancient basins carry delicate ejecta rays, kept low-contrast like lunar albedo.
    context.save();context.globalCompositeOperation='screen';context.lineCap='round';
    for(let i=0;i<9;i++){
      const x=random()*canvas.width,y=38+random()*(canvas.height-76),radius=13+random()*15;
      context.strokeStyle='rgba(211,224,245,'+(0.045+random()*.035).toFixed(3)+')';
      context.lineWidth=.45+random()*.5;
      for(let ray=0;ray<7;ray++){
        const angle=ray*Math.PI*2/7+(random()-.5)*.18,length=radius*(1.8+random()*2.6);
        context.beginPath();context.moveTo(x+Math.cos(angle)*radius*.35,y+Math.sin(angle)*radius*.35);
        context.lineTo(x+Math.cos(angle)*length,y+Math.sin(angle)*length);context.stroke();
      }
    }
    context.restore();

    context.save();
    for(let i=0;i<900;i++){
      const x=random()*canvas.width,y=18+random()*(canvas.height-36),radius=.45+random()*2.8;
      context.fillStyle='rgba(48,65,91,'+(0.025+random()*.055).toFixed(3)+')';
      context.beginPath();context.arc(x,y,radius,0,Math.PI*2);context.fill();
    }
    context.restore();
    const texture=new T.CanvasTexture(canvas);
    texture.colorSpace=T.SRGBColorSpace;
    texture.wrapS=T.RepeatWrapping;texture.wrapT=T.ClampToEdgeWrapping;
    texture.generateMipmaps=true;
    texture.minFilter=T.LinearMipmapLinearFilter;
    texture.magFilter=T.LinearFilter;
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
      const geometry=new T.SphereGeometry(1,64,48);
      const material=new T.ShaderMaterial({
        uniforms:{
          uMoonMap:{value:moonSurfaceTexture},
          uMoonTint:{value:new T.Color('#C7DCFF')},
          uLightDirectionWorld:{value:new T.Vector3(0,-1,0)},
          uMoonIntensity:{value:1},
          uMoonGlare:{value:0},
          uEarthshineStrength:{value:1.0}
        },
        vertexShader:`varying vec2 vMoonUv;
varying vec3 vMoonNormalWorld;
varying vec3 vMoonWorldPosition;
void main(){
  vMoonUv=uv;
  vMoonNormalWorld=normalize(mat3(modelMatrix)*normal);
  vec4 worldPosition=modelMatrix*vec4(position,1.0);
  vMoonWorldPosition=worldPosition.xyz;
  gl_Position=projectionMatrix*viewMatrix*worldPosition;
}`,
        fragmentShader:`uniform sampler2D uMoonMap;
uniform vec3 uMoonTint;
uniform vec3 uLightDirectionWorld;
uniform float uMoonIntensity;
uniform float uMoonGlare;
uniform float uEarthshineStrength;
varying vec2 vMoonUv;
varying vec3 vMoonNormalWorld;
varying vec3 vMoonWorldPosition;
void main(){
  vec3 normal=normalize(vMoonNormalWorld);
  vec3 lightDirection=normalize(uLightDirectionWorld);
  vec3 viewDirection=normalize(cameraPosition-vMoonWorldPosition);
  float facing=clamp(dot(normal,viewDirection),0.0,1.0);
  float ndl=dot(normal,lightDirection);
  float direct=clamp(ndl,0.0,1.0);
  float terminator=smoothstep(-0.16,0.17,ndl);
  vec3 lunar=texture2D(uMoonMap,vMoonUv).rgb;
  // Slightly warm key light keeps the sunlit regolith from reading as a featureless white sphere.
  vec3 lunarKey=mix(uMoonTint,vec3(1.0,0.925,0.80),0.22);
  vec3 directColor=lunar*vec3(0.86,0.94,1.02)*lunarKey*(0.13+direct*1.28);
  // Earthshine is deliberately deep blue and low energy: it lifts the night side without flattening the terminator.
  vec3 earthshine=vec3(0.012,0.022,0.047)+uMoonTint*0.012;
  earthshine*=uEarthshineStrength*(0.62+0.38*(1.0-facing));
  vec3 color=mix(earthshine,directColor,terminator);
  float terminatorRelief=exp(-pow(ndl/0.115,2.0));
  color+=vec3(0.12,0.16,0.24)*terminatorRelief*0.045;
  // Limb darkening and a narrow cool rim preserve the sphere silhouette without a cut-out edge.
  float limb=pow(1.0-facing,2.7);
  color*=1.0-limb*0.22;
  color+=uMoonTint*limb*(0.028+direct*0.055);
  vec3 champagne=vec3(1.0,0.88,0.69);
  color+=mix(champagne,uMoonTint,0.28)*uMoonGlare*pow(1.0-facing,1.65)*0.115;
  color*=uMoonIntensity;
  gl_FragColor=vec4(color,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
        depthTest:true,depthWrite:true,transparent:false,fog:false
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
    if(mesh.material.uniforms.uMoonTint)mesh.material.uniforms.uMoonTint.value.set(profile.moonColor||'#C7DCFF');
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
    const radius=distance*Math.tan(3.0*Math.PI/180);
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

  function drawDaytimeCloudField(context,width,height,profile,sun){
    const selected=resolveQualityPreset(qualityPreset);
    const resolutions={mobile:[768,384],balanced:[1024,512],high:[1536,768],maximum:[1792,896],ultra:[2048,1024]};
    const dimensions=resolutions[selected]||resolutions.balanced;
    const cloudCanvas=document.createElement('canvas');
    cloudCanvas.width=dimensions[0];cloudCanvas.height=dimensions[1];
    const cloudContext=cloudCanvas.getContext('2d');
    if(!cloudContext)return false;
    const fieldWidth=cloudCanvas.width,fieldHeight=cloudCanvas.height;
    let seed=0x51f15e5d;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const makeNoiseGrid=(gridWidth,gridHeight)=>{
      const values=new Float32Array(gridWidth*gridHeight);
      for(let i=0;i<values.length;i++)values[i]=random();
      return{width:gridWidth,height:gridHeight,values};
    };
    const grids=[makeNoiseGrid(32,16),makeNoiseGrid(64,32),makeNoiseGrid(128,64),makeNoiseGrid(256,128),makeNoiseGrid(512,256)];
    const sampleNoise=(grid,u,v)=>{
      const gx=((u%1)+1)%1*grid.width,gy=Math.max(0,Math.min(1,v))*(grid.height-1);
      const x0=Math.floor(gx)%grid.width,x1=(x0+1)%grid.width;
      const y0=Math.floor(gy),y1=Math.min(grid.height-1,y0+1);
      const fx=gx-Math.floor(gx),fy=gy-y0;
      const sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
      const a=grid.values[y0*grid.width+x0],b=grid.values[y0*grid.width+x1];
      const c=grid.values[y1*grid.width+x0],d=grid.values[y1*grid.width+x1];
      const top=a+(b-a)*sx,bottom=c+(d-c)*sx;
      return top+(bottom-top)*sy;
    };
    const smooth=(a,b,value)=>{const t=Math.max(0,Math.min(1,(value-a)/Math.max(1e-6,b-a)));return t*t*(3-2*t);};
    const clamp01=value=>Math.max(0,Math.min(1,value));
    const coverage=clamp01(Number(profile.cloudCoverage)||.56);
    const detail=clamp01(Number(profile.cloudDetail)||.94);
    const threshold=.58-coverage*.13;
    const sunU=Math.max(0,Math.min(1,(Number(sun?.x)||0)/Math.max(1,width)));
    const image=cloudContext.createImageData(fieldWidth,fieldHeight),pixels=image.data;
    for(let y=0;y<fieldHeight;y++){
      const v=y/Math.max(1,fieldHeight-1);
      const cloudBand=smooth(.125,.215,v)*(1-smooth(.432,.492,v));
      if(cloudBand<=.002)continue;
      for(let x=0;x<fieldWidth;x++){
        const u=x/fieldWidth;
        const broad=sampleNoise(grids[0],u,v);
        const medium=sampleNoise(grids[1],u,v);
        const fine=sampleNoise(grids[2],u,v);
        const micro=sampleNoise(grids[3],u,v);
        const nano=sampleNoise(grids[4],u,v);
        const warp=sampleNoise(grids[1],u+.217,v*.94+.071);
        const field=broad*.34+medium*.27+fine*.20+micro*.12+nano*.07+(warp-.5)*.13;
        const erosion=(1-fine)*detail*.04+(1-micro)*detail*.045+(1-nano)*detail*.055;
        const density=smooth(threshold-.045,threshold+.11,field-erosion);
        const cloudShape=Math.pow(density,.72);
        const alpha=clamp01(cloudShape*cloudBand*.92);
        if(alpha<.006)continue;
        const underside=1-smooth(threshold-.02,threshold+.105,field);
        const upperSurface=smooth(threshold+.02,threshold+.13,field+nano*.045);
        const wrappedDelta=Math.abs(u-sunU);
        const solarFacing=.5+.5*Math.cos(Math.min(wrappedDelta,1-wrappedDelta)*Math.PI*2);
        const upperSky=1-smooth(.19,.445,v);
        const microLight=(nano-.5)*.055;
        const light=clamp01(.64+solarFacing*.12+upperSurface*.17+upperSky*.035-Math.min(.42,underside*.26)+microLight);
        const warmEdge=solarFacing*upperSurface;
        const offset=(y*fieldWidth+x)*4;
        pixels[offset]=Math.round(132+101*light+10*warmEdge);
        pixels[offset+1]=Math.round(154+86*light+6*warmEdge);
        pixels[offset+2]=Math.round(181+70*light-3*warmEdge);
        pixels[offset+3]=Math.round(Math.min(.94,alpha)*255);
      }
    }
    cloudContext.putImageData(image,0,0);
    context.save();
    context.globalCompositeOperation='source-over';
    context.globalAlpha=.96;
    context.imageSmoothingEnabled=true;
    context.imageSmoothingQuality='high';
    context.drawImage(cloudCanvas,0,0,width,height);
    context.restore();
    return true;
  }
  function createProceduralSkyTexture(T,profile){
    const canvas=document.createElement('canvas');
    const width=2048,height=1024;
    canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Canvas 2D context is unavailable for procedural sky generation.');
    const name=String(profile.name||'day');
    const palettes={
      day:[[0,'#1A4F86'],[.12,'#236FB0'],[.3,'#4798D0'],[.43,'#83BDDC'],[.465,'#A8CFE2'],[.485,'#BDD9E6'],[.505,'#B5D0DB'],[.525,'#A2BECC'],[.55,'#849EAD'],[.68,'#607A8A'],[1,'#405969']],
      dusk:[[0,'#171B42'],[.12,'#262349'],[.25,'#44305A'],[.35,'#76405F'],[.42,'#B95761'],[.462,'#DC7165'],[.485,'#F09A72'],[.498,'#F6B884'],[.51,'#E7A078'],[.535,'#BD756F'],[.58,'#80546B'],[.67,'#483D59'],[1,'#252133']],
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
    const drawWrappedX=(x,margin,draw)=>{
      draw(x);
      if(x<margin)draw(x+width);
      else if(x>width-margin)draw(x-width);
    };

    if(name==='night'){
      // A dark, periodic starfield with a structured Milky Way rather than a smooth painted stripe.
      // Four seeded noise octaves create clouds, filaments and dark molecular dust lanes.
      const makeNoiseGrid=(gridWidth,gridHeight)=>{
        const values=new Float32Array(gridWidth*gridHeight);
        for(let i=0;i<values.length;i++)values[i]=random();
        return{width:gridWidth,height:gridHeight,values};
      };
      const noiseGrids=[makeNoiseGrid(48,24),makeNoiseGrid(96,48),makeNoiseGrid(192,96),makeNoiseGrid(384,192),makeNoiseGrid(768,384)];
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

      // Render the nebula at native panorama resolution; a fifth high-frequency octave restores fine filament detail before mipmap generation.
      const galaxyCanvas=document.createElement('canvas');
      const galaxyWidth=width,galaxyHeight=height;
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
            const ultraFine=sampleNoise(noiseGrids[4],u,v);
            // A curved, seam-safe galactic plane with turbulent edge displacement.
            let center=.315+.115*Math.sin(angle-.72)+.035*Math.sin(angle*2+1.1);
            center+=(broad-.5)*.045+(medium-.5)*.018;
            const bandWidth=.032+.025*broad;
            const distance=Math.abs(v-center);
            const core=Math.exp(-Math.pow(distance/bandWidth,2)*1.55);
            const haze=Math.exp(-Math.pow(distance/(bandWidth*3.15),2));
            const structure=clamp01((medium*.39+fine*.31+micro*.19+ultraFine*.11-.27)*1.72);
            const knots=clamp01((fine*.48+micro*.34+ultraFine*.18-.49)*2.3);
            const dust=clamp01((fine*.42+micro*.38+ultraFine*.20-.61)*2.3)*core;
            const fiberRidges=Math.pow(clamp01(1-Math.abs(ultraFine-.5)*3.6),5.2);
            const filaments=core*(.085+structure*.68+knots*.19+fiberRidges*.16);
            const outerHaze=haze*(.025+broad*.055);
            const intensity=clamp01((filaments+outerHaze)*(1-dust*.68)*1.38);
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

      // A restrained horizon airglow gives the starfield a real atmospheric boundary.
      // It is a smooth, low-frequency band, not a full-screen fog pass.
      const horizonAirglow=context.createLinearGradient(0,height*.405,0,height*.585);
      horizonAirglow.addColorStop(0,'rgba(9,18,38,0)');
      horizonAirglow.addColorStop(.36,'rgba(54,78,119,0.018)');
      horizonAirglow.addColorStop(.52,'rgba(105,139,184,0.072)');
      horizonAirglow.addColorStop(.68,'rgba(65,91,139,0.035)');
      horizonAirglow.addColorStop(1,'rgba(8,15,30,0)');
      context.save();context.globalCompositeOperation='screen';
      context.fillStyle=horizonAirglow;context.fillRect(0,height*.405,width,height*.18);
      context.restore();

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
      const moonV=moonUv.y/height;
      if(moonGlow>.001){
        // Three nested scattering lobes: warm near-limb bloom, cool blue halo and a broad atmospheric veil.
        const glowLayers=[
          {radius:height*.026,stops:[[0,'rgba(255,239,211,0.19)'],[.32,'rgba(246,230,205,0.14)'],[.68,'rgba(191,213,249,0.065)'],[1,'rgba(120,158,221,0)']]},
          {radius:height*.074,stops:[[0,'rgba(211,226,255,0.12)'],[.35,'rgba(156,190,243,0.075)'],[.72,'rgba(91,132,205,0.028)'],[1,'rgba(58,87,150,0)']]},
          {radius:height*.148,stops:[[0,'rgba(107,147,211,0.038)'],[.52,'rgba(68,104,171,0.022)'],[1,'rgba(35,57,111,0)']]}
        ];
        context.save();context.globalCompositeOperation='screen';
        // Preserve the azimuth-aligned lunar airglow that joins the moon to the scene horizon.
        const horizonRadiusX=width*.19,horizonRadiusY=height*.052;
        drawWrappedX(moonUv.x,horizonRadiusX,wrappedX=>{
          context.save();context.translate(wrappedX,height*.505);context.scale(1,horizonRadiusY/horizonRadiusX);
          const lunarHorizon=context.createRadialGradient(0,0,0,0,0,horizonRadiusX);
          lunarHorizon.addColorStop(0,'rgba(137,174,229,'+(0.052*moonGlow)+')');
          lunarHorizon.addColorStop(.38,'rgba(91,132,197,'+(0.028*moonGlow)+')');
          lunarHorizon.addColorStop(1,'rgba(35,61,108,0)');
          context.fillStyle=lunarHorizon;context.fillRect(-horizonRadiusX,-horizonRadiusX,horizonRadiusX*2,horizonRadiusX*2);
          context.restore();
        });
        context.globalAlpha=Math.min(1,moonGlow);
        for(const layer of glowLayers){
          drawWrappedX(moonUv.x,layer.radius,wrappedX=>{
            const gradient=context.createRadialGradient(wrappedX,moonUv.y,1,wrappedX,moonUv.y,layer.radius);
            for(const [stop,color] of layer.stops)gradient.addColorStop(stop,color);
            context.fillStyle=gradient;
            context.fillRect(wrappedX-layer.radius,moonUv.y-layer.radius,layer.radius*2,layer.radius*2);
          });
        }
        // Moonlight catches a few very thin, high cirrus wisps in the same static panorama.
        context.lineCap='round';context.lineJoin='round';
        for(let i=0;i<34;i++){
          const x=moonUv.x+(random()-.5)*width*.105;
          const y=moonUv.y+(random()-.5)*height*.105;
          const length=width*(.006+random()*.017);
          const bend=(random()-.5)*height*.008;
          const alpha=(.018+random()*.027)*moonGlow;
          drawWrappedX(x,length+4,wrappedX=>{
            context.beginPath();context.moveTo(wrappedX,y);
            context.bezierCurveTo(wrappedX+length*.28,y+bend,wrappedX+length*.66,y-bend*.62,wrappedX+length,y+bend*.22);
            context.strokeStyle='rgba(183,207,244,'+alpha.toFixed(3)+')';
            context.lineWidth=.7+random()*1.15;
            context.shadowColor='rgba(178,204,247,0.12)';context.shadowBlur=5+random()*8;
            context.stroke();
          });
        }
        context.restore();
      }

      // Fine stars dominate; only a tiny fraction are bright enough to bloom or sparkle.
      // Density and brightness rise gently inside the galactic band.
      const starBrightness=Math.max(.75,Math.min(1.8,Number(profile.starBrightness)||1));
      for(let i=0;i<12000;i++){
        const x=random()*width,y=8+random()*height*.485,u=x/width,v=y/height;
        const angle=u*Math.PI*2;
        const galacticCenterY=.315+.115*Math.sin(angle-.72)+.035*Math.sin(angle*2+1.1);
        const band=Math.exp(-Math.pow((v-galacticCenterY)/.092,2));
        const roll=random();
        const radius=roll>.996?2.8+random()*1.4:roll>.94?1.05+random()*.8:.27+Math.pow(random(),2)*.86;
        const moonDxRaw=Math.abs(x-moonUv.x),moonDx=Math.min(moonDxRaw,width-moonDxRaw)*Math.max(.2,Math.cos((moonV-.5)*Math.PI));
        const moonDy=y-moonUv.y;
        const moonDistance=Math.sqrt(moonDx*moonDx+moonDy*moonDy);
        const moonStarFade=1.0-.64*Math.exp(-Math.pow(moonDistance/(height*.062),2)*1.45);
        const alpha=Math.min(.99,(.12+random()*.55+band*.2)*(radius>1.7?1.22:1)*starBrightness*moonStarFade);
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
          // Only the rare brightest stars receive a restrained six-fold diffraction flare.
          context.save();context.translate(x,y);
          context.strokeStyle='rgba('+color+','+(alpha*.34).toFixed(3)+')';
          context.lineWidth=.58;context.lineCap='round';
          context.beginPath();
          context.moveTo(-radius*3.4,0);context.lineTo(radius*3.4,0);
          context.moveTo(0,-radius*3.4);context.lineTo(0,radius*3.4);
          const diagonal=radius*2.35;
          context.moveTo(-diagonal,-diagonal*.58);context.lineTo(diagonal,diagonal*.58);
          context.moveTo(-diagonal,diagonal*.58);context.lineTo(diagonal,-diagonal*.58);
          context.stroke();
          context.strokeStyle='rgba('+color+','+(alpha*.19).toFixed(3)+')';
          context.lineWidth=.48;context.beginPath();
          context.moveTo(-radius*1.8,-radius*3.1);context.lineTo(radius*1.8,radius*3.1);
          context.moveTo(-radius*1.8,radius*3.1);context.lineTo(radius*1.8,-radius*3.1);
          context.stroke();context.restore();
        }
      }
      // A restrained second layer of very faint pinprick stars adds depth without changing
      // the established Milky Way palette or the existing main and micro-star distributions.
      for(let i=0;i<2600;i++){
        const x=random()*width,y=4+random()*height*.49;
        const tint=random();
        const color=tint>.9?'190,211,255':tint>.72?'211,225,255':tint<.07?'255,220,180':'236,241,250';
        const radius=.1+random()*.25;
        const moonDxRaw=Math.abs(x-moonUv.x),moonDx=Math.min(moonDxRaw,width-moonDxRaw)*Math.max(.2,Math.cos((moonV-.5)*Math.PI));
        const moonDy=y-moonUv.y;
        const moonMicroFade=1.0-.62*Math.exp(-(moonDx*moonDx+moonDy*moonDy)/(height*height*.0048));
        const alpha=(.045+random()*.09)*starBrightness*moonMicroFade;
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
      if(dusk){
        // Keep the sunset physically anchored to the horizon: a narrow afterglow band
        // plus a horizontally stretched, seam-safe aureole around the solar direction.
        const bandY=Math.max(height*.475,Math.min(height*.525,sun.y));
        const horizonBand=context.createLinearGradient(0,bandY-height*.035,0,bandY+height*.075);
        horizonBand.addColorStop(0,'rgba(121,56,103,0)');
        horizonBand.addColorStop(.24,'rgba(175,71,100,0.025)');
        horizonBand.addColorStop(.48,'rgba(224,101,91,0.075)');
        horizonBand.addColorStop(.62,'rgba(255,177,117,0.11)');
        horizonBand.addColorStop(.82,'rgba(194,91,105,0.045)');
        horizonBand.addColorStop(1,'rgba(77,45,83,0)');
        context.save();context.globalCompositeOperation='screen';
        context.fillStyle=horizonBand;
        context.fillRect(0,bandY-height*.035,width,height*.11);
        const glowRadiusX=width*.17,glowRadiusY=height*.045;
        for(const wrapOffset of [-width,0,width]){
          context.save();
          context.translate(sun.x+wrapOffset,bandY);
          context.scale(1,glowRadiusY/glowRadiusX);
          const horizonLight=context.createRadialGradient(0,0,0,0,0,glowRadiusX);
          horizonLight.addColorStop(0,'rgba(255,207,157,0.22)');
          horizonLight.addColorStop(.26,'rgba(255,150,117,0.14)');
          horizonLight.addColorStop(.62,'rgba(225,104,111,0.055)');
          horizonLight.addColorStop(1,'rgba(121,56,103,0)');
          context.fillStyle=horizonLight;
          context.fillRect(-glowRadiusX,-glowRadiusX,glowRadiusX*2,glowRadiusX*2);
          context.restore();
        }
        context.restore();
      }else{
        drawWrappedX(sun.x,width*.18,wrappedX=>{
          const horizonGlow=context.createRadialGradient(wrappedX,sun.y,2,wrappedX,sun.y,height*.16);
          horizonGlow.addColorStop(0,'rgba(255,238,196,0.13)');
          horizonGlow.addColorStop(.24,'rgba(159,210,245,0.06)');
          horizonGlow.addColorStop(1,'rgba(255,255,255,0)');
          context.fillStyle=horizonGlow;context.fillRect(wrappedX-width*.16,sun.y-height*.16,width*.32,height*.32);
        });
      }

      if(name==='day'||name==='dusk'){
      // Soft, broken cloud banks and fine cirrus stop the sky from reading as a flat gradient.
      context.save();
      context.globalCompositeOperation='screen';
      for(let i=0;i<(dusk?112:30);i++){
        const x=random()*width,y=height*(dusk?.29:.18)+random()*height*(dusk?.18:.25);
        const rx=55+random()*(dusk?190:150),ry=4+random()*(dusk?17:11);
        drawWrappedX(x,rx+2,wrappedX=>{
          context.save();context.translate(wrappedX,y);context.rotate((random()-.5)*.18);context.scale(1,ry/rx);
          const cloud=context.createRadialGradient(0,0,2,0,0,rx);
          if(dusk){
            cloud.addColorStop(0,'rgba(255,178,148,0.20)');
            cloud.addColorStop(.46,'rgba(225,130,134,0.105)');
            cloud.addColorStop(1,'rgba(190,117,163,0)');
          }else{
            cloud.addColorStop(0,'rgba(246,252,255,0.095)');
            cloud.addColorStop(.5,'rgba(220,239,250,0.038)');
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
        });
      }
      if(name==='day')drawDaytimeCloudField(context,width,height,profile,sun);
      context.lineCap='round';context.lineJoin='round';
      for(let i=0;i<(dusk?112:260);i++){
        const x=random()*width,y=height*(dusk?.12:.095)+random()*height*(dusk?.34:.31),length=60+random()*(dusk?360:250);
        const yEnd=y+(random()-.5)*(dusk?8:4),yControlA=y+(random()-.5)*(dusk?9:4),yControlB=y+(random()-.5)*(dusk?15:7);
        const strokeWidth=dusk?1+random()*7:.35+random()*1.15,strokeAlpha=dusk?.12+random()*.22:.055+random()*.11,shadowBlur=dusk?7+random()*18:.45+random()*1.4;
        drawWrappedX(x,length+4,wrappedX=>{
          context.beginPath();context.moveTo(wrappedX,y);
          context.bezierCurveTo(wrappedX+length*.24,yControlA,wrappedX+length*.68,yControlB,wrappedX+length,yEnd);
          context.lineWidth=strokeWidth;
          context.strokeStyle=dusk?'rgba(255,184,151,0.35)':'rgba(239,249,255,0.24)';
          context.globalAlpha=strokeAlpha;
          context.shadowColor=dusk?'rgba(255,153,123,0.22)':'rgba(226,244,255,0.12)';
          context.shadowBlur=shadowBlur;
          context.stroke();
        });
      }
      context.restore();
      }

      const glowRadius=sunRadius*(dusk?3.2:10);
      drawWrappedX(sun.x,glowRadius,wrappedX=>{
        const halo=context.createRadialGradient(wrappedX,sun.y,1,wrappedX,sun.y,glowRadius);
        halo.addColorStop(0,dusk?'rgba(255,235,202,'+(0.22*glowStrength)+')':'rgba(255,250,226,'+(0.48*glowStrength)+')');
        halo.addColorStop(.12,dusk?'rgba(255,161,105,'+(0.14*glowStrength)+')':'rgba(255,229,178,'+(0.22*glowStrength)+')');
        halo.addColorStop(.42,dusk?'rgba(239,117,91,'+(0.065*glowStrength)+')':'rgba(174,220,249,'+(0.09*glowStrength)+')');
        halo.addColorStop(1,'rgba(255,255,255,0)');
        context.fillStyle=halo;context.fillRect(wrappedX-glowRadius,sun.y-glowRadius,glowRadius*2,glowRadius*2);
      });
      // The photosphere itself is rendered by PStudioSunSphere; this panorama retains only the atmospheric halo.
    }

    const texture=new T.CanvasTexture(canvas);
    texture.mapping=T.EquirectangularReflectionMapping;
    // Equirectangular panoramas are periodic horizontally. ClampToEdge creates a visible longitude seam.
    texture.wrapS=T.RepeatWrapping;texture.wrapT=T.ClampToEdgeWrapping;
    texture.colorSpace=T.SRGBColorSpace;
    texture.generateMipmaps=true;
    texture.minFilter=T.LinearMipmapLinearFilter;
    texture.magFilter=T.LinearFilter;
    texture.anisotropy=Math.min(16,renderer?.capabilities?.getMaxAnisotropy?.()||1);
    texture.needsUpdate=true;
    texture.userData=texture.userData||{};
    texture.userData.pstudioAtmosphere={preset:name,width,height,nightStars:name==='night'?14600:0,nightPrimaryStars:name==='night'?12000:0,proceduralCloudLayers:name==='day'||name==='dusk'};
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
    material.uniforms.pStudioSunAngularRadius={value:0.52};
    const enhancement=[
      'retColor*=pStudioAtmosphereExposure;',
      'float pStudioHorizonBand=exp(-abs(direction.y)*12.0);',
      'float pStudioTwilight=smoothstep(-0.14,0.08,vSunDirection.y)*(1.0-smoothstep(0.10,0.52,vSunDirection.y))*pStudioTwilightStrength;',
      'float pStudioSunAlignment=max(dot(normalize(direction),normalize(vSunDirection)),0.0);',
      'float pStudioSolarExponent=mix(260.0,155.0,clamp((pStudioSunAngularRadius-0.1)/0.5,0.0,1.0));',
      'float pStudioSolarHalo=pow(pStudioSunAlignment,pStudioSolarExponent*0.24);',
      'float pStudioSolarCore=pow(pStudioSunAlignment,pStudioSolarExponent);',
      'float pStudioHorizonWarmth=smoothstep(-0.16,0.025,direction.y)*(1.0-smoothstep(0.025,0.20,direction.y));',
      'vec3 pStudioWarmHorizon=mix(vec3(0.48,0.20,0.36),vec3(1.0,0.48,0.25),smoothstep(-0.10,0.16,direction.y));',
      'vec3 pStudioPeachHorizon=mix(vec3(0.72,0.28,0.38),vec3(1.0,0.72,0.43),smoothstep(-0.05,0.14,direction.y));',
      'retColor=mix(retColor,pStudioWarmHorizon,pStudioHorizonBand*pStudioTwilight*0.34);',
      'retColor=mix(retColor,pStudioPeachHorizon,pStudioHorizonWarmth*pStudioTwilight*0.16);',
      'retColor+=vec3(1.0,0.30,0.13)*pStudioSolarHalo*pStudioTwilight*0.095;',
      'retColor+=vec3(1.0,0.72,0.46)*pStudioSolarCore*pStudioTwilight*0.055;',
      'retColor+=vec3(0.36,0.53,0.82)*pow(pStudioSunAlignment,30.0)*smoothstep(0.42,0.86,vSunDirection.y)*0.018;',
      'float pStudioAtmosphereGrain=fract(sin(dot(direction.xy,vec2(127.1,311.7)))*43758.5453)-0.5;',
      'retColor+=pStudioAtmosphereGrain*0.00045;'
    ].join('\n');
    const shaderWithUniforms=source.replace(uniformMarker,uniformMarker+'\nuniform float pStudioAtmosphereExposure;\nuniform float pStudioTwilightStrength;\nuniform float pStudioSunAngularRadius;');
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
      if(uniforms.pStudioSunAngularRadius)uniforms.pStudioSunAngularRadius.value=Math.max(0.1,Math.min(4,Number(profile.sunAngularRadius)||0.52));
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
    const cloudTierActive=!memorySafetyApplied&&!adaptiveTouchPostFxBudget;
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
    const environmentState=window.PStudioRenderingEnvironment?.resolvePStudioEnvironmentState?.(profile)||{
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
    };
    window.PStudioEnvironmentFX?.configureAtmosphere?.(environmentState);
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
      toon:state.toon??null,
      modelOverrides:overrides.map(item=>[
        item.name,item.roughness??null,item.diffuseRoughness??null,item.metalness??null,item.color??null,
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
        if('diffuseRoughness' in material&&Number.isFinite(defaults.diffuseRoughness))material.diffuseRoughness=defaults.diffuseRoughness;
        material.metalness=defaults.metalness;
        if(defaults.color&&material.color)material.color.copy(defaults.color);
        if(defaults.emissive&&material.emissive)material.emissive.copy(defaults.emissive);
        if(Number.isFinite(defaults.emissiveIntensity))material.emissiveIntensity=defaults.emissiveIntensity;
        material.side=defaults.side;
        const override=overrides.find(item=>item.name===object.name||item.name===material.name)||overrides.find(item=>item.name==='*');
        const toonSettings=override?.toon||state?.toon||null;
        if(toonSettings&&toonSettings.enabled!==false){
          window.PStudioEnvironmentFX?.configureToon?.(material,toonSettings,object);
          if(Object.prototype.hasOwnProperty.call(toonSettings,'windStrength')){
            window.PStudioEnvironmentFX?.configureFoliage?.(material,object,{windStrength:toonSettings.windStrength,windSpeed:toonSettings.windSpeed});
          }
        }
        if(!override)continue;
        if(Number.isFinite(override.roughness))material.roughness=Math.max(0,Math.min(1,override.roughness));
        if('diffuseRoughness' in material&&Number.isFinite(override.diffuseRoughness))material.diffuseRoughness=Math.max(0,Math.min(1,override.diffuseRoughness));
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
      window.PStudioEnvironmentFX?.releaseObject?.(object);
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
    if(productionWebGPUCompileStage==='converting-materials'||productionWebGPUCompileStage==='compiling'){
      productionPendingCommands=commandsByObject;
      productionPendingRenderRevision++;
      return;
    }
    productionPendingCommands=null;
    productionPendingRenderRevision++;
    const T = window.THREE;
    lastCommands=commandsByObject;
    bloomEnabled=false;ssaoEnabled=qualityAOEnabled;bloomStrength=0.45;
    let frameDelta=1/60;
    for(const commandList of commandsByObject.values()){const timing=commandList.find(item=>Number.isFinite(item.dt));if(timing){const value=Number(timing.dt);frameDelta=Number.isFinite(value)?Math.max(0,Math.min(0.1,value)):1/60;break;}}
    particleClock+=frameDelta;updateTrailEffects();
    for(const material of waterMaterials){const u=material.userData?.pstudioWaterUniforms;if(u?.uPStudioTime&&Object.prototype.hasOwnProperty.call(u.uPStudioTime,'value'))u.uPStudioTime.value=particleClock;}window.PStudioEnvironmentFX?.update?.(particleClock);
    const usedMeshes=new Set(),usedGrids=new Set(),usedModels=new Set(),usedLights=new Set(),usedEmitters=new Set(),stoppedEmitters=new Set(),preservedOwners=new Set();
    const pendingFrameInstances=[];
    let cameraCommand=null,environment=null,cameraOwnerId=null;
    for (const [ownerId,list] of commandsByObject.entries()) {
      if(!isOwnerChunkActive(ownerId)){preservedOwners.add(ownerId);continue;}
      let ownerMaterial=null;
      const modelOverrides=list.filter(command=>command.type==='model_material').map(d=>({name:String(d.name),roughness:Number(d.roughness),metalness:Number(d.metalness),color:d.color?String(d.color):null,doubleSide:typeof d.doubleSide==='boolean'?d.doubleSide:undefined,recomputeNormals:typeof d.recomputeNormals==='boolean'?d.recomputeNormals:undefined,emissive:d.emissive?String(d.emissive):null,emissiveIntensity:Number.isFinite(Number(d.emissiveIntensity))?Math.max(0,Math.min(8,Number(d.emissiveIntensity))):undefined,toon:d.toon&&typeof d.toon==='object'?d.toon:null}));
      if(modelOverrides.length)ownerMaterial={modelOverrides};
      for (let commandIndex=0;commandIndex<list.length;commandIndex++) {
        const d=list[commandIndex];
        const key=String(ownerId)+':'+commandIndex;
        if (d.type==='camera') { cameraCommand=d; cameraOwnerId=d.cameraOwnerId??ownerId; continue; }
        if (d.type==='environment') { environment=Object.assign(environment||{},d); continue; }
      if(d.type==='postfx'){bloomEnabled=bloomEnabled||!!d.bloom;ssaoEnabled=ssaoEnabled||(!adaptiveTouchPostFxBudget&&!!d.ssao);const strength=Number(d.strength);if(Number.isFinite(strength))bloomStrength=Math.max(0,Math.min(2,strength));continue;}
      if(d.type==='trail'){updateTrailEffect(String(ownerId)+':'+String(d.targetId),d);continue;}
      if(d.type==='camera_shake'||d.type==='camera_fx')continue;
      if(d.type==='model_material')continue;
      if(d.type==='toon_material'){const toon=d.toon&&typeof d.toon==='object'?d.toon:{};ownerMaterial=Object.assign(ownerMaterial||{},{shader:toon.enabled===false?(ownerMaterial?.shader==='toon'?'standard':ownerMaterial?.shader||'standard'):'toon',toon});continue;}
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
            const waterOpacity=Math.max(0.05,Math.min(1,Number.isFinite(Number(d.opacity))?Number(d.opacity):1));
            material.opacity=waterOpacity;material.transparent=waterOpacity<0.999;material.depthWrite=waterOpacity>=0.999;
          }else if(d.type==='mirror_water'){
            material=configureMirrorWaterMaterial(new T.MeshPhysicalMaterial({color:'#0b3d52',roughness:0.012,metalness:0,clearcoat:1,clearcoatRoughness:0.008,ior:1.333,side:T.DoubleSide,depthWrite:true}));
          }else if(shaderMode==='custom'){
            material=new T.ShaderMaterial({uniforms:{uColor:{value:new T.Color(d.color||'#d1d5db')}},vertexShader,fragmentShader:fragmentShader||'uniform vec3 uColor; varying vec2 vUv; void main(){gl_FragColor=vec4(uColor,1.0);}',side:T.DoubleSide});
          }else if(shaderMode==='toon')material=new T.MeshStandardMaterial({color:d.color||'#d1d5db',roughness:ownerMaterial?.roughness??0.72,metalness:ownerMaterial?.metalness??0.04,side:T.DoubleSide});
          else if(shaderMode==='unlit')material=new T.MeshBasicMaterial({color:d.color||'#d1d5db',side:T.DoubleSide});
          else if(shaderMode==='normal')material=new T.MeshNormalMaterial({side:T.DoubleSide});
          else material=new T.MeshStandardMaterial({color:d.color||'#d1d5db',roughness:d.type==='terrain'?0.92:0.72,metalness:0.04,wireframe:shaderMode==='wireframe',side:d.type==='terrain'?T.DoubleSide:T.FrontSide});
          mesh=new T.Mesh(geometry,material);if(d.type==='terrain')window.PStudioEnvironmentFX?.configureTerrain?.(material,mesh);setupLightingMaterial(material);bindObjectProbeLighting(mesh);setupClusteredLightingMaterial(material);scheduleAutoLOD(mesh,geometry);
          mesh.castShadow=d.type!=='plane'&&d.type!=='water'&&d.type!=='mirror_water';
          mesh.receiveShadow=true;
          mesh.userData.signature=signature;mesh.userData.shader=shaderMode;mesh.userData.fragmentShader=fragmentShader;mesh.userData.primitiveType=d.type;
          if(d.type==='water'){
            mesh.userData.pstudioWaterSurface=true;
            geometry.computeBoundingBox?.();
            const bounds=geometry.boundingBox,waterUniforms=material.userData?.pstudioWaterHQ;
            if(bounds&&waterUniforms?.bounds)waterUniforms.bounds.value.set(bounds.min.x,bounds.min.z,Math.max(.001,bounds.max.x-bounds.min.x),Math.max(.001,bounds.max.z-bounds.min.z));
          }
          if(d.type==='mirror_water'){
            mesh.userData.pstudioWaterSurface=true;
            mesh.userData.pstudioMirrorWater=createMirrorWaterState(material);
          }
          meshCache.set(key,mesh);primitiveGroup.add(mesh);
        }
        const primitiveToon=ownerMaterial?.toon;
        if(shaderMode==='toon'||(primitiveToon&&primitiveToon.enabled!==false))window.PStudioEnvironmentFX?.configureToon?.(mesh.material,Object.assign({},primitiveToon||{},{enabled:true}),mesh);
        else if(mesh.material.userData?.pstudioToonHQ)window.PStudioEnvironmentFX?.configureToon?.(mesh.material,{enabled:false},mesh);
        if(primitiveToon&&Object.prototype.hasOwnProperty.call(primitiveToon,'windStrength'))window.PStudioEnvironmentFX?.configureFoliage?.(mesh.material,mesh,{windStrength:primitiveToon.windStrength,windSpeed:primitiveToon.windSpeed});
        if(d.color&&mesh.material.color&&mesh.material.color.getStyle()!==new T.Color(d.color).getStyle())mesh.material.color.set(d.color);
        if(mesh.material.uniforms?.uColor&&d.color)mesh.material.uniforms.uColor.value.set(d.color);
        if(d.type!=='water'&&d.type!=='mirror_water'){
          if('roughness' in mesh.material)mesh.material.roughness=ownerMaterial?ownerMaterial.roughness:(d.type==='terrain'?0.92:0.72);
          if('metalness' in mesh.material)mesh.material.metalness=ownerMaterial?ownerMaterial.metalness:0.04;
        }else if(d.type==='water')mesh.material.transmission=Math.max(0.18,Math.min(0.98,Number(d.opacity)||0.82));
        if(d.type==='mirror_water'){
          const state=mesh.userData.pstudioMirrorWater;
          if(state){
            state.reflectivity=Math.max(0,Math.min(1,Number.isFinite(Number(d.reflectivity))?Number(d.reflectivity):1.0));
            state.waveStrength=Math.max(0,Math.min(1,Number.isFinite(Number(d.waveStrength))?Number(d.waveStrength):0.05));
            const tslSettings=mesh.material?.userData?.pstudioWaterTSLSettings;
            if(tslSettings){tslSettings.reflectivity=state.reflectivity;tslSettings.waveStrength=state.waveStrength;}
          }
        }
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
    fallbackFromWebGPUForUnsupportedFeatures(commandsByObject);
    updateCamera(cameraCommand?.dt ?? 1 / 60,cameraOwnerId);
    if(!productionRendererPromotionStarted){
      productionRendererPromotionStarted=true;
      requestProductionWebGPUMigration({automatic:true}).catch(error=>{
        console.warn('[PStudio] Automatic WebGPU scene promotion was not completed; WebGL2 remains active.',error);
      });
    }
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
    for(const trail of trailEffects.values())disposeTrailEffect(trail);trailEffects.clear();
    cameraShakeState=null;godRaysEnabled=false;godRaysFallbackEnabled=false;godRaysIntensity=0;
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
    getRenderingBackendStatus:renderingBackendStatus,
    requestWebGPUMigration:()=>requestProductionWebGPUMigration({retry:true}),
    getWebGPUMigrationDiagnostics:()=>Object.freeze({
      bridge:productionRendererBridge?.getState?.()||null,
      blockers:Object.freeze(getProductionWebGPUFeatureBlockers()),
      compileStage:productionWebGPUCompileStage
    }),
    clear,
    frameObject,
    adjustZoom:adjustCameraZoom,
    cameraShake:triggerCameraShake,
    setGodRays:(enabled,intensity=1)=>{
      resetPostProcessingFailure();
      const requested=!!enabled;
      godRaysIntensity=Math.max(0,Math.min(2,Number.isFinite(Number(intensity))?Number(intensity):1));
      if(requested&&!renderer&&window.THREE)ensureRenderer();
      const webgpuRaysAvailable=window.PStudioRenderingMigration?.supportsPStudioTSLGodRays===true;
      const webgpuRaysActive=productionRendererBridge?.getState?.().backend==='webgpu';
      godRaysEnabled=requested&&(!!godRaysPass||(webgpuRaysActive&&webgpuRaysAvailable));
      godRaysFallbackEnabled=requested&&!godRaysEnabled&&!!bloomPass;
      if(productionRendererBridge?.getState?.().backend==='webgpu')productionRendererBridge.setGodRays?.(godRaysEnabled?getPStudioGodRaysSettings():false);
      if(!requested){godRaysEnabled=false;godRaysFallbackEnabled=false;}
      if(renderer&&scene&&camera)drawFrame();
      return{enabled:godRaysEnabled||godRaysFallbackEnabled,available:!!godRaysPass||webgpuRaysAvailable,fallback:godRaysFallbackEnabled?'bloom':null,intensity:godRaysIntensity};
    },
    getZoom:()=>({distanceMultiplier:zoom,displayPercent:Math.round((1/zoom)*100)}),
    retryModelAsset,
    getModelStatus,
    getEditorOverlayVisibility,
    setEditorOverlayVisibility,
    setSelected: id => {
      selectedOwnerId = id || null;
      if(id!==null&&id!==undefined)cameraFocusOwnerId=String(id);
      refreshSelectionOutline();
      if(renderer&&scene&&camera)drawFrame();
    },
    getCameraBasis,
    getModelCollisionTriangles,
    setPostProcessing:(bloom,ssao,strength,ssr)=>{resetPostProcessingFailure();bloomEnabled=!!bloom;ssaoEnabled=!!ssao&&!adaptiveTouchPostFxBudget;bloomStrength=Math.max(0,Math.min(2,Number(strength)||0.45));if(ssr!==undefined)ssrEnabled=!!ssr&&!adaptiveTouchPostFxBudget;if(renderer&&scene&&camera)drawFrame();},
    setQualityPreset:applyQualityPreset,setAdaptiveQuality:enabled=>{adaptiveQualityEnabled=!!enabled&&(qualityPreset==='auto'||qualityPreset==='ultra'||adaptiveMaximumTouchMode);adaptiveSlowFrames=0;adaptiveFastFrames=0;return adaptiveQualityEnabled;},
    togglePerformanceMonitor,
    getPerformanceStats:performanceStatsSnapshot,
    setDynamicGI:enabled=>{
      const next=!!enabled;
      if(next&&!bakedLightProbeVolume?.length)return{enabled:false,available:false,reason:'Bake an SH probe volume with bakeEnvironmentGI() before enabling the dynamic radiance cache.'};
      dynamicGIEnabled=next;
      if(next){
        dynamicProbeSnapshots=collectDynamicLightSnapshots();
        const signature=dynamicLightCacheSignature(dynamicProbeSnapshots);resetDynamicProbeCache(signature);
        dynamicGIStatus=dynamicLights.size?'updating':'waiting-for-dynamic-lights';
      }else{
        dynamicProbeDirty=null;dynamicProbeCache=[];dynamicProbeSnapshots=[];dynamicGIStatus='disabled';probeVolumeGeneration++;
      }
      if(renderer&&scene&&camera)drawFrame();
      return{enabled:dynamicGIEnabled,available:!!bakedLightProbeVolume?.length,status:dynamicGIStatus,probeCount:dynamicProbeCache.length,updateIntervalMs:DYNAMIC_PROBE_UPDATE_INTERVAL_MS,kind:'raster-captured-one-bounce-dynamic-sh-probe-cache'};
    },
    toggleDynamicGI:()=>{
      const result=window.PStudio3D.setDynamicGI(!dynamicGIEnabled);
      const button=document.getElementById('dynamic-gi-toggle');
      if(button){button.setAttribute('aria-pressed',String(!!result.enabled));button.classList.toggle('active',!!result.enabled);}
      const status=document.getElementById('gi-bake-status');
      if(status)status.textContent=result.enabled?'Live GI: '+result.status:(result.reason||'Live GI disabled');
      return result;
    },
    setTemporalAA:enabled=>{const next=!!enabled,fx=window.PStudioEnvironmentFX?.getStats?.()||{};if(next&&(Number(fx.waterMaterials)||0)+(Number(fx.foliageMaterials)||0)>0)return{enabled:false,reason:'Three.js r160 TAARenderPass has no motion-vector reprojection; freeze animated water/foliage before enabling temporal accumulation.'};if(!taaPass)return{enabled:false,reason:'TAARenderPass is unavailable.'};resetPostProcessingFailure();temporalAAEnabled=next;taaPass.accumulate=next;taaPass.accumulateIndex=-1;if(!next)taaPass.sampleLevel=['maximum','ultra'].includes(resolveQualityPreset(qualityPreset))?2:resolveQualityPreset(qualityPreset)==='high'?1:0;if(renderer&&scene&&camera)drawFrame();return{enabled:temporalAAEnabled,mode:next?'static-scene-temporal-accumulation':'per-frame-spatial-supersampling'};},
    setContactShadows:(enabled,options={})=>{
      resetPostProcessingFailure();
      contactShadowsRequested=enabled===null||enabled===undefined?null:!!enabled;
      const selected=resolveQualityPreset(qualityPreset),profile=QUALITY_PROFILES[selected];
      contactShadowsEnabled=!!contactShadowPass&&!memorySafetyApplied&&!adaptiveTouchPostFxBudget&&(contactShadowsRequested===null?!!profile.contactShadows:contactShadowsRequested);
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
    setVolumetricFog:(enabled,options={})=>{resetPostProcessingFailure();volumetricFogEnabled=!!enabled&&!adaptiveTouchPostFxBudget;if(volumetricFogPass){const u=volumetricFogPass.uniforms;if(u){if(options.color&&u.uFogColor?.value?.set)u.uFogColor.value.set(options.color);if(Number.isFinite(options.density)&&u.uFogDensity&&Object.prototype.hasOwnProperty.call(u.uFogDensity,'value'))u.uFogDensity.value=Math.max(0,Math.min(.08,options.density));if(Number.isFinite(options.heightFalloff)&&u.uHeightFalloff&&Object.prototype.hasOwnProperty.call(u.uHeightFalloff,'value'))u.uHeightFalloff.value=Math.max(0,Math.min(.2,options.heightFalloff));if(Number.isFinite(options.baseHeight)&&u.uBaseHeight&&Object.prototype.hasOwnProperty.call(u.uBaseHeight,'value'))u.uBaseHeight.value=options.baseHeight;}}if(renderer&&scene&&camera)drawFrame();return{enabled:volumetricFogEnabled,available:!!volumetricFogPass};},
    setVolumetricClouds:(enabled,options={})=>{resetPostProcessingFailure();volumetricCloudsEnabled=!!enabled&&!adaptiveTouchPostFxBudget&&!!volumetricCloudPass&&activeEnvironmentPreset!=='studio';if(volumetricCloudPass){const u=volumetricCloudPass.uniforms;if(u){if(Number.isFinite(options.base)&&u.uCloudBase&&Object.prototype.hasOwnProperty.call(u.uCloudBase,'value'))u.uCloudBase.value=options.base;if(Number.isFinite(options.top)&&u.uCloudTop&&Object.prototype.hasOwnProperty.call(u.uCloudTop,'value'))u.uCloudTop.value=Math.max((Number(u.uCloudBase?.value)||0)+1,options.top);if(Number.isFinite(options.density)&&u.uCloudDensity&&Object.prototype.hasOwnProperty.call(u.uCloudDensity,'value'))u.uCloudDensity.value=Math.max(0,Math.min(2,options.density));if(Number.isFinite(options.scale)&&u.uCloudScale&&Object.prototype.hasOwnProperty.call(u.uCloudScale,'value'))u.uCloudScale.value=Math.max(.0005,Math.min(.05,options.scale));if(Number.isFinite(options.atmosphereStrength)&&u.uAtmosphereStrength&&Object.prototype.hasOwnProperty.call(u.uAtmosphereStrength,'value'))u.uAtmosphereStrength.value=Math.max(0,Math.min(1,options.atmosphereStrength));if(Number.isFinite(options.coverage)&&u.uCloudCoverage)u.uCloudCoverage.value=Math.max(0,Math.min(1,options.coverage));if(Number.isFinite(options.detail)&&u.uCloudDetail)u.uCloudDetail.value=Math.max(0,Math.min(1,options.detail));if(Number.isFinite(options.steps)&&u.uCloudSteps)u.uCloudSteps.value=Math.max(8,Math.min(64,Math.floor(options.steps)));if(Number.isFinite(options.windX)&&Number.isFinite(options.windZ)&&u.uCloudWind?.set)u.uCloudWind.value.set(Math.max(-4,Math.min(4,options.windX)),Math.max(-4,Math.min(4,options.windZ)));}}if(renderer&&scene&&camera)drawFrame();return{enabled:volumetricCloudsEnabled,available:!!volumetricCloudPass,reason:adaptiveTouchPostFxBudget?'Disabled by the constrained-touch rendering budget.':null};},
    getQualityPreset:()=>{
      const active=resolveQualityPreset(qualityPreset),hardware=qualityHardwareCapabilities();
      const targetPixelRatio=qualityPreset==='ultra'?Math.min(hardware.pixelRatio,QUALITY_PROFILES.maximum.pixelRatio)*2:resolveQualityRenderPixelRatio(active,adaptiveQualityLevel,adaptiveQualityEnabled);
      const renderPixelRatio=renderer?.getPixelRatio?.()||resolveQualityRenderPixelRatio(active,adaptiveQualityLevel,adaptiveQualityEnabled);
      return{requested:qualityPreset,active,adaptiveEnabled:adaptiveQualityEnabled,adaptiveLevel:adaptiveQualityLevel,safetyLimited:memorySafetyApplied,hardware,outputMultiplier:qualityPreset==='ultra'?2:1,targetPixelRatio,renderPixelRatio,resolutionLimited:qualityPreset==='ultra'&&renderPixelRatio+0.001<targetPixelRatio};
    },
    getMemoryStats:memorySnapshot,
    getStats:()=>renderer?{
      renderingBackend:renderingBackendStatus(),
      calls:lastFrameRenderStats.calls,
      contactShadows:{enabled:contactShadowsEnabled,available:!!contactShadowPass,steps:contactShadowPass?.uniforms?.uSteps?.value||0},
      triangles:lastFrameRenderStats.triangles,
      points:lastFrameRenderStats.points,
      geometries:lastFrameRenderStats.geometries,
      textures:lastFrameRenderStats.textures,
      instancedBatches:instancedBatches.size,
      clusteredLighting:{enabled:clusteredLightingEnabled,active:clusteredLightingActive,available:!!clusteredLightingResources,pointLights:clusteredLightingResources?.lightCount||0,clusteredPointLights:clusteredLightSet.size,nativeFallbackPointLights:[...dynamicLights.values()].filter(light=>light.isPointLight&&light.visible).length,updatedClusters:clusteredLightingUpdatedClusters,grid:[CLUSTER_GRID_X,CLUSTER_GRID_Y,CLUSTER_GRID_Z],maxLightsPerCluster:CLUSTER_MAX_PER_CELL,mode:'cpu-cluster-assignment-gpu-brdf'},
      virtualTexturing:{textures:virtualTextures.size,queuedPages:virtualTextureQueue.length,residentPages:virtualTexturePageCache.size,requestedPages:virtualTextureRequests,uploadedPages:virtualTextureTileUploads,atlasBytes:[...virtualTextureAtlases.values()].reduce((sum,atlas)=>sum+atlas.bytes,0),atlasCount:virtualTextureAtlases.size},
      gpuInstanceFrustumCulling:{enabled:gpuInstanceFrustumCullingEnabled,mode:'vertex-shader-sphere-test',primitiveBatches:[...instancedBatches.values()].filter(batch=>batch.userData?.pstudioGPUFrustumConfigured).length,modelBatches:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.foliageBatches||[]).filter(entry=>entry.mesh.userData?.pstudioGPUFrustumConfigured).length,0)},
      instancedInstances:[...instancedBatches.values()].reduce((sum,batch)=>sum+batch.count,0),foliageInstancedBatches:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.foliageBatches?.filter(entry=>entry.isTree).length||0),0),modelInstancedBatches:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.foliageBatches?.filter(entry=>!entry.isTree).length||0),0),modelStreamChunks:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.streamChunks?.length||0),0),activeModelStreamChunks:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.streamChunks?.filter(chunk=>chunk.userData.pstudioStreamActive!==false).length||0),0),foliageInstancedInstances:[...modelInstances.values()].reduce((sum,instance)=>sum+(instance.foliageBatches||[]).reduce((n,entry)=>n+entry.sources.length,0),0),
      gpuParticleSystems:particleEmitters.size+particleBursts.size,
      trails:{active:trailEffects.size,maxEffects:MAX_TRAIL_EFFECTS,maxPoints:MAX_TRAIL_POINTS},
      cameraShake:{active:!!cameraShakeState},
      godRays:{available:!!godRaysPass,enabled:godRaysEnabled,fallback:godRaysFallbackEnabled},
      postProcessing:{available:!!composer,failed:postProcessingFailed,reason:postProcessingFailureReason||null},
      models:modelInstances.size,
      modelPreparationPending,
      stagedTextureUploads,
      parallelShaderCompileSupported,
      frustumCulledMeshes:[...modelInstances.values()].reduce((sum,instance)=>sum+instance.meshes.filter(mesh=>mesh.frustumCulled).length,0),
      renderTimeMs:Number(lastRenderDurationMs.toFixed(2)),gpuRenderTimeMs:lastGpuRenderDurationMs?Number(lastGpuRenderDurationMs.toFixed(2)):null,timingSource:adaptiveMetricSource,gpuTimerQuerySupported:!!gpuTimerExtension,quality:resolveQualityPreset(qualityPreset),adaptive:{enabled:adaptiveQualityEnabled,level:adaptiveQualityLevel,frameEMA:Number(adaptiveFrameEMA.toFixed(2)),source:adaptiveMetricSource,dynamicResolutionScale:Number(dynamicResolutionScale.toFixed(3))},performance:performanceStatsSnapshot(),gi:{probeCount:bakedLightProbeVolume?.length||0,bounces:bakedGIBounces,objectLocalSH:true,probeInterpolationCache:{hits:probeRadianceCacheHits,misses:probeRadianceCacheMisses,recomputes:probeRadianceCacheRecomputes,generation:probeVolumeGeneration},dynamic:{enabled:dynamicGIEnabled,status:dynamicGIStatus,probeCount:dynamicProbeCache.length,validProbes:dynamicProbeCache.filter(item=>item.valid).length,updates:dynamicProbeUpdates,updateIntervalMs:DYNAMIC_PROBE_UPDATE_INTERVAL_MS,kind:'raster-captured-one-bounce-dynamic-light-sh-cache',rayTraced:false},uvLightmappedMeshes:lightmapTargets().filter(({object})=>!!object.userData.pstudioLightmapTexture).length,pendingLightmaps:pendingLightmaps.size,bvhAvailable:!!window.PStudioBVH},csm:{enabled:!!csm,cascades:csm?.cascades||0,shadowDistance:worldRenderConfig.shadowDistance},environmentFX:window.PStudioEnvironmentFX?.getStats?.()||null,memory:{deviceMemoryGiB:deviceMemoryGiB(),modelEstimateBytes:[...modelCache.values()].reduce((sum,asset)=>sum+(Number(asset.memoryEstimateBytes)||0),0),jsHeapUsedBytes:Number(window.performance?.memory?.usedJSHeapSize)||null,jsHeapLimitBytes:Number(window.performance?.memory?.jsHeapSizeLimit)||null,resourceCache:window.PStudioResources?.stats?.()||null,clusteredLightingBytes:clusteredLightingResources?.bytes||0,virtualTextureAtlasBytes:[...virtualTextureAtlases.values()].reduce((sum,atlas)=>sum+atlas.bytes,0)},volumetricClouds:{available:!!volumetricCloudPass,enabled:volumetricCloudsEnabled},waterDepthPrepass:{available:!!waterDepthTarget,failed:waterDepthPrepassFailed},temporalAA:{available:!!taaPass,enabled:!!taaPass?.enabled,accumulating:!!taaPass?.accumulate},volumetricFog:{available:!!volumetricFogPass,enabled:volumetricFogEnabled}
    }:null,
    loadEnvironmentHDR,
    bakeLightProbe,
    clearLightProbe:()=>{let changed=false;if(bakedLightProbe){scene?.remove(bakedLightProbe);bakedLightProbe=null;changed=true;}if(bakedLightProbeVolume){for(const item of bakedLightProbeVolume){scene?.remove(item.light);item.light.dispose?.();}bakedLightProbeVolume=null;bakedGIBounces=0;changed=true;}if(changed){updateProbeVolumeBlend();drawFrame();}return changed;},
    bakeLightProbeVolume,
    bakeEnvironmentGI:async options=>{
      const status=document.getElementById('gi-bake-status');
      if(status)status.textContent='Baking static SH probes...';
      try{
        const result=await bakeEnvironmentGI(options);
        if(status)status.textContent='GI ready: '+result.probes+' probes, '+result.bounces+' bounces';
        try{window.PStudioEvents?.emit('gi.bake.completed',result);}catch(_){}
        return result;
      }catch(error){
        if(status)status.textContent='GI bake failed: '+String(error?.message||error);
        try{window.PStudioEvents?.emit('gi.bake.failed',{message:String(error?.message||error)});}catch(_){}
        throw error;
      }
    },
    bakeUVLightmaps,saveLightmaps,loadLightmaps,clearLightmaps,setWorldRenderConfig,registerWorldChunk,assignObjectToChunk,unassignObjectFromChunk,unregisterWorldChunk,
    setWorldStreamingInterests,clearWorldStreamingInterests,
    isOwnerChunkActive,
    setGPUInstanceFrustumCulling:enabled=>{gpuInstanceFrustumCullingEnabled=!!enabled;updateGPUInstanceFrustumPlanes();return gpuInstanceFrustumCullingEnabled;},
    setClusteredLighting:enabled=>{clusteredLightingEnabled=!!enabled;updateClusteredLighting(true);return{enabled:clusteredLightingEnabled,available:!!clusteredLightingResources,active:clusteredLightingActive};},
    setOcclusionCulling:enabled=>{occlusionEnabled=!!enabled;for(const mesh of meshCache.values()){mesh.userData.pstudioOccluded=false;mesh.visible=true;}for(const instance of modelInstances.values()){instance.root.userData.pstudioOccluded=false;instance.root.visible=true;}for(const batch of instancedBatches.values())for(const source of batch.userData.instanceSources||[])source.mesh.userData.pstudioOccluded=false;return occlusionEnabled;},
    getWorldStats:()=>({chunks:worldChunks.size,activeChunks:[...worldChunks.values()].filter(c=>c.active).length,loadingChunks:[...worldChunks.values()].filter(c=>c.loading).length,chunkErrors:[...worldChunks.values()].filter(c=>c.error).map(c=>({id:c.id,error:c.error})),assignedObjects:objectChunkAssignments.size,streamingInterests:worldStreamingInterests.length,config:{...worldRenderConfig,lodDistances:worldRenderConfig.lodDistances.slice()}}),
    isAvailable: () => !!window.THREE,
    getModelError: name => modelLoadErrors.get(name) || null,
    invalidateAsset
  };
  window.addEventListener('resize', resize);
})();