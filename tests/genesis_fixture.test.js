const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const fixture = path.join(root, 'examples', 'GENESIS_TORII_MIRROR_V1');
const read = name => fs.readFileSync(path.join(fixture, name), 'utf8');

test('GENESIS_TORII_MIRROR_V1 starter fixture contains fixed scene components and capture protocol', () => {
  const manifest = read('README.md');
  for (const name of ['camera.ps', 'ground.ps', 'torii.ps', 'water.ps', 'foliage.ps', 'particles.ps']) {
    assert.ok(fs.existsSync(path.join(fixture, name)), name + ' exists');
    assert.ok(manifest.includes(name), name + ' is documented');
  }
  assert.match(manifest, /960×540/);
  assert.match(manifest, /20 seconds/);
  assert.match(manifest, /p50\/p95\/p99/);
  assert.match(manifest, /known omissions/i);
});

test('GENESIS fixture scripts use supported PStudio draw APIs and fixed world-space values', () => {
  const camera = read('camera.ps');
  const ground = read('ground.ps');
  const torii = read('torii.ps');
  const water = read('water.ps');
  const foliage = read('foliage.ps');
  const particles = read('particles.ps');

  assert.match(camera, /set_camera\(0, 13, 42, 0, 4, -18\)/);
  assert.match(ground, /draw_terrain\(0, -1\.0, -50, 220, 110, 64, 0\.8\)/);
  assert.equal((torii.match(/draw_box\(/g) || []).length, 6);
  assert.match(water, /draw_mirror_water\(0, -0\.78, 8, 180, 72, 1\.0, 0\.035\)/);
  assert.equal((foliage.match(/draw_sphere\(/g) || []).length, 6);
  assert.match(particles, /func start\(\)/);
  assert.match(particles, /emit_particles\(0, 2\.2, -15, 48/);
});
