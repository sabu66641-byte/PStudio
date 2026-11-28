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
        frame: { width: 2, height: 2, channels: 4, data: rgba(variant === "baseline" ? index : index) }
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
