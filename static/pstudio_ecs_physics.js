/* PStudio ECS / Physics bridge 1.0.0
 * ECS Components describe physics configuration; PStudioPhysics remains the fixed-step solver.
 * Runtime state is mirrored back after the physics step without changing legacy ps APIs.
 */
(() => {
  'use strict';

  const ecs = window.PStudioECS;
  if (!ecs || !window.PStudioPhysics) {
    console.warn('[PStudio ECS Physics] ECS or Physics core is unavailable.');
    return;
  }

  const bodyOwners = new Map();
  const bodyConfigPositions = new Map();
  const hasType = type => ecs.hasComponentType(type);

  if (!hasType('Velocity')) {
    ecs.registerComponent('Velocity', {
      label: 'Velocity',
      category: 'Motion',
      description: 'Per-second velocity applied to the ECS Transform by the built-in motion System.',
      additionalProperties: false,
      schema: {
        x: { type: 'number', default: 0, label: 'Velocity X' },
        y: { type: 'number', default: 0, label: 'Velocity Y' },
        z: { type: 'number', default: 0, label: 'Velocity Z' }
      }
    });
  }

  if (!hasType('PhysicsState')) {
    ecs.registerComponent('PhysicsState', {
      label: 'Physics State',
      category: 'Physics',
      description: 'Read-only state sampled from the fixed-step Physics solver.',
      persistent: false,
      readonly: true,
      internal: true,
      additionalProperties: false,
      schema: {
        x: { type: 'number', default: 0, label: 'World X' },
        y: { type: 'number', default: 0, label: 'World Y' },
        z: { type: 'number', default: 0, label: 'World Z' },
        velocityX: { type: 'number', default: 0, label: 'Velocity X' },
        velocityY: { type: 'number', default: 0, label: 'Velocity Y' },
        velocityZ: { type: 'number', default: 0, label: 'Velocity Z' },
        horizontalSpeed: { type: 'number', default: 0, label: 'Horizontal Speed' },
        grounded: { type: 'boolean', default: false, label: 'Grounded' },
        controlled: { type: 'boolean', default: false, label: 'Character Controller' },
        jumped: { type: 'boolean', default: false, label: 'Jumped' },
        landed: { type: 'boolean', default: false, label: 'Landed' },
        airTime: { type: 'number', default: 0, label: 'Air Time' },
        active: { type: 'boolean', default: true, label: 'Active' }
      }
    });
  }

  if (!hasType('PhysicsTransform')) {
    ecs.registerComponent('PhysicsTransform', {
      label: 'Physics Transform',
      category: 'Physics',
      description: 'World-space position produced by the Physics solver. It is intentionally separate from the editor Transform coordinate space.',
      persistent: false,
      readonly: true,
      internal: true,
      additionalProperties: false,
      schema: {
        x: { type: 'number', default: 0, label: 'World Position X' },
        y: { type: 'number', default: 0, label: 'World Position Y' },
        z: { type: 'number', default: 0, label: 'World Position Z' }
      }
    });
  }

  if (!hasType('PhysicsBody')) {
    ecs.registerComponent('PhysicsBody', {
      label: 'Physics Body',
      category: 'Physics',
      description: 'Capsule body configuration in Physics world units. World coordinates are independent of the 2D editor pixel coordinates.',
      additionalProperties: false,
      schema: {
        enabled: { type: 'boolean', default: true, label: 'Enabled' },
        positionX: { type: 'number', default: 0, label: 'World Position X' },
        positionY: { type: 'number', default: 0, label: 'World Position Y' },
        positionZ: { type: 'number', default: 0, label: 'World Position Z' },
        radius: { type: 'number', default: 0.35, min: 0.05, max: 100, step: 0.05, label: 'Radius' },
        height: { type: 'number', default: 1.8, min: 0.1, max: 200, step: 0.1, label: 'Height' },
        mass: { type: 'number', default: 1, min: 0.001, max: 100000, step: 0.1, label: 'Mass' },
        gravityX: { type: 'number', default: 0, label: 'Gravity X' },
        gravityY: { type: 'number', default: -9.81, label: 'Gravity Y' },
        gravityZ: { type: 'number', default: 0, label: 'Gravity Z' },
        controllerEnabled: { type: 'boolean', default: false, label: 'Character Controller' },
        maxSpeed: { type: 'number', default: 5, min: 0, max: 1000, step: 0.1, label: 'Max Speed' },
        acceleration: { type: 'number', default: 24, min: 0, max: 10000, step: 0.5, label: 'Acceleration' },
        airControl: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.05, label: 'Air Control' },
        stepHeight: { type: 'number', default: 0.35, min: 0, max: 2, step: 0.05, label: 'Step Height' },
        maxSlope: { type: 'number', default: 50, min: 0, max: 89, step: 1, label: 'Max Slope (degrees)' }
      },
      onAdd(entity, value, api) {
        const reference = api.hasComponent(entity, 'SceneObjectRef')
          ? api.getComponent(entity, 'SceneObjectRef')
          : null;
        bodyOwners.set(entity, reference ? String(reference.sceneObjectId) : 'ecs-' + entity);
        if (!api.hasComponent(entity, 'PhysicsState')) api.addComponent(entity, 'PhysicsState');
        if (!api.hasComponent(entity, 'PhysicsTransform')) api.addComponent(entity, 'PhysicsTransform');
      },
      onRemove(entity, value, api) {
        const ownerId = bodyOwners.get(entity);
        if (ownerId !== undefined) window.PStudioPhysics?.removeBody?.(ownerId);
        bodyOwners.delete(entity);
        bodyConfigPositions.delete(entity);
        if (api.hasComponent(entity, 'PhysicsState')) api.removeComponent(entity, 'PhysicsState');
        if (api.hasComponent(entity, 'PhysicsTransform')) api.removeComponent(entity, 'PhysicsTransform');
      }
    });
  }

  const existingSystems = new Set(ecs.getSystems().map(system => system.id));

  if (!existingSystems.has('engine.velocity-integrator')) {
    ecs.registerSystem({
      id: 'engine.velocity-integrator',
      name: 'Transform Velocity Integrator',
      description: 'Applies Velocity to Transform for non-physics entities.',
      components: ['Transform', 'Velocity'],
      priority: 0,
      phase: 'update',
      internal: true,
      update(dt, api) {
        api.forEach(['Transform', 'Velocity'], (entity, transform, velocity) => {
          if (api.hasComponent(entity, 'PhysicsBody')) return;
          transform.x += velocity.x * dt;
          transform.y += velocity.y * dt;
          transform.z += velocity.z * dt;
        });
      }
    });
  }

  if (!existingSystems.has('engine.physics.pre')) {
    ecs.registerSystem({
      id: 'engine.physics.pre',
      name: 'Physics Body Synchronization',
      description: 'Creates/configures Physics bodies from ECS PhysicsBody Components before the fixed-step simulation.',
      components: ['PhysicsBody'],
      priority: -1000,
      phase: 'prePhysics',
      internal: true,
      update(dt, api) {
        const physics = window.PStudioPhysics;
        if (!physics) return;
        api.forEach(['PhysicsBody'], (entity, config) => {
          const ownerId = bodyOwners.get(entity) || 'ecs-' + entity;
          bodyOwners.set(entity, ownerId);
          if (!config.enabled) {
            if (physics.getBody(ownerId)) physics.setActive(ownerId, false);
            const state = api.getComponent(entity, 'PhysicsState');
            if (state) state.active = false;
            return;
          }
          const existingBody = physics.getBody(ownerId);
          physics.createBody(
            ownerId,
            config.positionX, config.positionY, config.positionZ,
            config.radius, config.height, config.mass
          );
          const configuredPosition = {
            x: Number(config.positionX),
            y: Number(config.positionY),
            z: Number(config.positionZ)
          };
          const previousPosition = bodyConfigPositions.get(entity);
          if (existingBody && previousPosition) {
            // Do not overwrite the Solver's simulated motion every frame.
            // Only explicit ECS config edits teleport the body.
            for (const [axis, index] of [['x', 0], ['y', 1], ['z', 2]]) {
              if (!Object.is(previousPosition[axis], configuredPosition[axis])) {
                physics.setPosition(ownerId, index, configuredPosition[axis]);
              }
            }
          }
          // For an existing legacy body with no ECS position snapshot, preserve its
          // current Solver position and begin tracking edits from the current config.
          bodyConfigPositions.set(entity, configuredPosition);
          physics.setActive(ownerId, true);
          physics.setGravity(ownerId, config.gravityX, config.gravityY, config.gravityZ);
          physics.setController(ownerId, config.controllerEnabled ? {
            maxSpeed: config.maxSpeed,
            acceleration: config.acceleration,
            airControl: config.airControl
          } : null);
          physics.setStepHeight(ownerId, config.stepHeight);
          physics.setMaxSlope(ownerId, config.maxSlope);
        });
      }
    });
  }

  if (!existingSystems.has('engine.physics.post')) {
    ecs.registerSystem({
      id: 'engine.physics.post',
      name: 'Physics State Synchronization',
      description: 'Copies fixed-step Physics results into the read-only ECS PhysicsState Component.',
      components: ['PhysicsBody', 'PhysicsState', 'PhysicsTransform'],
      priority: 1000,
      phase: 'postPhysics',
      internal: true,
      update(dt, api) {
        const physics = window.PStudioPhysics;
        if (!physics) return;
        api.forEach(['PhysicsBody', 'PhysicsState', 'PhysicsTransform'], (entity, config, state, transform) => {
          const ownerId = bodyOwners.get(entity) || 'ecs-' + entity;
          const snapshot = physics.getBodyState(ownerId);
          if (!snapshot) {
            state.active = false;
            return;
          }
          Object.assign(state, snapshot);
          transform.x = snapshot.x;
          transform.y = snapshot.y;
          transform.z = snapshot.z;
        });
      }
    });
  }

  window.PStudioECSPhysics = {
    version: '1.0.0',
    componentTypes: ['Velocity', 'PhysicsBody', 'PhysicsState', 'PhysicsTransform']
  };
})();
