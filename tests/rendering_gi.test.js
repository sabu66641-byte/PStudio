const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gi = import('../static/pstudio_rendering_gi.mjs');

test('GI capture cadence and resolution are selected without loading a renderer', async () => {
  const module = await gi;
  assert.equal(module.dynamicProbeCaptureIntervalMs(5, true), 300);
  assert.equal(module.dynamicProbeCaptureIntervalMs(8, true), 550);
  assert.equal(module.dynamicProbeCaptureIntervalMs(11, true), 900);
  assert.equal(module.dynamicProbeCaptureIntervalMs(20, true), 1500);
  assert.equal(module.dynamicProbeCaptureIntervalMs(3, false), 450);
  assert.equal(module.dynamicProbeCaptureIntervalMs(6, false), 900);
  assert.equal(module.dynamicProbeCaptureIntervalMs(20, false), 1500);
  assert.equal(module.dynamicProbeCaptureResolution('ultra'), 192);
  assert.equal(module.dynamicProbeCaptureResolution('maximum'), 128);
  assert.equal(module.dynamicProbeCaptureResolution('high'), 96);
  assert.equal(module.dynamicProbeCaptureResolution('balanced'), 64);
});

test('dirty probe selection is deterministic, round-robin and bounded', async () => {
  const { nextDirtyProbeIndex } = await gi;
  const dirty = new Uint8Array([0, 1, 0, 1, 0]);
  assert.equal(nextDirtyProbeIndex(dirty, 0), 1);
  assert.equal(nextDirtyProbeIndex(dirty, 2), 3);
  assert.equal(nextDirtyProbeIndex(dirty, 4), 1);
  assert.equal(nextDirtyProbeIndex(new Uint8Array(4), 0), -1);
  assert.equal(nextDirtyProbeIndex(null, 0), -1);
});

test('light changes invalidate only probes inside the old/new influence regions', async () => {
  const { findChangedProbeIndices } = await gi;
  const probes = [
    { position: { x: 0, y: 0, z: 0 } },
    { position: { x: 2, y: 0, z: 0 } },
    { position: { x: 5, y: 0, z: 0 } },
    { position: { x: 10, y: 0, z: 0 } }
  ];
  const oldLights = [{ key: 'key', signature: 'a', position: [0, 0, 0], radius: 1 }];
  const newLights = [{ key: 'key', signature: 'b', position: [5, 0, 0], radius: 1 }];
  assert.deepEqual(findChangedProbeIndices(probes, oldLights, newLights, 0), [0, 2]);
  assert.deepEqual(findChangedProbeIndices(probes, oldLights, oldLights, 0), []);
  assert.deepEqual(findChangedProbeIndices(probes, [], [{ key: 'sun', signature: 'a', position: [0, 0, 0], radius: 0 }]), [0, 1, 2, 3]);
});

test('SH temporal blending converges smoothly and mutates the reusable buffer', async () => {
  const { blendSHCoefficients } = await gi;
  const current = new Float32Array(27);
  const incoming = new Float32Array(27).fill(1);
  const alpha = blendSHCoefficients(current, incoming, 240, 240);
  assert.ok(alpha > 0.45 && alpha < 0.55);
  assert.ok(current[0] > 0.49 && current[0] < 0.51);
  const before = current;
  blendSHCoefficients(current, incoming, 240, 240);
  assert.equal(current, before);
  assert.ok(current[0] > 0.74 && current[0] < 0.76);
  assert.equal(blendSHCoefficients(current, incoming, 0, 240), 0);
});

test('dynamic SH contributions fade out smoothly and retire below the residual threshold', async () => {
  const { decaySHCoefficients } = await gi;
  const coefficients = new Float32Array(27).fill(1);
  const first = decaySHCoefficients(coefficients, 320, 320, 1e-4);
  assert.equal(first.finished, false);
  assert.ok(coefficients[0] > 0.49 && coefficients[0] < 0.51);
  const second = decaySHCoefficients(coefficients, 8000, 320, 1e-4);
  assert.equal(second.finished, true);
  assert.equal(coefficients[0], 0);
});

test('GI module is wired into the shared runtime and dynamic probe capture path', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
  assert.match(html, /PStudioRenderingGI\s*=\s*await import\('\/static\/pstudio_rendering_gi\.mjs/);
  assert.match(engine, /findChangedProbeIndices/);
  assert.match(engine, /blendSHCoefficients/);
  assert.match(engine, /decaySHCoefficients/);
  assert.match(engine, /dynamicProbeSnapshots/);
});


test('clustered light data preserves the 16x9x16 view-space record layout',async()=>{
  const THREE=await import('three/webgpu');
  const {buildPStudioClusteredLightData,PSTUDIO_CLUSTER_GRID,PSTUDIO_CLUSTER_MAX_LIGHTS,PSTUDIO_CLUSTER_MAX_PER_CELL}=await import('../static/pstudio_rendering_clustered_lighting_tsl.mjs');
  const camera=new THREE.PerspectiveCamera(60,1,0.1,100);
  camera.position.set(0,0,0);
  camera.lookAt(0,0,-1);
  camera.updateMatrixWorld(true);
  const light=new THREE.PointLight(0xff8040,3,20,2);
  light.position.set(0,0,-8);
  light.updateMatrixWorld(true);
  // The production clusterer hides successfully clustered lights from the
  // legacy renderer. They must remain in the source set on subsequent updates.
  light.visible=false;
  const snapshot=buildPStudioClusteredLightData({camera,lights:[light],maxFar:100});
  assert.deepEqual(PSTUDIO_CLUSTER_GRID,{x:16,y:9,z:16});
  assert.equal(PSTUDIO_CLUSTER_MAX_LIGHTS,96);
  assert.equal(PSTUDIO_CLUSTER_MAX_PER_CELL,24);
  assert.equal(snapshot.lightData.length,96*3*4);
  assert.equal(snapshot.clusterData.length,16*9*16*25*4);
  assert.equal(snapshot.lightCount,1);
  assert.equal(snapshot.clusteredLights.has(light),true);
  assert.equal(snapshot.nativeFallbackLights.has(light),false);
  assert.equal(snapshot.lightData[3],20);
  assert.equal(snapshot.lightData[7],3);
  assert.equal(snapshot.lightData[8],2);
  assert.ok(snapshot.counts.some(count=>count===1));
  light.dispose();
});

test('cluster overflow and the 96-light limit retain lights on the native fallback path',async()=>{
  const THREE=await import('three/webgpu');
  const {buildPStudioClusteredLightData}=await import('../static/pstudio_rendering_clustered_lighting_tsl.mjs');
  const camera=new THREE.PerspectiveCamera(60,1,0.1,80);
  camera.lookAt(0,0,-1);
  camera.updateMatrixWorld(true);
  const first=new THREE.PointLight(0xffffff,1,20,2);
  const second=new THREE.PointLight(0xffffff,1,20,2);
  first.position.set(0,0,-5);
  second.position.set(0,0,-6);
  const overflow=buildPStudioClusteredLightData({
    camera,lights:[first,second],grid:{x:1,y:1,z:1},maxLights:2,maxPerCell:1,maxFar:80
  });
  assert.equal(overflow.clusteredLights.has(first),true);
  assert.equal(overflow.clusteredLights.has(second),false);
  assert.equal(overflow.nativeFallbackLights.has(second),true);

  const third=new THREE.PointLight(0xffffff,1,20,2);
  third.position.set(1,0,-5);
  const capped=buildPStudioClusteredLightData({
    camera,lights:[first,second,third],grid:{x:1,y:1,z:1},maxLights:1,maxPerCell:24,maxFar:80
  });
  assert.equal(capped.lightCount,1);
  assert.equal(capped.nativeFallbackLights.has(second),true);
  assert.equal(capped.nativeFallbackLights.has(third),true);
  first.dispose();second.dispose();third.dispose();
});

test('WebGPU clustered StorageBuffers use pinned r187 APIs and update in-place',async()=>{
  const THREE=await import('three/webgpu');
  const TSL=await import('three/tsl');
  const {createPStudioTSLClusterStorage,buildPStudioClusteredLightData}=await import('../static/pstudio_rendering_clustered_lighting_tsl.mjs');
  assert.equal(typeof THREE.StorageBufferAttribute,'function');
  assert.equal(typeof TSL.storage,'function');
  const renderer={backend:{isWebGPUBackend:true,device:{limits:{maxStorageBufferBindingSize:2*1024*1024,maxBufferSize:2*1024*1024}}}};
  const storage=createPStudioTSLClusterStorage(renderer,{grid:{x:1,y:1,z:1},maxLights:2,maxPerCell:1});
  assert.ok(storage.lightStorage?.isNode);
  assert.ok(storage.clusterStorage?.isNode);
  const camera=new THREE.PerspectiveCamera(60,1,0.1,80);
  camera.lookAt(0,0,-1);
  camera.updateMatrixWorld(true);
  const light=new THREE.PointLight(0xffffff,1,20,2);
  light.position.set(0,0,-5);
  const snapshot=buildPStudioClusteredLightData({camera,lights:[light],grid:{x:1,y:1,z:1},maxLights:2,maxPerCell:1,maxFar:80});
  const lightVersion=storage.lightAttribute.version;
  const clusterVersion=storage.clusterAttribute.version;
  assert.equal(storage.update(snapshot),true);
  assert.equal(storage.lightAttribute.version,lightVersion+1);
  assert.equal(storage.clusterAttribute.version,clusterVersion+1);
  assert.deepEqual(storage.lightAttribute.array,snapshot.lightData);
  assert.deepEqual(storage.clusterAttribute.array,snapshot.clusterData);
  assert.equal(storage.getState().uploads,1);
  assert.equal(storage.dispose(),true);
  assert.equal(storage.dispose(),false);
  light.dispose();
});

test('clustered WebGPU storage rejects WebGL backends and unsafe device buffer limits',async()=>{
  const {createPStudioTSLClusterStorage}=await import('../static/pstudio_rendering_clustered_lighting_tsl.mjs');
  assert.throws(()=>createPStudioTSLClusterStorage({backend:{isWebGPUBackend:false}}),/initialized WebGPU backend/);
  const tinyDevice={backend:{isWebGPUBackend:true,device:{limits:{maxStorageBufferBindingSize:16,maxBufferSize:16}}}};
  assert.throws(()=>createPStudioTSLClusterStorage(tinyDevice,{grid:{x:1,y:1,z:1},maxLights:2,maxPerCell:1}),/maxStorageBufferBindingSize/);
});


test('TSL SH irradiance uses the same nine RGB coefficients and PBR lighting context',async()=>{
  const THREE=await import('three/webgpu');
  const TSL=await import('three/tsl');
  const {createPStudioTSLSHProbeNode,attachPStudioTSLSHProbeToMaterial,blendPStudioTSLSHCoefficients}=await import('../static/pstudio_rendering_gi_tsl.mjs');
  assert.equal(typeof THREE.IrradianceNode,'function');
  assert.equal(typeof THREE.LightsNode,'function');
  assert.equal(typeof TSL.uniform,'function');
  const probe=createPStudioTSLSHProbeNode();
  assert.ok(probe.node instanceof THREE.IrradianceNode);
  assert.equal(probe.uniforms.length,9);
  const coefficients=new Float32Array(27);
  for(let index=0;index<27;index++)coefficients[index]=(index+1)*0.01;
  assert.equal(probe.setCoefficients(coefficients),true);
  assert.ok(Math.abs(probe.uniforms[0].value.x-0.01)<1e-7);
  assert.ok(Math.abs(probe.uniforms[8].value.z-0.27)<1e-6);
  const target=new Float32Array(27);
  assert.ok(blendPStudioTSLSHCoefficients(target,coefficients,240,240)>0.49);
  assert.ok(target[0]>0.004&&target[0]<0.006);

  const material=new THREE.MeshStandardNodeMaterial();
  const light=new THREE.DirectionalLight(0xffffff,2);
  const originalLightsNode=material.lightsNode??null;
  const handle=attachPStudioTSLSHProbeToMaterial(material,[light]);
  assert.ok(material.lightsNode instanceof THREE.LightsNode);
  const lights=material.lightsNode.getLights();
  assert.ok(lights.includes(light));
  assert.ok(lights.some(item=>item instanceof THREE.IrradianceNode));
  assert.equal(material.userData.pstudioTSLProbeUniforms.length,9);
  const values=Float32Array.from({length:27},(_,index)=>index/100);
  handle.setCoefficients(values);
  assert.ok(Math.abs(handle.uniforms[1].value.y-0.04)<1e-7);
  assert.equal(handle.dispose(),true);
  assert.equal(handle.dispose(),false);
  assert.equal(material.lightsNode,originalLightsNode);
  assert.equal(material.userData.pstudioTSLProbeUniforms,undefined);
  material.dispose();
  light.dispose();
});

test('TSL SH probe adapter preserves existing scene lights and supports independent per-material uniforms',async()=>{
  const THREE=await import('three/webgpu');
  const {attachPStudioTSLSHProbeToMaterial}=await import('../static/pstudio_rendering_gi_tsl.mjs');
  const scene=new THREE.Scene();
  const key=new THREE.DirectionalLight(0xffffff,2);
  const fill=new THREE.PointLight(0x88aaff,1,20,2);
  scene.add(key,fill);
  const materialA=new THREE.MeshPhysicalNodeMaterial();
  const materialB=new THREE.MeshStandardNodeMaterial();
  const a=attachPStudioTSLSHProbeToMaterial(materialA,[key,fill]);
  const b=attachPStudioTSLSHProbeToMaterial(materialB,[key,fill]);
  assert.equal(materialA.lightsNode.getLights().filter(item=>item.isLight).length,2);
  assert.equal(materialB.lightsNode.getLights().filter(item=>item.isLight).length,2);
  a.setCoefficients(new Float32Array(27).fill(0.5));
  b.setCoefficients(new Float32Array(27).fill(0.25));
  assert.notEqual(a.uniforms[0].value.x,b.uniforms[0].value.x);
  a.dispose();b.dispose();
  materialA.dispose();materialB.dispose();key.dispose();fill.dispose();
});


test('clustered TSL irradiance node builds from the shared StorageBuffer records',async()=>{
  const THREE=await import('three/webgpu');
  const {buildPStudioClusteredLightData,createPStudioTSLClusterStorage,createPStudioTSLClusterIrradianceNode}=await import('../static/pstudio_rendering_clustered_lighting_tsl.mjs');
  const renderer={backend:{isWebGPUBackend:true,device:{limits:{maxStorageBufferBindingSize:1024*1024,maxBufferSize:1024*1024}}}};
  const storage=createPStudioTSLClusterStorage(renderer,{grid:{x:2,y:2,z:2},maxLights:4,maxPerCell:2});
  const camera=new THREE.PerspectiveCamera(60,1,0.1,100);
  camera.lookAt(0,0,-1);
  camera.updateMatrixWorld(true);
  const point=new THREE.PointLight(0xffaa66,2,18,2);
  point.position.set(0,0,-6);
  const snapshot=buildPStudioClusteredLightData({camera,lights:[point],grid:{x:2,y:2,z:2},maxLights:4,maxPerCell:2,maxFar:100});
  const node=createPStudioTSLClusterIrradianceNode(storage);
  assert.ok(node instanceof THREE.IrradianceNode);
  assert.equal(storage.update(snapshot),true);
  assert.equal(storage.getState().lastLightCount,1);
  storage.dispose();
  point.dispose();
});

test('clustered TSL attachment preserves native lights and restores light lists on disposal',async()=>{
  const THREE=await import('three/webgpu');
  const {buildPStudioClusteredLightData,createPStudioTSLClusterStorage,applyPStudioTSLClusteredLighting}=await import('../static/pstudio_rendering_clustered_lighting_tsl.mjs');
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(60,1,0.1,100);
  camera.lookAt(0,0,-1);
  camera.updateMatrixWorld(true);
  const clusteredPoint=new THREE.PointLight(0xffffff,2,15,2);
  clusteredPoint.position.set(0,0,-5);
  const retainedDirectional=new THREE.DirectionalLight(0xffffff,1);
  scene.add(clusteredPoint,retainedDirectional);
  const material=new THREE.MeshStandardNodeMaterial();
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),material);
  scene.add(mesh);
  const originalLightsNode=material.lightsNode??null;
  const grid={x:2,y:2,z:2};
  const snapshot=buildPStudioClusteredLightData({camera,lights:[clusteredPoint],grid,maxLights:4,maxPerCell:2,maxFar:100});
  assert.equal(snapshot.clusteredLights.has(clusteredPoint),true);
  const renderer={backend:{isWebGPUBackend:true,device:{limits:{maxStorageBufferBindingSize:1024*1024,maxBufferSize:1024*1024}}}};
  const storage=createPStudioTSLClusterStorage(renderer,{grid,maxLights:4,maxPerCell:2});
  const handle=applyPStudioTSLClusteredLighting(scene,{storage,snapshot});
  assert.equal(handle.materialCount,1);
  assert.ok(material.lightsNode instanceof THREE.LightsNode);
  const activeLights=material.lightsNode.getLights();
  assert.ok(activeLights.includes(retainedDirectional));
  assert.equal(activeLights.includes(clusteredPoint),false);
  assert.ok(activeLights.some(item=>item instanceof THREE.IrradianceNode));
  assert.equal(handle.getState().storage.uploads,1);

  const fallbackSnapshot={...snapshot,clusteredLights:new Set()};
  assert.equal(handle.update(fallbackSnapshot),true);
  assert.ok(material.lightsNode.getLights().includes(clusteredPoint));
  assert.equal(handle.dispose(),true);
  assert.equal(handle.dispose(),false);
  assert.equal(material.lightsNode,originalLightsNode);
  assert.equal(storage.dispose(),true);
  material.dispose();mesh.geometry.dispose();clusteredPoint.dispose();retainedDirectional.dispose();
});
