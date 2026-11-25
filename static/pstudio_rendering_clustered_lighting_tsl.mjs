import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

export const PSTUDIO_CLUSTER_GRID = Object.freeze({ x: 16, y: 9, z: 16 });
export const PSTUDIO_CLUSTER_MAX_LIGHTS = 96;
export const PSTUDIO_CLUSTER_MAX_PER_CELL = 24;
export const PSTUDIO_CLUSTER_RECORD_WIDTH = PSTUDIO_CLUSTER_MAX_PER_CELL + 1;
const DEFAULT_FAR = 2400;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function depthSlice(depth, near, far, slices) {
  const clamped = Math.max(near, Math.min(far, depth));
  const value = Math.floor(Math.log(clamped / near) / Math.log(far / near) * slices);
  return Math.max(0, Math.min(slices - 1, value));
}

function worldToViewPosition(light, camera) {
  const position = new THREE.Vector3();
  light.updateWorldMatrix?.(true, false);
  if (typeof light.getWorldPosition === 'function') light.getWorldPosition(position);
  else if (light.position?.isVector3) position.copy(light.position);
  else throw new TypeError('Clustered lights must expose a Three.js world position.');
  return position.applyMatrix4(camera.matrixWorldInverse);
}

/**
 * Reproduces PStudio's established 16x9x16 forward-cluster layout.
 * Lights that overflow any cluster remain in native lighting and are not
 * silently truncated from the active light set.
 */
export function buildPStudioClusteredLightData(options = {}) {
  const camera = options.camera;
  if (!camera?.isCamera) throw new TypeError('A Three.js camera is required for clustered light packing.');
  camera.updateMatrixWorld?.(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  const grid = {
    x: Math.max(1, Math.floor(finite(options.grid?.x, PSTUDIO_CLUSTER_GRID.x))),
    y: Math.max(1, Math.floor(finite(options.grid?.y, PSTUDIO_CLUSTER_GRID.y))),
    z: Math.max(1, Math.floor(finite(options.grid?.z, PSTUDIO_CLUSTER_GRID.z)))
  };
  const maxLights = Math.max(1, Math.min(96, Math.floor(finite(options.maxLights, PSTUDIO_CLUSTER_MAX_LIGHTS))));
  const maxPerCell = Math.max(1, Math.min(24, Math.floor(finite(options.maxPerCell, PSTUDIO_CLUSTER_MAX_PER_CELL))));
  const clusterCount = grid.x * grid.y * grid.z;
  const recordWidth = maxPerCell + 1;
  const lightData = new Float32Array(maxLights * 3 * 4);
  const clusterData = new Float32Array(clusterCount * recordWidth * 4);
  const counts = new Uint8Array(clusterCount);
  const clusteredLights = new Set();
  const nativeFallbackLights = new Set();
  const near = Math.max(0.001, finite(camera.near, 0.1));
  const far = Math.max(near * 1.01, Math.min(finite(camera.far, DEFAULT_FAR), finite(options.maxFar, DEFAULT_FAR) * 2));
  const projection = camera.projectionMatrix.elements;
  const lights = [];

  for (const light of options.lights || []) {
    if (!light?.isPointLight || finite(light.intensity, 0) <= 0) continue;
    if (lights.length >= maxLights) {
      nativeFallbackLights.add(light);
      continue;
    }
    const position = worldToViewPosition(light, camera);
    const range = Math.max(near, finite(light.distance, 0) || finite(options.defaultRange, DEFAULT_FAR));
    lights.push({ light, position, range });
  }

  const push = (x, y, z, index) => {
    const cluster = (z * grid.y + y) * grid.x + x;
    const count = counts[cluster];
    clusterData[(cluster * recordWidth + count + 1) * 4] = index;
    counts[cluster] = count + 1;
  };

  for (let index = 0; index < lights.length; index++) {
    const { light, position, range } = lights[index];
    const depth = -position.z;
    const base = index * 12;
    lightData[base] = position.x;
    lightData[base + 1] = position.y;
    lightData[base + 2] = position.z;
    lightData[base + 3] = range;
    lightData[base + 4] = finite(light.color?.r, 1);
    lightData[base + 5] = finite(light.color?.g, 1);
    lightData[base + 6] = finite(light.color?.b, 1);
    lightData[base + 7] = Math.max(0, finite(light.intensity, 0));
    lightData[base + 8] = Math.max(0.01, finite(light.decay, 2));

    if (depth + range < near || depth - range > far) {
      nativeFallbackLights.add(light);
      continue;
    }

    let minX = 0, maxX = grid.x - 1, minY = 0, maxY = grid.y - 1;
    if (depth - range > near) {
      const clipW = -position.z;
      if (clipW > 0) {
        const centerX = (position.x * projection[0]) / clipW;
        const centerY = (position.y * projection[5]) / clipW;
        const radiusX = Math.abs(projection[0] * range / Math.max(near, depth - range));
        const radiusY = Math.abs(projection[5] * range / Math.max(near, depth - range));
        minX = Math.max(0, Math.floor(((centerX - radiusX) * 0.5 + 0.5) * grid.x));
        maxX = Math.min(grid.x - 1, Math.floor(((centerX + radiusX) * 0.5 + 0.5) * grid.x));
        minY = Math.max(0, Math.floor(((centerY - radiusY) * 0.5 + 0.5) * grid.y));
        maxY = Math.min(grid.y - 1, Math.floor(((centerY + radiusY) * 0.5 + 0.5) * grid.y));
        if (maxX < minX || maxY < minY) {
          nativeFallbackLights.add(light);
          continue;
        }
      }
    }

    const minZ = depthSlice(Math.max(near, depth - range), near, far, grid.z);
    const maxZ = depthSlice(Math.min(far, depth + range), near, far, grid.z);
    const clusters = [];
    let fitsEveryCluster = true;
    for (let z = minZ; z <= maxZ && fitsEveryCluster; z++) {
      for (let y = minY; y <= maxY && fitsEveryCluster; y++) {
        for (let x = minX; x <= maxX; x++) {
          const cluster = (z * grid.y + y) * grid.x + x;
          if (counts[cluster] >= maxPerCell) {
            fitsEveryCluster = false;
            break;
          }
          clusters.push([x, y, z]);
        }
      }
    }
    if (!fitsEveryCluster) {
      nativeFallbackLights.add(light);
      continue;
    }

    clusteredLights.add(light);
    for (const [x, y, z] of clusters) push(x, y, z, index);
  }

  for (let cluster = 0; cluster < clusterCount; cluster++) {
    clusterData[(cluster * recordWidth) * 4] = counts[cluster];
  }

  return Object.freeze({
    grid: Object.freeze(grid),
    near,
    far,
    maxLights,
    maxPerCell,
    clusterCount,
    recordWidth,
    lightCount: lights.length,
    clusteredLights,
    nativeFallbackLights,
    counts,
    lightData,
    clusterData,
    bytes: lightData.byteLength + clusterData.byteLength
  });
}

function validateStorageLimits(renderer, lightBytes, clusterBytes) {
  const device = renderer?.backend?.device;
  const limits = device?.limits || {};
  const maxBinding = Number(limits.maxStorageBufferBindingSize);
  const maxBuffer = Number(limits.maxBufferSize);
  for (const [name, bytes] of [['light data', lightBytes], ['cluster indices', clusterBytes]]) {
    if (Number.isFinite(maxBinding) && bytes > maxBinding) {
      throw new RangeError(`PStudio clustered ${name} exceeds maxStorageBufferBindingSize.`);
    }
    if (Number.isFinite(maxBuffer) && bytes > maxBuffer) {
      throw new RangeError(`PStudio clustered ${name} exceeds maxBufferSize.`);
    }
  }
}

/**
 * Owns the WebGPU-only StorageBufferAttributes for packed cluster records.
 * CPU data is uploaded in-place; buffer identities remain stable across frames.
 */
export function createPStudioTSLClusterStorage(renderer, options = {}) {
  if (renderer?.backend?.isWebGPUBackend !== true) {
    throw new TypeError('PStudio clustered storage requires an initialized WebGPU backend.');
  }
  const grid = options.grid || PSTUDIO_CLUSTER_GRID;
  const maxLights = Math.max(1, Math.min(96, Math.floor(finite(options.maxLights, PSTUDIO_CLUSTER_MAX_LIGHTS))));
  const maxPerCell = Math.max(1, Math.min(24, Math.floor(finite(options.maxPerCell, PSTUDIO_CLUSTER_MAX_PER_CELL))));
  const clusterCount = grid.x * grid.y * grid.z;
  const recordWidth = maxPerCell + 1;
  const lightFloats = maxLights * 3 * 4;
  const clusterFloats = clusterCount * recordWidth * 4;
  const lightBytes = lightFloats * Float32Array.BYTES_PER_ELEMENT;
  const clusterBytes = clusterFloats * Float32Array.BYTES_PER_ELEMENT;
  validateStorageLimits(renderer, lightBytes, clusterBytes);

  if (typeof THREE.StorageBufferAttribute !== 'function' || typeof TSL.storage !== 'function') {
    throw new Error('Three.js r187 StorageBufferAttribute/TSL storage APIs are unavailable.');
  }

  const lightAttribute = new THREE.StorageBufferAttribute(lightFloats / 4, 4);
  const clusterAttribute = new THREE.StorageBufferAttribute(clusterFloats / 4, 4);
  lightAttribute.setUsage(THREE.DynamicDrawUsage);
  clusterAttribute.setUsage(THREE.DynamicDrawUsage);
  const lightStorage = TSL.storage(lightAttribute, 'vec4', lightAttribute.count).toReadOnly();
  const clusterStorage = TSL.storage(clusterAttribute, 'vec4', clusterAttribute.count).toReadOnly();
  const nearUniform = TSL.uniform(0.1);
  const farUniform = TSL.uniform(DEFAULT_FAR);
  const enabledUniform = TSL.uniform(1);
  let lastRevision = null;
  let lastEnabled = true;
  let disposed = false;
  let uploads = 0;
  let lastLightCount = 0;

  return Object.freeze({
    kind: 'pstudio-tsl-cluster-storage',
    lightStorage,
    clusterStorage,
    nearUniform,
    farUniform,
    enabledUniform,
    grid: Object.freeze({ ...grid }),
    maxLights,
    maxPerCell,
    recordWidth,
    lightAttribute,
    clusterAttribute,
    update(snapshot) {
      if (disposed) return false;
      if (!snapshot?.lightData || !snapshot?.clusterData
        || snapshot.lightData.length !== lightAttribute.array.length
        || snapshot.clusterData.length !== clusterAttribute.array.length) {
        throw new TypeError('PStudio cluster snapshot does not match the allocated WebGPU buffer layout.');
      }
      lightAttribute.array.set(snapshot.lightData);
      clusterAttribute.array.set(snapshot.clusterData);
      lightAttribute.needsUpdate = true;
      clusterAttribute.needsUpdate = true;
      nearUniform.value = Math.max(0.001, finite(snapshot.near, 0.1));
      farUniform.value = Math.max(nearUniform.value * 1.01, finite(snapshot.far, DEFAULT_FAR));
      lastEnabled = snapshot.enabled !== false;
      enabledUniform.value = lastEnabled ? 1 : 0;
      lastRevision = Number.isFinite(Number(snapshot.revision)) ? Number(snapshot.revision) : null;
      lastLightCount = Math.max(0, Math.min(maxLights, Math.floor(finite(snapshot.lightCount, 0))));
      uploads++;
      return true;
    },
    getState() {
      return Object.freeze({ disposed, uploads, lastLightCount, lightBytes, clusterBytes, recordWidth, clusterCount, enabled: lastEnabled, revision: lastRevision });
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      lightAttribute.dispose?.();
      clusterAttribute.dispose?.();
      return true;
    }
  });
}


function requiredClusterTSLFunctions() {
  const names = [
    'screenUV','positionView','normalView','float','int','vec3','floor','clamp','log',
    'max','Loop','If','storage','getDistanceAttenuation'
  ];
  return names.filter(name=>TSL[name]===undefined);
}

/**
 * Emits clustered point-light irradiance into Three.js' PBR lighting context.
 * Cluster bins are camera-space and use the same normalized screen tiles and
 * logarithmic view-depth slicing as PStudio's existing WebGL cluster shader.
 */
export function createPStudioTSLClusterIrradianceNode(storage) {
  if (!storage?.lightStorage?.isNode || !storage?.clusterStorage?.isNode) {
    throw new TypeError('PStudio clustered irradiance requires initialized TSL StorageBuffer nodes.');
  }
  const missing=requiredClusterTSLFunctions();
  if(missing.length)throw new Error('Three.js r187 is missing clustered TSL functions: '+missing.join(', '));

  const {grid,maxPerCell,recordWidth,nearUniform,farUniform,enabledUniform}=storage;
  const lightRecords=storage.lightStorage;
  const clusterRecords=storage.clusterStorage;
  const expression=TSL.Fn(()=>{
    const uv=TSL.screenUV;
    const px=TSL.int(TSL.floor(TSL.clamp(uv.x,0,0.999999).mul(grid.x)));
    const py=TSL.int(TSL.floor(TSL.clamp(uv.y,0,0.999999).mul(grid.y)));
    const near=TSL.float(nearUniform);
    const far=TSL.float(farUniform);
    const depth=TSL.max(TSL.positionView.z.negate(),near);
    const depthRatio=TSL.log(depth.div(near)).div(TSL.log(far.div(near)).max(1e-5));
    const pz=TSL.int(TSL.floor(TSL.clamp(depthRatio.mul(grid.z),0,grid.z-1)));
    const clusterIndex=pz.mul(grid.y*grid.x).add(py.mul(grid.x)).add(px);
    const clusterBase=clusterIndex.mul(recordWidth);
    const count=TSL.int(clusterRecords.element(clusterBase).x).clamp(0,maxPerCell);
    const total=TSL.vec3(0).toVar();

    TSL.Loop({start:0,end:maxPerCell},({i})=>{
      TSL.If(i.lessThan(count),()=>{
        const lightIndex=TSL.int(clusterRecords.element(clusterBase.add(i).add(1)).x);
        const lightBase=lightIndex.mul(3);
        const positionRange=lightRecords.element(lightBase);
        const colorIntensity=lightRecords.element(lightBase.add(1));
        const decay=lightRecords.element(lightBase.add(2));
        const delta=positionRange.xyz.sub(TSL.positionView);
        const distance=delta.length().max(0.0001);
        const direction=delta.div(distance);
        const attenuation=TSL.getDistanceAttenuation({
          lightDistance:distance,
          cutoffDistance:positionRange.w,
          decayExponent:decay.x
        });
        const cosine=TSL.max(TSL.normalView.dot(direction),0);
        total.addAssign(colorIntensity.rgb.mul(colorIntensity.w).mul(attenuation).mul(cosine));
      });
    });

    return total.mul(TSL.float(enabledUniform));
  })();

  return new THREE.IrradianceNode(expression);
}

/**
 * Attaches the cluster irradiance term to converted PBR NodeMaterials while
 * retaining every non-clustered scene light. The input snapshot owns membership.
 */
export function applyPStudioTSLClusteredLighting(root,options={}) {
  if(!root?.traverse)throw new TypeError('A Three.js Object3D or Scene is required.');
  const storage=options.storage;
  const snapshot=options.snapshot;
  if(!storage||!snapshot)throw new TypeError('PStudio cluster storage and initial packed snapshot are required.');
  if(typeof THREE.LightsNode!=='function'||typeof THREE.IrradianceNode!=='function'){
    throw new Error('Three.js r187 LightsNode/IrradianceNode exports are unavailable.');
  }

  const sceneLights=[];
  const materials=new Set();
  root.traverse(object=>{
    if(object?.isLight)sceneLights.push(object);
    if(!(object?.isMesh||object?.isLine||object?.isPoints||object?.isSprite)||!object.material)return;
    const assigned=Array.isArray(object.material)?object.material:[object.material];
    for(const material of assigned)if(material?.isNodeMaterial===true)materials.add(material);
  });

  const entries=[];
  const clusteredNode=createPStudioTSLClusterIrradianceNode(storage);
  let disposed=false;
  let lastMembership='';
  let lastRevision = Number.isFinite(Number(snapshot.revision)) ? Number(snapshot.revision) : null;

  for(const material of materials){
    if(material.lightsNode&&typeof material.lightsNode.getLights!=='function'){
      throw new Error('PStudio cannot replace a custom NodeMaterial lightsNode without an explicit adapter.');
    }
    const originalLightsNode=material.lightsNode??null;
    const baseLights=originalLightsNode?.getLights?.()||sceneLights;
    const lightsNode=new THREE.LightsNode();
    const entry={material,originalLightsNode,baseLights:[...baseLights],lightsNode};
    material.lightsNode=lightsNode;
    entries.push(entry);
  }

  function updateLights(clusteredSet) {
    const membership=[];
    for(const entry of entries){
      // The legacy clusterer suppresses clustered lights by toggling
      // Object3D.visible. Membership is authoritative here; a light that has
      // left the cluster set must return to the native path even if it was
      // invisible in the preceding frame.
      const retained=entry.baseLights.filter(light=>!light?.isLight||!clusteredSet.has(light));
      const signature=retained.map(light=>light?.uuid||light?.id||String(light)).join('|');
      membership.push(signature);
      entry.lightsNode.setLights([...retained,clusteredNode]);
    }
    const next=membership.join('||');
    if(next!==lastMembership){
      lastMembership=next;
      for(const entry of entries)entry.material.needsUpdate=true;
      return true;
    }
    return false;
  }

  try{
    updateLights(snapshot.clusteredLights||new Set());
    storage.update(snapshot);
  }catch(error){
    for(const entry of entries)if(entry.material.lightsNode===entry.lightsNode)entry.material.lightsNode=entry.originalLightsNode;
    throw new Error('PStudio failed to attach clustered TSL lighting; all material light lists were restored.',{cause:error});
  }

  return Object.freeze({
    kind:'pstudio-tsl-clustered-lighting',
    materialCount:entries.length,
    update(nextSnapshot){
      if(disposed)return false;
      const revision = Number.isFinite(Number(nextSnapshot?.revision)) ? Number(nextSnapshot.revision) : null;
      const membershipChanged = (nextSnapshot?.clusteredLights||new Set()).size !== (snapshot.clusteredLights||new Set()).size
        || [...(nextSnapshot?.clusteredLights||new Set())].some(light => !(snapshot.clusteredLights||new Set()).has(light));
      if(revision === null || revision !== lastRevision || membershipChanged || nextSnapshot?.enabled !== (snapshot.enabled !== false)) {
        storage.update(nextSnapshot);
        updateLights(nextSnapshot.clusteredLights||new Set());
        lastRevision = revision;
        return true;
      }
      return false;
    },
    getState(){
      return Object.freeze({
        disposed,
        materialCount:entries.length,
        storage:storage.getState(),
        clusteredLights:lastMembership
      });
    },
    dispose(){
      if(disposed)return false;
      disposed=true;
      for(const entry of entries){
        if(entry.material.lightsNode===entry.lightsNode)entry.material.lightsNode=entry.originalLightsNode;
        entry.material.needsUpdate=true;
      }
      return true;
    }
  });
}
