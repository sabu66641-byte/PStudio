const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modules = Promise.all([
  import('three/webgpu'),
  import('../static/pstudio_rendering_production_bridge.mjs')
]);

function makeElement(tagName, documentRef) {
  const attributes = new Map();
  const values = Object.create(null);
  return {
    tagName: tagName.toUpperCase(),
    ownerDocument: documentRef,
    parentElement: null,
    nextSibling: null,
    className: 'game-canvas game-canvas-3d',
    hidden: false,
    style: {
      setProperty(key, value) { values[key] = String(value); },
      getPropertyValue(key) { return values[key] || ''; },
      get position() { return values.position || ''; },
      set position(value) { values.position = value; },
      get isolation() { return values.isolation || ''; },
      set isolation(value) { values.isolation = value; }
    },
    classList: { add() {} },
    setAttribute(key, value) { attributes.set(key, String(value)); },
    getAttribute(key) { return attributes.has(key) ? attributes.get(key) : null; },
    removeAttribute(key) { attributes.delete(key); },
    remove() { this.parentElement?.removeChild(this); }
  };
}

function makeCanvasDOM() {
  const documentRef = {
    defaultView: { getComputedStyle: element => ({ position: element.style.position || 'static' }) },
    createElement(tagName) { return makeElement(tagName, documentRef); }
  };
  const children = [];
  const parent = makeElement('div', documentRef);
  parent.style.position = 'static';
  parent.insertBefore = (element, before) => {
    if (element.parentElement) element.parentElement.removeChild(element);
    const index = before ? children.indexOf(before) : -1;
    if (index < 0) children.push(element);
    else children.splice(index, 0, element);
    element.parentElement = parent;
  };
  parent.removeChild = element => {
    const index = children.indexOf(element);
    if (index >= 0) children.splice(index, 1);
    element.parentElement = null;
  };
  const legacyCanvas = makeElement('canvas', documentRef);
  parent.insertBefore(legacyCanvas, null);
  return { legacyCanvas, children };
}

function makeScene(THREE) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 1000);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  scene.add(mesh);
  return { scene, camera };
}

test('production bridge keeps WebGL2 visible until a compatible WebGPU scene is ready', async () => {
  const [THREE, bridgeModule] = await modules;
  const { createPStudioProductionRenderingBridge } = bridgeModule;
  const { legacyCanvas, children } = makeCanvasDOM();
  const { scene, camera } = makeScene(THREE);
  let creates = 0;
  let renders = 0;
  let resizes = 0;
  let disposals = 0;
  const bridge = createPStudioProductionRenderingBridge({
    legacyCanvas,
    scene,
    camera,
    createWebGPU: async ({ canvas, fallbackCanvas }) => {
      creates += 1;
      assert.notEqual(canvas, fallbackCanvas);
      assert.notEqual(canvas, legacyCanvas);
      return {
        capabilities: { backend: 'webgpu' },
        render() { renders += 1; return true; },
        resize() { resizes += 1; return true; },
        dispose() { disposals += 1; }
      };
    }
  });

  const pending = bridge.initialize();
  assert.equal(legacyCanvas.style.getPropertyValue('visibility'), 'visible');
  await pending;
  const state = bridge.getState();
  assert.equal(state.backend, 'webgpu');
  assert.equal(state.state, 'ready');
  assert.equal(legacyCanvas.style.getPropertyValue('visibility'), 'hidden');
  assert.equal(children.length, 2);
  assert.equal(bridge.render(), true);
  assert.equal(bridge.resize(800, 450, 1.5), true);
  assert.equal(creates, 1);
  assert.equal(renders, 1);
  assert.equal(resizes, 1);

  bridge.dispose();
  assert.equal(disposals, 1);
  assert.equal(children.length, 1);
});

test('production bridge fails closed for a scene with a custom GLSL material hook', async () => {
  const [THREE, bridgeModule] = await modules;
  const { createPStudioProductionRenderingBridge } = bridgeModule;
  const { legacyCanvas, children } = makeCanvasDOM();
  const { scene, camera } = makeScene(THREE);
  const mesh = scene.children[0];
  mesh.material.onBeforeCompile = () => {};
  let creates = 0;
  const bridge = createPStudioProductionRenderingBridge({
    legacyCanvas,
    scene,
    camera,
    createWebGPU: async () => { creates += 1; return { render() { return true; } }; }
  });

  assert.equal(await bridge.initialize(), false);
  assert.equal(bridge.getState().state, 'blocked');
  assert.equal(bridge.getState().backend, 'webgl2');
  assert.equal(bridge.getState().blockers.some(item => item.id === 'unsupported-material'), true);
  assert.equal(creates, 0);
  assert.equal(children.length, 1);
  bridge.dispose();
});

test('production bridge activates the existing WebGL2 fallback after WebGPU initialization failure', async () => {
  const [THREE, bridgeModule] = await modules;
  const { createPStudioProductionRenderingBridge } = bridgeModule;
  const { legacyCanvas } = makeCanvasDOM();
  const { scene, camera } = makeScene(THREE);
  const bridge = createPStudioProductionRenderingBridge({
    legacyCanvas,
    scene,
    camera,
    createWebGPU: async () => { throw new Error('simulated WebGPU init failure'); }
  });

  await bridge.initialize();
  assert.equal(bridge.getState().backend, 'webgl2');
  assert.equal(bridge.getState().state, 'fallback');
  assert.equal(legacyCanvas.style.getPropertyValue('visibility'), 'visible');
  bridge.dispose();
});

test('production bridge can recover from WebGPU device loss without replacing the legacy renderer', async () => {
  const [THREE, bridgeModule] = await modules;
  const { createPStudioProductionRenderingBridge } = bridgeModule;
  const { legacyCanvas } = makeCanvasDOM();
  const { scene, camera } = makeScene(THREE);
  let disposed = 0;
  const bridge = createPStudioProductionRenderingBridge({
    legacyCanvas,
    scene,
    camera,
    createWebGPU: async () => ({
      render() { return true; },
      dispose() { disposed += 1; }
    })
  });

  await bridge.initialize();
  assert.equal(bridge.getState().backend, 'webgpu');
  assert.equal(await bridge.useFallback(new Error('simulated device loss')), true);
  assert.equal(bridge.getState().backend, 'webgl2');
  assert.equal(legacyCanvas.style.getPropertyValue('visibility'), 'visible');
  assert.equal(disposed, 1);
  bridge.dispose();
});

test('production bridge deduplicates concurrent initialization and permits retry after policy blockers clear', async () => {
  const [THREE, bridgeModule] = await modules;
  const { createPStudioProductionRenderingBridge } = bridgeModule;
  const { legacyCanvas } = makeCanvasDOM();
  const { scene, camera } = makeScene(THREE);
  let allowed = false;
  let creates = 0;
  const bridge = createPStudioProductionRenderingBridge({
    legacyCanvas,
    scene,
    camera,
    canPromote: () => allowed,
    createWebGPU: async () => {
      creates += 1;
      return { render() { return true; }, dispose() {} };
    }
  });

  assert.equal(await bridge.initialize(), false);
  allowed = true;
  const [a, b] = await Promise.all([bridge.initialize(), bridge.initialize()]);
  assert.equal(a, b);
  assert.equal(creates, 1);
  assert.equal(bridge.getState().backend, 'webgpu');
  bridge.dispose();
});

// Keep the browser bootstrap and the engine's runtime handoff coupled in regression coverage.
test('production 3D render loop is wired to a fail-closed WebGPU bridge with resize and fallback routing', () => {
  const root = path.join(__dirname, '..');
  const engine = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');

  for (const token of [
    'window.PStudioProductionRenderingBridgeFactory',
    'function getProductionWebGPUFeatureBlockers',
    'function requestProductionWebGPUMigration',
    "productionRendererBridge.render()",
    'productionRendererBridge.resize(width,height,bridgePixelRatio)',
    'fallbackFromWebGPUForUnsupportedFeatures(commandsByObject)',
    'productionPendingCommands=commandsByObject',
    'requestWebGPUMigration:()=>requestProductionWebGPUMigration({retry:true})',
    'getWebGPUMigrationDiagnostics:'
  ]) {
    assert.ok(engine.includes(token), 'production engine integration: ' + token);
  }

  for (const token of [
    '/static/pstudio_rendering_production_bridge.mjs?v=20261125-production-scene-bridge-v1',
    'window.PStudioProductionRenderingBridgeFactory = productionBridge.createPStudioProductionRenderingBridge'
  ]) {
    assert.ok(html.includes(token), 'application bootstrap: ' + token);
  }
});
