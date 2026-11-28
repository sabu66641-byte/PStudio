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
  const warmupCount = Math.max(0, Math.min(120, Math.floor(Number(options.warmupCount ?? 4))));
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
      const afterCaptureKey = contextKey(await readContext());
      if (afterCaptureKey !== originalContextKey) throw new Error("PVCS calibration context changed during capture; samples were discarded.");
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
      try { await restore(); }
      finally { running = false; }
    }
  }
  return Object.freeze({ kind: "pstudio-pvcs-calibration-runner", run, getState: () => Object.freeze({ running }) });
}


// Paired evidence-gated harness; kept alongside the original callback-based calibration API.

const HARNESS_DOMAIN_METRICS = Object.freeze({
  'cpu-frame': Object.freeze({ key: 'cpuFrameMs', unit: 'ms' }),
  'cpu-stage': Object.freeze({ key: 'cpuSubmitMs', unit: 'ms' }),
  'gpu-frame': Object.freeze({ key: 'gpuRenderMs', unit: 'ms' }),
  'gpu-stage': Object.freeze({ key: 'gpuStageMs', unit: 'ms' }),
  asynchronous: Object.freeze({ key: 'asyncElapsedMs', unit: 'ms' }),
  memory: Object.freeze({ key: 'memoryBytes', unit: 'bytes' })
});

function harnessFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(label + ' must be a harnessFinite non-negative number.');
  return number;
}
function harnessInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new RangeError(label + ' must be an harnessInteger between ' + min + ' and ' + max + '.');
  return number;
}
function harnessCanonical(value) {
  if (Array.isArray(value)) return value.map(harnessCanonical);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = harnessCanonical(value[key]);
  return result;
}
function harnessNormalizeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A complete render context is required.');
  const result = {};
  for (const key of ['backend', 'scene', 'quality']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new TypeError('Render context must include ' + key + '.');
    result[key] = value[key].trim();
  }
  for (const key of ['renderWidth', 'renderHeight', 'renderPixelRatio']) {
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number <= 0) throw new TypeError('Render context must include positive ' + key + '.');
    result[key] = number;
  }
  if (value.effects != null) {
    if (typeof value.effects !== 'object' || Array.isArray(value.effects)) throw new TypeError('Render context effects must be an object.');
    result.effects = {};
    for (const key of Object.keys(value.effects).sort()) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || typeof value.effects[key] !== 'boolean') {
        throw new TypeError('Render context effect flags must have stable keys and explicit boolean values.');
      }
      result.effects[key] = value.effects[key];
    }
  }
  return Object.freeze(harnessCanonical(result));
}
function harnessFreezeProfile(profile, label) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError(label + ' profile must be an object.');
  return Object.freeze({ ...profile });
}
function harnessValidateByteFrame(frame) {
  if (!frame || (!(frame.data instanceof Uint8Array) && !(frame.data instanceof Uint8ClampedArray))) {
    throw new TypeError('Calibration image captures must use Uint8Array or Uint8ClampedArray pixel bytes.');
  }
  const width = Math.floor(Number(frame.width));
  const height = Math.floor(Number(frame.height));
  const channels = Math.floor(Number(frame.channels) || 4);
  if (width < 1 || height < 1 || (channels !== 3 && channels !== 4) || frame.data.length !== width * height * channels) {
    throw new RangeError('Calibration frame data does not match its width, height and channel count.');
  }
  return { ...frame, width, height, channels };
}
function harnessCopySmallFrame(frame, maxWidth, maxHeight) {
  const width = Math.floor(Number(frame.width));
  const height = Math.floor(Number(frame.height));
  const channels = Math.floor(Number(frame.channels) || 4);
  if (!frame.data || frame.data.length !== width * height * channels) throw new RangeError('Calibration frame data does not match its dimensions.');
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const outWidth = Math.max(1, Math.floor(width * scale));
  const outHeight = Math.max(1, Math.floor(height * scale));
  const data = new Uint8Array(outWidth * outHeight * channels);
  for (let y = 0; y < outHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / outHeight));
    for (let x = 0; x < outWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / outWidth));
      const from = (sourceY * width + sourceX) * channels;
      const to = (y * outWidth + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) data[to + channel] = Number(frame.data[from + channel]);
    }
  }
  return Object.freeze({ data, width: outWidth, height: outHeight, channels });
}
function harnessCheckAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('PVCS calibration was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
function harnessSampleMetric(result, key, label) {
  const metrics = result?.metrics || result || {};
  return harnessFinite(metrics[key], label + '.' + key);
}
function harnessSameContext(a, b) {
  return JSON.stringify(harnessCanonical(a)) === JSON.stringify(harnessCanonical(b));
}

/**
 * Paired, alternating A/B calibration for PVCS. The caller owns the actual scene
 * execution and capture; this harness only accepts explicit measurements and pixels.
 * It never applies an optimization or turns on automatic actuation.
 */
export function createPStudioPVCSCalibrationHarness(options = {}) {
  const runVariant = options.runVariant;
  if (typeof runVariant !== 'function') throw new TypeError('PVCS calibration requires runVariant(input).');
  const minSamples = harnessInteger(options.minSamples ?? 30, 'minSamples', 2, 1200);
  const maxSamples = harnessInteger(options.maxSamples ?? 120, 'maxSamples', minSamples, 1200);
  const maxTemporalFrames = harnessInteger(options.maxTemporalFrames ?? 8, 'maxTemporalFrames', 2, 16);
  const visualWidth = harnessInteger(options.visualWidth ?? 640, 'visualWidth', 32, 1024);
  const visualHeight = harnessInteger(options.visualHeight ?? 360, 'visualHeight', 18, 1024);
  const temporalWidth = harnessInteger(options.temporalWidth ?? 320, 'temporalWidth', 32, 1024);
  const temporalHeight = harnessInteger(options.temporalHeight ?? 180, 'temporalHeight', 18, 1024);
  const pixelThreshold = harnessFinite(options.pixelThreshold ?? 2, 'pixelThreshold');

  async function calibrate(input = {}) {
    const domain = String(input.domain || '');
    const descriptor = HARNESS_DOMAIN_METRICS[domain];
    if (!descriptor) throw new TypeError('Unsupported PVCS calibration domain: ' + domain);
    const sampleCount = harnessInteger(input.sampleCount ?? minSamples, 'sampleCount', minSamples, maxSamples);
    const warmupCount = harnessInteger(input.warmupCount ?? 5, 'warmupCount', 0, 120);
    const context = harnessNormalizeContext(input.context);
    const baselineProfile = harnessFreezeProfile(input.baselineProfile || {}, 'Baseline');
    const alternativeProfile = harnessFreezeProfile(input.alternativeProfile || {}, 'Alternative');
    const limits = input.limits || {};
    const visualLimits = Object.freeze({
      maxMeanAbsoluteError: harnessFinite(limits.maxMeanAbsoluteError, 'limits.maxMeanAbsoluteError'),
      maxChangedPixelRatio: harnessFinite(limits.maxChangedPixelRatio, 'limits.maxChangedPixelRatio'),
      maxTemporalError: harnessFinite(limits.maxTemporalError, 'limits.maxTemporalError')
    });
    if (visualLimits.maxMeanAbsoluteError > 1 || visualLimits.maxChangedPixelRatio > 1 || visualLimits.maxTemporalError > 1) {
      throw new RangeError('Visual acceptance limits must not exceed 1.0.');
    }
    const signal = input.signal || null;
    const baselineValues = [], alternativeValues = [];
    const baselineTemporal = [], alternativeTemporal = [];
    let worstMeanAbsoluteError = 0, worstChangedPixelRatio = 0;
    const temporalIndices = new Set();
    let sourceFrameWidth = null, sourceFrameHeight = null, sourceFrameChannels = null;
    let visualCaptureWidth = 0, visualCaptureHeight = 0;
    for (let index = 0; index < maxTemporalFrames; index += 1) {
      temporalIndices.add(Math.round(index * (sampleCount - 1) / (maxTemporalFrames - 1)));
    }

    async function capture(variant, profile, index, warmup) {
      harnessCheckAbort(signal);
      const result = await runVariant(Object.freeze({
        variant, profile, index, warmup, domain, metric: descriptor.key,
        context, signal
      }));
      harnessCheckAbort(signal);
      if (!result || typeof result !== 'object') throw new TypeError('runVariant must return a frame and explicit metrics.');
      const resultContext = harnessNormalizeContext(result.context);
      if (!harnessSameContext(resultContext, context)) throw new Error('Calibration render context changed during ' + variant + ' execution.');
      if (!warmup) {
        const value = harnessSampleMetric(result, descriptor.key, variant);
        const frame = harnessValidateByteFrame(result.frame);
        return { value, frame };
      }
      return true;
    }

    for (let index = 0; index < warmupCount; index += 1) {
      const order = index % 2 === 0 ? ['baseline', 'alternative'] : ['alternative', 'baseline'];
      for (const variant of order) {
        await capture(variant, variant === 'baseline' ? baselineProfile : alternativeProfile, index, true);
      }
    }

    for (let index = 0; index < sampleCount; index += 1) {
      const order = index % 2 === 0 ? ['baseline', 'alternative'] : ['alternative', 'baseline'];
      let baselineSample = null, alternativeSample = null;
      for (const variant of order) {
        const result = await capture(variant, variant === 'baseline' ? baselineProfile : alternativeProfile, index, false);
        if (variant === 'baseline') baselineSample = result;
        else alternativeSample = result;
      }
      const baselineFrame = baselineSample.frame, alternativeFrame = alternativeSample.frame;
      if (baselineFrame.width !== alternativeFrame.width || baselineFrame.height !== alternativeFrame.height || baselineFrame.channels !== alternativeFrame.channels) {
        throw new Error('Baseline and alternative captures must have identical source dimensions and channel counts.');
      }
      if (sourceFrameWidth === null) {
        sourceFrameWidth = baselineFrame.width; sourceFrameHeight = baselineFrame.height; sourceFrameChannels = baselineFrame.channels;
      } else if (sourceFrameWidth !== baselineFrame.width || sourceFrameHeight !== baselineFrame.height || sourceFrameChannels !== baselineFrame.channels) {
        throw new Error('Source capture dimensions changed during calibration.');
      }
      const baselineVisual = harnessCopySmallFrame(baselineFrame, visualWidth, visualHeight);
      const alternativeVisual = harnessCopySmallFrame(alternativeFrame, visualWidth, visualHeight);
      visualCaptureWidth = baselineVisual.width; visualCaptureHeight = baselineVisual.height;
      const visual = compareRgbaFrames(baselineVisual, alternativeVisual, { pixelThreshold });
      worstMeanAbsoluteError = Math.max(worstMeanAbsoluteError, visual.meanAbsoluteError);
      worstChangedPixelRatio = Math.max(worstChangedPixelRatio, visual.changedPixelRatio);
      baselineValues.push(baselineSample.value);
      alternativeValues.push(alternativeSample.value);
      if (temporalIndices.has(index)) {
        baselineTemporal.push(harnessCopySmallFrame(baselineSample.frame, temporalWidth, temporalHeight));
        alternativeTemporal.push(harnessCopySmallFrame(alternativeSample.frame, temporalWidth, temporalHeight));
      }
    }
    if (baselineTemporal.length < 2 || baselineTemporal.length !== alternativeTemporal.length) {
      throw new Error('Calibration did not retain enough aligned frames for temporal validation.');
    }
    const temporalResult = compareTemporalSequences(baselineTemporal, alternativeTemporal);
    const temporalError = temporalResult.meanAbsoluteTemporalDeltaError;
    const percentile95 = values => {
      const sorted = values.slice().sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
    };
    const baselineP95 = percentile95(baselineValues);
    const alternativeP95 = percentile95(alternativeValues);
    if (!(baselineP95 > 0)) throw new RangeError('Baseline P95 must be greater than zero to evaluate relative improvement.');
    if (worstMeanAbsoluteError > visualLimits.maxMeanAbsoluteError ||
        worstChangedPixelRatio > visualLimits.maxChangedPixelRatio ||
        temporalError > visualLimits.maxTemporalError) {
      throw new RangeError('Alternative failed the caller-specified visual or temporal acceptance limits.');
    }
    return Object.freeze({
      domain, metric: descriptor.key, unit: descriptor.unit, context,
      baseline: Object.freeze({ p95: baselineP95, sampleCount: baselineValues.length }),
      alternative: Object.freeze({ p95: alternativeP95, sampleCount: alternativeValues.length }),
      visual: Object.freeze({
        meanAbsoluteError: worstMeanAbsoluteError,
        changedPixelRatio: worstChangedPixelRatio,
        width: visualCaptureWidth,
        height: visualCaptureHeight,
        metric: 'pstudio.rgba-basic.v1',
        aggregation: 'worst-sample'
      }),
      temporal: Object.freeze({
        meanAbsoluteTemporalDeltaError: temporalError,
        frameCount: temporalResult.frameCount,
        captureWidth: baselineTemporal[0].width,
        captureHeight: baselineTemporal[0].height,
        metric: temporalResult.metric
      }),
      limits: visualLimits,
      sampling: Object.freeze({ warmupCount, sampleCount, order: 'paired-alternating', pixelThreshold, visualMaxWidth: visualWidth, visualMaxHeight: visualHeight, temporalMaxWidth: temporalWidth, temporalMaxHeight: temporalHeight })
    });
  }

  return Object.freeze({ calibrate, domains: Object.freeze(Object.keys(HARNESS_DOMAIN_METRICS)), getConfiguration: () => Object.freeze({ minSamples, maxSamples, maxTemporalFrames, visualWidth, visualHeight, temporalWidth, temporalHeight, pixelThreshold }) });
}
