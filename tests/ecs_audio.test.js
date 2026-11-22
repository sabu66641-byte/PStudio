const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function createAudioRuntime(objects = [{ id: 'player', name: 'Player' }]) {
  const played = [];
  const stopped = [];
  const volumes = [];
  const active = new Set();
  const events = [];
  const window = {
    PStudioAudioService: {
      hasAsset: name => name === 'footstep' || name === 'music',
      hasSound: (owner, name) => active.has(String(owner) + ':' + String(name)),
      play(owner, name, volume, loop) {
        played.push({ owner, name, volume, loop });
        active.add(String(owner) + ':' + String(name));
        return true;
      },
      stop(owner, name) {
        stopped.push({ owner, name });
        return active.delete(String(owner) + ':' + String(name));
      },
      setVolume(owner, name, volume) {
        volumes.push({ owner, name, volume });
        return active.has(String(owner) + ':' + String(name));
      }
    },
    PStudioEvents: { emit(type, payload) { events.push({ type, payload }); } }
  };
  const sandbox = {
    window, console, Math, Number, Map, Set, WeakMap, Date,
    Object, Array, String, Boolean, TypeError, Error, Promise, JSON
  };
  vm.runInNewContext(read('static/pstudio_ecs.js'), sandbox, { filename: 'pstudio_ecs.js' });
  vm.runInNewContext(read('static/pstudio_ecs_audio.js'), sandbox, { filename: 'pstudio_ecs_audio.js' });
  const ecs = window.PStudioECS;
  const audio = window.PStudioECSAudio;
  ecs.syncSceneObjects(objects);
  return { ecs, audio, objects, played, stopped, volumes, active, events, window };
}

test('AudioEmitter is persistent authoring data while AudioCommand is transient runtime data', () => {
  const { ecs } = createAudioRuntime();
  const emitter = ecs.getComponentDefinition('AudioEmitter');
  const command = ecs.getComponentDefinition('AudioCommand');
  assert.equal(emitter.persistent, true);
  assert.equal(emitter.internal, false);
  assert.equal(command.persistent, false);
  assert.equal(command.internal, true);
});

test('Audio play requests dispatch through the Audio service during postUpdate', () => {
  const { ecs, audio, played } = createAudioRuntime();
  assert.equal(audio.play('player', 'footstep', 0.75, false), true);
  assert.equal(played.length, 0, 'AudioCommand is queued, not played inline');
  assert.equal(ecs.query(['AudioCommand']).length, 1);

  ecs.updatePhase('postUpdate', 1 / 60, {});
  assert.deepEqual(played, [{ owner: 'player', name: 'footstep', volume: 0.75, loop: false }]);
  assert.equal(ecs.query(['AudioCommand']).length, 0);
  assert.deepEqual(audio.getState().pendingCount, 0);
});

test('AudioEmitter settings scale volume and mute without taking ownership of Audio resources', () => {
  const { ecs, audio, played } = createAudioRuntime();
  assert.equal(audio.attachEmitter('player', { volume: 0.4, muted: false }), true);
  assert.deepEqual(audio.getEmitter('player'), { enabled: true, muted: false, volume: 0.4 });

  audio.play('player', 'footstep', 0.5, true);
  ecs.updatePhase('postUpdate', 1 / 60, {});
  assert.equal(played[0].volume, 0.2);
  assert.equal(played[0].loop, true);

  audio.attachEmitter('player', { volume: 0.8, muted: true });
  audio.play('player', 'music', 1, true);
  ecs.updatePhase('postUpdate', 1 / 60, {});
  assert.equal(played[1].volume, 0);
  assert.equal(audio.detachEmitter('player'), true);
  assert.equal(audio.getEmitter('player'), null);
});

test('stop and set-volume commands preserve ordering for a newly queued play', () => {
  const { ecs, audio, played, stopped, volumes } = createAudioRuntime();
  assert.equal(audio.play('player', 'music', 1, true), true);
  assert.equal(audio.setVolume('player', 'music', 0.3), true);
  assert.equal(audio.stop('player', 'music'), true);

  ecs.updatePhase('postUpdate', 1 / 60, {});
  assert.equal(played.length, 1);
  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].volume, 0.3);
  assert.deepEqual(stopped, [{ owner: 'player', name: 'music' }]);
  assert.equal(ecs.query(['AudioCommand']).length, 0);
  assert.equal(audio.stop('player', 'music'), false);
});

test('missing audio assets fail synchronously and clearing drops pending commands', () => {
  const { ecs, audio, played } = createAudioRuntime();
  assert.throws(() => audio.play('player', 'missing', 1, false), /音声アセットが見つかりません/);
  assert.equal(audio.play('player', 'footstep', 1, false), true);
  assert.equal(ecs.query(['AudioCommand']).length, 1);
  assert.equal(audio.clear(), true);
  assert.equal(ecs.query(['AudioCommand']).length, 0);
  ecs.updatePhase('postUpdate', 1 / 60, {});
  assert.equal(played.length, 0);
});

test('AudioEmitter attachment follows Scene Object identity and detaches safely', () => {
  const { ecs, audio } = createAudioRuntime();
  assert.equal(audio.attachEmitter('missing'), false);
  assert.equal(audio.attachEmitter('player'), true);
  const entity = ecs.getEntityForSceneObject('player');
  assert.ok(ecs.hasComponent(entity, 'AudioEmitter'));
  assert.equal(audio.detachEmitter('player'), true);
  assert.equal(ecs.hasComponent(entity, 'AudioEmitter'), false);
});
