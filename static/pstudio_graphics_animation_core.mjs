const PATHS = new Set(["translation", "rotation", "scale", "weights"]);
const INTERPOLATIONS = new Set(["LINEAR", "STEP", "CUBICSPLINE"]);
const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(label + " must be finite.");
  return number;
};
const vec = (value, length, label) => {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== length) {
    throw new TypeError(label + " must contain exactly " + length + " finite values.");
  }
  return Array.from(value, (item, index) => finite(item, label + "[" + index + "]"));
};
const normalize = value => {
  const length = Math.hypot(...value);
  return length > 1e-10 ? value.map(item => item / length) : [0, 0, 0, 1];
};
function slerp(a, b, t) {
  let right = b.slice();
  let cosine = a.reduce((sum, value, index) => sum + value * right[index], 0);
  if (cosine < 0) { right = right.map(value => -value); cosine = -cosine; }
  if (cosine > 0.9995) return normalize(a.map((value, index) => value + (right[index] - value) * t));
  const theta = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const sine = Math.sin(theta);
  const leftWeight = Math.sin((1 - t) * theta) / sine;
  const rightWeight = Math.sin(t * theta) / sine;
  return normalize(a.map((value, index) => value * leftWeight + right[index] * rightWeight));
}
function sampleTrack(track, time) {
  const times = track.times, values = track.values, width = track.components;
  if (time <= times[0]) return values.slice(0, width);
  const last = times.length - 1;
  if (time >= times[last]) return values.slice(last * width, (last + 1) * width);
  let right = 1;
  while (right < times.length && times[right] < time) right += 1;
  const left = right - 1;
  const a = values.slice(left * width, (left + 1) * width);
  const b = values.slice(right * width, (right + 1) * width);
  const deltaTime = times[right] - times[left];
  const t = (time - times[left]) / deltaTime;
  if (track.interpolation === "STEP") return a;
  if (track.interpolation === "CUBICSPLINE") {
    const outgoing = track.outTangents.slice(left * width, (left + 1) * width);
    const incoming = track.inTangents.slice(right * width, (right + 1) * width);
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const value = a.map((component, index) =>
      h00 * component +
      h10 * deltaTime * outgoing[index] +
      h01 * b[index] +
      h11 * deltaTime * incoming[index]
    );
    return track.path === "rotation" ? normalize(value) : value;
  }
  if (track.path === "rotation") return slerp(a, b, t);
  return a.map((value, index) => value + (b[index] - value) * t);
}

export function createPStudioAnimationClip(input = {}) {
  const id = String(input.id || "").trim();
  if (!id) throw new TypeError("Animation clip id is required.");
  const tracks = (input.tracks || []).map((source, index) => {
    const targetId = String(source.targetId || "").trim();
    const path = String(source.path || "");
    if (!targetId || !PATHS.has(path)) throw new TypeError("Animation track " + index + " requires targetId and a supported path.");
    const components = path === "rotation" ? 4 : path === "weights" ? Number(source.components) : 3;
    if (!Number.isSafeInteger(components) || components < 1 || components > 64) throw new RangeError("Animation track component count is invalid.");
    const times = Array.from(source.times || [], (value, i) => finite(value, "track time " + i));
    if (!times.length || times.some((value, i) => value < 0 || (i > 0 && value <= times[i - 1]))) throw new RangeError("Animation track times must be non-negative and strictly increasing.");
    const values = Array.from(source.values || [], (value, i) => finite(value, "track value " + i));
    if (values.length !== times.length * components) throw new RangeError("Animation track value count does not match its keyframes.");
    const interpolation = String(source.interpolation || "LINEAR").toUpperCase();
    if (!INTERPOLATIONS.has(interpolation)) throw new TypeError("Unsupported animation interpolation: " + interpolation);
    const inTangents = interpolation === "CUBICSPLINE"
      ? Array.from(source.inTangents || [], (value, i) => finite(value, "track in tangent " + i))
      : null;
    const outTangents = interpolation === "CUBICSPLINE"
      ? Array.from(source.outTangents || [], (value, i) => finite(value, "track out tangent " + i))
      : null;
    if (interpolation === "CUBICSPLINE" &&
        (inTangents.length !== values.length || outTangents.length !== values.length)) {
      throw new RangeError("CUBICSPLINE animation requires one in- and out-tangent vector per keyframe.");
    }
    if (path === "rotation") {
      for (let i = 0; i < times.length; i += 1) {
        const q = values.slice(i * 4, i * 4 + 4);
        if (Math.hypot(...q) < 1e-10) throw new RangeError("Animation quaternion keys must have non-zero length.");
        const normalized = normalize(q);
        values.splice(i * 4, 4, ...normalized);
      }
    }
    return Object.freeze({
      targetId, path, components, times: Object.freeze(times), values: Object.freeze(values),
      inTangents: inTangents ? Object.freeze(inTangents) : null,
      outTangents: outTangents ? Object.freeze(outTangents) : null,
      interpolation
    });
  });
  const duration = Math.max(finite(input.duration ?? 0, "clip duration"), ...tracks.flatMap(track => [track.times[track.times.length - 1]]), 0);
  if (duration < 0) throw new RangeError("Animation duration must be non-negative.");
  return Object.freeze({ kind: "pstudio-animation-clip", id, duration, tracks: Object.freeze(tracks), metadata: Object.freeze({ ...(input.metadata || {}) }) });
}

export function samplePStudioAnimationClip(clip, timeSeconds, options = {}) {
  if (clip?.kind !== "pstudio-animation-clip") throw new TypeError("A PStudio animation clip is required.");
  const requestedTime = Math.max(0, finite(timeSeconds, "animation time"));
  const loop = options.loop === true && clip.duration > 0;
  const sampleTime = loop ? requestedTime % clip.duration : Math.min(clip.duration, requestedTime);
  return Object.freeze({
    clipId: clip.id, time: sampleTime,
    tracks: Object.freeze(clip.tracks.map(track => Object.freeze({
      targetId: track.targetId, path: track.path, value: Object.freeze(sampleTrack(track, sampleTime))
    })))
  });
}

export function applyPStudioAnimationFrame(sceneCore, frame) {
  if (!sceneCore || typeof sceneCore.getEntity !== "function" || typeof sceneCore.updateEntity !== "function") throw new TypeError("A PStudio Scene Core is required.");
  if (!frame || !Array.isArray(frame.tracks)) throw new TypeError("A sampled PStudio animation frame is required.");
  const grouped = new Map();
  for (const track of frame.tracks) {
    let patch = grouped.get(track.targetId);
    if (!patch) { patch = { transform: {}, components: null }; grouped.set(track.targetId, patch); }
    if (track.path === "weights") {
      const current = sceneCore.getEntity(track.targetId);
      patch.components = { ...(current?.components || {}), animationWeights: track.value.slice() };
    } else patch.transform[track.path === "translation" ? "position" : track.path] = track.value.slice();
  }
  let updated = 0;
  for (const [targetId, patch] of grouped) {
    const current = sceneCore.getEntity(targetId);
    if (!current) continue;
    const transform = Object.keys(patch.transform).length
      ? { position: patch.transform.position || current.transform.position, rotation: patch.transform.rotation || current.transform.rotation, scale: patch.transform.scale || current.transform.scale }
      : undefined;
    sceneCore.updateEntity(targetId, { ...(transform ? { transform } : {}), ...(patch.components ? { components: patch.components } : {}) });
    updated += 1;
  }
  return updated;
}

export function createPStudioSkinDescriptor(input = {}) {
  const id = String(input.id || "").trim();
  if (!id) throw new TypeError("Skin id is required.");
  const joints = (input.joints || []).map(String);
  if (!joints.length || joints.length > 256 || new Set(joints).size !== joints.length || joints.some(value => !value.trim())) throw new RangeError("A PStudio skin requires 1–256 unique joint ids.");
  const inverseBindMatrices = Array.from(input.inverseBindMatrices || [], (matrix, index) => vec(matrix, 16, "inverse bind matrix " + index));
  if (inverseBindMatrices.length !== joints.length) throw new RangeError("Skin inverse bind matrix count must match the joint count.");
  const skeletonRoot = input.skeletonRoot == null ? null : String(input.skeletonRoot).trim();
  if (input.skeletonRoot != null && !skeletonRoot) throw new TypeError("Skin skeletonRoot must be a non-empty node id.");
  return Object.freeze({
    kind: "pstudio-skin", id, joints: Object.freeze(joints),
    inverseBindMatrices: Object.freeze(inverseBindMatrices.map(Object.freeze)), skeletonRoot
  });
}
function multiplyPoint(matrix, point, w) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12] * w,
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13] * w,
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14] * w
  ];
}
function normalize3(value) {
  const length = Math.hypot(...value);
  return length > 1e-10 ? value.map(item => item / length) : [0, 1, 0];
}
export function deformPStudioSkinnedGeometry(input = {}) {
  const positions = vec(input.positions, input.positions?.length, "positions");
  if (positions.length % 3) throw new RangeError("Positions must contain vec3 values.");
  const vertexCount = positions.length / 3;
  const normals = input.normals == null ? new Array(positions.length).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0) : vec(input.normals, positions.length, "normals");
  const joints = input.jointIndices, weights = input.jointWeights;
  if (!joints || !weights || joints.length !== vertexCount * 4 || weights.length !== vertexCount * 4) throw new RangeError("Skinning requires four joint indices and weights per vertex.");
  const matrices = input.jointMatrices || [];
  if (!matrices.length || matrices.length > 256) throw new RangeError("Joint matrix palette must contain 1–256 matrices.");
  const palette = matrices.map((m, i) => vec(m, 16, "joint matrix " + i));
  const morphTargets = input.morphTargets || [];
  const morphWeights = input.morphWeights || [];
  if (morphTargets.length !== morphWeights.length) throw new RangeError("Morph target and weight counts must match.");
  const morphedPositions = positions.slice(), morphedNormals = normals.slice();
  for (let targetIndex = 0; targetIndex < morphTargets.length; targetIndex += 1) {
    const weight = finite(morphWeights[targetIndex], "morph weight");
    if (weight === 0) continue;
    const target = morphTargets[targetIndex];
    const dp = target.positions ? vec(target.positions, positions.length, "morph positions") : null;
    const dn = target.normals ? vec(target.normals, normals.length, "morph normals") : null;
    if (dp) for (let i = 0; i < dp.length; i += 1) morphedPositions[i] += dp[i] * weight;
    if (dn) for (let i = 0; i < dn.length; i += 1) morphedNormals[i] += dn[i] * weight;
  }
  const outputPositions = new Float32Array(positions.length), outputNormals = new Float32Array(normals.length);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const p = morphedPositions.slice(vertex * 3, vertex * 3 + 3);
    const n = morphedNormals.slice(vertex * 3, vertex * 3 + 3);
    let outP = [0, 0, 0], outN = [0, 0, 0], total = 0;
    for (let influence = 0; influence < 4; influence += 1) {
      const at = vertex * 4 + influence;
      const joint = Number(joints[at]), weight = finite(weights[at], "joint weight");
      if (!Number.isSafeInteger(joint) || joint < 0 || joint >= palette.length) throw new RangeError("Vertex references an unknown skin joint.");
      if (weight < 0) throw new RangeError("Skin joint weights cannot be negative.");
      if (weight === 0) continue;
      const matrix = palette[joint];
      const wp = multiplyPoint(matrix, p, 1);
      const wn = multiplyPoint(matrix, n, 0);
      outP = outP.map((value, axis) => value + wp[axis] * weight);
      outN = outN.map((value, axis) => value + wn[axis] * weight);
      total += weight;
    }
    if (total <= 1e-8) { outP = p; outN = n; total = 1; }
    for (let axis = 0; axis < 3; axis += 1) {
      outputPositions[vertex * 3 + axis] = outP[axis] / total;
      outputNormals[vertex * 3 + axis] = normalize3(outN)[axis];
    }
  }
  return Object.freeze({ positions: outputPositions, normals: outputNormals, vertexCount, revision: Math.max(1, Math.floor(Number(input.revision) || 1) + 1) });
}


function identity4() { return [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]; }
function multiply4(left, right) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += left[k * 4 + row] * right[column * 4 + k];
    }
  }
  return out;
}
function inverse4(value) {
  const m = vec(value, 16, "matrix");
  const a = Array.from({length:4}, (_, row) => [
    m[row], m[4+row], m[8+row], m[12+row],
    ...(row === 0 ? [1,0,0,0] : row === 1 ? [0,1,0,0] : row === 2 ? [0,0,1,0] : [0,0,0,1])
  ]);
  for (let col = 0; col < 4; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 4; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new RangeError("Scene transform matrix is singular.");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let k = 0; k < 8; k += 1) a[col][k] /= divisor;
    for (let row = 0; row < 4; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let k = 0; k < 8; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  const out = new Array(16);
  for (let row = 0; row < 4; row += 1) for (let col = 0; col < 4; col += 1) out[col * 4 + row] = a[row][col + 4];
  return out;
}
function composeNodeMatrix(node) {
  if (node.matrix && node.matrix.length === 16 && node.metadata?.matrixAuthored === true) return vec(node.matrix, 16, "node matrix");
  const [x,y,z,w] = vec(node.rotation || [0,0,0,1],4,"node rotation");
  const [sx,sy,sz] = vec(node.scale || [1,1,1],3,"node scale");
  const [tx,ty,tz] = vec(node.translation || [0,0,0],3,"node translation");
  return [
    (1-2*(y*y+z*z))*sx, 2*(x*y+z*w)*sx, 2*(x*z-y*w)*sx, 0,
    2*(x*y-z*w)*sy, (1-2*(x*x+z*z))*sy, 2*(y*z+x*w)*sy, 0,
    2*(x*z+y*w)*sz, 2*(y*z-x*w)*sz, (1-2*(x*x+y*y))*sz, 0,
    tx,ty,tz,1
  ];
}
function morphPStudioGeometry(geometry, weights) {
  const positions = vec(geometry.positions, geometry.positions.length, "morph base positions");
  const normals = vec(geometry.normals, geometry.normals.length, "morph base normals");
  const outputPositions = positions.slice(), outputNormals = normals.slice();
  const targets = geometry.morphTargets || [];
  if (weights.length && weights.length !== targets.length) throw new RangeError("Morph weight count must match the number of morph targets.");
  for (let index = 0; index < targets.length; index += 1) {
    const weight = finite(weights[index] ?? 0, "morph weight");
    const target = targets[index];
    if (target.positions) {
      const delta = vec(target.positions, positions.length, "morph position delta");
      for (let i = 0; i < delta.length; i += 1) outputPositions[i] += delta[i] * weight;
    }
    if (target.normals) {
      const delta = vec(target.normals, normals.length, "morph normal delta");
      for (let i = 0; i < delta.length; i += 1) outputNormals[i] += delta[i] * weight;
    }
  }
  return Object.freeze({
    positions: Float32Array.from(outputPositions),
    normals: Float32Array.from(Array.from({length: outputNormals.length / 3}, (_, i) => normalize3(outputNormals.slice(i * 3, i * 3 + 3))).flat()),
    vertexCount: positions.length / 3,
    revision: Math.max(1, Math.floor(Number(geometry.revision) || 1) + 1)
  });
}

/**
 * Evaluates a PStudio-owned animation clip against a complete immutable scene asset.
 * It updates node world transforms and performs morph-then-skin CPU deformation for
 * renderable entities, returning a new asset without mutating source geometry.
 */
export function evaluatePStudioSceneAnimation(sceneAsset, clipId, timeSeconds, options = {}) {
  if (sceneAsset?.kind !== "pstudio-graphics-scene-asset") throw new TypeError("A PStudio-owned scene asset is required.");
  const clip = (sceneAsset.animations || []).find(item => item.id === String(clipId));
  if (!clip) throw new RangeError("PStudio animation clip was not found: " + clipId);
  const frame = samplePStudioAnimationClip(clip, timeSeconds, { loop: options.loop === true });
  const nodeMap = new Map((sceneAsset.nodes || []).map(node => [node.id, {
    ...node,
    translation: Array.from(node.translation || [0,0,0]),
    rotation: Array.from(node.rotation || [0,0,0,1]),
    scale: Array.from(node.scale || [1,1,1]),
    weights: Array.from(node.weights || [])
  }]));
  for (const track of frame.tracks) {
    const node = nodeMap.get(track.targetId);
    if (!node) throw new Error("Animation track target node is not in the scene: " + track.targetId);
    if (track.path === "translation") node.translation = track.value.slice();
    else if (track.path === "rotation") node.rotation = track.value.slice();
    else if (track.path === "scale") node.scale = track.value.slice();
    else if (track.path === "weights") node.weights = track.value.slice();
  }
  const worldMatrices = new Map(), visiting = new Set();
  function worldFor(id) {
    if (worldMatrices.has(id)) return worldMatrices.get(id);
    const node = nodeMap.get(id);
    if (!node) throw new Error("Scene node reference is missing: " + id);
    if (visiting.has(id)) throw new Error("Scene node hierarchy contains a cycle at " + id);
    visiting.add(id);
    const local = composeNodeMatrix(node);
    const world = node.parentId ? multiply4(worldFor(node.parentId), local) : local;
    visiting.delete(id);
    worldMatrices.set(id, world);
    return world;
  }
  for (const id of nodeMap.keys()) worldFor(id);
  const animatedNodes = [...nodeMap.values()].map(node => Object.freeze({
    ...node,
    matrix: Object.freeze(composeNodeMatrix(node)),
    worldMatrix: Object.freeze(worldMatrices.get(node.id))
  }));
  const geometryMap = new Map((sceneAsset.geometries || []).map(geometry => [geometry.id, geometry]));
  const skinMap = new Map((sceneAsset.skins || []).map(skin => [skin.id, skin]));
  const geometries = [...sceneAsset.geometries];
  const entities = sceneAsset.entities.map(entity => {
    const nodeId = entity.nodeId || null;
    const node = nodeId ? nodeMap.get(nodeId) : null;
    const world = nodeId ? worldMatrices.get(nodeId) : entity.matrixWorld;
    if (!world) throw new Error("Renderable entity node has no world transform: " + entity.id);
    const source = geometryMap.get(entity.geometryId);
    if (!source) throw new Error("Renderable entity geometry is missing: " + entity.geometryId);
    const nodeWeights = node?.weights || [];
    const morphWeights = entity.morphWeights?.length ? Array.from(entity.morphWeights) : nodeWeights;
    let geometryId = entity.geometryId, skinId = entity.skinId, finalMorphWeights = morphWeights;
    if (skinId) {
      const skin = skinMap.get(skinId);
      if (!skin) throw new Error("Renderable entity skin is missing: " + skinId);
      const meshInverse = inverse4(world);
      const palette = skin.joints.map((jointId, index) =>
        multiply4(multiply4(meshInverse, worldMatrices.get(jointId) || (() => { throw new Error("Skin joint node is missing: " + jointId); })()), skin.inverseBindMatrices[index])
      );
      const deformed = deformPStudioSkinnedGeometry({
        positions: source.positions, normals: source.normals,
        jointIndices: source.jointIndices, jointWeights: source.jointWeights,
        jointMatrices: palette,
        morphTargets: source.morphTargets || [], morphWeights,
        revision: source.revision
      });
      geometryId = source.id + "@deformed@" + entity.id + "@" + frame.time;
      geometries.push({
        id: geometryId, positions: deformed.positions, normals: deformed.normals,
        uvs: source.uvs, uv2s: source.uv2s, tangents: source.tangents,
        indices: source.indices, groups: source.groups, revision: deformed.revision
      });
      skinId = null;
      finalMorphWeights = [];
    } else if (source.morphTargets?.length) {
      const deformed = morphPStudioGeometry(source, morphWeights);
      geometryId = source.id + "@morphed@" + entity.id + "@" + frame.time;
      geometries.push({
        id: geometryId, positions: deformed.positions, normals: deformed.normals,
        uvs: source.uvs, uv2s: source.uv2s, tangents: source.tangents,
        indices: source.indices, groups: source.groups, revision: deformed.revision
      });
      finalMorphWeights = [];
    }
    return Object.freeze({
      ...entity, geometryId, skinId, morphWeights: Object.freeze(finalMorphWeights),
      matrixWorld: Object.freeze(Array.from(world))
    });
  });
  const { createPStudioGraphicsSceneAsset } = await import("./pstudio_graphics_scene_asset.mjs");
  return createPStudioGraphicsSceneAsset({
    id: sceneAsset.id, revision: sceneAsset.revision + 1,
    geometries, materials: sceneAsset.materials, textures: sceneAsset.textures, entities,
    nodes: animatedNodes, skins: sceneAsset.skins, animations: sceneAsset.animations,
    clearColor: sceneAsset.clearColor, lighting: sceneAsset.lighting,
    metadata: { ...sceneAsset.metadata, animationClipId: clip.id, animationTime: frame.time }
  });
}

export function createPStudioSceneAnimationPlayer(sceneAsset, options = {}) {
  if (sceneAsset?.kind !== "pstudio-graphics-scene-asset") throw new TypeError("A PStudio-owned scene asset is required.");
  const clipId = String(options.clipId || sceneAsset.animations?.[0]?.id || "");
  if (!clipId || !sceneAsset.animations?.some(clip => clip.id === clipId)) throw new RangeError("A valid PStudio animation clip id is required.");
  let time = Math.max(0, finite(options.startTime ?? 0, "animation start time"));
  let playing = options.autoPlay === true;
  let disposed = false;
  const loop = options.loop !== false;
  function assertLive() { if (disposed) throw new Error("PStudio Scene Animation Player is disposed."); }
  function current() { return evaluatePStudioSceneAnimation(sceneAsset, clipId, time, { loop }); }
  return Object.freeze({
    play() { assertLive(); playing = true; return true; },
    pause() { assertLive(); playing = false; return true; },
    stop() { assertLive(); playing = false; time = 0; return current(); },
    seek(seconds) { assertLive(); time = Math.max(0, finite(seconds, "animation seek time")); return current(); },
    update(deltaSeconds) {
      assertLive();
      const delta = Math.max(0, finite(deltaSeconds, "animation delta"));
      if (playing) time += delta;
      const scene = current();
      return Object.freeze({ scene, time: loop && scene.metadata.animationTime != null ? scene.metadata.animationTime : time, playing });
    },
    dispose() { if (disposed) return false; disposed = true; playing = false; return true; },
    getState() { return Object.freeze({ disposed, clipId, time, playing, loop }); }
  });
}

export function selectPStudioLOD(levels, distance, currentIndex = null, hysteresis = 0.1) {
  if (!Array.isArray(levels) || !levels.length) throw new TypeError("At least one LOD level is required.");
  const normalized = levels.map((level, index) => {
    const maxDistance = Number(level.maxDistance);
    if (!Number.isFinite(maxDistance) || maxDistance <= 0) throw new RangeError("LOD maxDistance values must be finite and positive.");
    return { ...level, index, maxDistance };
  }).sort((a, b) => a.maxDistance - b.maxDistance);
  if (normalized.some((level, index) => index && level.maxDistance <= normalized[index - 1].maxDistance)) throw new RangeError("LOD distance thresholds must be strictly increasing.");
  const d = Math.max(0, finite(distance, "camera distance"));
  const h = Math.min(0.45, Math.max(0, finite(hysteresis, "LOD hysteresis")));
  if (Number.isSafeInteger(currentIndex) && currentIndex >= 0 && currentIndex < normalized.length) {
    const current = normalized[currentIndex];
    const lower = currentIndex === 0 ? 0 : normalized[currentIndex - 1].maxDistance * (1 - h);
    const upper = current.maxDistance * (1 + h);
    if (d >= lower && d <= upper) return Object.freeze({ ...current, changed: false });
  }
  const selected = normalized.find(level => d <= level.maxDistance) || normalized[normalized.length - 1];
  return Object.freeze({ ...selected, changed: selected.index !== currentIndex });
}

export function createPStudioInstancePool(options = {}) {
  const limit = Math.max(1, Math.min(1000000, Math.floor(Number(options.limit) || 100000)));
  const instances = new Map();
  let revision = 0;
  function matrix(value) { return vec(value || [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], 16, "instance transform"); }
  function create(id, transform) {
    const key = String(id || "").trim();
    if (!key || instances.has(key)) throw new Error("Instance id must be unique and non-empty.");
    if (instances.size >= limit) throw new RangeError("PStudio instance pool limit reached.");
    const record = { id: key, matrix: matrix(transform), visible: true, revision: ++revision };
    instances.set(key, record);
    return snapshot(record);
  }
  function snapshot(record) { return Object.freeze({ id: record.id, matrix: Object.freeze(record.matrix.slice()), visible: record.visible, revision: record.revision }); }
  function update(id, patch = {}) {
    const record = instances.get(String(id));
    if (!record) throw new Error("PStudio instance not found: " + id);
    const nextMatrix = patch.matrix == null ? record.matrix : matrix(patch.matrix);
    const nextVisible = patch.visible == null ? record.visible : patch.visible === true;
    record.matrix = nextMatrix; record.visible = nextVisible; record.revision = ++revision;
    return snapshot(record);
  }
  function release(id) { const removed = instances.delete(String(id)); if (removed) revision += 1; return removed; }
  return Object.freeze({
    create, update, release,
    get: id => instances.has(String(id)) ? snapshot(instances.get(String(id))) : null,
    snapshot: () => Object.freeze([...instances.values()].map(snapshot)),
    stats: () => Object.freeze({ count: instances.size, limit, revision }),
    clear: () => { const count = instances.size; instances.clear(); revision += count ? 1 : 0; return count; }
  });
}
