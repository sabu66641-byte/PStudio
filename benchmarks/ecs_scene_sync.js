'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

function createECS() {
  const window = { dispatchEvent() {}, CustomEvent: undefined };
  const sandbox = { window, console, Map, Set, Promise, Date, Number, Object, Array, TypeError, Error, Math };
  vm.runInNewContext(fs.readFileSync('static/pstudio_ecs.js', 'utf8'), sandbox);
  return window.PStudioECS;
}

function benchmark(objectCount, frames = 1200) {
  const ecs = createECS();
  ecs.registerComponent('BenchmarkState', {
    persistent: true,
    schema: { value: { type: 'integer', default: 0 } }
  });
  const objects = Array.from({ length: objectCount }, (_, index) => ({
    id: 'object-' + index,
    x: index,
    y: index % 7,
    z: 0,
    ecsComponentsVersion: 1,
    ecsComponents: [{ type: 'BenchmarkState', data: { value: index } }]
  }));

  ecs.syncSceneObjects(objects);
  for (let frame = 0; frame < 200; frame++) {
    ecs.syncSceneObjects(objects);
    ecs.applySceneObjectTransforms(objects);
  }

  const start = performance.now();
  for (let frame = 0; frame < frames; frame++) {
    ecs.syncSceneObjects(objects);
    ecs.applySceneObjectTransforms(objects);
  }
  const elapsedMs = performance.now() - start;
  return {
    sceneObjects: objectCount,
    frames,
    totalMs: Number(elapsedMs.toFixed(2)),
    averageMsPerFrame: Number((elapsedMs / frames).toFixed(5))
  };
}

const results = [100, 500, 1000].map(count => benchmark(count));
process.stdout.write(JSON.stringify({
  benchmark: 'PStudio ECS Scene Object sync + apply',
  note: 'Informational only; no hardware-dependent pass/fail threshold.',
  results
}, null, 2) + '\n');
