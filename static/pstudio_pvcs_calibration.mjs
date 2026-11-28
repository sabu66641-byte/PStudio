import { compareRgbaFrames, compareTemporalSequences } from "./pstudio_visual_difference.mjs";

const DOMAIN_METRICS = Object.freeze({
  "cpu-frame": "cpuFrameMs",
  "cpu-stage": "cpuStageMs",
  "gpu-frame": "gpuFrameMs",
  "gpu-stage": "gpuStageMs",
  asynchronous: "asyncElapsedMs",
  memory: "memoryBytes"
});
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonical(value[key]);
  return output;
}
function contextKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("PVCS calibration requires a render context object.");
  return JSON.stringify(canonical(value));
}
function percentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.ceil(p * ordered.length) - 1))];
}
function validateMetric(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("PVCS calibration metric is unavailable or invalid: " + field + ".");
  return number;
}
function frameCopy(frame, maxPixels) {
  if (!frame || !Number.isSafeInteger(Number(frame.width)) || !Number.isSafeInteger(Number(frame.height))) throw new TypeError("PVCS calibration capture must provide an RGBA frame.");
  const width = Number(frame.width), height = Number(frame.height), channels = Number(frame.channels || 4);
  if (width < 1 || height < 1 || channels !== 4 || width * height > maxPixels) throw new RangeError("PVCS calibration frame dimensions exceed the configured RGBA limit.");
  if (!frame.data || frame.data.length !== width * height * 4) throw new RangeError("PVCS calibration RGBA data length does not match its dimensions.");
  return Object.freeze({ width, height, channels, data: Uint8Array.from(frame.data) });
}
function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
function validateLimits(limits) {
  const output = {
    maxMeanAbsoluteError: Number(limits?.maxMeanAbsoluteError),
    maxChangedPixelRatio: Number(limits?.maxChangedPixelRatio),
    maxTemporalError: Number(limits?.maxTemporalError)
  };
  for (const [key, value] of Object.entries(output)) if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("Explicit PVCS visual acceptance limit is required: " + key + ".");
  return Object.freeze(output);
}

/**
 * Repeatable, real-callback A/B calibration for PVCS. The caller supplies the
 * active renderer variant switch, metric capture and RGBA readback. No synthetic
 * samples are generated and unavailable GPU metrics fail closed instead of
 * falling back to CPU timings.
 *
 * Required callbacks:
 *   readContext() -> stable workload context
 *   applyVariant("baseline" | "alternative")
 *   capture() -> { metrics: {...}, frame: { width, height, channels: 4, data } }
 *   restore() -> restores the pre-calibration renderer state
 */
export function createPStudioPVCSCalibrationRunner(options = {}) {
  const readContext = options.readContext;
  const applyVariant = options.applyVariant;
  const capture = options.capture;
  const restore = options.restore;
  if (typeof readContext !== "function" || typeof applyVariant !== "function" ||
      typeof capture !== "function" || typeof restore !== "function") {
    throw new TypeError("PVCS calibration requires readContext, applyVariant, capture and restore callbacks.");
  }
  const domain = String(options.domain || "cpu-frame");
  if (!Object.prototype.hasOwnProperty.call(DOMAIN_METRICS, domain)) throw new TypeError("Unsupported PVCS calibration domain: " + domain);
  const sampleCount = Math.max(2, Math.min(512, Math.floor(Number(options.sampleCount) || 40)));
  const warmupCount = Math.max(0, Math.min(120, Math.floor(Number(options.warmupCount) || 4)));
  const visualSampleCount = Math.max(2, Math.min(sampleCount, Math.floor(Number(options.visualSampleCount) || Math.min(8, sampleCount))));
  const minSamples = Math.max(2, Math.floor(Number(options.minSamples) || 30));
  const maxPixels = Math.max(1, Math.min(4194304, Math.floor(Number(options.maxPixels) || 1048576)));
  const limits = validateLimits(options.limits);
  let running = false;

  async function run(runOptions = {}) {
    if (running) throw new Error("A PVCS calibration run is already active.");
    running = true;
    const signal = runOptions.signal || options.signal || null;
    const samples = { baseline: [], alternative: [] };
    const visualFrames = { baseline: [], alternative: [] };
    let originalContextKey = null;
    let restoreAttempted = false;
    function abortCheck() {
      if (signal?.aborted) {
        const error = new Error("PVCS calibration was cancelled.");
        error.name = "AbortError";
        throw error;
      }
    }
    async function sampleVariant(variant, index, warmup) {
      abortCheck();
      await applyVariant(variant, Object.freeze({ index, warmup, signal }));
      abortCheck();
      const currentKey = contextKey(await readContext());
      if (currentKey !== originalContextKey) throw new Error("PVCS calibration context changed during A/B capture; samples were discarded.");
      const result = await capture(Object.freeze({ variant, index, warmup, signal }));
      if (warmup) return;
      const metricName = DOMAIN_METRICS[domain];
      const metrics = result?.metrics || result || {};
      samples[variant].push(validateMetric(metrics[metricName], metricName));
      if (visualFrames[variant].length < visualSampleCount) {
        visualFrames[variant].push(frameCopy(result?.frame || result?.rgbaFrame, maxPixels));
      }
      try { options.onSample?.(Object.freeze({ variant, index, warmup: false, sampleCount: samples[variant].length, target: sampleCount })); } catch (_) {}
    }

    try {
      originalContextKey = contextKey(await readContext());
      for (let index = 0; index < warmupCount; index += 1) {
        await sampleVariant("baseline", index, true);
        await sampleVariant("alternative", index, true);
      }
      for (let index = 0; index < sampleCount; index += 1) {
        // Alternate order each pair to reduce systematic warm-up and thermal bias.
        const order = index % 2 === 0 ? ["baseline", "alternative"] : ["alternative", "baseline"];
        for (const variant of order) await sampleVariant(variant, index, false);
      }
      if (samples.baseline.length < minSamples || samples.alternative.length < minSamples) {
        throw new Error("PVCS calibration did not collect the required sample count for both variants.");
      }
      if (visualFrames.baseline.length < 2 || visualFrames.alternative.length !== visualFrames.baseline.length) {
        throw new Error("PVCS calibration did not collect enough aligned image frames.");
      }
      const frameComparisons = visualFrames.baseline.map((frame, index) => compareRgbaFrames(frame, visualFrames.alternative[index]));
      const temporal = compareTemporalSequences(visualFrames.baseline, visualFrames.alternative);
      const evidence = Object.freeze({
        domain,
        context: canonical(await readContext()),
        baseline: Object.freeze({ p95: percentile(samples.baseline, 0.95), sampleCount: samples.baseline.length, mean: average(samples.baseline) }),
        alternative: Object.freeze({ p95: percentile(samples.alternative, 0.95), sampleCount: samples.alternative.length, mean: average(samples.alternative) }),
        visual: Object.freeze({
          meanAbsoluteError: average(frameComparisons.map(value => value.meanAbsoluteError)),
          changedPixelRatio: average(frameComparisons.map(value => value.changedPixelRatio)),
          sampleCount: frameComparisons.length
        }),
        temporal: Object.freeze({
          meanAbsoluteTemporalDeltaError: temporal.meanAbsoluteTemporalDeltaError,
          frameCount: temporal.frameCount,
          metric: temporal.metric
        }),
        limits
      });
      return Object.freeze({
        status: "calibrated",
        evidence,
        samples: Object.freeze({ baseline: samples.baseline.length, alternative: samples.alternative.length, visualFrames: frameComparisons.length }),
        improvementRatio: evidence.baseline.p95 > 0 ? (evidence.baseline.p95 - evidence.alternative.p95) / evidence.baseline.p95 : null
      });
    } finally {
      restoreAttempted = true;
      try { await restore(); }
      finally { running = false; }
    }
  }
  return Object.freeze({ kind: "pstudio-pvcs-calibration-runner", run, getState: () => Object.freeze({ running }) });
}
