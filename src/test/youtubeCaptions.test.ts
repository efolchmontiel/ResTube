// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  CAPTIONS_ARGS, CAPTIONS_PYTHON, CAPTIONS_SCRIPT, CAPTIONS_TIMEOUT_MS,
  EXTRACTION_ARGS, EXTRACTION_COMMAND, TRANSCRIPT_MAX_CHARS,
  captionsError, extractYoutube, parseCaptionsPayload, parseYoutubeUrl,
} from '../../server/youtube';
import type { CommandRunner } from '../../server/processRunner';
import { runCommand } from '../../server/processRunner';
import { SUMMARY_ERRORS, SummaryError } from '../../src/data/summary';

const id = 'abcdefghijk'; const url = `https://www.youtube.com/watch?v=${id}`;
const metadata = JSON.stringify({ id, title: 'Título extraído', uploader: 'Autor extraído', duration: 90 });
const validPayload = { language: 'es', cues: [{ start: 0, text: 'Hola mundo' }] };

function runnerWith(stdoutByFile: Partial<Record<string, string | Error>> = {}, metadataStdout = metadata) {
  const calls: { cmd: Parameters<CommandRunner>[0]; signal: AbortSignal }[] = [];
  const runner = vi.fn<CommandRunner>(async (cmd, signal) => {
    calls.push({ cmd, signal });
    if (cmd.args.includes('--list-models')) return 'provider model context max-out thinking images\nfixture model-a 128K 8K no no\n';
    if (cmd.file === EXTRACTION_COMMAND) return metadataStdout;
    if (cmd.file === CAPTIONS_PYTHON) {
      const out = stdoutByFile[cmd.file];
      if (out instanceof Error) throw out;
      return out ?? JSON.stringify(validPayload);
    }
    return JSON.stringify({ takeaways: [{ num: '01', time: '00:00', heading: 'Resultado', text: 'Texto.' }], deepdive: { heading: 'Análisis', tone: 'accent', paragraphs: ['P.'] }, actions: { heading: 'Pasos', tone: 'blue', items: ['A.'] }, quote: null });
  });
  return { runner, calls };
}
const extract = (runner: CommandRunner, signal = new AbortController().signal) => extractYoutube(parseYoutubeUrl(url), runner, vi.fn(), signal);

describe('adaptador de subtítulos tubescrape', () => {
  it('usa argv fijo del venv de captions sin URLs, shell ni fetch del navegador', async () => {
    const s = runnerWith(); const transcript = await extract(s.runner);
    expect(transcript.video).toEqual({ source: 'youtube', id, url, title: 'Título extraído', author: 'Autor extraído', duration: 90, language: 'es' });
    expect(transcript.cues).toEqual(validPayload.cues);
    const captions = s.calls[1].cmd;
    expect(captions.file).toMatch(/\.tools\/captions\/python\/bin\/python3$/);
    expect(captions.args).toEqual([...CAPTIONS_ARGS, id]);
    expect(CAPTIONS_ARGS[0]).toBe('-I');
    expect(CAPTIONS_ARGS[1]).toMatch(/scripts\/youtube_captions\.py$/);
    expect(CAPTIONS_ARGS.slice(2)).toEqual(['--video-id']);
    expect(captions.args.join(' ')).not.toContain('http');
    expect(captions.cleanEnv).toBe(true);
    expect(captions.timeout).toBe(CAPTIONS_TIMEOUT_MS);
    expect(captions.timeout).toBeGreaterThan(0);
    expect(captions.maxBuffer).toBeGreaterThan(0);
  });

  it('conserva la extracción de metadatos yt-dlp módulo-relativa y no consulta URLs de subtítulos heredadas', async () => {
    const hostileMetadata = JSON.stringify({ id, title: 'T', uploader: 'A', duration: 90, subtitles: { es: [{ ext: 'json3', url: 'https://attacker.example/api/timedtext?v=abcdefghijk' }] } });
    const s = runnerWith({}, hostileMetadata);
    await extract(s.runner);
    const extraction = s.calls[0].cmd;
    expect(extraction.file).toBe(EXTRACTION_COMMAND);
    expect(extraction.args).toEqual([...EXTRACTION_ARGS, '--', url]);
    expect(s.calls.length).toBe(2); // extractYoutube: metadatos + captions; la inferencia vive en la ruta.
  });

  it('aborta entre metadatos y captions sin pedir subtítulos ni inferencia', async () => {
    const controller = new AbortController();
    let captionsCalls = 0;
    const runner: CommandRunner = async (cmd, signal) => {
      if (cmd.file === CAPTIONS_PYTHON) { captionsCalls += 1; return JSON.stringify(validPayload); }
      if (cmd.file === EXTRACTION_COMMAND) { controller.abort(); return metadata; }
      throw new Error('llamada inesperada');
    };
    await expect(extract(runner, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(captionsCalls).toBe(0);
  });

  it('falla sin inferencia cuando el runtime de captions falta o sale mal', async () => {
    const missing = runnerWith();
    missing.runner.mockImplementationOnce(async () => metadata).mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'ENOENT' }));
    await expect(extract(missing.runner)).rejects.toMatchObject({ code: 'CAPTIONS_MISSING' });
    const failed = runnerWith({ [CAPTIONS_PYTHON]: Object.assign(new Error('private raw'), { stderr: '{"error":"RESTUBE_BLOCKED"}' }) });
    await expect(extract(failed.runner)).rejects.toMatchObject({ code: 'YOUTUBE_BLOCKED' });
    expect(failed.calls.length).toBe(2);
    const garbage = runnerWith({ [CAPTIONS_PYTHON]: 'no es json' });
    await expect(extract(garbage.runner)).rejects.toMatchObject({ code: 'EXTRACTION' });
  });

  it('valida el JSON del adaptador en TypeScript: claves exactas, idioma, orden y topes', () => {
    expect(parseCaptionsPayload(validPayload, 90)).toEqual(validPayload);
    expect(parseCaptionsPayload({ language: 'es-419', cues: [{ start: 0, text: 'Hola' }, { start: 0, text: 'otra' }] }, 90).cues.length).toBe(2);
    // Claves exactas.
    expect(() => parseCaptionsPayload({ ...validPayload, extra: 1 }, 90)).toThrow(/inválido|subtítulos/);
    expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: 0, text: 'Hola', dur: 1 }] }, 90)).toThrow();
    expect(() => parseCaptionsPayload({ language: 'es', cues: [{ text: 'Hola' }] }, 90)).toThrow();
    expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: '0', text: 'Hola' }] }, 90)).toThrow();
    // Idioma aceptado: es/en y variantes, nada más.
    expect(parseCaptionsPayload({ language: 'en', cues: [{ start: 0, text: 'Hello' }] }, 90).language).toBe('en');
    expect(() => parseCaptionsPayload({ language: 'fr', cues: [{ start: 0, text: 'Hola' }] }, 90)).toThrow();
    expect(() => parseCaptionsPayload({ language: 'es\x00', cues: [{ start: 0, text: 'Hola' }] }, 90)).toThrow();
    // Vacío, orden y topes contra la duración.
    expect(() => parseCaptionsPayload({ language: 'es', cues: [] }, 90)).toThrow(/subtítulos JSON3|No hay/);
    expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: -1, text: 'x' }] }, 90)).toThrow();
    expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: 90, text: 'x' }, { start: 89, text: 'y' }] }, 90)).toThrow();
    expect(parseCaptionsPayload({ language: 'es', cues: [{ start: 90.5, text: 'cierre' }] }, 90).cues.length).toBe(1);
    expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: 92, text: 'x' }] }, 90)).toThrow();
    expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: 0, text: ' ' }] }, 90)).toThrow(/No hay/);
    expect(() => parseCaptionsPayload({ language: 'es', cues: Array.from({ length: 12_001 }, (_, i) => ({ start: i, text: 'x' })) }, 90)).toThrow(/límite/);
    expect(() => parseCaptionsPayload({ language: 'es', cues: [{ start: 0, text: 'x'.repeat(TRANSCRIPT_MAX_CHARS) }] }, 90)).toThrow(/límite/);
  });

  it('clasifica errores del adaptador en códigos fijos sin filtrar contenido crudo', () => {
    // runCommand conserva stderr en el rechazo, no stdout: los tokens fijos llegan por stderr.
    const token = (t: string) => Object.assign(new Error('private raw'), { stderr: `{"error":"${t}"}` });
    expect(captionsError(token('RESTUBE_RATE_LIMIT')).code).toBe('YOUTUBE_RATE_LIMIT');
    expect(captionsError(token('RESTUBE_AUTH')).code).toBe('YOUTUBE_AUTH');
    expect(captionsError(token('RESTUBE_BLOCKED')).code).toBe('YOUTUBE_BLOCKED');
    expect(captionsError(token('RESTUBE_UNAVAILABLE')).code).toBe('YOUTUBE_UNAVAILABLE');
    expect(captionsError(token('RESTUBE_NO_CAPTIONS')).code).toBe('NO_CAPTIONS');
    expect(captionsError(token('RESTUBE_TRANSCRIPT_LIMIT')).code).toBe('TRANSCRIPT_LIMIT');
    expect(captionsError(token('RESTUBE_TIMEOUT')).code).toBe('TIMEOUT');
    expect(captionsError(token('RESTUBE_UNKNOWN')).code).toBe('EXTRACTION');
    expect(captionsError(token('RESTUBE_{"leak":1}')).code).toBe('EXTRACTION');
    expect(captionsError(Object.assign(new Error('x'), { stderr: '{"error":"RESTUBE_RATE_LIMIT"} extra' })).code).toBe('EXTRACTION');
    expect(captionsError(Object.assign(new Error('x'), { stdout: '{"error":"RESTUBE_RATE_LIMIT"}' })).code).toBe('EXTRACTION'); // stdout no es la fuente
    expect(captionsError(new Error('secret')).message).not.toContain('secret');
    expect(captionsError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).code).toBe('TIMEOUT');
  });

  it('runCommand real: los siete tokens fijos por stderr se mapean exactamente sin depender de stdout', async () => {
    const cases = [
      ['RESTUBE_RATE_LIMIT', 'YOUTUBE_RATE_LIMIT'], ['RESTUBE_AUTH', 'YOUTUBE_AUTH'], ['RESTUBE_BLOCKED', 'YOUTUBE_BLOCKED'],
      ['RESTUBE_UNAVAILABLE', 'YOUTUBE_UNAVAILABLE'], ['RESTUBE_NO_CAPTIONS', 'NO_CAPTIONS'],
      ['RESTUBE_TRANSCRIPT_LIMIT', 'TRANSCRIPT_LIMIT'], ['RESTUBE_TIMEOUT', 'TIMEOUT'],
    ] as const;
    for (const [token, code] of cases) {
      // Hijo local inofensivo: ruido por stdout, token fijo compacto por stderr y salida 1.
      const child = `process.stdout.write('STDOUT-NOISE'); process.stderr.write(JSON.stringify({error: ${JSON.stringify(token)}}) + "\\n"); process.exit(1)`;
      const failure = await extractYoutubeCaptionsErrorViaRealRunner(child);
      expect(failure.code).toBe(code);
      expect(failure.message).toBe(SUMMARY_ERRORS[code]); // mensaje fijo seguro, sin ruido ni raw
      expect(failure.message).not.toContain('NOISE');
      expect(failure.message).not.toContain(token);
    }
    const garbage = `process.stdout.write('NOISE'); process.stderr.write('fallo privado sin token'); process.exit(1)`;
    expect((await extractYoutubeCaptionsErrorViaRealRunner(garbage)).code).toBe('EXTRACTION');
  });
});

/** Regresión B2: el seam real (runCommand → captionsError) con un hijo local inofensivo. */
async function extractYoutubeCaptionsErrorViaRealRunner(childScript: string): Promise<SummaryError> {
  try {
    await runCommand({ file: 'node', args: ['-e', childScript], timeout: 15_000, maxBuffer: 1024 * 1024 }, new AbortController().signal);
    throw new Error('el hijo debía fallar');
  } catch (error) { return captionsError(error); }
}
