/* PStudio ECS Audio Bridge 1.0.0
 * ECS stores per-entity emitter settings and transient playback commands.
 * The existing browser Audio service remains the sole owner of HTMLAudio instances.
 */
(() => {
  'use strict';
  const ecs = window.PStudioECS;
  if (!ecs) {
    console.warn('[PStudio ECS Audio] ECS core is unavailable.');
    return;
  }

  const SOURCE = 'pstudio_ecs_audio';
  const TYPES = Object.freeze({ AudioEmitter: 'AudioEmitter', AudioCommand: 'AudioCommand' });
  const commandEntities = new Set();
  const pendingRequests = [];
  let sequence = 0;

  function clamp01(value, fallback = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
  }
  function ownerEntity(ownerId) {
    return ecs.getEntityForSceneObject?.(String(ownerId)) ?? null;
  }
  function emitterData(ownerId, create = false) {
    const entity = ownerEntity(ownerId);
    if (entity === null) return null;
    if (!ecs.hasComponent(entity, TYPES.AudioEmitter) && create) {
      ecs.addComponent(entity, TYPES.AudioEmitter);
    }
    return ecs.hasComponent(entity, TYPES.AudioEmitter)
      ? ecs.getComponent(entity, TYPES.AudioEmitter)
      : null;
  }
  function normalizeEmitter(value = {}) {
    return {
      enabled: value.enabled !== false,
      muted: value.muted === true,
      volume: clamp01(value.volume, 1)
    };
  }

  function registerComponents() {
    if (!ecs.hasComponentType(TYPES.AudioEmitter)) {
      ecs.registerComponent(TYPES.AudioEmitter, {
        source: SOURCE,
        label: 'Audio Emitter',
        description: 'Per-Scene Object audio output settings. HTMLAudio resources remain owned by the Audio service.',
        category: 'Audio',
        persistent: true,
        internal: false,
        additionalProperties: false,
        schema: {
          enabled: { type: 'boolean', default: true, label: 'Enabled' },
          muted: { type: 'boolean', default: false, label: 'Muted' },
          volume: { type: 'number', min: 0, max: 1, default: 1, label: 'Volume' }
        },
        create: () => ({ enabled: true, muted: false, volume: 1 })
      });
    } else if (ecs.getComponentDefinition(TYPES.AudioEmitter)?.source !== SOURCE) {
      throw new Error('ECS Component name conflict: ' + TYPES.AudioEmitter);
    }

    if (!ecs.hasComponentType(TYPES.AudioCommand)) {
      ecs.registerComponent(TYPES.AudioCommand, {
        source: SOURCE,
        label: 'Audio Command',
        description: 'Transient request consumed by the browser Audio service.',
        category: 'Audio',
        internal: true,
        persistent: false,
        additionalProperties: false,
        schema: {
          action: { type: 'string', default: 'play' },
          ownerId: { type: 'string', default: '' },
          assetName: { type: 'string', default: '' },
          volume: { type: 'number', min: 0, max: 1, default: 1 },
          loop: { type: 'boolean', default: false },
          sequence: { type: 'integer', min: 0, default: 0 }
        },
        create: () => ({ action: 'play', ownerId: '', assetName: '', volume: 1, loop: false, sequence: 0 })
      });
    } else if (ecs.getComponentDefinition(TYPES.AudioCommand)?.source !== SOURCE) {
      throw new Error('ECS Component name conflict: ' + TYPES.AudioCommand);
    }
  }

  function commandPayload(action, ownerId, assetName, volume, loop) {
    return {
      action,
      ownerId: String(ownerId),
      assetName: String(assetName ?? ''),
      volume: clamp01(volume, 1),
      loop: loop === true,
      sequence: ++sequence
    };
  }

  function enqueue(payload) {
    const request = { ...payload };
    pendingRequests.push(request);
    ecs.defer(() => {
      const index = pendingRequests.indexOf(request);
      if (index < 0) return;
      pendingRequests.splice(index, 1);
      const entity = ecs.createEntity();
      try {
        ecs.addComponent(entity, TYPES.AudioCommand, request);
        commandEntities.add(entity);
      } catch (error) {
        ecs.destroyEntity(entity);
        throw error;
      }
    });
    return true;
  }

  function hasPendingPlay(ownerId, name) {
    const owner = String(ownerId), asset = String(name);
    if (pendingRequests.some(command => command.action === 'play' && command.ownerId === owner && command.assetName === asset)) {
      return true;
    }
    let found = false;
    ecs.forEach([TYPES.AudioCommand], (entity, command) => {
      if (command.action === 'play' && command.ownerId === owner && command.assetName === asset) found = true;
    });
    return found;
  }

  function play(ownerId, name, volume = 1, loop = false) {
    const assetName = String(name);
    const service = window.PStudioAudioService;
    if (!service || typeof service.hasAsset !== 'function' || !service.hasAsset(assetName)) {
      throw new Error('音声アセットが見つかりません: ' + assetName);
    }
    const emitter = emitterData(ownerId, true);
    if (emitter && !emitter.enabled) return false;
    const emitterVolume = emitter ? clamp01(emitter.volume, 1) : 1;
    const muted = emitter?.muted === true;
    return enqueue(commandPayload('play', ownerId, assetName, muted ? 0 : clamp01(volume, 1) * emitterVolume, loop));
  }

  function stop(ownerId, name) {
    const assetName = String(name);
    const service = window.PStudioAudioService;
    const active = service?.hasSound?.(ownerId, assetName) === true;
    if (!active && !hasPendingPlay(ownerId, assetName)) return false;
    return enqueue(commandPayload('stop', ownerId, assetName, 1, false));
  }

  function setVolume(ownerId, name, volume) {
    const assetName = String(name);
    const service = window.PStudioAudioService;
    const active = service?.hasSound?.(ownerId, assetName) === true;
    if (!active && !hasPendingPlay(ownerId, assetName)) return false;
    const emitter = emitterData(ownerId, true);
    const effective = emitter?.muted ? 0 : clamp01(volume, 1) * (emitter ? clamp01(emitter.volume, 1) : 1);
    return enqueue(commandPayload('set-volume', ownerId, assetName, effective, false));
  }

  function attachEmitter(ownerId, options = {}) {
    const entity = ownerEntity(ownerId);
    if (entity === null) return false;
    const value = normalizeEmitter(options);
    if (ecs.hasComponent(entity, TYPES.AudioEmitter)) ecs.setComponent(entity, TYPES.AudioEmitter, value);
    else ecs.addComponent(entity, TYPES.AudioEmitter, value);
    return true;
  }

  function getEmitter(ownerId) {
    const data = emitterData(ownerId, false);
    return data ? Object.freeze({ enabled: data.enabled, muted: data.muted, volume: data.volume }) : null;
  }

  function detachEmitter(ownerId) {
    const entity = ownerEntity(ownerId);
    if (entity === null || !ecs.hasComponent(entity, TYPES.AudioEmitter)) return false;
    return ecs.removeComponent(entity, TYPES.AudioEmitter);
  }

  function dispatchCommands() {
    if (ecs.getSystems().some(system => system.id === 'audio.command-dispatch')) return;
    ecs.registerSystem({
      id: 'audio.command-dispatch',
      name: 'Audio Command Dispatcher',
      description: 'Consumes AudioCommand Components through the existing browser Audio service.',
      components: [TYPES.AudioCommand],
      phase: 'postUpdate',
      priority: 1000,
      internal: true,
      source: SOURCE,
      update(dt, api) {
        const service = window.PStudioAudioService;
        const completed = [];
        api.forEach([TYPES.AudioCommand], (entity, command) => {
          try {
            if (!service) throw new Error('PStudio Audio service is unavailable.');
            if (command.action === 'play') service.play(command.ownerId, command.assetName, command.volume, command.loop);
            else if (command.action === 'stop') service.stop(command.ownerId, command.assetName);
            else if (command.action === 'set-volume') service.setVolume(command.ownerId, command.assetName, command.volume);
            else throw new Error('Unknown Audio command: ' + command.action);
          } catch (error) {
            console.warn('[PStudio ECS Audio] command failed:', error);
            window.PStudioEvents?.emit?.('audio.error', {
              ownerId: command.ownerId, assetName: command.assetName,
              action: command.action, error: error?.message || String(error)
            });
          }
          completed.push(entity);
        });
        for (const entity of completed) {
          api.defer(() => {
            try { api.destroyEntity(entity); } catch (_) {}
            commandEntities.delete(entity);
          });
        }
      }
    });
  }

  function clear() {
    for (const entity of commandEntities) {
      try { ecs.destroyEntity(entity); } catch (_) {}
    }
    commandEntities.clear();
    pendingRequests.length = 0;
    return true;
  }

  function getState() {
    return Object.freeze({
      emitterCount: ecs.query([TYPES.AudioEmitter]).length,
      commandCount: ecs.query([TYPES.AudioCommand]).length,
      pendingCount: pendingRequests.length,
      sequence
    });
  }

  registerComponents();
  dispatchCommands();

  window.PStudioECSAudio = Object.freeze({
    version: '1.0.0',
    componentTypes: Object.values(TYPES),
    play, stop, setVolume,
    attachEmitter, getEmitter, detachEmitter,
    clear, getState
  });
})();
