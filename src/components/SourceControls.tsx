import { Fragment } from 'react';
import type { StudioState } from '../state/studioState';
import { AlertIcon, FolderIcon, LinkIcon, PlayIcon, YoutubeIcon } from './icons';
interface Props {
  state: StudioState;
  onSourceMode: (mode: 'url' | 'file') => void;
  onUrl: (url: string) => void;
  onFile: (file: File | null) => void;
  onRun: () => void;
}
export function SourceControls({ state, onSourceMode, onUrl, onFile, onRun }: Props) {
  const busy = !!state.inFlight;
  return <>
    <div className="source-mode-row" role="group" aria-label="Origen del video">
      {([['url', 'Enlace de YouTube', LinkIcon], ['file', 'Archivo local', FolderIcon]] as const).map(([mode, label, Icon]) =>
        <button key={mode} type="button" className={`source-mode-btn${state.sourceMode === mode ? ' is-active' : ''}`} aria-pressed={state.sourceMode === mode} onClick={() => onSourceMode(mode)}><Icon /><span>{label}</span></button>)}
    </div>
    {/* Claves por fuente: un cambio de modo remonta el input y nunca arrastra su estado controlado. */}
    {state.sourceMode === 'url' ? <Fragment key="source-url">
      <div className="input-box">
        <div className="url-source-group"><div className="input-yt-icon"><YoutubeIcon /></div>
          <input type="url" className="main-url-input" value={state.url} onChange={(e) => onUrl(e.target.value)} placeholder="Pega el enlace de un video de YouTube" aria-label="URL del video" />
        </div>
        <button type="button" className="btn-submit-main" onClick={onRun} aria-busy={busy} disabled={busy || state.catalog !== 'ready'}><PlayIcon /><span>{busy ? 'Procesando…' : 'Procesar Video'}</span></button>
      </div>
    </Fragment> : <Fragment key="source-file">
      <div className="input-box file-input-box">
        <div className="file-source-group">
          <label className="file-label" htmlFor="local-video-input">Elegir archivo de video</label>
          <input id="local-video-input" type="file" accept="video/*" className="file-input" aria-label="Archivo de video local"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
          <span className="file-selected-name" aria-live="polite">{state.file ? state.file.name : 'Ningún archivo seleccionado'}</span>
        </div>
        <button type="button" className="btn-submit-main" onClick={onRun} aria-busy={busy} disabled={busy || state.catalog !== 'ready'}><PlayIcon /><span>{busy ? 'Procesando…' : 'Procesar archivo'}</span></button>
      </div>
    </Fragment>}
    {state.sourceError && <div className="validation-msg source-validation-msg" role="alert"><AlertIcon /><span>{state.sourceError}</span></div>}
    {state.processingError && <div className="validation-msg source-validation-msg" role="alert"><AlertIcon /><span>{state.processingError}</span></div>}
  </>;
}
