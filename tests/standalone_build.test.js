const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const buildSource = fs.readFileSync(path.join(root, 'static', 'pstudio_build.js'), 'utf8');
const playerSource = fs.readFileSync(path.join(root, 'static', 'pstudio_player.js'), 'utf8');
const playerHTML = fs.readFileSync(path.join(root, 'static', 'pstudio_player.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');

function createBuild() {
  const window = { location: { origin: 'https://example.test' } };
  vm.runInNewContext(buildSource, {
    window, Blob, TextEncoder, Promise, Date, Uint8Array, DataView,
    BigInt, Number, String, Math, Object, Array, Map, Set, TypeError,
    RangeError, Error, fetch: async () => { throw new Error('unexpected fetch in zip unit test'); }
  });
  return window.PStudioBuild;
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

test('standalone player module remains syntactically valid as an ES module source', () => {
  const source = playerSource.replaceAll('import.meta.url', '"https://example.test/static/pstudio_player.js"');
  assert.doesNotThrow(() => new Function(source));
});

test('standalone ZIP64 writer stores UTF-8 files, CRC32 and ZIP64 metadata correctly', async () => {
  const build = createBuild();
  assert.equal(await build.crc32Blob(new Blob(['123456789'])), 0xCBF43926);
  const progress = [];
  const zip = await build.createZip64([
    { name: 'index.html', blob: new Blob(['<h1>Game</h1>'], { type: 'text/html' }) },
    { name: 'assets/木.glb', blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'model/gltf-binary' }) }
  ], detail => progress.push(detail));
  assert.ok(progress.some(detail => detail.stage === 'checksum'));
  assert.ok(progress.some(detail => detail.stage === 'archive'));
  assert.equal(zip.type, 'application/zip');
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.equal(readU32(bytes, 0), 0x04034B50);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const firstName = new TextDecoder().decode(bytes.slice(30, 30 + nameLength));
  assert.equal(firstName, 'index.html');
  const firstExtra = 30 + nameLength;
  assert.equal(view.getUint16(firstExtra, true), 0x0001);
  const dataStart = firstExtra + extraLength;
  assert.equal(new TextDecoder().decode(bytes.slice(dataStart, dataStart + 13)), '<h1>Game</h1>');
  assert.ok(bytes.some((_, index) => index + 3 < bytes.length && readU32(bytes, index) === 0x06064B50));
  assert.ok(bytes.some((_, index) => index + 3 < bytes.length && readU32(bytes, index) === 0x07064B50));
  assert.ok(bytes.some((_, index) => index + 3 < bytes.length && readU32(bytes, index) === 0x06054B50));
});

test('ZIP64 package can be extracted by the standard Python zipfile implementation', async (t) => {
  const build = createBuild();
  const archive = await build.createZip64([
    { name: 'index.html', blob: new Blob(['<!doctype html><title>Standalone</title>']) },
    { name: 'assets/scene.glb', blob: new Blob([new Uint8Array([0, 1, 2, 3, 254, 255])]) }
  ]);
  const python = String.raw`import io, json, sys, zipfile
data = sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
    assert archive.namelist() == ["index.html", "assets/scene.glb"]
    assert archive.read("index.html") == b"<!doctype html><title>Standalone</title>"
    assert archive.read("assets/scene.glb") == bytes([0, 1, 2, 3, 254, 255])
    assert archive.testzip() is None
print("zip64 extraction verified")`;
  const result = spawnSync('python', ['-c', python], { input: Buffer.from(await archive.arrayBuffer()), encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return t.skip('Python is unavailable in this environment.');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /zip64 extraction verified/);
});

test('standalone ZIP64 writer rejects path traversal and duplicate entry names', async () => {
  const build = createBuild();
  await assert.rejects(build.createZip64([{ name: '../secret.txt', blob: new Blob(['x']) }]), /Unsafe ZIP entry path/);
  await assert.rejects(build.createZip64([
    { name: 'same.txt', blob: new Blob(['one']) },
    { name: 'same.txt', blob: new Blob(['two']) }
  ]), /Duplicate ZIP entry/);
});

test('standalone player uses prevalidated browser ASTs and does not require editor or game-prepare routes', () => {
  assert.match(playerSource, /PStudioPlayerManifest/);
  assert.match(playerSource, /assetFiles/);
  assert.match(playerSource, /PStudioAssetStore/);
  assert.doesNotMatch(playerSource, /fetch\(['"]\/game\/prepare/);
  assert.match(engine, /window\.PStudioPlayerManifest\?\.scripts/);
  assert.match(engine, /data=\{success:true,scripts:window\.PStudioPlayerManifest\.scripts\}/);
  assert.match(playerHTML, /pstudio_player\.js/);
  const editorHTML = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  assert.ok(editorHTML.includes('window.PStudioBuild?.exportStandalone?.()'));
  assert.ok(editorHTML.includes('id="asset-storage-info"'));
  assert.ok(editorHTML.includes('value!==null&&value!==undefined'));
  assert.ok(editorHTML.includes('pstudio_assets.js?v=20261121-step5-opfs2'));
  assert.ok(editorHTML.includes('pstudio_build.js?v=20261121-step5-build2'));
  assert.doesNotMatch(playerHTML, /ide-shell|editor-panel|inspector-content/);
});

test('standalone page includes touch controls and the 3D renderer resolves workers relative to package root', () => {
  for (const id of ['game-canvas', 'game-3d-canvas', 'game-hud-canvas', 'game-ui-overlay', 'touch-controls', 'touch-joystick', 'touch-jump']) {
    assert.ok(playerHTML.includes('id="' + id + '"'), id);
  }
  assert.match(renderer, /window\.PStudioStaticBase\|\|'/);
  assert.match(renderer, /pstudio_gltf_worker\.js/);
});
