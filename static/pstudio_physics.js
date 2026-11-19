/* PStudio Physics 1.0.0
 * Deterministic fixed-step capsule controller and basic static-world collision.
 * Coordinates are world units; +Y is up.
 */
(() => {
  'use strict';
  const FIXED_STEP = 1 / 60;
  const MAX_SUBSTEPS = 8;
  const SKIN = 0.001;
  const bodies = new Map();
  let accumulator = 0;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const approach = (current, target, amount) =>
    current < target ? Math.min(target, current + amount) : Math.max(target, current - amount);

  function requireBody(id) {
    const body = bodies.get(id);
    if (!body) throw new Error('physics_body() を先に呼び出してください。');
    return body;
  }

  function createBody(id, x, y, z, radius, height, mass) {
    const r = Math.max(0.05, finite(radius, 0.35));
    const h = Math.max(r * 2, finite(height, 1.8));
    const m = Math.max(0.001, finite(mass, 1));
    const old = bodies.get(id);
    if (old) {
      old.radius = r;
      old.height = h;
      old.mass = m;
      old.invMass = 1 / m;
      return old;
    }
    const body = {
      id,
      position: [finite(x), finite(y), finite(z)],
      velocity: [0, 0, 0],
      force: [0, 0, 0],
      gravity: [0, -9.81, 0],
      radius: r,
      height: h,
      mass: m,
      invMass: 1 / m,
      grounded: false,
      coyoteTime: 0,
      jumpBuffer: 0,
      jumpSpeed: 0,
      controller: null,
      input: [0, 0],
      friction: 8
    };
    bodies.set(id, body);
    return body;
  }

  function getBody(id) { return bodies.get(id) || null; }
  function getPosition(id) {
    const b = bodies.get(id);
    return b ? { x: b.position[0], y: b.position[1], z: b.position[2] } : null;
  }
  function setPosition(id, axis, value) {
    const b = requireBody(id);
    b.position[axis] = finite(value);
    return b.position[axis];
  }
  function getVelocity(id, axis) {
    const b = requireBody(id);
    return b.velocity[axis];
  }
  function setVelocity(id, axis, value) {
    const b = requireBody(id);
    b.velocity[axis] = finite(value);
    return b.velocity[axis];
  }
  function setGravity(id, x, y, z) {
    const b = requireBody(id);
    b.gravity = [finite(x), finite(y), finite(z)];
  }
  function beginFrame() {
    for (const body of bodies.values()) body.force = [0, 0, 0];
  }

  function applyForce(id, x, y, z) {
    const b = requireBody(id);
    b.force[0] += finite(x);
    b.force[1] += finite(y);
    b.force[2] += finite(z);
  }
  function applyImpulse(id, x, y, z) {
    const b = requireBody(id);
    b.velocity[0] += finite(x) * b.invMass;
    b.velocity[1] += finite(y) * b.invMass;
    b.velocity[2] += finite(z) * b.invMass;
  }
  function configureController(id, maxSpeed, acceleration, airControl) {
    const b = requireBody(id);
    b.controller = {
      maxSpeed: Math.max(0, finite(maxSpeed, 5)),
      acceleration: Math.max(0, finite(acceleration, 24)),
      airControl: clamp(finite(airControl, 0.25), 0, 1)
    };
  }
  function moveCharacter(id, x, z) {
    const b = requireBody(id);
    if (!b.controller) throw new Error('character_controller() を先に呼び出してください。');
    let ix = finite(x), iz = finite(z);
    const length = Math.hypot(ix, iz);
    if (length > 1) { ix /= length; iz /= length; }
    b.input[0] = ix;
    b.input[1] = iz;
  }
  function jump(id, speed) {
    const b = requireBody(id);
    const power = Math.max(0, finite(speed, 7));
    if (power <= 0) return false;
    b.jumpSpeed = power;
    b.jumpBuffer = 0.12;
    return true;
  }
  function isGrounded(id) {
    const b = bodies.get(id);
    return !!(b && b.grounded);
  }

  function getStaticColliders(commandsByObject) {
    const colliders = [];
    for (const [ownerId, draws] of commandsByObject) {
      if (bodies.has(ownerId)) continue;
      for (const d of draws) {
        const x = finite(d.x), y = finite(d.y), z = finite(d.z);
        if (d.type === 'plane') {
          colliders.push({
            type: 'plane', x, y, z,
            halfX: Math.max(0.001, finite(d.width)) / 2,
            halfZ: Math.max(0.001, finite(d.depth)) / 2
          });
          continue;
        }
        let hx, hy, hz;
        if (d.type === 'cube' || d.type === 'box') {
          const a = d.type === 'cube' ? Math.max(0.001, finite(d.size)) / 2 : Math.max(0.001, finite(d.width)) / 2;
          const b = d.type === 'cube' ? a : Math.max(0.001, finite(d.height)) / 2;
          const c = d.type === 'cube' ? a : Math.max(0.001, finite(d.depth)) / 2;
          const rx=finite(d.rotationX),ry=finite(d.rotationY),rz=finite(d.rotationZ);
          const c1=Math.cos(rx),s1=Math.sin(rx),c2=Math.cos(ry),s2=Math.sin(ry),c3=Math.cos(rz),s3=Math.sin(rz);
          hx=Math.abs(c2*c3)*a+Math.abs(c2*s3)*b+Math.abs(s2)*c;
          hy=Math.abs(s1*s2*c3+c1*s3)*a+Math.abs(s1*s2*s3-c1*c3)*b+Math.abs(s1*c2)*c;
          hz=Math.abs(c1*s2*c3-s1*s3)*a+Math.abs(c1*s2*s3+s1*c3)*b+Math.abs(c1*c2)*c;
        } else if (d.type === 'cylinder' || d.type === 'cone' || d.type === 'capsule') {
          hx = hz = Math.max(0.001, finite(d.radius));
          hy = Math.max(0.001, finite(d.height)) / 2;
        } else continue;
        colliders.push({
          type: 'box',
          minX: x - hx, maxX: x + hx,
          minY: y - hy, maxY: y + hy,
          minZ: z - hz, maxZ: z + hz
        });
      }
    }
    return colliders;
  }

  function solvePlane(body, plane, oldPosition) {
    const p = body.position;
    const halfHeight = body.height / 2;
    const bottom = p[1] - halfHeight;
    const oldBottom = oldPosition[1] - halfHeight;
    const withinX = p[0] + body.radius >= plane.x - plane.halfX &&
                    p[0] - body.radius <= plane.x + plane.halfX;
    const withinZ = p[2] + body.radius >= plane.z - plane.halfZ &&
                    p[2] - body.radius <= plane.z + plane.halfZ;
    if (!withinX || !withinZ || body.velocity[1] > 0) return false;
    const crossed = oldBottom >= plane.y - SKIN && bottom <= plane.y + SKIN;
    const resting = body.grounded && Math.abs(bottom - plane.y) <= SKIN * 3;
    const spawnedBelow = bottom < plane.y && oldBottom < plane.y && p[1] >= plane.y;
    if (!crossed && !resting && !spawnedBelow) return false;
    p[1] = plane.y + halfHeight;
    if (body.velocity[1] < 0) body.velocity[1] = 0;
    body.grounded = true;
    return true;
  }

  function solveBox(body, box) {
    const p = body.position;
    const segLow = p[1] - (body.height / 2 - body.radius);
    const segHigh = p[1] + (body.height / 2 - body.radius);
    let segY;
    const overlapLow = Math.max(segLow, box.minY);
    const overlapHigh = Math.min(segHigh, box.maxY);
    if (overlapLow <= overlapHigh) segY = clamp(p[1], overlapLow, overlapHigh);
    else segY = segHigh < box.minY ? segHigh : segLow;

    const qx = clamp(p[0], box.minX, box.maxX);
    const qy = clamp(segY, box.minY, box.maxY);
    const qz = clamp(p[2], box.minZ, box.maxZ);
    let nx = p[0] - qx, ny = segY - qy, nz = p[2] - qz;
    const distance = Math.hypot(nx, ny, nz);
    if (distance >= body.radius) return false;

    if (distance > 1e-7) {
      nx /= distance; ny /= distance; nz /= distance;
    } else {
      const choices = [
        { d: Math.abs(segHigh - box.minY), x: 0, y: 1, z: 0 },
        { d: Math.abs(box.maxY - segLow), x: 0, y: -1, z: 0 },
        { d: Math.abs(p[0] - box.minX), x: -1, y: 0, z: 0 },
        { d: Math.abs(box.maxX - p[0]), x: 1, y: 0, z: 0 },
        { d: Math.abs(p[2] - box.minZ), x: 0, y: 0, z: -1 },
        { d: Math.abs(box.maxZ - p[2]), x: 0, y: 0, z: 1 }
      ].sort((a, b) => a.d - b.d);
      nx = choices[0].x; ny = choices[0].y; nz = choices[0].z;
    }

    const penetration = body.radius - distance + SKIN;
    p[0] += nx * penetration;
    p[1] += ny * penetration;
    p[2] += nz * penetration;
    const intoSurface = body.velocity[0] * nx + body.velocity[1] * ny + body.velocity[2] * nz;
    if (intoSurface < 0) {
      body.velocity[0] -= nx * intoSurface;
      body.velocity[1] -= ny * intoSurface;
      body.velocity[2] -= nz * intoSurface;
    }
    if (ny > 0.55 && body.velocity[1] <= 0.05) {
      body.velocity[1] = 0;
      body.grounded = true;
    }
    return true;
  }

  function solveWorld(body, colliders, oldPosition) {
    body.grounded = false;
    for (let iteration = 0; iteration < 4; iteration++) {
      let touched = false;
      for (const collider of colliders) {
        if (collider.type === 'plane') {
          if (solvePlane(body, collider, oldPosition)) touched = true;
        } else if (solveBox(body, collider)) touched = true;
      }
      if (!touched) break;
    }
  }

  function applyBufferedJump(body) {
    if (body.jumpBuffer <= 0 || !(body.grounded || body.coyoteTime > 0)) return;
    body.velocity[1] = body.jumpSpeed;
    body.grounded = false;
    body.coyoteTime = 0;
    body.jumpBuffer = 0;
  }

  function simulateBody(body, dt, colliders) {
    const wasGrounded = body.grounded;
    if (wasGrounded) body.coyoteTime = 0.12;
    else body.coyoteTime = Math.max(0, body.coyoteTime - dt);
    body.jumpBuffer = Math.max(0, body.jumpBuffer - dt);
    applyBufferedJump(body);

    const controller = body.controller;
    if (controller) {
      const control = body.grounded ? 1 : controller.airControl;
      const maxChange = controller.acceleration * control * dt;
      const targetX = body.input[0] * controller.maxSpeed;
      const targetZ = body.input[1] * controller.maxSpeed;
      body.velocity[0] = approach(body.velocity[0], targetX, maxChange);
      body.velocity[2] = approach(body.velocity[2], targetZ, maxChange);
    }

    const oldPosition = body.position.slice();
    for (let axis = 0; axis < 3; axis++) {
      body.velocity[axis] += (body.gravity[axis] + body.force[axis] * body.invMass) * dt;
      body.position[axis] += body.velocity[axis] * dt;
    }

    solveWorld(body, colliders, oldPosition);
    if (body.grounded) {
      body.coyoteTime = 0.12;
      if (!controller) {
        const friction = Math.exp(-body.friction * dt);
        body.velocity[0] *= friction;
        body.velocity[2] *= friction;
      }
      applyBufferedJump(body);
    }
  }

  function step(frameDt, commandsByObject) {
    const before = new Map();
    for (const [id, body] of bodies) before.set(id, body.position.slice());
    const colliders = getStaticColliders(commandsByObject || new Map());
    accumulator = Math.min(accumulator + clamp(finite(frameDt), 0, 0.1), FIXED_STEP * MAX_SUBSTEPS);
    let steps = 0;
    while (accumulator + 1e-9 >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      for (const body of bodies.values()) simulateBody(body, FIXED_STEP, colliders);
      accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps > 0) {
      for (const body of bodies.values()) body.force = [0, 0, 0];
    }
    const result = new Map();
    for (const [id, body] of bodies) {
      const old = before.get(id) || body.position;
      result.set(id, {
        x: body.position[0], y: body.position[1], z: body.position[2],
        dx: body.position[0] - old[0],
        dy: body.position[1] - old[1],
        dz: body.position[2] - old[2],
        grounded: body.grounded
      });
    }
    return result;
  }

  function clear() {
    bodies.clear();
    accumulator = 0;
  }

  window.PStudioPhysics = {
    createBody, getBody, getPosition, setPosition, getVelocity, setVelocity,
    setGravity, beginFrame, applyForce, applyImpulse, configureController,
    moveCharacter, jump, isGrounded, step, clear,
    version: '1.0.0'
  };
})();