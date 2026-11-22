# ECS Full Runtime Migration Plan

## Objective

Move gameplay runtime state and behavior toward ECS without turning every engine subsystem into an Entity or Component. ECS is the authoritative model for game-world entities, their runtime data, and scheduled gameplay behavior. Specialized services remain responsible for rendering, storage, asset decoding, editor interaction, asynchronous work, and platform integration.

This is a staged migration. Existing ps built-ins and project files remain compatible until each subsystem has a tested replacement path.

## Ownership rules

- Entity identity and game-world component data belong to ECS.
- Deterministic per-frame gameplay behavior belongs in ECS Systems.
- GPU objects, Three.js scene graphs, shader programs, decoded model caches, and resource leases remain owned by the renderer/resource services. ECS may hold stable handles/configuration, never raw GPU ownership.
- IndexedDB and project backup/serialization remain owned by the asset/editor layer. ECS exposes serializable gameplay state through explicit save/load boundaries.
- DOM and editor controls remain presentation/editor concerns. ECS may publish UI-facing state/events but does not own DOM nodes.
- Input devices, browser audio, worker/job scheduling, and platform capabilities remain services. ECS Systems consume snapshots/commands from those services.
- The event bus remains cross-subsystem infrastructure. ECS may enqueue and emit domain events; it does not replace the generic event bus.
- Physics solver remains authoritative for fixed-step collision resolution until a deliberate solver replacement is designed. ECS Components own body configuration and gameplay-facing state.

## Migration inventory

| Domain | Current ownership | ECS direction | Status |
|---|---|---|---|
| Scene entity identity | Scene Objects + ECS mirror | ECS Entity with SceneObjectRef bridge | Existing bridge |
| Transform | Scene Object fields + ECS Transform | ECS Transform with explicit editor/world coordinate adapters | Partial; two-way editor bridge remains |
| Physics body | PStudioPhysics | PhysicsBody config + PhysicsState/PhysicsTransform Components; solver remains authoritative | Partial bridge |
| Velocity | Gameplay/runtime code | Velocity Component + integration System | Initial System exists |
| Health | PStudioGameplay stats Map | Health Component | Phase 3 implemented |
| Inventory | PStudioGameplay inventories Map | Inventory Component with item-count object and Stop/Play snapshot | Phase 4 implemented |
| Equipment | PStudioGameplay equipment Map | Equipment Component with slot-to-item data | Phase 4 implemented |
| Item/weapon definitions | PStudioGameplay definition Maps | Project-level data assets/resources; entity equipment references definitions | Pending design |
| Combat cooldowns/combos | attackTimes / weaponCombos Maps | CombatState Component + cooldown maintenance System | Phase 4 implemented |
| Enemy AI | aiStates Map + direct helper calls | AIController + MovementIntent Components and postUpdate Systems | Phase 4 implemented |
| Quest state | global quests/questDefinitions Maps | QuestProgress entities; definitions remain project/gameplay config | Phase 4 implemented |
| Dialogue | dialogueStates and activeUI globals | DialogueSession Component; PStudioUI still owns DOM presentation | Phase 4 implemented |
| Navigation | navNodes/blockedNavNodes Maps | Navigation graph as world data; path requests/results as Components or events | Pending design |
| Input | engine-global keyboard/touch sets | Input snapshot service + per-entity PlayerInput/ControlIntent Components | Pending |
| Audio | ownerAudio Map and HTMLAudio objects | AudioEmitter/AudioCommand Components; audio service owns HTMLAudio resources | Pending |
| Collision events | engine collision-pair Sets + Physics callbacks | ECS-facing collision events and optional contact Components | Pending |
| Render commands | per-frame draw command Maps | Renderable/Camera/Light/Animation configuration Components consumed by renderer | Pending; renderer remains owner |
| Model/GLB resources | PStudio3D + AssetStore + Resources | ECS stores asset references and presentation config only | Service boundary; not a wholesale ECS rewrite |
| Environment / post FX | PStudio3D + EnvironmentFX | Environment/Water/Fog/Light configuration Components consumed by renderer | Pending |
| Particles/trails | renderer-owned transient GPU systems | Emitter/Trail configuration Components; renderer owns GPU buffers | Pending |
| World chunks/streaming | PStudio3D chunk manager | WorldPartition/StreamingInterest Components and Systems; renderer retains GPU cache ownership | Pending |
| HUD/game UI | PStudioUI DOM renderer + Gameplay UI state | UI state/events may be ECS data; DOM stays in UI service | Pending boundary |
| Events | PStudioEvents | Remains shared event infrastructure, with ECS adapters | Keep service |
| Jobs | PStudioJobs cooperative queue | Jobs remain async infrastructure; ECS stores task state only where gameplay needs it | Keep service |
| Modules | PStudioModules registry | Modules register/unregister ECS Components and Systems through lifecycle hooks | Integration pending |
| Assets/storage | PStudioAssetStore / IndexedDB | ECS stores stable asset IDs, never binary asset payloads | Keep service |
| Editor/Inspector | templates/index.html | Inspector reads/writes ECS definitions and selected-entity Components | Existing partial integration |
| Scene/project persistence | editor serializer and project backup | Explicit Component serialization allowlist and versioned migration | Partial |

## Safe implementation sequence

1. **Health** — move HP state into ECS, keep ps built-ins unchanged, snapshot state at Stop. (Phase 3 complete.)
2. **Inventory and equipment** — typed runtime Components store per-entity item counts and equipment slots. Static item definitions remain service configuration; Stop/Play snapshots are regression-tested. (Phase 4 implemented; stack limits and project-asset definitions remain future work.)
3. **Combat and AI** — cooldown/combo data live in CombatState; AIController evaluates in postUpdate and MovementIntent resolves before Physics. Existing ps function names and synchronous AI result are preserved. (Phase 4 implemented.)
4. **Quests and dialogue** — QuestProgress uses standalone ECS entities; DialogueSession holds conversation content/choice while PStudioUI owns presentation. Static quest definitions remain service data. (Phase 4 implemented.)
5. **Input, audio, collision events** — define immutable per-frame input snapshots, queued audio commands, and deterministic collision event delivery.
6. **Rendering-facing Components** — expose camera, light, renderable, animation, particle, water and environment configuration as Components. Renderer consumes snapshots and remains the sole owner of Three.js/GPU resources.
7. **Streaming and module lifecycle** — connect world-partition interest and module activation to ECS System lifecycle without moving resource disposal or async job execution into ECS.
8. **Persistence and compatibility cleanup** — versioned scene/project serialization, old-project migration tests, deprecation period for legacy APIs, then remove duplicate runtime stores only after parity tests.

## Required gates for every slice

- Fetch and review the complete current owning files before edits.
- Preserve existing public ps built-ins and return semantics unless a versioned change is explicitly intended.
- Add tests for old behavior, new ECS ownership, lifecycle cleanup, save/load and failure rollback.
- Do not create per-frame allocations/scans where a stable query or cached mapping is sufficient.
- Verify System phase/priority order and prevent duplicate writers to the same authoritative state.
- Run the full Python and JavaScript CI suites.
- Keep browser/WebGL/mobile-device validation as a separate gate; CI alone is not proof of rendering or touch correctness.
- Do not claim full migration while any domain in the inventory remains pending.
