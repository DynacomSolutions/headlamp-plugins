import { setPointer } from './pointer';
import { A2UI_VERSION, A2uiComponent, A2uiMessage, Surface, SurfaceState } from './types';

export function emptyState(): SurfaceState {
  return { surfaces: {}, warnings: [] };
}

function mergeComponents(
  existing: Record<string, A2uiComponent>,
  list: unknown
): Record<string, A2uiComponent> {
  const out = { ...existing };
  if (!Array.isArray(list)) return out;
  for (const c of list) {
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as A2uiComponent).id === 'string' &&
      typeof (c as A2uiComponent).component === 'string'
    ) {
      out[(c as A2uiComponent).id] = c as A2uiComponent;
    }
  }
  return out;
}

/** Applies one message and returns the new state. Messages with another version only add a warning. */
export function applyMessage(state: SurfaceState, msg: A2uiMessage): SurfaceState {
  if (!msg || typeof msg !== 'object')
    return { ...state, warnings: [...state.warnings, 'Ignored a malformed A2UI message'] };
  if (msg.version !== A2UI_VERSION) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `Ignored an A2UI message with unsupported version ${JSON.stringify(msg.version ?? null)}`,
      ],
    };
  }
  const surfaces = { ...state.surfaces };
  if (msg.createSurface && typeof msg.createSurface.surfaceId === 'string') {
    const c = msg.createSurface;
    surfaces[c.surfaceId] = {
      id: c.surfaceId,
      catalogId: c.catalogId,
      components: mergeComponents({}, c.components),
      dataModel: c.dataModel === undefined ? {} : c.dataModel,
    };
  } else if (msg.updateComponents && typeof msg.updateComponents.surfaceId === 'string') {
    const u = msg.updateComponents;
    const s = surfaces[u.surfaceId];
    if (!s)
      return {
        ...state,
        warnings: [...state.warnings, `updateComponents for unknown surface ${u.surfaceId}`],
      };
    surfaces[u.surfaceId] = { ...s, components: mergeComponents(s.components, u.components) };
  } else if (msg.updateDataModel && typeof msg.updateDataModel.surfaceId === 'string') {
    const u = msg.updateDataModel;
    const s = surfaces[u.surfaceId];
    if (!s)
      return {
        ...state,
        warnings: [...state.warnings, `updateDataModel for unknown surface ${u.surfaceId}`],
      };
    surfaces[u.surfaceId] = { ...s, dataModel: setPointer(s.dataModel, u.path ?? '/', u.value) };
  } else if (msg.deleteSurface && typeof msg.deleteSurface.surfaceId === 'string') {
    delete surfaces[msg.deleteSurface.surfaceId];
  } else {
    return { ...state, warnings: [...state.warnings, 'Ignored an A2UI message of unknown type'] };
  }
  return { ...state, surfaces };
}

export function processMessages(messages: unknown): SurfaceState {
  let state = emptyState();
  if (!Array.isArray(messages)) return state;
  for (const m of messages) state = applyMessage(state, m as A2uiMessage);
  return state;
}

export type { Surface };
