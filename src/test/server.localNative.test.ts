// @vitest-environment node
// Integración con node:http real (ni EventEmitters ni mock de flujo): puertos efímeros
// de 127.0.0.1 únicamente; catálogo/transcriptor/inferencia inyectados, sin red externa.
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessageLike, type Server } from 'node:http';
// Buffer no está tipado sin @types/node: se usan Uint8Array puros.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSummarizeMiddleware, type SummaryRequest, type SummaryResponse } from '../../server/summarizeApi';
import { TRANSCRIBE_COMMAND, type LocalTranscription } from '../../server/localVideo';
import type { CommandRunner } from '../../server/processRunner';

const catalog = 'provider model context max-out thinking images\nfixture model-a 128K 8K no no\n';
const summary = { takeaways: [{ num: '01', time: '00:00', heading: 'Resultado', text: 'Texto fundamentado.' }], deepdive: { heading: 'Análisis', tone: 'accent', paragraphs: ['Contenido.'] }, actions: { heading: 'Pasos', tone: 'blue', items: ['Paso.'] }, quote: null };
const wrapperTranscription: LocalTranscription = { duration: 90, language: 'es', cues: [{ start: 0, text: 'Hola mundo' }] };

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(overrides: { uploadTimeoutMs?: number; hangCatalog?: { release: (value: string) => void } } = {}) {
  const capturedMedia: Uint8Array[] = [];
  let catalogCalls = 0;
  const runner = vi.fn<CommandRunner>(async (cmd) => {
    if (cmd.args.includes('--list-models')) {
      // Solo la primera consulta queda colgada (controlada por releaseCatalog).
      if (overrides.hangCatalog && catalogCalls++ === 0) return new Promise<string>((resolve) => { overrides.hangCatalog!.release = (value) => resolve(value); });
      return catalog;
    }
    if (cmd.file === TRANSCRIBE_COMMAND) {
      capturedMedia.push(new Uint8Array(await readFile(cmd.args[2])));
      return JSON.stringify(wrapperTranscription);
    }
    return JSON.stringify(summary);
  });
  const root = await mkdtemp(join(tmpdir(), 'restube-native-')); roots.push(root);
  const middleware = createSummarizeMiddleware({ runner, cooldownMs: 0, uploadTimeoutMs: overrides.uploadTimeoutMs, root });
  const server = createServer((req, res) => {
    middleware(req as SummaryRequest, res as SummaryResponse, () => {
      const fallback = res as { statusCode?: number; end(body?: string): void };
      fallback.statusCode = 404; fallback.end();
    });
  });
  server.on('clientError', (_error: unknown, socket: { destroy(): void }) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { server, root, runner, capturedMedia, releaseCatalog: (value: string) => overrides.hangCatalog?.release(value) };
}

interface NativeResult { status: number; body: string }
interface NativeOptions { contentLength?: number; write: Uint8Array[]; holdOpen?: boolean; headers?: Record<string, string> }
function post(server: Server, options: NativeOptions): { done: Promise<NativeResult>; raw: ReturnType<typeof httpRequest> } {
  const address = server.address() as { port: number };
  const req = httpRequest({
    host: '127.0.0.1', port: address.port, path: '/api/summarize-local', method: 'POST',
    headers: {
      origin: `http://127.0.0.1:${address.port}`,
      'content-type': 'video/mp4',
      'x-restube-provider': 'fixture', 'x-restube-model': 'model-a',
      'x-restube-filename': encodeURIComponent('clip.mp4'),
      ...(options.contentLength !== undefined ? { 'content-length': String(options.contentLength) } : {}),
      ...options.headers,
    },
  });
  const done = new Promise<NativeResult>((resolve) => {
    req.on('response', (res: IncomingMessageLike) => {
      let body = '';
      res.on('data', (chunk: Uint8Array) => { body += new TextDecoder().decode(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
  });
  req.on('error', () => { /* aborts del cliente: se comprueban los efectos en el servidor */ });
  for (const chunk of options.write) req.write(chunk);
  if (!options.holdOpen) req.end();
  return { done, raw: req };
}

async function pollUntil<T>(attempt: () => Promise<T>, predicate: (value: T) => boolean, tries = 500): Promise<T> {
  let value = await attempt();
  for (let i = 0; i < tries && !predicate(value); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await attempt();
  }
  return value;
}

it('acepta una subida nativa con Content-Length de 200 KiB y los bytes llegan intactos', async () => {
  const { server, runner, capturedMedia, root } = await setup();
  const payload = new Uint8Array(200 * 1024).fill(7);
  const result = await post(server, { contentLength: payload.length, write: [payload] }).done;
  expect(result.status).toBe(200);
  expect((JSON.parse(result.body) as { video: { title: string } }).video.title).toBe('clip.mp4');
  expect(capturedMedia[0]).toEqual(payload);
  expect(runner.mock.calls.filter(([cmd]) => cmd.file === TRANSCRIBE_COMMAND)).toHaveLength(1);
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
});

it('acepta una subida nativa chunked de 300 KiB sin Content-Length y los bytes llegan intactos', async () => {
  const { server, runner, capturedMedia, root } = await setup();
  const payload = new Uint8Array(300 * 1024).fill(9);
  const result = await post(server, { write: [payload.subarray(0, 100 * 1024), payload.subarray(100 * 1024, 200 * 1024), payload.subarray(200 * 1024)] }).done;
  expect(result.status).toBe(200);
  expect(capturedMedia[0]).toEqual(payload);
  expect(runner.mock.calls.filter(([cmd]) => cmd.file === TRANSCRIBE_COMMAND)).toHaveLength(1);
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
});

it('una desconexión tardía aborta sin transcriptor/modelo y deja el directorio limpio', async () => {
  const { server, runner, root } = await setup();
  const payload = new Uint8Array(200 * 1024).fill(1);
  const { raw } = post(server, { contentLength: payload.length, write: [payload.subarray(0, 50 * 1024)], holdOpen: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  raw.destroy();
  // La limpieza del directorio solo ocurre cuando el trabajo abortado terminó de deshacerse.
  await pollUntil(async () => readdir(join(root, '.tools', 'tmp')).catch(() => [] as string[]), (files) => files.length === 0);
  expect(runner.mock.calls.filter(([cmd]) => cmd.file === TRANSCRIBE_COMMAND)).toHaveLength(0);
  expect(runner.mock.calls.filter(([cmd]) => cmd.input)).toHaveLength(0);
  const retry = await pollUntil(async () => post(server, { contentLength: 4, write: [new Uint8Array([1, 2, 3, 4])] }).done, (r) => r.status === 200);
  expect(retry.status).toBe(200);
});

it('el plazo propio de subida responde 504 antes del plazo total, mantiene 429 durante la limpieza y no transcribe', async () => {
  const { server, runner, releaseCatalog, root } = await setup({ uploadTimeoutMs: 200, hangCatalog: { release: () => {} } });
  const payload = new Uint8Array(200 * 1024).fill(3);
  const first = post(server, { contentLength: payload.length, write: [payload.subarray(0, 50 * 1024)], holdOpen: true });
  // El plazo de subida (200 ms) vence mientras el catálogo sigue pendiente: el trabajo no termina.
  await new Promise((resolve) => setTimeout(resolve, 350));
  const duringCleanup = await post(server, { contentLength: 4, write: [new Uint8Array([1, 2, 3, 4])] }).done;
  expect(duringCleanup.status).toBe(429);
  expect(runner.mock.calls.filter(([cmd]) => cmd.file === TRANSCRIBE_COMMAND)).toHaveLength(0);
  releaseCatalog(catalog);
  const timeoutResponse = await Promise.race([first.done, new Promise<NativeResult>((_, reject) => setTimeout(() => reject(new Error('504 no llegó a tiempo')), 5_000))]);
  expect(timeoutResponse.status).toBe(504);
  expect(JSON.parse(timeoutResponse.body).code).toBe('TIMEOUT');
  first.raw.destroy();
  await pollUntil(async () => readdir(join(root, '.tools', 'tmp')).catch(() => [] as string[]), (files) => files.length === 0);
  const after = await pollUntil(async () => post(server, { contentLength: 4, write: [new Uint8Array([1, 2, 3, 4])] }).done, (r) => r.status === 200);
  expect(after.status).toBe(200);
});
