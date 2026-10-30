import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../App';
import { CATALOG_FIXTURE, SUMMARY_FIXTURE, installCatalogFetch, YOUTUBE_URL } from './catalog';
async function select(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Seleccionar modelo disponible/ })); await user.click(await screen.findByRole('option', { name: /mimo-demo-flash/ }));
}
async function reload(user: ReturnType<typeof userEvent.setup>) { await user.click(screen.getByRole('button', { name: /mimo-demo-flash/ })); await user.click(screen.getByRole('button', { name: 'Actualizar catálogo' })); }
describe('invalidación del catálogo conectado', () => {
  it('la recarga explícita usa la cabecera fija para saltear cache', async () => {
    const mock = installCatalogFetch(); const user = userEvent.setup(); render(<App />); await select(user); await reload(user);
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    expect(new Headers(mock.mock.calls[0][1]?.headers).get('x-restube-catalog')).toBeNull();
    expect(new Headers(mock.mock.calls[1][1]?.headers).get('x-restube-catalog')).toBe('refresh');
  });
  it('aborta y no publica respuestas tardías cuando desaparece el modelo', async () => {
    let count = 0; let done!: (v: unknown) => void; let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/models') return { ok: true, json: async () => ({ models: count++ ? CATALOG_FIXTURE.slice(1) : CATALOG_FIXTURE }) };
      signal = init!.signal as AbortSignal; return new Promise((r) => { done = r; });
    }));
    const user = userEvent.setup(); render(<App />); await select(user);
    await user.type(screen.getByLabelText('URL del video'), YOUTUBE_URL); await user.click(screen.getByRole('button', { name: /Procesar Video/ }));
    await reload(user); expect(await screen.findByText(/ya no está disponible/)).toBeInTheDocument(); expect(signal.aborted).toBe(true);
    await act(async () => done({ ok: true, json: async () => SUMMARY_FIXTURE }));
    expect(screen.queryByText('Hallazgo sintético')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /mimo-demo-flash/ })).not.toBeInTheDocument();
  });
  it('mantiene el resultado y selección si el modelo sigue en el catálogo', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/api/models' ? { models: CATALOG_FIXTURE } : SUMMARY_FIXTURE })));
    const user = userEvent.setup(); render(<App />); await select(user);
    await user.type(screen.getByLabelText('URL del video'), YOUTUBE_URL); await user.click(screen.getByRole('button', { name: /Procesar Video/ })); await screen.findByText('Hallazgo sintético');
    await reload(user); await screen.findByRole('option', { name: /mimo-demo-flash/ }); await user.keyboard('{Escape}');
    expect(screen.getByText('Hallazgo sintético')).toBeInTheDocument(); expect(screen.getByRole('button', { name: /mimo-demo-flash/ })).toBeInTheDocument();
  });
});
