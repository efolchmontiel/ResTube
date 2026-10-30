import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { installCatalogFetch } from './catalog';
import { MODEL_VALIDATION_MESSAGE, SOURCE_VALIDATION_MESSAGE } from '../state/studioState';

describe('fuente y catálogo sin selección predeterminada', () => {
  it('no selecciona modelo por defecto y carga el catálogo conectado', async () => {
    const fetchMock = installCatalogFetch(); const user = userEvent.setup(); render(<App />);
    const trigger = screen.getByRole('button', { name: /Seleccionar modelo disponible/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false'); await user.click(trigger);
    expect(await screen.findByRole('option', { name: /mimo-demo-flash/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /qwen-demo-6/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /gpt-demo-4o/ })).toBeInTheDocument(); expect(fetchMock.mock.calls[0][0]).toBe('/api/models');
  });
  it.each([[{ ok: false, status: 500 }, /No se pudo cargar el catálogo/, 'Reintentar'], [{ body: { models: [] } }, /No hay modelos conectados disponibles/, 'Actualizar catálogo']] as const)('recupera catálogo fallido o vacío', async (spec, message, button) => {
    installCatalogFetch([spec, {}]); const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole('button', { name: /Seleccionar modelo disponible/ }));
    expect(await screen.findByText(message)).toBeInTheDocument(); expect(screen.queryByRole('option')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: button })); expect(await screen.findByRole('option', { name: /mimo-demo-flash/ })).toBeInTheDocument();
  });
  it('requiere fuente antes de enviar un trabajo', async () => {
    const mock = installCatalogFetch(); const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole('button', { name: /Seleccionar modelo disponible/ }));
    await user.click(await screen.findByRole('option', { name: /mimo-demo-flash/ }));
    await user.click(screen.getByRole('button', { name: /Procesar Video/ }));
    expect(screen.getByText(SOURCE_VALIDATION_MESSAGE)).toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(1);
  });
  it('requiere modelo, enfoca y limpia aria-invalid al seleccionarlo', async () => {
    installCatalogFetch(); const user = userEvent.setup(); render(<App />);
    await user.type(screen.getByLabelText('URL del video'), 'https://youtu.be/abcdefghijk');
    await user.click(screen.getByRole('button', { name: /Procesar Video/ }));
    const trigger = screen.getByRole('button', { name: /Seleccionar modelo disponible/ });
    expect(trigger).toHaveFocus(); expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAttribute('aria-describedby', 'modelValidationMessage');
    expect(screen.getAllByText(MODEL_VALIDATION_MESSAGE).length).toBeGreaterThan(0);
    await user.click(trigger); await user.click(await screen.findByRole('option', { name: /qwen-demo-6/ }));
    expect(screen.getByRole('button', { name: /qwen-demo-6/ })).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('Hallazgos Principales')).not.toBeInTheDocument();
  });
  it('filtra por identidad interna sin seleccionar un resultado automáticamente', async () => {
    installCatalogFetch(); const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole('button', { name: /Seleccionar modelo disponible/ })); await screen.findByRole('option', { name: /mimo-demo-flash/ });
    await user.type(screen.getByRole('searchbox', { name: /Buscar modelo/ }), 'openai');
    expect(screen.getByRole('option', { name: /gpt-demo-4o/ })).toBeInTheDocument(); expect(screen.queryByRole('option', { name: /mimo-demo-flash/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Seleccionar modelo disponible/ })).toBeInTheDocument();
  });
});
