import { useEffect, useState } from 'react';
import { displayDuration } from '../data/summary';
import type { StudioState } from '../state/studioState';

export function VideoPreview({ state }: { state: StudioState }) {
  const result = state.output?.result;
  const video = result?.video;
  const seconds = video ? Math.floor(video.duration) : 0;
  const isLocal = video?.source === 'local';
  const blobUrl = useLocalBlobUrl(isLocal ? state.file : null);
  return <aside className="video-sidebar">
    <div className="video-player">
      {video && !isLocal ? <iframe title={`Reproducir ${video.title}`} src={`https://www.youtube-nocookie.com/embed/${video.id}`} allow="fullscreen; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
        : video && isLocal && blobUrl ? <video controls src={blobUrl} aria-label={`Reproducir ${video.title}`} /> : null}
      {!video && <p>El video aparecerá cuando se obtenga su transcripción.</p>}
    </div>
    <div className="video-details-card">
      <h2 className="vd-title">{video?.title ?? 'Sin video procesado'}</h2>
      <p className="vd-author">{video?.author ?? 'Introduce un enlace o elige un archivo local para comenzar.'}</p>
      {video && <div className="vd-stats-row">
        <div className="vd-stat"><dt>DURACIÓN</dt><dd>{displayDuration(seconds)}</dd></div>
        <div className="vd-stat"><dt>{isLocal ? 'TRANSCRIPCIÓN' : 'SUBTÍTULOS'}</dt><dd>{video.language}</dd></div>
        <div className="vd-stat"><dt>MODELO</dt><dd>{result.model.name}</dd></div>
      </div>}
    </div>
    <div className="gs-telemetry-card" role="status">
      {state.inFlight ? 'Transcribiendo y generando el resumen…' : state.processingError ? 'Procesamiento detenido. Revisa el mensaje de error.' : result ? `Resumen generado con ${result.model.name}.` : 'Esperando fuente y modelo.'}
      {state.output && state.model !== state.output.modelKey && <p>El resumen conserva el modelo anterior hasta que pulses «Actualizar resumen».</p>}
    </div>
  </aside>;
}

/** Blob URL del archivo seleccionado: se revoca al reemplazarlo o desmontar. Nunca rutas del servidor. */
function useLocalBlobUrl(file: { file: File } | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') return;
    const created = URL.createObjectURL(file.file);
    setUrl(created);
    return () => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [file]);
  return url;
}
