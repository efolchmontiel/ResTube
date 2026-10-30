import type { Actions, DeepDive, Quote, Takeaway } from './models';
import { canonicalYoutube } from './youtubeUrl';

export interface YoutubeVideoData { source: 'youtube'; id: string; url: string; title: string; author: string; duration: number; language: string }
/** El servidor genera un id opaco y nunca envía rutas ni blob URLs: el título es el nombre del archivo. */
export interface LocalVideoData { source: 'local'; id: string; url: null; title: string; author: string; duration: number; language: string }
export type VideoData = YoutubeVideoData | LocalVideoData;
export const LOCAL_UPLOAD_ENDPOINT = '/api/summarize-local';
export const LOCAL_MAX_UPLOAD_BYTES = 134_217_728; // 128 MiB, el servidor aplica el límite real.
export const LOCAL_MAX_DURATION_SECONDS = 7200; // 2 h
export interface SummaryData { takeaways: Takeaway[]; deepdive: DeepDive; actions: Actions; quote: Quote | null }
export interface SummaryResult { video: VideoData; summary: SummaryData; model: { provider: string; id: string; name: string } }
/** Uniform time display: accepts m:ss, mm:ss and h:mm:ss and pads each short segment. */
export function displayTime(value: string): string {
  return value.split(':').map((part, index, parts) => (index === parts.length - 1 ? part : part.padStart(2, '0'))).join(':');
}
/** Video length: h:mm:ss from one hour on, mm:ss below it. */
export function displayDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const rest = total % 60;
  const tail = `${String(minutes).padStart(hours ? 2 : 1, '0')}:${String(rest).padStart(2, '0')}`;
  return hours ? `${hours}:${tail}` : tail;
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key));
}
export function text(value: unknown, max = 4000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
const tone = (value: unknown) => ['accent', 'blue', 'green', 'yellow'].includes(value as string);
const texts = (value: unknown, maxItems = 12) => Array.isArray(value) && value.length > 0 && value.length <= maxItems && value.every((item) => text(item));
export function validSummary(value: unknown): value is SummaryData {
  if (!record(value) || !keys(value, ['takeaways', 'deepdive', 'actions', 'quote'])) return false;
  const { takeaways, deepdive: d, actions: a, quote: q } = value;
  return Array.isArray(takeaways) && takeaways.length > 0 && takeaways.length <= 20 && takeaways.every((t) =>
    record(t) && keys(t, ['num', 'time', 'heading', 'text']) && text(t.num, 8) && text(t.time, 12) && /^\d{1,3}:\d{2}(?::\d{2})?$/.test(t.time) && text(t.heading, 300) && text(t.text)) &&
    record(d) && keys(d, ['heading', 'tone', 'paragraphs'], ['code']) && text(d.heading, 300) && tone(d.tone) && texts(d.paragraphs) && (d.code === undefined || text(d.code, 8000)) &&
    record(a) && keys(a, ['heading', 'tone'], ['items', 'paragraph']) && text(a.heading, 300) && tone(a.tone) && (a.items === undefined || texts(a.items, 20)) && (a.paragraph === undefined || text(a.paragraph)) && (a.items !== undefined || a.paragraph !== undefined) &&
    (q === null || (record(q) && keys(q, ['text', 'author', 'tone']) && text(q.text, 2000) && text(q.author, 300) && tone(q.tone)));
}
const youtubeDuration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 604800;
const localDuration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= LOCAL_MAX_DURATION_SECONDS;
/** Discriminada por origen: un archivo local jamás imita un id/URL de YouTube ni al revés. */
export function validResult(value: unknown): value is SummaryResult {
  if (!record(value) || !keys(value, ['video', 'summary', 'model'])) return false;
  const { video: v, model: m } = value;
  if (!(record(v) && keys(v, ['source', 'id', 'url', 'title', 'author', 'duration', 'language']))) return false;
  const videoValid = v.source === 'youtube' ? typeof v.id === 'string' && /^[\w-]{11}$/.test(v.id) &&
    v.url === `https://www.youtube.com/watch?v=${v.id}` && text(v.title, 500) && text(v.author, 300) && youtubeDuration(v.duration) && text(v.language, 40) :
    v.source === 'local' && typeof v.id === 'string' && /^[a-f0-9]{32}$/.test(v.id) && v.url === null && text(v.title, 500) &&
    v.author === 'Archivo local' && localDuration(v.duration) && text(v.language, 40);
  return videoValid && record(m) && keys(m, ['provider', 'id', 'name']) && text(m.provider, 200) && text(m.id, 300) && text(m.name, 300) && validSummary(value.summary);
}
export const SUMMARY_ERRORS = {
  BAD_REQUEST: 'Petición inválida. Envía una URL de YouTube y un modelo del catálogo.',
  LOCAL_REQUEST: 'Petición inválida. Envía un archivo de video con el modelo del catálogo en las cabeceras fijas.',
  FILE_TYPE: 'Usa un archivo de video local: el envío requiere un tipo de contenido de video.',
  FILE_LIMIT: 'El archivo supera el límite de 128 MiB para procesamiento local.',
  FILE_DURATION: 'El video supera el límite de 2 horas para transcripción local.',
  FILE_INVALID: 'El archivo no se pudo decodificar como video o no contiene habla transcribible. Prueba con otro archivo.',
  TRANSCRIBER_MISSING: 'No está instalado el transcriptor local. Ejecuta pnpm run setup:transcription en este proyecto.',
  TRANSCRIPTION: 'No se pudo transcribir el audio del archivo localmente. Prueba con otro archivo.',
  FORBIDDEN: 'Acceso permitido solo desde la propia aplicación local.',
  METHOD: 'Método no permitido: usa POST.',
  CONTENT_TYPE: 'Usa application/json para procesar el video.',
  BODY_LIMIT: 'La petición supera el límite de 4 KiB.',
  URL: 'Usa un enlace de un video de YouTube, sin listas de reproducción ni credenciales.',
  MODEL: 'El modelo ya no está disponible. Actualiza el catálogo y selecciona uno.',
  CATALOG: 'No se pudo consultar el catálogo conectado. Actualízalo e inténtalo de nuevo.',
  BUSY: 'Ya hay un procesamiento activo. Espera a que termine antes de volver a intentarlo.',
  YOUTUBE_RATE_LIMIT: 'YouTube limitó las consultas (429). Espera antes de volver a intentarlo.',
  YOUTUBE_AUTH: 'YouTube rechazó el acceso a este contenido por autenticación. ResTube no inicia sesión ni usa cookies. Usa un video público accesible.',
  YOUTUBE_BLOCKED: 'YouTube bloqueó el acceso automatizado al video o sus subtítulos. No necesitas iniciar sesión en ResTube.',
  YOUTUBE_UNAVAILABLE: 'El video es privado, no está disponible o sigue en directo. Usa un video público finalizado.',
  NO_CAPTIONS: 'No hay subtítulos JSON3 accesibles en español o inglés. Prueba otro video con subtítulos.',
  CAPTION_URL: 'YouTube no proporcionó una dirección de subtítulos segura para este video.',
  TRANSCRIPT_LIMIT: 'Los subtítulos superan el límite de procesamiento por bloques. No se recortó el contenido. Usa un video más corto.',
  EXTRACTOR_MISSING: 'No está instalado el extractor local. Ejecuta pnpm run setup:yt-dlp en este proyecto.',
  CAPTIONS_MISSING: 'No está instalado el adaptador de subtítulos. Ejecuta pnpm run setup:captions en este proyecto.',
  EXTRACTION: 'No se pudieron obtener los subtítulos de YouTube. Comprueba el acceso al video e inténtalo de nuevo.',
  MODEL_FAILED: 'El modelo no pudo generar el resumen. Comprueba su disponibilidad y vuelve a intentarlo.',
  MODEL_RESPONSE: 'El modelo devolvió un resumen con un formato inválido. Vuelve a procesar el video.',
  TIMEOUT: 'Se agotó el tiempo de procesamiento. Puedes volver a intentarlo.',
  NETWORK: 'No se pudo contactar al servidor local. Comprueba que ResTube siga abierto.',
} as const;
export type SummaryErrorCode = keyof typeof SUMMARY_ERRORS;
export const MODEL_RESPONSE_DETAIL_LIMIT = 400;
/** Detalle MODEL_RESPONSE confiable: prefijo canónico más contexto acotado entre paréntesis, sin caracteres de control. */
export function modelResponseDetail(value: unknown): string | null {
  const base = SUMMARY_ERRORS.MODEL_RESPONSE;
  if (typeof value !== 'string' || !value.startsWith(`${base} (`) || value.length > MODEL_RESPONSE_DETAIL_LIMIT) return null;
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
}
export class SummaryError extends Error {
  constructor(public code: SummaryErrorCode, detail?: string) { super(detail ?? SUMMARY_ERRORS[code]); }
}
/** Decodifica el cuerpo {code,error} del servidor: solo el detalle MODEL_RESPONSE confiable atraviesa; el resto es estático. */
function decodeServerSummaryError(body: unknown): SummaryError {
  if (record(body) && keys(body, ['code', 'error']) && typeof body.code === 'string' && Object.hasOwn(SUMMARY_ERRORS, body.code)) {
    const code = body.code as SummaryErrorCode;
    return new SummaryError(code, code === 'MODEL_RESPONSE' ? modelResponseDetail(body.error) ?? undefined : undefined);
  }
  return new SummaryError('NETWORK');
}
export async function fetchSummary(input: { url: string; provider: string; model: string }, signal: AbortSignal): Promise<SummaryResult> {
  const response = await fetch('/api/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  const body: unknown = await response.json();
  if (!response.ok) throw decodeServerSummaryError(body);
  if (!validResult(body) || body.video.source !== 'youtube' || body.model.provider !== input.provider || body.model.id !== input.model || body.video.id !== canonicalYoutube(input.url)?.id) throw new SummaryError('MODEL_RESPONSE');
  return body;
}

/** Subida binaria al bridge local: cabeceras fijas, nunca rutas ni campos de ruta. */
export async function fetchLocalSummary(input: { file: File; provider: string; model: string; filename: string }, signal: AbortSignal): Promise<SummaryResult> {
  const headers: Record<string, string> = {
    'x-restube-provider': input.provider,
    'x-restube-model': input.model,
    // Codificado para sobrevivir al transporte latin1 de las cabeceras HTTP.
    'x-restube-filename': encodeURIComponent(input.filename),
  };
  const mime = input.file.type.startsWith('video/') ? input.file.type : 'video/mp4';
  headers['Content-Type'] = mime;
  const response = await fetch(LOCAL_UPLOAD_ENDPOINT, { method: 'POST', headers, body: input.file, signal });
  const body: unknown = await response.json();
  if (!response.ok) throw decodeServerSummaryError(body);
  // El título devuelto debe anclarse al archivo exacto que se subió.
  if (!validResult(body) || body.video.source !== 'local' || body.video.title !== input.filename || body.model.provider !== input.provider || body.model.id !== input.model) throw new SummaryError('MODEL_RESPONSE');
  return body;
}
