import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createPStudioWebGPUBackend } from './pstudio_rendering_backend.mjs';
import { convertPStudioScenePBRMaterials } from './pstudio_rendering_materials.mjs';
import { createPStudioRenderPipeline } from './pstudio_rendering_pipeline.mjs';

const overlay = document.getElementById('webgpu-lab-overlay');
const canvas = document.getElementById('webgpu-lab-canvas');
const canvasHost = document.getElementById('webgpu-lab-canvas-host');
const statusElement = document.getElementById('webgpu-lab-status');
const openButton = document.getElementById('webgpu-lab-open');
const closeButton = document.getElementById('webgpu-lab-close');

let renderer = null;
let backendHandle = null;
let pipelineHandle = null;
let materialConversion = null;
let scene = null;
let camera = null;
let animatedGroup = null;
let resizeObserver = null;
let openingPromise = null;
let generation = 0;
let lastFrameTime = 0;
let fallbackResizeListener = null;

function setStatus(message, state = 'info') {
  if (!statusElement) return;
  statusElement.textContent = String(message || '');
  statusElement.dataset.state = state;
}

function createPatternTexture() {
  const source = document.createElement('canvas');
  source.width = 256;
  source.height = 256;
  const context = source.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable for the PBR texture test.');

  const gradient = context.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, '#e3a65f');
  gradient.addColorStop(0.48, '#b6d9df');
  gradient.addColorStop(1, '#527fba');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);

  context.strokeStyle = 'rgba(15, 28, 45, 0.28)';
  context.lineWidth = 3;
  for (let x = 0; x <= 256; x += 32) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, 256);
    context.stroke();
  }
  for (let y = 0; y <= 256; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(256, y);
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}

function createLabScene(deviceMemoryGiB) {
  const nextScene = new THREE.Scene();
  nextScene.background = new THREE.Color('#111c2a');

  const nextCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
  nextCamera.position.set(5.6, 4.1, 8.4);
  nextCamera.lookAt(0, 0.1, 0);

  const group = new THREE.Group();
  nextScene.add(group);

  const texture = createPatternTexture();
  const standardMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: texture,
    roughness: 0.34,
    metalness: 0.12
  });
  const standardSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.88, 48, 32),
    standardMaterial
  );
  standardSphere.position.set(-2.1, 0.05, 0);
  standardSphere.castShadow = true;
  standardSphere.receiveShadow = true;
  group.add(standardSphere);

  const physicalMaterial = new THREE.MeshPhysicalMaterial({
    color: '#e8d6bd',
    roughness: 0.17,
    metalness: 0.04,
    clearcoat: 0.85,
    clearcoatRoughness: 0.16
  });
  const physicalSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.88, 48, 32),
    physicalMaterial
  );
  physicalSphere.position.set(0, 0.05, 0);
  physicalSphere.castShadow = true;
  physicalSphere.receiveShadow = true;
  group.add(physicalSphere);

  const nodeMaterial = new THREE.MeshStandardNodeMaterial({
    roughness: 0.29,
    metalness: 0.08
  });
  nodeMaterial.colorNode = TSL.mix(
    TSL.vec3(0.025, 0.22, 0.66),
    TSL.vec3(0.96, 0.39, 0.055),
    TSL.uv().x
  );
  const nodeSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.88, 48, 32),
    nodeMaterial
  );
  nodeSphere.position.set(2.1, 0.05, 0);
  nodeSphere.castShadow = true;
  nodeSphere.receiveShadow = true;
  group.add(nodeSphere);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: '#697787',
    roughness: 0.88,
    metalness: 0.02
  });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    floorMaterial
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.91;
  floor.receiveShadow = true;
  nextScene.add(floor);

  const hemisphere = new THREE.HemisphereLight('#c5e0ff', '#3b2b20', 1.05);
  nextScene.add(hemisphere);

  const keyLight = new THREE.DirectionalLight('#fff0d7', 3.0);
  keyLight.position.set(-3.5, 7.5, 4.5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(deviceMemoryGiB >= 6 ? 1024 : 512, deviceMemoryGiB >= 6 ? 1024 : 512);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 24;
  keyLight.shadow.camera.left = -7;
  keyLight.shadow.camera.right = 7;
  keyLight.shadow.camera.top = 7;
  keyLight.shadow.camera.bottom = -7;
  keyLight.shadow.bias = -0.0002;
  keyLight.shadow.normalBias = 0.025;
  nextScene.add(keyLight, keyLight.target);

  return { scene: nextScene, camera: nextCamera, animatedGroup: group };
}

function disposeScene() {
  if (!scene) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const assigned = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of assigned) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
    }
  });

  for (const texture of textures) {
    try { texture.dispose(); } catch (_) {}
  }
  for (const material of materials) {
    try { material.dispose(); } catch (_) {}
  }
  for (const geometry of geometries) {
    try { geometry.dispose(); } catch (_) {}
  }

  scene = null;
  camera = null;
  animatedGroup = null;
}

function disposeRenderer() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (fallbackResizeListener) {
    window.removeEventListener('resize', fallbackResizeListener);
    fallbackResizeListener = null;
  }
  if (pipelineHandle) {
    try { pipelineHandle.dispose(); } catch (_) {}
    pipelineHandle = null;
  }
  if (materialConversion) {
    try { materialConversion.disposeSourceMaterials(); } catch (_) {}
    materialConversion = null;
  }
  if (backendHandle) {
    try { backendHandle.dispose(); } catch (_) {}
    backendHandle = null;
    renderer = null;
  } else if (renderer) {
    try { renderer.setAnimationLoop(null); } catch (_) {}
    try { renderer.dispose(); } catch (_) {}
    renderer = null;
  }
  disposeScene();
  lastFrameTime = 0;
}

function resizeLab() {
  if (!renderer || !camera || !canvasHost) return;
  const bounds = canvasHost.getBoundingClientRect();
  const width = Math.max(1, Math.floor(bounds.width));
  const height = Math.max(1, Math.floor(bounds.height));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

async function runLab(ticket) {
  try {
    if (ticket !== generation || overlay?.hidden) return;
    const memoryGiB = Math.max(1, Number(navigator.deviceMemory) || 4);
    setStatus('共有WebGPUバックエンドを初期化しています…');
    backendHandle = await createPStudioWebGPUBackend({
      canvas,
      antialias: memoryGiB >= 4,
      alpha: false,
      powerPreference: 'low-power'
    });
    renderer = backendHandle.renderer;

    if (ticket !== generation || overlay?.hidden) {
      disposeRenderer();
      return;
    }

    const pixelRatioCap = memoryGiB <= 2 ? 1 : memoryGiB <= 4 ? 1.1 : 1.35;
    renderer.setPixelRatio(Math.min(Number(window.devicePixelRatio) || 1, pixelRatioCap));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;

    const lab = createLabScene(memoryGiB);
    scene = lab.scene;
    camera = lab.camera;
    animatedGroup = lab.animatedGroup;
    materialConversion = convertPStudioScenePBRMaterials(scene);
    resizeLab();

    setStatus('TSL NodeMaterialとRenderPipelineをコンパイルしています…');
    await renderer.compileAsync(scene, camera);

    if (ticket !== generation || overlay?.hidden) {
      disposeRenderer();
      return;
    }

    resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(resizeLab)
      : null;
    resizeObserver?.observe(canvasHost);
    if (!resizeObserver) {
      fallbackResizeListener = resizeLab;
      window.addEventListener('resize', fallbackResizeListener);
    }

    pipelineHandle = createPStudioRenderPipeline(renderer, scene, camera, {
      bloom: { strength: 0.18, radius: 0.22, threshold: 0.82 }
    });

    renderer.setAnimationLoop((time) => {
      if (renderer !== backendHandle?.renderer || !scene || !camera || !pipelineHandle) return;
      const elapsed = lastFrameTime ? Math.min(0.05, Math.max(0, (time - lastFrameTime) / 1000)) : 0;
      lastFrameTime = time;
      if (animatedGroup) animatedGroup.rotation.y += elapsed * 0.16;
      pipelineHandle.render();
    });

    setStatus('共有WebGPUバックエンド／TSL NodeMaterial／RenderPipeline／Bloomを実行中です。', 'success');
  } catch (error) {
    if (ticket === generation) {
      disposeRenderer();
      const message = String(error?.message || error || 'Unknown WebGPU initialization error');
      setStatus('WebGPUラボを起動できませんでした：' + message, 'error');
    }
  }
}

function open() {
  if (!overlay || !canvas || !canvasHost) return Promise.resolve(false);
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  if (renderer) return Promise.resolve(true);
  if (openingPromise) return openingPromise;

  const ticket = ++generation;
  setStatus('検証環境を準備しています…');
  openButton?.setAttribute('aria-expanded', 'true');
  openingPromise = runLab(ticket).finally(() => {
    openingPromise = null;
  });
  return openingPromise;
}

function close() {
  generation += 1;
  disposeRenderer();
  if (overlay) {
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
  }
  openButton?.setAttribute('aria-expanded', 'false');
  setStatus('未起動 — WebGPUラボは必要なときだけ起動します。');
}

function initialize() {
  if (!openButton || !overlay || !canvas || !canvasHost || !closeButton) return false;
  openButton.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) close();
  });
  window.PStudioWebGPULab = Object.freeze({
    open,
    close,
    getState: () => ({
      active: !!renderer,
      backend: renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'inactive',
      pipeline: pipelineHandle?.getState?.().pipeline || null,
      nodeMaterials: materialConversion?.convertedMaterials || 0,
      threeRevision: String(THREE.REVISION || 'unknown')
    })
  });
  return true;
}

