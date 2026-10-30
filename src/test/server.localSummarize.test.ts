// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSummarizeMiddleware, type SummaryRequest, type SummaryResponse } from '../../server/summarizeApi';
import { TRANSCRIBE_COMMAND, TRANSCRIBE_SCRIPT, LOCAL_MAX_UPLOAD_BYTES, LOCAL_UPLOAD_PATH, transcriberCommand, type LocalTranscription } from '../../server/localVideo';
import { INFERENCE_ARGS } from '../../server/inference';
import type { CommandRunner } from '../../server/processRunner';

const catalog = 'provider model context max-out thinking images\nfixture model-a 128K 8K no no\n';
const summary = { takeaways: [{ num: '01', time: '00:00', heading: 'Resultado', text: 'Texto fundamentado.' }], deepdive: { heading: 'Análisis', tone: 'accent', paragraphs: ['Contenido.'] }, actions: { heading: 'Pasos', tone: 'blue', items: ['Paso.'] }, quote: null };
const wrapperTranscription: LocalTranscription = { duration: 90, language: 'es', cues: [{ start: 0, text: 'Hola mundo' }] };
/** Intercambia exactamente el par `]}` que cierra el final de `marker`: los dos caracteres que MiMo invirtió. */
const swapPair = (valid: string, marker: string) => {
  const at = valid.indexOf(marker) + marker.length - 2;
  expect(valid.slice(at, at + 2)).toBe(']}');
  return valid.slice(0, at) + '}]' + valid.slice(at + 2);
};
const bytes = new Uint8Array([86, 73, 68, 69, 79]); // "VIDEO"

class Events {
  listeners = new Map<string, Set<(...args: never[]) => void>>();
  on(event: string, fn: (...args: never[]) => void) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(fn); }
  removeListener(event: string, fn: (...args: never[]) => void) { this.listeners.get(event)?.delete(fn); }
  emit(event: string, ...args: unknown[]) { for (const fn of [...this.listeners.get(event) ?? []]) fn(...args as never[]); }
}
function localHeaders(overrides: Record<string, string | string[] | undefined> = {}) {
  return {
    host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173',
    'content-type': 'video/mp4',
    'x-restube-provider': 'fixture', 'x-restube-model': 'model-a',
    'x-restube-filename': encodeURIComponent('clip.mp4'),
    ...overrides,
  };
}
function request(options: { raw?: Uint8Array; headers?: Record<string, string | string[] | undefined>; method?: string; path?: string; chunks?: number[]; fakeChunkSize?: number } = {}) {
  const events = new Events(); const out = new Events(); let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const req = Object.assign(events, { method: options.method ?? 'POST', url: options.path ?? LOCAL_UPLOAD_PATH, headers: localHeaders(options.headers) }) as SummaryRequest & Events;
  const headers: Record<string, string> = {};
  const res = Object.assign(out, { statusCode: 0, body: '', setHeader(k: string, v: string) { headers[k] = v; }, end(body = '') { res.body = body; resolve(); } }) as SummaryResponse & Events & { body: string };
  return {
    req, res, done, headers,
    send: () => {
      if (options.fakeChunkSize) { req.emit('data', { byteLength: options.fakeChunkSize } as unknown as Uint8Array); req.emit('end'); return; }
      const payload = options.raw ?? bytes;
      const parts = options.chunks ?? [payload.byteLength];
      let at = 0;
      for (const size of parts) { req.emit('data', payload.subarray(at, at + size)); at += size; }
      req.emit('end');
    },
  };
}
async function makeRoot() { return mkdtemp(join(tmpdir(), 'restube-local-test-')); }
const roots: string[] = [];
/** Las etapas del trabajo usan fs real: esperar a que el runner llegue a la llamada N. */
async function waitForRunnerCalls(runner: ReturnType<typeof vi.fn<CommandRunner>>, count: number) {
  for (let i = 0; i < 500 && runner.mock.calls.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(runner.mock.calls.length).toBeGreaterThanOrEqual(count);
}
async function fixtureRoot() { const root = await makeRoot(); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function setup(overrides: { transcription?: unknown; transcriptionError?: unknown; inference?: unknown; inferenceRaw?: string; inferenceError?: unknown; root?: string; transcriber?: (mediaPath: string, runner: CommandRunner, signal: AbortSignal) => Promise<LocalTranscription>; localTimeoutMs?: number } = {}) {
  const runner = vi.fn<CommandRunner>(async (cmd) => {
    if (cmd.args.includes('--list-models')) return catalog;
    if (cmd.file === TRANSCRIBE_COMMAND) {
      if (overrides.transcriptionError) throw overrides.transcriptionError;
      return JSON.stringify(overrides.transcription ?? wrapperTranscription);
    }
    if (overrides.inferenceError) throw overrides.inferenceError;
    return overrides.inferenceRaw ?? JSON.stringify(overrides.inference ?? summary);
  });
  const middleware = createSummarizeMiddleware({
    runner, fetcher: vi.fn(), root: overrides.root, transcriber: overrides.transcriber,
    cooldownMs: 0, localTimeoutMs: overrides.localTimeoutMs,
  });
  async function call(options: Parameters<typeof request>[0] = {}) {
    const r = request(options); middleware(r.req, r.res, vi.fn()); r.send(); await r.done; await Promise.resolve(); return r;
  }
  return { runner, middleware, call };
}

it('transcribe el archivo subido localmente y pasa los cues al modelo exacto seleccionado', async () => {
  const root = await fixtureRoot();
  let mediaBytes: Uint8Array | undefined; let mediaMode = -1; let dirMode = -1; let mediaPath = '';
  const s = setup({
    root,
    transcriber: async (path, runner, signal) => {
      mediaPath = path; mediaBytes = new Uint8Array(await readFile(path));
      mediaMode = (await stat(path)).mode & 0o777;
      dirMode = (await stat(join(path, '..'))).mode & 0o777;
      return (async () => { const stdout = await runner(transcriberCommand(path), signal); return JSON.parse(stdout) as LocalTranscription; })();
    },
  });
  const r = await s.call();
  expect(r.res.statusCode).toBe(200);
  const result = JSON.parse(r.res.body);
  expect(result.video).toEqual({ source: 'local', id: expect.stringMatching(/^[a-f0-9]{32}$/), url: null, title: 'clip.mp4', author: 'Archivo local', duration: 90, language: 'es' });
  expect(result.summary.takeaways[0].heading).toBe('Resultado');
  expect(mediaBytes).toEqual(bytes);
  expect(mediaMode).toBe(0o600);
  expect(dirMode).toBe(0o700);
  expect(mediaPath).toMatch(/\.tools[\\/]tmp[\\/]local-/);
  const transcriptionCall = s.runner.mock.calls.find(([cmd]) => cmd.file === TRANSCRIBE_COMMAND)!;
  expect(transcriptionCall[0].file).toMatch(/\.tools[\\/]python[\\/]bin[\\/]python3$/);
  expect(transcriptionCall[0].args[0]).toMatch(/[\\/]scripts[\\/]transcribe\.py$/);
  expect(transcriptionCall[0].args.slice(1, 3)).toEqual(['--media', mediaPath]);
  expect(transcriptionCall[0].cleanEnv).toBe(true);
  const inference = s.runner.mock.calls.filter(([cmd]) => cmd.input).at(-1)![0];
  expect(inference.args.slice(0, INFERENCE_ARGS.length + 4)).toEqual([...INFERENCE_ARGS, '--provider', 'fixture', '--model', 'model-a']);
  expect(JSON.parse(inference.input!).subtitles).toEqual(wrapperTranscription.cues);
  expect(JSON.parse(inference.input!).title).toBe('clip.mp4');
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
});

it.each([
  [{ method: 'GET' }, 405], [{ path: `${LOCAL_UPLOAD_PATH}?x=1` }, 400], [{ path: `${LOCAL_UPLOAD_PATH}#x` }, 400],
  [{ headers: { origin: undefined } }, 403], [{ headers: { origin: 'http://localhost:5173' } }, 403],
  [{ headers: { host: '127.0.0.1.attacker' } }, 403],
  [{ headers: { 'content-type': 'application/json' } }, 415], [{ headers: { 'content-type': 'text/plain' } }, 415],
  [{ headers: { 'content-length': String(LOCAL_MAX_UPLOAD_BYTES + 1) } }, 413],
  [{ headers: { 'x-restube-provider': undefined } }, 400], [{ headers: { 'x-restube-model': undefined } }, 400],
  [{ headers: { 'x-restube-filename': '%zz' } }, 400], [{ headers: { 'x-restube-filename': undefined } }, 400],
] as [NonNullable<Parameters<typeof request>[0]>, number][])('rechaza %j sin procesos ni consumo del cuerpo', async (options, status) => {
  const s = setup({ root: await fixtureRoot() }); const r = await s.call(options);
  expect(r.res.statusCode).toBe(status); expect(s.runner).not.toHaveBeenCalled();
});

it('no admite un par proveedor:modelo fuera del catálogo antes de consumir la subida', async () => {
  const s = setup({ root: await fixtureRoot() });
  const r = await s.call({ headers: { 'x-restube-model': 'model-b' } });
  expect(r.res.statusCode).toBe(400); expect(JSON.parse(r.res.body).code).toBe('MODEL');
  expect(s.runner).toHaveBeenCalledTimes(1);
});

it('rechaza una subida que supera el límite de bytes y limpia el directorio del trabajo', async () => {
  const root = await fixtureRoot();
  const s = setup({ root });
  const r = await s.call({ fakeChunkSize: LOCAL_MAX_UPLOAD_BYTES + 1 });
  expect(r.res.statusCode).toBe(413); expect(JSON.parse(r.res.body).code).toBe('FILE_LIMIT');
  expect(s.runner).toHaveBeenCalledTimes(1);
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
});

it('un nombre de archivo hostil nunca se convierte en ruta del sistema de archivos', async () => {
  await fixtureRoot();
  const s = setup();
  const r = await s.call({ headers: { 'x-restube-filename': encodeURIComponent('../../etc/passwd') } });
  expect(r.res.statusCode).toBe(200);
  expect(JSON.parse(r.res.body).video.title).toBe('passwd');
  const transcriptionCall = s.runner.mock.calls.find(([cmd]) => cmd.file === TRANSCRIBE_COMMAND)!;
  expect(transcriptionCall[0].args[2]).not.toContain('/etc');
  expect(transcriptionCall[0].args[2]).toContain('.tools');
});

it.each([
  [Object.assign(new Error('secret raw'), { stderr: 'RESTUBE_ERROR:FILE_INVALID\nprivate stderr detail' }), 'FILE_INVALID', 422],
  [Object.assign(new Error('secret raw'), { code: 'ENOENT' }), 'TRANSCRIBER_MISSING', 502],
] as const)('clasifica fallos del transcriptor %s sin filtrar detalles ni inferir', async (error, code, status) => {
  const s = setup({ root: await fixtureRoot(), transcriptionError: error });
  const r = await s.call();
  expect(r.res.statusCode).toBe(status); expect(JSON.parse(r.res.body).code).toBe(code);
  expect(r.res.body).not.toContain('secret'); expect(r.res.body).not.toContain('private');
  expect(s.runner.mock.calls.filter(([cmd]) => cmd.input)).toHaveLength(0);
});

it.each([
  [{ duration: 90, language: 'es', cues: [] }, 'FILE_INVALID', 422],
  [{ duration: 7201, language: 'es', cues: [{ start: 0, text: 'x' }] }, 'FILE_DURATION', 413],
  [{ duration: 90, language: 'es', cues: Array.from({ length: 12001 }, (_, i) => ({ start: i, text: 'x' })) }, 'TRANSCRIPT_LIMIT', 413],
  [{ duration: 90, language: 'es', cues: [{ start: 0, text: 'x' }], extra: true }, 'TRANSCRIPTION', 502],
  ['not json at all', 'TRANSCRIPTION', 502],
  [{ duration: -1, language: 'es', cues: [{ start: 0, text: 'x' }] }, 'TRANSCRIPTION', 502],
] as const)('rechaza salida inválida del transcriptor %j con código saneado', async (transcription, code, status) => {
  const s = setup({ root: await fixtureRoot(), transcription });
  const r = await s.call();
  expect(r.res.statusCode).toBe(status); expect(JSON.parse(r.res.body).code).toBe(code);
  expect(s.runner.mock.calls.filter(([cmd]) => cmd.input)).toHaveLength(0);
});

it('un MODEL_RESPONSE agotado en la ruta local publica detalle curado sin contenido del modelo', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
  const root = await fixtureRoot();
  const s = setup({
    root,
    transcription: { duration: 7200, language: 'es', cues: Array.from({ length: 100 }, (_, i) => ({ start: i * 10, text: `fragmento${i} ${'contenido '.repeat(45)}` })) },
    inference: { notes: Array.from({ length: 13 }, () => ({ start: 0, text: 'note' })) },
  });
  const r = await s.call();
  expect(r.res.statusCode).toBe(502);
  const body = JSON.parse(r.res.body);
  expect(body.code).toBe('MODEL_RESPONSE');
  expect(body.error.startsWith('El modelo devolvió un resumen con un formato inválido.')).toBe(true);
  expect(body.error).toMatch(/bloque de notas 1 de \d+/);
  expect(body.error).toContain('13');
  expect(r.res.body).not.toContain('SECRET');
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
  warn.mockRestore();
});

it('fallo de inferencia nunca expone salida cruda ni conserva archivos temporales', async () => {
  const root = await fixtureRoot();
  const s = setup({ root, inferenceError: new Error('SECRET credentials') });
  const r = await s.call();
  expect(JSON.parse(r.res.body).code).toBe('MODEL_FAILED'); expect(r.res.body).not.toContain('SECRET');
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
});

it('recupera exactamente una inversión de cierre en la inferencia local, sin llamada extra y con el contenido intacto', async () => {
  const inverted = swapPair(JSON.stringify(summary), '"Contenido."]}');
  expect(() => JSON.parse(inverted)).toThrow();
  const root = await fixtureRoot();
  const s = setup({ root, inferenceRaw: inverted });
  const r = await s.call();
  expect(r.res.statusCode).toBe(200);
  expect(JSON.parse(r.res.body).summary).toEqual(summary);
  expect(s.runner.mock.calls.filter(([cmd]) => cmd.input)).toHaveLength(1);
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
});

it('ocupación exclusiva compartida: un trabajo local bloquea también /api/summarize y viceversa', async () => {
  const root = await fixtureRoot();
  const s = setup({ root });
  let release!: (value: string) => void;
  s.runner.mockImplementationOnce(async () => catalog).mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; }));
  const pending = request();
  s.middleware(pending.req, pending.res, vi.fn()); pending.send();
  await Promise.resolve();
  expect((await s.call()).res.statusCode).toBe(429);
  const youtubeRequest = request({ path: '/api/summarize', headers: { 'content-type': 'application/json' } });
  middlewareYoutube(s.middleware, youtubeRequest);
  expect(youtubeRequest.res.statusCode).toBe(429);
  await waitForRunnerCalls(s.runner, 2);
  release(JSON.stringify(wrapperTranscription));
  // El cupo y la limpieza se liberan juntos: el directorio desaparece cuando el trabajo termina.
  for (let i = 0; i < 500; i += 1) {
    const rest = await readdir(join(root, '.tools', 'tmp')).catch(() => ['pending']);
    if (rest.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
  expect((await s.call()).res.statusCode).toBe(200);
});
function middlewareYoutube(middleware: ReturnType<typeof createSummarizeMiddleware>, r: ReturnType<typeof request>) {
  middleware(r.req, r.res, vi.fn());
  r.req.emit('data', new TextEncoder().encode(JSON.stringify({ url: 'https://www.youtube.com/watch?v=abcdefghijk', provider: 'fixture', model: 'model-a' })));
  r.req.emit('end');
}

it('desconectar durante la transcripción aborta y nunca llama al modelo ni publica respuesta', async () => {
  const root = await fixtureRoot();
  const s = setup({ root });
  let release!: (value: string) => void;
  s.runner.mockImplementationOnce(async () => catalog).mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; }));
  const pending = request(); const end = vi.spyOn(pending.res, 'end');
  s.middleware(pending.req, pending.res, vi.fn()); pending.send();
  await Promise.resolve();
  expect((await s.call()).res.statusCode).toBe(429);
  await waitForRunnerCalls(s.runner, 2);
  pending.res.emit('close');
  expect(s.runner.mock.calls[1][1].aborted).toBe(true);
  // El adaptador ignora la señal: la ocupación se conserva hasta que finaliza de todos modos.
  release(JSON.stringify(wrapperTranscription));
  // La limpieza ocurre cuando el trabajo abortado termina de rechazar y remover su directorio.
  for (let i = 0; i < 500; i += 1) {
    const rest = await readdir(join(root, '.tools', 'tmp')).catch(() => ['pending']);
    if (rest.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(end).not.toHaveBeenCalled();
  expect(s.runner.mock.calls.filter(([cmd]) => cmd.input)).toHaveLength(0);
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
  expect((await s.call()).res.statusCode).toBe(200);
});

it('desconectar durante la subida descarta el cuerpo y limpia sin llamar al transcriptor', async () => {
  const root = await fixtureRoot();
  const s = setup({ root });
  const pending = request(); const end = vi.spyOn(pending.res, 'end');
  s.middleware(pending.req, pending.res, vi.fn());
  pending.req.emit('data', bytes.subarray(0, 2));
  pending.res.emit('close');
  pending.req.emit('data', bytes.subarray(2)); pending.req.emit('end');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(end).not.toHaveBeenCalled();
  expect(s.runner.mock.calls.filter(([cmd]) => cmd.file === TRANSCRIBE_COMMAND)).toHaveLength(0);
  expect(s.runner).toHaveBeenCalledTimes(1); // Solo el catálogo: la subida nunca llegó a consumirse.
  expect(await readdir(join(root, '.tools', 'tmp')).catch(() => [])).toEqual([]);
  expect((await s.call()).res.statusCode).toBe(200);
});

it('responde 504 al agotar el plazo local y conserva la ocupación hasta finalizar', async () => {
  const root = await fixtureRoot();
  const s = setup({ root, localTimeoutMs: 10 });
  let release!: (value: string) => void;
  s.runner.mockImplementationOnce(async () => catalog).mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; }));
  const r = await s.call();
  expect(r.res.statusCode).toBe(504); expect(JSON.parse(r.res.body).code).toBe('TIMEOUT');
  expect((await s.call()).res.statusCode).toBe(429);
  release(JSON.stringify(wrapperTranscription));
  // La limpieza del directorio del trabajo solo ocurre cuando el trabajo rechazado termina.
  for (let i = 0; i < 500; i += 1) {
    const rest = await readdir(join(root, '.tools', 'tmp')).catch(() => ['pending']);
    if (rest.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(s.runner.mock.calls.filter(([cmd]) => cmd.input)).toHaveLength(0);
  await expect(readdir(join(root, '.tools', 'tmp'))).resolves.toEqual([]);
  expect((await s.call()).res.statusCode).toBe(200);
});

it('el argv del transcriptor es exactamente consumible por el parser argparse del wrapper', () => {
  const mediaPath = join(tmpdir(), 'restube-missing-media.bin');
  expect(transcriberCommand(mediaPath).args).toEqual([TRANSCRIBE_SCRIPT, '--media', mediaPath]);
});

it('el parser real del wrapper responde el error de dominio fijo, nunca usage de argparse', () => {
  // Interprete sustituto del sistema: este camino del wrapper no importa faster-whisper.
  const run = spawnSync('python3', transcriberCommand(join(tmpdir(), 'restube-missing-media.bin')).args, { encoding: 'utf8', timeout: 30_000 });
  expect(run.status).toBe(2);
  expect(run.stdout).toBe('');
  expect(run.stderr).toBe('RESTUBE_ERROR:FILE_INVALID\n');
  expect(run.stderr).not.toMatch(/^usage:/m);
});

it('rechaza el catálogo/modelo y desmonta los listeners del cuerpo en todas las rutas terminales', async () => {
  const root = await fixtureRoot();
  const s = setup({ root });
  const r = await s.call({ headers: { 'x-restube-model': 'model-b' } });
  expect(r.res.statusCode).toBe(400);
  const pendingReq = s.middleware; // los listeners viven en la request del propio middleware
  expect(pendingReq).toBeDefined();
  // La request del rechazo ya cerró sus listeners de subida.
  expect((r.req as unknown as Events).listeners.get('data')?.size ?? 0).toBe(0);
  expect((r.req as unknown as Events).listeners.get('end')?.size ?? 0).toBe(0);
  expect((r.req as unknown as Events).listeners.get('error')?.size ?? 0).toBe(0);
  await expect(readdir(join(root, '.tools', 'tmp')).catch(() => [])).resolves.toEqual([]);
});
