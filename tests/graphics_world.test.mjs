import test from "node:test";
import assert from "node:assert/strict";
import {
  createPStudioGraphicsWorldCore,
  createPStudioWorldStreamingCore,
  PSTUDIO_WORLD_TERRAIN_WGSL,
  PSTUDIO_WORLD_FOLIAGE_WGSL,
  uploadPStudioWorldTile,
  packPStudioWorldMaterialTable
} from "../static/pstudio_graphics_world.mjs";

test("terrain tile builds bounded indexed geometry, finite normals and skirt vertices", () => {
  const core = createPStudioGraphicsWorldCore({ maxTerrainSegments: 16 });
  const heights = Float32Array.from({ length: 25 }, (_, i) => Math.sin(i) * 0.2);
  const tile = core.buildTerrainTile({ segments: 4, heightSamples: heights, size: [8, 6], origin: [2, 1, -3], skirtDepth: 2 });
  assert.equal(tile.vertexCount, 25 + 16);
  assert.equal(tile.indexCount, 4 * 4 * 6 + 4 * 4 * 6);
  assert.equal(tile.positions.length, tile.vertexCount * 3);
  assert.equal(tile.normals.length, tile.vertexCount * 3);
  assert.equal(tile.uvs.length, tile.vertexCount * 2);
  assert.ok(tile.indices.every(index => index < tile.vertexCount));
  assert.ok([...tile.normals].every(Number.isFinite));
  assert.equal(tile.bounds.min[1], 1 + Math.min(...heights) - 2);
  assert.equal(tile.bounds.max[0], 10);
  assert.throws(() => core.buildTerrainTile({ segments: 2, heightSamples: [0, 0], size: [1, 1] }), /heightSamples/);
  core.dispose();
  assert.throws(() => core.buildTerrainTile({}), /disposed/);
});

test("screen-space LOD refines nearby tiles, stabilizes hysteresis and culls outside frustum", () => {
  const core = createPStudioGraphicsWorldCore();
  const child = id => ({ id, bounds: { min: [-1, -1, 4], max: [1, 1, 6] }, geometricError: 0.1 });
  const root = { id: "root", bounds: { min: [-2, -2, 2], max: [2, 2, 8] }, geometricError: 10, children: [child("left"), child("right")] };
  const result = core.selectLod({ roots: [root], cameraPosition: [0, 0, 0], projectionScale: 100, pixelErrorThreshold: 2 });
  assert.deepEqual(result.visibleTiles.map(item => item.id), ["left", "right"]);
  const culled = core.selectLod({ roots: [{ ...root, bounds: { min: [100, 100, 100], max: [110, 110, 110] } }], cameraPosition: [0, 0, 0], frustumPlanes: [[-1, 0, 0, 50]] });
  assert.deepEqual(culled.culledTileIds, ["root"]);
  const duplicate = { id: "dup", bounds: { min: [0, 0, 0], max: [1, 1, 1] }, geometricError: 100, children: [{ id: "dup", bounds: { min: [0, 0, 0], max: [1, 1, 1] } }] };
  assert.throws(() => core.selectLod({ roots: [duplicate], cameraPosition: [0, 0, 0], projectionScale: 100 }), /duplicate or cyclic/);
  core.dispose();
});

test("foliage placement is deterministic and slope-aware", () => {
  const core = createPStudioGraphicsWorldCore({ maxFoliageInstances: 500 });
  const input = { bounds: { min: [0, 0, 0], max: [10, 1, 10] }, densityPerSquareUnit: 2, seed: 77, heightAt: (x, z) => x + z, slopeAt: (x) => x / 10, minSlope: 0.5 };
  const a = core.buildFoliageInstances(input), b = core.buildFoliageInstances(input);
  assert.equal(a.count, b.count);
  assert.deepEqual([...a.records], [...b.records]);
  assert.ok(a.count > 0 && a.count <= 500);
  assert.ok(a.records.every(Number.isFinite));
  assert.ok(a.records.filter((_, i) => i % 8 === 1).every(y => y >= 5));
  core.dispose();
});

test("world pass declarations remain explicit and separate from production renderer", () => {
  const core = createPStudioGraphicsWorldCore();
  const passes = core.buildRenderPasses({ includeDebugBounds: true });
  assert.deepEqual(passes.map(p => p.id), ["world.depth", "world.terrain", "world.foliage", "world.transparent", "world.debug-bounds"]);
  assert.ok(PSTUDIO_WORLD_TERRAIN_WGSL.includes("viewProjection"));
  assert.ok(PSTUDIO_WORLD_FOLIAGE_WGSL.includes("viewProjection"));
  const table = packPStudioWorldMaterialTable([{ id: "z", roughness: 0.5 }, { id: "a", baseColor: [0.5, 0.6, 0.7, 1], metalness: 0.2 }]);
  assert.equal(table.count, 2);
  assert.equal(table.indexById.get("a"), 0);
  assert.equal(table.data.length, 32);
  assert.throws(() => packPStudioWorldMaterialTable([{ id: "same" }, { id: "same" }]), /Duplicate/);
  core.dispose();
});

test("world streaming enforces concurrency, prioritizes queued work and accounts resident bytes", async () => {
  let releaseA;
  const started = [], disposed = [];
  const core = createPStudioWorldStreamingCore({
    maxConcurrentLoads: 1, maxResidentBytes: 8, maxResidentTiles: 2,
    loader: async (payload) => {
      started.push(payload.id);
      if (payload.id === "a") await new Promise(resolve => { releaseA = resolve; });
      return { value: { id: payload.id }, byteLength: 4 };
    },
    dispose: (value, meta) => disposed.push([value.id, meta.reason])
  });
  const a = core.request("a", { id: "a" });
  const b = core.request("b", { id: "b" }, 1);
  const c = core.request("c", { id: "c" }, 10);
  await Promise.resolve();
  assert.deepEqual(started, ["a"]);
  releaseA();
  await Promise.all([a, b, c]);
  assert.deepEqual(started, ["a", "c", "b"]);
  assert.equal(core.stats().residentBytes, 8);
  assert.equal(core.stats().residentTiles, 2);
  assert.ok(disposed.some(([, reason]) => reason === "budget-eviction"));
  assert.equal(core.pin("b"), true);
  await core.request("d", { id: "d" }, 0);
  assert.equal(core.stats().residentTiles, 2);
  assert.equal(core.stats().maxResidentTiles, 2);
  assert.equal(core.stats().residentBytes, 8);
  assert.equal(core.release("b"), false);
  assert.ok(disposed.some(([id, reason]) => id === "c" && reason === "budget-eviction"));
  assert.equal(core.unpin("b"), true);
  assert.equal(core.release("b"), true);
  core.dispose();
  assert.equal(core.stats().residentBytes, 0);
  assert.ok(disposed.some(([, reason]) => reason === "core-disposal"));
});

test("world streaming cancellation disposes late stale results and rejects its waiter", async () => {
  let finish;
  const disposed = [];
  const core = createPStudioWorldStreamingCore({
    loader: async () => await new Promise(resolve => { finish = resolve; }),
    dispose: (value, meta) => disposed.push(meta.reason)
  });
  const pending = core.request("late", {});
  await Promise.resolve();
  assert.equal(core.cancel("late"), true);
  await assert.rejects(pending, error => error.name === "AbortError");
  finish({ value: { late: true }, byteLength: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(disposed.includes("stale-load"));
  core.dispose();
});


test("world tile GPU upload owns all buffers and releases each once", () => {
  const created = [], destroyed = [];
  const backend = {
    createResource(descriptor, config) { const value = { id: descriptor.id, byteLength: config.initialData.byteLength }; created.push(value); return value; },
    destroyResource(resource) { destroyed.push(resource.id); return true; }
  };
  const core = createPStudioGraphicsWorldCore();
  const tile = core.buildTerrainTile({ segments: 1, heightSamples: [0, 0, 0, 0] });
  const gpu = uploadPStudioWorldTile(backend, tile, { id: "tile.0" });
  assert.equal(created.length, 4);
  assert.equal(gpu.vertexCount, 4);
  assert.equal(gpu.indexCount, 6);
  assert.equal(gpu.dispose(), true);
  assert.equal(gpu.dispose(), false);
  assert.equal(destroyed.length, 4);
  core.dispose();
});
