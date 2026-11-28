const EPSILON = 1e-8;
const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(label + " must be finite.");
  return number;
};
function vec3(value, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 3) throw new TypeError(label + " must be vec3.");
  return Array.from(value, (item, index) => finite(item, label + "[" + index + "]"));
}
function matrix4(value, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 16) throw new TypeError(label + " must be mat4.");
  return Array.from(value, (item, index) => finite(item, label + "[" + index + "]"));
}
function normalize3(v) {
  const length = Math.hypot(...v);
  if (!(length > EPSILON)) throw new RangeError("Ray direction must be non-zero.");
  return v.map(value => value / length);
}
const min3 = (a, b) => a.map((value, i) => Math.min(value, b[i]));
const max3 = (a, b) => a.map((value, i) => Math.max(value, b[i]));
function boundsForTriangle(positions, indices, triangle) {
  const a = indices ? indices[triangle * 3] : triangle * 3;
  const b = indices ? indices[triangle * 3 + 1] : triangle * 3 + 1;
  const c = indices ? indices[triangle * 3 + 2] : triangle * 3 + 2;
  const points = [a, b, c].map(index => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]]);
  return { min: min3(min3(points[0], points[1]), points[2]), max: max3(max3(points[0], points[1]), points[2]), centroid: points[0].map((v, i) => (v + points[1][i] + points[2][i]) / 3) };
}
function mergeBounds(items) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const item of items) { min = min3(min, item.bounds.min); max = max3(max, item.bounds.max); }
  return { min, max };
}
function buildNode(items, depth, maxLeafTriangles) {
  const bounds = mergeBounds(items);
  if (items.length <= maxLeafTriangles || depth >= 48) {
    return Object.freeze({ min: Object.freeze(bounds.min), max: Object.freeze(bounds.max), triangles: Object.freeze(items.map(item => item.triangle)), left: null, right: null });
  }
  const extent = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const axis = extent.indexOf(Math.max(...extent));
  const sorted = items.slice().sort((a, b) => a.bounds.centroid[axis] - b.bounds.centroid[axis] || a.triangle - b.triangle);
  const middle = Math.floor(sorted.length / 2);
  if (middle <= 0 || middle >= sorted.length) {
    return Object.freeze({ min: Object.freeze(bounds.min), max: Object.freeze(bounds.max), triangles: Object.freeze(items.map(item => item.triangle)), left: null, right: null });
  }
  return Object.freeze({
    min: Object.freeze(bounds.min), max: Object.freeze(bounds.max), triangles: null,
    left: buildNode(sorted.slice(0, middle), depth + 1, maxLeafTriangles),
    right: buildNode(sorted.slice(middle), depth + 1, maxLeafTriangles)
  });
}
function rayBounds(origin, direction, min, max, maxDistance) {
  let near = 0, far = maxDistance;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(direction[axis]) < EPSILON) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return false;
      continue;
    }
    const inverse = 1 / direction[axis];
    let a = (min[axis] - origin[axis]) * inverse;
    let b = (max[axis] - origin[axis]) * inverse;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b);
    if (far < near) return false;
  }
  return far >= 0;
}
function intersectTriangle(origin, direction, positions, indices, triangle, cullBackfaces) {
  const ia = indices ? indices[triangle * 3] : triangle * 3;
  const ib = indices ? indices[triangle * 3 + 1] : triangle * 3 + 1;
  const ic = indices ? indices[triangle * 3 + 2] : triangle * 3 + 2;
  const a = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]];
  const b = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]];
  const c = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]];
  const e1 = b.map((v, i) => v - a[i]), e2 = c.map((v, i) => v - a[i]);
  const p = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]];
  const determinant = e1.reduce((sum, value, i) => sum + value * p[i], 0);
  if (cullBackfaces ? determinant < EPSILON : Math.abs(determinant) < EPSILON) return null;
  const inverse = 1 / determinant;
  const tvec = origin.map((value, i) => value - a[i]);
  const u = tvec.reduce((sum, value, i) => sum + value * p[i], 0) * inverse;
  if (u < 0 || u > 1) return null;
  const q = [tvec[1] * e1[2] - tvec[2] * e1[1], tvec[2] * e1[0] - tvec[0] * e1[2], tvec[0] * e1[1] - tvec[1] * e1[0]];
  const v = direction.reduce((sum, value, i) => sum + value * q[i], 0) * inverse;
  if (v < 0 || u + v > 1) return null;
  const distance = e2.reduce((sum, value, i) => sum + value * q[i], 0) * inverse;
  if (distance < 0) return null;
  const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const length = Math.hypot(...cross) || 1;
  return { distance, barycentric: [1 - u - v, u, v], normal: cross.map(value => value / length) };
}
function inverseMatrix4(m) {
  const a = Array.from({ length: 4 }, (_, r) => Array.from({ length: 8 }, (_, c) => c < 4 ? m[c * 4 + r] : (c - 4 === r ? 1 : 0)));
  for (let c = 0; c < 4; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < 4; r += 1) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < EPSILON) throw new RangeError("Cannot raycast an entity with a singular world transform.");
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const divisor = a[c][c];
    for (let k = 0; k < 8; k += 1) a[c][k] /= divisor;
    for (let r = 0; r < 4; r += 1) {
      if (r === c) continue;
      const factor = a[r][c];
      for (let k = 0; k < 8; k += 1) a[r][k] -= factor * a[c][k];
    }
  }
  const out = new Array(16);
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) out[c * 4 + r] = a[r][c + 4];
  return out;
}
function transformPoint(m, p, w = 1) {
  const v = [p[0], p[1], p[2], w];
  const result = [0, 1, 2].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
  const divisor = w === 1 ? (m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]) : 1;
  return result.map(value => value / (Math.abs(divisor) < EPSILON ? 1 : divisor));
}
function transformDirection(m, d) {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

export function createPStudioTriangleBVH(geometry, options = {}) {
  const positions = geometry?.positions;
  if ((!Array.isArray(positions) && !ArrayBuffer.isView(positions)) || !positions.length || positions.length % 3) throw new TypeError("BVH geometry requires vec3 positions.");
  const values = Array.from(positions, (value, index) => finite(value, "position " + index));
  const indices = geometry.indices == null ? null : Array.from(geometry.indices, Number);
  const elementCount = indices ? indices.length : values.length / 3;
  if (elementCount % 3 !== 0) throw new RangeError("BVH geometry must contain complete triangles.");
  if (indices && indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= values.length / 3)) throw new RangeError("BVH index is outside the vertex range.");
  const triangleCount = elementCount / 3;
  const maxLeafTriangles = Math.max(1, Math.min(64, Math.floor(Number(options.maxLeafTriangles) || 8)));
  const items = Array.from({ length: triangleCount }, (_, triangle) => ({ triangle, bounds: boundsForTriangle(values, indices, triangle) }));
  const root = triangleCount ? buildNode(items, 0, maxLeafTriangles) : null;
  function raycast(ray = {}, config = {}) {
    if (!root) return null;
    const origin = vec3(ray.origin, "ray origin"), direction = normalize3(vec3(ray.direction, "ray direction"));
    const maxDistance = config.maxDistance == null ? Infinity : finite(config.maxDistance, "maxDistance");
    if (maxDistance < 0) throw new RangeError("maxDistance must be non-negative.");
    let best = null;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!rayBounds(origin, direction, node.min, node.max, best?.distance ?? maxDistance)) continue;
      if (node.triangles) {
        for (const triangle of node.triangles) {
          const hit = intersectTriangle(origin, direction, values, indices, triangle, config.backfaceCulling === true);
          if (hit && hit.distance <= maxDistance && hit.distance < (best?.distance ?? Infinity)) best = { ...hit, triangleIndex: triangle };
        }
      } else {
        if (node.left) stack.push(node.left);
        if (node.right) stack.push(node.right);
      }
    }
    if (!best) return null;
    const position = origin.map((value, i) => value + direction[i] * best.distance);
    return Object.freeze({ ...best, position: Object.freeze(position), normal: Object.freeze(best.normal), barycentric: Object.freeze(best.barycentric) });
  }
  return Object.freeze({ kind: "pstudio-triangle-bvh", triangleCount, maxLeafTriangles, bounds: root ? Object.freeze({ min: root.min, max: root.max }) : null, raycast });
}

export function createPStudioBVHCollisionAdapter(sceneAsset, options = {}) {
  if (sceneAsset?.kind !== "pstudio-graphics-scene-asset") throw new TypeError("A PStudio scene asset is required.");
  const geometries = new Map(sceneAsset.geometries.map(item => [item.id, item]));
  const entities = sceneAsset.entities.filter(item => item.visible);
  const cache = new Map();
  function getTree(geometryId) {
    const geometry = geometries.get(geometryId);
    if (!geometry) throw new Error("Collision entity references missing geometry: " + geometryId);
    const key = geometryId + ":" + geometry.revision;
    if (!cache.has(key)) cache.set(key, createPStudioTriangleBVH(geometry, options));
    return cache.get(key);
  }
  function raycast(ray, config = {}) {
    const origin = vec3(ray.origin, "ray origin"), direction = normalize3(vec3(ray.direction, "ray direction"));
    let best = null;
    for (const entity of entities) {
      const world = matrix4(entity.matrixWorld, "entity world matrix");
      const inverse = inverseMatrix4(world);
      const localOrigin = transformPoint(inverse, origin);
      const localDirection = transformDirection(inverse, direction);
      const hit = getTree(entity.geometryId).raycast({ origin: localOrigin, direction: localDirection }, { maxDistance: best?.distance ?? config.maxDistance, backfaceCulling: config.backfaceCulling });
      if (!hit || hit.distance >= (best?.distance ?? Infinity)) continue;
      const worldPosition = transformPoint(world, hit.position);
      const localNormal = hit.normal;
      const normalMatrix = inverse;
      const worldNormal = normalize3([
        normalMatrix[0] * localNormal[0] + normalMatrix[1] * localNormal[1] + normalMatrix[2] * localNormal[2],
        normalMatrix[4] * localNormal[0] + normalMatrix[5] * localNormal[1] + normalMatrix[6] * localNormal[2],
        normalMatrix[8] * localNormal[0] + normalMatrix[9] * localNormal[1] + normalMatrix[10] * localNormal[2]
      ]);
      best = Object.freeze({ entityId: entity.id, geometryId: entity.geometryId, triangleIndex: hit.triangleIndex, distance: hit.distance, position: Object.freeze(worldPosition), normal: Object.freeze(worldNormal), barycentric: hit.barycentric });
    }
    return best;
  }
  return Object.freeze({ kind: "pstudio-bvh-collision-adapter", raycast, stats: () => Object.freeze({ cachedGeometryCount: cache.size, entityCount: entities.length }) });
}
