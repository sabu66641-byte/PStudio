'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function modules() {
  const [{ createPStudioPVCS }, governor, budget] = await Promise.all([
    import('../static/pstudio_pvcs.mjs'),
    import('../static/pstudio_pvcs_governor.mjs'),
    Promise.resolve(require('../static/pstudio_rendering_budget.js'))
  ]);
  return { createPStudioPVCS, ...governor, budget };
}

function context(overrides = {}) {
  return {
    backend: 'webgl2',
    scene: 'pvcs-calibration-scene',
    quality: 'high',
    renderWidth: 1280,
    renderHeight: 720,
    renderPixelRatio: 1,
    effects: { ao: true, ssr: false, volumetricClouds: true },
    ...overrides
  };
}

function evidence(domain = 'cpu-frame', overrides = {}) {
  return {
    domain,
    context: context(),
    baseline: { p95: 22, sampleCount: 40 },
    alternative: { p95: 18, sampleCount: 40 },
    visual: { meanAbsoluteError: 0.004, changedPixelRatio: 0.012 },
    temporal: { meanAbsoluteTemporalDeltaError: 0.003, frameCount: 40 },
    limits: { maxMeanAbsoluteError: 0.01, maxChangedPixelRatio: 0.03, maxTemporalError: 0.01 },
    ...overrides
  };
}

function makePVCS(createPStudioPVCS, now = () => 100) {
  const renderer = {
    getPerformanceStats() {
      return {
        backend: 'webgl2', scene: 'pvcs-calibration-scene', quality: 'high',
        renderWidth: 1280, renderHeight: 720, renderPixelRatio: 1,
        renderEffects: { ao: true, ssr: false, volumetricClouds: true },
        cpuRenderSubmitMs: 5, frameIntervalMs: 22, estimatedGpuBytes: 1024
      };
    }
  };
  return createPStudioPVCS({ getRenderer: () => renderer, now });
}

test('PVCS governor does not produce proposals while analysis mode is disabled', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  const governor = pvcs.createGovernor();
  assert.equal(governor.evaluate().status, 'monitoring-disabled');
  assert.equal(governor.getState().automaticAllowed, false);
  assert.equal(governor.getState().automaticEnabled, false);
});

test('PVCS governor ranks candidates only within the same metric domain and exact render context', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  pvcs.setMonitoringEnabled(true);
  for (let i = 0; i < 40; i++) pvcs.recordFrameMetrics(22);
  const governor = pvcs.createGovernor({ minLiveSamples: 30, minEvidenceSamples: 30 });
  governor.registerCandidate({
    id: 'reduce-pass-resolution',
    stageId: 'frame-loop',
    domain: 'cpu-frame',
    triggerAbove: 20,
    action: { type: 'render-scale', scale: 0.92 },
    evidence: evidence(),
    priority: 2
  });
  const decision = governor.evaluate();
  assert.equal(decision.status, 'proposal-ready');
  assert.equal(decision.proposal.id, 'reduce-pass-resolution');
  assert.equal(decision.proposal.domain, 'cpu-frame');
  assert.equal(decision.proposal.currentP95, 22);
  assert.ok(decision.proposal.expectedSaving > 0);
  assert.equal(decision.proposal.context.scene, 'pvcs-calibration-scene');
});

test('PVCS governor never substitutes CPU timing for unavailable GPU timing', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  pvcs.setMonitoringEnabled(true);
  for (let i = 0; i < 40; i++) pvcs.recordFrameMetrics(22);
  const governor = pvcs.createGovernor({ minLiveSamples: 30 });
  governor.registerCandidate({
    id: 'gpu-resolution',
    stageId: 'frame-loop',
    domain: 'gpu-frame',
    triggerAbove: 1,
    action: { type: 'render-scale', scale: 0.9 },
    evidence: evidence('gpu-frame'),
    priority: 1
  });
  const decision = governor.evaluate();
  assert.equal(decision.proposal, null);
  assert.equal(decision.rejected[0].reason, 'live-domain-or-context-unavailable');
});

test('PVCS governor requires exact context and refuses stale calibration from another quality preset', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  pvcs.setMonitoringEnabled(true);
  for (let i = 0; i < 40; i++) pvcs.recordFrameMetrics(22);
  const governor = pvcs.createGovernor({ minLiveSamples: 30 });
  governor.registerCandidate({
    id: 'wrong-quality',
    stageId: 'frame-loop',
    domain: 'cpu-frame',
    triggerAbove: 20,
    action: { type: 'render-scale', scale: 0.92 },
    evidence: evidence('cpu-frame', { context: context({ quality: 'ultra' }) })
  });
  const decision = governor.evaluate();
  assert.equal(decision.proposal, null);
  assert.equal(decision.rejected[0].reason, 'live-domain-or-context-unavailable');
});

test('PVCS governor rejects insufficient A/B samples and unacceptable visual or temporal error', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  const governor = pvcs.createGovernor({ minEvidenceSamples: 30 });
  assert.throws(() => governor.registerCandidate({
    id: 'too-few-samples', stageId: 'frame-loop', domain: 'cpu-frame',
    triggerAbove: 10, action: { type: 'render-scale', scale: 0.9 },
    evidence: evidence('cpu-frame', { baseline: { p95: 22, sampleCount: 5 } })
  }), /enough samples/);
  assert.throws(() => governor.registerCandidate({
    id: 'visual-regression', stageId: 'frame-loop', domain: 'cpu-frame',
    triggerAbove: 10, action: { type: 'render-scale', scale: 0.9 },
    evidence: evidence('cpu-frame', { visual: { meanAbsoluteError: 0.2, changedPixelRatio: 0.4 } })
  }), /Visual or temporal/);
  assert.throws(() => governor.registerCandidate({
    id: 'no-performance-gain', stageId: 'frame-loop', domain: 'cpu-frame',
    triggerAbove: 10, action: { type: 'render-scale', scale: 0.9 },
    evidence: evidence('cpu-frame', { alternative: { p95: 22, sampleCount: 40 } })
  }), /minimum repeatable improvement/);
});

test('PVCS governor rejects disabling premium effects and invalid/unbounded action parameters', async () => {
  const { createPStudioPVCS } = await modules();
  const governor = makePVCS(createPStudioPVCS).createGovernor();
  const common = { stageId: 'frame-loop', domain: 'cpu-frame', triggerAbove: 10, evidence: evidence() };
  assert.throws(() => governor.registerCandidate({ ...common, id: 'disable-ssr', action: { type: 'disable-effect', effect: 'ssr' } }), /Unsupported compensation action/);
  assert.throws(() => governor.registerCandidate({ ...common, id: 'zero-scale', action: { type: 'render-scale', scale: 0 } }), /in range/);
  assert.throws(() => governor.registerCandidate({ ...common, id: 'negative-cadence', action: { type: 'gi-cadence', multiplier: -1 } }), /in range/);
});

test('PVCS governor applies a reversible transaction only through the explicit executor', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  pvcs.setMonitoringEnabled(true);
  for (let i = 0; i < 40; i++) pvcs.recordFrameMetrics(22);
  let applied = 0, rolledBack = 0, activeToken = null;
  const governor = pvcs.createGovernor({
    minLiveSamples: 30,
    executor: {
      async apply({ candidate }) {
        applied++;
        activeToken = { previous: 'baseline', action: candidate.action };
        return { applied: true, rollbackToken: activeToken };
      },
      async rollback({ rollbackToken }) {
        assert.equal(rollbackToken, activeToken);
        rolledBack++;
        activeToken = null;
        return true;
      }
    }
  });
  governor.registerCandidate({
    id: 'mirror-refresh', stageId: 'frame-loop', domain: 'cpu-frame', triggerAbove: 20,
    action: { type: 'mirror-schedule', intervalFrames: 2, resolutionScale: 0.9 },
    evidence: evidence()
  });
  const decision = governor.evaluate();
  assert.equal(decision.proposal.id, 'mirror-refresh');
  const appliedResult = await governor.applyProposal('mirror-refresh');
  assert.equal(appliedResult.applied, true);
  assert.equal(applied, 1);
  assert.equal(governor.getState().active.candidateId, 'mirror-refresh');
  const rollback = await governor.rollback('visual-regression');
  assert.equal(rollback.rolledBack, true);
  assert.equal(rolledBack, 1);
  assert.equal(governor.getState().active, null);
});

test('automatic actuation remains disabled unless explicitly enabled and confirmed with hysteresis', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  pvcs.setMonitoringEnabled(true);
  for (let i = 0; i < 40; i++) pvcs.recordFrameMetrics(22);
  let applies = 0, clock = 100000;
  const governor = pvcs.createGovernor({
    now: () => clock,
    minLiveSamples: 30,
    allowAutomaticActuation: true,
    automaticConfirmations: 3,
    automaticCooldownMs: 1000,
    executor: {
      async apply() { applies++; return { applied: true, rollbackToken: {} }; },
      async rollback() { return true; }
    }
  });
  governor.registerCandidate({
    id: 'auto-mirror', stageId: 'frame-loop', domain: 'cpu-frame', triggerAbove: 20,
    action: { type: 'mirror-schedule', intervalFrames: 2, resolutionScale: 0.9 },
    evidence: evidence(), automaticEligible: true
  });
  assert.equal(governor.getState().automaticEnabled, false);
  assert.equal((await governor.tick()).automaticApplied, false);
  assert.equal(applies, 0);
  governor.setAutomaticEnabled(true);
  assert.equal((await governor.tick()).automaticApplied, false);
  assert.equal((await governor.tick()).automaticApplied, false);
  assert.equal((await governor.tick()).automaticApplied, true);
  assert.equal(applies, 1);
});

test('frame-budget executor delegates only reversible overlay actions to PStudio3D', async () => {
  const { createPStudioPVCSFrameBudgetExecutor } = await modules();
  let restored = 0;
  const renderer = {
    applyPVCSFrameBudgetOverride(profile) {
      return { applied: true, rollbackToken: { profile } };
    },
    rollbackPVCSFrameBudgetOverride(token) {
      assert.deepEqual(token.profile, { scale: 0.9, giCadenceMultiplier: 2 });
      restored++;
      return true;
    }
  };
  const executor = createPStudioPVCSFrameBudgetExecutor({ getRenderer: () => renderer });
  const result = await executor.apply({ candidate: { action: { type: 'frame-budget', profile: { scale: 0.9, giCadenceMultiplier: 2 } } } });
  assert.equal(result.applied, true);
  assert.equal(await executor.rollback({ rollbackToken: result.rollbackToken }), true);
  assert.equal(restored, 1);
});


test('PVCS governor serializes concurrent apply and rollback operations', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  pvcs.setMonitoringEnabled(true);
  for (let i = 0; i < 40; i++) pvcs.recordFrameMetrics(22);
  let releaseApply;
  let applyStarted;
  const started = new Promise(resolve => { applyStarted = resolve; });
  const governor = pvcs.createGovernor({
    minLiveSamples: 30,
    executor: {
      apply: async () => {
        applyStarted();
        return await new Promise(resolve => { releaseApply = resolve; });
      },
      async rollback() { return true; }
    }
  });
  governor.registerCandidate({
    id: 'serial-apply', stageId: 'frame-loop', domain: 'cpu-frame', triggerAbove: 20,
    action: { type: 'render-scale', scale: 0.9 }, evidence: evidence()
  });
  const first = governor.applyProposal('serial-apply');
  await started;
  assert.equal(governor.getState().inFlight, true);
  await assert.rejects(governor.applyProposal('serial-apply'), /transaction is already active/);
  assert.equal((await governor.tick()).automaticReason, 'transaction-in-progress');
  assert.throws(() => governor.registerCandidate({}), /registry is locked/);
  assert.throws(() => governor.unregisterCandidate('serial-apply'), /registry is locked/);
  releaseApply({ applied: true, rollbackToken: { id: 'one' } });
  await first;
  assert.equal(governor.getState().inFlight, false);
  await governor.rollback('test-complete');
  assert.equal(governor.getState().active, null);
});


test('PVCS governor automatically rolls back when context changes during an awaited apply', async () => {
  const { createPStudioPVCS } = await modules();
  const pvcs = makePVCS(createPStudioPVCS);
  pvcs.setMonitoringEnabled(true);
  for (let i = 0; i < 40; i++) pvcs.recordFrameMetrics(22);
  let rollbacks = 0;
  const governor = pvcs.createGovernor({
    minLiveSamples: 30,
    executor: {
      async apply() {
        pvcs.setMonitoringEnabled(false);
        return { applied: true, rollbackToken: { id: 'stale' } };
      },
      async rollback({ rollbackToken }) {
        assert.equal(rollbackToken.id, 'stale');
        rollbacks++;
        return true;
      }
    }
  });
  governor.registerCandidate({
    id: 'stale-context', stageId: 'frame-loop', domain: 'cpu-frame', triggerAbove: 20,
    action: { type: 'render-scale', scale: 0.9 }, evidence: evidence()
  });
  await assert.rejects(governor.applyProposal('stale-context'), /became stale during apply/);
  assert.equal(rollbacks, 1);
  assert.equal(governor.getState().active, null);
  assert.equal(governor.getState().applyCount, 0);
  assert.equal(governor.getState().rollbackCount, 1);
});
