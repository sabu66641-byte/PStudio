const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('templates/index.html', 'utf8');
const start = html.indexOf('const PSTUDIO_MAX_GLB_BYTES=');
const end = html.indexOf('async function importGLTFFile', start);
assert.ok(start >= 0 && end > start, 'GLB import validator source must exist');
const validatorSource = html.slice(start, end);

function createGLB(jsonObject, binary = new Uint8Array([1, 2, 3, 4])) {
  const jsonText = JSON.stringify(jsonObject);
  const jsonPadding = (4 - (new TextEncoder().encode(jsonText).length % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(jsonText + ' '.repeat(jsonPadding));
  const binPadding = (4 - (binary.length % 4)) % 4;
  const binBytes = new Uint8Array(binary.length + binPadding);
  binBytes.set(binary);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.length;
  view.setUint32(binHeader, binBytes.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  output.set(binBytes, binHeader + 8);
  return new Blob([output], { type: 'model/gltf-binary' });
}

function makeValidator() {
  const window = { dispatchEvent() {} };
  const getValidator = new Function('window', 'TextDecoder', 'CustomEvent',
    validatorSource + '; return { validateGLBFile, PSTUDIO_MAX_GLB_BYTES };');
  return getValidator(window, TextDecoder, undefined);
}

test('staged GLB validator accepts a valid file and reports useful resource estimates', async () => {
  const { validateGLBFile } = makeValidator();
  const blob = createGLB({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0
  });
  const info = await validateGLBFile(blob);
  assert.equal(info.sourceBytes, blob.size);
  assert.equal(info.geometryBytes, 4);
  assert.equal(info.nodeCount, 1);
  assert.equal(info.meshCount, 1);
  assert.equal(info.triangleCount, 1);
  assert.ok(info.estimatedRuntimeBytes > blob.size);
  assert.ok(info.estimatedCpuBytes > blob.size);
});

test('staged GLB validation reads only the header and JSON, not the full BIN payload', async () => {
  const { validateGLBFile } = makeValidator();
  const blob = createGLB({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4 * 1024 * 1024 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 * 1024 * 1024 }],
    accessors: [], meshes: [], nodes: [], scenes: [{ nodes: [] }], scene: 0
  }, new Uint8Array(4 * 1024 * 1024));
  const reads = [];
  const file = {
    name: 'large.glb',
    size: blob.size,
    slice(a, b) {
      reads.push([a, b]);
      const part = blob.slice(a, b);
      return { arrayBuffer: () => part.arrayBuffer() };
    }
  };
  await validateGLBFile(file);
  const binDataStart = reads.find(([a, b]) => b - a === 8 && a > 12)[1] + 8;
  assert.equal(reads.some(([a, b]) => a >= binDataStart && b > binDataStart), false);
});

test('staged validator rejects incorrect GLB headers and mismatched declared lengths', async () => {
  const { validateGLBFile } = makeValidator();
  const good = createGLB({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], bufferViews: [{ byteOffset: 0, byteLength: 4 }] });
  const bytes = new Uint8Array(await good.arrayBuffer());
  bytes[0] = 0;
  await assert.rejects(validateGLBFile(new Blob([bytes])), /マジック番号/);
  const wrongLength = new Uint8Array(await good.arrayBuffer());
  new DataView(wrongLength.buffer).setUint32(8, wrongLength.length - 4, true);
  await assert.rejects(validateGLBFile(new Blob([wrongLength])), /一致しません/);
});

test('GLB maximum is exactly one GiB and oversize files are rejected before reading', async () => {
  const { validateGLBFile, PSTUDIO_MAX_GLB_BYTES } = makeValidator();
  assert.equal(PSTUDIO_MAX_GLB_BYTES, 1024 * 1024 * 1024);
  const fake = { size: PSTUDIO_MAX_GLB_BYTES + 1, slice() { throw new Error('should not read'); } };
  await assert.rejects(validateGLBFile(fake), /1GB/);
});

test('GLB validator rejects external resources and out-of-range buffer views', async () => {
  const { validateGLBFile } = makeValidator();
  const external = createGLB({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4, uri: 'scene.bin' }],
    bufferViews: [{ byteOffset: 0, byteLength: 4 }]
  });
  await assert.rejects(validateGLBFile(external), /外部バッファ/);
  const outOfRange = createGLB({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4 }],
    bufferViews: [{ byteOffset: 2, byteLength: 4 }]
  });
  await assert.rejects(validateGLBFile(outOfRange), /範囲外/);
});


test('external .gltf bundling remains capped separately to avoid giant base64 copies',()=>{
  assert.ok(html.includes('const PSTUDIO_MAX_GLTF_BYTES=30*1024*1024'));
  assert.ok(html.includes("if(file.size>PSTUDIO_MAX_GLTF_BYTES)"));
  assert.ok(html.includes('大容量モデルは.glbで読み込んでください。'));
});
