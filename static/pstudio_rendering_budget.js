(function(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.PStudioRenderingBudget = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function() {
  'use strict';
  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  function createPStudioFrameBudgetController() {
    const state = {
      source:'unavailable', measuredMs:null, targetFrameMs:16.67, resourcePressure:0,
      scale:1, mirrorIntervalFrames:1, mirrorResolutionScale:1,
      giCaptureAllowed:true, giCadenceMultiplier:1,
      cloudStepScale:1, fogStepScale:1, contactShadowStepScale:1, revision:0
    };
    function update(gpuRenderMs,gpuFresh,frameIntervalMs,targetFrameMs,resourcePressure,cameraMoving,dynamicScene,hasMirrors,giEnabled) {
      const target = clamp(targetFrameMs,8,60,16.67);
      const gpuMs = Number(gpuRenderMs), frameMs = Number(frameIntervalMs);
      const useGpu = gpuFresh === true && Number.isFinite(gpuMs) && gpuMs > 0;
      const useFrame = !useGpu && Number.isFinite(frameMs) && frameMs >= 1 && frameMs <= 100;
      if (!useGpu && !useFrame) return state;
      const measured = useGpu ? gpuMs : frameMs, ratio = measured / target;
      let scale = useGpu
        ? clamp(1 - Math.max(0,ratio - 0.58) * 1.25,0.35,1,1)
        : clamp(1 - Math.max(0,ratio - 0.72) * 1.1,0.42,1,1);
      const pressure = clamp(resourcePressure,0,1,0);
      if (pressure >= 0.96) scale = Math.min(scale,0.38);
      else if (pressure >= 0.88) scale = Math.min(scale,0.52);
      else if (pressure >= 0.78) scale = Math.min(scale,0.70);
      const mirrorInterval = !hasMirrors ? 0 : cameraMoving
        ? (scale >= 0.82 ? 1 : scale >= 0.60 ? 2 : 3)
        : dynamicScene
          ? (scale >= 0.82 ? 2 : scale >= 0.60 ? 3 : 4)
          : 24;
      const mirrorResolution = clamp(0.62 + scale * 0.38,0.62,1,1);
      const giAllowed = Boolean(giEnabled && scale >= 0.45 && pressure < 0.93);
      const giCadence = scale >= 0.84 ? 1 : scale >= 0.70 ? 1.5 : scale >= 0.55 ? 2.5 : 4;
      const cloudScale = clamp(0.55 + scale * 0.45,0.55,1,1);
      const fogScale = clamp(0.60 + scale * 0.40,0.60,1,1);
      const contactScale = clamp(0.50 + scale * 0.50,0.50,1,1);
      const changed =
        state.source !== (useGpu ? 'gpu-timer-query' : 'frame-interval-fallback') ||
        Math.abs(state.scale - scale) >= 0.015 ||
        state.mirrorIntervalFrames !== mirrorInterval ||
        Math.abs(state.mirrorResolutionScale - mirrorResolution) >= 0.015 ||
        state.giCaptureAllowed !== giAllowed ||
        Math.abs(state.giCadenceMultiplier - giCadence) >= 0.015 ||
        Math.abs(state.cloudStepScale - cloudScale) >= 0.015 ||
        Math.abs(state.fogStepScale - fogScale) >= 0.015 ||
        Math.abs(state.contactShadowStepScale - contactScale) >= 0.015;
      state.source = useGpu ? 'gpu-timer-query' : 'frame-interval-fallback';
      state.measuredMs = measured; state.targetFrameMs = target; state.resourcePressure = pressure;
      state.scale = scale; state.mirrorIntervalFrames = mirrorInterval; state.mirrorResolutionScale = mirrorResolution;
      state.giCaptureAllowed = giAllowed; state.giCadenceMultiplier = giCadence;
      state.cloudStepScale = cloudScale; state.fogStepScale = fogScale; state.contactShadowStepScale = contactScale;
      if (changed) state.revision += 1;
      return state;
    }
    return Object.freeze({state,update});
  }

  function createPStudioResolutionTrialVerifier(options = {}) {
    const requiredSamples = Math.floor(clamp(options.sampleCount, 4, 120, 30));
    const minimumImprovement = clamp(options.minimumImprovement, 0.005, 0.2, 0.025);
    let trial = null, blocked = false;
    let last = {status:'unverified',beforeScale:null,afterScale:null,referenceFrameMs:null,observedFrameMs:null,improvement:null,sampleCount:0,reason:null};
    function snapshot() { return Object.freeze({...last,active:!!trial,blocked,requiredSamples,minimumImprovement}); }
    function begin(beforeScale,afterScale,referenceFrameMs) {
      const before=Number(beforeScale),after=Number(afterScale),reference=Number(referenceFrameMs);
      if(trial||blocked||!Number.isFinite(before)||!Number.isFinite(after)||!Number.isFinite(reference)||before<=0||after<=0||after>=before||reference<=0||reference>100)return false;
      trial={beforeScale:before,afterScale:after,referenceFrameMs:reference,samples:[]};
      last={status:'measuring',beforeScale:before,afterScale:after,referenceFrameMs:reference,observedFrameMs:null,improvement:null,sampleCount:0,reason:null};
      return snapshot();
    }
    function observe(frameIntervalMs) {
      if(!trial)return snapshot();
      const value=Number(frameIntervalMs);
      if(!Number.isFinite(value)||value<1||value>100)return snapshot();
      trial.samples.push(value);last={...last,sampleCount:trial.samples.length};
      if(trial.samples.length<requiredSamples)return snapshot();
      const observed=trial.samples.reduce((sum,sample)=>sum+sample,0)/trial.samples.length;
      const improvement=(trial.referenceFrameMs-observed)/trial.referenceFrameMs;
      const improved=improvement>=minimumImprovement;blocked=!improved;
      last={status:improved?'improved':'ineffective',beforeScale:trial.beforeScale,afterScale:trial.afterScale,referenceFrameMs:trial.referenceFrameMs,observedFrameMs:observed,improvement,sampleCount:trial.samples.length,reason:improved?null:'frame-pacing-did-not-improve'};
      trial=null;return snapshot();
    }
    function reset(reason='reset') {
      trial=null;blocked=false;
      last={status:'unverified',beforeScale:null,afterScale:null,referenceFrameMs:null,observedFrameMs:null,improvement:null,sampleCount:0,reason:String(reason||'reset')};
      return snapshot();
    }
    return Object.freeze({begin,observe,reset,getState:snapshot});
  }

  return Object.freeze({createPStudioFrameBudgetController,createPStudioResolutionTrialVerifier});
});
