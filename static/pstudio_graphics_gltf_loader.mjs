import { createPStudioGraphicsSceneAsset } from "./pstudio_graphics_scene_asset.mjs";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPONENTS = Object.freeze({ SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16 });
const COMPONENT_BYTES = Object.freeze({ 5120:1, 5121:1, 5122:2, 5123:2, 5125:4, 5126:4 });
const COMPONENT_READ = Object.freeze({
  5120: (view, offset) => view.getInt8(offset),
  5121: (view, offset) => view.getUint8(offset),
  5122: (view, offset) => view.getInt16(offset, true),
  5123: (view, offset) => view.getUint16(offset, true),
  5125: (view, offset) => view.getUint32(offset, true),
  5126: (view, offset) => view.getFloat32(offset, true)
});
const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(label + " must be finite.");
  return number;
};
function bytesOf(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("GLB input must be an ArrayBuffer or typed-array view.");
}
function parseGlb(input) {
  const bytes = bytesOf(input);
  if (bytes.byteLength < 20) throw new RangeError("GLB header is truncated.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new TypeError("GLB magic is invalid.");
  const version = view.getUint32(4, true), declaredLength = view.getUint32(8, true);
  if (version !== 2) throw new TypeError("Only binary glTF 2.0 containers are supported.");
  if (declaredLength !== bytes.byteLength) throw new RangeError("GLB declared length does not match the supplied bytes.");
  let offset = 12, document = null, binary = null;
  while (offset < declaredLength) {
    if (offset + 8 > declaredLength) throw new RangeError("GLB chunk header is truncated.");
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 || offset + length > declaredLength) throw new RangeError("GLB chunk length or alignment is invalid.");
    const chunk = bytes.subarray(offset, offset + length);
    if (type === JSON_CHUNK && document === null) {
      const text = new TextDecoder("utf-8", { fatal:true }).decode(chunk).replace(/[\u0000\u0020]+$/g, "");
      document = JSON.parse(text);
    } else if (type === BIN_CHUNK && binary === null) binary = chunk;
    offset += length;
  }
  if (!document || typeof document !== "object") throw new TypeError("GLB JSON document is missing.");
  return { document, binary, byteLength: bytes.byteLength };
}
function normalizeComponent(value, componentType, signed) {
  if (!signed && componentType === 5121) return value / 255;
  if (!signed && componentType === 5123) return value / 65535;
  if (!signed && componentType === 5125) return value / 4294967295;
  if (signed && componentType === 5120) return Math.max(-1, value / 127);
  if (signed && componentType === 5122) return Math.max(-1, value / 32767);
  return value;
}
function matrixTRS(node) {
  if (node.matrix) {
    if (node.matrix.length !== 16 || !node.matrix.every(Number.isFinite)) throw new TypeError("glTF node matrix must contain 16 finite values.");
    return Array.from(node.matrix);
  }
  const t = node.translation || [0,0,0], q = node.rotation || [0,0,0,1], s = node.scale || [1,1,1];
  if (t.length !== 3 || q.length !== 4 || s.length !== 3 || ![...t,...q,...s].every(Number.isFinite)) throw new TypeError("glTF node TRS transform is invalid.");
  const [x,y,z,w] = q, [sx,sy,sz] = s;
  return [
    (1-2*(y*y+z*z))*sx, 2*(x*y+z*w)*sx, 2*(x*z-y*w)*sx, 0,
    2*(x*y-z*w)*sy, (1-2*(x*x+z*z))*sy, 2*(y*z+x*w)*sy, 0,
    2*(x*z+y*w)*sz, 2*(y*z-x*w)*sz, (1-2*(x*x+y*y))*sz, 0,
    t[0],t[1],t[2],1
  ];
}
function multiply4(a,b) {
  const out=new Array(16).fill(0);
  for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)out[c*4+r]+=a[k*4+r]*b[c*4+k];
  return out;
}
function makeReader(document, binary) {
  const buffers = (document.buffers || []).map((buffer, index) => {
    if (buffer.uri) throw new Error("External glTF buffers are not supported by the single-file GLB loader.");
    if (index !== 0 || !binary) throw new Error("GLB is missing its embedded BIN chunk.");
    if (buffer.byteLength > binary.byteLength) throw new RangeError("glTF buffer byteLength exceeds the GLB BIN chunk.");
    return binary;
  });
  function view(accessorIndex) {
    const accessor = document.accessors?.[accessorIndex];
    if (!accessor) throw new RangeError("glTF accessor does not exist: " + accessorIndex);
    const components = COMPONENTS[accessor.type], bytesPerComponent = COMPONENT_BYTES[accessor.componentType], read = COMPONENT_READ[accessor.componentType];
    if (!components || !bytesPerComponent || !read) throw new TypeError("glTF accessor component or type is unsupported.");
    const count = Number(accessor.count);
    if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("glTF accessor count must be positive.");
    const output = new Array(count * components).fill(0);
    if (accessor.bufferView != null) {
      const bufferView = document.bufferViews?.[accessor.bufferView];
      if (!bufferView) throw new RangeError("glTF accessor references a missing bufferView.");
      const data = buffers[bufferView.buffer || 0];
      if (!data) throw new RangeError("glTF accessor references an unavailable buffer.");
      const bufferOffset = Number(bufferView.byteOffset || 0) + Number(accessor.byteOffset || 0);
      const packedSize = components * bytesPerComponent;
      const stride = Number(bufferView.byteStride || packedSize);
      if (stride < packedSize || stride % bytesPerComponent || bufferOffset < 0 || !Number.isSafeInteger(stride)) throw new RangeError("glTF accessor byteStride is invalid.");
      const end = count ? bufferOffset + (count - 1) * stride + packedSize : bufferOffset;
      if (end > data.byteLength) throw new RangeError("glTF accessor exceeds its bufferView.");
      const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let item=0;item<count;item++) for(let component=0;component<components;component++) {
        let value=read(dataView,bufferOffset+item*stride+component*bytesPerComponent);
        if (accessor.normalized && accessor.componentType !== 5126) value=normalizeComponent(value,accessor.componentType,accessor.componentType===5120||accessor.componentType===5122);
        output[item*components+component]=finite(value,"glTF accessor component");
      }
    } else if (accessor.sparse) {
      // Sparse accessors start with zero-filled values and patch the indexed elements.
    } else throw new TypeError("glTF accessor without a bufferView must be sparse.");
    if (accessor.sparse) {
      const sparse=accessor.sparse, countSparse=Number(sparse.count);
      const indexType=Number(sparse.indices?.componentType), indexRead=COMPONENT_READ[indexType], indexBytes=COMPONENT_BYTES[indexType];
      if (!Number.isSafeInteger(countSparse)||countSparse<1||![5121,5123,5125].includes(indexType)||!indexRead)throw new TypeError("glTF sparse accessor indices are invalid.");
      const indexView=document.bufferViews?.[sparse.indices.bufferView], valueView=document.bufferViews?.[sparse.values.bufferView];
      const indexBuffer=buffers[indexView?.buffer||0],valueBuffer=buffers[valueView?.buffer||0];
      if(!indexView||!valueView||!indexBuffer||!valueBuffer)throw new RangeError("glTF sparse accessor bufferView is missing.");
      const indexOffset=Number(indexView.byteOffset||0)+Number(sparse.indices.byteOffset||0);
      const valueOffset=Number(valueView.byteOffset||0)+Number(sparse.values.byteOffset||0);
      const indexDV=new DataView(indexBuffer.buffer,indexBuffer.byteOffset,indexBuffer.byteLength);
      const valueDV=new DataView(valueBuffer.buffer,valueBuffer.byteOffset,valueBuffer.byteLength);
      for(let i=0;i<countSparse;i++){
        const target=indexRead(indexDV,indexOffset+i*indexBytes);
        if(target>=count)throw new RangeError("glTF sparse accessor index is out of range.");
        for(let c=0;c<components;c++){
          let value=read(valueDV,valueOffset+(i*components+c)*bytesPerComponent);
          if(accessor.normalized&&accessor.componentType!==5126)value=normalizeComponent(value,accessor.componentType,accessor.componentType===5120||accessor.componentType===5122);
          output[target*components+c]=finite(value,"glTF sparse accessor value");
        }
      }
    }
    return { data: output, count, components, componentType: accessor.componentType };
  }
  return { accessor: view, buffers };
}
function bytesFromDataUri(uri) {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(String(uri||""));
  if (!match) throw new TypeError("Only base64 embedded glTF image data URIs are supported.");
  const binary = atob(match[2]);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function extractImage(document, index, buffers) {
  const image = document.images?.[index];
  if (!image) throw new RangeError("glTF texture references missing image: " + index);
  if (image.uri) return { bytes: bytesFromDataUri(image.uri), mimeType: image.mimeType || image.uri.slice(5,image.uri.indexOf(";")) };
  const bufferView = document.bufferViews?.[image.bufferView];
  const buffer = buffers[bufferView?.buffer || 0];
  if (!bufferView || !buffer) throw new RangeError("glTF image bufferView is unavailable.");
  const start = Number(bufferView.byteOffset || 0), end = start + Number(bufferView.byteLength);
  if (!Number.isSafeInteger(end) || start < 0 || end > buffer.byteLength) throw new RangeError("glTF embedded image range is invalid.");
  return { bytes: buffer.slice(start,end), mimeType: image.mimeType || "application/octet-stream" };
}
function samplerOptions(document, texture) {
  const sampler = document.samplers?.[texture.sampler] || {};
  const wrap = value => value === 33071 ? "clamp-to-edge" : value === 33648 ? "mirror-repeat" : "repeat";
  const filter = value => value === 9728 || value === 9984 || value === 9986 ? "nearest" : "linear";
  return {
    addressModeU: wrap(sampler.wrapS), addressModeV: wrap(sampler.wrapT),
    magFilter: filter(sampler.magFilter), minFilter: filter(sampler.minFilter),
    generateMipmaps: sampler.minFilter == null || sampler.minFilter >= 9984
  };
}

/** Parse a self-contained glTF 2.0 GLB into a PStudio-owned scene asset. */
export async function loadPStudioGLB(input, options = {}) {
  const { document, binary, byteLength } = parseGlb(input);
  if (String(document.asset?.version || "") !== "2.0") throw new TypeError("glTF asset version 2.0 is required.");
  const unsupported = [];
  for (const extension of document.extensionsRequired || []) {
    if (!["KHR_lights_punctual"].includes(extension)) unsupported.push({ feature: "required-extension", extension });
  }
  const reader=makeReader(document,binary), geometries=new Map(),materials=[],textures=[],entities=[];
  const decodedImages=new Map();
  async function textureFor(index) {
    const sourceTexture=document.textures?.[index];
    if(!sourceTexture)throw new RangeError("glTF baseColorTexture index is invalid.");
    const image=extractImage(document,sourceTexture.source,reader.buffers);
    if(typeof options.decodeImage!=="function")throw new Error("An injected decodeImage(bytes, mimeType) function is required to decode GLB images into PStudio RGBA8 textures.");
    let decoded=decodedImages.get(sourceTexture.source);
    if(!decoded){decoded=await options.decodeImage(image.bytes,image.mimeType);decodedImages.set(sourceTexture.source,decoded);}
    if(!decoded||!Number.isSafeInteger(decoded.width)||!Number.isSafeInteger(decoded.height)||!(decoded.data instanceof Uint8Array)||decoded.data.length!==decoded.width*decoded.height*4)throw new TypeError("decodeImage must return width, height and owned RGBA8 Uint8Array pixels.");
    const id="glb.texture."+sourceTexture.source;
    if(!textures.some(item=>item.id===id))textures.push({id,width:decoded.width,height:decoded.height,data:new Uint8Array(decoded.data),format:"rgba8unorm-srgb",...samplerOptions(document,sourceTexture)});
    return id;
  }
  const materialIndexMap=new Map();
  async function materialFor(index) {
    if(index==null)return materialForDefault();
    if(materialIndexMap.has(index))return materialIndexMap.get(index);
    const source=document.materials?.[index];if(!source)throw new RangeError("glTF primitive references missing material: "+index);
    const pbr=source.pbrMetallicRoughness||{};
    const baseTextureId=pbr.baseColorTexture?await textureFor(pbr.baseColorTexture.index):null;
    const id="glb.material."+index;
    const alphaMode=String(source.alphaMode||"OPAQUE").toLowerCase();
    materials.push({
      id,model:"pbr",baseColor:pbr.baseColorFactor||[1,1,1,1],metallic:pbr.metallicFactor??1,
      roughness:pbr.roughnessFactor??1,emissive:source.emissiveFactor||[0,0,0],
      alphaMode:alphaMode==="mask"?"mask":alphaMode==="blend"?"blend":"opaque",
      doubleSided:source.doubleSided===true,baseColorTextureId:baseTextureId,
      metadata:{alphaCutoff:source.alphaCutoff??0.5,source:"gltf-2.0"}
    });
    for(const feature of ["normalTexture","occlusionTexture","emissiveTexture"])if(source[feature])unsupported.push({feature:"material-"+feature,materialId:id});
    materialIndexMap.set(index,id);return id;
  }
  async function materialForDefault(){const id="glb.material.default";if(!materials.some(item=>item.id===id))materials.push({id,model:"pbr",baseColor:[1,1,1,1],metallic:1,roughness:1});return id;}
  const meshPrimitives=[];
  for(let meshIndex=0;meshIndex<(document.meshes||[]).length;meshIndex++){
    const mesh=document.meshes[meshIndex];
    for(let primitiveIndex=0;primitiveIndex<(mesh.primitives||[]).length;primitiveIndex++){
      const primitive=mesh.primitives[primitiveIndex];
      if((primitive.mode??4)!==4){unsupported.push({feature:"primitive-mode",meshIndex,primitiveIndex,mode:primitive.mode});continue;}
      const positionIndex=primitive.attributes?.POSITION;
      if(positionIndex==null)throw new Error("glTF triangle primitive has no POSITION accessor.");
      const position=reader.accessor(positionIndex);
      if(position.components!==3)throw new TypeError("glTF POSITION accessor must be VEC3.");
      const normals=primitive.attributes.NORMAL==null?null:reader.accessor(primitive.attributes.NORMAL).data;
      const uvs=primitive.attributes.TEXCOORD_0==null?null:reader.accessor(primitive.attributes.TEXCOORD_0).data;
      if(primitive.attributes.TANGENT!=null||primitive.attributes.JOINTS_0!=null||primitive.attributes.WEIGHTS_0!=null||mesh.weights!=null||mesh.primitives[primitiveIndex].targets?.length)unsupported.push({feature:"skinning-morph-or-tangent",meshIndex,primitiveIndex});
      const indices=primitive.indices==null?null:reader.accessor(primitive.indices).data;
      const geometryId="glb.geometry."+meshIndex+"."+primitiveIndex;
      geometries.set(geometryId,{id:geometryId,positions:position.data,normals,uvs,indices,revision:1});
      const materialId=await materialFor(primitive.material);
      meshPrimitives.push({geometryId,materialId});
    }
  }
  const nodes=document.nodes||[],worlds=new Map(),parents=new Map();
  for(let index=0;index<nodes.length;index++)for(const child of nodes[index].children||[]){if(parents.has(child))throw new Error("glTF node has more than one parent.");parents.set(child,index);}
  const sceneIndex=Number(document.scene||0),rootNodes=document.scenes?.[sceneIndex]?.nodes||nodes.map((_,i)=>i).filter(i=>!parents.has(i));
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const walk=(nodeIndex,parentWorld,stack)=>{
    if(!Number.isSafeInteger(nodeIndex)||nodeIndex<0||nodeIndex>=nodes.length)throw new RangeError("glTF node reference is invalid.");
    if(stack.has(nodeIndex))throw new Error("glTF node hierarchy contains a cycle.");
    const node=nodes[nodeIndex],local=matrixTRS(node),world=multiply4(parentWorld,local);
    worlds.set(nodeIndex,world);
    if(node.mesh!=null){
      const matching=meshPrimitives.filter(item=>item.geometryId.startsWith("glb.geometry."+node.mesh+"."));
      matching.forEach((item,primitiveIndex)=>entities.push({id:"glb.node."+nodeIndex+".primitive."+primitiveIndex,geometryId:item.geometryId,materialId:item.materialId,matrixWorld:world,visible:true}));
    }
    const next=new Set(stack);next.add(nodeIndex);
    for(const child of node.children||[])walk(child,world,next);
  };
  for(const root of rootNodes)walk(root,identity,new Set());
  if((document.skins||[]).length)unsupported.push({feature:"skin-skeleton-import",count:document.skins.length});
  if((document.animations||[]).length)unsupported.push({feature:"animation-clip-import",count:document.animations.length});
  if(document.extensionsUsed?.includes("KHR_lights_punctual"))unsupported.push({feature:"KHR_lights_punctual-node-import"});
  const asset=createPStudioGraphicsSceneAsset({
    id:options.id||"glb.scene",geometries:[...geometries.values()],materials,textures,entities,
    metadata:{source:"pstudio-glb-loader",glbByteLength:byteLength,gltfVersion:"2.0"}
  });
  const report=Object.freeze({supported:unsupported.length===0,geometryCount:asset.geometries.length,materialCount:asset.materials.length,textureCount:asset.textures.length,entityCount:asset.entities.length,unsupported:Object.freeze(unsupported.map(item=>Object.freeze({...item})))});
  if(options.strict!==false&&!report.supported){const error=new Error("GLB contains features not yet supported by the PStudio-native loader.");error.code="PSTUDIO_GLB_UNSUPPORTED_FEATURES";error.report=report;throw error;}
  return Object.freeze({asset,report,document});
}

/** Registers the native GLB loader through the PStudio-owned Asset Core injection boundary. */
export function createPStudioGLBAssetLoader(options = {}) {
  return async (descriptor, dependencies = {}) => {
    const buffer = dependencies[descriptor.id] || options.resolveBytes?.(descriptor);
    if (!buffer) throw new Error("GLB byte source is unavailable for asset: " + descriptor.id);
    const result = await loadPStudioGLB(buffer, { ...options, id: descriptor.id });
    return { value: result, dispose: () => { try { options.onDispose?.(result); } catch (_) {} } };
  };
}
