/* PStudio Standalone Web Player.
 * Loads a prevalidated game AST bundle and packaged assets; it does not call the editor or game-prepare server routes.
 */
(() => {
  'use strict';

  const status = document.getElementById('game-status');
  const errors = document.getElementById('player-errors');
  const rootURL = new URL('../', import.meta.url);
  const staticURL = new URL('./', import.meta.url);
  const assetBlobPromises = new Map();

  function report(message, isError = false) {
    if (status) status.textContent = String(message);
    if (isError && errors) {
      errors.hidden = false;
      errors.textContent = String(message);
    }
    if (isError) console.error('[PStudio Player]', message);
  }

  function loadClassicScript(name) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(name, staticURL).href;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error('Runtime module failed to load: ' + name));
      document.body.appendChild(script);
    });
  }

  async function loadThreeRuntime() {
    try {
      report('Loading 3D runtime…');
      const THREE = await import('three');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const SkeletonUtils = await import('three/addons/utils/SkeletonUtils.js');
      window.THREE = THREE;
      window.PStudioGLTFLoader = GLTFLoader;
      window.PStudioSkeletonUtils = SkeletonUtils;

      try { window.PStudioMeshoptDecoder = (await import('three/addons/libs/meshopt_decoder.module.js')).MeshoptDecoder; }
      catch (error) { console.warn('[PStudio Player] Meshopt decoder unavailable:', error); }
      try { window.PStudioKTX2Loader = (await import('three/addons/loaders/KTX2Loader.js')).KTX2Loader; }
      catch (error) { console.warn('[PStudio Player] KTX2 transcoder unavailable:', error); }
      try { window.PStudioDRACOLoader = (await import('three/addons/loaders/DRACOLoader.js')).DRACOLoader; }
      catch (error) { console.warn('[PStudio Player] Draco decoder unavailable:', error); }

      const postFX = {};
      const optional = [
        ['EffectComposer', 'three/addons/postprocessing/EffectComposer.js'],
        ['RenderPass', 'three/addons/postprocessing/RenderPass.js'],
        ['UnrealBloomPass', 'three/addons/postprocessing/UnrealBloomPass.js'],
        ['SSAOPass', 'three/addons/postprocessing/SSAOPass.js'],
        ['OutputPass', 'three/addons/postprocessing/OutputPass.js'],
        ['GTAOPass', 'three/addons/postprocessing/GTAOPass.js'],
        ['TAARenderPass', 'three/addons/postprocessing/TAARenderPass.js'],
        ['SMAAPass', 'three/addons/postprocessing/SMAAPass.js'],
        ['ShaderPass', 'three/addons/postprocessing/ShaderPass.js'],
        ['SSRPass', 'three/addons/postprocessing/SSRPass.js'],
        ['LightProbeGenerator', 'three/addons/lights/LightProbeGenerator.js']
      ];
      for (const [key, specifier] of optional) {
        try {
          const module = await import(specifier);
          postFX[key] = module[key];
        } catch (error) {
          console.warn('[PStudio Player] Optional 3D module unavailable:', key, error);
        }
      }
      window.PStudioPostFX = postFX;
      try { window.PStudioCSM = (await import('three/addons/csm/CSM.js')).CSM; }
      catch (error) { console.warn('[PStudio Player] Cascaded shadows unavailable:', error); }
      try { window.PStudioSimplifyModifier = (await import('three/addons/modifiers/SimplifyModifier.js')).SimplifyModifier; }
      catch (error) { console.warn('[PStudio Player] Automatic mesh LOD unavailable:', error); }
      try {
        const bvh = await import('https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.7.8/build/index.module.js');
        THREE.Mesh.prototype.raycast = bvh.acceleratedRaycast;
        THREE.BufferGeometry.prototype.computeBoundsTree = bvh.computeBoundsTree;
        THREE.BufferGeometry.prototype.disposeBoundsTree = bvh.disposeBoundsTree;
        window.PStudioBVH = bvh;
      } catch (error) { console.warn('[PStudio Player] BVH acceleration unavailable:', error); }
      try { window.PStudioHDRLoader = (await import('three/addons/loaders/RGBELoader.js')).RGBELoader; }
      catch (error) { console.warn('[PStudio Player] HDR loader unavailable:', error); }
      try { window.PStudioReflector = (await import('three/addons/objects/Reflector.js')).Reflector; }
      catch (error) { console.warn('[PStudio Player] Planar reflection unavailable:', error); }
      try { window.PStudioRoomEnvironment = (await import('three/addons/environments/RoomEnvironment.js')).RoomEnvironment; }
      catch (error) { console.warn('[PStudio Player] Studio environment helper unavailable:', error); }

      window.PStudio3DReady = Promise.resolve(true);
      window.dispatchEvent(new Event('pstudio-three-ready'));
      return true;
    } catch (error) {
      window.PStudio3DError = error;
      window.PStudio3DReady = Promise.resolve(false);
      window.dispatchEvent(new Event('pstudio-three-failed'));
      console.warn('[PStudio Player] 3D dependency loading failed; 2D games remain available.', error);
      return false;
    }
  }

  function installProjectGlobals(manifest) {
    window.PStudioPlayerManifest = manifest;
    window.PStudioStaticBase = staticURL.href;
    window.projectFiles = manifest.projectFiles || {};
    window.projectAssets = Array.isArray(manifest.projectAssets) ? manifest.projectAssets : [];
    window.sceneObjects = Array.isArray(manifest.sceneObjects) ? manifest.sceneObjects : [];
    window.sceneEnvironment = manifest.sceneEnvironment || { preset: 'day' };
    window.activeProjectFile = manifest.activeProjectFile || Object.keys(window.projectFiles).find(name => window.projectFiles[name]?.type === 'ps') || '';
    window.selectedObjectId = null;
    window.imageCache = new Map();

    const editor = document.getElementById('code');
    if (editor) {
      editor.value = window.projectFiles[window.activeProjectFile]?.content || '';
      window.codeEditor = editor;
    }
    window.persistProject = () => true;
    window.renderGamePreview = () => {};
    window.switchWorkspaceView = () => true;
    window.setOutput = (value, kind) => {
      report(value, kind === 'error');
    };

    const assetFiles = manifest.assetFiles || {};
    const assetMetadata = manifest.assetMetadata || {};
    window.PStudioAssetStore = {
      async get(name) {
        const key = String(name);
        if (assetBlobPromises.has(key)) return assetBlobPromises.get(key);
        const relativePath = assetFiles[key];
        if (!relativePath) return null;
        const promise = fetch(new URL(relativePath, rootURL), { cache: 'no-store' }).then(response => {
          if (!response.ok) throw new Error('Packaged asset could not be loaded: ' + key + ' (' + response.status + ')');
          return response.blob();
        }).catch(error => {
          assetBlobPromises.delete(key);
          throw error;
        });
        assetBlobPromises.set(key, promise);
        return promise;
      },
      async getStream(name) {
        const blob = await this.get(name);
        return blob?.stream?.() || null;
      },
      async getMetadata(name) { return assetMetadata[String(name)] || null; },
      async getStorageBackend(name) { return assetFiles[String(name)] ? 'package' : null; },
      async getStorageInfo() { return { supported: true, opfsSupported: false, preferredBackend: 'package', persisted: false, usage: null, quota: null, available: null }; },
      async requestPersistentStorage() { return false; },
      async put() { throw new Error('Standalone packages are read-only. Rebuild the game from PStudio to change assets.'); },
      async remove() { throw new Error('Standalone packages are read-only. Rebuild the game from PStudio to change assets.'); },
      maxModelBytes: 0xFFFFFFFF,
      version: 'standalone-1.0.0'
    };
  }

  async function startPlayer() {
    try {
      report('Loading game package…');
      const response = await fetch(new URL('../game.json', import.meta.url), { cache: 'no-store' });
      if (!response.ok) throw new Error('Game package manifest could not be read (' + response.status + ').');
      const manifest = await response.json();
      if (manifest?.format !== 'pstudio-standalone' || manifest?.version !== 1 ||
          !manifest.scripts || typeof manifest.scripts !== 'object' ||
          !manifest.projectFiles || typeof manifest.projectFiles !== 'object') {
        throw new Error('This is not a supported PStudio standalone game package.');
      }
      installProjectGlobals(manifest);
      await loadThreeRuntime();

      const runtimeFiles = [
        'pstudio_events.js',
        'pstudio_platform.js',
        'pstudio_jobs.js',
        'pstudio_resources.js',
        'pstudio_physics.js',
        'pstudio_gameplay.js',
        'pstudio_game_ui.js',
        'pstudio_environment_fx.js',
        'pstudio_scene_environment.js',
        'pstudio_3d_engine.js',
        'pstudio_engine.js',
        'pstudio_modules.js',
        'pstudio_ecs.js'
      ];
      report('Loading game systems…');
      for (const file of runtimeFiles) await loadClassicScript(file);

      document.getElementById('engine-play')?.addEventListener('click', () => window.PStudioEngine?.start?.());
      document.getElementById('engine-stop')?.addEventListener('click', () => window.PStudioEngine?.stop?.());
      document.getElementById('player-title').textContent = String(manifest.title || 'PStudio Game');
      window.setPStudioViewMode?.(manifest.viewMode === '2d' ? '2d' : manifest.viewMode === '3d' ? '3d' : 'auto');
      report('Starting game…');
      await window.PStudioEngine.start();
      if (window.PStudioEngine.isRunning()) report('Running');
      else report('Game did not start. Check that at least one scene object has an attached .ps script.', true);
    } catch (error) {
      report('Game load failed: ' + String(error?.message || error), true);
    }
  }

  window.PStudioPlayerReady = startPlayer();
})();
