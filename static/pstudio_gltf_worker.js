import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/DRACOLoader.js';

const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/';
const TRANSFERS = new Set();

function safeJSON(value) {
  if (value === undefined || value === null) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
}

function transferTypedArray(array) {
  if (!array || !ArrayBuffer.isView(array)) return null;
  const copy = array.slice ? array.slice() : new array.constructor(array);
  TRANSFERS.add(copy.buffer);
  return { type: copy.constructor.name, buffer: copy.buffer, length: copy.length };
}

function attributeArray(attribute) {
  if (!attribute) return null;
  if (attribute.isInterleavedBufferAttribute) {
    const packed = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let c = 0; c < attribute.itemSize; c++) {
        const value = attribute.getComponent ? attribute.getComponent(i, c)
          : c === 0 ? attribute.getX(i)
          : c === 1 ? attribute.getY(i)
          : c === 2 ? attribute.getZ(i)
          : attribute.getW(i);
        packed[i * attribute.itemSize + c] = value;
      }
    }
    return { array: packed, normalized: !!attribute.normalized, itemSize: attribute.itemSize, name: attribute.name || '', gpuType: attribute.gpuType || 0 };
  }
  return { array: attribute.array, normalized: !!attribute.normalized, itemSize: attribute.itemSize, name: attribute.name || '', gpuType: attribute.gpuType || 0 };
}

function serializeAttribute(attribute) {
  const value = attributeArray(attribute);
  if (!value?.array) return null;
  return {
    data: transferTypedArray(value.array),
    itemSize: value.itemSize,
    normalized: value.normalized,
    name: value.name,
    gpuType: value.gpuType
  };
}

function serializeGeometry(geometry, geometryIds) {
  if (!geometry) return null;
  if (geometryIds.has(geometry)) return geometryIds.get(geometry);
  const id = geometryIds.size;
  geometryIds.set(geometry, id);
  return id;
}

const MATERIAL_TEXTURE_SLOTS = [
  'map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'displacementMap',
  'emissiveMap', 'lightMap', 'metalnessMap', 'roughnessMap', 'specularMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'iridescenceMap',
  'iridescenceThicknessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'specularColorMap', 'specularIntensityMap', 'transmissionMap',
  'thicknessMap', 'anisotropyMap'
];

function colorArray(color) {
  return color?.isColor ? [color.r, color.g, color.b] : null;
}


async function serializeMaterial(material, materialIds, textures, textureIds, images, imageIds) {
  if (!material) return null;
  if (materialIds.has(material)) return materialIds.get(material);
  const id = materialIds.size;
  materialIds.set(material, id);
  const textureSlots = {};
  for (const slot of MATERIAL_TEXTURE_SLOTS) {
    const texture = material[slot];
    if (!texture?.isTexture) continue;
    if (!textures.has(texture)) textures.set(texture, textures.size);
    textureSlots[slot] = textures.get(texture);
  }
  return {
    id,
    type: material.isMeshPhysicalMaterial ? 'MeshPhysicalMaterial'
      : material.isMeshStandardMaterial ? 'MeshStandardMaterial'
      : material.isMeshBasicMaterial ? 'MeshBasicMaterial'
      : material.isMeshLambertMaterial ? 'MeshLambertMaterial'
      : material.isMeshPhongMaterial ? 'MeshPhongMaterial'
      : material.isMeshToonMaterial ? 'MeshToonMaterial'
      : material.isLineBasicMaterial ? 'LineBasicMaterial'
      : material.isPointsMaterial ? 'PointsMaterial'
      : 'MeshStandardMaterial',
    name: material.name || '',
    color: colorArray(material.color),
    emissive: colorArray(material.emissive),
    roughness: material.roughness,
    metalness: material.metalness,
    opacity: material.opacity,
    alphaTest: material.alphaTest,
    transparent: !!material.transparent,
    depthWrite: material.depthWrite !== false,
    depthTest: material.depthTest !== false,
    side: material.side,
    vertexColors: !!material.vertexColors,
    flatShading: !!material.flatShading,
    wireframe: !!material.wireframe,
    blending: material.blending,
    toneMapped: material.toneMapped !== false,
    premultipliedAlpha: !!material.premultipliedAlpha,
    normalScale: material.normalScale?.toArray?.() || [1, 1],
    displacementScale: material.displacementScale,
    displacementBias: material.displacementBias,
    emissiveIntensity: material.emissiveIntensity,
    specular: colorArray(material.specular),
    shininess: material.shininess,
    clearcoat: material.clearcoat,
    clearcoatRoughness: material.clearcoatRoughness,
    ior: material.ior,
    transmission: material.transmission,
    thickness: material.thickness,
    attenuationDistance: material.attenuationDistance,
    attenuationColor: colorArray(material.attenuationColor),
    sheen: material.sheen,
    sheenColor: colorArray(material.sheenColor),
    sheenRoughness: material.sheenRoughness,
    iridescence: material.iridescence,
    iridescenceIOR: material.iridescenceIOR,
    iridescenceThicknessRange: material.iridescenceThicknessRange?.slice?.() || null,
    anisotropy: material.anisotropy,
    specularIntensity: material.specularIntensity,
    specularColor: colorArray(material.specularColor),
    textureSlots,
    userData: safeJSON(material.userData)
  };
}

function objectKind(object) {
  if (object.isSkinnedMesh) return 'SkinnedMesh';
  if (object.isMesh) return 'Mesh';
  if (object.isPoints) return 'Points';
  if (object.isLineSegments) return 'LineSegments';
  if (object.isLineLoop) return 'LineLoop';
  if (object.isLine) return 'Line';
  if (object.isBone) return 'Bone';
  if (object.isPerspectiveCamera) return 'PerspectiveCamera';
  if (object.isOrthographicCamera) return 'OrthographicCamera';
  if (object.isDirectionalLight) return 'DirectionalLight';
  if (object.isPointLight) return 'PointLight';
  if (object.isSpotLight) return 'SpotLight';
  if (object.isHemisphereLight) return 'HemisphereLight';
  if (object.isAmbientLight) return 'AmbientLight';
  if (object.isGroup) return 'Group';
  return 'Object3D';
}

function serializeNode(object, index, objectIds, geometryIds, materialIds, geometries) {
  const node = {
    id: index,
    kind: objectKind(object),
    name: object.name || '',
    parent: object.parent ? objectIds.get(object.parent) : -1,
    children: object.children.map(child => objectIds.get(child)),
    position: object.position?.toArray?.() || [0, 0, 0],
    quaternion: object.quaternion?.toArray?.() || [0, 0, 0, 1],
    scale: object.scale?.toArray?.() || [1, 1, 1],
    matrix: object.matrix?.toArray?.() || null,
    matrixAutoUpdate: object.matrixAutoUpdate !== false,
    visible: object.visible !== false,
    renderOrder: object.renderOrder || 0,
    frustumCulled: object.frustumCulled !== false,
    castShadow: !!object.castShadow,
    receiveShadow: !!object.receiveShadow,
    userData: safeJSON(object.userData),
    geometryId: object.geometry ? serializeGeometry(object.geometry, geometryIds) : null,
    materialIds: object.material ? (Array.isArray(object.material)
      ? object.material.map(material => material ? materialIds.get(material) : null)
      : [materialIds.get(object.material)]) : [],
    morphTargetInfluences: object.morphTargetInfluences?.slice?.() || null,
    morphTargetDictionary: safeJSON(object.morphTargetDictionary)
  };

  if (object.isCamera) {
    Object.assign(node, {
      near: object.near, far: object.far, zoom: object.zoom,
      fov: object.fov, aspect: object.aspect, filmGauge: object.filmGauge,
      filmOffset: object.filmOffset,
      left: object.left, right: object.right, top: object.top, bottom: object.bottom,
      focus: object.focus, view: safeJSON(object.view)
    });
  }
  if (object.isLight) {
    Object.assign(node, {
      color: colorArray(object.color),
      intensity: object.intensity,
      distance: object.distance,
      decay: object.decay,
      angle: object.angle,
      penumbra: object.penumbra,
      groundColor: colorArray(object.groundColor),
      target: object.target ? (objectIds.get(object.target) ?? -1) : -1,
      shadow: object.shadow ? {
        bias: object.shadow.bias,
        normalBias: object.shadow.normalBias,
        radius: object.shadow.radius,
        mapSize: object.shadow.mapSize?.toArray?.() || null
      } : null
    });
  }
  if (object.isSkinnedMesh && object.skeleton) {
    node.skeleton = {
      bones: object.skeleton.bones.map(bone => objectIds.get(bone) ?? -1),
      boneInverses: object.skeleton.boneInverses.map(matrix => matrix.toArray()),
      bindMatrix: object.bindMatrix.toArray(),
      bindMatrixInverse: object.bindMatrixInverse.toArray(),
      bindMode: object.bindMode
    };
  }
  return node;
}

async function serializeGLTF(gltf) {
  const root = gltf.scene;
  const objects = [];
  root.traverse(object => objects.push(object));
  const objectIds = new Map(objects.map((object, index) => [object, index]));
  const geometryIds = new Map();
  const materialIds = new Map();
  const textureIds = new Map();
  const imageIds = new WeakMap();
  const geometries = [];
  const materials = [];
  const textures = [];
  const images = [];

  for (const object of objects) {
    if (object.isMesh && object.geometry) serializeGeometry(object.geometry, geometryIds);
    const list = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
    for (const material of list) {
      if (material) await serializeMaterial(material, materialIds, textures, textureIds, images, imageIds);
    }
  }

  for (const [geometry, id] of geometryIds) {
    // serializeGeometry returns an id immediately; complete records are assembled below.
    const attributes = {};
    for (const [name, attribute] of Object.entries(geometry.attributes || {})) {
      const value = serializeAttribute(attribute);
      if (value) attributes[name] = value;
    }
    const morphAttributes = {};
    for (const [name, list] of Object.entries(geometry.morphAttributes || {})) {
      morphAttributes[name] = list.map(serializeAttribute).filter(Boolean);
    }
    const box = geometry.boundingBox;
    const sphere = geometry.boundingSphere;
    geometries[id] = {
      id, name: geometry.name || '', type: geometry.type || 'BufferGeometry',
      attributes, morphAttributes, morphTargetsRelative: !!geometry.morphTargetsRelative,
      index: geometry.index ? serializeAttribute(geometry.index) : null,
      groups: (geometry.groups || []).map(group => ({ start: group.start, count: group.count, materialIndex: group.materialIndex })),
      drawRange: { start: geometry.drawRange?.start ?? 0, count: Number.isFinite(geometry.drawRange?.count) ? geometry.drawRange.count : -1 },
      boundingBox: box ? { min: box.min.toArray(), max: box.max.toArray() } : null,
      boundingSphere: sphere ? { center: sphere.center.toArray(), radius: sphere.radius } : null,
      userData: safeJSON(geometry.userData)
    };
  }

  for (const [material, id] of materialIds) {
    const textureSlots = {};
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      const texture = material[slot];
      if (texture?.isTexture) textureSlots[slot] = textureIds.get(texture);
    }
    materials[id] = {
      id,
      type: material.isMeshPhysicalMaterial ? 'MeshPhysicalMaterial'
        : material.isMeshStandardMaterial ? 'MeshStandardMaterial'
        : material.isMeshBasicMaterial ? 'MeshBasicMaterial'
        : material.isMeshLambertMaterial ? 'MeshLambertMaterial'
        : material.isMeshPhongMaterial ? 'MeshPhongMaterial'
        : material.isMeshToonMaterial ? 'MeshToonMaterial'
        : material.isLineBasicMaterial ? 'LineBasicMaterial'
        : material.isPointsMaterial ? 'PointsMaterial'
        : 'MeshStandardMaterial',
      name: material.name || '',
      color: colorArray(material.color), emissive: colorArray(material.emissive),
      roughness: material.roughness, metalness: material.metalness,
      opacity: material.opacity, alphaTest: material.alphaTest,
      transparent: !!material.transparent, depthWrite: material.depthWrite !== false,
      depthTest: material.depthTest !== false, side: material.side,
      vertexColors: !!material.vertexColors, flatShading: !!material.flatShading,
      wireframe: !!material.wireframe, blending: material.blending,
      toneMapped: material.toneMapped !== false, premultipliedAlpha: !!material.premultipliedAlpha,
      normalScale: material.normalScale?.toArray?.() || [1, 1],
      displacementScale: material.displacementScale, displacementBias: material.displacementBias,
      emissiveIntensity: material.emissiveIntensity, specular: colorArray(material.specular),
      shininess: material.shininess, clearcoat: material.clearcoat,
      clearcoatRoughness: material.clearcoatRoughness, ior: material.ior,
      transmission: material.transmission, thickness: material.thickness,
      attenuationDistance: material.attenuationDistance, attenuationColor: colorArray(material.attenuationColor),
      sheen: material.sheen, sheenColor: colorArray(material.sheenColor),
      sheenRoughness: material.sheenRoughness, iridescence: material.iridescence,
      iridescenceIOR: material.iridescenceIOR,
      iridescenceThicknessRange: material.iridescenceThicknessRange?.slice?.() || null,
      anisotropy: material.anisotropy, specularIntensity: material.specularIntensity,
      specularColor: colorArray(material.specularColor),
      textureSlots, userData: safeJSON(material.userData)
    };
  }

  for (const [texture, id] of textureIds) {
    const image = texture.source?.data ?? texture.image;
    let imageId = imageIds.get(image);
    if (imageId === undefined) {
      if (typeof createImageBitmap !== 'function') throw new Error('GLTF_WORKER_IMAGEBITMAP_UNAVAILABLE');
      const bitmap = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap
        ? image
        : await createImageBitmap(image);
      if (typeof ImageBitmap === 'undefined' || !(bitmap instanceof ImageBitmap)) {
        throw new Error('GLTF_WORKER_IMAGE_TRANSFER_UNAVAILABLE');
      }
      imageId = images.length;
      imageIds.set(image, imageId);
      TRANSFERS.add(bitmap);
      images.push({ id: imageId, width: bitmap.width, height: bitmap.height, bitmap });
    }
    textures[id] = {
      id, imageId, name: texture.name || '', mapping: texture.mapping,
      channel: texture.channel ?? 0, wrapS: texture.wrapS, wrapT: texture.wrapT,
      magFilter: texture.magFilter, minFilter: texture.minFilter,
      format: texture.format, type: texture.type, colorSpace: texture.colorSpace || '',
      generateMipmaps: texture.generateMipmaps !== false, premultiplyAlpha: !!texture.premultiplyAlpha,
      flipY: !!texture.flipY, unpackAlignment: texture.unpackAlignment || 4,
      anisotropy: texture.anisotropy || 1, offset: texture.offset?.toArray?.() || [0, 0],
      repeat: texture.repeat?.toArray?.() || [1, 1], center: texture.center?.toArray?.() || [0, 0],
      rotation: texture.rotation || 0, matrixAutoUpdate: texture.matrixAutoUpdate !== false,
      matrix: texture.matrix?.toArray?.() || null, userData: safeJSON(texture.userData)
    };
  }

  const nodes = objects.map((object, index) => serializeNode(object, index, objectIds, geometryIds, materialIds, geometries));
  return {
    rootIndex: objectIds.get(root) ?? 0,
    nodes, geometries, materials, textures, images,
    animations: (gltf.animations || []).map(clip => THREE.AnimationClip.toJSON(clip)),
    sceneName: root.name || '',
    source: 'three-gltfloader-worker-r160'
  };
}

async function parseGLB(message) {
  const buffer = message.buffer;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20) throw new Error('Invalid GLB buffer.');
  const jsonLengthView = new DataView(buffer);
  if (jsonLengthView.getUint32(0, true) !== 0x46546c67 || jsonLengthView.getUint32(4, true) !== 2) {
    throw new Error('GLB 2.0 header validation failed.');
  }
  const jsonChunkLength = jsonLengthView.getUint32(12, true);
  if (jsonChunkLength < 2 || 20 + jsonChunkLength > buffer.byteLength) throw new Error('GLB JSON chunk is invalid.');
  const jsonText = new TextDecoder().decode(new Uint8Array(buffer, 20, jsonChunkLength)).replace(/[\u0000\s]+$/g, '');
  const json = JSON.parse(jsonText);
  if ((json.extensionsUsed || []).includes('KHR_texture_basisu')) {
    const error = new Error('This GLB uses KTX2/Basis textures; the renderer must initialize the KTX2 transcoder on the main thread.');
    error.code = 'PSTUDIO_MAIN_THREAD_REQUIRED';
    throw error;
  }

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  if ((json.extensionsUsed || []).includes('KHR_draco_mesh_compression')) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(CDN + 'libs/draco/');
    draco.setWorkerLimit(2);
    loader.setDRACOLoader(draco);
  }

  const started = performance.now();
  const gltf = await loader.parseAsync(buffer, '');
  const parsedAt = performance.now();
  const packet = await serializeGLTF(gltf);
  const serializedAt = performance.now();
  packet.timings = {
    parseMs: parsedAt - started,
    serializeMs: serializedAt - parsedAt,
    totalWorkerMs: serializedAt - started
  };
  return packet;
}

self.onmessage = async event => {
  const message = event.data || {};
  if (!Number.isSafeInteger(message.id) || message.op !== 'parse-glb') return;
  TRANSFERS.clear();
  try {
    const packet = await parseGLB(message);
    const transferList = [...TRANSFERS];
    self.postMessage({ id: message.id, ok: true, result: packet }, transferList);
  } catch (error) {
    const messageText=String(error?.message||error);
    const code=String(error?.code||(messageText.startsWith('GLTF_WORKER_')?messageText.split(/[ :]/)[0]:''));
    self.postMessage({ id: message.id, ok: false, error: messageText, code });
  }
};
