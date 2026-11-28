const test = require("node:test");
const assert = require("node:assert/strict");
const { createPStudioGraphicsSceneCore } = require("../static/pstudio_graphics_scene_core.mjs");
const { createPStudioGraphicsAssetCore } = require("../static/pstudio_graphics_asset_core.mjs");
const { createPStudioGraphicsCore } = require("../static/pstudio_graphics_core.mjs");

test("PStudio Scene Core owns scene and entity hierarchy without Three.js objects", () => {
  const core = createPStudioGraphicsSceneCore();
  core.createScene({ id: "world.main", name: "World" });
  core.createEntity({ id: "root", sceneId: "world.main", transform: { position: [2, 0, 0] } });
  core.createEntity({ id: "child", sceneId: "world.main", parentId: "root", transform: { position: [0, 3, 0] }, geometryId: "geo.cube", materialIds: ["mat.stone"] });
  const child = core.getEntity("child");
  assert.deepEqual(child.worldMatrix.slice(12, 15), [2, 3, 0]);
  assert.equal(child.parentId, "root");
  assert.deepEqual(child.materialIds, ["mat.stone"]);
  assert.equal(core.stats().entityCount, 2);
  core.dispose();
});

test("Scene Core rejects cycles, cross-scene parenting and implicit destructive removal", () => {
  const core = createPStudioGraphicsSceneCore();
  core.createScene({ id: "scene.a" });
  core.createScene({ id: "scene.b" });
  core.createEntity({ id: "a", sceneId: "scene.a" });
  core.createEntity({ id: "b", sceneId: "scene.a", parentId: "a" });
  core.createEntity({ id: "other", sceneId: "scene.b" });
  assert.throws(() => core.setEntityParent("a", "b"), /cycle/);
  assert.throws(() => core.setEntityParent("a", "other"), /same scene/);
  assert.throws(() => core.removeEntity("a"), /children/);
  assert.equal(core.removeEntity("a", { recursive: true }), 2);
  assert.equal(core.getEntity("b"), null);
  core.dispose();
});

test("Scene Core updates descendant world transforms and freezes snapshots", () => {
  const core = createPStudioGraphicsSceneCore();
  core.createScene({ id: "scene" });
  core.createEntity({ id: "parent", sceneId: "scene", transform: { position: [1, 2, 3] } });
  core.createEntity({ id: "child", sceneId: "scene", parentId: "parent", transform: { position: [4, 5, 6] } });
  core.updateEntity("parent", { transform: { position: [7, 8, 9] } });
  const snapshot = core.snapshot("scene");
  const child = snapshot.entities.find(value => value.id === "child");
  assert.deepEqual(child.worldMatrix.slice(12, 15), [11, 13, 15]);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(child.transform.position));
  assert.throws(() => core.updateEntity("parent", { transform: { rotation: [0, 0, 0, 0] } }), /non-zero/);
  core.dispose();
});

test("Asset Core deduplicates concurrent loads and protects dependency references", async () => {
  const core = createPStudioGraphicsAssetCore({ cpuBudgetBytes: 1024 });
  let loads = 0, disposed = 0;
  const descriptor = { id: "asset.texture", type: "texture", estimatedBytes: 128 };
  const [first, second] = await Promise.all([
    core.load(descriptor, async () => { loads++; return { value: { handle: 1 }, dispose: () => { disposed++; } }; }),
    core.load(descriptor, async () => { loads++; return { value: { handle: 2 }, dispose: () => { disposed++; } }; })
  ]);
  assert.equal(first, second);
  assert.equal(loads, 1);
  core.register({ id: "asset.model", type: "model", dependencies: ["asset.texture"], estimatedBytes: 256 }, { mesh: true });
  assert.throws(() => core.remove("asset.texture"), /dependent assets/);
  const lease = core.retain("asset.model");
  assert.throws(() => core.dispose(), /retained assets/);
  assert.equal(lease.release(), true);
  core.dispose();
  assert.equal(disposed, 1);
});

test("Asset Core uses separate CPU/GPU budgets and evicts only unretained least-recently-used assets", () => {
  const core = createPStudioGraphicsAssetCore({ cpuBudgetBytes: 100, gpuBudgetBytes: 100 });
  const reasons = [];
  core.register({ id: "cpu.old", type: "buffer", domain: "cpu", estimatedBytes: 60 }, {}, { dispose: (_, reason) => reasons.push(reason) });
  const lease = core.retain("cpu.old");
  core.register({ id: "gpu.texture", type: "texture", domain: "gpu", estimatedBytes: 90 }, {});
  assert.throws(() => core.register({ id: "cpu.new", type: "buffer", domain: "cpu", estimatedBytes: 60 }, {}), /cannot admit/);
  lease.release();
  core.register({ id: "cpu.new", type: "buffer", domain: "cpu", estimatedBytes: 60 }, {});
  assert.deepEqual(reasons, ["budget"]);
  assert.equal(core.stats().gpuBytes, 90);
  assert.equal(core.stats().cpuBytes, 60);
  core.dispose({ force: true });
});

test("Graphics Core composes native Scene and Asset ownership cores", async () => {
  const hal = { initialize: async () => ({ state: "ready", backend: "webgpu" }), render: () => true, resize: () => true, dispose: () => true, getState: () => ({ state: "ready", backend: "webgpu" }) };
  const core = createPStudioGraphicsCore({ hal });
  core.scene.createScene({ id: "main" });
  core.scene.createEntity({ id: "camera", sceneId: "main" });
  core.assets.register({ id: "mesh.asset", type: "mesh", estimatedBytes: 32 }, { positions: new Float32Array([0, 0, 0]) });
  assert.equal(core.stats().scene.entityCount, 1);
  assert.equal(core.stats().assets.assetCount, 1);
  assert.equal(core.dispose(), true);
});
