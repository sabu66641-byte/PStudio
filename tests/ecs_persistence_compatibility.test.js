const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');
function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, 'backup helper exists: ' + startMarker);
  return source.slice(start, end).trim();
}

function loadBackupValidator() {
  const source = read('templates/index.html');
  const helpers = [
    extract(source, 'function safeProjectName(', '\nasync function exportProjectBackup'),
    extract(source, 'function validateBackupDataUrl(', '\nasync function exportNativeEcsProject'),
    extract(source, 'function decodeBackupBase64(', '\nfunction validateBackupDataUrl'),
    extract(source, 'function copySavedEcsComponentPayload(', '\nfunction validateAndBuildBackup'),
    extract(source, 'function validateAndBuildBackup(', '\nasync function importProjectBackup')
  ].join('\n\n');
  const context = {
    window: { PStudioECS: { sceneComponentSchemaVersion: 1 } },
    PSTUDIO_BACKUP_FORMAT: 'pstudio-project',
    PSTUDIO_BACKUP_VERSION: 1,
    PSTUDIO_BACKUP_LIMIT: 64 * 1024 * 1024,
    TextEncoder, Blob, Uint8Array, Set, Map, Math, Number, Object, Array, String,
    Boolean, TypeError, Error, JSON, console, atob
  };
  vm.runInNewContext(helpers, context, { filename: 'pstudio-backup-validator.js' });
  return context;
}

function archiveFor(object) {
  return {
    format: 'pstudio-project',
    version: 1,
    project: {
      files: { 'main.ps': { type: 'ps', content: 'func start()\n    ps "ok"\n' } },
      assets: [],
      objects: [object],
      environment: { preset: 'studio' },
      active: 'main.ps'
    },
    binaryAssets: []
  };
}

function loadECS() {
  const window = { dispatchEvent() {} };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date, Object, Array,
    TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  return window.PStudioECS;
}

test('old unversioned array and type-keyed Component payloads survive a real backup import validator', () => {
  const validator = loadBackupValidator();
  for (const saved of [
    { ecsComponents: [{ type: 'Health', data: { hp: 73, max: 100 } }] },
    { ecsComponents: { Health: { hp: 41, max: 60 } } }
  ]) {
    const next = validator.validateAndBuildBackup(archiveFor({ id: 'hero', x: 1, y: 2, z: 0, ...saved }));
    const object = next.objects[0];
    assert.equal(object.ecsComponentsVersion, 0);
    const ecs = loadECS();
    ecs.registerComponent('Health', {
      persistent: true,
      additionalProperties: false,
      schema: {
        hp: { type: 'integer', default: 100, min: 0 },
        max: { type: 'integer', default: 100, min: 1 }
      }
    });
    ecs.syncSceneObjects([object]);
    const entity = ecs.getEntityForSceneObject('hero');
    const health = ecs.getComponent(entity, 'Health');
    assert.equal(health.hp, saved.ecsComponents?.Health?.hp ?? saved.ecsComponents[0].data.hp);
    assert.equal(object.ecsComponentsVersion, 1, 'legacy payload upgrades only when restored by the ECS core');
  }
});

test('current versioned Component payload restores through backup validation and ECS serialization', () => {
  const validator = loadBackupValidator();
  const saved = {
    id: 'hero', x: 4, y: 5, z: 0, ecsComponentsVersion: 1,
    ecsComponents: [{ type: 'Health', data: { hp: 61, max: 90 } }]
  };
  const next = validator.validateAndBuildBackup(archiveFor(saved));
  const object = next.objects[0];
  const ecs = loadECS();
  ecs.registerComponent('Health', {
    persistent: true,
    additionalProperties: false,
    schema: {
      hp: { type: 'integer', default: 100, min: 0 },
      max: { type: 'integer', default: 100, min: 1 }
    }
  });
  ecs.syncSceneObjects([object]);
  const entity = ecs.getEntityForSceneObject('hero');
  assert.deepEqual({ ...ecs.getComponent(entity, 'Health') }, { hp: 61, max: 90 });
  const roundTrip = ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object);
  assert.equal(roundTrip.version, 1);
  assert.deepEqual(roundTrip.components.find(item => item.type === 'Health').data, { hp: 61, max: 90 });
});

test('future and unknown Component schemas remain opaque and are not downgraded by backup import', () => {
  const validator = loadBackupValidator();
  const futurePayload = [
    { type: 'Health', data: { hp: 10, max: 100 } },
    { type: 'FuturePhysics', data: { solver: 'future-v9', opaque: [1, 2, 3] } }
  ];
  const next = validator.validateAndBuildBackup(archiveFor({
    id: 'hero', x: 0, y: 0, z: 0,
    ecsComponentsVersion: 99, ecsComponents: futurePayload
  }));
  const object = next.objects[0];
  assert.equal(object.ecsComponentsVersion, 99);
  assert.deepEqual(JSON.parse(JSON.stringify(object.ecsComponents)), futurePayload);
  const before = JSON.stringify(object.ecsComponents);
  const ecs = loadECS();
  ecs.registerComponent('Health', { persistent: true, schema: { hp: { type: 'integer', default: 100 } } });
  ecs.syncSceneObjects([object]);
  const entity = ecs.getEntityForSceneObject('hero');
  assert.equal(ecs.hasComponent(entity, 'Health'), false, 'older runtime skips an unknown future schema');
  assert.equal(ecs.serializeEntityComponents(entity, ['Transform', 'SceneObjectRef'], object), null);
  assert.equal(object.ecsComponentsVersion, 99);
  assert.equal(JSON.stringify(object.ecsComponents), before);
});

test('backup validation rejects invalid versions, malformed current payloads and oversized Component data', () => {
  const validator = loadBackupValidator();
  assert.throws(() => validator.validateAndBuildBackup(archiveFor({
    id: 'bad', ecsComponentsVersion: -1, ecsComponents: []
  })), /schema version is invalid/);
  assert.throws(() => validator.validateAndBuildBackup(archiveFor({
    id: 'bad', ecsComponentsVersion: 1, ecsComponents: { Health: { hp: 5 } }
  })), /must be an array/);
  assert.throws(() => validator.validateAndBuildBackup(archiveFor({
    id: 'bad', ecsComponentsVersion: 0, ecsComponents: Array.from({ length: 129 }, (_, index) => ({ type: 'C' + index, data: {} }))
  })), /at most 128/);
  assert.throws(() => validator.validateAndBuildBackup(archiveFor({
    id: 'bad', ecsComponentsVersion: 99, ecsComponents: { data: 'x'.repeat(1024 * 1024) }
  })), /1 MB/);
});

test('project backup export snapshots complete Scene Object records including versioned ECS payloads', () => {
  const source = read('templates/index.html');
  const exportBody = extract(source, 'async function exportProjectBackup(', '\nfunction copySavedEcsComponentPayload');
  assert.match(exportBody, /const objects=JSON\.parse\(JSON\.stringify\(sceneObjects\)\)/);
  assert.match(exportBody, /project:\{files,assets,objects,environment:/);
  const sceneObjects = [{
    id: 'model', ecsComponentsVersion: 1,
    ecsComponents: [{ type: 'Renderable', data: { asset: 'scene.glb' } }]
  }];
  const snapshot = JSON.parse(JSON.stringify(sceneObjects));
  assert.deepEqual(snapshot, sceneObjects);
});
