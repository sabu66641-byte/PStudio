const test = require('node:test');
const assert = require('node:assert/strict');
const hostModule = import('../static/pstudio_rendering_canvas_host.mjs');

function makeElement(tagName, documentRef) {
  const attributes = new Map();
  const styleValues = Object.create(null);
  const element = {
    tagName: tagName.toUpperCase(),
    ownerDocument: documentRef,
    parentElement: null,
    nextSibling: null,
    className: '',
    hidden: false,
    style: {
      setProperty(key, value) { styleValues[key] = String(value); },
      getPropertyValue(key) { return styleValues[key] || ''; },
      get position() { return styleValues.position || ''; },
      set position(value) { styleValues.position = value; },
      get isolation() { return styleValues.isolation || ''; },
      set isolation(value) { styleValues.isolation = value; }
    },
    classList: { add() {} },
    setAttribute(key, value) { attributes.set(key, String(value)); },
    getAttribute(key) { return attributes.has(key) ? attributes.get(key) : null; },
    removeAttribute(key) { attributes.delete(key); },
    remove() { this.parentElement?.removeChild(this); }
  };
  return element;
}

function makeDOM() {
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
  const primary = makeElement('canvas', documentRef);
  primary.className = 'game-canvas game-canvas-3d';
  primary.setAttribute('style', 'width:100%;height:auto');
  parent.insertBefore(primary, null);
  return { documentRef, parent, primary, children };
}

test('canvas host creates two aligned surfaces and switches visibility without sharing contexts', async () => {
  const { createPStudioRendererCanvasHost } = await hostModule;
  const { parent, primary, children } = makeDOM();
  const host = createPStudioRendererCanvasHost({ primaryCanvas: primary });
  const fallback = host.fallbackCanvas;
  assert.notEqual(primary, fallback);
  assert.equal(fallback.parentElement, parent);
  assert.equal(children.length, 2);
  assert.equal(host.getCanvas('webgpu'), primary);
  assert.equal(host.getCanvas('webgl2'), fallback);
  assert.equal(host.getState().separateContexts, true);
  assert.equal(primary.style.getPropertyValue('visibility'), 'visible');
  assert.equal(fallback.style.getPropertyValue('visibility'), 'hidden');

  assert.equal(host.activate('webgl2'), true);
  assert.equal(primary.style.getPropertyValue('visibility'), 'hidden');
  assert.equal(fallback.style.getPropertyValue('visibility'), 'visible');
  assert.equal(fallback.style.getPropertyValue('pointer-events'), 'auto');
  assert.equal(primary.style.getPropertyValue('pointer-events'), 'none');
  assert.equal(host.getState().activeBackend, 'webgl2');

  assert.equal(host.dispose(), true);
  assert.equal(host.dispose(), false);
  assert.equal(children.length, 1);
  assert.equal(primary.getAttribute('style'), 'width:100%;height:auto');
  assert.equal(parent.style.position, 'static');
  assert.equal(parent.style.isolation, '');
});

test('canvas host validates both canvas types and does not accept a shared element', async () => {
  const { createPStudioRendererCanvasHost } = await hostModule;
  const { primary } = makeDOM();
  assert.throws(() => createPStudioRendererCanvasHost({ primaryCanvas: {} }), /HTMLCanvasElement/);
  assert.throws(() => createPStudioRendererCanvasHost({ primaryCanvas: primary, fallbackCanvas: primary }), /different elements/);
  assert.throws(() => createPStudioRendererCanvasHost({ primaryCanvas: primary, fallbackCanvas: { tagName: 'DIV' } }), /HTMLCanvasElement/);
});

test('canvas host can adopt a caller-provided detached fallback and removes it on disposal', async () => {
  const { createPStudioRendererCanvasHost } = await hostModule;
  const { parent, primary, children } = makeDOM();
  const fallback = makeElement('canvas', primary.ownerDocument);
  const host = createPStudioRendererCanvasHost({ primaryCanvas: primary, fallbackCanvas: fallback });
  assert.equal(fallback.parentElement, parent);
  assert.equal(children.length, 2);
  host.activate('webgl2');
  assert.equal(host.getCanvas(), fallback);
  host.dispose();
  assert.equal(fallback.parentElement, null);
  assert.equal(children.length, 1);
});
