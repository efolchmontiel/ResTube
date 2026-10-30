import { findModel, type ModelKey, type RuntimeModel } from '../data/models';
import type { SummaryResult } from '../data/summary';
import { FILE_VALIDATION_MESSAGE, MODEL_VALIDATION_MESSAGE, SOURCE_VALIDATION_MESSAGE, withToast, type StudioState, type TabKey, type SourceMode, type LocalFile } from './studioState';
export const initialState: StudioState = {
  sourceMode: 'url', url: '', file: null, model: null, catalog: 'loading', catalogModels: [], modelPickerOpen: false,
  modelError: false, sourceError: null, processingError: null, output: null, inFlight: null,
  requestId: 0, activeTab: 'takeaways', focusModelTrigger: 0, toast: null,
};
export type StudioAction =
  | { type: 'setSourceMode'; mode: SourceMode } | { type: 'setUrl'; url: string }
  | { type: 'setFile'; file: LocalFile | null }
  | { type: 'catalogStart' } | { type: 'catalogSuccess'; models: RuntimeModel[] } | { type: 'catalogError' }
  | { type: 'toggleModelPicker'; open?: boolean } | { type: 'selectModel'; modelKey: ModelKey }
  | { type: 'setTab'; tab: TabKey } | { type: 'processStart' } | { type: 'refreshStart' }
  | { type: 'flightSuccess'; id: number; result: SummaryResult } | { type: 'flightError'; id: number; message: string }
  | { type: 'clearToast' } | { type: 'showToast'; message: string };
function start(state: StudioState, kind: 'process' | 'refresh'): StudioState {
  if (state.inFlight || (kind === 'refresh' && !state.output)) return state;
  // Fuente anclada al momento de enviar: cambiarla después aborta y no publica respuesta vieja.
  const source = state.sourceMode === 'url'
    ? { url: state.url.trim(), file: undefined, sourceKey: `url:${state.url.trim()}`, empty: !state.url.trim(), message: SOURCE_VALIDATION_MESSAGE }
    : state.file
      ? { url: undefined, file: state.file, sourceKey: `file:${state.file.name}:${state.file.size}:${state.file.lastModified}`, empty: false, message: '' }
      : { url: undefined, file: undefined, sourceKey: '', empty: true, message: FILE_VALIDATION_MESSAGE };
  if (source.empty) return { ...state, sourceError: source.message };
  if (!findModel(state.catalogModels, state.model) || state.catalog !== 'ready') return withToast(state, { modelError: true, focusModelTrigger: state.focusModelTrigger + 1 }, MODEL_VALIDATION_MESSAGE);
  const id = state.requestId + 1;
  return { ...state, requestId: id, sourceError: null, processingError: null, modelError: false,
    inFlight: { id, kind, modelKey: state.model!, url: source.url, file: source.file, sourceKey: source.sourceKey } };
}
export function studioReducer(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'setSourceMode': return { ...state, sourceMode: action.mode, inFlight: null, output: null, processingError: null, sourceError: null };
    case 'setUrl': return { ...state, url: action.url, inFlight: null, output: null, processingError: null, sourceError: null };
    case 'setFile': return { ...state, file: action.file, inFlight: null, output: null, processingError: null, sourceError: null };
    case 'catalogStart': return { ...state, catalog: 'loading', inFlight: null, processingError: null };
    case 'catalogError': return { ...state, catalog: 'error', inFlight: null };
    case 'catalogSuccess': {
      const lost = state.model !== null && !findModel(action.models, state.model);
      return withToast(state, { catalog: 'ready', catalogModels: action.models, model: lost ? null : state.model,
        inFlight: null, output: state.output && findModel(action.models, state.output.modelKey) ? state.output : null }, lost ? 'El modelo seleccionado ya no está disponible en el catálogo.' : null);
    }
    case 'toggleModelPicker': return { ...state, modelPickerOpen: action.open ?? !state.modelPickerOpen };
    case 'selectModel': {
      const model = findModel(state.catalogModels, action.modelKey); if (!model || state.catalog !== 'ready') return state;
      return withToast(state, { model: action.modelKey, modelError: false, modelPickerOpen: false, inFlight: null, processingError: null },
        state.output && state.output.modelKey !== action.modelKey ? `Modelo cambiado a ${model.name}: pulsa "Actualizar resumen" para regenerarlo.` : null);
    }
    case 'setTab': return { ...state, activeTab: action.tab };
    case 'processStart': return start(state, 'process');
    case 'refreshStart': return start(state, 'refresh');
    case 'flightSuccess': {
      if (!state.inFlight || state.inFlight.id !== action.id) return state;
      return { ...state, output: { sourceKey: state.inFlight.sourceKey, modelKey: state.inFlight.modelKey, result: action.result },
        inFlight: null, processingError: null, activeTab: state.inFlight.kind === 'process' ? 'takeaways' : state.activeTab };
    }
    case 'flightError': return state.inFlight?.id === action.id ? { ...state, inFlight: null, processingError: action.message } : state;
    case 'clearToast': return { ...state, toast: null };
    case 'showToast': return withToast(state, {}, action.message);
    default: return state;
  }
}
