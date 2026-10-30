import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';
import { CATALOG_FIXTURE } from './catalog';

// Datos con varios puntos clave para probar la paginación del panel.
const TAKEAWAYS = Array.from({ length: 3 }, (_, i) => ({
  num: String(i + 1).padStart(2, '0'),
  time: `00:0${i + 1}`,
  heading: `Punto clave ${i + 1}`,
  text: `Contenido del punto ${i + 1}.`,
}));
const RESULT = {
  video: { source: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Título extraído', author: 'Canal real', duration: 120, language: 'es' },
  model: { provider: CATALOG_FIXTURE[0].provider, id: CATALOG_FIXTURE[0].id, name: CATALOG_FIXTURE[0].name },
  summary: {
    takeaways: TAKEAWAYS,
    deepdive: { heading: 'Análisis recibido', tone: 'accent', paragraphs: ['Detalle recibido.'] },
    actions: { heading: 'Pasos recibidos', tone: 'blue', items: ['Comprobar evidencia.'] },
    quote: { text: 'Texto literal', author: 'Canal real', tone: 'green' },
  },
};
function response(body: unknown, ok = true) { return { ok, json: async () => body }; }
function install(post: (init: RequestInit) => Promise<unknown> = async () => response(RESULT)) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => url === '/api/models' ? response({ models: CATALOG_FIXTURE }) : post(init!)));
}
async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('URL del video'), RESULT.video.url);
  await user.click(screen.getByRole('button', { name: /Seleccionar modelo disponible/i }));
  await user.click(await screen.findByRole('option', { name: /mimo-demo-flash/ }));
  await user.click(screen.getByRole('button', { name: /Procesar Video/i }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('muestra un punto clave por página con anterior/siguiente accesibles, extremos deshabilitados y posición', async () => {
  install(); const user = userEvent.setup(); render(<App />); await start(user);
  expect(await screen.findByText('Punto clave 1')).toBeInTheDocument();
  // Una tarjeta por página: el resto no está en el DOM de esta página.
  expect(screen.queryByText('Punto clave 2')).not.toBeInTheDocument();
  expect(screen.queryByText('Punto clave 3')).not.toBeInTheDocument();
  const prev = screen.getByRole('button', { name: 'Punto anterior' });
  const next = screen.getByRole('button', { name: 'Punto siguiente' });
  expect(prev).toBeDisabled();
  expect(next).toBeEnabled();
  expect(screen.getByText('Punto 1 de 3')).toBeInTheDocument();
  await user.click(next);
  expect(screen.getByText('Punto clave 2')).toBeInTheDocument();
  expect(screen.getByText('Punto 2 de 3')).toBeInTheDocument();
  expect(prev).toBeEnabled();
  await user.click(prev);
  expect(screen.getByText('Punto clave 1')).toBeInTheDocument();
  await user.click(next); await user.click(next);
  expect(screen.getByText('Punto clave 3')).toBeInTheDocument();
  expect(next).toBeDisabled();
});

it('la posición vuelve al primer punto cuando cambia el resultado y conserva la posición entre pestañas', async () => {
  let n = 0;
  install(async () => response(n++ ? { ...RESULT, summary: { ...RESULT.summary, takeaways: TAKEAWAYS.map((t, i) => ({ ...t, heading: `Renovado ${i + 1}` })) } } : RESULT));
  const user = userEvent.setup(); render(<App />); await start(user);
  expect(await screen.findByText('Punto clave 1')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Punto siguiente' }));
  expect(screen.getByText('Punto 2 de 3')).toBeInTheDocument();
  // Cambiar de pestaña y volver conserva la posición del mismo resultado.
  await user.click(screen.getByRole('tab', { name: 'Plan de Acción' }));
  expect(screen.getByText('Pasos recibidos')).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Puntos Clave' }));
  expect(screen.getByText('Punto 2 de 3')).toBeInTheDocument();
  // Nuevo resultado (refresh): la paginación se reinicia.
  await user.click(screen.getByRole('button', { name: /Actualizar resumen/ }));
  expect(await screen.findByText('Renovado 1')).toBeInTheDocument();
  expect(screen.getByText('Punto 1 de 3')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Punto anterior' })).toBeDisabled();
});

it('el botón de copiar conserva el resumen completo aunque la página visible sea una sola', async () => {
  install(); const user = userEvent.setup(); const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<App />); await start(user);
  expect(await screen.findByText('Punto clave 1')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Copiar Resumen Completo/ }));
  const markdown = (await waitFor(() => expect(writeText).toHaveBeenCalledOnce()), writeText.mock.calls[0][0] as string);
  for (const heading of ['Punto clave 1', 'Punto clave 2', 'Punto clave 3']) expect(markdown).toContain(heading);
});

it('cada pestaña conserva una región legible sin una parada de teclado para scroll interno', async () => {
  install(); const user = userEvent.setup(); render(<App />); await start(user);
  await screen.findByText('Punto clave 1');
  const region = screen.getByRole('region', { name: 'Contenido de Puntos Clave' });
  expect(region).not.toHaveAttribute('tabindex');
  await user.click(screen.getByRole('tab', { name: 'Plan de Acción' }));
  expect(screen.getByRole('region', { name: 'Contenido de Plan de Acción' })).not.toHaveAttribute('tabindex');
});

it('con un solo punto clave no hay flechas rotas: siguiente queda deshabilitado y la posición se muestra', async () => {
  install(async () => response({ ...RESULT, summary: { ...RESULT.summary, takeaways: [TAKEAWAYS[0]] } }));
  const user = userEvent.setup(); render(<App />); await start(user);
  expect(await screen.findByText('Punto clave 1')).toBeInTheDocument();
  expect(screen.getByText('Punto 1 de 1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Punto anterior' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Punto siguiente' })).toBeDisabled();
});
