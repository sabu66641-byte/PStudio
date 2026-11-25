const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gi = import('../static/pstudio_rendering_gi.mjs');

test('GI capture cadence and resolution are selected without loading a renderer', async () => {
  const module = await gi;
  assert.equal(module.dynamicProbeCaptureIntervalMs(5, true), 300);
  assert.equal(module.dynamicProbeCaptureIntervalMs(8, true), 550);
  assert.equal(module.dynamicProbeCaptureIntervalMs(11, true), 900);
  assert.equal(module.dynamicProbeCaptureIntervalMs(20, true), 1500);
  assert.equal(module.dynamicProbeCaptureIntervalMs(3, false), 450);
  assert.equal(module.dynamicProbeCaptureIntervalMs(6, false), 900);
  assert.equal(module.dynamicProbeCaptureIntervalMs(20, false), 1500);
  assert.equal(module.dynamicProbeCaptureResolution('ultra'), 192);
  assert.equal(module.dynamicProbeCaptureResolution('maximum'), 128);
  assert.equal(module.dynamicProbeCaptureResolution('high'), 96);
  assert.equal(module.dynamicProbeCaptureResolution('balanced'), 64);
});

test('dirty probe selection is deterministic, round-robin and bounded', async () => {
  const { nextDirtyProbeIndex } = await gi;
  const dirty = new Uint8Array([0, 1, 0, 1, 0]);
  assert.equal(nextDirtyProbeIndex(dirty, 0), 1);
  assert.equal(nextDirtyProbeIndex(dirty, 2), 3);
  assert.equal(nextDirtyProbeIndex(dirty, 4), 1);
  assert.equal(nextDirtyProbeIndex(new Uint8Array(4), 0), -1);
  assert.equal(nextDirtyProbeIndex(null, 0), -1);
});

test('light changes invalidate only probes inside the old/new influence regions', async () => {
  const { findChangedProbeIndices } = await gi;
  const probes = [
    { position: { x: 0, y: 0, z: 0 } },
    { position: { x: 2, y: 0, z: 0 } },
    { position: { x: 5, y: 0, z: 0 } },
    { position: { x: 10, y: 0, z: 0 } }
  ];
  const oldLights = [{ key: 'key', signature: 'a', position: [0, 0, 0], radius: 1 }];
  const newLights = [{ key: 'key', signature: 'b', position: [5, 0, 0], radius: 1 }];
  assert.deepEqual(findChangedProbeIndices(probes, oldLights, newLights, 0), [0, 2]);
  assert.deepEqual(findChangedProbeIndices(probes, oldLights, oldLights, 0), []);
  assert.deepEqual(findChangedProbeIndices(probes, [], [{ key: 'sun', signature: 'a', position: [0, 0, 0], radius: 0 }]), [0, 1, 2, 3]);
});

test('SH temporal blending converges smoothly and mutates the reusable buffer', async () => {
  const { blendSHCoefficients } = await gi;
  const current = new Float32Array(27);
  const incoming = new Float32Array(27).fill(1);
  const alpha = blendSHCoefficients(current, incoming, 240, 240);
  assert.ok(alpha > 0.45 && alpha < 0.55);
  assert.ok(current[0] > 0.49 && current[0] < 0.51);
  const before = current;
  blendSHCoefficients(current, incoming, 240, 240);
  assert.equal(current, before);
  assert.ok(current[0] > 0.74 && current[0] < 0.76);
  assert.equal(blendSHCoefficients(current, incoming, 0, 240), 0);
});

test('dynamic SH contributions fade out smoothly and retire below the residual threshold', async () => {
  const { decaySHCoefficients } = await gi;
  const coefficients = new Float32Array(27).fill(1);
  const first = decaySHCoefficients(coefficients, 320, 320, 1e-4);
  assert.equal(first.finished, false);
  assert.ok(coefficients[0] > 0.49 && coefficients[0] < 0.51);
  const second = decaySHCoefficients(coefficients, 8000, 320, 1e-4);
  assert.equal(second.finished, true);
  assert.equal(coefficients[0], 0);
});

test('GI module is wired into the shared runtime and dynamic probe capture path', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
  assert.match(html, /PStudioRenderingGIs*=s*await import\('\/static\/pstudio_rendering_gi\.mjs/);
  assert.match(engine, /findChangedProbeIndices/);
  assert.match(engine, /blendSHCoefficients/);
  assert.match(engine, /decaySHCoefficients/);
  assert.match(engine, /dynamicProbeSnapshots/);
});
