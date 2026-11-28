import { compareRgbaFrames, compareTemporalSequences } from './pstudio_visual_difference.mjs';

const DOMAIN_METRICS = Object.freeze({
  'cpu-frame': Object.freeze({ key: 'cpuFrameMs', unit: 'ms' }),
  'cpu-stage': Object.freeze({ key: 'cpuSubmitMs', unit: 'ms' }),
  'gpu-frame': Object.freeze({ key: 'gpuRenderMs', unit: 'ms' }),
  'gpu-stage': Object.freeze({ key: 'gpuStageMs', unit: 'ms' }),
  asynchronous: Object.freeze({ key: 'asyncElapsedMs', unit: 'ms' }),
  memory: Object.freeze({ key: 'memoryBytes', unit: 'bytes' })
});

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(label + ' must be a finite non-negative number.');
  return number;
}
function integer(value, label, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new RangeError(label + ' must be an integer between ' + min + ' and ' + max + '.');
  return number;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
  return result;
}
function normalizeContext(value) {
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
    for (const key of ['ao', 'ssr', 'volumetricClouds', 'volumetricFog', 'contactShadows']) {
      if (typeof value.effects[key] !== 'boolean') throw new TypeError('Render context effect ' + key + ' must be explicitly boolean when effects are supplied.');
      result.effects[key] = value.effects[key];
    }
  }
  return Object.freeze(canonical(result));
}
function freezeProfile(profile, label) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError(label + ' profile must be an object.');
  return Object.freeze({ ...profile });
}
function validateByteFrame(frame) {
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
function copySmallFrame(frame, maxWidth, maxHeight) {
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
function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('PVCS calibration was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
function sampleMetric(result, key, label) {
  const metrics = result?.metrics || result || {};
  return finite(metrics[key], label + '.' + key);
}
function sameContext(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Paired, alternating A/B calibration for PVCS. The caller owns the actual scene
 * execution and capture; this harness only accepts explicit measurements and pixels.
 * It never applies an optimization or turns on automatic actuation.
 */
export function createPStudioPVCSCalibrationHarness(options = {}) {
  const runVariant = options.runVariant;
  if (typeof runVariant !== 'function') throw new TypeError('PVCS calibration requires runVariant(input).');
  const minSamples = integer(options.minSamples ?? 30, 'minSamples', 2, 1200);
  const maxSamples = integer(options.maxSamples ?? 120, 'maxSamples', minSamples, 1200);
  const maxTemporalFrames = integer(options.maxTemporalFrames ?? 8, 'maxTemporalFrames', 2, 16);
  const visualWidth = integer(options.visualWidth ?? 640, 'visualWidth', 32, 1024);
  const visualHeight = integer(options.visualHeight ?? 360, 'visualHeight', 18, 1024);
  const temporalWidth = integer(options.temporalWidth ?? 320, 'temporalWidth', 32, 1024);
  const temporalHeight = integer(options.temporalHeight ?? 180, 'temporalHeight', 18, 1024);
  const pixelThreshold = finite(options.pixelThreshold ?? 2, 'pixelThreshold');

  async function calibrate(input = {}) {
    const domain = String(input.domain || '');
    const descriptor = DOMAIN_METRICS[domain];
    if (!descriptor) throw new TypeError('Unsupported PVCS calibration domain: ' + domain);
    const sampleCount = integer(input.sampleCount ?? minSamples, 'sampleCount', minSamples, maxSamples);
    const warmupCount = integer(input.warmupCount ?? 5, 'warmupCount', 0, 120);
    const context = normalizeContext(input.context);
    const baselineProfile = freezeProfile(input.baselineProfile || {}, 'Baseline');
    const alternativeProfile = freezeProfile(input.alternativeProfile || {}, 'Alternative');
    const limits = input.limits || {};
    const visualLimits = Object.freeze({
      maxMeanAbsoluteError: finite(limits.maxMeanAbsoluteError, 'limits.maxMeanAbsoluteError'),
      maxChangedPixelRatio: finite(limits.maxChangedPixelRatio, 'limits.maxChangedPixelRatio'),
      maxTemporalError: finite(limits.maxTemporalError, 'limits.maxTemporalError')
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
      checkAbort(signal);
      const result = await runVariant(Object.freeze({
        variant, profile, index, warmup, domain, metric: descriptor.key,
        context, signal
      }));
      checkAbort(signal);
      if (!result || typeof result !== 'object') throw new TypeError('runVariant must return a frame and explicit metrics.');
      const resultContext = normalizeContext(result.context);
      if (!sameContext(resultContext, context)) throw new Error('Calibration render context changed during ' + variant + ' execution.');
      if (!warmup) {
        const value = sampleMetric(result, descriptor.key, variant);
        const frame = validateByteFrame(result.frame);
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
      const baselineVisual = copySmallFrame(baselineFrame, visualWidth, visualHeight);
      const alternativeVisual = copySmallFrame(alternativeFrame, visualWidth, visualHeight);
      visualCaptureWidth = baselineVisual.width; visualCaptureHeight = baselineVisual.height;
      const visual = compareRgbaFrames(baselineVisual, alternativeVisual, { pixelThreshold });
      worstMeanAbsoluteError = Math.max(worstMeanAbsoluteError, visual.meanAbsoluteError);
      worstChangedPixelRatio = Math.max(worstChangedPixelRatio, visual.changedPixelRatio);
      baselineValues.push(baselineSample.value);
      alternativeValues.push(alternativeSample.value);
      if (temporalIndices.has(index)) {
        baselineTemporal.push(copySmallFrame(baselineSample.frame, temporalWidth, temporalHeight));
        alternativeTemporal.push(copySmallFrame(alternativeSample.frame, temporalWidth, temporalHeight));
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

  return Object.freeze({ calibrate, domains: Object.freeze(Object.keys(DOMAIN_METRICS)), getConfiguration: () => Object.freeze({ minSamples, maxSamples, maxTemporalFrames, visualWidth, visualHeight, temporalWidth, temporalHeight, pixelThreshold }) });
}
