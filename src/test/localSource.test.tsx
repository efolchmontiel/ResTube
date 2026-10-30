import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import { CATALOG_FIXTURE, installCatalogFetch } from './catalog';
import { FILE_VALIDATION_MESSAGE, MODEL_VALIDATION_MESSAGE } from '../state/studioState';

const LOCAL_RESULT = {
  video: { source: 'local', id: '0f1e2d3c4b5a697887796a5b4c3d2e1f', url: null, title: 'clip.mp4', author: 'Archivo local', duration: 90, language: 'es' },
  model: { provider: CATALOG_FIXTURE[0].provider, id: CATALOG_FIXTURE[0].id, name: CATALOG_FIXTURE[0].name },
  summary: {
    takeaways: [{ num: '01', time: '00:05', heading: 'Hallazgo local', text: 'Contenido transcrito.' }],
    deepdive: { heading: 'Análisis local', tone: 'accent', paragraphs: ['Detalle.'] },
    actions: { heading: 'Pasos', tone: 'blue', items: ['Paso.'] },
    quote: null,
  },
};
const localResponse = (overrides: object = {}) => ({ ok: true, json: async () => ({ ...LOCAL_RESULT, ...overrides }) });

const objectUrlState: { created: string[]; revoked: string[]; counter: number } = { created: [], revoked: [], counter: 0 };
function installBlobMocks() {
  const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  beforeEach(() => {
    objectUrlState.counter = 0; objectUrlState.created = []; objectUrlState.revoked = [];
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => { const url = `blob:mock-${++objectUrlState.counter}`; objectUrlState.created.push(url); return url; }) });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn((url: string) => { objectUrlState.revoked.push(url); }) });
  });
  afterEach(() => {
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
    else delete (URL as unknown as Record<string, unknown>).createObjectURL;
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });
}
installBlobMocks();

function installLocalFetch(post: (init: RequestInit) => unknown) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => url === '/api/models'
    ? { ok: true, json: async () => ({ models: CATALOG_FIXTURE }) }
    : post(init!));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function startFileFlow(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.click(screen.getByRole('button', { name: 'Archivo local' }));
  await user.upload(screen.getByLabelText('Archivo de video local'), file);
  await user.click(screen.getByRole('button', { name: /Seleccionar modelo disponible/ }));
  await user.click(await screen.findByRole('option', { name: /mimo-demo-flash/ }));
  await user.click(screen.getByRole('button', { name: 'Procesar archivo' }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('sube el archivo binario con cabeceras fijas al endpoint local y renderiza el resultado', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' });
  const mock = installLocalFetch((init) => {
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toMatch(/^video\//);
    expect(headers.get('x-restube-provider')).toBe(CATALOG_FIXTURE[0].provider);
    expect(headers.get('x-restube-model')).toBe(CATALOG_FIXTURE[0].id);
    expect(headers.get('x-restube-filename')).toBe(encodeURIComponent('clip.mp4'));
    expect(init.body).toBe(file);
    return localResponse();
  });
  const user = userEvent.setup(); const { container } = render(<App />);
  await startFileFlow(user, file);
  expect(mock.mock.calls.find(([url]) => url === '/api/summarize-local')).toBeTruthy();
  expect((await screen.findAllByText('clip.mp4')).length).toBeGreaterThan(0);
  expect(screen.getByText('Archivo local', { selector: 'p' })).toBeInTheDocument();
  const player = container.querySelector('video');
  expect(player).not.toBeNull();
  expect(player).toHaveAttribute('src', 'blob:mock-1');
  expect(objectUrlState.created).toEqual(['blob:mock-1']);
});

it('la copia exporta el origen local real: nombre de archivo, sin blob URL ni ruta del servidor', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const file = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' });
  installLocalFetch(() => localResponse());
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<App />);
  await startFileFlow(user, file);
  await screen.findByText('Hallazgo local');
  await user.click(screen.getByRole('button', { name: /Copiar Resumen Completo/ }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const markdown = writeText.mock.calls[0][0] as string;
  expect(markdown).toContain('clip.mp4');
  expect(markdown).toContain('Archivo local');
  expect(markdown).not.toContain('blob:');
  expect(markdown).not.toContain('/api/');
});

it('revoca el blob URL al desmontar y al reemplazar el archivo', async () => {
  const file = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' });
  installLocalFetch(() => localResponse());
  const user = userEvent.setup(); const view = render(<App />);
  await startFileFlow(user, file);
  await screen.findByText('Hallazgo local');
  view.unmount();
  expect(objectUrlState.revoked).toEqual(['blob:mock-1']);
  const second = render(<App />);
  await user.click(screen.getByRole('button', { name: 'Archivo local' }));
  await user.upload(screen.getByLabelText('Archivo de video local'), new File([new Uint8Array([2])], 'otro.mp4', { type: 'video/mp4' }));
  expect(screen.queryAllByText('clip.mp4')).toHaveLength(0);
  second.unmount();
  expect(objectUrlState.revoked).toEqual(['blob:mock-1']);
});

it('refrescar vuelve a subir el archivo seleccionado al endpoint local', async () => {
  let calls = 0;
  const mock = installLocalFetch(() => localResponse(calls++ ? { summary: { ...LOCAL_RESULT.summary, takeaways: [{ ...LOCAL_RESULT.summary.takeaways[0], heading: 'Reprocesado' }] } } : {}));
  const file = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' });
  const user = userEvent.setup(); render(<App />);
  await startFileFlow(user, file);
  await screen.findAllByText('clip.mp4');
  await user.click(screen.getByRole('button', { name: /Actualizar resumen/ }));
  expect(await screen.findByText('Reprocesado')).toBeInTheDocument();
  expect(mock.mock.calls.filter(([url]) => url === '/api/summarize-local')).toHaveLength(2);
});

it('cambiar el archivo aborta el trabajo en vuelo y no publica la respuesta vieja', async () => {
  let signal: AbortSignal | undefined; let done!: (value: unknown) => void;
  installLocalFetch((init) => { signal = init.signal as AbortSignal; return new Promise((resolve) => { done = resolve; }); });
  const user = userEvent.setup(); render(<App />);
  await startFileFlow(user, new File([new Uint8Array([1])], 'uno.mp4', { type: 'video/mp4' }));
  expect(signal).toBeDefined();
  await user.upload(screen.getByLabelText('Archivo de video local'), new File([new Uint8Array([2])], 'dos.mp4', { type: 'video/mp4' }));
  expect(signal?.aborted).toBe(true);
  await act(async () => done(localResponse({ video: { ...LOCAL_RESULT.video, title: 'uno.mp4' } })));
  expect(screen.queryByText('uno.mp4')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Procesar archivo' })).toBeEnabled();
});

it('exige archivo y modelo antes de procesar, sin enviar peticiones locales', async () => {
  const mock = installLocalFetch(() => { throw new Error('no se esperaba ninguna petición'); });
  const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole('button', { name: 'Archivo local' }));
  await user.click(screen.getByRole('button', { name: 'Procesar archivo' }));
  expect(screen.getByText(FILE_VALIDATION_MESSAGE)).toBeInTheDocument();
  await user.upload(screen.getByLabelText('Archivo de video local'), new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' }));
  await user.click(screen.getByRole('button', { name: 'Procesar archivo' }));
  expect(screen.getAllByText(MODEL_VALIDATION_MESSAGE).length).toBeGreaterThan(0);
  expect(mock.mock.calls.filter(([url]) => url === '/api/summarize-local')).toHaveLength(0);
});

it('muestra errores locales saneados sin publicar contenido del servidor', async () => {
  installLocalFetch(() => ({ ok: false, json: async () => ({ code: 'FILE_LIMIT', error: 'PRIVATE server detail' }) }));
  const user = userEvent.setup(); render(<App />);
  await startFileFlow(user, new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' }));
  expect(await screen.findByText('El archivo supera el límite de 128 MiB para procesamiento local.')).toBeInTheDocument();
  expect(screen.queryByText('PRIVATE server detail')).not.toBeInTheDocument();
});
it('muestra el detalle curado local de MODEL_RESPONSE sin contenido crudo del servidor', async () => {
  const detail = 'El modelo devolvió un resumen con un formato inválido. Vuelve a procesar el video. (bloque de notas 2 de 3: la respuesta no cumplió la validación de la etapa. Se esperaban entre 1 y 12 notas y la respuesta no fue una lista.)';
  installLocalFetch(() => ({ ok: false, json: async () => ({ code: 'MODEL_RESPONSE', error: detail }) }));
  const user = userEvent.setup(); render(<App />);
  await startFileFlow(user, new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' }));
  expect(await screen.findByText(detail)).toBeInTheDocument();
});

it('cambiar entre enlace y archivo no reutiliza el input: sin aviso controlado→no controlado', async () => {
  installCatalogFetch();
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const user = userEvent.setup(); render(<App />);
  await user.type(screen.getByLabelText('URL del video'), 'https://youtu.be/abcdefghijk');
  await user.click(screen.getByRole('button', { name: 'Archivo local' }));
  expect(screen.getByLabelText('Archivo de video local')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Enlace de YouTube' }));
  expect(screen.getByLabelText('URL del video')).toBeInTheDocument();
  const warning = errorSpy.mock.calls.find(([first]) => typeof first === 'string' && /controlled input|uncontrolled/i.test(first));
  expect(warning).toBeUndefined();
  errorSpy.mockRestore();
});
