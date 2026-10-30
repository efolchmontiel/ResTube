import { useEffect, useRef, useState } from 'react';
import { type Tone } from '../data/models';
import { displayTime, type SummaryResult } from '../data/summary';
import { generateFullMarkdown } from '../state/markdown';
import { TABS, type StudioState, type TabKey } from '../state/studioState';
import { CheckIcon, CopyIcon, RefreshIcon } from './icons';

const CARD_TONE: Record<Tone, string> = {
  accent: 'card-heading-accent',
  blue: 'card-heading-blue',
  green: 'card-heading-green',
  yellow: 'card-heading-yellow',
};

const AUTHOR_TONE: Record<Tone, string> = {
  accent: 'quote-author-accent',
  blue: 'quote-author-blue',
  green: 'quote-author-green',
  yellow: 'quote-author-yellow',
};

interface SummaryWorkspaceProps {
  state: StudioState;
  onTab: (tab: TabKey) => void;
  onRefresh: () => void;
  notify: (message: string) => void;
}

export function SummaryWorkspace({ state, onTab, onRefresh, notify }: SummaryWorkspaceProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  // Paginación de puntos clave: estado puramente local del componente, una tarjeta por página.
  const [takeawayPage, setTakeawayPage] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasOutput = !!state.output;
  const busy = state.inFlight?.kind === 'refresh';
  const processing = state.inFlight?.kind === 'process';

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  // Cambia la identidad del resultado (proceso o refresh): la paginación vuelve al primer punto.
  // Cambiar de pestaña no altera state.output, así que la posición se conserva.
  useEffect(() => {
    setTakeawayPage(0);
  }, [state.output]);

  async function handleCopy() {
    if (!state.output) {
      notify('⚠ Primero selecciona un modelo y procesa el video para poder copiar el resumen.');
      return;
    }
    const markdown = generateFullMarkdown(state.output.result);
    let copied = false;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(markdown);
        copied = true;
      } catch {
        copied = false;
      }
    }

    if (!copied) {
      // Fallback para entornos con portapapeles restringido
      const textarea = document.createElement('textarea');
      textarea.value = markdown;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      document.body.removeChild(textarea);
    }

    setCopyState(copied ? 'copied' : 'error');
    if (copied) {
      notify('Resumen completo copiado en Markdown. Listo para pegar en Slack, Notion o cualquier app.');
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (!copied) notify('No se pudo copiar el resumen. Comprueba los permisos del portapapeles.');
    copyTimer.current = setTimeout(() => setCopyState('idle'), 2500);
  }

  const data = state.output?.result.summary ?? null;
  const takeaways = data?.takeaways ?? [];
  const takeawayCount = takeaways.length;
  // Ajuste defensivo si el arreglo cambia de tamaño sin cambiar de resultado.
  const page = Math.min(takeawayPage, Math.max(0, takeawayCount - 1));

  return (
    <section className="studio-main-panel">
      <div className="studio-tab-bar">
        <ul className="tab-list" role="tablist" aria-label="Secciones del resumen">
          {TABS.map((tab) => (
            <li key={tab.key}>
              <button
                type="button"
                role="tab"
                aria-selected={state.activeTab === tab.key}
                className={`tab-btn${state.activeTab === tab.key ? ' is-active' : ''}`}
                onClick={() => onTab(tab.key)}
              >
                {tab.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="tab-actions">
          {hasOutput && (
            <button
              type="button"
              className="action-icon-btn"
              onClick={onRefresh}
              disabled={busy || processing}
              title="Vuelve a generar el resumen con el modelo seleccionado"
            >
              <RefreshIcon />
              <span>{busy ? 'Actualizando…' : 'Actualizar resumen'}</span>
            </button>
          )}
          <button
            type="button"
            className={`action-icon-btn is-copy-full${copyState === 'copied' ? ' is-copied' : ''}`}
            onClick={handleCopy}
            disabled={busy}
            title="Copiar el resumen completo en formato Markdown para compartirlo en cualquier aplicación"
          >
            <CopyIcon />
            <span>
              {copyState === 'copied' ? '✓ ¡Resumen Completo Copiado!' : 'Copiar Resumen Completo'}
            </span>
          </button>
        </div>
      </div>

      <div className="studio-tab-body">
        <div className="empty-workspace-state" hidden={hasOutput}>
          <div className="empty-icon-wrap">
            <div className="empty-icon-badge">$ gentle-shell /model</div>
          </div>
          <h3 className="empty-title">Selecciona un modelo para iniciar el resumen</h3>
          <p className="empty-desc">
            Elige un modelo del <strong>catálogo conectado</strong> de Gentle Shell para resumir
            los subtítulos de un video público o la transcripción local de tu archivo. Si la fuente no está disponible, verás el motivo.
          </p>
          <div className="empty-steps">
            <span className="step-pill">1. Enlace o archivo local</span>
            <span className="step-arrow">→</span>
            <span className="step-pill is-highlight">2. Elegir modelo (/model)</span>
            <span className="step-arrow">→</span>
            <span className="step-pill">3. Procesar Video</span>
          </div>
        </div>

        {hasOutput && data && (
          <>
            {state.activeTab === 'takeaways' && (
              <div role="tabpanel" aria-label="Puntos Clave" className="studio-tabpanel">
                <div className="pane-header">
                  <h3 className="pane-title">Hallazgos Principales</h3>
                </div>
                <div className="panel-content" role="region" aria-label="Contenido de Puntos Clave">
                  <div className="takeaways-grid">
                    {takeawayCount > 0 && (() => {
                      const item = takeaways[page];
                      return (
                        <article key={item.num} className="takeaway-card">
                          <div className="takeaway-top">
                            <span className="takeaway-num">{item.num}</span>
                            <span className="takeaway-time">▶ {displayTime(item.time)}</span>
                          </div>
                          <h4 className="takeaway-heading">{item.heading}</h4>
                          <p className="takeaway-text">{item.text}</p>
                        </article>
                      );
                    })()}
                  </div>
                </div>
                <div className="takeaway-nav">
                  <button
                    type="button"
                    className="takeaway-nav-btn"
                    aria-label="Punto anterior"
                    title="Punto anterior"
                    disabled={page === 0}
                    onClick={() => setTakeawayPage(Math.max(0, page - 1))}
                  >
                    <ChevronLeftIcon />
                  </button>
                  <span className="takeaway-nav-pos">Punto {page + 1} de {takeawayCount}</span>
                  <button
                    type="button"
                    className="takeaway-nav-btn"
                    aria-label="Punto siguiente"
                    title="Punto siguiente"
                    disabled={page >= takeawayCount - 1}
                    onClick={() => setTakeawayPage(Math.min(takeawayCount - 1, page + 1))}
                  >
                    <ChevronRightIcon />
                  </button>
                </div>
              </div>
            )}

            {state.activeTab === 'deepdive' && (
              <div role="tabpanel" aria-label="Análisis en Profundidad" className="studio-tabpanel">
                <div className="pane-header">
                  <h3 className="pane-title">Análisis en Profundidad</h3>
                  <span className="pane-badge">Desglose Conceptual</span>
                </div>
                <div className="panel-content" role="region" aria-label="Contenido de Análisis en Profundidad">
                <article className="takeaway-card">
                  <h4 className={CARD_TONE[data.deepdive.tone]}>{data.deepdive.heading}</h4>
                  {data.deepdive.paragraphs.map((p, i) => (
                    <p key={i} className="card-paragraph">
                      {p}
                    </p>
                  ))}
                  {data.deepdive.code && (
                    <pre className="code-preview-box">{data.deepdive.code}</pre>
                  )}
                </article>
                </div>
              </div>
            )}

            {state.activeTab === 'actions' && (
              <div role="tabpanel" aria-label="Plan de Acción" className="studio-tabpanel">
                <div className="pane-header">
                  <h3 className="pane-title">Plan de Acción Sugerido</h3>
                  <span className="pane-badge">Implementación Práctica</span>
                </div>
                <div className="panel-content" role="region" aria-label="Contenido de Plan de Acción">
                <article className="takeaway-card">
                  <h4 className={CARD_TONE[data.actions.tone]}>{data.actions.heading}</h4>
                  {data.actions.items && (
                    <ul className="card-list">
                      {data.actions.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                  {data.actions.paragraph && <p className="card-paragraph">{data.actions.paragraph}</p>}
                </article>
                </div>
              </div>
            )}

            {state.activeTab === 'quotes' && (
              <div role="tabpanel" aria-label="Citas Destacadas" className="studio-tabpanel">
                <div className="pane-header">
                  <h3 className="pane-title">Citas Textuales Verificadas</h3>
                  <span className="pane-badge">Transcripción Validada</span>
                </div>
                <div className="panel-content" role="region" aria-label="Contenido de Citas Destacadas">
                {data.quote ? <article className="takeaway-card">
                  <p className="quote-text">"{data.quote.text}"</p>
                  <span className={`quote-author ${AUTHOR_TONE[data.quote.tone]}`}>
                    {data.quote.author}
                  </span>
                </article> : <p>No se incluyó una cita literal verificada.</p>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Flechas de paginación dibujadas en el mismo trazo que el resto de iconos del panel. */
function ChevronLeftIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>;
}
function ChevronRightIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>;
}

export function Toast({ message, visible }: { message: string; visible: boolean }) {
  return (
    <div className={`toast-notice${visible ? ' is-visible' : ''}`} role="status" aria-live="polite">
      {visible && <CheckIcon />}
      <span>{message}</span>
    </div>
  );
}
