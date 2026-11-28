import { createPStudioGraphicsMaterial } from './pstudio_graphics_contract.mjs';

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ATTRIBUTE_COMPONENTS = Object.freeze({ positions: 3, normals: 3, uvs: 2 });

function vector(value, length, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== length) throw new TypeError(label + ' must contain exactly ' + length + ' values.');
  const result = Array.from(value, Number);
  if (!result.every(Number.isFinite)) throw new TypeError(label + ' must contain only finite values.');
  return result;
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
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], positions[index + axis]); max[axis] = Math.max(max[axis], positions[index + axis]); }
  }
  const drawElementCount = indices?.length || positions.length / 3;
  const groups = (input.groups || []).map(group => {
    const start = Number(group.start ?? 0), count = Number(group.count ?? 0), materialIndex = Number(group.materialIndex ?? 0);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1 ||
        !Number.isSafeInteger(materialIndex) || materialIndex < 0 || start + count > drawElementCount) {
      throw new RangeError('Geometry group range or material index is invalid.');
    }
    return Object.freeze({ start, count, materialIndex });
  });
  return Object.freeze({
    id, revision: Math.max(1, Math.floor(Number(input.revision) || 1)),
    positions, normals, uvs, indices,
    vertexCount: positions.length / 3, indexCount: indices?.length || 0,
    bounds: Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }),
    groups: Object.freeze(groups)
  });
}
function materialDescriptor(input) {
  const id = String(input.id || '').trim();
  if (!id) throw new TypeError('Material id is required.');
  return createPStudioGraphicsMaterial({ ...input, id });
}
function entityDescriptor(input) {
  const id = String(input.id || '').trim();
  const geometryId = String(input.geometryId || '').trim();
  if (!id || !geometryId) throw new TypeError('Entity id and geometryId are required.');
  const matrix = vector(input.matrixWorld || input.matrix || IDENTITY, 16, 'Entity matrix');
  const materialIds = [...new Set((input.materialIds || (input.materialId ? [input.materialId] : [])).map(String))];
  if (!materialIds.length) throw new TypeError('Entity must reference at least one PStudio material.');
  return Object.freeze({
    id, geometryId, materialIds: Object.freeze(materialIds),
    matrixWorld: Object.freeze(matrix),
    visible: input.visible !== false,
    castShadow: input.castShadow === true,
    receiveShadow: input.receiveShadow === true,
    layers: Math.max(0, Math.floor(Number(input.layers) || 0)),
    sourceObjectId: input.sourceObjectId == null ? null : String(input.sourceObjectId)
  });
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
  return Object.freeze({
    sunDirection: Object.freeze(sceneVector3Like(input.sunDirection, [0.35, -0.85, -0.38], 'Scene sun direction')),
    sunColor: Object.freeze(sceneVector3Like(input.sunColor, [1, 0.96, 0.9], 'Scene sun color')),
    sunIntensity: sceneScalar(input.sunIntensity, 3, 'Scene sun intensity'),
    ambientColor: Object.freeze(sceneVector3Like(input.ambientColor, [0.12, 0.15, 0.2], 'Scene ambient color')),
    ambientIntensity: sceneScalar(input.ambientIntensity, 1, 'Scene ambient intensity')
  });
}

/** Create a Three.js-free scene asset containing only PStudio-owned data. */
export function createPStudioGraphicsSceneAsset(input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new TypeError('PStudio graphics scene asset id is required.');
  const geometries = (input.geometries || []).map(geometryDescriptor);
  const materials = (input.materials || []).map(materialDescriptor);
  const entities = (input.entities || []).map(entityDescriptor);
  const clearColor = sceneColor4(input.clearColor, 'Scene clear color');
  const lighting = sceneLightingDescriptor(input.lighting);
  const geometryIds = new Set(), materialIds = new Set();
  for (const geometry of geometries) {
    if (geometryIds.has(geometry.id)) throw new Error('Duplicate geometry id: ' + geometry.id);
    geometryIds.add(geometry.id);
  }
  for (const material of materials) {
    if (materialIds.has(material.id)) throw new Error('Duplicate material id: ' + material.id);
    materialIds.add(material.id);
  }
  const entityIds = new Set();
  for (const entity of entities) {
    if (entityIds.has(entity.id)) throw new Error('Duplicate entity id: ' + entity.id);
    entityIds.add(entity.id);
    if (!geometryIds.has(entity.geometryId)) throw new Error('Entity references an unknown geometry: ' + entity.geometryId);
    for (const materialId of entity.materialIds) if (!materialIds.has(materialId)) throw new Error('Entity references an unknown material: ' + materialId);
  }
  return Object.freeze({
    kind: 'pstudio-graphics-scene-asset',
    schema: 'pstudio.scene-asset.v1',
    id, revision: Math.max(1, Math.floor(Number(input.revision) || 1)),
    geometries: Object.freeze(geometries),
    materials: Object.freeze(materials),
    entities: Object.freeze(entities),
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
  const geometries = new Map(), materials = new Map(), entities = [];
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
    if (object.isLight) { unsupported.push({ objectId: String(object.uuid || object.id || object.name || 'light'), feature: 'scene-lighting' }); continue; }
    if (object.isLine || object.isLineSegments || object.isPoints || object.isSprite) { unsupported.push({ objectId: String(object.uuid || object.id || object.name || 'object'), feature: 'non-triangle-primitive' }); continue; }
    if (!object.isMesh) {
      if (object.geometry) unsupported.push({ objectId: String(object.uuid || object.id || object.name || 'object'), feature: 'unsupported-geometry-object' });
      continue;
    }
    const name = String(object.name || object.uuid || 'mesh-' + meshIndex);
    const objectId = String(object.uuid || object.id || name);
    if (object.isSkinnedMesh || object.isInstancedMesh || object.isBatchedMesh) {
      unsupported.push({ objectId, feature: object.isSkinnedMesh ? 'skinning' : object.isInstancedMesh ? 'instancing' : 'batching' });
      continue;
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
    if (groups.length > 1 || groups.some(group => group.materialIndex > 0)) unsupported.push({ objectId, feature: 'multi-material-geometry-groups' });
    if (groups.length === 1 && (Number(groups[0].start) !== 0 || Number(groups[0].count) !== drawCount)) unsupported.push({ objectId, feature: 'partial-geometry-group' });
    if (sourceGeometry.drawRange && (Number(sourceGeometry.drawRange.start || 0) !== 0 || Number.isFinite(Number(sourceGeometry.drawRange.count)))) unsupported.push({ objectId, feature: 'geometry-draw-range' });
    if (sourceGeometry.morphAttributes && Object.values(sourceGeometry.morphAttributes).some(value => value?.length)) unsupported.push({ objectId, feature: 'morph-targets' });
    if (!geometries.has(geometryId)) {
      geometries.set(geometryId, geometryDescriptor({
        id: geometryId, revision: sourceGeometry.version || 1, positions, normals, uvs, indices, groups
      }));
    }
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    if (sourceMaterials.length > 1) unsupported.push({ objectId, feature: 'multiple-materials' });
    const materialIds = [];
    for (let index = 0; index < sourceMaterials.length; index += 1) {
      const source = sourceMaterials[index];
      if (!source) continue;
      const knownMaterial = source.isMeshBasicMaterial || source.isMeshToonMaterial || source.isMeshLambertMaterial || source.isMeshStandardMaterial || source.isMeshPhysicalMaterial;
      if (!knownMaterial) unsupported.push({ objectId, feature: 'material-model-' + String(source.type || 'unknown') });
      const materialId = String(source.uuid || source.id || objectId + '.material.' + index);
      materialIds.push(materialId);
      const textureFields = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap'];
      const textures = textureFields.filter(key => source[key]).map(key => {
        unsupported.push({ objectId, materialId, feature: 'texture-' + key });
        return String(source[key].uuid || source[key].name || materialId + '.' + key);
      });
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
          doubleSided: source.side === 2, textures,
          metadata: { sourceMaterialType: source.type || 'unknown', sourceMaterialId: materialId }
        }));
      }
    }
    if (!materialIds.length) { unsupported.push({ objectId, feature: 'missing-material' }); continue; }
    if (object.castShadow || object.receiveShadow) unsupported.push({ objectId, feature: 'shadow-casting-or-receiving' });
    const matrix = object.matrixWorld?.elements || object.matrix?.elements || IDENTITY;
    entities.push(entityDescriptor({
      id: objectId, sourceObjectId: objectId, geometryId, materialIds, matrixWorld: matrix,
      visible: object.visible !== false, castShadow: object.castShadow === true,
      receiveShadow: object.receiveShadow === true, layers: object.layers?.mask || 0
    }));
    meshIndex += 1;
  }
  const report = Object.freeze({
    supported: unsupported.length === 0,
    convertedMeshCount: entities.length,
    geometryCount: geometries.size,
    materialCount: materials.size,
    unsupported: Object.freeze(unsupported.map(item => Object.freeze({ ...item })))
  });
  const asset = createPStudioGraphicsSceneAsset({
    id: options.id || scene.uuid || scene.name || 'imported-three-scene',
    revision: options.revision || 1,
    geometries: [...geometries.values()],
    materials: [...materials.values()],
    entities,
    clearColor,
    lighting: options.lighting || null,
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
