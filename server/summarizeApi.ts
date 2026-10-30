import { mkdtemp, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keys, record, text, SummaryError, validResult, validSummary, modelResponseDetail, type SummaryErrorCode, type SummaryResult } from '../src/data/summary';
import { LIST_MODELS_ARGS, LIST_MODELS_COMMAND, LIST_MODELS_MAX_BUFFER, LIST_MODELS_TIMEOUT_MS, parseListModelsOutput, type ApiRequest, type ApiResponse, type MiddlewareHost } from './modelsApi';
import { runCommand, type CommandRunner } from './processRunner';
import { extractYoutube, parseYoutubeUrl, type Transcript } from './youtube';
import { inferSummary } from './inference';
import { LOCAL_UPLOAD_PATH, LOCAL_MAX_UPLOAD_BYTES, LOCAL_MAX_DURATION_SECONDS, LOCAL_TOTAL_TIMEOUT_MS, LOCAL_UPLOAD_TIMEOUT_MS, sanitizeFilename, transcribeLocal, type LocalTranscription } from './localVideo';

export interface SummaryRequest extends ApiRequest {
  socket?: { encrypted?: boolean };
  pause?(): unknown;
  resume?(): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}
export interface SummaryResponse extends ApiResponse {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  writableEnded?: boolean;
}
interface Options {
  runner?: CommandRunner; fetcher?: typeof fetch; cooldownMs?: number;
  timeoutMs?: number; bodyTimeoutMs?: number; localTimeoutMs?: number;
  /** Plazo propio de la subida local (120 s por defecto), distinto del plazo total del trabajo. */
  uploadTimeoutMs?: number;
  /** Raíz del proyecto para el directorio temporal de trabajos (inyectable en pruebas). */
  root?: string;
  /** Transcriptor inyectable; por defecto usa el wrapper local con el runner. */
  transcriber?: (mediaPath: string, runner: CommandRunner, signal: AbortSignal) => Promise<LocalTranscription>;
}
function header(req: ApiRequest, key: string): string | null {
  const value = req.headers[key]; return typeof value === 'string' ? value : null;
}
function localOrigin(req: SummaryRequest): boolean {
  const host = header(req, 'host'); const origin = header(req, 'origin');
  if (!host || !origin || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/.test(host)) return false;
  try {
    const parsed = new URL(origin);
    const protocol = req.socket?.encrypted ? 'https:' : 'http:';
    return parsed.protocol === protocol && origin === `${protocol}//${host}` && parsed.host === host && !parsed.username && !parsed.password;
  } catch { return false; }
}
function json(res: ApiResponse, status: number, body: unknown) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(JSON.stringify(body));
}
function fail(res: ApiResponse, status: number, code: SummaryErrorCode, detail?: string) {
  // Solo el detalle MODEL_RESPONSE confiable atraviesa; cualquier otro código mantiene su mensaje estático.
  const safe = code === 'MODEL_RESPONSE' ? modelResponseDetail(detail) : null;
  json(res, status, { code, error: safe ?? new SummaryError(code).message });
}
function readBody(req: SummaryRequest, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bytes: Uint8Array[] = []; let length = 0;
    const timer = setTimeout(() => finish(new SummaryError('TIMEOUT')), timeoutMs);
    function cleanup() { clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', error); signal.removeEventListener('abort', abort); }
    function finish(error?: unknown, value?: unknown) { cleanup(); if (error) reject(error); else resolve(value); }
    function abort() { finish(new SummaryError('TIMEOUT')); }
    function error() { finish(new SummaryError('BAD_REQUEST')); }
    function data(chunk: Uint8Array) {
      length += chunk.byteLength;
      if (length > 4096) { finish(new SummaryError('BODY_LIMIT')); return; }
      bytes.push(chunk);
    }
    function end() {
      try {
        const all = new Uint8Array(length); let at = 0;
        for (const part of bytes) { all.set(part, at); at += part.length; }
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); finish(undefined, value);
      } catch { finish(new SummaryError('BAD_REQUEST')); }
    }
    req.on('data', data as (...args: never[]) => void); req.on('end', end); req.on('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

const JSON_BODY_LIMIT = 4096;
const statusOf = (code: SummaryErrorCode) => code === 'BODY_LIMIT' || code === 'TRANSCRIPT_LIMIT' || code === 'FILE_LIMIT' || code === 'FILE_DURATION' ? 413 : code === 'TIMEOUT' ? 504 : ['MODEL', 'URL', 'BAD_REQUEST', 'LOCAL_REQUEST'].includes(code) ? 400 : code === 'NO_CAPTIONS' || code === 'YOUTUBE_UNAVAILABLE' || code === 'FILE_INVALID' ? 422 : code === 'FILE_TYPE' ? 415 : 502;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Cabeceras fijas validadas del envío local. */
interface LocalHeaders { provider: string; model: string; filename: string }

function localHeaders(req: SummaryRequest): LocalHeaders {
  const contentType = (header(req, 'content-type') ?? '').split(';')[0].trim();
  if (!/^video\/[a-z0-9.+-]+$/i.test(contentType)) throw new SummaryError('FILE_TYPE');
  const provider = header(req, 'x-restube-provider');
  const model = header(req, 'x-restube-model');
  const rawFilename = header(req, 'x-restube-filename');
  if (!provider || !text(provider, 200) || !model || !text(model, 300)) throw new SummaryError('LOCAL_REQUEST');
  let filename = '';
  try { filename = sanitizeFilename(decodeURIComponent(rawFilename ?? '')); } catch { throw new SummaryError('LOCAL_REQUEST'); }
  if (!text(filename, 200)) throw new SummaryError('LOCAL_REQUEST');
  const size = header(req, 'content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > LOCAL_MAX_UPLOAD_BYTES)) throw new SummaryError('FILE_LIMIT');
  return { provider, model, filename };
}

/** Recepción nativa del cuerpo: adjunta sincrónicamente, en pausa hasta start(), con contrapresión real de disco. */
interface UploadReceiver {
  readonly failed: SummaryError | null;
  /** Abre el archivo destino (0600), reanuda el stream y resuelve al terminar el cuerpo completo. */
  start(handle: FileHandle): Promise<void>;
  /** Terminal: quita listeners de data/end/error/abort y el timer en cualquier ruta que ya no consuma el cuerpo. */
  detach(): void;
}
function attachUpload(req: SummaryRequest, signal: AbortSignal, timeoutMs: number): UploadReceiver {
  // En pausa antes de adjuntar: en Node real ningún byte se consume hasta start(); el catálogo decide antes.
  req.pause?.();
  let handle: FileHandle | null = null;
  let settle: ((ok: boolean, error?: SummaryError) => void) | null = null;
  let started = false; let finished = false; let ended = false; let pumping = false;
  let total = 0; let failure: SummaryError | null = null;
  const pending: Uint8Array[] = [];
  const timer = setTimeout(() => fail(new SummaryError('TIMEOUT')), timeoutMs);
  function removeListeners() {
    req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError);
    signal.removeEventListener('abort', onAbort);
  }
  function fail(error: SummaryError) {
    if (finished) return;
    finished = true; failure = error;
    clearTimeout(timer); removeListeners(); req.pause?.();
    settle?.(false, error);
  }
  function complete() {
    if (finished) return;
    finished = true;
    clearTimeout(timer); removeListeners();
    settle?.(true);
  }
  function onData(chunk: Uint8Array) {
    if (finished) return;
    total += chunk.byteLength;
    if (total > LOCAL_MAX_UPLOAD_BYTES) { fail(new SummaryError('FILE_LIMIT')); return; }
    pending.push(chunk);
    if (!started) return; // En Node real el stream está pausado; un mock puede adelantar bytes, se retienen hasta start().
    req.pause?.(); // Contrapresión: el socket espera mientras el bloque anterior llega a disco.
    void pump();
  }
  async function pump() {
    if (pumping) return; pumping = true;
    try {
      while (pending.length) { const chunk = pending.shift()!; await handle!.write(chunk); }
      if (ended) { complete(); return; }
      if (!finished) req.resume?.();
    } catch { fail(new SummaryError('LOCAL_REQUEST')); }
    finally { pumping = false; }
  }
  function onEnd() {
    if (finished) return;
    ended = true;
    if (!started) return;
    if (!pumping) { if (pending.length) void pump(); else complete(); }
  }
  function onError() { fail(new SummaryError('LOCAL_REQUEST')); }
  function onAbort() { fail(new SummaryError('TIMEOUT')); }
  req.on('data', onData as (...args: never[]) => void); req.on('end', onEnd); req.on('error', onError);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    get failed() { return failure; },
    start(target: FileHandle): Promise<void> {
      handle = target; started = true;
      if (failure) return Promise.reject(failure);
      return new Promise<void>((resolve, reject) => {
        settle = (ok, error) => { settle = null; if (ok) resolve(); else reject(error!); };
        if (finished) { const error = failure!; settle = null; reject(error); return; }
        if (ended) { if (pending.length) void pump(); else complete(); return; }
        // Orden correcto: primero abrir/adjuntar destino, después reanudar el stream pausado.
        req.resume?.();
        if (pending.length) void pump();
      });
    },
    detach() {
      if (finished) return;
      finished = true;
      clearTimeout(timer); removeListeners(); req.pause?.();
    },
  };
}

/** Un único trabajo acotado compartido por ambas rutas; todos los datos de navegador se validan antes del primer proceso. */
export function createSummarizeMiddleware(options: Options = {}) {
  const runner = options.runner ?? runCommand; const fetcher = options.fetcher ?? fetch;
  const transcriber = options.transcriber ?? ((mediaPath: string, r: CommandRunner, signal: AbortSignal) => transcribeLocal(mediaPath, r, signal));
  const root = options.root ?? PROJECT_ROOT;
  // Ocupación exclusiva única: YouTube y archivo local comparten el mismo cupo.
  let active = false; let nextAllowed = 0;
  return (req: SummaryRequest, res: SummaryResponse, next: () => void): void => {
    const path = (req.url ?? '').split(/[?#]/)[0];
    const isLocal = path === LOCAL_UPLOAD_PATH;
    if (path !== '/api/summarize' && !isLocal) { next(); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(res, 405, 'METHOD'); return; }
    if (req.url !== path) { fail(res, 400, 'BAD_REQUEST'); return; }
    if (!localOrigin(req)) { fail(res, 403, 'FORBIDDEN'); return; }
    let local: LocalHeaders | null = null;
    if (isLocal) {
      // Cabeceras y Content-Type antes de tocar el cupo o el cuerpo.
      try { local = localHeaders(req); } catch (error) {
        fail(res, statusOf(error instanceof SummaryError ? error.code : 'LOCAL_REQUEST'), error instanceof SummaryError ? error.code : 'LOCAL_REQUEST');
        return;
      }
    } else {
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, 'content-type') ?? '')) { fail(res, 415, 'CONTENT_TYPE'); return; }
      const size = header(req, 'content-length');
      if (size !== null && (!/^\d+$/.test(size) || Number(size) > JSON_BODY_LIMIT)) { fail(res, 413, 'BODY_LIMIT'); return; }
    }
    if (active || Date.now() < nextAllowed) { res.setHeader('Retry-After', '1'); fail(res, 429, 'BUSY'); return; }
    active = true;
    const controller = new AbortController(); let disconnected = false; let finished = false;
    const disconnect = () => { if (!finished) { disconnected = true; controller.abort(); } };
    req.on('aborted', disconnect); res.on('close', disconnect);
    const timer = setTimeout(() => controller.abort(), isLocal ? (options.localTimeoutMs ?? LOCAL_TOTAL_TIMEOUT_MS) : (options.timeoutMs ?? 900_000));

    const localWork = async (signal: AbortSignal, headers: LocalHeaders): Promise<SummaryResult> => {
      // Recepción adjunta sincrónicamente y en pausa: el catálogo decide antes de consumir la subida.
      const receiver = attachUpload(req, signal, options.uploadTimeoutMs ?? LOCAL_UPLOAD_TIMEOUT_MS);
      try {
        let models;
        try {
          models = parseListModelsOutput(await runner({ file: LIST_MODELS_COMMAND, args: [...LIST_MODELS_ARGS], timeout: LIST_MODELS_TIMEOUT_MS, maxBuffer: LIST_MODELS_MAX_BUFFER }, signal));
        } catch { throw new SummaryError('CATALOG'); }
        signal.throwIfAborted();
        const model = models.find((m) => m.provider === headers.provider && m.id === headers.model);
        if (!model) throw new SummaryError('MODEL');
        await mkdir(join(root, '.tools', 'tmp'), { recursive: true });
        // Directorio aleatorio 0700 (mkdtemp); se elimina completo al terminar, éxito o fallo.
        const dir = await mkdtemp(join(root, '.tools', 'tmp', 'local-'));
        try {
          const mediaPath = join(dir, 'input');
          const handle = await open(mediaPath, 'wx', 0o600);
          try {
            // Orden correcto: destino abierto antes de reanudar el stream (nunca deadlock nativo).
            await receiver.start(handle);
          } finally { await handle.close(); }
          signal.throwIfAborted();
        const transcription = await transcriber(mediaPath, runner, signal);
        signal.throwIfAborted();
        const transcript: Transcript = {
          video: { source: 'local', id: randomUUID().replace(/-/g, ''), url: null, title: headers.filename, author: 'Archivo local', duration: transcription.duration, language: transcription.language },
          cues: transcription.cues,
        };
        const summary = await inferSummary(transcript, model, runner, signal);
        signal.throwIfAborted();
        const result = { video: transcript.video, summary, model: { provider: model.provider, id: model.id, name: model.name } };
        if (!validResult(result)) {
          const metadata = [transcription.duration <= 0 || transcription.duration > LOCAL_MAX_DURATION_SECONDS ? 'duration' : '', !transcription.cues.length ? 'cues' : ''].filter(Boolean);
          console.warn(`[restube] MODEL_RESPONSE stage=result-local metadata=${metadata.join(',') || 'none'} summary=${validSummary(summary) ? 'valid' : 'invalid'}`);
          throw new SummaryError('MODEL_RESPONSE');
        }
        return result;
        } finally {
          // Solo el directorio que este trabajo creó; tras el cierre del subproceso.
          await rm(dir, { recursive: true, force: true });
        }
      } finally {
        // Ruta terminal (catálogo/modelo/fallo/aborto): sin listeners del cuerpo ni timer vivo.
        receiver.detach();
      }
    };

    const youtubeWork = async (signal: AbortSignal): Promise<SummaryResult> => {
      const body = await readBody(req, signal, options.bodyTimeoutMs ?? 5000);
      signal.throwIfAborted();
      if (!record(body) || !keys(body, ['url', 'provider', 'model']) || !text(body.url, 2048) || !text(body.provider, 200) || !text(body.model, 300)) throw new SummaryError('BAD_REQUEST');
      const source = parseYoutubeUrl(body.url);
      let models;
      try {
        models = parseListModelsOutput(await runner({ file: LIST_MODELS_COMMAND, args: [...LIST_MODELS_ARGS], timeout: LIST_MODELS_TIMEOUT_MS, maxBuffer: LIST_MODELS_MAX_BUFFER }, signal));
      } catch { throw new SummaryError('CATALOG'); }
      signal.throwIfAborted();
      const model = models.find((m) => m.provider === body.provider && m.id === body.model);
      if (!model) throw new SummaryError('MODEL');
      // Vale solo el par exacto del catálogo, nunca patrones/flags del navegador.
      const transcript = await extractYoutube(source, runner, fetcher, signal);
      signal.throwIfAborted();
      const summary = await inferSummary(transcript, model, runner, signal);
      signal.throwIfAborted();
      const result = { video: transcript.video, summary, model: { provider: model.provider, id: model.id, name: model.name } };
      if (!validResult(result)) {
        const v = transcript.video;
        const metadata = [text(v.title, 500) ? '' : 'title', text(v.author, 300) ? '' : 'author', text(v.language, 40) ? '' : 'language', typeof v.duration === 'number' && v.duration > 0 && v.duration <= 604800 ? '' : 'duration'].filter(Boolean);
        console.warn(`[restube] MODEL_RESPONSE stage=result metadata=${metadata.join(',') || 'none'} summary=${validSummary(summary) ? 'valid' : 'invalid'}`);
        throw new SummaryError('MODEL_RESPONSE');
      }
      return result;
    };

    const actualWork = isLocal ? localWork(controller.signal, local!) : youtubeWork(controller.signal);

    // La respuesta puede vencer antes que el trabajo. El cupo pertenece al trabajo real:
    // un adaptador que ignore AbortSignal conserva la ocupación hasta finalizar (fail closed).
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new SummaryError('TIMEOUT'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const releaseOccupation = () => {
      active = false;
      nextAllowed = Date.now() + (options.cooldownMs ?? 1000);
    };
    void actualWork.then(releaseOccupation, releaseOccupation);

    void Promise.race([actualWork, aborted]).then((result) => {
      if (!disconnected && !controller.signal.aborted) {
        finished = true;
        json(res, 200, result);
      }
    }).catch((error: unknown) => {
      if (!disconnected) {
        finished = true;
        const code = controller.signal.aborted ? 'TIMEOUT' : error instanceof SummaryError ? error.code : 'EXTRACTION';
        fail(res, statusOf(code), code, error instanceof SummaryError && code === 'MODEL_RESPONSE' ? error.message : undefined);
      }
    }).finally(() => {
      finished = true;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      req.removeListener('aborted', disconnect);
      res.removeListener('close', disconnect);
    });
  };
}
export function summarizeApiPlugin() {
  const middleware = createSummarizeMiddleware();
  const configure = (server: MiddlewareHost) => { server.middlewares.use((req, res, next) => middleware(req as SummaryRequest, res as SummaryResponse, next)); };
  return { name: 'restube-summarize-api', configureServer: configure, configurePreviewServer: configure };
}
