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
| Scene entity identity | Scene Objects + ECS mirror | ECS Entity with SceneObjectRef bridge | Existing identity/transform compatibility adapter remains |\n| Script assignment | Scene Object `script` field | Persistent ScriptAttachment Component stores the .ps project-file reference; AST and execution context remain Runtime-owned | Phase 20 implemented; legacy field is migrated once |\n| 2D presentation | Scene Object `sprite/color/shape/w/h` fields | Persistent SpriteRenderer Component stores image reference, dimensions, tint and shape; image bytes and Canvas rendering remain AssetStore/Runtime-owned | Phase 20 implemented; legacy fields migrated once |\n| 2D collision | Scene Object `collider` flag + engine overlap Sets | Persistent Collider2D Component gates overlap detection; event pair sets and collision dispatch remain service-owned | Phase 20 implemented |\n| Model asset reference | Scene Object `model`/`modelScale` fields | Existing persistent Renderable Component stores model asset ID and scale | Phase 20 integrated with Phase 19 |\n| Editor manipulation | Scene Object `manipulationEnabled` flag | Persistent EditorObjectSettings Component | Phase 20 implemented |
| Transform | Scene Object fields + ECS Transform | ECS Transform is the runtime component; the Scene Object bridge performs deterministic two-way editor/project synchronization and transform application | Runtime ownership migrated; editor/project adapter intentionally remains |
| Physics body | PStudioPhysics | PhysicsBody configuration and PhysicsState/PhysicsTransform snapshots are ECS Components; the fixed-step PStudioPhysics solver remains the physics service | ECS state/configuration migrated; solver adapter intentionally remains |
| Velocity | Gameplay/runtime code | Velocity Component + integration System; PhysicsBody entities are excluded from the Transform integrator | Implemented; solver-driven bodies use PStudioPhysics |
| Health | PStudioGameplay stats Map | Health Component stored in the Scene Object's versioned ECS payload | Phase 3 runtime / Phase 17 persistence implemented |
| Inventory | PStudioGameplay inventories Map | Inventory Component stored in the Scene Object's versioned ECS payload | Phase 4 runtime / Phase 17 persistence implemented |
| Equipment | PStudioGameplay equipment Map | Equipment Component stored in the Scene Object's versioned ECS payload | Phase 4 runtime / Phase 17 persistence implemented |
| Item/weapon/quest definitions | PStudioGameplay definition Maps | Standalone ItemDefinition/WeaponDefinition/QuestDefinition Entities hold gameplay configuration; legacy defineItem/defineWeapon/questDefine APIs write through to ECS | Phase 15 implemented; definitions are runtime config, distinct from per-entity state |
| Combat cooldowns/combos | attackTimes / weaponCombos Maps | CombatState Component stored in the Scene Object's versioned ECS payload + cooldown maintenance System | Phase 4 runtime / Phase 17 persistence implemented |
| Enemy AI | aiStates Map + direct helper calls | AIController + MovementIntent Components and postUpdate Systems | Phase 4 implemented |
| Quest state | PStudioGameplay quests Map + ECS | QuestProgress standalone Entities remain in ECS across Stop/Play; QuestDefinition is a separate ECS definition Entity | Phase 4 runtime / Phase 15 definitions / Phase 17 session lifecycle implemented |
| Dialogue | dialogueStates and activeUI globals | DialogueSession standalone ECS Entity remains in ECS across Stop/Play; PStudioUI still owns DOM presentation | Phase 4 runtime / Phase 17 session lifecycle implemented |
| Navigation | navNodes/blockedNavNodes Maps | Standalone NavigationNode Entities own node IDs, coordinates, links and blocked state; ECS bridge provides nearest-node and A* next-node queries | Phase 5 implemented; graph is runtime-only and preserves its in-memory Play/Stop lifetime |
| Input | engine keyboard/touch event state | InputSnapshot/ControlIntent are transient; PlayerInput key mappings are persistent Inspector-editable Components stored with their Scene Object | Phase 6 runtime / Phase 17 PlayerInput persistence implemented |
| Audio | ownerAudio Map and HTMLAudio objects | Persistent AudioEmitter configuration + transient AudioCommand requests; existing Audio service owns HTMLAudio resources | Phase 8 implemented; commands dispatch after ps update in postUpdate |
| Collision events | engine collision-pair Sets + Physics solver contacts | Runtime-only CollisionEvent Entities represent enter/stay/exit transitions; PStudioEvents publishes collision notifications; solver remains authoritative | Phase 7 implemented for 2D, 3D and dynamic body-pair contacts |
| Render commands | per-frame draw command Maps | Persistent Renderable/Camera/Light/Animation Components feed the existing renderer command pipeline; Three.js/GPU resources remain renderer-owned | Phase 9 implemented |\n| Render authoring settings | Scene Object toonMaterialSettings/modelMaterialOverrides/shaderFragment/modelScale and collider flags | Persistent ToonMaterial/MaterialOverrides/ShaderMaterial/MeshCollider Components; legacy fields migrate once into the versioned ECS payload and Inspector reads/writes Components | Phase 19 implemented; shader/material/mesh resources remain renderer/physics-owned |
| Model/GLB resources | PStudio3D + AssetStore + Resources | ECS stores asset references and presentation config only | Service boundary; not a wholesale ECS rewrite |
| Environment / post FX | PStudio3D + EnvironmentFX | Persistent Environment/Fog/Water/PostFX Components emit renderer commands; PStudio3D retains environment textures, water materials, post-processing passes and GPU resources | Phase 11 implemented; legacy ps commands preserved |
| Particles/trails | renderer-owned transient GPU systems | Persistent ParticleEmitter/Trail configuration Components feed existing renderer commands; PStudio3D retains particle simulation, trail sampling, buffers and disposal; one-shot bursts remain transient service commands | Phase 11 implemented |
| World chunks/streaming | PStudio3D chunk manager | Persistent WorldPartition and StreamingInterest Components snapshot region membership and multiple prioritized interest points; PStudio3D retains async asset jobs, chunk activation, GPU leases and rendering | Phase 10 implemented; generation-safe reconfiguration, multi-interest hysteresis and bounded load concurrency |
| HUD/game UI | PStudioUI DOM renderer + Gameplay UI state | Transient UIOverlay singleton Component owns active inventory/quest/dialogue intent; PStudioUI retains DOM, input widgets and presentation | Phase 12 implemented; state resets at Game Stop and is not serialized |
| Events | PStudioEvents | Remains shared event infrastructure, with ECS adapters | Keep service |
| Jobs | PStudioJobs cooperative queue | Jobs remain async infrastructure; ECS stores task state only where gameplay needs it | Keep service |
| Modules | PStudioModules registry | ModuleState mirror Components track registration, activation/deactivation, errors and enabled state; PStudioModules remains authoritative for dependencies, async hooks and rollback | Phase 13 implemented; ECS mirror is runtime-only |
| Assets/storage | PStudioAssetStore / IndexedDB | ECS stores stable asset IDs, never binary asset payloads | Keep service |
| Editor/Inspector | templates/index.html | Inspector reads/writes ECS definitions and selected-entity Components | Existing partial integration |
| Scene/project persistence | editor serializer and project backup | Versioned `ecsComponentsVersion` envelope, persistent-only Component serialization and v0 array/map migration; future schema versions are preserved and not overwritten | Phase 14 implemented for Component payloads; broader project migrations and legacy API retirement remain pending |

## Prioritized follow-up migration inventory

| Domain | Current ownership | ECS direction | Status |
|---|---|---|---|
| ps script global variables | Runtime `states` Map | Runtime-only `ScriptState.variables` Component per Scene Object | Phase 21 implemented |
| ps script lifecycle | Runtime `initialized` / `started` Sets and landing-sequence Map | Runtime-only `ScriptLifecycle` Component per Scene Object | Phase 21 implemented |
| ps ECS System locals | Runtime `ecsStates` Map keyed by System and Entity | Runtime-only `ScriptSystemState` Component keyed by System ID on each matching Entity | Phase 21 implemented |
| Simulation time | Runtime `timeScale` field and frame-clock calculation | Dedicated runtime-only `TimeState` Component; frame scheduling remains a service boundary | Pending Phase 22 |
| Legacy gameplay state | PStudioGameplay Maps retained as compatibility fallbacks | Remove only duplicate authoritative stores after API and lifecycle parity tests | Pending Phase 23 |
| Editor/runtime synchronization | Scene Object serialization adapters and ECS runtime Components | Audit deterministic ownership and eliminate redundant synchronization only where proven safe | Pending Phase 24 |
| Durable compatibility | Versioned ECS payload plus project backup importer | End-to-end old/new project, future-schema and backup round-trip validation | Pending Phase 25 |

## Safe implementation sequence

1. **Health** — move HP state into ECS, keep ps built-ins unchanged, snapshot state at Stop. (Phase 3 complete.)
2. **Inventory and equipment** — typed runtime Components store per-entity item counts and equipment slots. (Phase 4 implemented; static definitions moved to standalone ECS entities in Phase 15.)
3. **Combat and AI** — cooldown/combo data live in CombatState; AIController evaluates in postUpdate and MovementIntent resolves before Physics. Existing ps function names and synchronous AI result are preserved. (Phase 4 implemented.)
4. **Quests and dialogue** — QuestProgress and QuestDefinition use standalone ECS entities; DialogueSession holds conversation content/choice while PStudioUI owns presentation. (State Phase 4; definitions Phase 15.)
5. **Navigation** — move node/edge/blocking data and nearest/A* graph queries to ECS-owned NavigationNode Entities while keeping existing nav built-ins stable. (Phase 5 implemented.)
6. **Input** — introduce immutable per-frame InputSnapshot data and per-entity PlayerInput/ControlIntent Components; keep browser keyboard/touch listeners in the Input service. (Phase 6 implemented; existing ps input built-ins read the snapshot.)
7. **Collision Events** — preserve 2D/3D detection and Physics solver ownership; publish pair enter/stay/exit transitions as short-lived ECS CollisionEvent Entities and PStudioEvents notifications. (Phase 7 implemented.)
8. **Audio** — store per-entity AudioEmitter settings and queue AudioCommand requests through postUpdate; keep HTMLAudio instances, chunk pause/resume and resource cleanup in the Audio service. (Phase 8 implemented.)
9. **Rendering-facing Components** — expose Camera, Light, Renderable and Animation configuration as persistent Components; ECS Systems translate snapshots to existing renderer commands before Physics, while PStudio3D retains Three.js/GPU ownership. (Phase 9 implemented for camera, light, model/primitive and animation commands.)
10. **World streaming** — connect WorldPartition membership and multiple StreamingInterest points to the renderer's chunk manager. ECS owns serializable partition/interest configuration; PStudio3D retains async loading, activation, GPU resource leases and disposal. (Phase 10 implemented.)
11. **Visual effects configuration** — move environment, fog, water, post-FX, particle-emitter and trail configuration to persistent Components; keep shaders, GPU simulation, particle buffers, trail geometry and post-FX passes inside PStudio3D. One-shot particle bursts remain transient commands. (Phase 11 implemented.)
12. **HUD/UI state boundary** — move transient active inventory/quest/dialogue overlay intent to a UIOverlay singleton Component; PStudioUI remains the DOM renderer. (Phase 12 implemented.)
13. **Module lifecycle** — mirror module registration and state transitions into runtime-only ModuleState entities; PStudioModules retains dependency resolution, async activation/deactivation, rollback and service cleanup. (Phase 13 implemented.)
14. **Versioned Component persistence** — store persistent Components behind an explicit scene schema version, migrate unversioned v0 Component arrays/maps, preserve unknown future versions, and test round-trip/invalid data. (Phase 14 implemented.)
15. **Gameplay definition entities** — move Item/Quest/Weapon definition records into standalone ECS entities while keeping ps definition APIs compatible. (Phase 15 implemented.)
16. **Transform and Physics parity** — keep ECS Transform and PhysicsBody/State as runtime state, verify two-way editor synchronization and config changes, and retain Scene Object serialization and the fixed-step solver as service adapters. (Phase 16 implemented; adapters intentionally remain.)
17. **Gameplay state persistence integration** — write persistent per-Scene Object gameplay Components through the versioned serializer; retain QuestProgress/DialogueSession standalone Entities across Stop/Play; preserve unknown/future Component payloads; persist PlayerInput mapping configuration. (Phase 17 implemented.)
18. **Project backup ECS preservation** — reconstructing Scene Objects during backup import must preserve versioned, legacy and unknown-future ECS Component payloads rather than dropping them. (Phase 18 implemented.)
19. **Rendering authoring Components** — move Toon/NPR settings, per-GLB material overrides, custom shader source, model scale and mesh collider activation into persistent ECS Components; migrate legacy Scene Object fields once and keep GPU resources in renderer services. (Phase 19 implemented.)\n20. **Scene behavior and 2D presentation** — move ps script assignment, SpriteRenderer configuration, Collider2D activation, model asset references and editor manipulation settings into persistent ECS Components; preserve AST/asset/GPU/Canvas services. (Phase 20 implemented.)\n21. **ps Script Runtime State** — move per-Scene Object script variables, initialization/start lifecycle, per-Entity ps System locals and landing sequence state into runtime-only ECS Components. (Phase 21 implemented.)\n22. **TimeState** — move the simulation clock/time-scale state into a dedicated runtime-only ECS Component while preserving the existing timing semantics. (Pending.)\n23. **Gameplay Map compatibility cleanup** — parity-test legacy Scene Object/ps gameplay paths and remove duplicate fallback stores only after compatibility is proven. (Pending.)\n24. **Scene Object / ECS synchronization audit** — verify editor, preview, Play, Stop and object-destruction synchronization has one runtime source of truth. (Pending.)\n25. **Persistence compatibility audit** — test old projects, current schemas, unknown Components, future schemas and backup round-trips end-to-end. (Pending.)\n26. **Final migration audit and optimization** — remove proven redundant adapters and measure any remaining per-frame synchronization cost without reducing features. (Pending.)

## Required gates for every slice

- Fetch and review the complete current owning files before edits.
- Preserve existing public ps built-ins and return semantics unless a versioned change is explicitly intended.
- Add tests for old behavior, new ECS ownership, lifecycle cleanup, save/load and failure rollback.
- Do not create per-frame allocations/scans where a stable query or cached mapping is sufficient.
- Verify System phase/priority order and prevent duplicate writers to the same authoritative state.
- Run the full Python and JavaScript CI suites.
- Keep browser/WebGL/mobile-device validation as a separate gate; CI alone is not proof of rendering or touch correctness.
- Do not claim full migration while any domain in the inventory remains pending.
