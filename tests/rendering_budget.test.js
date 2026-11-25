const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const budget = require('../static/pstudio_rendering_budget.js');
const root = path.resolve(__dirname, '..');

test('frame budget reuses one state object and preserves full quality with GPU headroom', () => {
  const controller = budget.createPStudioFrameBudgetController();
  const state = controller.state;
  assert.equal(controller.update(5,true,0,16.67,0,true,true,true,true),state);
  assert.equal(state.source,'gpu-timer-query');
  assert.equal(state.scale,1);
  assert.equal(state.mirrorIntervalFrames,1);
  assert.equal(state.mirrorResolutionScale,1);
  assert.equal(state.giCaptureAllowed,true);
  assert.equal(state.giCadenceMultiplier,1);
  assert.equal(state.cloudStepScale,1);
});

test('heavy GPU frames reduce reflection cadence/resolution and GI/volumetric work together', () => {
  const controller = budget.createPStudioFrameBudgetController();
  const state = controller.update(21,true,0,16.67,0,true,true,true,true);
  assert.ok(state.scale<=0.36);
  assert.equal(state.mirrorIntervalFrames,3);
  assert.ok(state.mirrorResolutionScale<0.8);
  assert.equal(state.giCaptureAllowed,false);
  assert.ok(state.giCadenceMultiplier>=4);
  assert.ok(state.cloudStepScale<0.75);
  assert.ok(state.fogStepScale<0.8);
  assert.ok(state.contactShadowStepScale<0.75);
});

test('visible frame pacing fallback respects the touch frame budget', () => {
  const controller = budget.createPStudioFrameBudgetController();
  const state = controller.update(0,false,24,20,0,false,true,true,true);
  assert.equal(state.source,'frame-interval-fallback');
  assert.ok(state.scale<1&&state.scale>0.4);
  assert.ok(state.mirrorIntervalFrames>=2);
  assert.equal(state.giCaptureAllowed,true);
});

test('resource pressure caps optional rendering work even when GPU timing is fast', () => {
  const controller = budget.createPStudioFrameBudgetController();
  const state = controller.update(4,true,0,16.67,0.99,true,true,true,true);
  assert.ok(state.scale<=0.4);
  assert.equal(state.giCaptureAllowed,false);
  assert.equal(state.mirrorIntervalFrames,3);
});

test('static scenes reuse cached reflections while camera motion raises update priority', () => {
  const controller = budget.createPStudioFrameBudgetController();
  const state = controller.update(6,true,0,16.67,0,false,false,true,false);
  assert.equal(state.mirrorIntervalFrames,4);
  controller.update(6,true,0,16.67,0,true,false,true,false);
  assert.equal(state.mirrorIntervalFrames,1);
  assert.equal(state.giCaptureAllowed,false);
});

test('missing or invalid timing samples retain the latest stable budget without NaN', () => {
  const controller = budget.createPStudioFrameBudgetController();
  const state = controller.update(8,true,0,16.67,0,true,true,true,true);
  const scale=state.scale,revision=state.revision;
  assert.equal(controller.update(NaN,false,250,16.67,NaN,true,true,true,true),state);
  assert.equal(state.scale,scale);
  assert.equal(state.revision,revision);
  for(const key of ['scale','mirrorResolutionScale','giCadenceMultiplier','cloudStepScale','fogStepScale','contactShadowStepScale']) {
    assert.ok(Number.isFinite(state[key]),key);
  }
});

test('renderer, planar reflections, Dynamic GI and post FX consume the shared broker', () => {
  const engine=fs.readFileSync(path.join(root,'static/pstudio_3d_engine.js'),'utf8');
  const fx=fs.readFileSync(path.join(root,'static/pstudio_environment_fx.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'templates/index.html'),'utf8');
  for(const token of [
    'updateRenderingFrameBudget()',
    'renderingFrameBudget.mirrorIntervalFrames',
    'renderingFrameBudget.mirrorResolutionScale',
    'renderingFrameBudget.giCaptureAllowed',
    'renderingFrameBudget.giCadenceMultiplier',
    'renderingFrameBudget.cloudStepScale',
    'renderingFrameBudget.fogStepScale',
    'renderingFrameBudget.contactShadowStepScale'
  ])assert.ok(engine.includes(token),token);
  for(const token of [
    'setFrameBudget(settings={})',
    'setFrameBudgetScale=scale=>',
    'baseSteps:steps'
  ])assert.ok(fx.includes(token),token);
  assert.ok(html.includes('pstudio_rendering_budget.js?v=20261125-frame-budget-v1'));
});
