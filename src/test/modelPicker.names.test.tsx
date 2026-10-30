import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../components/ModelPicker';
import { type RuntimeModel } from '../data/models';
import { initialState } from '../state/studioReducer';
import { MODEL_VALIDATION_MESSAGE, type StudioState } from '../state/studioState';

const models: RuntimeModel[] = [
  { provider: 'nan', id: 'mimo-internal', name: 'MiMo', context: 'NaN', maxOutput: '8k', thinking: true, images: true },
  { provider: 'provider-a', id: 'shared-a', name: 'Modelo compartido', context: '128k', thinking: false, images: false },
  { provider: 'provider-b', id: 'shared-b', name: 'Modelo compartido', maxOutput: '32k' },
];

function setup(patch: Partial<StudioState> = {}) {
  const state: StudioState = {
    ...initialState,
    catalog: 'ready',
    catalogModels: models,
    model: null,
    modelPickerOpen: true,
    modelError: false,
    focusModelTrigger: 0,
    ...patch,
  };
  const callbacks = { onToggle: vi.fn(), onSelect: vi.fn(), onReloadCatalog: vi.fn() };
  const view = render(<ModelPicker state={state} {...callbacks} />);
  return {
    ...view,
    ...callbacks,
    update: (next: Partial<StudioState>) => view.rerender(<ModelPicker state={{ ...state, ...next }} {...callbacks} />),
  };
}

describe('ModelPicker — solo nombres de modelos', () => {
  it('muestra los nombres literales sin proveedores, grupos ni metadatos en el DOM', () => {
    const { container } = setup();
    expect(screen.getByText('MiMo', { exact: true })).toBeVisible();
    expect(screen.getAllByText('Modelo compartido', { exact: true })).toHaveLength(2);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'MiMo', 'Modelo compartido', 'Modelo compartido',
    ]);
    expect(container.querySelector('.dropdown-group, .item-provider, .item-meta, .meta-chip, .trigger-badge')).toBeNull();
    expect(container.textContent).not.toMatch(/nan|provider-a|provider-b|contexto|salida|razonamiento|imágenes|128k|32k|8k/i);
    expect(screen.getByRole('option', { name: 'MiMo' })).toBeVisible();
  });

  it('mantiene opciones homónimas separadas y selecciona cada clave canónica con clic y teclado', async () => {
    const user = userEvent.setup();
    const { onSelect, update } = setup({ model: 'provider-a:shared-a' });
    const options = screen.getAllByRole('option', { name: 'Modelo compartido' });
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
    await user.click(options[1]);
    expect(onSelect).toHaveBeenLastCalledWith('provider-b:shared-b');
    update({ model: 'provider-b:shared-b' });
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    options[0].focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('provider-a:shared-a');
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenLastCalledWith('provider-a:shared-a');
  });

  it('usa únicamente el nombre del modelo como nombre accesible del trigger seleccionado', async () => {
    const user = userEvent.setup();
    const { container, onToggle } = setup({ model: 'nan:mimo-internal', modelPickerOpen: false });
    const trigger = screen.getByRole('button', { name: 'MiMo' });
    expect(trigger).toHaveTextContent('MiMo');
    expect(container.querySelector('.trigger-badge')).toBeNull();
    await user.click(trigger);
    expect(onToggle).toHaveBeenCalledWith();
  });

  it.each([null, 'provider-a:missing', 'unknown:shared-a'])('no elige un modelo por defecto para %s', (model) => {
    const { onSelect } = setup({ model });
    expect(screen.getByRole('button', { name: /Seleccionar modelo disponible/ })).toBeVisible();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('busca por nombre, proveedor o id con una etiqueta neutral y conserva la recarga y el estado vacío', async () => {
    const user = userEvent.setup();
    const { onReloadCatalog, update } = setup();
    const search = screen.getByRole('searchbox', { name: 'Buscar modelo' });
    expect(search).toHaveAttribute('placeholder', 'Buscar modelo');
    expect(search).toHaveFocus();
    await user.type(search, 'MiMo');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.clear(search);
    await user.type(search, 'compartido');
    expect(screen.getAllByRole('option', { name: 'Modelo compartido' })).toHaveLength(2);
    await user.clear(search);
    await user.type(search, 'PROVIDER-B');
    expect(screen.getAllByRole('option', { name: 'Modelo compartido' })).toHaveLength(1);
    await user.clear(search);
    await user.type(search, 'shared-a');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.clear(search);
    await user.type(search, 'inexistente');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Sin resultados para la búsqueda.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Actualizar catálogo' }));
    expect(onReloadCatalog).toHaveBeenCalledOnce();
    update({ modelPickerOpen: false });
    update({ modelPickerOpen: true });
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('actualiza las opciones cuando cambia el catálogo dinámico', () => {
    const { update } = setup();
    update({ catalogModels: [{ provider: 'nuevo', id: 'otro-id', name: 'Otro modelo' }] });
    expect(screen.getByRole('option', { name: 'Otro modelo' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'MiMo' })).not.toBeInTheDocument();
  });

  it('conserva los estados de carga, error recuperable y catálogo vacío', async () => {
    const user = userEvent.setup();
    const { onReloadCatalog, update } = setup({ catalog: 'loading', catalogModels: [] });
    expect(screen.getByRole('status')).toHaveTextContent('Cargando catálogo');
    expect(screen.getByRole('button', { name: 'Actualizar catálogo' })).toBeDisabled();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    update({ catalog: 'error', catalogModels: [] });
    expect(screen.getByText('No se pudo cargar el catálogo de modelos conectados.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onReloadCatalog).toHaveBeenCalledOnce();
    update({ catalog: 'ready', catalogModels: [] });
    expect(screen.getByText('No hay modelos conectados disponibles en el catálogo.')).toBeVisible();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('conserva la validación y el foco solicitado en el trigger, Escape y clic fuera', async () => {
    const user = userEvent.setup();
    const { onToggle, update } = setup({ modelPickerOpen: false });
    update({ modelError: true, focusModelTrigger: 1 });
    const trigger = screen.getByRole('button', { name: /Seleccionar modelo disponible/ });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAccessibleDescription(MODEL_VALIDATION_MESSAGE);
    expect(screen.getByText(MODEL_VALIDATION_MESSAGE)).toBeVisible();
    update({ modelPickerOpen: true });
    await user.keyboard('{Escape}');
    expect(onToggle).toHaveBeenLastCalledWith(false);
    await user.click(document.body);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});
