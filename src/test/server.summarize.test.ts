// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createSummarizeMiddleware, type SummaryRequest, type SummaryResponse } from '../../server/summarizeApi';
import { CAPTIONS_ARGS, CAPTIONS_PYTHON, EXTRACTION_ARGS, EXTRACTION_COMMAND, TRANSCRIPT_MAX_CHARS, parseCaptionsPayload, parseYoutubeUrl } from '../../server/youtube';
import { INFERENCE_ARGS } from '../../server/inference';
import type { CommandRunner } from '../../server/processRunner';

const id = 'abcdefghijk'; const url = `https://www.youtube.com/watch?v=${id}`;
const catalog = 'provider model context max-out thinking images\nfixture model-a 128K 8K no no\n';
const summary = { takeaways: [{ num: '01', time: '00:00', heading: 'Resultado', text: 'Texto fundamentado.' }], deepdive: { heading: 'Análisis', tone: 'accent', paragraphs: ['Contenido.'] }, actions: { heading: 'Pasos', tone: 'blue', items: ['Paso.'] }, quote: { text: 'Hola mundo', author: 'Inventado', tone: 'green' } };
const info = { id, title: 'Título extraído', uploader: 'Autor extraído', duration: 90 };
/** Intercambia exactamente el par `]}` que cierra el final de `marker`: los dos caracteres que MiMo invirtió. */
const swapPair = (valid: string, marker: string) => {
  const at = valid.indexOf(marker) + marker.length - 2;
  expect(valid.slice(at, at + 2)).toBe(']}');
  return valid.slice(0, at) + '}]' + valid.slice(at + 2);
};
const adapterToken = (token: string) => Object.assign(new Error('private raw'), { stderr: `{"error":"${token}"}` });
class Events {
  listeners = new Map<string, Set<(...args: never[]) => void>>();
  on(event: string, fn: (...args: never[]) => void) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(fn); }
  removeListener(event: string, fn: (...args: never[]) => void) { this.listeners.get(event)?.delete(fn); }
  emit(event: string, ...args: unknown[]) { for (const fn of [...this.listeners.get(event) ?? []]) fn(...args as never[]); }
}
function request(options: { body?: unknown; raw?: string; headers?: Record<string, string | string[] | undefined>; method?: string; path?: string } = {}) {
  const events = new Events(); const out = new Events(); let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const req = Object.assign(events, { method: options.method ?? 'POST', url: options.path ?? '/api/summarize', headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', ...options.headers } }) as SummaryRequest & Events;
  const headers: Record<string, string> = {};
  const res = Object.assign(out, { statusCode: 0, body: '', setHeader(k: string, v: string) { headers[k] = v; }, end(body = '') { res.body = body; resolve(); } }) as SummaryResponse & Events & { body: string };
  return { req, res, done, headers, send: () => { req.emit('data', new TextEncoder().encode(options.raw ?? JSON.stringify(options.body ?? { url, provider: 'fixture', model: 'model-a' }))); req.emit('end'); } };
}
function setup(overrides: { metadata?: unknown; inference?: unknown; inferenceRaw?: string; extractError?: string; captions?: string | Error; runner?: CommandRunner; timeoutMs?: number } = {}) {
  const runner = vi.fn<CommandRunner>(overrides.runner ?? (async (cmd) => {
    if (cmd.args.includes('--list-models')) return catalog;
    if (cmd.file === EXTRACTION_COMMAND) {
      if (overrides.extractError) throw Object.assign(new Error('secret raw'), { stderr: overrides.extractError });
      return JSON.stringify(overrides.metadata ?? info);
    }
    if (cmd.file === CAPTIONS_PYTHON) {
      if (overrides.captions instanceof Error) throw overrides.captions;
      return overrides.captions ?? JSON.stringify({ language: 'es', cues: [{ start: 0, text: 'Hola mundo' }] });
    }
    return overrides.inferenceRaw ?? JSON.stringify(overrides.inference ?? summary);
  }));
  // El fetch del navegador ya no participa: la adquisición de subtítulos vive en el adaptador.
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('RED de capturas heredadas no permitida'); });
  const middleware = createSummarizeMiddleware({ runner, fetcher, cooldownMs: 0, timeoutMs: overrides.timeoutMs });
  async function call(options: Parameters<typeof request>[0] = {}) { const r = request(options); middleware(r.req, r.res, vi.fn()); r.send(); await r.done; await Promise.resolve(); return r; }
  return { runner, fetcher, middleware, call };
}
describe('POST /api/summarize público', () => {
  it('usa extracción real, adaptador de subtítulos y modelo seleccionado con argv fijo y contenido solo en stdin', async () => {
    const s = setup(); const r = await s.call(); expect(r.res.statusCode).toBe(200);
    const result = JSON.parse(r.res.body);
    expect(result.video).toEqual({ source: 'youtube', id, url, title: info.title, author: info.uploader, duration: 90, language: 'es' });
    expect(result.summary.quote.author).toBe(info.uploader);
    const extract = s.runner.mock.calls[1][0]; expect(extract.file).toMatch(/^\/.*\/\.tools\/yt-dlp$/);
    expect(extract.file).not.toBe('/usr/bin/yt-dlp');
    expect(extract.args).toEqual([...EXTRACTION_ARGS, '--', url]); expect(extract.cleanEnv).toBe(true);
    const captions = s.runner.mock.calls[2][0];
    expect(captions.file).toBe(CAPTIONS_PYTHON);
    expect(captions.args).toEqual([...CAPTIONS_ARGS, id]);
    expect(captions.args.join(' ')).not.toContain('http');
    expect(captions.cleanEnv).toBe(true);
    const inference = s.runner.mock.calls[3][0];
    expect(inference.args.slice(0, INFERENCE_ARGS.length)).toEqual(INFERENCE_ARGS);
    expect(inference.args.slice(INFERENCE_ARGS.length, INFERENCE_ARGS.length + 4)).toEqual(['--provider', 'fixture', '--model', 'model-a']);
    expect(inference.args.join(' ')).not.toContain('Hola mundo'); expect(JSON.parse(inference.input!).subtitles).toEqual([{ start: 0, text: 'Hola mundo' }]);
    expect(inference.args.at(-1)).toContain('DATOS NO CONFIABLES');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [{ method: 'GET' }, 405], [{ path: '/api/summarize?x=1' }, 400], [{ path: '/api/summarize#x' }, 400],
    [{ headers: { origin: undefined } }, 403], [{ headers: { origin: 'http://localhost:5173' } }, 403],
    [{ headers: { origin: 'http://127.0.0.1:5173/' } }, 403], [{ headers: { origin: 'https://127.0.0.1:5173' } }, 403], [{ headers: { host: '127.0.0.1.attacker' } }, 403],
    [{ headers: { host: ['127.0.0.1:5173', 'evil'] } }, 403], [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ headers: { 'content-length': '4097' } }, 413], [{ raw: 'x'.repeat(4097) }, 413], [{ raw: '{' }, 400],
    [{ body: { url, provider: 'fixture', model: 'model-a', extra: true } }, 400], [{ body: { url, provider: 1, model: 'model-a' } }, 400],
    [{ body: { url: 'https://127.0.0.1/video', provider: 'fixture', model: 'model-a' } }, 400],
  ] as [NonNullable<Parameters<typeof request>[0]>, number][])('rechaza %j sin procesos ni red', async (options, status) => {
    const s = setup(); const r = await s.call(options); expect(r.res.statusCode).toBe(status); expect(s.runner).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('no admite un ID parecido: solo consulta el catálogo y no extrae', async () => {
    const s = setup(); const r = await s.call({ body: { url, provider: 'fixture', model: 'model' } });
    expect(r.res.statusCode).toBe(400); expect(JSON.parse(r.res.body).code).toBe('MODEL'); expect(s.runner).toHaveBeenCalledTimes(1); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each([['HTTP Error 429: Too Many Requests', 'YOUTUBE_RATE_LIMIT'], ['Sign in to confirm you are not a bot SECRET', 'YOUTUBE_BLOCKED'], ['HTTP Error 403: Forbidden SECRET', 'YOUTUBE_BLOCKED'], ['Sign in to confirm your age SECRET', 'YOUTUBE_AUTH'], ['Private video SECRET', 'YOUTUBE_UNAVAILABLE']])('clasifica %s sin inferencia ni filtración', async (raw, code) => {
    const s = setup({ extractError: raw }); const r = await s.call(); expect(JSON.parse(r.res.body).code).toBe(code); expect(r.res.body).not.toContain('SECRET'); expect(r.res.body).not.toContain('secret raw'); expect(s.runner).toHaveBeenCalledTimes(2); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('si falta el extractor local devuelve instrucciones y no usa el del sistema', async () => {
    const s = setup();
    s.runner.mockImplementationOnce(async () => catalog).mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'ENOENT' }));
    const r = await s.call();
    expect(r.res.statusCode).toBe(502);
    expect(JSON.parse(r.res.body)).toEqual({ code: 'EXTRACTOR_MISSING', error: 'No está instalado el extractor local. Ejecuta pnpm run setup:yt-dlp en este proyecto.' });
    expect(s.runner).toHaveBeenCalledTimes(2); expect(s.fetcher).not.toHaveBeenCalled();
    expect(r.res.body).not.toContain('private path');
  });
  it('extrae subtítulos aunque no haya formatos descargables sin inventar metadatos', async () => {
    const s = setup();
    s.runner.mockImplementationOnce(async () => catalog).mockImplementationOnce(async (cmd) => {
      if (!cmd.args.includes('--ignore-no-formats-error')) throw new Error('No video formats found');
      return JSON.stringify({ ...info, formats: [] });
    });
    const r = await s.call();
    expect(r.res.statusCode).toBe(200);
    expect(JSON.parse(r.res.body).video.title).toBe(info.title);
    expect(s.runner.mock.calls[1][0].args).toContain('--skip-download');
    expect(s.runner.mock.calls[1][0].args).toContain('--ignore-no-formats-error');
    expect(s.runner).toHaveBeenCalledTimes(4); expect(s.fetcher).not.toHaveBeenCalled();
    const invalid = setup({ metadata: { ...info, title: undefined, formats: [] } });
    expect(JSON.parse((await invalid.call()).res.body).code).toBe('EXTRACTION');
    expect(invalid.runner).toHaveBeenCalledTimes(2); expect(invalid.fetcher).not.toHaveBeenCalled();
  });
  it('procesa subtítulos largos por bloques y publica solamente la síntesis final', async () => {
    const s = setup();
    s.runner.mockImplementation(async (cmd) => {
      if (cmd.args.includes('--list-models')) return catalog;
      if (cmd.file === EXTRACTION_COMMAND) return JSON.stringify({ ...info, duration: 300 });
      if (cmd.file === CAPTIONS_PYTHON) return JSON.stringify({ language: 'es', cues: Array.from({ length: 100 }, (_, i) => ({ start: i, text: `fragmento${i} ${'contenido '.repeat(90)}` })) });
      const input = JSON.parse(cmd.input!);
      return JSON.stringify(input.subtitles ? { notes: [{ start: input.subtitles[0].start, text: 'Contenido del fragmento' }] } : summary);
    });
    const r = await s.call();
    expect(r.res.statusCode).toBe(200); expect(JSON.parse(r.res.body).summary.takeaways).toEqual(summary.takeaways);
    const calls = s.runner.mock.calls.filter(([cmd]) => cmd.input);
    expect(calls.length).toBeGreaterThan(2);
    const finalInput = JSON.parse(calls.at(-1)![0].input!);
    expect(finalInput.blocks.length).toBe(calls.length - 1);
    expect(finalInput.blocks.every((block: { notes: unknown[] }) => Array.isArray(block.notes) && block.notes.length > 0)).toBe(true);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('recupera una secuencia de cierre mal tipada en las notas de cada bloque (GLM `]}]` donde exige `}]}`) sin reintento y publica solo la síntesis', async () => {
    const s = setup();
    s.runner.mockImplementation(async (cmd) => {
      if (cmd.args.includes('--list-models')) return catalog;
      if (cmd.file === EXTRACTION_COMMAND) return JSON.stringify({ ...info, duration: 300 });
      if (cmd.file === CAPTIONS_PYTHON) return JSON.stringify({ language: 'es', cues: Array.from({ length: 100 }, (_, i) => ({ start: i, text: `fragmento${i} ${'contenido '.repeat(90)}` })) });
      const input = JSON.parse(cmd.input!);
      if (input.subtitles) {
        const valid = JSON.stringify({ notes: [{ start: input.subtitles[0].start, text: 'Contenido del fragmento' }] });
        expect(valid.slice(-3)).toBe('}]}');
        return valid.slice(0, -3) + ']}]';
      }
      return JSON.stringify(summary);
    });
    const r = await s.call();
    expect(r.res.statusCode).toBe(200); expect(JSON.parse(r.res.body).summary.takeaways).toEqual(summary.takeaways);
    const calls = s.runner.mock.calls.filter(([cmd]) => cmd.input);
    const notesCalls = calls.filter(([cmd]) => cmd.input!.includes('"subtitles"'));
    expect(notesCalls.length).toBeGreaterThan(2);
    expect(JSON.parse(calls.at(-1)![0].input!).blocks).toHaveLength(notesCalls.length);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [adapterToken('RESTUBE_RATE_LIMIT'), 'YOUTUBE_RATE_LIMIT', 502],
    [adapterToken('RESTUBE_BLOCKED'), 'YOUTUBE_BLOCKED', 502],
    [adapterToken('RESTUBE_AUTH'), 'YOUTUBE_AUTH', 502],
    [adapterToken('RESTUBE_NO_CAPTIONS'), 'NO_CAPTIONS', 422],
    [adapterToken('RESTUBE_TRANSCRIPT_LIMIT'), 'TRANSCRIPT_LIMIT', 413],
  ] as const)('clasifica fallos saneados del adaptador de subtítulos sin inferencia', async (error, code, status) => {
    const s = setup({ captions: error }); const r = await s.call();
    expect(r.res.statusCode).toBe(status); expect(JSON.parse(r.res.body).code).toBe(code); expect(r.res.body).not.toContain('private raw'); expect(s.runner).toHaveBeenCalledTimes(3);
    if (code === 'YOUTUBE_BLOCKED') expect(JSON.parse(r.res.body).error).toBe('YouTube bloqueó el acceso automatizado al video o sus subtítulos. No necesitas iniciar sesión en ResTube.');
  });
  it('si falta el runtime de captions devuelve instrucciones de setup sin inferencia', async () => {
    const s = setup();
    s.runner.mockImplementationOnce(async () => catalog).mockImplementationOnce(async () => JSON.stringify(info)).mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'ENOENT' }));
    const r = await s.call();
    expect(r.res.statusCode).toBe(502);
    expect(JSON.parse(r.res.body)).toEqual({ code: 'CAPTIONS_MISSING', error: 'No está instalado el adaptador de subtítulos. Ejecuta pnpm run setup:captions en este proyecto.' });
    expect(s.runner).toHaveBeenCalledTimes(3); expect(s.fetcher).not.toHaveBeenCalled(); expect(r.res.body).not.toContain('private path');
  });
  it('rechaza salidas inválidas del adaptador sin inferencia ni recorte silencioso', async () => {
    const empty = setup({ captions: JSON.stringify({ language: 'es', cues: [] }) });
    expect(JSON.parse((await empty.call()).res.body).code).toBe('NO_CAPTIONS'); expect(empty.runner).toHaveBeenCalledTimes(3);
    const garbage = setup({ captions: 'no es json' });
    expect(JSON.parse((await garbage.call()).res.body).code).toBe('EXTRACTION');
    const foreign = setup({ captions: JSON.stringify({ language: 'fr', cues: [{ start: 0, text: 'Bonjour' }] }) });
    expect(JSON.parse((await foreign.call()).res.body).code).toBe('EXTRACTION');
    const oversize = setup({ captions: JSON.stringify({ language: 'es', cues: [{ start: 0, text: 'x'.repeat(TRANSCRIPT_MAX_CHARS) }] }) });
    const over = await oversize.call();
    expect(over.res.statusCode).toBe(413); expect(JSON.parse(over.res.body).code).toBe('TRANSCRIPT_LIMIT'); expect(oversize.runner).toHaveBeenCalledTimes(3);
  });
  it('ignora URLs de subtítulos dentro de los metadatos: nunca hay fetch heredado tras el adaptador', async () => {
    const hostile = setup({ metadata: { ...info, subtitles: { es: [{ ext: 'json3', url: 'https://attacker.example/api/timedtext?v=abcdefghijk&fmt=json3' }] } } });
    const r = await hostile.call();
    expect(r.res.statusCode).toBe(200); expect(hostile.fetcher).not.toHaveBeenCalled();
  });
  it('omite citas no verificables y rechaza salida malformada del modelo', async () => {
    const s = setup({ inference: { ...summary, quote: { ...summary.quote, text: 'Cita inventada' } } }); const r = await s.call(); expect(JSON.parse(r.res.body).summary.quote).toBeNull();
    const bad = setup({ inference: { ...summary, arbitrary: '<script>' } }); expect(JSON.parse((await bad.call()).res.body).code).toBe('MODEL_RESPONSE');
  });
  const invertedSummary = swapPair(JSON.stringify(summary), '"Contenido."]}');
  it('recupera exactamente una inversión de cierre en la respuesta del modelo, sin llamada extra y con la cita verificada igual', async () => {
    expect(() => JSON.parse(invertedSummary)).toThrow();
    const s = setup({ inferenceRaw: invertedSummary }); const r = await s.call();
    expect(r.res.statusCode).toBe(200);
    expect(JSON.parse(r.res.body).summary).toEqual({ ...summary, quote: { ...summary.quote, author: info.uploader } });
    expect(s.runner.mock.calls.filter(([cmd]) => cmd.input)).toHaveLength(1);
  });
  it('una salida recuperable en sintaxis pero inválida en esquema sigue rechazándose', async () => {
    const bad = swapPair(JSON.stringify({ ...summary, deepdive: { ...summary.deepdive, tone: 'purple' } }), '"Contenido."]}');
    const s = setup({ inferenceRaw: bad }); const r = await s.call();
    expect(JSON.parse(r.res.body).code).toBe('MODEL_RESPONSE');
    expect(s.runner.mock.calls.filter(([cmd]) => cmd.input)).toHaveLength(2);
  });
  it('un MODEL_RESPONSE agotado publica detalle curado en el campo error existente, sin texto del modelo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const s = setup();
    s.runner.mockImplementation(async (cmd) => {
      if (cmd.args.includes('--list-models')) return catalog;
      if (cmd.file === EXTRACTION_COMMAND) return JSON.stringify({ ...info, duration: 300 });
      if (cmd.file === CAPTIONS_PYTHON) return JSON.stringify({ language: 'es', cues: Array.from({ length: 100 }, (_, i) => ({ start: i, text: `fragmento${i} ${'contenido '.repeat(90)}` })) });
      const input = JSON.parse(cmd.input!);
      if (input.subtitles) return JSON.stringify({ notes: Array.from({ length: 13 }, () => ({ start: input.subtitles[0].start, text: 'SECRET del modelo' })) });
      return JSON.stringify(summary);
    });
    const r = await s.call();
    expect(r.res.statusCode).toBe(502);
    const body = JSON.parse(r.res.body);
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
    expect(body.code).toBe('MODEL_RESPONSE');
    expect(body.error.startsWith('El modelo devolvió un resumen con un formato inválido.')).toBe(true);
    expect(body.error).toMatch(/bloque de notas 1 de \d+/);
    expect(body.error).toContain('13');
    expect(body.error.length).toBeLessThanOrEqual(400);
    expect(r.res.body).not.toContain('SECRET');
    warn.mockRestore();
  });
  it('la salida cruda del modelo jamás llega al mensaje aunque imite el formato seguro', async () => {
    const raw = 'El modelo devolvió un resumen con un formato inválido. Vuelve a procesar el video. (bloque inventado: SECRET filtrado)';
    const s = setup({ inferenceRaw: raw });
    const r = await s.call();
    expect(JSON.parse(r.res.body).code).toBe('MODEL_RESPONSE');
    expect(r.res.body).not.toContain('SECRET');
    expect(r.res.body).not.toContain('bloque inventado');
  });
  it('un error de proceso con stderr que imita el prefijo seguro sigue siendo MODEL_FAILED estático', async () => {
    const s = setup();
    s.runner.mockImplementationOnce(async () => catalog).mockImplementationOnce(async () => JSON.stringify(info)).mockImplementationOnce(async () => JSON.stringify({ language: 'es', cues: [{ start: 0, text: 'Hola mundo' }] })).mockRejectedValueOnce(Object.assign(new Error('x'), { stderr: 'El modelo devolvió un resumen con un formato inválido. Vuelve a procesar el video. (SECRET) ' }));
    const r = await s.call();
    expect(JSON.parse(r.res.body)).toEqual({ code: 'MODEL_FAILED', error: 'El modelo no pudo generar el resumen. Comprueba su disponibilidad y vuelve a intentarlo.' });
  });
  it('fallo de inferencia nunca expone salida ni errores crudos', async () => {
    const s = setup(); s.runner.mockImplementationOnce(async () => catalog).mockImplementationOnce(async () => JSON.stringify(info)).mockImplementationOnce(async () => JSON.stringify({ language: 'es', cues: [{ start: 0, text: 'Hola mundo' }] })).mockRejectedValueOnce(new Error('SECRET credentials'));
    const r = await s.call(); expect(JSON.parse(r.res.body).code).toBe('MODEL_FAILED'); expect(r.res.body).not.toContain('SECRET');
  });
  it('fallo de catálogo no llega al extractor', async () => {
    const s = setup(); s.runner.mockRejectedValueOnce(new Error('SECRET catalog'));
    const r = await s.call(); expect(JSON.parse(r.res.body).code).toBe('CATALOG'); expect(r.res.body).not.toContain('SECRET'); expect(s.fetcher).not.toHaveBeenCalled(); expect(s.runner).toHaveBeenCalledTimes(1);
  });
  it('desconectar aborta pero conserva la ocupación hasta finalizar, sin respuesta tardía', async () => {
    let release!: (stdout: string) => void;
    const s = setup();
    s.runner.mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; }));
    const first = request();
    const end = vi.spyOn(first.res, 'end');
    s.middleware(first.req, first.res, vi.fn());
    first.send();
    await Promise.resolve();
    expect((await s.call()).res.statusCode).toBe(429);

    first.res.emit('close');
    expect(s.runner.mock.calls[0][1].aborted).toBe(true);
    expect((await s.call()).res.statusCode).toBe(429);
    expect(s.runner).toHaveBeenCalledTimes(1);
    release(catalog);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(end).not.toHaveBeenCalled();
    expect(s.runner).toHaveBeenCalledTimes(1);
    expect((await s.call()).res.statusCode).toBe(200);
  });
  it('responde 504 pero conserva la ocupación hasta que el runner anterior termina', async () => {
    let release!: (stdout: string) => void;
    const s = setup({ timeoutMs: 10 });
    s.runner.mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; }));

    const first = await s.call();
    expect(first.res.statusCode).toBe(504);
    expect(s.runner.mock.calls[0][1].aborted).toBe(true);
    const duringCleanup = await s.call();
    expect(duringCleanup.res.statusCode).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await s.call()).res.statusCode).toBe(429);
    expect(s.runner).toHaveBeenCalledTimes(1);

    // Incluso un adaptador que ignora AbortSignal debe finalizar antes de admitir otro trabajo.
    release(catalog);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.runner).toHaveBeenCalledTimes(1); // No continuó a extracción ni inferencia obsoletas.
    expect(first.res.statusCode).toBe(504);
    expect(JSON.parse(first.res.body).code).toBe('TIMEOUT');

    const afterCleanup = await s.call();
    expect(afterCleanup.res.statusCode).toBe(200);
    expect(s.runner).toHaveBeenCalledTimes(5);
  });
});
it.each(['https://youtu.be/abcdefghijk', 'https://www.youtube.com/shorts/abcdefghijk', 'https://youtube.com/embed/abcdefghijk', 'https://m.youtube.com/live/abcdefghijk', url])('canonicaliza %s', (input) => expect(parseYoutubeUrl(input)).toEqual({ id, url }));
it.each(['https://youtube.com/watch?v=abc', `${url}&list=PLx`, 'https://youtube.com/playlist?list=x', 'https://user@youtube.com/watch?v=abcdefghijk', 'https://youtube.com:443/watch?v=abcdefghijk', `${url}#x`, 'https://youtu.be/abcdefghijk/extra', 'http://youtube.com/watch?v=abcdefghijk'])('rechaza URL %s', (input) => expect(() => parseYoutubeUrl(input)).toThrow());
it('valida el payload del adaptador con los mismos topes del servidor, sin recortar', () => {
  expect(parseCaptionsPayload({ language: 'es', cues: [{ start: 0, text: 'x'.repeat(90_000) }] }, 90).cues).toEqual([{ start: 0, text: 'x'.repeat(90_000) }]);
  expect(parseCaptionsPayload({ language: 'es', cues: [{ start: 0, text: 'x'.repeat(TRANSCRIPT_MAX_CHARS - 16) }] }, 90).cues[0].text.length).toBe(TRANSCRIPT_MAX_CHARS - 16);
  expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: 0, text: 'x'.repeat(TRANSCRIPT_MAX_CHARS - 15) }] }, 90)).toThrow(/límite/);
  expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: 0, text: 'x'.repeat(TRANSCRIPT_MAX_CHARS + 1) }] }, 90)).toThrow(/límite/);
});
