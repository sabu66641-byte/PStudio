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
          : 4;
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
  return Object.freeze({createPStudioFrameBudgetController});
});
