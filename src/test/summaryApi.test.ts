import { afterEach, expect, it, vi } from 'vitest';
import { displayDuration, displayTime, fetchLocalSummary, fetchSummary, validResult, validSummary } from '../data/summary';
import { YOUTUBE_URL } from './catalog';
import { SUMMARY_FIXTURE } from './catalog';
afterEach(() => vi.unstubAllGlobals());
it('valida cuatro secciones, límites, campos y URL canónica en ambos lados', () => {
  expect(validResult(SUMMARY_FIXTURE)).toBe(true);
  for (const value of [null, { ...SUMMARY_FIXTURE, secret: 'no' }, { ...SUMMARY_FIXTURE, video: { ...SUMMARY_FIXTURE.video, url: 'javascript:alert(1)' } }, { ...SUMMARY_FIXTURE, model: { ...SUMMARY_FIXTURE.model, apiKey: 'no' } }, { ...SUMMARY_FIXTURE, video: { ...SUMMARY_FIXTURE.video, duration: Infinity } }]) expect(validResult(value)).toBe(false);
  for (const value of [{ ...SUMMARY_FIXTURE.summary, quote: undefined }, { ...SUMMARY_FIXTURE.summary, takeaways: [] }, { ...SUMMARY_FIXTURE.summary, takeaways: Array(21).fill(SUMMARY_FIXTURE.summary.takeaways[0]) }, { ...SUMMARY_FIXTURE.summary, actions: { heading: 'x', tone: 'blue' } }, { ...SUMMARY_FIXTURE.summary, deepdive: { ...SUMMARY_FIXTURE.summary.deepdive, paragraphs: ['x'.repeat(4001)] } }]) expect(validSummary(value)).toBe(false);
});
it('rechaza éxito de otro par exacto sin confundir nombres parecidos', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => SUMMARY_FIXTURE })));
  await expect(fetchSummary({ url: YOUTUBE_URL, provider: 'otro', model: SUMMARY_FIXTURE.model.id }, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
});
it('rechaza un resultado de otro video aunque el modelo sea el mismo', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => SUMMARY_FIXTURE })));
  await expect(fetchSummary({ url: 'https://youtu.be/zyxwvutsrqp', provider: SUMMARY_FIXTURE.model.provider, model: SUMMARY_FIXTURE.model.id }, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
});
it('errores del servidor nunca publican mensajes arbitrarios o secretos en el navegador', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ code: 'MODEL_FAILED', error: 'SECRET raw stderr' }) })));
  await expect(fetchSummary({ url: YOUTUBE_URL, provider: SUMMARY_FIXTURE.model.provider, model: SUMMARY_FIXTURE.model.id }, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_FAILED', message: 'El modelo no pudo generar el resumen. Comprueba su disponibilidad y vuelve a intentarlo.' });
});

const BASE = 'El modelo devolvió un resumen con un formato inválido. Vuelve a procesar el video.';
const DETAIL = `${BASE} (bloque de notas 5 de 8: la respuesta no cumplió la validación de la etapa. Se esperaban entre 1 y 12 notas y la respuesta tuvo 13.)`;
it('un MODEL_RESPONSE con detalle confiable del servidor llega al mensaje del usuario', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ code: 'MODEL_RESPONSE', error: DETAIL }) })));
  await expect(fetchSummary({ url: YOUTUBE_URL, provider: SUMMARY_FIXTURE.model.provider, model: SUMMARY_FIXTURE.model.id }, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE', message: DETAIL });
});
it('detalles no confiables de MODEL_RESPONSE caen al mensaje estático', async () => {
  for (const error of [BASE, 'otro mensaje sin prefijo', `x${DETAIL}`, `${DETAIL}\ncontrol`, `${BASE} (${'x'.repeat(500)})`]) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ code: 'MODEL_RESPONSE', error }) })));
    await expect(fetchSummary({ url: YOUTUBE_URL, provider: SUMMARY_FIXTURE.model.provider, model: SUMMARY_FIXTURE.model.id }, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE', message: BASE });
  }
});
it('la ruta local comparte el mismo decodificador de errores del servidor', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ code: 'MODEL_RESPONSE', error: DETAIL }) })));
  await expect(fetchLocalSummary({ file: new File([new Uint8Array([1])], 'clip.mp4'), provider: 'p', model: 'm', filename: 'clip.mp4' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE', message: DETAIL });
});
it('la señal y el cuerpo exacto viajan al endpoint local', async () => {
  const mock = vi.fn(async () => ({ ok: true, json: async () => SUMMARY_FIXTURE })); vi.stubGlobal('fetch', mock);
  const signal = new AbortController().signal; const body = { url: YOUTUBE_URL, provider: SUMMARY_FIXTURE.model.provider, model: SUMMARY_FIXTURE.model.id };
  await fetchSummary(body, signal); expect(mock).toHaveBeenCalledWith('/api/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
});

it('acepta catorce hallazgos reales de un video largo y sigue rechazando más de veinte', () => {
  const takeaway = SUMMARY_FIXTURE.summary.takeaways[0];
  expect(validSummary({ ...SUMMARY_FIXTURE.summary, takeaways: Array(14).fill(takeaway) })).toBe(true);
  expect(validSummary({ ...SUMMARY_FIXTURE.summary, takeaways: Array(20).fill(takeaway) })).toBe(true);
  expect(validSummary({ ...SUMMARY_FIXTURE.summary, takeaways: Array(21).fill(takeaway) })).toBe(false);
});

it('acepta tiempos con minutos de un dígito y los muestra uniformes sin inventar valores', () => {
  const takeaway = { num: '01', time: '5:30', heading: 'x', text: 'y' };
  expect(validSummary({ ...SUMMARY_FIXTURE.summary, takeaways: [takeaway] })).toBe(true);
  expect(validSummary({ ...SUMMARY_FIXTURE.summary, takeaways: [{ ...takeaway, time: '1:02:37' }] })).toBe(true);
  expect(validSummary({ ...SUMMARY_FIXTURE.summary, takeaways: [{ ...takeaway, time: 'sin tiempo' }] })).toBe(false);
  expect(displayTime('5:30')).toBe('05:30');
  expect(displayTime('1:02:37')).toBe('01:02:37');
  expect(displayTime('01:05')).toBe('01:05');
  expect(displayDuration(7948)).toBe('2:12:28');
  expect(displayDuration(65)).toBe('1:05');
  expect(displayDuration(600)).toBe('10:00');
});
