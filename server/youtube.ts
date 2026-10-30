import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { keys, record, text, SummaryError, type SummaryErrorCode, type VideoData } from '../src/data/summary';
import { canonicalYoutube } from '../src/data/youtubeUrl';
import type { CommandRunner } from './processRunner';

export const EXTRACTION_COMMAND = resolve(dirname(fileURLToPath(import.meta.url)), '../.tools/yt-dlp');
export const EXTRACTION_ARGS = ['--ignore-config', '--no-cache-dir', '--skip-download', '--ignore-no-formats-error', '--dump-single-json', '--no-playlist', '--no-warnings', '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0'] as const;
export const TRANSCRIPT_MAX_CHARS = 240_000;
export interface Cue { start: number; text: string }
export interface Transcript { video: VideoData; cues: Cue[] }
/** Solo estas formas se convierten en un watch canónico, nunca se envía la URL original al CLI. */
export function parseYoutubeUrl(input: string): { id: string; url: string } {
  const source = canonicalYoutube(input);
  if (!source) throw new SummaryError('URL');
  return source;
}
function extractionError(error: unknown): SummaryError {
  if ((error as { code?: unknown } | null)?.code === 'ENOENT') return new SummaryError('EXTRACTOR_MISSING');
  const raw = record(error) || error instanceof Error ? `${(error as { stderr?: string }).stderr ?? ''} ${String(error)}`.toLowerCase() : '';
  if (/429|too many requests/.test(raw)) return new SummaryError('YOUTUBE_RATE_LIMIT');
  if (/not a bot|confirm.*bot|bot verification|http(?: error)?\s*403\b|\bforbidden\b/.test(raw)) return new SummaryError('YOUTUBE_BLOCKED');
  if (/sign in|log.?in/.test(raw)) return new SummaryError('YOUTUBE_AUTH');
  if (/private video|not available|unavailable|removed|members.only/.test(raw)) return new SummaryError('YOUTUBE_UNAVAILABLE');
  return new SummaryError('EXTRACTION');
}
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
const MAX_CUES = 12_000;
const CUE_ACCOUNT_CHARS = 16;
/** Margen de 1 s para cierres de cue reportados justo al final del video. */
const CUE_END_EPSILON = 1;
const ACCEPTED_LANGUAGE = /^(?:es|en)(?:-|$)/;
/**
 * Valida el JSON estricto {language,cues:[{start,text}]} del adaptador de subtítulos.
 * Exactitud de claves, idioma aceptado, orden no decreciente, tiempos dentro de la duración
 * del video, texto no vacío y topes de cantidad/caracteres: nunca se recorta en silencio.
 */
export function parseCaptionsPayload(value: unknown, duration: number): { language: string; cues: Cue[] } {
  if (!record(value) || !keys(value, ['language', 'cues']) || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new SummaryError('EXTRACTION');
  if (!text(value.language, 40) || !ACCEPTED_LANGUAGE.test(value.language)) throw new SummaryError('EXTRACTION');
  if (!Array.isArray(value.cues) || !value.cues.length) throw new SummaryError('NO_CAPTIONS');
  if (value.cues.length > MAX_CUES) throw new SummaryError('TRANSCRIPT_LIMIT');
  const cues: Cue[] = [];
  let total = 0;
  let previousStart = -1;
  for (const cue of value.cues) {
    if (!record(cue) || !keys(cue, ['start', 'text'])) throw new SummaryError('EXTRACTION');
    if (typeof cue.start !== 'number' || !Number.isFinite(cue.start) || cue.start < 0 || cue.start > duration + CUE_END_EPSILON) throw new SummaryError('EXTRACTION');
    if (cue.start < previousStart) throw new SummaryError('EXTRACTION');
    if (typeof cue.text !== 'string') throw new SummaryError('EXTRACTION');
    previousStart = cue.start;
    const line = normalize(cue.text);
    const characters = line.length + CUE_ACCOUNT_CHARS;
    // Tope por cue y agregado antes de cualquier otra validación de texto: nunca se recorta.
    if (characters > TRANSCRIPT_MAX_CHARS) throw new SummaryError('TRANSCRIPT_LIMIT');
    if (!line) continue;
    if (!text(cue.text, TRANSCRIPT_MAX_CHARS)) throw new SummaryError('EXTRACTION');
    total += characters;
    if (total > TRANSCRIPT_MAX_CHARS) throw new SummaryError('TRANSCRIPT_LIMIT');
    cues.push({ start: cue.start, text: line });
  }
  if (!cues.length) throw new SummaryError('NO_CAPTIONS');
  return { language: value.language, cues };
}
/** Tokens fijos del adaptador Python (por stderr: runCommand conserva stderr en el
 *  rechazo y execFile no adjunta stdout): nunca texto de excepciones, URLs ni transcripciones. */
const CAPTION_ERROR_CODES = {
  RESTUBE_RATE_LIMIT: 'YOUTUBE_RATE_LIMIT',
  RESTUBE_AUTH: 'YOUTUBE_AUTH',
  RESTUBE_BLOCKED: 'YOUTUBE_BLOCKED',
  RESTUBE_UNAVAILABLE: 'YOUTUBE_UNAVAILABLE',
  RESTUBE_NO_CAPTIONS: 'NO_CAPTIONS',
  RESTUBE_TRANSCRIPT_LIMIT: 'TRANSCRIPT_LIMIT',
  RESTUBE_TIMEOUT: 'TIMEOUT',
} satisfies Record<string, SummaryErrorCode>;
export function captionsError(error: unknown): SummaryError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return new SummaryError('CAPTIONS_MISSING');
  if (code === 'ETIMEDOUT') return new SummaryError('TIMEOUT');
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const match = typeof stderr === 'string' ? stderr.match(/^\s*\{"error":"(RESTUBE_[A-Z_]+)"\}\s*$/) : null;
  const mapped = match ? (CAPTION_ERROR_CODES as Record<string, SummaryErrorCode | undefined>)[match[1]] : undefined;
  return new SummaryError(mapped ?? 'EXTRACTION');
}
/** Intérprete del venv de captions; el setup real lo instala el padre con pnpm run setup:captions. */
export const CAPTIONS_PYTHON = resolve(dirname(fileURLToPath(import.meta.url)), '../.tools/captions/python/bin/python3');
export const CAPTIONS_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/youtube_captions.py');
/** Argv fijo: -I aísla el intérprete (sin cwd/PYTHONPATH/entorno); el ID viaja como valor exacto. */
export const CAPTIONS_ARGS = ['-I', CAPTIONS_SCRIPT, '--video-id'] as const;
export const CAPTIONS_TIMEOUT_MS = 90_000;
const CAPTIONS_MAX_BUFFER = 4 * 1024 * 1024;
export async function extractYoutube(source: { id: string; url: string }, runner: CommandRunner, fetcher: typeof fetch, signal: AbortSignal): Promise<Transcript> {
  let stdout: string;
  try {
    stdout = await runner({ file: EXTRACTION_COMMAND, args: [...EXTRACTION_ARGS, '--', source.url], timeout: 30_000, maxBuffer: 4 * 1024 * 1024, cleanEnv: true }, signal);
  } catch (error) { throw extractionError(error); }
  signal.throwIfAborted();
  let info: unknown;
  try {
    info = JSON.parse(stdout);
    if (!record(info) || info.id !== source.id || !text(info.title, 500) || !text(info.uploader ?? info.channel, 300) || typeof info.duration !== 'number' || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 604800) throw 0;
    if (info.is_live === true || info.live_status === 'is_upcoming') throw new SummaryError('YOUTUBE_UNAVAILABLE');
  } catch (error) { if (error instanceof SummaryError) throw error; throw new SummaryError('EXTRACTION'); }
  signal.throwIfAborted();
  let payload: string;
  try {
    payload = await runner({ file: CAPTIONS_PYTHON, args: [...CAPTIONS_ARGS, source.id], timeout: CAPTIONS_TIMEOUT_MS, maxBuffer: CAPTIONS_MAX_BUFFER, cleanEnv: true }, signal);
  } catch (error) { throw captionsError(error); }
  signal.throwIfAborted();
  try {
    const parsed: unknown = JSON.parse(payload);
    const { language, cues } = parseCaptionsPayload(parsed, info.duration);
    return { video: { source: 'youtube' as const, ...source, title: info.title, author: (info.uploader ?? info.channel) as string, duration: info.duration, language }, cues };
  } catch (error) { if (error instanceof SummaryError) throw error; throw new SummaryError('EXTRACTION'); }
}
