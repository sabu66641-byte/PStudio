/* PStudio Standalone Build Exporter.
 * Produces a ZIP64 web-game package without converting binary model assets to base64.
 */
(() => {
  'use strict';

  const ZIP32_SENTINEL = 0xFFFFFFFF;
  const ZIP16_SENTINEL = 0xFFFF;
  const STATIC_RUNTIME_FILES = [
    'pstudio_player.js',
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
    'pstudio_ecs.js',
    'pstudio_gltf_worker.js'
  ];
  const encoder = new TextEncoder();
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function updateCRC(crc, bytes) {
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return crc >>> 0;
  }

  async function crc32Blob(blob, onProgress) {
    if (!blob || !Number.isFinite(Number(blob.size))) throw new TypeError('ZIP entry must be a Blob or File.');
    let crc = 0xFFFFFFFF;
    let processed = 0;
    if (typeof blob.stream === 'function') {
      const reader = blob.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          crc = updateCRC(crc, value);
          processed += value.byteLength;
          onProgress?.(processed, blob.size);
        }
      } finally {
        try { reader.releaseLock?.(); } catch (_) {}
      }
    } else {
      const chunkSize = 1024 * 1024;
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer());
        crc = updateCRC(crc, bytes);
        processed += bytes.byteLength;
        onProgress?.(processed, blob.size);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function zipNameBytes(name) {
    const value = String(name || '');
    if (!value || value.startsWith('/') || value.includes('\\') ||
        value.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new TypeError('Unsafe ZIP entry path: ' + value);
    }
    return encoder.encode(value);
  }

  function localHeader(nameBytes, crc, size) {
    const extraLength = 20;
    const header = new Uint8Array(30 + nameBytes.length + extraLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034B50, true);
    view.setUint16(4, 45, true);
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, 0, true); // STORE: preserve already-compressed GLB/PNG/JPEG data
    view.setUint16(10, 0, true); // DOS time
    view.setUint16(12, 0x0021, true); // 1980-01-01
    view.setUint32(14, crc, true);
    view.setUint32(18, ZIP32_SENTINEL, true);
    view.setUint32(22, ZIP32_SENTINEL, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, extraLength, true);
    header.set(nameBytes, 30);
    const extra = 30 + nameBytes.length;
    view.setUint16(extra, 0x0001, true);
    view.setUint16(extra + 2, 16, true);
    view.setBigUint64(extra + 4, size, true);
    view.setBigUint64(extra + 12, size, true);
    return header;
  }

  function centralHeader(nameBytes, crc, size, localOffset) {
    const extraLength = 28;
    const header = new Uint8Array(46 + nameBytes.length + extraLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014B50, true);
    view.setUint16(4, 45, true);
    view.setUint16(6, 45, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0x0021, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, ZIP32_SENTINEL, true);
    view.setUint32(24, ZIP32_SENTINEL, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, extraLength, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, ZIP32_SENTINEL, true);
    header.set(nameBytes, 46);
    const extra = 46 + nameBytes.length;
    view.setUint16(extra, 0x0001, true);
    view.setUint16(extra + 2, 24, true);
    view.setBigUint64(extra + 4, size, true);
    view.setBigUint64(extra + 12, size, true);
    view.setBigUint64(extra + 20, localOffset, true);
    return header;
  }

  function zip64End(entryCount, centralSize, centralOffset) {
    const end64 = new Uint8Array(56);
    const view64 = new DataView(end64.buffer);
    view64.setUint32(0, 0x06064B50, true);
    view64.setBigUint64(4, 44n, true);
    view64.setUint16(12, 45, true);
    view64.setUint16(14, 45, true);
    view64.setUint32(16, 0, true);
    view64.setUint32(20, 0, true);
    view64.setBigUint64(24, BigInt(entryCount), true);
    view64.setBigUint64(32, BigInt(entryCount), true);
    view64.setBigUint64(40, centralSize, true);
    view64.setBigUint64(48, centralOffset, true);

    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);
    locatorView.setUint32(0, 0x07064B50, true);
    locatorView.setUint32(4, 0, true);
    locatorView.setBigUint64(8, centralOffset + centralSize, true);
    locatorView.setUint32(16, 1, true);

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054B50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, ZIP16_SENTINEL, true);
    endView.setUint16(10, ZIP16_SENTINEL, true);
    endView.setUint32(12, ZIP32_SENTINEL, true);
    endView.setUint32(16, ZIP32_SENTINEL, true);
    endView.setUint16(20, 0, true);
    return [end64, locator, end];
  }

  async function createZip64(entries, onProgress) {
    if (!Array.isArray(entries) || !entries.length) throw new TypeError('At least one ZIP entry is required.');
    if (entries.length > ZIP16_SENTINEL) throw new RangeError('Too many files for this game package.');
    const names = new Set();
    const parts = [];
    const centralParts = [];
    let offset = 0n;
    let completed = 0;
    for (const entry of entries) {
      const nameBytes = zipNameBytes(entry.name);
      const blob = entry.blob instanceof Blob ? entry.blob : new Blob([entry.blob ?? '']);
      if (names.has(String(entry.name))) throw new Error('Duplicate ZIP entry: ' + entry.name);
      names.add(String(entry.name));
      const size = BigInt(blob.size);
      const crc = await crc32Blob(blob, (processed, total) => onProgress?.({ stage: 'checksum', name: entry.name, processed, total }));
      const header = localHeader(nameBytes, crc, size);
      const localOffset = offset;
      parts.push(header, blob);
      offset += BigInt(header.byteLength) + size;
      const central = centralHeader(nameBytes, crc, size, localOffset);
      centralParts.push(central);
      completed++;
      onProgress?.({ stage: 'archive', completed, total: entries.length, name: entry.name });
    }
    const centralOffset = offset;
    let centralSize = 0n;
    for (const part of centralParts) {
      parts.push(part);
      centralSize += BigInt(part.byteLength);
    }
    parts.push(...zip64End(entries.length, centralSize, centralOffset));
    return new Blob(parts, { type: 'application/zip' });
  }

  function safeAssetFilename(name, index) {
    const base = String(name || 'asset').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 96) || 'asset';
    return 'assets/' + String(index).padStart(4, '0') + '-' + base;
  }

  async function fetchRuntimeFile(name) {
    const url = new URL('/static/' + name, window.location.origin);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not package runtime file ' + name + ' (' + response.status + ').');
    return response.blob();
  }

  async function buildEntries() {
    if (typeof projectFiles === 'undefined' || typeof projectAssets === 'undefined' ||
        typeof sceneObjects === 'undefined' || typeof sceneEnvironment === 'undefined') {
      throw new Error('The PStudio project is not available in this page.');
    }
    if (window.PStudioEngine?.isRunning?.()) throw new Error('Stop Play before building a standalone game.');
    if (!window.PStudioAssetStore) throw new Error('Persistent asset storage is unavailable.');

    if (typeof saveActiveProjectFile === 'function') saveActiveProjectFile(false);
    const sourceFiles = JSON.parse(JSON.stringify(projectFiles));
    const objects = JSON.parse(JSON.stringify(sceneObjects));
    const attachedObjects = objects.filter(object => typeof object.script === 'string' && object.script);
    if (!attachedObjects.length) throw new Error('Attach at least one .ps game script to a Scene Object before exporting.');
    for (const object of attachedObjects) {
      if (!sourceFiles[object.script] || sourceFiles[object.script].type !== 'ps') {
        throw new Error('Scene Object "' + String(object.name || object.id) + '" refers to a missing .ps script: ' + object.script);
      }
    }
    const scripts = {};
    for (const [name, file] of Object.entries(sourceFiles)) if (file?.type === 'ps') scripts[name] = String(file.content || '');
    if (!Object.keys(scripts).length) throw new Error('No .ps scripts were found in the project.');

    if (typeof setOutput === 'function') setOutput('Validating .ps game scripts for the standalone build…', 'info');
    const validationResponse = await fetch('/game/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scripts })
    });
    const validation = await validationResponse.json().catch(() => null);
    if (!validationResponse.ok || !validation?.success || !validation.scripts) {
      throw new Error(validation?.error || 'Game script validation failed (HTTP ' + validationResponse.status + ').');
    }

    const assetMetadata = {};
    const assetFiles = {};
    const exportedAssets = JSON.parse(JSON.stringify(projectAssets));
    const entries = [];
    const modelAssets = exportedAssets.filter(asset => asset.kind === 'model');
    let assetIndex = 0;
    for (const asset of modelAssets) {
      const blob = await window.PStudioAssetStore.get(asset.name, { cache: false });
      if (!blob) throw new Error('Missing model asset in persistent storage: ' + asset.name);
      const relativePath = safeAssetFilename(asset.name, ++assetIndex);
      entries.push({ name: relativePath, blob });
      assetFiles[asset.name] = relativePath;
      assetMetadata[asset.name] = await window.PStudioAssetStore.getMetadata?.(asset.name) || {
        estimatedRuntimeBytes: Number(asset.estimatedRuntimeBytes) || Number(asset.size) || blob.size,
        estimatedCpuBytes: Number(asset.estimatedCpuBytes) || Number(asset.size) || blob.size
      };
      asset.storage = 'package';
      asset.size = blob.size;
    }

    const manifest = {
      format: 'pstudio-standalone',
      version: 1,
      title: String(document.getElementById('project-name')?.textContent || 'PStudio Game').trim(),
      createdAt: new Date().toISOString(),
      scripts: validation.scripts,
      projectFiles: sourceFiles,
      projectAssets: exportedAssets,
      sceneObjects: objects,
      sceneEnvironment: JSON.parse(JSON.stringify(sceneEnvironment || { preset: 'day' })),
      activeProjectFile: typeof activeProjectFile === 'string' ? activeProjectFile : 'main.ps',
      assetFiles,
      assetMetadata,
      viewMode: 'auto'
    };
    entries.unshift({ name: 'game.json', blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }) });

    const playerPage = await fetchRuntimeFile('pstudio_player.html');
    entries.unshift({ name: 'index.html', blob: playerPage });
    const runtimeBlobs = await Promise.all(STATIC_RUNTIME_FILES.map(async name => ({
      name: 'static/' + name,
      blob: await fetchRuntimeFile(name)
    })));
    entries.push(...runtimeBlobs);
    const readme = [
      'PStudio standalone Web Game',
      '',
      '1. Extract this archive to a folder.',
      '2. Upload the folder to a static web host (or serve it from a local HTTP server).',
      '3. Open index.html through HTTP(S). Do not open it as file:// because browser module workers and fetch require an origin.',
      '',
      'The game runs the bundled, prevalidated browser AST and does not require the PStudio editor or /game/prepare endpoint.',
      'Three.js and selected rendering add-ons are loaded from their public CDN URLs, so a network connection is required for 3D features.'
    ].join('\n');
    entries.push({ name: 'README.txt', blob: new Blob([readme], { type: 'text/plain' }) });
    return entries;
  }

  let activeBuild = false;
  async function exportStandalone() {
    if (activeBuild) return false;
    activeBuild = true;
    const button = document.getElementById('standalone-export-button');
    if (button) button.disabled = true;
    try {
      if (typeof setOutput === 'function') setOutput('Preparing standalone Web build…', 'info');
      const entries = await buildEntries();
      if (typeof setOutput === 'function') setOutput('Packing ' + entries.length + ' files into a ZIP64 archive…', 'info');
      const archive = await createZip64(entries, detail => {
        if (detail.stage === 'archive' && typeof setOutput === 'function') {
          setOutput('Packaging ' + detail.completed + '/' + detail.total + ': ' + detail.name, 'info');
        }
      });
      const url = URL.createObjectURL(archive);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = url;
      link.download = 'PStudio-Web-Game-' + stamp + '.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (typeof setOutput === 'function') setOutput('Standalone Web build created (' + (archive.size / 1024 / 1024).toFixed(1) + ' MiB). Extract it and host index.html over HTTP(S).', 'success');
      if (typeof toast === 'function') toast('Standalone Web build exported');
      return true;
    } catch (error) {
      const message = String(error?.message || error);
      if (typeof setOutput === 'function') setOutput('Standalone build failed: ' + message, 'error');
      if (typeof toast === 'function') toast('Web build export failed: ' + message);
      return false;
    } finally {
      activeBuild = false;
      if (button) button.disabled = false;
    }
  }

  window.PStudioBuild = Object.freeze({ exportStandalone, createZip64, crc32Blob, version: '1.0.0' });
})();
