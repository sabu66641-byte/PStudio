/**
 * Keeps WebGPU and WebGL renderer contexts on separate canvases while sharing
 * one visual viewport. The canvases remain layout-aligned so the existing
 * engine's parent-level pointer handlers and primary-canvas bounds stay valid.
 */
export function createPStudioRendererCanvasHost(options = {}) {
  const primaryCanvas = options.primaryCanvas;
  if (!primaryCanvas || String(primaryCanvas.tagName || '').toLowerCase() !== 'canvas') {
    throw new TypeError('primaryCanvas must be an HTMLCanvasElement.');
  }
  const parent = primaryCanvas.parentElement;
  const documentRef = primaryCanvas.ownerDocument;
  if (!parent || !documentRef?.createElement) {
    throw new TypeError('primaryCanvas must be attached to a document parent.');
  }

  const fallbackCanvas = options.fallbackCanvas || documentRef.createElement('canvas');
  if (fallbackCanvas === primaryCanvas) {
    throw new TypeError('Primary and fallback canvases must be different elements.');
  }
  if (String(fallbackCanvas.tagName || '').toLowerCase() !== 'canvas') {
    throw new TypeError('fallbackCanvas must be an HTMLCanvasElement.');
  }
  if (fallbackCanvas.parentElement && fallbackCanvas.parentElement !== parent) {
    throw new Error('fallbackCanvas must share the primary canvas parent.');
  }

  const createdFallback = !options.fallbackCanvas;
  const elements = [primaryCanvas, fallbackCanvas];
  const originalStyles = elements.map((canvas) => ({
    style: canvas.getAttribute?.('style'),
    className: canvas.className,
    hidden: canvas.hidden,
    ariaHidden: canvas.getAttribute?.('aria-hidden')
  }));
  const parentOriginalStyle = parent.getAttribute?.('style');
  let disposed = false;
  let activeBackend = 'webgpu';

  function setStyle(element, key, value) {
    if (element.style?.setProperty) element.style.setProperty(key, value);
    else if (element.style) element.style[key] = value;
  }

  function applyLayout() {
    const parentStyle = documentRef.defaultView?.getComputedStyle?.(parent);
    if (parentStyle?.position === 'static') setStyle(parent, 'position', 'relative');
    setStyle(parent, 'isolation', 'isolate');

    for (const [index, canvas] of elements.entries()) {
      setStyle(canvas, 'position', 'absolute');
      setStyle(canvas, 'left', '50%');
      setStyle(canvas, 'top', '50%');
      setStyle(canvas, 'transform', 'translate(-50%, -50%)');
      setStyle(canvas, 'width', 'min(100%, 800px)');
      setStyle(canvas, 'max-width', '100%');
      setStyle(canvas, 'max-height', '100%');
      setStyle(canvas, 'aspect-ratio', '16 / 9');
      setStyle(canvas, 'display', 'block');
      setStyle(canvas, 'z-index', index === 0 ? '1' : '2');
      setStyle(canvas, 'pointer-events', 'auto');
      setStyle(canvas, 'visibility', 'visible');
      canvas.classList?.add('pstudio-renderer-surface');
    }
    if (createdFallback) {
      fallbackCanvas.className = primaryCanvas.className || 'game-canvas game-canvas-3d';
      fallbackCanvas.setAttribute?.('aria-label', 'PStudio WebGL compatibility renderer');
      parent.insertBefore(fallbackCanvas, primaryCanvas.nextSibling);
    }
    activate(activeBackend);
  }

  function activate(backend) {
    if (disposed) return false;
    if (backend !== 'webgpu' && backend !== 'webgl2') {
      throw new TypeError('Renderer backend must be webgpu or webgl2.');
    }
    activeBackend = backend;
    for (const [index, canvas] of elements.entries()) {
      const selected = (backend === 'webgpu' ? index === 0 : index === 1);
      setStyle(canvas, 'z-index', selected ? '2' : '1');
      setStyle(canvas, 'pointer-events', selected ? 'auto' : 'none');
      setStyle(canvas, 'visibility', selected ? 'visible' : 'hidden');
      canvas.setAttribute?.('aria-hidden', selected ? 'false' : 'true');
    }
    return true;
  }

  function getState() {
    return Object.freeze({
      activeBackend,
      primaryCanvas,
      fallbackCanvas,
      disposed,
      separateContexts: primaryCanvas !== fallbackCanvas
    });
  }

  applyLayout();

  return Object.freeze({
    kind: 'pstudio-renderer-canvas-host',
    primaryCanvas,
    fallbackCanvas,
    activate,
    getCanvas(backend = activeBackend) {
      if (backend === 'webgpu') return primaryCanvas;
      if (backend === 'webgl2') return fallbackCanvas;
      throw new TypeError('Renderer backend must be webgpu or webgl2.');
    },
    getState,
    dispose() {
      if (disposed) return false;
      disposed = true;
      if (createdFallback) fallbackCanvas.remove?.();
      for (let index = 0; index < elements.length; index += 1) {
        const canvas = elements[index];
        const original = originalStyles[index];
        if (original.style === null || original.style === undefined) canvas.removeAttribute?.('style');
        else canvas.setAttribute?.('style', original.style);
        canvas.className = original.className;
        canvas.hidden = original.hidden;
        if (original.ariaHidden === null || original.ariaHidden === undefined) canvas.removeAttribute?.('aria-hidden');
        else canvas.setAttribute?.('aria-hidden', original.ariaHidden);
      }
      if (parentOriginalStyle === null || parentOriginalStyle === undefined) parent.removeAttribute?.('style');
      else parent.setAttribute?.('style', parentOriginalStyle);
      return true;
    }
  });
}
