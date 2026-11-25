// GLTFLoader imports the bare specifier "three". Module workers do not inherit the
// document import map, so use a self-contained ESM bundle for the parser.
import { GLTFLoader } from 'https://esm.sh/three@0.187.0/examples/jsm/loaders/GLTFLoader.js?bundle';
import { MeshoptDecoder } from 'https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/libs/meshopt_decoder.module.js';
const TRANSFERS = new Set();
const VIRTUAL_IMAGES = new Map();

function safeJSON(value) {
  if (value === undefined || value === null) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
}

function transferTypedArray(array) {
  if (!array || !ArrayBuffer.isView(array)) return null;
  const Constructor=array.constructor;
  let view=array;
  if(!(array.buffer instanceof ArrayBuffer)){
    view=new Constructor(array);
  }
  TRANSFERS.add(view.buffer);
  return {
    type: view.constructor.name,
    buffer: view.buffer,
    byteOffset: view.byteOffset||0,
    length: view.length
  };
}

function attributeArray(attribute) {
  if (!attribute) return null;
  if (attribute.isInterleavedBufferAttribute) {
    // Copy raw packed values, not normalized getters, so integer vertex formats
    // retain their original normalization semantics after transfer.
    const source=attribute.data.array;
    const packed=new source.constructor(attribute.count*attribute.itemSize);
    const stride=attribute.data.stride,offset=attribute.offset;
    for(let i=0;i<attribute.count;i++){
      for(let c=0;c<attribute.itemSize;c++)packed[i*attribute.itemSize+c]=source[i*stride+offset+c];
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
  'emissiveMap', 'lightMap', 'metalnessMap', 'roughnessMap', 'diffuseRoughnessMap', 'specularMap',
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
    if (!textureIds.has(texture)) textureIds.set(texture, textureIds.size);
    textureSlots[slot] = textureIds.get(texture);
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
    diffuseRoughness: Number.isFinite(material.diffuseRoughness) ? material.diffuseRoughness : null,
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
    iridescenceThicknessMinimum: Number.isFinite(material.iridescenceThicknessMinimum) ? material.iridescenceThicknessMinimum : null,
    iridescenceThicknessMaximum: Number.isFinite(material.iridescenceThicknessMaximum) ? material.iridescenceThicknessMaximum : null,
    iridescenceThicknessRange: Number.isFinite(material.iridescenceThicknessMinimum) && Number.isFinite(material.iridescenceThicknessMaximum)
      ? [material.iridescenceThicknessMinimum, material.iridescenceThicknessMaximum] : null,
    anisotropy: material.anisotropy,
    specularIntensity: material.specularIntensity,
    specularColor: colorArray(material.specularColor),
    textureSlots,
    userData: safeJSON(material.userData)
  };
}

function objectKind(object) {
  if (object.isInstancedMesh) return 'InstancedMesh';
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
    morphTargetDictionary: safeJSON(object.morphTargetDictionary),
    instanceCount:object.isInstancedMesh?object.count:null,
    instances:object.isInstancedMesh?{
      matrix:transferTypedArray(object.instanceMatrix.array),
      color:object.instanceColor?transferTypedArray(object.instanceColor.array):null
    }:null
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

async function serializeGLTF(gltf,assetKey='') {
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
    if (object.isMesh && object.geometry) {
      if(!object.geometry.boundingBox)object.geometry.computeBoundingBox();
      if(!object.geometry.boundingSphere)object.geometry.computeBoundingSphere();
      serializeGeometry(object.geometry, geometryIds);
    }
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
      roughness: material.roughness, diffuseRoughness: Number.isFinite(material.diffuseRoughness) ? material.diffuseRoughness : null,
      metalness: material.metalness,
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
      iridescenceThicknessMinimum: Number.isFinite(material.iridescenceThicknessMinimum) ? material.iridescenceThicknessMinimum : null,
      iridescenceThicknessMaximum: Number.isFinite(material.iridescenceThicknessMaximum) ? material.iridescenceThicknessMaximum : null,
      iridescenceThicknessRange: Number.isFinite(material.iridescenceThicknessMinimum) && Number.isFinite(material.iridescenceThicknessMaximum)
        ? [material.iridescenceThicknessMinimum, material.iridescenceThicknessMaximum] : null,
      anisotropy: material.anisotropy, specularIntensity: material.specularIntensity,
      specularColor: colorArray(material.specularColor),
      textureSlots, userData: safeJSON(material.userData)
    };
  }

  for (const [texture, id] of textureIds) {
    if(texture.isCompressedTexture){
      const mipmaps=(texture.mipmaps||[]).map(mipmap=>({
        width:mipmap.width,height:mipmap.height,depth:mipmap.depth||0,
        data:transferTypedArray(mipmap.data)
      }));
      textures[id]={
        id,name:texture.name||'',compressed:true,array:!!texture.isCompressedArrayTexture,
        width:texture.image?.width||0,height:texture.image?.height||0,depth:texture.image?.depth||0,
        mipmaps,format:texture.format,type:texture.type,colorSpace:texture.colorSpace||'',
        mapping:texture.mapping,wrapS:texture.wrapS,wrapT:texture.wrapT,
        magFilter:texture.magFilter,minFilter:texture.minFilter,
        generateMipmaps:false,flipY:false,premultiplyAlpha:!!texture.premultiplyAlpha,
        anisotropy:texture.anisotropy||1,userData:safeJSON(texture.userData)
      };
      continue;
    }
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
      const sourceWidth=bitmap.width,sourceHeight=bitmap.height;
      let imageRecord;
      if(Math.max(sourceWidth,sourceHeight)>2048&&typeof OffscreenCanvas==='function'){
        try{
          const scale=Math.min(1,512/Math.max(sourceWidth,sourceHeight));
          const fallbackWidth=Math.max(1,Math.round(sourceWidth*scale));
          const fallbackHeight=Math.max(1,Math.round(sourceHeight*scale));
          const canvas=new OffscreenCanvas(fallbackWidth,fallbackHeight);
          const context=canvas.getContext('2d',{alpha:true,colorSpace:'srgb'});
          if(!context)throw new Error('Could not create virtual texture fallback canvas.');
          context.drawImage(bitmap,0,0,sourceWidth,sourceHeight,0,0,fallbackWidth,fallbackHeight);
          const fallbackBitmap=await createImageBitmap(canvas);
          const workerImageKey=String(assetKey)+'::'+String(imageId);
          VIRTUAL_IMAGES.set(workerImageKey,bitmap);
          TRANSFERS.add(fallbackBitmap);
          imageRecord={
            id:imageId,width:fallbackBitmap.width,height:fallbackBitmap.height,
            bitmap:fallbackBitmap,
            virtual:{workerImageKey,sourceWidth,sourceHeight,pageSize:256}
          };
        }catch(error){
          TRANSFERS.add(bitmap);
          imageRecord={id:imageId,width:bitmap.width,height:bitmap.height,bitmap};
        }
      }else{
        TRANSFERS.add(bitmap);
        imageRecord={id:imageId,width:bitmap.width,height:bitmap.height,bitmap};
      }
      images.push(imageRecord);
    }
    textures[id] = {
      id, imageId, name: texture.name || '', mapping: texture.mapping,
      virtual:images[imageId]?.virtual||null,
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
    animations: (gltf.animations || []).map(clip => clip.constructor.toJSON(clip)),
    sceneName: root.name || '',
    source: 'three-gltfloader-worker-r160'
  };
}

async function parseGLB(message) {
  const buffer = message.buffer || (message.blob?.arrayBuffer ? await message.blob.arrayBuffer() : null);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20) throw new Error('Invalid GLB buffer.');
  const jsonLengthView = new DataView(buffer);
  if (jsonLengthView.getUint32(0, true) !== 0x46546c67 || jsonLengthView.getUint32(4, true) !== 2) {
    throw new Error('GLB 2.0 header validation failed.');
  }
  const jsonChunkLength = jsonLengthView.getUint32(12, true);
  if (jsonChunkLength < 2 || 20 + jsonChunkLength > buffer.byteLength) throw new Error('GLB JSON chunk is invalid.');
  const jsonText = new TextDecoder().decode(new Uint8Array(buffer, 20, jsonChunkLength)).replace(/[\u0000\s]+$/g, '');
  const json = JSON.parse(jsonText);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let ktx2Loader=null;
  if ((json.extensionsUsed || []).includes('KHR_texture_basisu')) {
    try {
      const module = await import('https://esm.sh/three@0.187.0/examples/jsm/loaders/KTX2Loader.js?bundle');
      ktx2Loader = new module.KTX2Loader();
      ktx2Loader.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/libs/basis/');
      ktx2Loader.setWorkerLimit(Math.max(1,Math.min(2,Number(self.navigator?.deviceMemory)||2)));
      const support=message.textureSupport||{};
      const extensions={
        'WEBGL_compressed_texture_astc':!!support.astc,
        'WEBGL_compressed_texture_etc1':!!support.etc1,
        'WEBGL_compressed_texture_etc':!!support.etc2,
        'WEBGL_compressed_texture_s3tc':!!support.dxt,
        'EXT_texture_compression_bptc':!!support.bptc,
        'WEBGL_compressed_texture_pvrtc':!!support.pvrtc,
        'WEBKIT_WEBGL_compressed_texture_pvrtc':!!support.pvrtc
      };
      ktx2Loader.detectSupport({
        isWebGPURenderer:false,
        capabilities:{isWebGL2:!!support.webgl2},
        extensions:{has:name=>!!extensions[name]}
      });
      loader.setKTX2Loader(ktx2Loader);
    } catch (cause) {
      const error = new Error('KTX2 worker transcoder could not initialize; using renderer-compatible fallback: '+String(cause?.message||cause));
      error.code = 'PSTUDIO_MAIN_THREAD_REQUIRED';
      throw error;
    }
  }
  let dracoLoader=null;
  if ((json.extensionsUsed || []).includes('KHR_draco_mesh_compression')) {
    try {
      const module = await import('https://esm.sh/three@0.187.0/examples/jsm/loaders/DRACOLoader.js?bundle');
      dracoLoader = new module.DRACOLoader();
      dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/libs/draco/');
      dracoLoader.setWorkerLimit(Math.max(1,Math.min(2,Number(self.navigator?.deviceMemory)||2)));
      loader.setDRACOLoader(dracoLoader);
    } catch (cause) {
      const error = new Error('Draco worker decoder could not initialize; use the renderer-compatible fallback path: '+String(cause?.message||cause));
      error.code = 'PSTUDIO_MAIN_THREAD_REQUIRED';
      throw error;
    }
  }

  const started = performance.now();
  let gltf,parsedAt,packet,serializedAt;
  try {
    gltf = await loader.parseAsync(buffer, '');
    parsedAt = performance.now();
    packet = await serializeGLTF(gltf,message.assetKey||'');
    serializedAt = performance.now();
  } finally {
    dracoLoader?.dispose?.();
    ktx2Loader?.dispose?.();
  }
  packet.timings = {
    parseMs: parsedAt - started,
    serializeMs: serializedAt - parsedAt,
    totalWorkerMs: serializedAt - started
  };
  return packet;
}

self.onmessage = async event => {
  const message = event.data || {};
  if (!Number.isSafeInteger(message.id)) return;
  try {
    if (message.op === 'capabilities') {
      self.postMessage({ id: message.id, ok: true, result: {
        offscreenCanvas: typeof OffscreenCanvas === 'function',
        createImageBitmap: typeof createImageBitmap === 'function'
      }});
      return;
    }
    if (message.op === 'register-image') {
      if (!message.bitmap || typeof message.textureId !== 'string') throw new Error('Invalid virtual texture image registration.');
      const previous = VIRTUAL_IMAGES.get(message.textureId);
      try { previous?.close?.(); } catch (_) {}
      VIRTUAL_IMAGES.set(message.textureId, message.bitmap);
      self.postMessage({ id: message.id, ok: true, result: { registered: true, width: message.bitmap.width, height: message.bitmap.height } });
      return;
    }
    if (message.op === 'extract-tile') {
      const bitmap = VIRTUAL_IMAGES.get(String(message.textureId));
      if (!bitmap) throw new Error('Virtual texture source image is no longer registered.');
      if (typeof OffscreenCanvas !== 'function') {
        const error = new Error('OffscreenCanvas is unavailable in the GLTF worker.');
        error.code = 'PSTUDIO_VT_WORKER_CANVAS_UNAVAILABLE';
        throw error;
      }
      const x = Math.max(0, Math.floor(Number(message.x) || 0));
      const y = Math.max(0, Math.floor(Number(message.y) || 0));
      const width = Math.max(1, Math.min(256, Math.floor(Number(message.width) || 256), bitmap.width - x));
      const height = Math.max(1, Math.min(256, Math.floor(Number(message.height) || 256), bitmap.height - y));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
      if (!context) throw new Error('Virtual texture tile canvas could not be created.');
      context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const copy = new Uint8Array(pixels.length);
      copy.set(pixels);
      self.postMessage({ id: message.id, ok: true, result: { width, height, buffer: copy.buffer, length: copy.length } }, [copy.buffer]);
      return;
    }
    if (message.op === 'release-asset') {
      const prefix=String(message.assetKey||'')+'::';
      for(const [key,bitmap] of VIRTUAL_IMAGES){
        if(!key.startsWith(prefix))continue;
        try{bitmap?.close?.();}catch(_){}
        VIRTUAL_IMAGES.delete(key);
      }
      self.postMessage({id:message.id,ok:true,result:{released:true}});
      return;
    }
    if (message.op === 'release-image') {
      const bitmap = VIRTUAL_IMAGES.get(String(message.textureId));
      try { bitmap?.close?.(); } catch (_) {}
      VIRTUAL_IMAGES.delete(String(message.textureId));
      self.postMessage({ id: message.id, ok: true, result: { released: true } });
      return;
    }
    if (message.op !== 'parse-glb') return;
    TRANSFERS.clear();
    self.postMessage({id:message.id,progress:{stage:'worker-parse-start',loaded:0,total:message.blob?.size||message.buffer?.byteLength||0,progress:0}});
    const packet = await parseGLB({...message,assetKey:message.assetKey||''});
    self.postMessage({id:message.id,progress:{stage:'worker-serialize-complete',loaded:message.blob?.size||message.buffer?.byteLength||0,total:message.blob?.size||message.buffer?.byteLength||0,progress:1,timings:packet.timings}});
    const transferList = [...TRANSFERS];
    self.postMessage({ id: message.id, ok: true, result: packet }, transferList);
  } catch (error) {
    if(message.op==='parse-glb'&&message.assetKey){
      const prefix=String(message.assetKey)+'::';
      for(const [key,bitmap] of VIRTUAL_IMAGES){if(key.startsWith(prefix)){try{bitmap?.close?.();}catch(_){}VIRTUAL_IMAGES.delete(key);}}
    }
    const messageText=String(error?.message||error);
    const code=String(error?.code||(messageText.startsWith('GLTF_WORKER_')?messageText.split(/[ :]/)[0]:''));
    self.postMessage({ id: message.id, ok: false, error: messageText, code });
  }
};