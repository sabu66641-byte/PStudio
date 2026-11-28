const finite = (value, label, minimum = 0) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new RangeError(label + " must be finite and >= " + minimum + ".");
  return number;
};
const positiveInteger = (value, fallback, maximum, label) => {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new RangeError(label + " must be a positive integer <= " + maximum + ".");
  return number;
};
function canonical(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonical(value[key]);
  return output;
}
function contextKey(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Renderer parity requires a stable render context.");
  for (const key of ["scene", "quality", "renderWidth", "renderHeight", "renderPixelRatio", "effects"]) {
    if (input[key] == null) throw new TypeError("Renderer parity context must include " + key + ".");
  }
  if (!Number.isFinite(Number(input.renderWidth)) || Number(input.renderWidth) < 1 ||
      !Number.isFinite(Number(input.renderHeight)) || Number(input.renderHeight) < 1 ||
      !Number.isFinite(Number(input.renderPixelRatio)) || Number(input.renderPixelRatio) <= 0) {
    throw new TypeError("Renderer parity context requires positive render dimensions and pixel ratio.");
  }
  return JSON.stringify(canonical({
    backend: "renderer-parity",
    scene: input.scene, quality: input.quality,
    renderWidth: Number(input.renderWidth), renderHeight: Number(input.renderHeight),
    renderPixelRatio: Number(input.renderPixelRatio), effects: input.effects
  }));
}
function sceneFingerprint(scene) {
  let hash = 2166136261;
  const update = value => {
    const text = typeof value === "string" ? value : JSON.stringify(canonical(value));
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  };
  update([scene.id, scene.revision, scene.geometries.length, scene.materials.length, scene.textures.length, scene.entities.length]);
  for (const geometry of scene.geometries) {
    update([geometry.id, geometry.revision]);
    for (const name of ["positions", "normals", "uvs", "uv2s", "tangents", "indices", "jointIndices", "jointWeights"]) {
      if (geometry[name]) update(geometry[name]);
    }
    for (const target of geometry.morphTargets || []) {
      if (target.positions) update(target.positions);
      if (target.normals) update(target.normals);
    }
  }
  for (const texture of scene.textures) update([texture.id, texture.revision, texture.data]);
  for (const material of scene.materials) update(material);
  for (const entity of scene.entities) update(entity);
  for (const node of scene.nodes || []) update(node);
  return hash.toString(16).padStart(8, "0");
}
function validateFrame(frame, label) {
  if (!frame || !Number.isSafeInteger(frame.width) || frame.width < 1 ||
      !Number.isSafeInteger(frame.height) || frame.height < 1 ||
      (frame.channels ?? 4) !== 4 || !(frame.data instanceof Uint8Array) ||
      frame.data.length !== frame.width * frame.height * 4) {
    throw new TypeError(label + " must provide an owned RGBA8 frame with width × height × 4 bytes.");
  }
  return Object.freeze({
    frameKey: String(frame.frameKey ?? ""),
    width: frame.width, height: frame.height, channels: 4,
    data: new Uint8Array(frame.data)
  });
}
function p95(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}
function frameDifference(left, right) {
  if (left.width !== right.width || left.height !== right.height) throw new Error("Renderer parity frame dimensions changed between variants.");
  let total = 0, changed = 0, pixels = left.width * left.height;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    let pixelDifference = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const index = pixel * 4 + channel;
      pixelDifference += Math.abs(left.data[index] - right.data[index]) / 255;
    }
    total += pixelDifference / 4;
    if (pixelDifference / 4 > 1 / 255) changed += 1;
  }
  return Object.freeze({ meanAbsoluteError: total / pixels, changedPixelRatio: changed / pixels });
}
function temporalDifference(framesA, framesB) {
  if (framesA.length < 2 || framesB.length !== framesA.length) return null;
  let total = 0, count = 0;
  for (let frame = 1; frame < framesA.length; frame += 1) {
    const previousA = framesA[frame - 1], currentA = framesA[frame];
    const previousB = framesB[frame - 1], currentB = framesB[frame];
    if (currentA.width !== currentB.width || currentA.height !== currentB.height ||
        previousA.width !== currentA.width || previousA.height !== currentA.height) {
      throw new Error("Renderer parity temporal sequence changed image dimensions.");
    }
    for (let index = 0; index < currentA.data.length; index += 1) {
      const deltaA = Math.abs(currentA.data[index] - previousA.data[index]) / 255;
      const deltaB = Math.abs(currentB.data[index] - previousB.data[index]) / 255;
      total += Math.abs(deltaA - deltaB);
      count += 1;
    }
  }
  return Object.freeze({ meanAbsoluteTemporalDeltaError: count ? total / count : null, frameCount: framesA.length });
}

/**
 * Same-scene renderer A/B runner.
 *
 * The caller must supply the actual renderer selector and frame capture. Captures must
 * come from a browser/GPU runtime and include real CPU timings, fresh GPU timer queries
 * where available, estimated GPU bytes, and a read-back RGBA8 image. Missing metrics
 * remain null/unavailable; this module never synthesizes timing or memory samples.
 */
export function createPStudioRendererParityRunner(options = {}) {
  const sceneAsset = options.sceneAsset;
  if (sceneAsset?.kind !== "pstudio-graphics-scene-asset") throw new TypeError("Renderer parity requires a PStudio-owned scene asset.");
  if (typeof options.readContext !== "function" || typeof options.selectRenderer !== "function" ||
      typeof options.capture !== "function" || typeof options.restore !== "function") {
    throw new TypeError("Renderer parity requires readContext, selectRenderer, capture and restore callbacks.");
  }
  const sampleCount = positiveInteger(options.sampleCount, 30, 512, "sampleCount");
  const warmupCount = options.warmupCount == null ? 3 : Number(options.warmupCount);
  if (!Number.isSafeInteger(warmupCount) || warmupCount < 0 || warmupCount > 120) throw new RangeError("warmupCount must be between 0 and 120.");
  const visualSampleCount = Math.min(sampleCount, positiveInteger(options.visualSampleCount, 8, 512, "visualSampleCount"));
  const minimumSamples = Math.min(sampleCount, positiveInteger(options.minimumSamples, 20, 512, "minimumSamples"));
  let running = false;
  let completedRuns = 0;

  async function run(runOptions = {}) {
    if (running) throw new Error("A renderer parity run is already active.");
    running = true;
    const signal = runOptions.signal || options.signal || null;
    const abort = () => {
      if (signal?.aborted) {
        const error = new Error("Renderer parity run was cancelled.");
        error.name = "AbortError";
        throw error;
      }
    };
    const fingerprint = sceneFingerprint(sceneAsset);
    const initialContext = contextKey(await options.readContext());
    const metrics = {
      baseline: { cpu: [], gpu: [], memory: [] },
      alternative: { cpu: [], gpu: [], memory: [] }
    };
    const frames = { baseline: [], alternative: [] };
    const unavailable = new Set();
    let restored = false;
    const assertContext = async () => {
      const current = contextKey(await options.readContext());
      if (current !== initialContext) throw new Error("Renderer parity context changed; samples were discarded.");
      if (sceneFingerprint(sceneAsset) !== fingerprint) throw new Error("Renderer parity scene asset was mutated during capture.");
    };
    async function captureVariant(variant, index, warmup) {
      abort();
      await options.selectRenderer(variant, Object.freeze({ index, warmup, sceneAsset, signal }));
      await assertContext();
      const result = await options.capture(Object.freeze({
        variant, index, warmup, sceneAsset,
        context: Object.freeze({
          sceneId: sceneAsset.id, sceneRevision: sceneAsset.revision,
          sceneFingerprint: fingerprint, parityContext: initialContext
        }),
        signal
      }));
      await assertContext();
      if (!result || typeof result !== "object" || !result.metrics) throw new TypeError("Renderer capture must return metrics and an RGBA8 frame.");
      if (result.sceneFingerprint != null && String(result.sceneFingerprint) !== fingerprint) {
        throw new Error("Renderer capture reports a different scene asset fingerprint.");
      }
      const frame = validateFrame(result.frame, variant + " frame");
      if (!frame.frameKey) throw new TypeError("Renderer captures must include a deterministic frameKey for baseline/alternative pairing.");
      return { frame, metrics: result.metrics };
    }
    try {
      // Warmup is paired under exactly the same immutable scene and render context.
      for (let i = 0; i < warmupCount; i += 1) {
        await captureVariant("baseline", i, true);
        await captureVariant("alternative", i, true);
      }
      for (let i = 0; i < sampleCount; i += 1) {
        const baseline = await captureVariant("baseline", i, false);
        const alternative = await captureVariant("alternative", i, false);
        if (baseline.frame.frameKey !== alternative.frame.frameKey) {
          throw new Error("Baseline and alternative captures do not represent the same scene frame/time.");
        }
        if (baseline.frame.width !== alternative.frame.width || baseline.frame.height !== alternative.frame.height) {
          throw new Error("Baseline and alternative captures have different image dimensions.");
        }
        for (const [variant, sample] of [["baseline", baseline], ["alternative", alternative]]) {
          const metric = sample.metrics;
          for (const [name, key] of [["cpu", "cpuFrameMs"], ["gpu", "gpuRenderMs"], ["memory", "estimatedGpuBytes"]]) {
            const value = metric[key];
            if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) {
              unavailable.add(name);
            } else if (name !== "gpu" || metric.gpuTimingFresh === true) {
              metrics[variant][name].push(Number(value));
            } else {
              unavailable.add(name);
            }
          }
          if (i < visualSampleCount) frames[variant].push(sample.frame);
        }
      }
      const performance = {};
      for (const name of ["cpu", "gpu", "memory"]) {
        const baseline = metrics.baseline[name], alternative = metrics.alternative[name];
        const available = baseline.length >= minimumSamples && alternative.length >= minimumSamples;
        performance[name] = Object.freeze({
          status: available ? "measured" : "unavailable",
          baselineP95: available ? p95(baseline) : null,
          alternativeP95: available ? p95(alternative) : null,
          baselineSampleCount: baseline.length,
          alternativeSampleCount: alternative.length,
          improvementRatio: available && p95(baseline) > 0
            ? (p95(baseline) - p95(alternative)) / p95(baseline) : null
        });
      }
      const visual = frames.baseline.map((frame, index) => frameDifference(frame, frames.alternative[index]));
      const temporal = temporalDifference(frames.baseline, frames.alternative);
      completedRuns += 1;
      return Object.freeze({
        status: "compared",
        scene: Object.freeze({ id: sceneAsset.id, revision: sceneAsset.revision, fingerprint }),
        context: initialContext,
        performance: Object.freeze(performance),
        visual: Object.freeze({
          meanAbsoluteError: visual.length ? visual.reduce((sum, value) => sum + value.meanAbsoluteError, 0) / visual.length : null,
          changedPixelRatio: visual.length ? visual.reduce((sum, value) => sum + value.changedPixelRatio, 0) / visual.length : null,
          sampleCount: visual.length
        }),
        temporal: temporal || Object.freeze({ meanAbsoluteTemporalDeltaError: null, frameCount: 0 }),
        unavailableMetrics: Object.freeze([...unavailable].sort()),
        sampleCount, visualSampleCount, warmupCount
      });
    } finally {
      try { await options.restore(); restored = true; }
      finally { running = false; }
    }
  }
  return Object.freeze({
    kind: "pstudio-renderer-parity-runner",
    run,
    getState: () => Object.freeze({ running, completedRuns })
  });
}
