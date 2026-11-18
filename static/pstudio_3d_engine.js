/* PStudio isolated 3D renderer.
 * This module only owns the additional WebGL canvas; the existing 2D renderer is untouched.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('game-3d-canvas');
  if (!canvas) return;
  let renderer = null;
  let scene = null;
  let camera = null;
  let primitiveGroup = null;
  let gridGroup = null;
  let lastSize = { width: 0, height: 0 };

  function ensureRenderer() {
    if (renderer) return true;
    if (!window.THREE || !window.THREE.WebGLRenderer) return false;
    const T = window.THREE;
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x171d26, 1);
    scene = new T.Scene();
    scene.background = new T.Color(0x171d26);
    camera = new T.PerspectiveCamera(55, 16 / 9, 0.1, 1000);
    camera.position.set(6, 5, 8);
    camera.lookAt(0, 0, 0);
    primitiveGroup = new T.Group();
    gridGroup = new T.Group();
    scene.add(primitiveGroup, gridGroup);
    scene.add(new T.HemisphereLight(0xffffff, 0x394150, 2.0));
    const key = new T.DirectionalLight(0xffffff, 2.2);
    key.position.set(5, 8, 6);
    scene.add(key);
    return true;
  }

  function disposeGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    }
  }

  function resize() {
    if (!renderer) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (width !== lastSize.width || height !== lastSize.height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastSize = { width, height };
    }
  }

  function render(commandsByObject) {
    if (!ensureRenderer()) throw new Error('Three.js could not be loaded. The 3D view needs an internet connection.');
    const T = window.THREE;
    disposeGroup(primitiveGroup);
    disposeGroup(gridGroup);
    let cameraCommand = null;
    for (const list of commandsByObject.values()) {
      for (const d of list) {
        if (d.type === 'camera') { cameraCommand = d; continue; }
        if (d.type === 'grid') {
          const grid = new T.GridHelper(d.size, d.divisions, 0x7b8797, 0x394352);
          grid.position.y = 0;
          gridGroup.add(grid);
          continue;
        }
        let geometry;
        if (d.type === 'cube') geometry = new T.BoxGeometry(d.size, d.size, d.size);
        else if (d.type === 'sphere') geometry = new T.SphereGeometry(d.radius, 24, 16);
        else continue;
        const material = new T.MeshStandardMaterial({ color: d.color || '#d1d5db', roughness: 0.72, metalness: 0.04 });
        const mesh = new T.Mesh(geometry, material);
        mesh.position.set(d.x, d.y, d.z);
        if (d.type === 'cube') mesh.rotation.set(d.rotationX || 0, d.rotationY || 0, d.rotationZ || 0);
        primitiveGroup.add(mesh);
      }
    }
    if (cameraCommand) {
      camera.position.set(cameraCommand.x, cameraCommand.y, cameraCommand.z);
      camera.lookAt(cameraCommand.targetX, cameraCommand.targetY, cameraCommand.targetZ);
    } else {
      camera.position.set(6, 5, 8);
      camera.lookAt(0, 0, 0);
    }
    resize();
    renderer.render(scene, camera);
  }

  function clear() {
    if (!renderer) return;
    disposeGroup(primitiveGroup);
    disposeGroup(gridGroup);
    renderer.render(scene, camera);
  }

  window.PStudio3D = { render, clear, isAvailable: () => !!window.THREE };
  window.addEventListener('resize', resize);
})();