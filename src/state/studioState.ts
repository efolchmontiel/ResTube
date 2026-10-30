import type { ModelKey, RuntimeModel } from '../data/models';
import type { SummaryResult } from '../data/summary';
export type SourceMode = 'url' | 'file';
export type CatalogStatus = 'loading' | 'ready' | 'error';
export type TabKey = 'takeaways' | 'deepdive' | 'actions' | 'quotes';
export const TABS: { key: TabKey; label: string }[] = [
  { key: 'takeaways', label: 'Puntos Clave' }, { key: 'deepdive', label: 'Análisis en Profundidad' },
  { key: 'actions', label: 'Plan de Acción' }, { key: 'quotes', label: 'Citas Destacadas' },
];
export const MODEL_VALIDATION_MESSAGE = 'Debes seleccionar un modelo del catálogo para procesar el video.';
export const SOURCE_VALIDATION_MESSAGE = 'Debes indicar la URL de un video de YouTube antes de procesar.';
export const FILE_VALIDATION_MESSAGE = 'Debes seleccionar un archivo de video local antes de procesar.';
/** El File vive solo en memoria del navegador: nunca se persiste ni se envía su ruta. */
export interface LocalFile { name: string; size: number; lastModified: number; file: File }
export interface Flight { id: number; kind: 'process' | 'refresh'; modelKey: ModelKey; url?: string; file?: LocalFile; sourceKey: string }
export interface StudioState {
  sourceMode: SourceMode;
  url: string;
  file: LocalFile | null;
  model: ModelKey | null;
  catalog: CatalogStatus;
  catalogModels: RuntimeModel[];
  modelPickerOpen: boolean;
  modelError: boolean;
  sourceError: string | null;
  processingError: string | null;
  output: { sourceKey: string; modelKey: ModelKey; result: SummaryResult } | null;
  inFlight: Flight | null;
  requestId: number;
  activeTab: TabKey;
  focusModelTrigger: number;
  toast: { id: number; message: string } | null;
}
export function withToast(state: StudioState, patch: Partial<StudioState>, message: string | null): StudioState {
  return { ...state, ...patch, ...(message ? { toast: { id: (state.toast?.id ?? 0) + 1, message } } : {}) };
}
