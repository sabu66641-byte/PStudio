const DOMAIN = Object.freeze({
  "cpu-frame": Object.freeze({ ranking: "cpuFrame", metric: "cpuFrameP95Ms", unit: "ms", requiredStage: "frame-loop" }),
  "cpu-stage": Object.freeze({ ranking: "cpuStages", metric: "cpuSubmitP95Ms", unit: "ms" }),
  "gpu-frame": Object.freeze({ ranking: "gpuFrame", metric: "gpuRenderP95Ms", unit: "ms", requiredStage: "frame-loop" }),
  "gpu-stage": Object.freeze({ ranking: "gpuStages", metric: "gpuStageP95Ms", unit: "ms" }),
  asynchronous: Object.freeze({ ranking: "asynchronous", metric: "asyncElapsedP95Ms", unit: "ms" }),
  memory: Object.freeze({ ranking: "memory", metric: "memoryP95Bytes", unit: "bytes" })
});

const ID = /^[a-z][a-z0-9._-]{0,63}$/;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function finite(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new RangeError(label + " must be finite and in range.");
  return number;
}
function positiveInteger(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new RangeError(label + " must be a safe integer in range.");
  return number;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
  return result;
}
function contextKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Calibration requires a full PVCS render context.");
  const allowed = ["backend", "scene", "quality", "renderWidth", "renderHeight", "renderPixelRatio", "effects"];
  const context = {};
  for (const key of allowed) {
    if (value[key] !== undefined && value[key] !== null) context[key] = value[key];
  }
  for (const key of ["backend", "scene", "quality"]) {
    if (typeof context[key] !== "string" || !context[key].length) throw new TypeError("PVCS context must include " + key + ".");
  }
  for (const key of ["renderWidth", "renderHeight", "renderPixelRatio"]) {
    if (!Number.isFinite(Number(context[key])) || Number(context[key]) <= 0) throw new TypeError("PVCS context must include positive " + key + ".");
    context[key] = Number(context[key]);
  }
  if (context.effects && typeof context.effects !== "object") throw new TypeError("PVCS effects context must be an object.");
  return JSON.stringify(canonical(context));
}
function parseAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new TypeError("A reversible compensation action is required.");
  const type = String(action.type || "");
  switch (type) {
    case "render-scale":
      return Object.freeze({ type, scale: finite(action.scale, "scale", 0.65, 1) });
    case "mirror-schedule":
      return Object.freeze({
        type,
        intervalFrames: positiveInteger(action.intervalFrames, "intervalFrames", 1, 60),
        resolutionScale: finite(action.resolutionScale, "resolutionScale", 0.5, 1)
      });
    case "gi-cadence":
      return Object.freeze({ type, multiplier: finite(action.multiplier, "multiplier", 1, 16) });
    case "pass-resolution":
      if (!ID.test(String(action.passId || ""))) throw new TypeError("passId must be a stable PStudio identifier.");
      return Object.freeze({ type, passId: String(action.passId), scale: finite(action.scale, "scale", 0.5, 1) });
    case "pass-samples":
      if (!ID.test(String(action.passId || ""))) throw new TypeError("passId must be a stable PStudio identifier.");
      return Object.freeze({ type, passId: String(action.passId), sampleScale: finite(action.sampleScale, "sampleScale", 0.5, 1) });
    case "cache-reuse":
      if (!ID.test(String(action.cacheId || ""))) throw new TypeError("cacheId must be a stable PStudio identifier.");
      return Object.freeze({ type, cacheId: String(action.cacheId), maxAgeFrames: positiveInteger(action.maxAgeFrames, "maxAgeFrames", 1, 120) });
    case "frame-budget": {
      const profile = action.profile || {};
      const allowed = ["scale", "mirrorIntervalFrames", "mirrorResolutionScale", "giCadenceMultiplier", "cloudStepScale", "fogStepScale", "contactShadowStepScale"];
      const result = {};
      for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(profile, key)) continue;
        if (key === "mirrorIntervalFrames") result[key] = positiveInteger(profile[key], key, 1, 60);
        else if (key === "giCadenceMultiplier") result[key] = finite(profile[key], key, 1, 16);
        else if (key === "scale") result[key] = finite(profile[key], key, 0.65, 1);
        else result[key] = finite(profile[key], key, 0.5, 1);
      }
      if (!Object.keys(result).length) throw new TypeError("frame-budget action must contain at least one bounded control.");
      return Object.freeze({ type, profile: Object.freeze(result) });
    }
    default:
      throw new TypeError("Unsupported compensation action. Quality/effect disabling is never an eligible action.");
  }
}
function readEvidence(input, minSamples, minImprovementRatio) {
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== "object") throw new TypeError("Measured A/B evidence is required.");
  const key = contextKey(evidence.context);
  const baseline = evidence.baseline || {};
  const alternative = evidence.alternative || {};
  const baselineP95 = finite(baseline.p95, "baseline.p95", 0.000001);
  const alternativeP95 = finite(alternative.p95, "alternative.p95", 0);
  const baselineSamples = positiveInteger(baseline.sampleCount, "baseline.sampleCount");
  const alternativeSamples = positiveInteger(alternative.sampleCount, "alternative.sampleCount");
  if (baselineSamples < minSamples || alternativeSamples < minSamples) throw new RangeError("A/B evidence does not contain enough samples.");
  const improvementRatio = (baselineP95 - alternativeP95) / baselineP95;
  if (improvementRatio < minImprovementRatio) throw new RangeError("A/B evidence does not prove the minimum repeatable improvement.");
  const visual = evidence.visual || {};
  const temporal = evidence.temporal || {};
  const limits = evidence.limits || {};
  const meanAbsoluteError = finite(visual.meanAbsoluteError, "visual.meanAbsoluteError", 0, 1);
  const changedPixelRatio = finite(visual.changedPixelRatio, "visual.changedPixelRatio", 0, 1);
  const temporalError = finite(temporal.meanAbsoluteTemporalDeltaError, "temporal.meanAbsoluteTemporalDeltaError", 0, 1);
  const temporalFrameCount = positiveInteger(temporal.frameCount, "temporal.frameCount", 2, 10000);
  const maxMeanAbsoluteError = finite(limits.maxMeanAbsoluteError, "limits.maxMeanAbsoluteError", 0, 1);
  const maxChangedPixelRatio = finite(limits.maxChangedPixelRatio, "limits.maxChangedPixelRatio", 0, 1);
  const maxTemporalError = finite(limits.maxTemporalError, "limits.maxTemporalError", 0, 1);
  if (meanAbsoluteError > maxMeanAbsoluteError || changedPixelRatio > maxChangedPixelRatio || temporalError > maxTemporalError) {
    throw new RangeError("Visual or temporal evidence exceeds its explicitly configured acceptance limits.");
  }
  return Object.freeze({
    context: key,
    baselineP95, alternativeP95, baselineSamples, alternativeSamples,
    improvementRatio, saving: baselineP95 - alternativeP95,
    visual: Object.freeze({ meanAbsoluteError, changedPixelRatio }),
    temporal: Object.freeze({ meanAbsoluteTemporalDeltaError: temporalError, frameCount: temporalFrameCount }),
    limits: Object.freeze({ maxMeanAbsoluteError, maxChangedPixelRatio, maxTemporalError })
  });
}

export function createPStudioPVCSGovernor(options = {}) {
  const pvcs = options.pvcs;
  if (!pvcs || typeof pvcs.isMonitoringEnabled !== "function" || typeof pvcs.analyze !== "function" || !pvcs.graph?.snapshot) {
    throw new TypeError("PVCS Governor requires a live PStudio PVCS instance.");
  }
  const executor = options.executor || null;
  const now = typeof options.now === "function" ? options.now : () => globalThis.performance?.now?.() ?? Date.now();
  const minLiveSamples = positiveInteger(options.minLiveSamples ?? 20, "minLiveSamples", 2, 1200);
  const minEvidenceSamples = positiveInteger(options.minEvidenceSamples ?? 30, "minEvidenceSamples", 2, 1200);
  const minImprovementRatio = finite(options.minImprovementRatio ?? 0.03, "minImprovementRatio", 0.001, 0.5);
  const maxContextDriftRatio = finite(options.maxContextDriftRatio ?? 0.35, "maxContextDriftRatio", 0, 1);
  const allowAutomaticActuation = options.allowAutomaticActuation === true;
  const automaticConfirmations = positiveInteger(options.automaticConfirmations ?? 3, "automaticConfirmations", 2, 30);
  const automaticCooldownMs = finite(options.automaticCooldownMs ?? 30000, "automaticCooldownMs", 1000, 3600000);
  const candidates = new Map();
  let active = null;
  let applying = false;
  let rollingBack = false;
  let automaticEnabled = false;
  let lastAutomaticActionAt = -Infinity;
  let confirmationId = null;
  let confirmationCount = 0;
  let evaluationCount = 0;
  let applyCount = 0;
  let rollbackCount = 0;
  let lastDecision = Object.freeze({ status: "not-evaluated", proposal: null, rejected: Object.freeze([]) });
  let disposed = false;

  function assertLive() {
    if (disposed) throw new Error("PVCS Governor is disposed.");
  }
  function registerCandidate(input = {}) {
    assertLive();
    if (applying || rollingBack) throw new Error("Candidate registry is locked during a PVCS compensation transaction.");
    const id = String(input.id || "");
    if (!ID.test(id)) throw new TypeError("Candidate id must be a stable PStudio identifier.");
    if (candidates.has(id)) throw new Error("PVCS candidate already exists: " + id);
    const stageId = String(input.stageId || "");
    if (!ID.test(stageId)) throw new TypeError("Candidate requires a valid PVCS stageId.");
    const domain = DOMAIN[input.domain] ? input.domain : null;
    if (!domain) throw new TypeError("Candidate domain must be cpu-frame, cpu-stage, gpu-frame, gpu-stage, asynchronous or memory.");
    if (DOMAIN[domain].requiredStage && DOMAIN[domain].requiredStage !== stageId) throw new TypeError("This measurement domain must use stage " + DOMAIN[domain].requiredStage + ".");
    const graphNode = pvcs.graph.snapshot().nodes.find(node => node.id === stageId);
    if (!graphNode) throw new TypeError("Candidate stage is not registered in the PVCS graph.");
    const triggerAbove = finite(input.triggerAbove, "triggerAbove", 0.000001);
    const evidence = readEvidence(input, minEvidenceSamples, minImprovementRatio);
    if (input.evidence?.domain !== domain) throw new TypeError("A/B evidence domain does not match the candidate domain.");
    const action = parseAction(input.action);
    const record = Object.freeze({
      id, stageId, domain, triggerAbove,
      action, evidence,
      priority: finite(input.priority ?? 1, "priority", 0.01, 100),
      automaticEligible: input.automaticEligible === true,
      description: String(input.description || id).slice(0, 240)
    });
    candidates.set(id, { descriptor: record, apply: input.apply, rollback: input.rollback });
    return record;
  }
  function unregisterCandidate(id) {
    assertLive();
    if (applying || rollingBack) throw new Error("Candidate registry is locked during a PVCS compensation transaction.");
    if (active?.candidateId === String(id)) throw new Error("Rollback the active compensation before unregistering it.");
    return candidates.delete(String(id));
  }
  function metricFor(candidate, rankings) {
    const spec = DOMAIN[candidate.domain];
    const list = rankings?.[spec.ranking];
    if (!Array.isArray(list)) return null;
    return list.find(item => {
      if (item.id !== candidate.stageId || item.sampleCount < minLiveSamples || !Number.isFinite(item.value)) return false;
      try { return contextKey(item.context) === candidate.evidence.context; }
      catch (_) { return false; }
    }) || null;
  }
  function evaluate() {
    assertLive();
    evaluationCount += 1;
    if (!pvcs.isMonitoringEnabled()) {
      lastDecision = Object.freeze({ status: "monitoring-disabled", proposal: null, rejected: Object.freeze([]) });
      return lastDecision;
    }
    let analysis;
    try { analysis = pvcs.analyze(); }
    catch (error) {
      lastDecision = Object.freeze({ status: "analysis-error", proposal: null, error: String(error?.message || error), rejected: Object.freeze([]) });
      return lastDecision;
    }
    const rejected = [];
    const eligible = [];
    for (const entry of candidates.values()) {
      const c = entry.descriptor;
      const live = metricFor(c, analysis.rankings);
      if (!live) {
        rejected.push(Object.freeze({ id: c.id, reason: "live-domain-or-context-unavailable" }));
        continue;
      }
      if (live.value < c.triggerAbove) {
        rejected.push(Object.freeze({ id: c.id, reason: "below-trigger", current: live.value, triggerAbove: c.triggerAbove }));
        continue;
      }
      const drift = Math.abs(live.value - c.evidence.baselineP95) / c.evidence.baselineP95;
      if (drift > maxContextDriftRatio) {
        rejected.push(Object.freeze({ id: c.id, reason: "calibration-drift", drift, maxContextDriftRatio }));
        continue;
      }
      const visualPenalty = c.evidence.visual.meanAbsoluteError * 2
        + c.evidence.visual.changedPixelRatio * 5
        + c.evidence.temporal.meanAbsoluteTemporalDeltaError * 10;
      const score = c.evidence.improvementRatio * c.priority / (1 + visualPenalty);
      eligible.push(Object.freeze({
        id: c.id, stageId: c.stageId, domain: c.domain, unit: DOMAIN[c.domain].unit,
        action: c.action, description: c.description,
        currentP95: live.value, triggerAbove: c.triggerAbove,
        calibratedBaselineP95: c.evidence.baselineP95,
        calibratedAlternativeP95: c.evidence.alternativeP95,
        expectedSaving: c.evidence.saving,
        expectedImprovementRatio: c.evidence.improvementRatio,
        visual: c.evidence.visual, temporal: c.evidence.temporal,
        context: live.context, score, automaticEligible: c.automaticEligible
      }));
    }
    eligible.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const proposal = active ? null : eligible[0] || null;
    lastDecision = Object.freeze({
      status: active ? "compensation-active" : proposal ? "proposal-ready" : "no-eligible-candidate",
      proposal,
      alternatives: Object.freeze(eligible.slice(1)),
      rejected: Object.freeze(rejected),
      activeCandidateId: active?.candidateId || null,
      evaluation: evaluationCount
    });
    return lastDecision;
  }
  function candidateForProposal(id, decision) {
    if (!decision?.proposal || decision.proposal.id !== String(id)) throw new Error("Proposal is stale or is not the current highest-ranked eligible candidate.");
    const entry = candidates.get(String(id));
    if (!entry) throw new Error("PVCS candidate no longer exists.");
    return entry;
  }
  async function applyProposal(id) {
    assertLive();
    if (active || applying || rollingBack) throw new Error("A PVCS compensation transaction is already active.");
    if (!executor || typeof executor.apply !== "function" || typeof executor.rollback !== "function") {
      throw new Error("A reversible PVCS executor with apply and rollback functions is required.");
    }
    applying = true;
    try {
      const decision = evaluate();
      const entry = candidateForProposal(id, decision);
      const c = entry.descriptor;
      const current = decision.proposal;
      if (!current || current.id !== c.id) throw new Error("PVCS candidate is no longer eligible.");
      const expectedContext = c.evidence.context;
      if (contextKey(current.context) !== expectedContext) throw new Error("PVCS context changed before apply.");
      const result = await executor.apply(Object.freeze({ candidate: c, proposal: current }));
      if (!result || result.applied !== true || !Object.prototype.hasOwnProperty.call(result, "rollbackToken") || result.rollbackToken === undefined || result.rollbackToken === null) {
        throw new Error("PVCS executor must apply atomically and return { applied: true, rollbackToken }.");
      }
      let postApplyDecision = null;
      try { postApplyDecision = evaluate(); } catch (_) {}
      if (postApplyDecision?.proposal?.id !== c.id || contextKey(postApplyDecision.proposal.context) !== expectedContext) {
        active = {
          candidateId: c.id, candidate: c, rollbackToken: result.rollbackToken,
          appliedAt: now(), context: expectedContext
        };
        try {
          await executor.rollback(Object.freeze({
            candidate: c,
            rollbackToken: result.rollbackToken,
            reason: "pvcs-context-or-evidence-changed-during-apply"
          }));
          active = null;
          rollbackCount += 1;
        } catch (rollbackError) {
          throw new Error("PVCS proposal became stale and automatic rollback failed; the rollback token remains active: " + String(rollbackError?.message || rollbackError));
        }
        throw new Error("PVCS proposal became stale during apply; the executor rolled it back.");
      }
      active = {
        candidateId: c.id, candidate: c, rollbackToken: result.rollbackToken,
        appliedAt: now(), context: expectedContext
      };
      applyCount += 1;
      lastAutomaticActionAt = now();
      confirmationId = null;
      confirmationCount = 0;
      return Object.freeze({ applied: true, candidateId: c.id, action: c.action, appliedAt: active.appliedAt });
    } finally {
      applying = false;
    }
  }
  async function rollback(reason = "manual") {
    assertLive();
    if (applying || rollingBack) throw new Error("A PVCS compensation transaction is already in progress.");
    if (!active) return Object.freeze({ rolledBack: false, reason: "no-active-compensation" });
    const current = active;
    rollingBack = true;
    try {
      await executor.rollback(Object.freeze({ candidate: current.candidate, rollbackToken: current.rollbackToken, reason: String(reason) }));
      active = null;
      rollbackCount += 1;
      lastDecision = Object.freeze({ status: "rolled-back", proposal: null, rejected: Object.freeze([]), reason: String(reason) });
      return Object.freeze({ rolledBack: true, candidateId: current.candidateId, reason: String(reason) });
    } finally {
      rollingBack = false;
    }
  }
  async function tick() {
    assertLive();
    if (applying || rollingBack) {
      return Object.freeze({
        ...lastDecision,
        status: "transaction-in-progress",
        automaticApplied: false,
        automaticReason: "transaction-in-progress"
      });
    }
    const decision = evaluate();
    if (!automaticEnabled || !allowAutomaticActuation || active || !decision.proposal?.automaticEligible) {
      confirmationId = null;
      confirmationCount = 0;
      return Object.freeze({ ...decision, automaticApplied: false, automaticReason: !automaticEnabled ? "automatic-disabled" : active ? "compensation-active" : "no-automatic-candidate" });
    }
    const id = decision.proposal.id;
    confirmationCount = confirmationId === id ? confirmationCount + 1 : 1;
    confirmationId = id;
    if (confirmationCount < automaticConfirmations) return Object.freeze({ ...decision, automaticApplied: false, automaticReason: "hysteresis-confirming", confirmationCount });
    if (now() - lastAutomaticActionAt < automaticCooldownMs) return Object.freeze({ ...decision, automaticApplied: false, automaticReason: "cooldown", confirmationCount });
    const applied = await applyProposal(id);
    return Object.freeze({ ...decision, automaticApplied: true, applied });
  }
  function setAutomaticEnabled(enabled) {
    assertLive();
    if (enabled === true && !allowAutomaticActuation) throw new Error("Automatic actuation was not explicitly enabled at construction.");
    if (enabled !== true) { confirmationId = null; confirmationCount = 0; }
    automaticEnabled = enabled === true;
    return automaticEnabled;
  }
  function state() {
    return Object.freeze({
      kind: "pstudio-pvcs-governor-state",
      monitoringEnabled: pvcs.isMonitoringEnabled(),
      candidateCount: candidates.size,
      active: active ? Object.freeze({ candidateId: active.candidateId, action: active.candidate.action, appliedAt: active.appliedAt, context: active.context }) : null,
      inFlight: applying || rollingBack,
      automaticAllowed: allowAutomaticActuation,
      automaticEnabled,
      confirmationCount,
      evaluationCount,
      applyCount,
      rollbackCount,
      lastDecision
    });
  }
  function dispose() {
    if (disposed) return false;
    if (active || applying || rollingBack) throw new Error("Rollback or finish the active compensation before disposing the PVCS Governor.");
    candidates.clear();
    disposed = true;
    return true;
  }
  return Object.freeze({
    kind: "pstudio-pvcs-governor",
    registerCandidate, unregisterCandidate, evaluate, applyProposal, rollback,
    tick, setAutomaticEnabled, getState: state, dispose
  });
}


/** Adapter from explicit PVCS transactions to PStudioRenderingBudget's reversible overlay. */
export function createPStudioPVCSFrameBudgetExecutor(options = {}) {
  const getRenderer = typeof options.getRenderer === "function" ? options.getRenderer : () => null;
  function resolveRenderer() {
    const renderer = getRenderer();
    if (!renderer || typeof renderer.applyPVCSFrameBudgetOverride !== "function" ||
        typeof renderer.rollbackPVCSFrameBudgetOverride !== "function") {
      throw new Error("The active PStudio3D renderer does not expose the reversible PVCS frame-budget bridge.");
    }
    return renderer;
  }
  return Object.freeze({
    async apply({ candidate }) {
      if (candidate?.action?.type !== "frame-budget") throw new TypeError("Frame-budget executor only accepts frame-budget actions.");
      const result = resolveRenderer().applyPVCSFrameBudgetOverride(candidate.action.profile);
      if (!result?.applied || !result.rollbackToken) throw new Error(result?.reason || "PStudioRenderingBudget rejected the compensation profile.");
      return Object.freeze({ applied: true, rollbackToken: result.rollbackToken, state: result.state || null });
    },
    async rollback({ rollbackToken }) {
      const result = resolveRenderer().rollbackPVCSFrameBudgetOverride(rollbackToken);
      if (result !== true) throw new Error("PStudioRenderingBudget could not restore the prior compensation state.");
      return true;
    }
  });
}
