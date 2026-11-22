/* PStudio ECS Inspector 1.0.0
 * Editor-side Entity/Component/System inspection.
 * Scene Objects remain the serialized project source of truth.
 */
(() => {
  'use strict';

  const CORE_COMPONENTS = new Set(['Transform', 'SceneObjectRef']);
  const STYLE_ID = 'pstudio-ecs-inspector-style';
  let activeEntityId = null;
  let wrappedSelect = false;
  let definitionRefreshPromise = null;
  const projectComponentDefinitions = new Map();
  const projectSystemDefinitions = new Map();

  const byId = id => document.getElementById(id);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };

  function ensureStyles() {
    if (byId(STYLE_ID)) return;
    const style = make('style');
    style.id = STYLE_ID;
    style.textContent = `
      .ecs-inspector{min-width:275px;flex:0 0 275px;padding:13px;border:1px solid var(--line);border-radius:8px;background:#151b23;margin:12px 0}
      .ecs-schema-form{display:grid;gap:7px}
      .ecs-schema-field{display:grid;gap:3px;color:var(--muted);font-size:10px}
      .ecs-schema-label{font-weight:700;color:#c8d2df}
      .ecs-schema-field input,.ecs-schema-field select,.ecs-schema-field textarea{min-width:0;width:100%;background:#10151c;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:6px;font-size:11px}
      .ecs-schema-field input[type=checkbox]{width:auto;accent-color:#d1d5db}
      .ecs-inline-status{color:var(--subtle);font-size:9px;line-height:1.5}
      .ecs-inspector-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
      .ecs-inspector-title{font-size:11px;font-weight:850;letter-spacing:.08em;color:#d7e0eb}
      .ecs-muted{color:var(--subtle);font-size:10px}
      .ecs-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:8px 0 11px}
      .ecs-stat{padding:7px 5px;border:1px solid var(--line);border-radius:6px;background:#10151c;text-align:center}
      .ecs-stat strong{display:block;font-size:15px;color:#f1f5f9}
      .ecs-stat span{font-size:9px;color:var(--subtle);letter-spacing:.04em}
      .ecs-row{display:flex;align-items:center;gap:6px;margin:7px 0}
      .ecs-row select,.ecs-row input,.ecs-component-editor{min-width:0;width:100%;background:#10151c;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:7px;font-size:11px}
      .ecs-row button,.ecs-component-head button,.ecs-system-row button{flex:0 0 auto;border:1px solid var(--line);background:#252e39;color:#e2eaf2;border-radius:5px;padding:6px 8px;font-size:10px}
      .ecs-row button:hover,.ecs-component-head button:hover,.ecs-system-row button:hover{background:#303d4c}
      .ecs-section-label{margin:13px 0 7px;font-size:10px;font-weight:800;color:#c8d2df;letter-spacing:.07em}
      .ecs-component-card,.ecs-system-card{padding:9px;margin:7px 0;border:1px solid var(--line);border-radius:6px;background:#10151c}
      .ecs-component-head,.ecs-system-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}
      .ecs-component-name{font:700 11px var(--mono);color:#e2eaf2;overflow-wrap:anywhere}
      .ecs-component-editor{display:block;min-height:78px;resize:vertical;font:10px/1.5 var(--mono);white-space:pre;tab-size:2}
      .ecs-component-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}
      .ecs-component-actions button{border:1px solid var(--line);border-radius:5px;background:#252e39;color:#e2eaf2;padding:5px 8px;font-size:10px}
      .ecs-component-actions .danger{color:#ff9da4}
      .ecs-system-description{font-size:9px;color:var(--subtle);line-height:1.5;overflow-wrap:anywhere;margin-bottom:7px}
      .ecs-system-row{display:flex;align-items:center;gap:7px}
      .ecs-system-row label{font-size:10px;color:var(--muted)}
      .ecs-system-row input[type=number]{width:64px;min-width:0;background:#10151c;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:5px;font-size:10px}
      .ecs-system-row input[type=checkbox]{accent-color:#d1d5db}
      .ecs-empty{padding:9px;border:1px dashed var(--line);border-radius:6px;color:var(--subtle);font-size:10px;line-height:1.6}
      .ecs-hint{font-size:9px;line-height:1.6;color:var(--subtle);margin-top:7px}
      .ecs-inline-status{font-size:10px;color:#9ca3af}
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    let panel = byId('ecs-inspector-section');
    if (panel) return panel;
    const anchor = byId('object-inspector');
    if (!anchor || !anchor.parentNode) return null;
    panel = make('section', 'inspector-section ecs-inspector');
    panel.id = 'ecs-inspector-section';
    const heading = make('div', 'ecs-inspector-heading');
    heading.appendChild(make('div', 'ecs-inspector-title', 'ENTITY COMPONENT SYSTEM'));
    heading.appendChild(make('div', 'ecs-muted', 'ECS'));
    panel.appendChild(heading);

    const stats = make('div', 'ecs-stats');
    for (const [id, label] of [['ecs-entity-count','ENTITIES'],['ecs-component-count','COMPONENTS'],['ecs-system-count','SYSTEMS']]) {
      const cell = make('div', 'ecs-stat');
      const value = make('strong', '', '0'); value.id = id;
      cell.append(value, make('span', '', label));
      stats.appendChild(cell);
    }
    panel.appendChild(stats);

    panel.appendChild(make('div', 'ecs-section-label', 'ENTITY'));
    const entityRow = make('div', 'ecs-row');
    const entitySelect = make('select'); entitySelect.id = 'ecs-entity-select';
    entitySelect.setAttribute('aria-label', 'Select ECS entity');
    entitySelect.addEventListener('change', () => selectEntity(Number(entitySelect.value)));
    const createButton = make('button', '', '+ Entity');
    createButton.type = 'button';
    createButton.title = 'Create a Scene Object backed by an ECS Entity';
    createButton.addEventListener('click', () => {
      if (window.PStudioEngine?.isRunning()) {
        notify('Stop the game before creating an Entity.');
        return;
      }
      if (typeof window.addSceneObject === 'function') window.addSceneObject();
      refresh();
    });
    entityRow.append(entitySelect, createButton);
    panel.appendChild(entityRow);

    const selectedInfo = make('div', 'ecs-muted', 'No Entity selected.');
    selectedInfo.id = 'ecs-selected-info';
    panel.appendChild(selectedInfo);

    panel.appendChild(make('div', 'ecs-section-label', 'COMPONENTS'));
    const componentHost = make('div');
    componentHost.id = 'ecs-component-list';
    panel.appendChild(componentHost);

    const addRow = make('div', 'ecs-row');
    const addSelect = make('select'); addSelect.id = 'ecs-add-component-type';
    addSelect.setAttribute('aria-label', 'Component type to add');
    const addButton = make('button', '', '＋ Add');
    addButton.type = 'button';
    addButton.addEventListener('click', addSelectedComponent);
    addRow.append(addSelect, addButton);
    panel.appendChild(addRow);

    const typeRow = make('div', 'ecs-row');
    const typeInput = make('input'); typeInput.id = 'ecs-new-component-type';
    typeInput.type = 'text'; typeInput.maxLength = 64;
    typeInput.placeholder = 'New component type (e.g. Velocity)';
    typeInput.autocomplete = 'off';
    const typeButton = make('button', '', 'Register');
    typeButton.type = 'button';
    typeButton.addEventListener('click', registerNewComponentType);
    typeRow.append(typeInput, typeButton);
    panel.appendChild(typeRow);
    const schemaEditor = make('textarea', 'ecs-component-editor');
    schemaEditor.id = 'ecs-new-component-schema';
    schemaEditor.rows = 4;
    schemaEditor.value = '{\n  "speed": { "type": "number", "default": 3, "min": 0 },\n  "active": { "type": "boolean", "default": true }\n}';
    schemaEditor.setAttribute('aria-label', 'New Component schema JSON');
    panel.appendChild(schemaEditor);
    const definitionsRow = make('div', 'ecs-row');
    const refreshDefinitions = make('button', '', 'Refresh .ps Definitions');
    refreshDefinitions.type = 'button';
    refreshDefinitions.addEventListener('click', () => refreshProjectDefinitions(false));
    definitionsRow.appendChild(refreshDefinitions);
    panel.appendChild(definitionsRow);
    const definitionsStatus = make('div', 'ecs-inline-status', 'No .ps definitions loaded.');
    definitionsStatus.id = 'ecs-definition-status';
    panel.appendChild(definitionsStatus);
    panel.appendChild(make('div', 'ecs-hint', 'Schema types: number, integer, boolean, string, enum, color, vector3, array, json, entity. Component data is checked when applied.'));

    panel.appendChild(make('div', 'ecs-section-label', 'SYSTEM SCHEDULER'));
    const systemHint = make('div', 'ecs-hint', 'Lower priority values execute first. Systems with equal priority keep their registration order.');
    panel.appendChild(systemHint);
    const systemsHost = make('div');
    systemsHost.id = 'ecs-system-list';
    panel.appendChild(systemsHost);
    anchor.insertAdjacentElement('afterend', panel);
    return panel;
  }

  function notify(message) {
    if (typeof window.toast === 'function') window.toast(message);
    else console.info('[PStudio ECS Inspector]', message);
  }

  function ecs() {
    return window.PStudioECS || null;
  }

  function sceneObjectForEntity(entityId) {
    const api = ecs();
    if (!api) return null;
    const ref = api.getComponent(entityId, 'SceneObjectRef');
    const objects = typeof sceneObjects !== 'undefined' ? sceneObjects : window.sceneObjects;
    if (!ref || !Array.isArray(objects)) return null;
    return objects.find(object => String(object.id) === String(ref.sceneObjectId)) || null;
  }

  function persistEntityComponents(entityId) {
    const api = ecs();
    if (!api) return;
    const object = sceneObjectForEntity(entityId);
    if (!object) return;
    const saved = [];
    for (const entry of api.getEntityComponents(entityId)) {
      if (CORE_COMPONENTS.has(entry.type) || entry.persistent === false) continue;
      try {
        const data = JSON.parse(JSON.stringify(entry.data));
        saved.push({ type: entry.type, data });
      } catch (error) {
        console.warn('[PStudio ECS Inspector] component is not JSON serializable:', entry.type, error);
      }
    }
    object.ecsComponents = saved;
    if (typeof window.persistProject === 'function') window.persistProject();
  }

  function syncSceneEntities() {
    const api = ecs();
    if (!api || typeof sceneObjects === 'undefined') return;
    api.syncSceneObjects(sceneObjects);
  }

  function selectEntity(entityId) {
    const api = ecs();
    if (!api) return;
    if (!api.getEntities(true).includes(entityId)) {
      activeEntityId = null;
      refresh();
      return;
    }
    activeEntityId = entityId;
    const ref = api.getComponent(entityId, 'SceneObjectRef');
    if (ref && typeof window.selectSceneObject === 'function') {
      const object = sceneObjectForEntity(entityId);
      const currentObject = typeof window.selectedObject === 'function' ? window.selectedObject() : null;
      if (object && String(currentObject?.id) !== String(object.id)) {
        window.selectSceneObject(object.id);
        return;
      }
    }
    refresh();
  }

  function addSelectedComponent() {
    const api = ecs();
    const entityId = activeEntityId;
    const select = byId('ecs-add-component-type');
    const type = select?.value || '';
    if (!api || !entityId || !type) return;
    try {
      api.addComponent(entityId, type);
      persistEntityComponents(entityId);
      refresh();
      notify('Component added: ' + type);
    } catch (error) {
      notify('Component add failed: ' + (error?.message || String(error)));
    }
  }

  function registerNewComponentType() {
    const api = ecs();
    const input = byId('ecs-new-component-type');
    const type = String(input?.value || '').trim();
    if (!api || !type) return;
    try {
      const rawSchema = String(byId('ecs-new-component-schema')?.value || '').trim();
      const schema = rawSchema ? JSON.parse(rawSchema) : null;
      if (schema !== null && (!schema || typeof schema !== 'object' || Array.isArray(schema))) {
        throw new Error('Component schema must be a JSON object.');
      }
      if (projectComponentDefinitions.has(type)) {
        throw new Error('This Component is defined in a .ps script. Edit the source definition instead.');
      }
      api.registerComponent(type, schema ? { schema, additionalProperties: false } : {});
      if (activeEntityId && api.getEntities(true).includes(activeEntityId)) {
        api.addComponent(activeEntityId, type);
        persistEntityComponents(activeEntityId);
      }
      if (input) input.value = '';
      refresh();
      notify('Component type registered: ' + type);
    } catch (error) {
      notify('Component registration failed: ' + (error?.message || String(error)));
    }
  }

  function saveComponent(entityId, type, editor) {
    const api = ecs();
    if (!api || !editor || api.getComponentDefinition?.(type)?.readonly) return;
    try {
      const data = JSON.parse(editor.value);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Component data must be a JSON object.');
      }
      api.setComponent(entityId, type, data);
      const object = sceneObjectForEntity(entityId);
      if (type === 'Transform' && object) api.applySceneObjectTransforms([object]);
      persistEntityComponents(entityId);
      if (typeof window.persistProject === 'function') window.persistProject();
      refresh();
      if (type === 'Transform' && object && typeof window.selectSceneObject === 'function') window.selectSceneObject(object.id);
      notify('Component updated: ' + type);
    } catch (error) {
      notify('Component update failed: ' + (error?.message || String(error)));
    }
  }

  function removeSelectedComponent(entityId, type) {
    const api = ecs();
    if (!api || CORE_COMPONENTS.has(type)) return;
    try {
      if (!api.removeComponent(entityId, type)) return;
      persistEntityComponents(entityId);
      refresh();
      notify('Component removed: ' + type);
    } catch (error) {
      notify('Component removal failed: ' + (error?.message || String(error)));
    }
  }

  function createSchemaControl(fieldName, field, value) {
    const wrap = make('label', 'ecs-schema-field');
    wrap.appendChild(make('span', 'ecs-schema-label', field.label || fieldName));
    let input;
    if (field.type === 'boolean') {
      input = make('input');
      input.type = 'checkbox';
      input.checked = value === true;
    } else if (field.type === 'enum') {
      input = make('select');
      (field.options || []).forEach((optionValue, index) => {
        const option = make('option', '', String(optionValue));
        option.value = String(index);
        input.appendChild(option);
      });
      const index = (field.options || []).findIndex(optionValue => Object.is(optionValue, value));
      input.value = String(Math.max(0, index));
    } else if (['number', 'integer', 'entity'].includes(field.type)) {
      input = make('input');
      input.type = 'number';
      input.value = value === null || value === undefined ? '' : String(value);
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      input.step = String(field.step || (field.type === 'integer' || field.type === 'entity' ? 1 : 'any'));
    } else if (field.type === 'color') {
      input = make('input');
      input.type = 'color';
      input.value = /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : '#ffffff';
    } else if (field.type === 'string') {
      input = make('input');
      input.type = 'text';
      input.value = value === undefined || value === null ? '' : String(value);
      if (field.maxLength !== undefined) input.maxLength = field.maxLength;
    } else {
      input = make('textarea', 'ecs-component-editor');
      input.rows = 3;
      try { input.value = JSON.stringify(value === undefined ? (field.default ?? null) : value, null, 2); }
      catch (_) { input.value = 'null'; input.readOnly = true; }
    }
    input.dataset.ecsField = fieldName;
    if (field.description) input.title = field.description;
    wrap.appendChild(input);
    return { wrap, input, field };
  }

  function readSchemaValue(fieldName, field, input) {
    if (field.type === 'boolean') return !!input.checked;
    if (field.type === 'enum') {
      const index = Number(input.value);
      return field.options[index];
    }
    if (['number', 'integer', 'entity'].includes(field.type)) {
      if (field.type === 'entity' && input.value.trim() === '') return null;
      const value = Number(input.value);
      if (!Number.isFinite(value)) throw new Error('"' + fieldName + '" must be a finite number.');
      return field.type === 'integer' || field.type === 'entity' ? Math.trunc(value) : value;
    }
    if (['json', 'array', 'vector3'].includes(field.type)) {
      let value;
      try { value = JSON.parse(input.value); }
      catch (_) { throw new Error('"' + fieldName + '" contains invalid JSON.'); }
      if (field.type === 'array' && !Array.isArray(value)) throw new Error('"' + fieldName + '" must be an array.');
      if (field.type === 'vector3' && (!value || typeof value !== 'object' || Array.isArray(value) ||
          !['x','y','z'].every(key => Number.isFinite(Number(value[key]))))) {
        throw new Error('"' + fieldName + '" must be a Vector3 JSON object with x/y/z numbers.');
      }
      return value;
    }
    return String(input.value);
  }

  function applySchemaComponent(entityId, type, entry, controls) {
    const api = ecs();
    try {
      const data = { ...entry.data };
      for (const item of controls) data[item.fieldName] = readSchemaValue(item.fieldName, item.field, item.input);
      api.setComponent(entityId, type, data);
      const object = sceneObjectForEntity(entityId);
      if (type === 'Transform' && object) api.applySceneObjectTransforms([object]);
      persistEntityComponents(entityId);
      if (typeof window.persistProject === 'function') window.persistProject();
      refresh();
      if (type === 'Transform' && object && typeof window.selectSceneObject === 'function') window.selectSceneObject(object.id);
      notify('Component updated: ' + type);
    } catch (error) {
      notify('Component update failed: ' + (error?.message || String(error)));
    }
  }

  function renderComponents(entityId) {
    const api = ecs();
    const host = byId('ecs-component-list');
    if (!api || !host) return;
    host.replaceChildren();
    const entries = api.getEntityComponents(entityId);
    if (!entries.length) host.appendChild(make('div', 'ecs-empty', 'This Entity has no Components yet.'));
    for (const entry of entries) {
      const definition = api.getComponentDefinition?.(entry.type) || {};
      const card = make('div', 'ecs-component-card');
      const header = make('div', 'ecs-component-head');
      header.appendChild(make('div', 'ecs-component-name', definition.label || entry.type));
      const readonly = !!(entry.readonly || definition.readonly || entry.type === 'SceneObjectRef');
      if (readonly) header.appendChild(make('span', 'ecs-muted', 'READ ONLY'));
      else if (CORE_COMPONENTS.has(entry.type)) header.appendChild(make('span', 'ecs-muted', 'CORE'));
      else {
        const remove = make('button', '', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => removeSelectedComponent(entityId, entry.type));
        header.appendChild(remove);
      }
      card.appendChild(header);
      if (definition.description) card.appendChild(make('div', 'ecs-system-description', definition.description));

      const schema = definition.schema || entry.schema || null;
      if (schema && Object.keys(schema).length) {
        const form = make('div', 'ecs-schema-form');
        const controls = [];
        for (const [fieldName, field] of Object.entries(schema)) {
          const control = createSchemaControl(fieldName, field, entry.data[fieldName]);
          control.input.disabled = readonly;
          controls.push({ fieldName, ...control });
          form.appendChild(control.wrap);
        }
        card.appendChild(form);
        const actions = make('div', 'ecs-component-actions');
        const apply = make('button', '', 'Apply Values');
        apply.type = 'button';
        apply.disabled = readonly;
        apply.addEventListener('click', () => applySchemaComponent(entityId, entry.type, entry, controls));
        actions.appendChild(apply);
        card.appendChild(actions);
      } else {
        const editor = make('textarea', 'ecs-component-editor');
        editor.spellcheck = false;
        try { editor.value = JSON.stringify(entry.data, null, 2); }
        catch (_) { editor.value = '{\n  "error": "Component data is not JSON serializable"\n}'; editor.readOnly = true; }
        editor.readOnly = readonly || entry.type === 'SceneObjectRef';
        card.appendChild(editor);
        const actions = make('div', 'ecs-component-actions');
        const save = make('button', '', 'Apply JSON');
        save.type = 'button';
        save.disabled = editor.readOnly;
        save.addEventListener('click', () => saveComponent(entityId, entry.type, editor));
        actions.appendChild(save);
        card.appendChild(actions);
      }
      host.appendChild(card);
    }

    const currentTypes = new Set(entries.map(entry => entry.type));
    const addSelect = byId('ecs-add-component-type');
    if (addSelect) {
      addSelect.replaceChildren();
      const available = api.getComponentTypes().filter(type => {
        if (CORE_COMPONENTS.has(type) || currentTypes.has(type)) return false;
        const definition = api.getComponentDefinition?.(type);
        return definition && definition.persistent !== false && !definition.readonly && !definition.internal;
      });
      const placeholder = make('option', '', available.length ? 'Choose Component…' : 'No Component types available');
      placeholder.value = '';
      addSelect.appendChild(placeholder);
      for (const type of available) {
        const definition = api.getComponentDefinition?.(type);
        const option = make('option', '', (definition?.label || type) + (definition?.source ? ' · ps' : ''));
        option.value = type;
        addSelect.appendChild(option);
      }
      addSelect.disabled = !available.length || !entityId;
    }
  }

  function openSystemSource(filename) {
    if (!filename) return;
    if (typeof window.openProjectFile === 'function') window.openProjectFile(filename);
    if (typeof window.switchWorkspaceView === 'function') window.switchWorkspaceView('editor');
  }

  function renderSystems() {
    const api = ecs();
    const host = byId('ecs-system-list');
    if (!api || !host) return;
    host.replaceChildren();
    const systems = api.getSystems();
    if (!systems.length) host.appendChild(make('div', 'ecs-empty', 'No Systems are currently registered. Press Play to register .ps System declarations.'));
    for (const system of systems) {
      const card = make('div', 'ecs-system-card');
      const head = make('div', 'ecs-system-head');
      head.appendChild(make('div', 'ecs-component-name', system.name || system.id));
      const state = make('label', 'ecs-muted');
      const enabled = make('input');
      enabled.type = 'checkbox';
      enabled.checked = system.enabled;
      enabled.disabled = !!system.internal;
      enabled.addEventListener('change', () => {
        try { api.setSystemEnabled(system.id, enabled.checked); }
        catch (error) { notify(error?.message || String(error)); }
      });
      state.append(enabled, document.createTextNode(' Enabled'));
      head.appendChild(state);
      card.appendChild(head);
      card.appendChild(make('div', 'ecs-system-description',
        system.id + ' · Requires: ' + (system.components.length ? system.components.join(', ') : 'none') +
        (system.source ? ' · ' + system.source : '') + (system.internal ? ' · ENGINE' : '')));
      const row = make('div', 'ecs-system-row');
      row.appendChild(make('label', '', 'Priority'));
      const priority = make('input');
      priority.type = 'number';
      priority.step = '1';
      priority.value = String(system.priority);
      priority.disabled = !!system.internal;
      priority.setAttribute('aria-label', system.id + ' priority');
      priority.addEventListener('change', () => {
        try { api.setSystemPriority(system.id, priority.value); renderSystems(); }
        catch (error) { notify(error?.message || String(error)); priority.value = String(system.priority); }
      });
      row.appendChild(priority);
      row.appendChild(make('label', '', 'Phase'));
      const phase = make('select');
      for (const value of ['update', 'prePhysics', 'postUpdate', 'postPhysics']) {
        const option = make('option', '', value);
        option.value = value;
        phase.appendChild(option);
      }
      phase.value = system.phase || 'update';
      phase.disabled = !!system.internal;
      phase.addEventListener('change', () => {
        try { api.setSystemPhase(system.id, phase.value); renderSystems(); }
        catch (error) { notify(error?.message || String(error)); phase.value = system.phase || 'update'; }
      });
      row.appendChild(phase);
      card.appendChild(row);
      const actions = make('div', 'ecs-component-actions');
      if (system.source) {
        const open = make('button', '', 'Open .ps Source');
        open.type = 'button';
        open.addEventListener('click', () => openSystemSource(system.source));
        actions.appendChild(open);
      }
      if (!system.internal) {
        const remove = make('button', '', 'Unregister');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          try { api.unregisterSystem(system.id); refresh(); notify('System unregistered: ' + system.name); }
          catch (error) { notify(error?.message || String(error)); }
        });
        actions.appendChild(remove);
      }
      if (actions.childNodes.length) card.appendChild(actions);
      host.appendChild(card);
    }

    if (projectSystemDefinitions.size) {
      host.appendChild(make('div', 'ecs-section-label', 'DECLARED IN .PS'));
      for (const definition of projectSystemDefinitions.values()) {
        const card = make('div', 'ecs-system-card');
        card.appendChild(make('div', 'ecs-component-name', definition.name));
        card.appendChild(make('div', 'ecs-system-description',
          definition.filename + ' · Requires: ' + definition.components.join(', ') +
          (definition.registered ? ' · Registered while playing' : ' · Registers at Play')));
        const open = make('button', '', 'Open Source');
        open.type = 'button';
        open.addEventListener('click', () => openSystemSource(definition.filename));
        const actions = make('div', 'ecs-component-actions');
        actions.appendChild(open);
        card.appendChild(actions);
        host.appendChild(card);
      }
    }
  }

  function parsePsEcsLiteral(node) {
    if (!node || typeof node !== 'object') throw new Error('Invalid .ps ECS default value.');
    if (node.type === 'Literal') {
      const raw = String(node.value ?? '');
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      if (raw.startsWith('"')) return JSON.parse(raw);
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error('Invalid numeric Component default.');
      return number;
    }
    if (node.type === 'ArrayLiteral') return (node.elements || []).map(parsePsEcsLiteral);
    throw new Error('Component defaults must be literal values or literal arrays.');
  }

  function psFieldType(value, sourceNode) {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'array';
    const raw = String(sourceNode?.value ?? '');
    return Number.isInteger(value) && !/[.eE]/.test(raw) ? 'integer' : 'number';
  }

  async function refreshProjectDefinitions(quiet) {
    if (definitionRefreshPromise) return definitionRefreshPromise;
    definitionRefreshPromise = (async () => {
      const status = byId('ecs-definition-status');
      const scripts = {};
      if (typeof projectFiles !== 'undefined') {
        for (const [name, file] of Object.entries(projectFiles || {})) {
          if (file?.type === 'ps' && typeof file.content === 'string') scripts[name] = file.content;
        }
      }
      if (!Object.keys(scripts).length) {
        projectComponentDefinitions.clear();
        projectSystemDefinitions.clear();
        if (status) status.textContent = 'No .ps scripts found.';
        refresh();
        return false;
      }
      if (status) status.textContent = 'Validating .ps Component / System declarations…';
      try {
        const response = await fetch('/game/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scripts })
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || 'Could not validate game scripts.');
        const api = ecs();
        if (!api) throw new Error('ECS is unavailable.');
        projectComponentDefinitions.clear();
        projectSystemDefinitions.clear();

        for (const [filename, ast] of Object.entries(payload.scripts || {})) {
          for (const node of ast?.body || []) {
            if (node.type === 'ComponentDef') {
              const defaults = Object.create(null);
              const schema = Object.create(null);
              for (const field of node.body || []) {
                const value = parsePsEcsLiteral(field.value);
                defaults[field.variable] = value;
                schema[field.variable] = {
                  type: psFieldType(value, field.value),
                  default: value,
                  label: field.variable
                };
              }
              const name = String(node.name || '');
              projectComponentDefinitions.set(name, { name, filename, line: node.line || 1, defaults, schema });
              const existing = api.getComponentDefinition?.(name);
              if (!existing) {
                api.registerComponent(name, {
                  create: () => JSON.parse(JSON.stringify(defaults)),
                  schema,
                  additionalProperties: false,
                  source: filename,
                  category: 'ps',
                  description: 'Defined in ' + filename
                });
              } else if (existing.source === filename) {
                api.updateComponentDefinition(name, {
                  create: () => JSON.parse(JSON.stringify(defaults)),
                  schema,
                  additionalProperties: false,
                  source: filename,
                  category: 'ps',
                  description: 'Defined in ' + filename
                });
              } else {
                throw new Error('Component name is already used by another definition: ' + name);
              }
            } else if (node.type === 'SystemDef') {
              const name = String(node.name || '');
              const key = filename + '::' + name;
              projectSystemDefinitions.set(key, {
                name,
                filename,
                line: node.line || 1,
                components: (node.components || []).map(String),
                registered: false
              });
            }
          }
        }
        if (typeof sceneObjects !== 'undefined') api.syncSceneObjects(sceneObjects || []);
        const systems = api.getSystems();
        for (const definition of projectSystemDefinitions.values()) {
          definition.registered = systems.some(system => system.source === definition.filename && system.name === definition.name);
        }
        if (status) status.textContent =
          projectComponentDefinitions.size + ' Component definitions · ' +
          projectSystemDefinitions.size + ' System definitions loaded.';
        refresh();
        if (!quiet) notify('Loaded .ps ECS definitions.');
        return true;
      } catch (error) {
        if (status) status.textContent = 'Definition refresh failed: ' + (error?.message || String(error));
        if (!quiet) notify('ECS definition refresh failed: ' + (error?.message || String(error)));
        return false;
      } finally {
        definitionRefreshPromise = null;
      }
    })();
    return definitionRefreshPromise;
  }

  function refresh(selectedSceneObjectId) {
    const api = ecs();
    if (!api) return;
    ensureStyles();
    const panel = ensurePanel();
    if (!panel) return;
    try { syncSceneEntities(); }
    catch (error) {
      const host = byId('ecs-component-list');
      if (host) {
        host.replaceChildren(make('div', 'ecs-empty', 'ECS synchronization error: ' + (error?.message || String(error))));
      }
      return;
    }

    const ids = api.getEntities(true);
    const stats = api.stats();
    const entityCount = byId('ecs-entity-count');
    const componentCount = byId('ecs-component-count');
    const systemCount = byId('ecs-system-count');
    if (entityCount) entityCount.textContent = String(stats.entityCount);
    if (componentCount) componentCount.textContent = String(stats.componentTypeCount);
    if (systemCount) systemCount.textContent = String(stats.systemCount);

    const select = byId('ecs-entity-select');
    if (select) {
      select.replaceChildren();
      const placeholder = make('option', '', ids.length ? 'Select an Entity…' : 'No Entities');
      placeholder.value = '';
      select.appendChild(placeholder);
      for (const id of ids) {
        const ref = api.getComponent(id, 'SceneObjectRef');
        const object = ref && sceneObjectForEntity(id);
        const label = object ? object.name + ' · Entity ' + id : 'Entity ' + id;
        const option = make('option', '', label);
        option.value = String(id);
        select.appendChild(option);
      }
    }

    const selectedObject = typeof window.selectedObject === 'function' ? window.selectedObject() : null;
    const requestedMappedId = selectedSceneObjectId !== undefined && selectedSceneObjectId !== null
      ? api.getEntityForSceneObject(selectedSceneObjectId)
      : null;
    const selectedMappedId = selectedObject ? api.getEntityForSceneObject(selectedObject.id) : null;
    if (requestedMappedId) activeEntityId = requestedMappedId;
    else if (!activeEntityId || !ids.includes(activeEntityId)) activeEntityId = selectedMappedId || ids[0] || null;
    if (select) select.value = activeEntityId ? String(activeEntityId) : '';
    const currentSystems = api.getSystems();
    for (const definition of projectSystemDefinitions.values()) {
      definition.registered = currentSystems.some(system => system.source === definition.filename && system.name === definition.name);
    }
    const info = byId('ecs-selected-info');
    if (info) {
      const ref = activeEntityId ? api.getComponent(activeEntityId, 'SceneObjectRef') : null;
      const object = ref ? sceneObjectForEntity(activeEntityId) : null;
      info.textContent = activeEntityId
        ? (object ? 'Entity #' + activeEntityId + ' · Scene Object: ' + object.name : 'Entity #' + activeEntityId + ' · standalone')
        : 'No Entity selected.';
    }

    const host = byId('ecs-component-list');
    if (activeEntityId) renderComponents(activeEntityId);
    else {
      if (host) host.replaceChildren(make('div', 'ecs-empty', 'Create or select an Entity to manage its Components.'));
      const addSelect = byId('ecs-add-component-type');
      if (addSelect) addSelect.disabled = true;
    }
    renderSystems();
  }

  function installSelectionHook() {
    if (wrappedSelect || typeof window.selectSceneObject !== 'function') return;
    const original = window.selectSceneObject;
    const wrapped = function(id) {
      const result = original.apply(this, arguments);
      refresh(id);
      return result;
    };
    wrapped.__pstudioECSWrapped = true;
    window.selectSceneObject = wrapped;
    wrappedSelect = true;
  }

  window.PStudioECSInspector = { refresh, refreshProjectDefinitions };
  installSelectionHook();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      refresh();
      refreshProjectDefinitions(true);
    }, { once: true });
  } else {
    refresh();
    refreshProjectDefinitions(true);
  }
})();
