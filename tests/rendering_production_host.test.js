const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
const modules = Promise.all([
  import('three/webgpu'),
  import('../static/pstudio_rendering_production_host.mjs')
]);

function makeElement(tagName, documentRef) {
  const attributes = new Map();
  const values = Object.create(null);
  return {
    tagName: tagName.toUpperCase(), ownerDocument: documentRef, parentElement: null,
    nextSibling: null, className: 'game-canvas', hidden: false,
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
    if (index < 0) children.push(element); else children.splice(index, 0, element);
    element.parentElement = parent;
  };
  parent.removeChild = element => {
    const index = children.indexOf(element);
    if (index >= 0) children.splice(index, 1);
    element.parentElement = null;
  };
  const primaryCanvas = makeElement('canvas', documentRef);
  parent.insertBefore(primaryCanvas, null);
  return { primaryCanvas, children };
}

test('production host activates WebGPU surface only after successful async initialization', async () => {
  const [THREE, hostModule] = await modules;
  const { primaryCanvas, children } = makeCanvasDOM();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const host = hostModule.createPStudioProductionRendererHost({
    primaryCanvas, scene, camera,
    createWebGPU: async ({ canvas }) => {
      assert.equal(canvas, primaryCanvas);
      return { capabilities: { backend: 'webgpu' }, render: () => true, dispose() {} };
    }
  });
  await host.initialize();
  assert.equal(host.getState().backend, 'webgpu');
  assert.equal(host.getState().canvasHost.activeBackend, 'webgpu');
  assert.equal(host.getCanvas('webgpu'), primaryCanvas);
  assert.equal(host.render(), true);
  assert.equal(children.length, 2);
  host.dispose();
  assert.equal(children.length, 1);
});

test('production host activates a distinct WebGL canvas when WebGPU initialization fails', async () => {
  const [THREE, hostModule] = await modules;
  const { primaryCanvas, children } = makeCanvasDOM();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  let fallbackCanvas;
  const host = hostModule.createPStudioProductionRendererHost({
    primaryCanvas, scene, camera,
    createWebGPU: async () => { throw new Error('GPU initialization failed'); },
    createFallback: async ({ canvas, webgpuCanvas }) => {
      fallbackCanvas = canvas;
      assert.notEqual(canvas, webgpuCanvas);
      return { backend: 'webgl2', render: () => true, dispose() {} };
    }
  });
  await host.initialize();
  assert.equal(host.getState().backend, 'webgl2');
  assert.equal(host.getState().canvasHost.activeBackend, 'webgl2');
  assert.equal(host.getCanvas('webgl2'), fallbackCanvas);
  assert.equal(fallbackCanvas.style.getPropertyValue('visibility'), 'visible');
  assert.equal(primaryCanvas.style.getPropertyValue('visibility'), 'hidden');
  assert.equal(host.render(), true);
  assert.equal(children.length, 2);
  host.dispose();
  assert.equal(children.length, 1);
});

test('application bootstraps the production renderer host factory without changing legacy startup', () => {
  assert.ok(html.includes('/static/pstudio_rendering_production_host.mjs?v=20261126-cluster-live-v1'));
  assert.ok(html.includes('window.PStudioProductionRendererHostFactory = productionRendererHost.createPStudioProductionRendererHost'));
  assert.ok(html.includes('window.PStudioProductionRendererHostFactory = null'));
  assert.ok(html.includes('/static/pstudio_3d_engine.js?v=20261126-genesis-1-2-v1'));
});
