import { createPStudioGraphicsMaterial } from './pstudio_graphics_contract.mjs';

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ATTRIBUTE_COMPONENTS = Object.freeze({ positions: 3, normals: 3, uvs: 2 });

function vector(value, length, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== length) throw new TypeError(label + ' must contain exactly ' + length + ' values.');
  const result = Array.from(value, Number);
  if (!result.every(Number.isFinite)) throw new TypeError(label + ' must contain only finite values.');
  return result;
}
function multiplyMatrix4(left, right) {
  const a = vector(left, 16, 'Parent world matrix');
  const b = vector(right, 16, 'Instance local matrix');
  const output = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) value += a[index * 4 + row] * b[column * 4 + index];
      output[column * 4 + row] = value;
    }
  }
  return output;
}
function normalizedComponent(value, array) {
  if (array instanceof Int8Array) return Math.max(-1, value / 127);
  if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) return value / 255;
  if (array instanceof Int16Array) return Math.max(-1, value / 32767);
  if (array instanceof Uint16Array) return value / 65535;
  if (array instanceof Int32Array) return Math.max(-1, value / 2147483647);
  if (array instanceof Uint32Array) return value / 4294967295;
  return value;
}
function readAttribute(attribute, expectedComponents, label) {
  if (!attribute) return null;
  const array = attribute.array || attribute.data?.array;
  if (!ArrayBuffer.isView(array) || array instanceof DataView) throw new TypeError(label + ' must expose a typed array.');
  const itemSize = Number(attribute.itemSize || expectedComponents);
  const count = Number(attribute.count || Math.floor(array.length / itemSize));
  const stride = Number(attribute.data?.stride || itemSize);
  const offset = Number(attribute.offset || 0);
  if (!Number.isSafeInteger(itemSize) || itemSize !== expectedComponents || !Number.isSafeInteger(count) || count < 1 ||
      !Number.isSafeInteger(stride) || stride < itemSize || !Number.isSafeInteger(offset) || offset < 0 ||
      (count - 1) * stride + offset + itemSize > array.length) {
    throw new TypeError(label + ' has an unsupported or inconsistent vertex layout.');
  }
  const result = new Float32Array(count * itemSize);
  for (let vertex = 0; vertex < count; vertex += 1) {
    for (let component = 0; component < itemSize; component += 1) {
      const raw = Number(array[vertex * stride + offset + component]);
      const value = attribute.normalized === true ? normalizedComponent(raw, array) : raw;
      if (!Number.isFinite(value)) throw new TypeError(label + ' contains a non-finite component.');
      result[vertex * itemSize + component] = value;
    }
  }
  return result;
}
function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  const count = indices ? indices.length : positions.length / 3;
  if (count % 3 !== 0) throw new RangeError('Triangle geometry must contain a multiple of three vertices or indices.');
  for (let cursor = 0; cursor < count; cursor += 3) {
    const ia = indices ? indices[cursor] : cursor;
    const ib = indices ? indices[cursor + 1] : cursor + 1;
    const ic = indices ? indices[cursor + 2] : cursor + 2;
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    for (const index of [ia, ib, ic]) { normals[index * 3] += nx; normals[index * 3 + 1] += ny; normals[index * 3 + 2] += nz; }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]);
    if (length > 1e-10) { normals[index] /= length; normals[index + 1] /= length; normals[index + 2] /= length; }
    else normals[index + 1] = 1;
  }
  return normals;
}
function geometryDescriptor(input) {
  const id = String(input.id || '').trim();
  if (!id) throw new TypeError('Geometry id is required.');
  const positions = input.positions instanceof Float32Array ? new Float32Array(input.positions) : Float32Array.from(input.positions || [], Number);
  if (!positions.length || positions.length % 3 || !Array.from(positions).every(Number.isFinite)) throw new TypeError('Geometry positions must be a non-empty finite vec3 array.');
  let indices = null;
  if (input.indices != null) {
    if ((!Array.isArray(input.indices) && !ArrayBuffer.isView(input.indices)) || input.indices instanceof DataView) throw new TypeError('Geometry indices must be an array or typed array.');
    const values = Array.from(input.indices, Number);
    if (!values.length || !values.every(value => Number.isSafeInteger(value) && value >= 0 && value < positions.length / 3)) throw new RangeError('Geometry indices are invalid or out of range.');
    let maximumIndex = 0;
    for (const value of values) if (value > maximumIndex) maximumIndex = value;
    indices = maximumIndex > 65535 ? Uint32Array.from(values) : Uint16Array.from(values);
    if (indices.length % 3) throw new RangeError('Triangle geometry index count must be divisible by three.');
  } else if ((positions.length / 3) % 3) throw new RangeError('Non-indexed triangle geometry vertex count must be divisible by three.');
  const normals = input.normals == null ? computeNormals(positions, indices) : Float32Array.from(input.normals, Number);
  const uvs = input.uvs == null ? new Float32Array((positions.length / 3) * 2) : Float32Array.from(input.uvs, Number);
  if (normals.length !== positions.length || uvs.length !== (positions.length / 3) * 2 ||
      !Array.from(normals).every(Number.isFinite) || !Array.from(uvs).every(Number.isFinite)) {
    throw new TypeError('Geometry normals and UVs must match the position vertex count.');
  }
  const vertexCount = positions.length / 3;
  const tangents = input.tangents == null ? null : Float32Array.from(input.tangents, Number);
  if (tangents && (tangents.length !== vertexCount * 4 || !Array.from(tangents).every(Number.isFinite))) {
    throw new TypeError('Geometry tangents must contain finite vec4 values for every vertex.');
  }
  let jointIndices = null, jointWeights = null;
  if (input.jointIndices != null || input.jointWeights != null) {
    const rawJoints = input.jointIndices;
    if ((!Array.isArray(rawJoints) && !ArrayBuffer.isView(rawJoints)) || rawJoints instanceof DataView ||
        (!Array.isArray(input.jointWeights) && !ArrayBuffer.isView(input.jointWeights)) || input.jointWeights instanceof DataView) {
      throw new TypeError('Geometry skin indices and weights must be array-like.');
    }
    if (rawJoints.length !== vertexCount * 4 || input.jointWeights.length !== vertexCount * 4) {
      throw new RangeError('Geometry skin indices and weights must provide four influences per vertex.');
    }
    const jointValues = Array.from(rawJoints, Number);
    const weightValues = Array.from(input.jointWeights, Number);
    if (!jointValues.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 65535) ||
        !weightValues.every(value => Number.isFinite(value) && value >= 0)) {
      throw new RangeError('Geometry skin indices or weights contain invalid values.');
    }
    jointIndices = Uint16Array.from(jointValues);
    jointWeights = Float32Array.from(weightValues);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const offset = vertex * 4;
      const sum = jointWeights[offset] + jointWeights[offset + 1] + jointWeights[offset + 2] + jointWeights[offset + 3];
      if (!(sum > 1e-8)) throw new RangeError('Each skinned vertex must have a positive total joint weight.');
      for (let influence = 0; influence < 4; influence += 1) jointWeights[offset + influence] /= sum;
    }
  }
  const morphTargets = Object.freeze((input.morphTargets || []).map((target, index) => {
    const morphPositions = target.positions == null ? null : Float32Array.from(target.positions, Number);
    const morphNormals = target.normals == null ? null : Float32Array.from(target.normals, Number);
    if ((!morphPositions && !morphNormals) ||
        (morphPositions && (morphPositions.length !== positions.length || !Array.from(morphPositions).every(Number.isFinite))) ||
        (morphNormals && (morphNormals.length !== normals.length || !Array.from(morphNormals).every(Number.isFinite)))) {
      throw new TypeError('Morph target ' + index + ' must contain finite per-vertex position or normal deltas.');
    }
    return Object.freeze({ positions: morphPositions, normals: morphNormals });
  }));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], positions[index + axis]); max[axis] = Math.max(max[axis], positions[index + axis]); }
  }
  const drawElementCount = indices?.length || positions.length / 3;
  const groups = (input.groups || []).map(group => {
    const start = Number(group.start ?? 0), count = Number(group.count ?? 0), materialIndex = Number(group.materialIndex ?? 0);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1 ||
        start % 3 !== 0 || count % 3 !== 0 ||
        !Number.isSafeInteger(materialIndex) || materialIndex < 0 || start + count > drawElementCount) {
      throw new RangeError('Geometry group range or material index is invalid; triangle groups must align to complete triangles.');
    }
    return Object.freeze({ start, count, materialIndex });
  });
  const orderedGroups = groups.slice().sort((a, b) => a.start - b.start);
  for (let index = 1; index < orderedGroups.length; index += 1) {
    if (orderedGroups[index - 1].start + orderedGroups[index - 1].count > orderedGroups[index].start) {
      throw new RangeError('Geometry material groups cannot overlap.');
    }
  }
  return Object.freeze({
    id, revision: Math.max(1, Math.floor(Number(input.revision) || 1)),
    positions, normals, uvs, tangents, indices, jointIndices, jointWeights, morphTargets,
    vertexCount, indexCount: indices?.length || 0,
    bounds: Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }),
    groups: Object.freeze(groups)
  });
}
function materialDescriptor(input) {
  const id = String(input.id || '').trim();
  if (!id) throw new TypeError('Material id is required.');
  return createPStudioGraphicsMaterial({ ...input, id });
}
function textureDescriptor(input) {
  const id = String(input.id || '').trim();
  const width = Number(input.width), height = Number(input.height);
  if (!id) throw new TypeError('Texture id is required.');
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError('Texture dimensions must be positive integers.');
  }
  const source = input.data;
  if (!(source instanceof Uint8Array) && !(source instanceof Uint8ClampedArray) && !Array.isArray(source)) {
    throw new TypeError('PStudio texture data must be RGBA8 bytes.');
  }
  const data = source instanceof Uint8Array ? new Uint8Array(source)
    : source instanceof Uint8ClampedArray ? Uint8Array.from(source)
    : Uint8Array.from(source, value => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0 || number > 255) throw new RangeError('Texture data values must be integer bytes.');
      return number;
    });
  if (data.length !== width * height * 4) throw new RangeError('RGBA8 texture data length must equal width × height × 4.');
  const addressModes = new Set(['clamp-to-edge', 'repeat', 'mirror-repeat']);
  const filters = new Set(['nearest', 'linear']);
  const addressModeU = String(input.addressModeU || 'repeat');
  const addressModeV = String(input.addressModeV || 'repeat');
  const magFilter = String(input.magFilter || 'linear');
  const minFilter = String(input.minFilter || 'linear');
  if (!addressModes.has(addressModeU) || !addressModes.has(addressModeV)) throw new TypeError('Unsupported PStudio texture address mode.');
  if (!filters.has(magFilter) || !filters.has(minFilter)) throw new TypeError('Unsupported PStudio texture filter.');
  const format = String(input.format || 'rgba8unorm-srgb');
  if (format !== 'rgba8unorm-srgb' && format !== 'rgba8unorm') throw new TypeError('PStudio RGBA8 textures support rgba8unorm-srgb or rgba8unorm.');
  let fingerprint = 2166136261;
  for (const value of data) fingerprint = Math.imul(fingerprint ^ value, 16777619) >>> 0;
  return Object.freeze({
    id, revision: Math.max(1, Math.floor(Number(input.revision) || 1)),
    fingerprint, width, height, data, format, addressModeU, addressModeV, magFilter, minFilter
  });
}
function entityDescriptor(input) {
  const id = String(input.id || '').trim();
  const geometryId = String(input.geometryId || '').trim();
  if (!id || !geometryId) throw new TypeError('Entity id and geometryId are required.');
  const matrix = vector(input.matrixWorld || input.matrix || IDENTITY, 16, 'Entity matrix');
  const materialIds = (input.materialIds || (input.materialId ? [input.materialId] : [])).map(String);
  if (!materialIds.length) throw new TypeError('Entity must reference at least one PStudio material.');
  return Object.freeze({
    id, geometryId, materialIds: Object.freeze(materialIds),
    matrixWorld: Object.freeze(matrix),
    visible: input.visible !== false,
    castShadow: input.castShadow === true,
    receiveShadow: input.receiveShadow === true,
    layers: Math.max(0, Math.floor(Number(input.layers) || 0)),
    sourceObjectId: input.sourceObjectId == null ? null : String(input.sourceObjectId),
    skinId: input.skinId == null ? null : String(input.skinId),
    morphWeights: Object.freeze(Array.from(input.morphWeights || [], (value, index) => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new TypeError('Entity morph weight ' + index + ' must be finite.');
      return number;
    }))
  });
}

function nodeDescriptor(input) {
  const id = String(input.id || '').trim();
  if (!id) throw new TypeError('Scene node id is required.');
  const translation = vector(input.translation || [0, 0, 0], 3, 'Scene node translation');
  const rotation = vector(input.rotation || [0, 0, 0, 1], 4, 'Scene node rotation');
  const scale = vector(input.scale || [1, 1, 1], 3, 'Scene node scale');
  const matrix = vector(input.matrix || IDENTITY, 16, 'Scene node local matrix');
  const worldMatrix = vector(input.worldMatrix || matrix, 16, 'Scene node world matrix');
  return Object.freeze({
    id,
    name: input.name == null ? '' : String(input.name),
    parentId: input.parentId == null ? null : String(input.parentId),
    translation: Object.freeze(translation),
    rotation: Object.freeze(rotation),
    scale: Object.freeze(scale),
    matrix: Object.freeze(matrix),
    worldMatrix: Object.freeze(worldMatrix),
    weights: Object.freeze(Array.from(input.weights || [], (value, index) => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new TypeError('Scene node weight ' + index + ' must be finite.');
      return number;
    }))
  });
}

function skinAssetDescriptor(input) {
  if (input?.kind !== 'pstudio-skin') throw new TypeError('Scene skin must be a PStudio-owned skin descriptor.');
  const id = String(input.id || '').trim();
  const joints = Array.from(input.joints || [], String);
  const inverseBindMatrices = Array.from(input.inverseBindMatrices || [], (matrix, index) => vector(matrix, 16, 'Skin inverse bind matrix ' + index));
  if (!id || !joints.length || joints.length > 256 || new Set(joints).size !== joints.length ||
      joints.some(joint => !joint.trim()) || inverseBindMatrices.length !== joints.length) {
    throw new RangeError('Scene skin joints and inverse bind matrices are inconsistent.');
  }
  return Object.freeze({
    kind: 'pstudio-skin', id,
    joints: Object.freeze(joints),
    inverseBindMatrices: Object.freeze(inverseBindMatrices.map(Object.freeze)),
    skeletonRoot: input.skeletonRoot == null ? null : String(input.skeletonRoot)
  });
}

function animationAssetDescriptor(input) {
  if (input?.kind !== 'pstudio-animation-clip' || !String(input.id || '').trim() || !Array.isArray(input.tracks)) {
    throw new TypeError('Scene animation must be a PStudio-owned animation clip.');
  }
  return input;
}

function sceneVector3Like(value, fallback, label) {
  if (value == null) return fallback.slice();
  const components = Array.isArray(value) || ArrayBuffer.isView(value)
    ? value : [value.x ?? value.r, value.y ?? value.g, value.z ?? value.b];
  return vector(components, 3, label);
}
function sceneScalar(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) throw new RangeError(label + ' must be finite and non-negative.');
  return number;
}
function sceneColor4(value, label) {
  if (value == null) return null;
  const components = Array.isArray(value) || ArrayBuffer.isView(value)
    ? Array.from(value) : [value.r, value.g, value.b, value.a ?? 1];
  if (components.length !== 3 && components.length !== 4) throw new TypeError(label + ' must be RGB or RGBA.');
  const color = components.length === 3 ? [...components, 1] : components;
  if (!color.every(item => Number.isFinite(Number(item)) && Number(item) >= 0 && Number(item) <= 1)) {
    throw new RangeError(label + ' components must be within [0, 1].');
  }
  return Object.freeze({ r: Number(color[0]), g: Number(color[1]), b: Number(color[2]), a: Number(color[3]) });
}
function sceneLightingDescriptor(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Scene lighting must be an object.');
  const lights = (input.lights || []).map((light, index) => {
    const type = String(light.type || '').toLowerCase();
    if (!['directional', 'point', 'spot'].includes(type)) throw new TypeError('Unsupported PStudio scene light type at index ' + index + ': ' + type);
    const color = sceneVector3Like(light.color, [1, 1, 1], 'Scene light color');
    if (color.some(value => value < 0)) throw new RangeError('Scene light color must be non-negative.');
    const intensity = sceneScalar(light.intensity, 1, 'Scene light intensity');
    const position = sceneVector3Like(light.position, [0, 0, 0], 'Scene light position');
    const direction = sceneVector3Like(light.direction, [0, -1, 0], 'Scene light direction');
    const directionLength = Math.hypot(...direction);
    if (type !== 'point' && directionLength < 1e-8) throw new RangeError('Directional and spot light directions must be non-zero.');
    const range = sceneScalar(light.range, 0, 'Scene light range');
    const innerConeCos = Number(light.innerConeCos ?? 0.9);
    const outerConeCos = Number(light.outerConeCos ?? 0.8);
    if (!Number.isFinite(innerConeCos) || !Number.isFinite(outerConeCos) ||
        innerConeCos < -1 || innerConeCos > 1 || outerConeCos < -1 || outerConeCos > 1 ||
        (type === 'spot' && innerConeCos < outerConeCos)) {
      throw new RangeError('Spotlight cone cosines must be within [-1, 1] and innerConeCos must not be below outerConeCos.');
    }
    return Object.freeze({
      type,
      position: Object.freeze(position),
      direction: Object.freeze(directionLength > 1e-8 ? direction.map(value => value / directionLength) : [0, -1, 0]),
      color: Object.freeze(color),
      intensity, range, innerConeCos, outerConeCos
    });
  });
  if (lights.length > 8) throw new RangeError('PStudio direct PBR scene renderer currently supports up to eight additional lights per scene.');
  return Object.freeze({
    sunDirection: Object.freeze(sceneVector3Like(input.sunDirection, [0.35, -0.85, -0.38], 'Scene sun direction')),
    sunColor: Object.freeze(sceneVector3Like(input.sunColor, [1, 0.96, 0.9], 'Scene sun color')),
    sunIntensity: sceneScalar(input.sunIntensity, 3, 'Scene sun intensity'),
    ambientColor: Object.freeze(sceneVector3Like(input.ambientColor, [0.12, 0.15, 0.2], 'Scene ambient color')),
    ambientIntensity: sceneScalar(input.ambientIntensity, 1, 'Scene ambient intensity'),
    lights: Object.freeze(lights)
  });
}

/** Create a Three.js-free scene asset containing only PStudio-owned data. */
export function createPStudioGraphicsSceneAsset(input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new TypeError('PStudio graphics scene asset id is required.');
  const geometries = (input.geometries || []).map(geometryDescriptor);
  const materials = (input.materials || []).map(materialDescriptor);
  const textures = (input.textures || []).map(textureDescriptor);
  const entities = (input.entities || []).map(entityDescriptor);
  const nodes = (input.nodes || []).map(nodeDescriptor);
  const skins = (input.skins || []).map(skinAssetDescriptor);
  const animations = (input.animations || []).map(animationAssetDescriptor);
  const clearColor = sceneColor4(input.clearColor, 'Scene clear color');
  const lighting = sceneLightingDescriptor(input.lighting);
  const geometryIds = new Set(), materialIds = new Set(), textureIds = new Set();
  for (const geometry of geometries) {
    if (geometryIds.has(geometry.id)) throw new Error('Duplicate geometry id: ' + geometry.id);
    geometryIds.add(geometry.id);
  }
  for (const material of materials) {
    if (materialIds.has(material.id)) throw new Error('Duplicate material id: ' + material.id);
    materialIds.add(material.id);
  }
  for (const texture of textures) {
    if (textureIds.has(texture.id)) throw new Error('Duplicate texture id: ' + texture.id);
    textureIds.add(texture.id);
  }
  for (const material of materials) {
    if (material.baseColorTextureId && !textureIds.has(material.baseColorTextureId)) {
      throw new Error('Material references an unknown base-color texture: ' + material.baseColorTextureId);
    }
  }
  const nodeIds = new Set(nodes.map(node => node.id));
  if (nodeIds.size !== nodes.length) throw new Error('Scene node ids must be unique.');
  for (const node of nodes) {
    if (node.parentId && !nodeIds.has(node.parentId)) throw new Error('Scene node references an unknown parent: ' + node.id);
  }
  const skinIds = new Set(skins.map(skin => skin.id));
  if (skinIds.size !== skins.length) throw new Error('Scene skin ids must be unique.');
  for (const skin of skins) {
    if (skin.skeletonRoot && !nodeIds.has(skin.skeletonRoot)) throw new Error('Scene skin references an unknown skeleton root: ' + skin.id);
    for (const joint of skin.joints) if (!nodeIds.has(joint)) throw new Error('Scene skin references an unknown joint node: ' + joint);
  }
  const entityIds = new Set();
  for (const entity of entities) {
    if (entityIds.has(entity.id)) throw new Error('Duplicate entity id: ' + entity.id);
    entityIds.add(entity.id);
    if (!geometryIds.has(entity.geometryId)) throw new Error('Entity references an unknown geometry: ' + entity.geometryId);
    for (const materialId of entity.materialIds) if (!materialIds.has(materialId)) throw new Error('Entity references an unknown material: ' + materialId);
    const geometry = geometries.find(item => item.id === entity.geometryId);
    if (entity.skinId) {
      const skin = skins.find(item => item.id === entity.skinId);
      if (!skin) throw new Error('Entity references an unknown skin: ' + entity.skinId);
      if (!geometry.jointIndices || !geometry.jointWeights) throw new Error('Skinned entity geometry must contain joint indices and weights: ' + entity.id);
      for (const jointIndex of geometry.jointIndices) if (jointIndex >= skin.joints.length) throw new RangeError('Skinned geometry references a joint outside its skin palette: ' + entity.id);
    } else if (geometry.jointIndices || geometry.jointWeights) {
      throw new Error('Geometry with skin attributes must be attached to an entity with a skin: ' + entity.id);
    }
    if (entity.morphWeights.length && entity.morphWeights.length !== geometry.morphTargets.length) {
      throw new RangeError('Entity morph weight count must match its geometry morph targets: ' + entity.id);
    }
    const requiredSlots = geometry.groups.length ? Math.max(...geometry.groups.map(group => group.materialIndex)) + 1 : 1;
    if (entity.materialIds.length < requiredSlots || (!geometry.groups.length && entity.materialIds.length !== 1)) {
      throw new Error('Entity material slots do not match its geometry material groups: ' + entity.id);
    }
  }
  return Object.freeze({
    kind: 'pstudio-graphics-scene-asset',
    schema: 'pstudio.scene-asset.v1',
    id, revision: Math.max(1, Math.floor(Number(input.revision) || 1)),
    geometries: Object.freeze(geometries),
    materials: Object.freeze(materials),
    textures: Object.freeze(textures),
    entities: Object.freeze(entities),
    nodes: Object.freeze(nodes),
    skins: Object.freeze(skins),
    animations: Object.freeze(animations),
    clearColor,
    lighting,
    metadata: Object.freeze({ ...(input.metadata || {}) })
  });
}

/**
 * Duck-typed Three.js scene importer. It never imports Three.js and never mutates
 * the source scene. Unsupported GPU features are reported and rejected in strict mode.
 */
export function importPStudioThreeScene(scene, options = {}) {
  if (!scene || typeof scene !== 'object') throw new TypeError('A source scene object is required.');
  const strict = options.strict !== false;
  const unsupported = [];
  const geometries = new Map(), materials = new Map(), textures = new Map(), entities = [], importedLights = [];
  const objects = [];
  let clearColor = null;
  if (scene.background != null) {
    const background = scene.background;
    if (Number.isFinite(Number(background.r)) && Number.isFinite(Number(background.g)) && Number.isFinite(Number(background.b)) &&
        [background.r, background.g, background.b].every(value => Number(value) >= 0 && Number(value) <= 1)) {
      clearColor = { r: Number(background.r), g: Number(background.g), b: Number(background.b), a: 1 };
    } else unsupported.push({ objectId: String(scene.uuid || scene.name || 'scene'), feature: 'scene-background' });
  }
  if (scene.environment != null) unsupported.push({ objectId: String(scene.uuid || scene.name || 'scene'), feature: 'scene-environment' });
  if (scene.fog != null) unsupported.push({ objectId: String(scene.uuid || scene.name || 'scene'), feature: 'scene-fog' });
  if (typeof scene.traverse === 'function') scene.traverse(object => objects.push(object));
  else {
    const visit = object => { if (!object) return; objects.push(object); for (const child of object.children || []) visit(child); };
    visit(scene);
  }
  let meshIndex = 0;
  for (const object of objects) {
    if (!object) continue;
    let visible = true;
    for (let parent = object; parent; parent = parent.parent) if (parent.visible === false) { visible = false; break; }
    if (!visible) continue;
    if (object.isLight) {
      const lightId = String(object.uuid || object.id || object.name || 'light');
      const type = object.isDirectionalLight ? 'directional' : object.isPointLight ? 'point' : object.isSpotLight ? 'spot' : null;
      if (!type) { unsupported.push({ objectId: lightId, feature: 'scene-light-type-' + String(object.type || 'unknown') }); continue; }
      const matrix = object.matrixWorld?.elements || object.matrix?.elements || IDENTITY;
      const position = [Number(matrix[12] || 0), Number(matrix[13] || 0), Number(matrix[14] || 0)];
      let direction = [0, -1, 0];
      if (type !== 'point') {
        const targetMatrix = object.target?.matrixWorld?.elements || null;
        if (targetMatrix) direction = [targetMatrix[12] - position[0], targetMatrix[13] - position[1], targetMatrix[14] - position[2]];
        else if (object.userData?.pstudioDirection) direction = sceneVector3Like(object.userData.pstudioDirection, direction, 'Light direction');
      }
      const color = object.color || {};
      const angle = Number(object.angle ?? Math.PI / 4);
      const penumbra = Math.max(0, Math.min(1, Number(object.penumbra) || 0));
      importedLights.push({
        type, position, direction,
        color: [Number(color.r ?? 1), Number(color.g ?? 1), Number(color.b ?? 1)],
        intensity: Number(object.intensity ?? 1),
        range: Number(object.distance ?? 0),
        innerConeCos: Math.cos(angle * (1 - penumbra)),
        outerConeCos: Math.cos(angle)
      });
      continue;
    }
    if (object.isLine || object.isLineSegments || object.isPoints || object.isSprite) { unsupported.push({ objectId: String(object.uuid || object.id || object.name || 'object'), feature: 'non-triangle-primitive' }); continue; }
    if (!object.isMesh) {
      if (object.geometry) unsupported.push({ objectId: String(object.uuid || object.id || object.name || 'object'), feature: 'unsupported-geometry-object' });
      continue;
    }
    const name = String(object.name || object.uuid || 'mesh-' + meshIndex);
    const objectId = String(object.uuid || object.id || name);
    if (object.isSkinnedMesh || object.isBatchedMesh) {
      unsupported.push({ objectId, feature: object.isSkinnedMesh ? 'skinning' : 'batching' });
      continue;
    }
    if (object.isInstancedMesh && object.instanceColor != null) {
      unsupported.push({ objectId, feature: 'instanced-per-instance-color' });
    }
    const sourceGeometry = object.geometry;
    const sourceAttributes = sourceGeometry?.attributes || {};
    for (const key of ['color', 'tangent', 'uv1', 'uv2', 'uv3', 'skinIndex', 'skinWeight']) {
      if (sourceAttributes[key]) unsupported.push({ objectId, feature: 'geometry-attribute-' + key });
    }
    const getAttribute = key => sourceGeometry?.getAttribute?.(key) || sourceAttributes[key] || null;
    const positionAttribute = getAttribute('position');
    if (!positionAttribute) { unsupported.push({ objectId, feature: 'missing-position-attribute' }); continue; }
    const positions = readAttribute(positionAttribute, 3, name + '.position');
    const normalAttribute = getAttribute('normal');
    const uvAttribute = getAttribute('uv');
    const normals = normalAttribute ? readAttribute(normalAttribute, 3, name + '.normal') : null;
    const uvs = uvAttribute ? readAttribute(uvAttribute, 2, name + '.uv') : null;
    const indexSource = sourceGeometry.index?.array || sourceGeometry.index || null;
    const indices = indexSource ? Array.from(indexSource, Number) : null;
    const geometryId = String(sourceGeometry.uuid || sourceGeometry.id || objectId + '.geometry');
    const groups = (sourceGeometry.groups || []).map(group => ({ start: group.start, count: group.count, materialIndex: group.materialIndex }));
    const drawCount = indices ? indices.length : positions.length / 3;
    if (groups.some(group => group.materialIndex < 0 || group.materialIndex >= (Array.isArray(object.material) ? object.material.length : 1))) {
      unsupported.push({ objectId, feature: 'geometry-group-material-slot-out-of-range' });
    }
    if (groups.length && !Array.isArray(object.material) && groups.some(group => group.materialIndex !== 0)) {
      unsupported.push({ objectId, feature: 'geometry-group-requires-material-array' });
    }
    if (sourceGeometry.drawRange && (Number(sourceGeometry.drawRange.start || 0) !== 0 || Number.isFinite(Number(sourceGeometry.drawRange.count)))) unsupported.push({ objectId, feature: 'geometry-draw-range' });
    if (sourceGeometry.morphAttributes && Object.values(sourceGeometry.morphAttributes).some(value => value?.length)) unsupported.push({ objectId, feature: 'morph-targets' });
    if (!geometries.has(geometryId)) {
      geometries.set(geometryId, geometryDescriptor({
        id: geometryId, revision: sourceGeometry.version || 1, positions, normals, uvs, indices, groups
      }));
    }
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    if (sourceMaterials.length > 1 && (!groups.length || groups.some(group => group.materialIndex >= sourceMaterials.length))) {
      unsupported.push({ objectId, feature: 'multi-materials-require-matching-geometry-groups' });
    }
    const materialIds = [];
    for (let index = 0; index < sourceMaterials.length; index += 1) {
      const source = sourceMaterials[index];
      if (!source) continue;
      const knownMaterial = source.isMeshBasicMaterial || source.isMeshToonMaterial || source.isMeshLambertMaterial || source.isMeshStandardMaterial || source.isMeshPhysicalMaterial;
      if (!knownMaterial) unsupported.push({ objectId, feature: 'material-model-' + String(source.type || 'unknown') });
      const materialId = String(source.uuid || source.id || objectId + '.material.' + index);
      materialIds.push(materialId);
      const baseColorMap = source.map || null;
      let baseColorTextureId = null;
      if (baseColorMap) {
        const textureId = String(baseColorMap.uuid || baseColorMap.name || materialId + '.base-color');
        const image = baseColorMap.image || baseColorMap.source?.data || null;
        let pixels = null;
        try {
          pixels = typeof options.readTexture === 'function'
            ? options.readTexture(baseColorMap, Object.freeze({ objectId, materialId, textureId }))
            : image?.data && ArrayBuffer.isView(image.data)
              ? { width: image.width || image.videoWidth || image.naturalWidth, height: image.height || image.videoHeight || image.naturalHeight, data: image.data }
              : null;
        } catch (error) {
          unsupported.push({ objectId, materialId, feature: 'texture-map-read-failed', message: String(error?.message || error) });
        }
        if (pixels && typeof pixels.then === 'function') {
          unsupported.push({ objectId, materialId, feature: 'async-texture-reader-not-supported' });
        } else if (!pixels || !ArrayBuffer.isView(pixels.data) || !Number.isFinite(Number(pixels.width)) || !Number.isFinite(Number(pixels.height))) {
          unsupported.push({ objectId, materialId, feature: 'texture-map' });
        } else {
          const width = Number(pixels.width), height = Number(pixels.height);
          const data = pixels.data instanceof Uint8Array || pixels.data instanceof Uint8ClampedArray ? pixels.data : null;
          if (!data || data.length !== width * height * 4) {
            unsupported.push({ objectId, materialId, feature: 'texture-map-not-rgba8' });
          } else if (!uvAttribute) {
            unsupported.push({ objectId, materialId, feature: 'texture-map-requires-uv0' });
          } else {
            const textureInput = {
              id: textureId, revision: baseColorMap.version || 1, width, height, data,
              format: pixels.format || 'rgba8unorm-srgb',
              addressModeU: baseColorMap.wrapS === 1001 ? 'clamp-to-edge' : baseColorMap.wrapS === 1002 ? 'mirror-repeat' : 'repeat',
              addressModeV: baseColorMap.wrapT === 1001 ? 'clamp-to-edge' : baseColorMap.wrapT === 1002 ? 'mirror-repeat' : 'repeat',
              magFilter: baseColorMap.magFilter === 1003 ? 'nearest' : 'linear',
              minFilter: baseColorMap.minFilter === 1003 || baseColorMap.minFilter === 1004 ? 'nearest' : 'linear'
            };
            if (!textures.has(textureId)) textures.set(textureId, textureInput);
            baseColorTextureId = textureId;
            const offset = baseColorMap.offset || { x: 0, y: 0 };
            const repeat = baseColorMap.repeat || { x: 1, y: 1 };
            if (Math.abs(Number(offset.x || 0)) > 1e-8 || Math.abs(Number(offset.y || 0)) > 1e-8 ||
                Math.abs(Number(repeat.x ?? 1) - 1) > 1e-8 || Math.abs(Number(repeat.y ?? 1) - 1) > 1e-8 ||
                Math.abs(Number(baseColorMap.rotation || 0)) > 1e-8) {
              unsupported.push({ objectId, materialId, feature: 'texture-map-transform' });
            }
            if (baseColorMap.colorSpace && !String(baseColorMap.colorSpace).toLowerCase().includes('srgb')) {
              unsupported.push({ objectId, materialId, feature: 'texture-map-color-space-' + String(baseColorMap.colorSpace) });
            }
          }
        }
      }
      for (const key of ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap']) {
        if (source[key]) unsupported.push({ objectId, materialId, feature: 'texture-' + key });
      }
      if (!materials.has(materialId)) {
        const color = source.color || {};
        const emissive = source.emissive || {};
        const colorValue = [Number(color.r ?? 1), Number(color.g ?? 1), Number(color.b ?? 1), Number(source.opacity ?? 1)];
        const emissiveIntensity = Number(source.emissiveIntensity ?? 1);
        const emissiveValue = [Number(emissive.r ?? 0) * emissiveIntensity, Number(emissive.g ?? 0) * emissiveIntensity, Number(emissive.b ?? 0) * emissiveIntensity];
        const alpha = source.transparent === true || Number(source.opacity ?? 1) < 1 ? 'blend' : source.alphaTest > 0 ? 'mask' : 'opaque';
        let model = source.isMeshBasicMaterial ? 'unlit' : source.isMeshToonMaterial ? 'toon' : source.isMeshLambertMaterial ? 'lambert' : 'pbr';
        if (alpha !== 'opaque') unsupported.push({ objectId, materialId, feature: 'alpha-mode-' + alpha });
        if (source.side === 2) unsupported.push({ objectId, materialId, feature: 'double-sided-material' });
        if (model !== 'pbr') unsupported.push({ objectId, materialId, feature: 'independent-pbr-renderer-material-model-' + model });
        if (source.vertexColors === true || source.flatShading === true || source.wireframe === true) unsupported.push({ objectId, materialId, feature: 'material-vertex-colors-flat-shading-or-wireframe' });
        for (const feature of ['clearcoat', 'sheen', 'iridescence', 'transmission', 'thickness', 'anisotropy', 'dispersion']) {
          if (Number(source[feature] || 0) > 0) unsupported.push({ objectId, materialId, feature: 'physical-material-' + feature });
        }
        materials.set(materialId, materialDescriptor({
          id: materialId, model, baseColor: colorValue, emissive: emissiveValue,
          metallic: source.metalness ?? 0, roughness: source.roughness ?? 0.7,
          opacity: source.opacity ?? 1, alphaMode: alpha,
          doubleSided: source.side === 2, textures: [], baseColorTextureId,
          metadata: { sourceMaterialType: source.type || 'unknown', sourceMaterialId: materialId }
        }));
      }
    }
    if (!materialIds.length) { unsupported.push({ objectId, feature: 'missing-material' }); continue; }
    if (object.castShadow || object.receiveShadow) unsupported.push({ objectId, feature: 'shadow-casting-or-receiving' });
    const parentMatrix = object.matrixWorld?.elements || object.matrix?.elements || IDENTITY;
    const instanceCount = object.isInstancedMesh ? Number(object.count) : 1;
    const instanceArray = object.isInstancedMesh ? object.instanceMatrix?.array : null;
    if (!Number.isSafeInteger(instanceCount) || instanceCount < 0) {
      unsupported.push({ objectId, feature: 'invalid-instanced-mesh-count' });
      continue;
    }
    if (object.isInstancedMesh && (
      !ArrayBuffer.isView(instanceArray) || instanceArray instanceof DataView ||
      (object.instanceMatrix?.itemSize != null && Number(object.instanceMatrix.itemSize) !== 16) ||
      instanceArray.length < instanceCount * 16
    )) {
      unsupported.push({ objectId, feature: 'instancing-matrix-data' });
      continue;
    }
    for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
      const instanceMatrix = object.isInstancedMesh
        ? Array.from(instanceArray.subarray(instanceIndex * 16, instanceIndex * 16 + 16), Number)
        : IDENTITY;
      const matrix = object.isInstancedMesh
        ? multiplyMatrix4(parentMatrix, instanceMatrix)
        : parentMatrix;
      const entityId = object.isInstancedMesh ? objectId + '.instance.' + instanceIndex : objectId;
      entities.push(entityDescriptor({
        id: entityId, sourceObjectId: objectId, geometryId, materialIds, matrixWorld: matrix,
        visible: object.visible !== false, castShadow: object.castShadow === true,
        receiveShadow: object.receiveShadow === true, layers: object.layers?.mask || 0
      }));
    }
    meshIndex += 1;
  }
  const report = Object.freeze({
    supported: unsupported.length === 0,
    convertedMeshCount: entities.length,
    geometryCount: geometries.size,
    materialCount: materials.size,
    textureCount: textures.size,
    unsupported: Object.freeze(unsupported.map(item => Object.freeze({ ...item })))
  });
  const asset = createPStudioGraphicsSceneAsset({
    id: options.id || scene.uuid || scene.name || 'imported-three-scene',
    revision: options.revision || 1,
    geometries: [...geometries.values()],
    materials: [...materials.values()],
    textures: [...textures.values()],
    entities,
    clearColor,
    lighting: { ...(options.lighting || {}), lights: [...(options.lighting?.lights || []), ...importedLights] },
    metadata: { source: 'duck-typed-three-scene-import', sourceSceneId: scene.uuid || null }
  });
  if (strict && !report.supported) {
    const error = new Error('Three.js scene contains features that are not yet losslessly supported by the PStudio scene importer.');
    error.code = 'PSTUDIO_SCENE_IMPORT_UNSUPPORTED_FEATURES';
    error.report = report;
    throw error;
  }
  return Object.freeze({ asset, report });
}
