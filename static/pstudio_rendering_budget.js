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
      cloudStepScale:1, fogStepScale:1, contactShadowStepScale:1, revision:0,
      compensationActive:false, compensationRevision:0
    };
    let compensation = null;
    let compensationRevision = 0;
    let lastBaseState = {...state};
    const compensationTokens = new WeakMap();
    let currentCompensationToken = null;
    function normalizeCompensation(profile = {}) {
      const allowed = ['scale','mirrorIntervalFrames','mirrorResolutionScale','giCadenceMultiplier','cloudStepScale','fogStepScale','contactShadowStepScale'];
      const result = {};
      for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(profile,key)) continue;
        const value = Number(profile[key]);
        if (!Number.isFinite(value)) throw new TypeError('Invalid PVCS frame-budget compensation value: '+key);
        if (key==='mirrorIntervalFrames') {
          if (!Number.isInteger(value)||value<1||value>60) throw new RangeError('mirrorIntervalFrames must be between 1 and 60.');
        } else if (key==='giCadenceMultiplier') {
          if (value<1||value>16) throw new RangeError('giCadenceMultiplier must be between 1 and 16.');
        } else if (key==='scale') {
          if (value<0.65||value>1) throw new RangeError('scale must be between 0.65 and 1.');
        } else if (value<0.5||value>1) {
          throw new RangeError(key+' must be between 0.5 and 1.');
        }
        result[key]=value;
      }
      if(!Object.keys(result).length)throw new TypeError('PVCS frame-budget compensation requires at least one bounded control.');
      return Object.freeze(result);
    }
    function applyCompensationOverlay() {
      Object.assign(state,lastBaseState);
      if(compensation) {
        if(Number.isFinite(compensation.scale))state.scale=Math.min(state.scale,compensation.scale);
        if(Number.isFinite(compensation.mirrorIntervalFrames)&&state.mirrorIntervalFrames>0)state.mirrorIntervalFrames=Math.max(state.mirrorIntervalFrames,compensation.mirrorIntervalFrames);
        if(Number.isFinite(compensation.mirrorResolutionScale))state.mirrorResolutionScale=Math.min(state.mirrorResolutionScale,compensation.mirrorResolutionScale);
        if(Number.isFinite(compensation.giCadenceMultiplier))state.giCadenceMultiplier=Math.max(state.giCadenceMultiplier,compensation.giCadenceMultiplier);
        if(Number.isFinite(compensation.cloudStepScale))state.cloudStepScale=Math.min(state.cloudStepScale,compensation.cloudStepScale);
        if(Number.isFinite(compensation.fogStepScale))state.fogStepScale=Math.min(state.fogStepScale,compensation.fogStepScale);
        if(Number.isFinite(compensation.contactShadowStepScale))state.contactShadowStepScale=Math.min(state.contactShadowStepScale,compensation.contactShadowStepScale);
      }
      state.compensationActive=!!compensation;
      state.compensationRevision=compensationRevision;
      state.revision=lastBaseState.revision+compensationRevision;
      return state;
    }
    function applyCompensation(profile) {
      const next=normalizeCompensation(profile);
      const previous=compensation?Object.freeze({...compensation}):null;
      const token=Object.freeze({kind:'pstudio-frame-budget-rollback-token'});
      compensationTokens.set(token,{previous,previousToken:currentCompensationToken});
      currentCompensationToken=token;
      compensation=next;
      compensationRevision+=1;
      applyCompensationOverlay();
      return token;
    }
    function restoreCompensation(token) {
      if(!token||token!==currentCompensationToken||!compensationTokens.has(token))return false;
      const previous=compensationTokens.get(token);
      compensation=previous.previous;
      currentCompensationToken=previous.previousToken;
      compensationTokens.delete(token);
      compensationRevision+=1;
      applyCompensationOverlay();
      return true;
    }
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
        lastBaseState.source !== (useGpu ? 'gpu-timer-query' : 'frame-interval-fallback') ||
        Math.abs(lastBaseState.scale - scale) >= 0.015 ||
        lastBaseState.mirrorIntervalFrames !== mirrorInterval ||
        Math.abs(lastBaseState.mirrorResolutionScale - mirrorResolution) >= 0.015 ||
        lastBaseState.giCaptureAllowed !== giAllowed ||
        Math.abs(lastBaseState.giCadenceMultiplier - giCadence) >= 0.015 ||
        Math.abs(lastBaseState.cloudStepScale - cloudScale) >= 0.015 ||
        Math.abs(lastBaseState.fogStepScale - fogScale) >= 0.015 ||
        Math.abs(lastBaseState.contactShadowStepScale - contactScale) >= 0.015;
      state.source = useGpu ? 'gpu-timer-query' : 'frame-interval-fallback';
      state.measuredMs = measured; state.targetFrameMs = target; state.resourcePressure = pressure;
      state.scale = scale; state.mirrorIntervalFrames = mirrorInterval; state.mirrorResolutionScale = mirrorResolution;
      state.giCaptureAllowed = giAllowed; state.giCadenceMultiplier = giCadence;
      state.cloudStepScale = cloudScale; state.fogStepScale = fogScale; state.contactShadowStepScale = contactScale;
      if (changed) state.revision = lastBaseState.revision + 1;
      else state.revision = lastBaseState.revision;
      lastBaseState = {...state};
      return applyCompensationOverlay();
    }
    return Object.freeze({state,update,applyCompensation,restoreCompensation});
  }
  return Object.freeze({createPStudioFrameBudgetController});
});
