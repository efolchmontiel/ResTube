import { useEffect, useMemo, useRef, useState } from 'react';
import { type ModelKey, findModel } from '../data/models';
import { MODEL_VALIDATION_MESSAGE, type StudioState } from '../state/studioState';
import { AlertIcon } from './icons';

interface ModelPickerProps {
  state: StudioState;
  onToggle: (open?: boolean) => void;
  onSelect: (modelKey: ModelKey) => void;
  onReloadCatalog: () => void;
}

export function ModelPicker({ state, onToggle, onSelect, onReloadCatalog }: ModelPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');

  const { catalog, catalogModels: models } = state;
  const hasModels = catalog === 'ready' && models.length > 0;

  // Enfoca el selector cuando una validación lo marca como error (focus request explícito).
  useEffect(() => {
    if (state.focusModelTrigger > 0) {
      triggerRef.current?.focus();
    }
  }, [state.focusModelTrigger]);

  // Cierra al hacer clic fuera del componente.
  useEffect(() => {
    if (!state.modelPickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        onToggle(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [state.modelPickerOpen, onToggle]);

  // El buscador recibe el foco al abrir el catálogo y se limpia al cerrarlo.
  useEffect(() => {
    if (state.modelPickerOpen && hasModels) {
      searchRef.current?.focus();
    }
    if (!state.modelPickerOpen) {
      setSearch('');
    }
  }, [state.modelPickerOpen, hasModels]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(query));
  }, [models, search]);

  const selected = findModel(models, state.model);

  const hint =
    catalog === 'loading'
      ? 'Cargando…'
      : catalog === 'error'
        ? 'Catálogo no disponible'
        : models.length === 0
          ? 'Sin modelos conectados'
          : `${models.length} modelos conectados`;

  return (
    <div className="model-picker-container">
      <div className="picker-label-row">
        <span className="picker-label" id="modelPickerLabel">
          <span>Modelo de análisis</span>
        </span>
        <span className={`required-tag${selected ? ' is-ready' : ''}`}>
          {selected ? '✓ Modelo listo' : '* Selección obligatoria'}
        </span>
      </div>

      <div className="custom-select-wrapper" ref={wrapperRef}>
        <button
          type="button"
          ref={triggerRef}
          className={`select-trigger${state.modelError ? ' has-error' : ''}${selected ? ' has-selection' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={state.modelPickerOpen}
          aria-invalid={state.modelError ? true : undefined}
          aria-describedby={state.modelError ? 'modelValidationMessage' : undefined}
          onClick={() => onToggle()}
        >
          <div className="trigger-left">
            <span className="trigger-text">
              {selected ? selected.name : 'Seleccionar modelo disponible en Gentle Shell (/model)...'}
            </span>
          </div>
          <span className="trigger-arrow" aria-hidden="true">
            ▼
          </span>
        </button>

        <div className="select-dropdown" hidden={!state.modelPickerOpen}>
          <div className="dropdown-header">
            <span className="cmd-badge">$ gentle-shell /model</span>
            <span className="header-actions">
              <span className="hint-badge">{hint}</span>
              <button
                type="button"
                className="picker-action-btn"
                onClick={onReloadCatalog}
                disabled={catalog === 'loading'}
                title="Vuelve a consultar el catálogo de modelos conectados"
              >
                Actualizar catálogo
              </button>
            </span>
          </div>

          {hasModels && (
            <div className="dropdown-search">
              <input
                ref={searchRef}
                type="search"
                role="searchbox"
                aria-label="Buscar modelo"
                placeholder="Buscar modelo"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          )}

          {catalog === 'loading' && (
            <p className="dropdown-status" role="status">
              Cargando catálogo de modelos conectados…
            </p>
          )}

          {catalog === 'error' && (
            <div className="dropdown-status is-error" role="alert">
              <p>No se pudo cargar el catálogo de modelos conectados.</p>
              <button type="button" className="picker-action-btn" onClick={onReloadCatalog}>
                Reintentar
              </button>
            </div>
          )}

          {catalog === 'ready' && models.length === 0 && (
            <div className="dropdown-status">
              <p>No hay modelos conectados disponibles en el catálogo.</p>
              <p className="dropdown-status-hint">Conecta un modelo en Gentle Shell y actualiza el catálogo.</p>
            </div>
          )}

          {hasModels && (
            <ul className="dropdown-options" role="listbox" aria-label="Modelos disponibles en Gentle Shell">
              {filtered.map((model) => {
                const key = `${model.provider}:${model.id}`;
                const isSelected = state.model === key;
                return (
                  <li
                    key={key}
                    role="option"
                    aria-selected={isSelected}
                    aria-label={model.name}
                    tabIndex={0}
                    className={`dropdown-item${isSelected ? ' is-selected' : ''}`}
                    onClick={() => onSelect(key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(key);
                      }
                    }}
                  >
                    <div className="item-top">
                      <span className="item-name">{model.name}</span>
                    </div>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="dropdown-status" role="presentation">
                  Sin resultados para la búsqueda.
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {/* Validación de modelo (mensaje exacto requerido) */}
      <div className="validation-msg" role="alert" id="modelValidationMessage" hidden={!state.modelError}>
        <AlertIcon />
        <span>{MODEL_VALIDATION_MESSAGE}</span>
      </div>
    </div>
  );
}
