'use strict';

const MAX_GLB_BYTES = 0xFFFFFFFF;
const GLB_JSON_LIMIT = 32 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

async function imageDimensions(file, binStart, view, name) {
  const maxRead = Math.min(128 * 1024, Math.max(0, Number(view.byteLength) || 0));
  if (!maxRead) return null;
  const bytes = new Uint8Array(await file.slice(
    binStart + (Number(view.byteOffset) || 0),
    binStart + (Number(view.byteOffset) || 0) + maxRead
  ).arrayBuffer());

  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i <= Math.min(64, bytes.length - 24); i++) {
    let match = true;
    for (let k = 0; k < 8; k++) {
      if (bytes[i + k] !== png[k]) { match = false; break; }
    }
    if (match) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + i, bytes.length - i);
      return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
    }
  }

  let jpg = -1;
  for (let i = 0; i < Math.min(64, bytes.length - 1); i++) {
    if (bytes[i] === 255 && bytes[i + 1] === 216) { jpg = i; break; }
  }
  if (jpg >= 0) {
    let p = jpg + 2;
    while (p + 8 < bytes.length) {
      if (bytes[p] !== 255) { p++; continue; }
      while (p < bytes.length && bytes[p] === 255) p++;
      if (p >= bytes.length) break;
      const marker = bytes[p++];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > bytes.length) break;
      const length = (bytes[p] << 8) | bytes[p + 1];
      if (length < 2) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && p + 7 <= bytes.length) {
        return { width: (bytes[p + 5] << 8) | bytes[p + 6], height: (bytes[p + 3] << 8) | bytes[p + 4] };
      }
      p += length;
    }
  }

  const hint = String(name || '').toLowerCase();
  const dimension = /8k/.test(hint) ? 8192 : /4k/.test(hint) ? 4096 : /2k/.test(hint) ? 2048 : /1k/.test(hint) ? 1024 : 0;
  return dimension ? { width: dimension, height: dimension, inferred: true } : null;
}

async function inspectGLB(file) {
  if (!file || typeof file.slice !== 'function') fail('GLBファイルを読み込めません。');
  if (file.size < 20) fail('GLBファイルが短すぎます。');
  if (file.size > MAX_GLB_BYTES) fail('GLBの上限は4GiB未満です。');

  const header = await file.slice(0, 12).arrayBuffer();
  if (header.byteLength !== 12) fail('GLBヘッダーが不足しています');
  const head = new DataView(header);
  const magic = head.getUint32(0, true);
  const version = head.getUint32(4, true);
  const totalLength = head.getUint32(8, true);
  if (magic !== 0x46546c67) fail('GLBマジック番号が正しくありません');
  if (version !== 2) fail('GLB 2.0形式のみ対応しています');
  if (totalLength !== file.size) fail('GLBヘッダーのファイル長と実際のサイズが一致しません。ファイルを再コピーしてください。');

  let offset = 12;
  let jsonChunk = null;
  let jsonLength = 0;
  let binStart = 0;
  let binLength = 0;
  let chunkCount = 0;
  let seenJSON = false;

  while (offset < totalLength) {
    const chunkHeader = await file.slice(offset, offset + 8).arrayBuffer();
    if (chunkHeader.byteLength !== 8) fail('GLBチャンクヘッダーが途中で切れています。');
    const view = new DataView(chunkHeader);
    const length = view.getUint32(0, true);
    const type = view.getUint32(4, true);
    const dataStart = offset + 8;
    const end = dataStart + length;
    if (length === 0 || length % 4 !== 0 || end > totalLength) fail('GLBチャンクのサイズまたは境界が不正です。');
    chunkCount++;
    if (chunkCount > 4096) fail('GLBのチャンク数が上限4096を超えています。');
    if (chunkCount === 1 && type !== 0x4e4f534a) fail('GLBの先頭チャンクがJSONではありません。');

    if (type === 0x4e4f534a) {
      if (seenJSON || length > GLB_JSON_LIMIT) fail('GLBのJSONチャンクが重複、または32MBを超えています。');
      seenJSON = true;
      jsonLength = length;
      const jsonBuffer = await file.slice(dataStart, end).arrayBuffer();
      const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(jsonBuffer).replace(/[\u0000\s]+$/g, '');
      try { jsonChunk = JSON.parse(jsonText); }
      catch (error) { fail('GLBのJSONチャンクを解析できません: ' + (error?.message || String(error))); }
    } else if (type === 0x004e4942) {
      if (binLength) fail('GLBにBINチャンクが複数あります。');
      binStart = dataStart;
      binLength = length;
    }
    offset = end;
  }

  if (offset !== totalLength || !jsonChunk) fail('GLBのチャンク構造が不完全です。');
  if (!jsonChunk.asset || !String(jsonChunk.asset.version || '').startsWith('2.')) fail('glTF 2.0アセット情報がありません。');
  if ((jsonChunk.buffers || []).length > 1) fail('GLBに複数の内部バッファがあります。外部依存を同梱したGLBにしてください。');
  if ((jsonChunk.buffers || []).some(buffer => buffer.uri && !String(buffer.uri).startsWith('data:'))) fail('GLBが外部バッファを参照しています。外部依存ファイルを同梱して再出力してください。');
  if ((jsonChunk.images || []).some(image => image.uri && !String(image.uri).startsWith('data:'))) fail('GLBが外部画像を参照しています。テクスチャをGLB内に埋め込んで再出力してください。');

  const declaredBuffer = Number(jsonChunk.buffers?.[0]?.byteLength) || 0;
  if (declaredBuffer > binLength) fail('BINチャンクがbuffer.byteLengthより短く、GLBが破損している可能性があります。');
  const bufferViews = jsonChunk.bufferViews || [];
  for (let i = 0; i < bufferViews.length; i++) {
    const item = bufferViews[i];
    const start = Number(item.byteOffset) || 0;
    const length = Number(item.byteLength);
    if (!Number.isSafeInteger(length) || length < 0 || start < 0 || start + length > declaredBuffer) {
      fail('bufferView ' + i + ' がBINバッファの範囲外です。');
    }
  }

  const imageViews = new Set();
  for (const image of jsonChunk.images || []) {
    if (Number.isInteger(image.bufferView)) {
      if (!bufferViews[image.bufferView]) fail('画像のbufferView参照が不正です。');
      imageViews.add(image.bufferView);
    }
  }

  let geometryBytes = 0;
  let compressedImageBytes = 0;
  let decodedTextureBytes = 0;
  for (let i = 0; i < bufferViews.length; i++) {
    const length = Number(bufferViews[i].byteLength) || 0;
    if (imageViews.has(i)) compressedImageBytes += length;
    else geometryBytes += length;
  }

  for (const image of jsonChunk.images || []) {
    const item = Number.isInteger(image.bufferView) ? bufferViews[image.bufferView] : null;
    if (!item || !binLength) continue;
    const dimensions = await imageDimensions(file, binStart, item, image.name);
    if (dimensions?.width && dimensions?.height) {
      const width = Math.min(16384, dimensions.width);
      const height = Math.min(16384, dimensions.height);
      decodedTextureBytes += width * height * 4 * 1.34;
    } else {
      decodedTextureBytes += Math.max(4 * 1024 * 1024, (item.byteLength || 0) * 8);
    }
  }

  const estimatedCpuBytes = Math.ceil(file.size * 0.72 + geometryBytes * 1.8 + 96 * 1024 * 1024);
  const estimatedGpuBytes = Math.ceil(geometryBytes * 1.15 + decodedTextureBytes);
  const estimatedRuntimeBytes = Math.ceil(file.size * 0.72 + geometryBytes * 1.8 + decodedTextureBytes * 1.28 + 96 * 1024 * 1024);
  const triangles = (jsonChunk.meshes || []).reduce((sum, mesh) =>
    sum + (mesh.primitives || []).reduce((subtotal, primitive) => {
      const index = Number.isInteger(primitive.indices) ? jsonChunk.accessors?.[primitive.indices]?.count : 0;
      const position = primitive.attributes?.POSITION;
      const vertices = Number.isInteger(position) ? jsonChunk.accessors?.[position]?.count : 0;
      const mode = primitive.mode === undefined ? 4 : primitive.mode;
      return subtotal + (mode === 4 ? (index || vertices) / 3 : 0);
    }, 0), 0);

  return {
    sourceBytes: file.size,
    binBytes: binLength,
    jsonBytes: jsonLength,
    geometryBytes,
    compressedImageBytes,
    decodedTextureBytes: Math.ceil(decodedTextureBytes),
    estimatedCpuBytes,
    estimatedGpuBytes,
    estimatedRuntimeBytes,
    nodeCount: (jsonChunk.nodes || []).length,
    meshCount: (jsonChunk.meshes || []).length,
    materialCount: (jsonChunk.materials || []).length,
    imageCount: (jsonChunk.images || []).length,
    triangleCount: Math.floor(triangles),
    animationCount: (jsonChunk.animations || []).length,
    chunkCount
  };
}

self.onmessage = async event => {
  const message = event.data || {};
  if (!Number.isSafeInteger(message.id)) return;
  try {
    if (message.op !== 'inspect-glb') fail('Unknown model worker operation.');
    const result = await inspectGLB(message.file);
    self.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: String(error?.message || error) });
  }
};
