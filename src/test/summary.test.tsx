import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';
import { CATALOG_FIXTURE } from './catalog';

const RESULT = {
  video: { source: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Título extraído', author: 'Canal real', duration: 120, language: 'es' },
  model: { provider: CATALOG_FIXTURE[0].provider, id: CATALOG_FIXTURE[0].id, name: CATALOG_FIXTURE[0].name },
  summary: {
    takeaways: [{ num: '01', time: '00:01', heading: 'Hallazgo recibido', text: 'Contenido devuelto por el servidor.' }],
    deepdive: { heading: 'Análisis recibido', tone: 'accent', paragraphs: ['Detalle recibido.'] },
    actions: { heading: 'Pasos recibidos', tone: 'blue', items: ['Comprobar evidencia.'] },
    quote: { text: 'Texto literal', author: 'Canal real', tone: 'green' },
  },
};
function response(body: unknown, ok = true) { return { ok, json: async () => body }; }
function install(post: (init: RequestInit) => Promise<unknown> = async () => response(RESULT)) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => url === '/api/models' ? response({ models: CATALOG_FIXTURE }) : post(init!));
  vi.stubGlobal('fetch', mock);
  return mock;
}
async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('URL del video'), RESULT.video.url);
  await user.click(screen.getByRole('button', { name: /Seleccionar modelo disponible/i }));
  await user.click(await screen.findByRole('option', { name: /mimo-demo-flash/ }));
  await user.click(screen.getByRole('button', { name: /Procesar Video/i }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('envía POST con el par exacto y renderiza el contenido y metadatos recibidos sin temporizador', async () => {
  const mock = install(); const user = userEvent.setup(); render(<App />); await start(user);
  expect(await screen.findByText('Hallazgo recibido')).toBeInTheDocument();
  expect(screen.getByText('Título extraído')).toBeInTheDocument();
  const call = mock.mock.calls.find(([url]) => url === '/api/summarize');
  expect(call?.[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
  expect(JSON.parse(call![1]!.body as string)).toEqual({ url: RESULT.video.url, provider: RESULT.model.provider, model: RESULT.model.id });
  for (const [tab, text] of [['Análisis en Profundidad', 'Análisis recibido'], ['Plan de Acción', 'Pasos recibidos'], ['Citas Destacadas', '"Texto literal"']]) {
    await user.click(screen.getByRole('tab', { name: tab })); expect(screen.getByText(text)).toBeInTheDocument();
  }
});
it.each([
  ['YOUTUBE_AUTH', 'YouTube rechazó el acceso a este contenido por autenticación. ResTube no inicia sesión ni usa cookies. Usa un video público accesible.'],
  ['YOUTUBE_BLOCKED', 'YouTube bloqueó el acceso automatizado al video o sus subtítulos. No necesitas iniciar sesión en ResTube.'],
  ['EXTRACTOR_MISSING', 'No está instalado el extractor local. Ejecuta pnpm run setup:yt-dlp en este proyecto.'],
])('muestra %s sin publicar contenido inventado', async (code, message) => {
  install(async () => response({ code, error: 'PRIVATE remote body' }, false));
  const user = userEvent.setup(); render(<App />); await start(user);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.queryByText('PRIVATE remote body')).not.toBeInTheDocument();
  expect(screen.queryByText('Hallazgos Principales')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Procesar Video/i })).toBeEnabled();
});
it('muestra el detalle curado de MODEL_RESPONSE en el banner de error, no contenido del servidor crudo', async () => {
  const detail = 'El modelo devolvió un resumen con un formato inválido. Vuelve a procesar el video. (bloque de notas 5 de 8: la respuesta no cumplió la validación de la etapa. Se esperaban entre 1 y 12 notas y la respuesta tuvo 13.)';
  install(async () => response({ code: 'MODEL_RESPONSE', error: detail }, false));
  const user = userEvent.setup(); render(<App />); await start(user);
  expect(await screen.findByText(detail)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Procesar Video/i })).toBeEnabled();
});
it('refresca con otro POST y copia las cuatro secciones del resultado fijado', async () => {
  let n = 0; install(async () => response(n++ ? { ...RESULT, summary: { ...RESULT.summary, takeaways: [{ ...RESULT.summary.takeaways[0], heading: 'Nuevo hallazgo' }] } } : RESULT));
  const user = userEvent.setup(); const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<App />); await start(user); await screen.findByText('Hallazgo recibido');
  await user.click(screen.getByRole('button', { name: /Actualizar resumen/ })); await screen.findByText('Nuevo hallazgo');
  await user.click(screen.getByRole('button', { name: /Copiar Resumen Completo/ }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  for (const text of ['Título extraído', 'Nuevo hallazgo', 'Análisis recibido', 'Pasos recibidos', 'Texto literal', RESULT.model.name]) expect(writeText.mock.calls[0][0]).toContain(text);
});
it('aborta al cambiar A→B→A y no acepta la respuesta vieja aunque ignore AbortSignal', async () => {
  let done!: (value: unknown) => void; let signal: AbortSignal | undefined;
  install(async (init) => { signal = init.signal as AbortSignal; return new Promise((resolve) => { done = resolve; }); });
  const user = userEvent.setup(); render(<App />); await start(user);
  await user.clear(screen.getByLabelText('URL del video')); await user.type(screen.getByLabelText('URL del video'), RESULT.video.url);
  expect(signal?.aborted).toBe(true);
  await act(async () => done(response(RESULT)));
  expect(screen.queryByText('Hallazgo recibido')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Procesar Video/i })).toBeEnabled();
});
it('cambiar modelo fija el resultado anterior hasta refrescar y aborta A→B→A en vuelo', async () => {
  let count = 0; let done!: (value: unknown) => void; let signal!: AbortSignal;
  install(async (init) => {
    if (count++ === 0) return response(RESULT);
    signal = init.signal as AbortSignal;
    return new Promise((resolve) => { done = resolve; });
  });
  const user = userEvent.setup(); const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<App />); await start(user); await screen.findByText('Hallazgo recibido');
  await user.click(screen.getByRole('button', { name: /mimo-demo-flash/ })); await user.click(await screen.findByRole('option', { name: /qwen-demo-6/ }));
  await user.click(screen.getByRole('button', { name: /Copiar Resumen Completo/ }));
  expect(writeText.mock.calls[0][0]).toContain(RESULT.model.name); expect(writeText.mock.calls[0][0]).not.toContain('qwen-demo-6');
  await user.click(screen.getByRole('button', { name: /Actualizar resumen/ })); expect(screen.getByText('Actualizando…')).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Procesamiento del video' })).toHaveTextContent('Actualizando el resumen…');
  await user.click(screen.getByRole('button', { name: /qwen-demo-6/ })); await user.click(await screen.findByRole('option', { name: /mimo-demo-flash/ }));
  await user.click(screen.getByRole('button', { name: /mimo-demo-flash/ })); await user.click(await screen.findByRole('option', { name: /qwen-demo-6/ }));
  expect(signal.aborted).toBe(true);
  await act(async () => done(response({ ...RESULT, model: { provider: CATALOG_FIXTURE[1].provider, id: CATALOG_FIXTURE[1].id, name: CATALOG_FIXTURE[1].name }, summary: { ...RESULT.summary, takeaways: [{ ...RESULT.summary.takeaways[0], heading: 'No publicar' }] } })));
  expect(screen.queryByText('No publicar')).not.toBeInTheDocument(); expect(screen.getByText('Hallazgo recibido')).toBeInTheDocument(); expect(screen.getByRole('button', { name: /Actualizar resumen/ })).toBeEnabled();
});
it('renderiza HTML ajeno como texto y descarta resultado al cambiar la fuente', async () => {
  install(async () => response({ ...RESULT, summary: { ...RESULT.summary, takeaways: [{ ...RESULT.summary.takeaways[0], text: '<img src=x onerror=alert(1)>' }] } }));
  const user = userEvent.setup(); const { container } = render(<App />); await start(user); await screen.findByText('<img src=x onerror=alert(1)>');
  expect(container.querySelector('img')).toBeNull();
  await user.clear(screen.getByLabelText('URL del video')); expect(screen.queryByText('Hallazgos Principales')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Actualizar resumen/ })).not.toBeInTheDocument();
});
it('no copia antes de obtener un resultado', async () => {
  install(); const user = userEvent.setup(); const writeText = vi.fn();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<App />); await user.click(screen.getByRole('button', { name: /Copiar Resumen Completo/ }));
  expect(await screen.findByText(/Primero selecciona un modelo y procesa el video/)).toBeInTheDocument(); expect(writeText).not.toHaveBeenCalled();
});
it('el fallback copia el resultado completo cuando execCommand devuelve true', async () => {
  install(); const user = userEvent.setup(); Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  document.execCommand = vi.fn().mockReturnValue(true);
  render(<App />); await start(user); await screen.findByText('Hallazgo recibido');
  await user.click(screen.getByRole('button', { name: /Copiar Resumen Completo/ }));
  expect(await screen.findByText('✓ ¡Resumen Completo Copiado!')).toBeInTheDocument(); expect(document.execCommand).toHaveBeenCalledWith('copy');
});
it('respeta false de execCommand y muestra fallo al copiar', async () => {
  install(); const user = userEvent.setup(); Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  document.execCommand = vi.fn().mockReturnValue(false);
  render(<App />); await start(user); await screen.findByText('Hallazgo recibido');
  await user.click(screen.getByRole('button', { name: /Copiar Resumen Completo/ }));
  expect(await screen.findByText(/No se pudo copiar/)).toBeInTheDocument();
});

it.each(['success', 'error', 'cancel'] as const)('mantiene spinner y estado accesible durante el proceso y limpia al finalizar: %s', async outcome => {
  let done!: (result: unknown) => void;
  let signal!: AbortSignal;
  install(async init => { signal = init.signal as AbortSignal; return new Promise(resolve => { done = resolve; }); });
  const user = userEvent.setup(); const { container } = render(<App />); await start(user);
  const status = screen.getByRole('status', { name: 'Procesamiento del video' });
  expect(status).toHaveTextContent('Procesando el video…');
  expect(status).toHaveTextContent('Los videos largos se procesan por bloques');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(container.querySelector('.loading-spinner')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Procesando…' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Procesando…' })).toBeDisabled();
  if (outcome === 'cancel') { await user.clear(screen.getByLabelText('URL del video')); expect(signal.aborted).toBe(true); }
  await act(async () => done(outcome === 'error' ? response({ code: 'MODEL_FAILED', error: 'private' }, false) : response(RESULT)));
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Procesamiento del video' })).not.toBeInTheDocument());
  expect(container.querySelector('.loading-spinner')).toBeNull();
  expect(screen.getByRole('button', { name: /Procesar Video/i })).toBeEnabled();
  if (outcome !== 'success') expect(screen.queryByText('Hallazgo recibido')).not.toBeInTheDocument();
});
