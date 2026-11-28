const test = require("node:test");
const assert = require("node:assert/strict");
const { createPStudioPVCSCalibrationRunner } = require("../static/pstudio_pvcs_calibration.mjs");

const context = Object.freeze({
  backend: "webgl2", scene: "calibration.scene", quality: "high",
  renderWidth: 640, renderHeight: 360, renderPixelRatio: 1,
  effects: { ao: true, ssr: false }
});
const limits = { maxMeanAbsoluteError: 0.02, maxChangedPixelRatio: 0.05, maxTemporalError: 0.02 };
function rgba(value) {
  return new Uint8Array([value, value, value, 255, value, value, value, 255, value, value, value, 255, value, value, value, 255]);
}

test("PVCS calibration produces A/B P95, visual and temporal evidence from injected captures", async () => {
  let variant = "baseline", captures = 0, restored = 0;
  const runner = createPStudioPVCSCalibrationRunner({
    domain: "cpu-frame", sampleCount: 8, minSamples: 8, warmupCount: 2, visualSampleCount: 4,
    limits, readContext: () => context,
    applyVariant: value => { variant = value; },
    capture: () => {
      const index = captures++;
      return {
        metrics: { cpuFrameMs: variant === "baseline" ? 20 + index % 3 : 15 + index % 3 },
        frame: { width: 2, height: 2, channels: 4, data: rgba(42) }
      };
    },
    restore: () => { restored++; }
  });
  const result = await runner.run();
  assert.equal(result.status, "calibrated");
  assert.equal(result.evidence.domain, "cpu-frame");
  assert.ok(result.evidence.baseline.p95 > result.evidence.alternative.p95);
  assert.equal(result.evidence.baseline.sampleCount, 8);
  assert.equal(result.evidence.visual.sampleCount, 4);
  assert.equal(result.evidence.temporal.frameCount, 4);
  assert.equal(result.evidence.visual.meanAbsoluteError, 0);
  assert.equal(restored, 1);
  assert.equal(runner.getState().running, false);
});

test("PVCS calibration never substitutes CPU data when GPU metrics are unavailable", async () => {
  let restored = 0;
  const runner = createPStudioPVCSCalibrationRunner({
    domain: "gpu-frame", sampleCount: 2, minSamples: 2, visualSampleCount: 2, limits,
    readContext: () => context, applyVariant: () => {},
    capture: () => ({ metrics: { cpuFrameMs: 16 }, frame: { width: 2, height: 2, data: rgba(0) } }),
    restore: () => { restored++; }
  });
  await assert.rejects(runner.run(), /gpuFrameMs/);
  assert.equal(restored, 1);
});

test("PVCS calibration discards a run when render context drifts and always restores state", async () => {
  let reads = 0, restored = 0;
  const runner = createPStudioPVCSCalibrationRunner({
    domain: "cpu-frame", sampleCount: 2, minSamples: 2, visualSampleCount: 2, limits,
    readContext: () => ++reads < 4 ? context : { ...context, quality: "ultra" },
    applyVariant: () => {},
    capture: () => ({ metrics: { cpuFrameMs: 12 }, frame: { width: 2, height: 2, data: rgba(0) } }),
    restore: () => { restored++; }
  });
  await assert.rejects(runner.run(), /context changed/);
  assert.equal(restored, 1);
  assert.equal(runner.getState().running, false);
});


const CONTEXT = Object.freeze({
  backend: 'webgpu',
  scene: 'pvcs-calibration-scene',
  quality: 'high',
  renderWidth: 640,
  renderHeight: 360,
  renderPixelRatio: 1,
  effects: { volumetricClouds: true }
});
function frame(index, offset = 0) {
  const data = new Uint8Array(4 * 4 * 4);
  for (let pixel = 0; pixel < 16; pixel += 1) {
    data[pixel * 4] = 80 + index + offset;
    data[pixel * 4 + 1] = 100 + index + offset;
    data[pixel * 4 + 2] = 120 + index + offset;
    data[pixel * 4 + 3] = 255;
  }
  return { width: 4, height: 4, data };
}
function harnessLimits() {
  return { maxMeanAbsoluteError: 0.01, maxChangedPixelRatio: 0.02, maxTemporalError: 0.01 };
}

test('PVCS paired calibration emits governor-compatible evidence with alternating samples', async () => {
  const { createPStudioPVCS } = await import('../static/pstudio_pvcs.mjs');
  const pvcs = createPStudioPVCS();
  const order = [];
  const harness = pvcs.createCalibrationHarness({
    minSamples: 30, maxSamples: 32, maxTemporalFrames: 4, temporalWidth: 32, temporalHeight: 18,
    runVariant: async input => {
      order.push(input.variant + ':' + input.index);
      return {
        context: CONTEXT,
        metrics: { cpuFrameMs: input.variant === 'baseline' ? 20 + input.index * 0.01 : 16 + input.index * 0.01 },
        frame: frame(input.index)
      };
    }
  });
  const evidence = await harness.calibrate({
    domain: 'cpu-frame', sampleCount: 30, warmupCount: 0, context: CONTEXT,
    baselineProfile: { resolutionScale: 1 }, alternativeProfile: { resolutionScale: 0.9 }, limits: harnessLimits()
  });
  assert.deepEqual(order.slice(0, 6), ['baseline:0', 'alternative:0', 'alternative:1', 'baseline:1', 'baseline:2', 'alternative:2']);
  assert.deepEqual(order.slice(-4), ['baseline:28', 'alternative:28', 'alternative:29', 'baseline:29']);
  assert.equal(evidence.domain, 'cpu-frame');
  assert.equal(evidence.metric, 'cpuFrameMs');
  assert.equal(evidence.baseline.sampleCount, 30);
  assert.equal(evidence.alternative.sampleCount, 30);
  assert.ok(evidence.baseline.p95 > evidence.alternative.p95);
  assert.equal(evidence.visual.meanAbsoluteError, 0);
  assert.equal(evidence.visual.changedPixelRatio, 0);
  assert.equal(evidence.temporal.meanAbsoluteTemporalDeltaError, 0);
  assert.equal(evidence.temporal.frameCount, 4);
  assert.equal(evidence.sampling.order, 'paired-alternating');
  const governor = pvcs.createGovernor();
  const candidate = governor.registerCandidate({
    id: 'calibrated.cpu-frame', stageId: 'frame-loop', domain: 'cpu-frame', triggerAbove: 0.001,
    action: { type: 'render-scale', scale: 0.9 }, evidence
  });
  assert.equal(candidate.id, 'calibrated.cpu-frame');
  assert.equal(candidate.evidence.baselineSamples, 30);
  pvcs.setMonitoringEnabled(false);
});

test('PVCS calibration never substitutes CPU measurements for a missing GPU metric', async () => {
  const { createPStudioPVCS } = await import('../static/pstudio_pvcs.mjs');
  const harness = createPStudioPVCS().createCalibrationHarness({
    minSamples: 2, maxSamples: 2, maxTemporalFrames: 2,
    runVariant: async input => ({
      context: CONTEXT, metrics: { cpuFrameMs: 20 }, frame: frame(input.index)
    })
  });
  await assert.rejects(harness.calibrate({
    domain: 'gpu-frame', sampleCount: 2, warmupCount: 0, context: CONTEXT,
    baselineProfile: {}, alternativeProfile: {}, limits: harnessLimits()
  }), /gpuRenderMs/);
});

test('PVCS calibration rejects render-context drift between variants', async () => {
  const { createPStudioPVCS } = await import('../static/pstudio_pvcs.mjs');
  const harness = createPStudioPVCS().createCalibrationHarness({
    minSamples: 2, maxSamples: 2, maxTemporalFrames: 2,
    runVariant: async input => ({
      context: input.variant === 'alternative' ? { ...CONTEXT, renderWidth: 320 } : CONTEXT,
      metrics: { cpuFrameMs: 20 }, frame: frame(input.index)
    })
  });
  await assert.rejects(harness.calibrate({
    domain: 'cpu-frame', sampleCount: 2, warmupCount: 0, context: CONTEXT,
    baselineProfile: {}, alternativeProfile: {}, limits: harnessLimits()
  }), /context changed/);
});

test('PVCS calibration rejects alternatives outside visual acceptance limits', async () => {
  const { createPStudioPVCS } = await import('../static/pstudio_pvcs.mjs');
  const harness = createPStudioPVCS().createCalibrationHarness({
    minSamples: 2, maxSamples: 2, maxTemporalFrames: 2,
    runVariant: async input => ({
      context: CONTEXT,
      metrics: { cpuFrameMs: input.variant === 'baseline' ? 20 : 16 },
      frame: frame(input.index, input.variant === 'alternative' ? 40 : 0)
    })
  });
  await assert.rejects(harness.calibrate({
    domain: 'cpu-frame', sampleCount: 2, warmupCount: 0, context: CONTEXT,
    baselineProfile: {}, alternativeProfile: {},
    limits: { maxMeanAbsoluteError: 0.001, maxChangedPixelRatio: 0.001, maxTemporalError: 0.001 }
  }), /visual or temporal acceptance limits/);
});

test('PVCS calibration requires explicit acceptance limits and bounded sample counts', async () => {
  const { createPStudioPVCS } = await import('../static/pstudio_pvcs.mjs');
  const harness = createPStudioPVCS().createCalibrationHarness({
    minSamples: 2, maxSamples: 4, maxTemporalFrames: 2,
    runVariant: async input => ({ context: CONTEXT, metrics: { cpuFrameMs: 20 }, frame: frame(input.index) })
  });
  await assert.rejects(harness.calibrate({
    domain: 'cpu-frame', sampleCount: 5, context: CONTEXT,
    baselineProfile: {}, alternativeProfile: {}, limits: harnessLimits()
  }), /sampleCount/);
  await assert.rejects(harness.calibrate({
    domain: 'cpu-frame', sampleCount: 2, context: CONTEXT,
    baselineProfile: {}, alternativeProfile: {}
  }), /limits.maxMeanAbsoluteError/);
});
