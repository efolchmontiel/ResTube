import { type RuntimeModel } from './models';

/**
 * Cabecera fija de recarga explícita. Es el mismo literal que acepta
 * `server/modelsApi.ts`; se duplica a propósito para que el bundle del cliente
 * nunca importe código del servidor (`node:child_process`). Los dos extremos
 * están clavados por tests: el servidor saltea la cache solo con este valor y
 * el cliente lo envía solo al pulsar «Actualizar catálogo».
 */
const CATALOG_REFRESH_HEADER = 'x-restube-catalog';
const CATALOG_REFRESH_HEADER_VALUE = 'refresh';

export const CATALOG_ENDPOINT = '/api/models';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalFlag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Descarga el catálogo del bridge local y valida su forma. Ante cualquier
 * respuesta malformada falla (estado de error en la UI): nunca se inventan
 * modelos ni se usa una lista estática de respaldo.
 *
 * `refresh: true` envía la cabecera fija de recarga explícita para que el
 * usuario obtenga siempre el catálogo actual al pulsar «Actualizar catálogo».
 */
export async function fetchModelCatalog(
  fetchImpl: typeof fetch = fetch,
  options: { refresh?: boolean } = {},
): Promise<RuntimeModel[]> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.refresh) headers[CATALOG_REFRESH_HEADER] = CATALOG_REFRESH_HEADER_VALUE;
  const response = await fetchImpl(CATALOG_ENDPOINT, { headers });
  if (!response.ok) {
    throw new Error(`El endpoint del catálogo respondió ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw new Error('La respuesta del catálogo no tiene el formato esperado');
  }
  const seen = new Set<string>();
  const models: RuntimeModel[] = [];
  for (const raw of data.models) {
    if (!isRecord(raw)) {
      throw new Error('Entrada del catálogo malformada');
    }
    const { provider, id, name, context, maxOutput, thinking, images } = raw;
    if (typeof provider !== 'string' || !provider || typeof id !== 'string' || !id) {
      throw new Error('Entrada del catálogo sin proveedor o id');
    }
    // Deduplica por la clave canónica proveedor:id (defensa en profundidad).
    const key = `${provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Allowlist estricta de campos: cualquier otro campo del endpoint se descarta.
    models.push({
      provider,
      id,
      name: optionalString(name) ?? id,
      context: optionalString(context),
      maxOutput: optionalString(maxOutput),
      thinking: optionalFlag(thinking),
      images: optionalFlag(images),
    });
  }
  return models;
}
