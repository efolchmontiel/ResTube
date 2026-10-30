import { useCallback, useEffect, useReducer, useRef } from 'react';
import { findModel } from '../data/models';
import { fetchSummary, fetchLocalSummary, SummaryError, SUMMARY_ERRORS } from '../data/summary';
import { Header } from './Header';
import { ModelPicker } from './ModelPicker';
import { SourceControls } from './SourceControls';
import { SummaryWorkspace, Toast } from './SummaryWorkspace';
import { VideoPreview } from './VideoPreview';
import { fetchModelCatalog } from '../data/catalogApi';
import { initialState, studioReducer, type StudioAction } from '../state/studioReducer';

export default function StudioApp() {
  const [state, dispatch] = useReducer(studioReducer, initialState);

  const catalogVersion = useRef(0);
  // Solo la última carga de catálogo puede publicar resultados.
  const loadCatalog = useCallback((refresh: boolean) => {
    let cancelled = false;
    const version = ++catalogVersion.current;
    dispatch({ type: 'catalogStart' });
    fetchModelCatalog(fetch, { refresh })
      .then((models) => {
        if (!cancelled && version === catalogVersion.current) dispatch({ type: 'catalogSuccess', models });
      })
      .catch(() => {
        if (!cancelled && version === catalogVersion.current) dispatch({ type: 'catalogError' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => loadCatalog(false), [loadCatalog]);

  // Recarga explícita del usuario: saltea la cache corta del bridge.
  const reloadCatalog = useCallback(() => {
    loadCatalog(true);
  }, [loadCatalog]);

  useEffect(() => {
    const flight = state.inFlight;
    if (!flight) return;
    const model = findModel(state.catalogModels, flight.modelKey);
    if (!model) return;
    const controller = new AbortController();
    let current = true;
    const request = flight.file
      ? fetchLocalSummary({ file: flight.file.file, provider: model.provider, model: model.id, filename: flight.file.name }, controller.signal)
      : fetchSummary({ url: flight.url!, provider: model.provider, model: model.id }, controller.signal);
    request
      .then((result) => { if (current) dispatch({ type: 'flightSuccess', id: flight.id, result }); })
      .catch((error: unknown) => {
        if (current) dispatch({ type: 'flightError', id: flight.id, message: error instanceof SummaryError ? error.message : SUMMARY_ERRORS.NETWORK });
      });
    return () => { current = false; controller.abort(); };
  }, [state.inFlight, state.catalogModels]);

  // Auto-desestimación del toast (3.5 s)
  useEffect(() => {
    if (!state.toast) return;
    const timer = setTimeout(() => dispatch({ type: 'clearToast' }), 3500);
    return () => clearTimeout(timer);
  }, [state.toast]);

  const notify = (message: string) => {
    dispatch({ type: 'showToast', message });
  };

  return (
    <div className="studio-app">
      <Header />

      <section className="hero-container">
        <div className="hero-eyebrow">Síntesis de videos de YouTube y archivos locales</div>
        <h1 className="hero-title">Resúmenes de video con el modelo que elijas</h1>
        <p className="hero-sub">
          Resume los subtítulos de un video público o transcribe un archivo local en tu equipo con el modelo conectado que elijas.
        </p>

        <SourceControls
          state={state}
          onSourceMode={(mode) => dispatch({ type: 'setSourceMode', mode })}
          onUrl={(url) => dispatch({ type: 'setUrl', url })}
          onFile={(file) => dispatch({ type: 'setFile', file: file ? { name: file.name, size: file.size, lastModified: file.lastModified, file } : null })}
          onRun={() => dispatch({ type: 'processStart' })}
        />

        <ModelPicker
          state={state}
          onToggle={(open) => dispatch({ type: 'toggleModelPicker', open })}
          onSelect={(modelKey) => dispatch({ type: 'selectModel', modelKey })}
          onReloadCatalog={reloadCatalog}
        />
      </section>

      {state.inFlight && (
        <div className="processing-status" role="status" aria-label="Procesamiento del video" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          <div>
            <strong>{state.inFlight.kind === 'refresh' ? 'Actualizando el resumen…' : 'Procesando el video…'}</strong>
            <p>{state.inFlight.file ? 'Transcribiendo el audio en tu equipo y generando el resumen. Los archivos largos pueden tardar varios minutos.' : 'Obteniendo subtítulos y generando el resumen. Los videos largos se procesan por bloques y pueden tardar varios minutos.'}</p>
          </div>
        </div>
      )}

      <main className="workspace-area" aria-busy={!!state.inFlight}>
        <VideoPreview state={state} />
        <SummaryWorkspace
          state={state}
          onTab={(tab) => dispatch({ type: 'setTab', tab })}
          onRefresh={() => dispatch({ type: 'refreshStart' })}
          notify={notify}
        />
      </main>

      {state.toast && <Toast key={state.toast.id} message={state.toast.message} visible />}
    </div>
  );
}

export type { StudioAction };
