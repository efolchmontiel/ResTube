import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { keys, record, text, SummaryError, type SummaryErrorCode } from '../src/data/summary';
import { TRANSCRIPT_MAX_CHARS, type Cue } from './youtube';
import type { CommandRunner } from './processRunner';

export const LOCAL_UPLOAD_PATH = '/api/summarize-local';
export const LOCAL_MAX_UPLOAD_BYTES = 134_217_728; // 128 MiB de video, medidos al transmitir.
export const LOCAL_MAX_DURATION_SECONDS = 7200; // 2 h de contenido.
export const LOCAL_UPLOAD_TIMEOUT_MS = 120_000; // Subida completa acotada.
export const LOCAL_TRANSCRIBE_TIMEOUT_MS = 1_500_000; // CPU int8 Base: ~4x tiempo real de un video de 2 h.
export const LOCAL_TOTAL_TIMEOUT_MS = 1_800_000; // Subida + transcripción + inferencia.
export const LOCAL_CUES_MAX = 12_000;
export const TRANSCRIBE_COMMAND = resolve(dirname(fileURLToPath(import.meta.url)), '../.tools/python/bin/python3');
export const TRANSCRIBE_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/transcribe.py');
export const TRANSCRIBE_MAX_BUFFER = 4 * 1024 * 1024;

export interface LocalTranscription { duration: number; language: string; cues: Cue[] }

/** Solo se usa como título visible: jamás construye una ruta del servidor. */
export function sanitizeFilename(input: string): string {
  return input.replace(/\\/g, '/').split('/').pop()!.trim();
}

/** Valida el JSON único del wrapper local con límites estrictos; nunca texto crudo. */
export function parseTranscription(stdout: string): LocalTranscription {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new SummaryError('TRANSCRIPTION'); }
  if (!record(value) || !keys(value, ['duration', 'language', 'cues'])) throw new SummaryError('TRANSCRIPTION');
  const { duration, language, cues } = value;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new SummaryError('TRANSCRIPTION');
  if (duration > LOCAL_MAX_DURATION_SECONDS) throw new SummaryError('FILE_DURATION');
  if (!text(language, 40)) throw new SummaryError('TRANSCRIPTION');
  if (!Array.isArray(cues)) throw new SummaryError('TRANSCRIPTION');
  if (!cues.length) throw new SummaryError('FILE_INVALID');
  if (cues.length > LOCAL_CUES_MAX) throw new SummaryError('TRANSCRIPT_LIMIT');
  let characters = 0;
  const parsed: Cue[] = [];
  for (const cue of cues) {
    if (!record(cue) || !keys(cue, ['start', 'text'])) throw new SummaryError('TRANSCRIPTION');
    const { start, text: content } = cue;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start > duration) throw new SummaryError('TRANSCRIPTION');
    if (!text(content)) throw new SummaryError('TRANSCRIPTION');
    characters += content.length + 16;
    if (characters > TRANSCRIPT_MAX_CHARS) throw new SummaryError('TRANSCRIPT_LIMIT');
    parsed.push({ start, text: content });
  }
  return { duration, language, cues: parsed };
}

/** Tokens cerrados que el wrapper puede reportar; cualquier otra salida es TRANSCRIPTION. */
const WRAPPER_CODES: readonly SummaryErrorCode[] = ['FILE_INVALID', 'FILE_DURATION', 'TRANSCRIPT_LIMIT', 'TRANSCRIBER_MISSING', 'TRANSCRIPTION'];
export function transcriberError(error: unknown): SummaryError {
  if ((error as { code?: unknown } | null)?.code === 'ENOENT') return new SummaryError('TRANSCRIBER_MISSING');
  const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? '');
  const match = /RESTUBE_ERROR:([A-Z_]+)/.exec(stderr);
  if (match && (WRAPPER_CODES as string[]).includes(match[1])) return new SummaryError(match[1] as SummaryErrorCode);
  return new SummaryError('TRANSCRIPTION');
}

/** Comando fijo: intérprete gestionado del proyecto + script + --media con la ruta del archivo subido. */
export function transcriberCommand(mediaPath: string) {
  return { file: TRANSCRIBE_COMMAND, args: [TRANSCRIBE_SCRIPT, '--media', mediaPath], timeout: LOCAL_TRANSCRIBE_TIMEOUT_MS, maxBuffer: TRANSCRIBE_MAX_BUFFER, cleanEnv: true };
}

/** Transcribe el archivo ya almacenado localmente; el wrapper carga solo rutas locales offline. */
export async function transcribeLocal(mediaPath: string, runner: CommandRunner, signal: AbortSignal): Promise<LocalTranscription> {
  let stdout: string;
  try {
    stdout = await runner(transcriberCommand(mediaPath), signal);
  } catch (error) { throw transcriberError(error); }
  signal.throwIfAborted();
  return parseTranscription(stdout);
}
