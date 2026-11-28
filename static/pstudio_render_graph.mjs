import { PStudioGraphicsError } from './pstudio_graphics_contract.mjs';

const ACCESS = new Set(['sampled', 'storage-read', 'storage-write', 'color-attachment', 'depth-attachment', 'vertex', 'index', 'uniform', 'indirect', 'copy-src', 'copy-dst', 'present']);
const WRITES = new Set(['storage-write', 'color-attachment', 'depth-attachment', 'copy-dst']);
const READS = new Set(['sampled', 'storage-read', 'vertex', 'index', 'uniform', 'indirect', 'copy-src', 'present']);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const idOf = value => String(typeof value === 'string' ? value : value?.resource || value?.id || '').trim();
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
};

/**
 * Deterministic, backend-neutral render graph. Pass callbacks are opt-in and are never
 * connected to the production PStudio3D render loop automatically.
 */
export function createPStudioRenderGraph(options = {}) {
  const resources = new Map();
  const passes = new Map();
  let revision = 0;
  let cachedPlan = null;
  let executing = false;
  let disposed = false;
  let executionCount = 0;

  function assertLive() {
    if (disposed) throw new PStudioGraphicsError('Render Graph is disposed.', { code: 'PSTUDIO_RENDER_GRAPH_DISPOSED' });
  }
  function changed() { revision += 1; cachedPlan = null; }
  function normalizeUse(value, direction) {
    const use = typeof value === 'string' ? { resource: value, access: direction === 'read' ? 'sampled' : 'storage-write' } : object(value);
    const resource = idOf(use);
    const access = String(use.access || (direction === 'read' ? 'sampled' : 'storage-write')).toLowerCase();
    if (!resource) throw new TypeError('Render Graph resource use requires a resource id.');
    if (!ACCESS.has(access)) throw new TypeError('Unsupported Render Graph access: ' + access);
    if (direction === 'read' && !READS.has(access)) throw new TypeError('Read use must specify a read-only access mode.');
    if (direction === 'write' && !WRITES.has(access)) throw new TypeError('Write use must specify a write access mode.');
    return Object.freeze({ resource, access, slot: use.slot == null ? null : String(use.slot) });
  }
  function addResource(input = {}) {
    assertLive();
    const id = String(input.id || '').trim();
    const type = String(input.type || 'texture').trim().toLowerCase();
    if (!id) throw new TypeError('Render Graph resource id is required.');
    if (resources.has(id)) throw new PStudioGraphicsError('Render Graph resource already exists: ' + id, { code: 'PSTUDIO_RENDER_GRAPH_DUPLICATE_RESOURCE' });
    if (!['texture', 'buffer', 'surface', 'acceleration-structure'].includes(type)) throw new TypeError('Unsupported Render Graph resource type: ' + type);
    const descriptor = Object.freeze({
      id, type,
      format: input.format == null ? null : String(input.format),
      width: input.width == null ? null : Math.floor(Number(input.width)),
      height: input.height == null ? null : Math.floor(Number(input.height)),
      depth: input.depth == null ? null : Math.floor(Number(input.depth)),
      size: input.size == null ? null : Math.floor(Number(input.size)),
      samples: input.samples == null ? 1 : Math.floor(Number(input.samples)),
      usage: Object.freeze([...new Set((input.usage || []).map(String).map(v => v.toLowerCase()))].sort()),
      lifetime: ['transient', 'persistent', 'external'].includes(input.lifetime) ? input.lifetime : 'transient',
      imported: input.imported === true || input.lifetime === 'external',
      aliasable: input.aliasable !== false && input.lifetime !== 'external' && input.imported !== true,
      initialState: input.initialState == null ? 'undefined' : String(input.initialState),
      metadata: Object.freeze({ ...object(input.metadata) })
    });
    for (const field of ['width', 'height', 'depth', 'size', 'samples']) {
      const value = descriptor[field];
      if (value != null && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError('Render Graph resource ' + field + ' must be a positive integer.');
    }
    resources.set(id, descriptor);
    changed();
    return descriptor;
  }
  function addPass(input = {}) {
    assertLive();
    const id = String(input.id || '').trim();
    if (!id) throw new TypeError('Render Graph pass id is required.');
    if (passes.has(id)) throw new PStudioGraphicsError('Render Graph pass already exists: ' + id, { code: 'PSTUDIO_RENDER_GRAPH_DUPLICATE_PASS' });
    if (typeof input.execute !== 'function') throw new TypeError('Render Graph pass requires execute(context).');
    const reads = Object.freeze((input.reads || []).map(value => normalizeUse(value, 'read')));
    const writes = Object.freeze((input.writes || []).map(value => normalizeUse(value, 'write')));
    const readResources = new Set(reads.map(use => use.resource));
    const writeResources = new Set(writes.map(use => use.resource));
    for (const resourceId of writeResources) {
      if (readResources.has(resourceId)) throw new PStudioGraphicsError('A pass cannot read and write the same resource without an explicit ping-pong resource: ' + id + ' / ' + resourceId, { code: 'PSTUDIO_RENDER_GRAPH_FEEDBACK_LOOP' });
    }
    // A single pass cannot express an intra-pass access transition in the current
    // backend-neutral command contract. Identical repeated declarations are harmless;
    // mixed modes must be split into separate passes with an explicit dependency.
    for (const useList of [reads, writes]) {
      const accessByResource = new Map();
      for (const use of useList) {
        const previous = accessByResource.get(use.resource);
        if (previous && previous !== use.access) {
          throw new PStudioGraphicsError('A pass cannot use one resource through multiple access modes; split the operation into ordered passes: ' + id + ' / ' + use.resource, { code: 'PSTUDIO_RENDER_GRAPH_INTRA_PASS_ACCESS_TRANSITION' });
        }
        accessByResource.set(use.resource, use.access);
      }
    }
    const dependsOn = Object.freeze([...new Set((input.dependsOn || []).map(String).map(v => v.trim()).filter(Boolean))]);
    const pass = Object.freeze({
      id,
      type: ['render', 'compute', 'copy', 'present', 'custom'].includes(input.type) ? input.type : 'render',
      reads, writes, dependsOn,
      execute: input.execute,
      metadata: Object.freeze({ ...object(input.metadata) })
    });
    passes.set(id, pass);
    changed();
    return pass;
  }
  function removePass(id) { assertLive(); const removed = passes.delete(String(id)); if (removed) changed(); return removed; }
  function removeResource(id) {
    assertLive(); const key = String(id);
    if ([...passes.values()].some(pass => [...pass.reads, ...pass.writes].some(use => use.resource === key))) throw new PStudioGraphicsError('Cannot remove a resource still referenced by a pass: ' + key, { code: 'PSTUDIO_RENDER_GRAPH_RESOURCE_IN_USE' });
    const removed = resources.delete(key); if (removed) changed(); return removed;
  }

  function compile(compileOptions = {}) {
    assertLive();
    if (cachedPlan && cachedPlan.revision === revision && compileOptions.allowTransientAliasing !== false) return cachedPlan;
    const passList = [...passes.values()];
    const resourceMap = new Map(resources);
    const edges = new Map(passList.map(pass => [pass.id, new Set()]));
    const reverse = new Map(passList.map(pass => [pass.id, new Set()]));
    const addEdge = (from, to) => {
      if (from === to) throw new PStudioGraphicsError('Render Graph pass depends on itself: ' + from, { code: 'PSTUDIO_RENDER_GRAPH_CYCLE' });
      if (!edges.has(from) || !edges.has(to)) throw new PStudioGraphicsError('Render Graph dependency references an unknown pass.', { code: 'PSTUDIO_RENDER_GRAPH_UNKNOWN_DEPENDENCY', details: { from, to } });
      edges.get(from).add(to); reverse.get(to).add(from);
    };
    for (const pass of passList) {
      for (const dep of pass.dependsOn) addEdge(dep, pass.id);
      for (const use of [...pass.reads, ...pass.writes]) if (!resourceMap.has(use.resource)) {
        throw new PStudioGraphicsError('Render Graph pass references an unknown resource: ' + use.resource, { code: 'PSTUDIO_RENDER_GRAPH_UNKNOWN_RESOURCE', details: { pass: pass.id, resource: use.resource } });
      }
    }
    // Infer RAW, WAR and WAW dependencies in declaration order. Explicit edges may
    // add constraints, but may not remove hazards.
    const lastWriter = new Map();
    const readersSinceWrite = new Map();
    for (const pass of passList) {
      for (const read of pass.reads) {
        const descriptor = resourceMap.get(read.resource);
        const writer = lastWriter.get(read.resource);
        if (!writer && !descriptor.imported) throw new PStudioGraphicsError('Transient or uninitialized resource is read before its first write: ' + read.resource, { code: 'PSTUDIO_RENDER_GRAPH_READ_BEFORE_WRITE', details: { pass: pass.id } });
        if (writer) addEdge(writer, pass.id);
        if (!readersSinceWrite.has(read.resource)) readersSinceWrite.set(read.resource, new Set());
        readersSinceWrite.get(read.resource).add(pass.id);
      }
      for (const write of pass.writes) {
        const writer = lastWriter.get(write.resource);
        if (writer) addEdge(writer, pass.id);
        for (const reader of readersSinceWrite.get(write.resource) || []) addEdge(reader, pass.id);
        readersSinceWrite.set(write.resource, new Set());
        lastWriter.set(write.resource, pass.id);
      }
    }
    const index = new Map(passList.map((pass, i) => [pass.id, i]));
    const ready = passList.filter(pass => reverse.get(pass.id).size === 0).map(pass => pass.id);
    const ordered = [];
    while (ready.length) {
      ready.sort((a, b) => index.get(a) - index.get(b));
      const id = ready.shift(); ordered.push(id);
      for (const next of edges.get(id)) {
        reverse.get(next).delete(id);
        if (reverse.get(next).size === 0) ready.push(next);
      }
    }
    if (ordered.length !== passList.length) {
      const cyclic = passList.filter(pass => !ordered.includes(pass.id)).map(pass => pass.id);
      throw new PStudioGraphicsError('Render Graph contains a dependency cycle: ' + cyclic.join(', '), { code: 'PSTUDIO_RENDER_GRAPH_CYCLE', details: { passes: cyclic } });
    }
    const orderedIndex = new Map(ordered.map((id, i) => [id, i]));
    const orderedPasses = ordered.map(id => passes.get(id));
    const lifetimes = new Map();
    for (const [resourceId, descriptor] of resourceMap) {
      const uses = [];
      orderedPasses.forEach((pass, i) => { if ([...pass.reads, ...pass.writes].some(use => use.resource === resourceId)) uses.push(i); });
      lifetimes.set(resourceId, Object.freeze({ resource: resourceId, firstUse: uses.length ? uses[0] : -1, lastUse: uses.length ? uses[uses.length - 1] : -1, unused: uses.length === 0, lifetime: descriptor.lifetime }));
    }
    const allowAliasing = compileOptions.allowTransientAliasing !== false;
    const slots = [];
    const aliasAssignments = {};
    const compatible = (a, b) => a.type === b.type && a.format === b.format && a.width === b.width && a.height === b.height && a.depth === b.depth && a.size === b.size && a.samples === b.samples && stable(a.usage) === stable(b.usage);
    const lifetimeOrder = [...resourceMap.values()].sort((a, b) => lifetimes.get(a.id).firstUse - lifetimes.get(b.id).firstUse || a.id.localeCompare(b.id));
    for (const descriptor of lifetimeOrder) {
      const life = lifetimes.get(descriptor.id);
      if (life.unused || descriptor.imported || descriptor.lifetime === 'external') { aliasAssignments[descriptor.id] = null; continue; }
      let slot = null;
      if (allowAliasing && descriptor.lifetime === 'transient' && descriptor.aliasable) {
        slot = slots.find(candidate => candidate.aliasable && candidate.lastUse < life.firstUse && compatible(candidate.descriptor, descriptor));
      }
      if (!slot) {
        slot = { id: slots.length, descriptor, lastUse: life.lastUse, transient: descriptor.lifetime === 'transient', aliasable: allowAliasing && descriptor.lifetime === 'transient' && descriptor.aliasable };
        slots.push(slot);
      } else {
        slot.lastUse = life.lastUse;
        (slot.aliases ||= []).push(descriptor.id);
      }
      aliasAssignments[descriptor.id] = slot.id;
    }
    const lastAccess = new Map();
    const barriers = [];
    for (const pass of orderedPasses) {
      for (const use of [...pass.reads, ...pass.writes]) {
        const previous = lastAccess.get(use.resource);
        const nextWrites = WRITES.has(use.access);
        const prevWrites = previous ? WRITES.has(previous.access) : false;
        if (previous && previous.pass !== pass.id && (previous.access !== use.access || (prevWrites && nextWrites))) {
          const kind = prevWrites && nextWrites ? 'write-after-write' : prevWrites ? 'write-to-read' : nextWrites ? 'read-to-write' : 'read-state-transition';
          barriers.push(Object.freeze({ resource: use.resource, beforePass: pass.id, from: previous.access, to: use.access, kind }));
        }
        lastAccess.set(use.resource, { access: use.access, pass: pass.id });
      }
    }
    const dependencies = Object.freeze(Object.fromEntries([...edges].map(([id, next]) => [id, Object.freeze([...next].sort((a, b) => orderedIndex.get(a) - orderedIndex.get(b)))])));
    const plan = Object.freeze({
      kind: 'pstudio-render-graph-plan', revision,
      passOrder: Object.freeze(ordered),
      passes: Object.freeze(orderedPasses),
      resources: Object.freeze([...resourceMap.values()]),
      dependencies,
      resourceLifetimes: Object.freeze([...lifetimes.values()]),
      aliasAssignments: Object.freeze(aliasAssignments),
      transientSlotCount: slots.filter(slot => slot.transient).length,
      aliasableTransientSlotCount: slots.filter(slot => slot.aliasable).length,
      allocationSlotCount: slots.length,
      barriers: Object.freeze(barriers),
      barrierCount: barriers.length,
      compileOptions: Object.freeze({ allowTransientAliasing: allowAliasing })
    });
    if (allowAliasing) cachedPlan = plan;
    return plan;
  }

  async function materialize(materializeOptions = {}) {
    assertLive();
    const plan = materializeOptions.plan || compile(materializeOptions.compileOptions);
    if (plan.kind !== 'pstudio-render-graph-plan') throw new TypeError('A compiled PStudio Render Graph plan is required.');
    const backend = materializeOptions.backend;
    const external = materializeOptions.resources || materializeOptions.externalResources || {};
    const used = new Set(plan.passes.flatMap(pass => [...pass.reads, ...pass.writes].map(use => use.resource)));
    const resolved = {};
    const allocated = [];
    const slotHandles = new Map();
    let released = false;
    const disposeOne = async entry => {
      if (entry.disposed) return false;
      entry.disposed = true;
      try {
        if (typeof entry.value?.dispose === 'function') await entry.value.dispose('render-graph-release');
        else if (typeof backend?.destroyResource === 'function') await backend.destroyResource(entry.value?.handle ?? entry.value, entry.descriptor);
        else throw new PStudioGraphicsError('Render Graph backend cannot release an allocated resource.', { code: 'PSTUDIO_RENDER_GRAPH_RELEASE_UNAVAILABLE' });
      } catch (error) {
        entry.error = error;
        throw error;
      }
      return true;
    };
    try {
      for (const descriptor of plan.resources) {
        if (!used.has(descriptor.id)) { resolved[descriptor.id] = null; continue; }
        if (descriptor.imported || descriptor.lifetime === 'external') {
          const borrowed = external[descriptor.id];
          if (borrowed == null) throw new PStudioGraphicsError('An external Render Graph resource was not supplied: ' + descriptor.id, { code: 'PSTUDIO_RENDER_GRAPH_EXTERNAL_RESOURCE_MISSING', details: { resource: descriptor.id } });
          resolved[descriptor.id] = borrowed;
          continue;
        }
        const slotId = plan.aliasAssignments[descriptor.id];
        if (slotId == null) throw new PStudioGraphicsError('A used Render Graph resource has no allocation slot: ' + descriptor.id, { code: 'PSTUDIO_RENDER_GRAPH_ALLOCATION_SLOT_MISSING' });
        if (!slotHandles.has(slotId)) {
          if (!backend || typeof backend.createResource !== 'function') throw new PStudioGraphicsError('Render Graph backend cannot allocate resources.', { code: 'PSTUDIO_RENDER_GRAPH_ALLOCATION_UNAVAILABLE' });
          const allocationDescriptor = Object.freeze({ ...descriptor, id: 'pstudio.render-graph.slot.' + slotId, domain: 'gpu', lifetime: 'transient', imported: false });
          const value = await backend.createResource(allocationDescriptor, { renderGraph: true, slotId, aliasResources: Object.freeze(plan.resources.filter(item => plan.aliasAssignments[item.id] === slotId).map(item => item.id)) });
          if (value == null) throw new PStudioGraphicsError('Render Graph backend returned an empty allocation for slot ' + slotId, { code: 'PSTUDIO_RENDER_GRAPH_ALLOCATION_EMPTY' });
          const entry = { value, descriptor: allocationDescriptor, disposed: false };
          allocated.push(entry);
          slotHandles.set(slotId, value);
        }
        resolved[descriptor.id] = slotHandles.get(slotId);
      }
      return Object.freeze({
        kind: 'pstudio-render-graph-materialization', plan,
        resources: Object.freeze(resolved), allocationCount: allocated.length,
        release: async () => {
          if (released) return false;
          released = true;
          const errors = [];
          for (const entry of [...allocated].reverse()) {
            try { await disposeOne(entry); } catch (error) { errors.push(error); }
          }
          if (errors.length) throw new AggregateError(errors, 'One or more Render Graph allocations could not be released.');
          return true;
        }
      });
    } catch (error) {
      for (const entry of [...allocated].reverse()) { try { await disposeOne(entry); } catch (_) {} }
      throw error;
    }
  }

  async function execute(executionOptions = {}) {
    assertLive();
    if (executing) throw new PStudioGraphicsError('Render Graph is already executing.', { code: 'PSTUDIO_RENDER_GRAPH_BUSY' });
    const plan = executionOptions.plan || compile(executionOptions.compileOptions);
    if (plan.kind !== 'pstudio-render-graph-plan') throw new TypeError('A compiled PStudio Render Graph plan is required.');
    const backend = executionOptions.backend || null;
    const signal = executionOptions.signal || null;
    const materialized = executionOptions.materialized || null;
    if (materialized && materialized.kind !== 'pstudio-render-graph-materialization') throw new TypeError('Invalid Render Graph materialization.');
    if (materialized && materialized.plan !== plan) throw new PStudioGraphicsError('Materialized resources belong to a different Render Graph plan.', { code: 'PSTUDIO_RENDER_GRAPH_MATERIALIZATION_MISMATCH' });
    const handles = { ...(materialized?.resources || {}), ...(executionOptions.resources || {}) };
    const runtimeResources = new Map();
    for (const descriptor of plan.resources) runtimeResources.set(descriptor.id, handles[descriptor.id] ?? null);
    const getResource = id => {
      const key = String(id);
      if (!runtimeResources.has(key)) throw new PStudioGraphicsError('Unknown resource requested during Render Graph execution: ' + key, { code: 'PSTUDIO_RENDER_GRAPH_UNKNOWN_RESOURCE' });
      return runtimeResources.get(key);
    };
    const barriersByPass = new Map();
    for (const barrier of plan.barriers) {
      if (!barriersByPass.has(barrier.beforePass)) barriersByPass.set(barrier.beforePass, []);
      barriersByPass.get(barrier.beforePass).push(barrier);
    }
    executing = true;
    const begun = [];
    try {
      if (signal?.aborted) throw new PStudioGraphicsError('Render Graph execution was cancelled.', { code: 'PSTUDIO_RENDER_GRAPH_CANCELLED' });
      await backend?.beginGraph?.(plan, executionOptions);
      for (const pass of plan.passes) {
        if (signal?.aborted) throw new PStudioGraphicsError('Render Graph execution was cancelled.', { code: 'PSTUDIO_RENDER_GRAPH_CANCELLED' });
        for (const barrier of barriersByPass.get(pass.id) || []) await backend?.barrier?.(barrier, { plan, pass });
        const context = Object.freeze({
          graph: plan, pass, frame: executionOptions.frame ?? null,
          backend, signal, getResource,
          resources: Object.freeze(Object.fromEntries([...pass.reads, ...pass.writes].map(use => [use.resource, getResource(use.resource)]))),
          barriers: Object.freeze(barriersByPass.get(pass.id) || [])
        });
        await backend?.beginPass?.(pass, context);
        begun.push(pass);
        await pass.execute(context);
        await backend?.endPass?.(pass, context);
        begun.pop();
      }
      await backend?.endGraph?.(plan, executionOptions);
      executionCount += 1;
      return Object.freeze({ success: true, revision: plan.revision, passCount: plan.passes.length, barriers: plan.barrierCount, executionCount });
    } catch (error) {
      for (const pass of begun.reverse()) { try { await backend?.abortPass?.(pass, error); } catch (_) {} }
      try { await backend?.abortGraph?.(plan, error); } catch (_) {}
      throw error;
    } finally { executing = false; }
  }
  function reset() { assertLive(); if (executing) throw new PStudioGraphicsError('Cannot reset a running Render Graph.', { code: 'PSTUDIO_RENDER_GRAPH_BUSY' }); resources.clear(); passes.clear(); changed(); return true; }
  function stats() { return Object.freeze({ resourceCount: resources.size, passCount: passes.size, revision, executing, executionCount, compiled: !!cachedPlan, disposed }); }
  function dispose() { if (disposed) return false; if (executing) throw new PStudioGraphicsError('Cannot dispose a running Render Graph.', { code: 'PSTUDIO_RENDER_GRAPH_BUSY' }); resources.clear(); passes.clear(); cachedPlan = null; disposed = true; return true; }
  return Object.freeze({ kind: 'pstudio-render-graph', addResource, addPass, removePass, removeResource, compile, materialize, execute, reset, stats, dispose });
}
