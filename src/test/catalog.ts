import { vi } from 'vitest';
import type { SummaryResult } from '../data/summary';

/**
 * Catálogo sintético para tests: NUNCA IDs ni proveedores reales del usuario.
 * 'nan-demo' imita la forma de un proveedor con varios modelos e
 * 'openai-demo' representa un segundo proveedor, ambos inventados.
 */
export const CATALOG_FIXTURE = [
  {
    provider: 'nan-demo',
    id: 'mimo-demo-flash',
    name: 'mimo-demo-flash',
    context: '1.0M',
    maxOutput: '131.1K',
    thinking: true,
    images: true,
  },
  {
    provider: 'nan-demo',
    id: 'qwen-demo-6',
    name: 'qwen-demo-6',
    context: '262.1K',
    maxOutput: '65.5K',
    thinking: true,
    images: true,
  },
  {
    provider: 'openai-demo',
    id: 'gpt-demo-4o',
    name: 'gpt-demo-4o',
    context: '128K',
    maxOutput: '16K',
    thinking: false,
    images: true,
  },
];

export const SUMMARY_FIXTURE: SummaryResult = {
  video: { source: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Video sintético', author: 'Canal sintético', duration: 120, language: 'es' },
  model: { provider: CATALOG_FIXTURE[0].provider, id: CATALOG_FIXTURE[0].id, name: CATALOG_FIXTURE[0].name },
  summary: { takeaways: [{ num: '01', time: '00:00', heading: 'Hallazgo sintético', text: 'Contenido de prueba.' }], deepdive: { heading: 'Análisis', tone: 'accent', paragraphs: ['Detalle.'] }, actions: { heading: 'Pasos', tone: 'blue', items: ['Paso.'] }, quote: null },
};

/** URL canónica de la fuente YouTube del fixture, ya estrechada para llamar a fetchSummary. */
export const YOUTUBE_URL: string = SUMMARY_FIXTURE.video.source === 'youtube' ? SUMMARY_FIXTURE.video.url : '';

export interface CatalogResponseSpec {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

/**
 * Stub de fetch para GET /api/models. Cada llamada consume una especificación
 * de la lista (la última se reutiliza). Devuelve el mock para aserciones.
 */
export function installCatalogFetch(responses: CatalogResponseSpec[] = [{}]) {
  let index = 0;
  const fetchMock = vi.fn(
    async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
      const spec = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        ok: spec.ok ?? true,
        status: spec.status ?? 200,
        json: async () => spec.body ?? { models: CATALOG_FIXTURE },
      };
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
