import { execFile } from 'node:child_process';

/**
 * Bridge local de solo lectura para el catálogo de modelos de Gentle Shell.
 *
 * Límite de confianza: expone únicamente metadatos allowlisted (proveedor, id,
 * nombre y tamaños/flags de la tabla pública del CLI). Nunca expone credenciales,
 * baseUrl, headers, rutas ni la salida cruda del comando. El comando, sus
 * argumentos y su entorno son constantes: nada originado en el navegador
 * (args, paths, env, cwd, proveedor) llega al subprocess.
 */

export interface ModelCatalogEntry {
  provider: string;
  id: string;
  /** El CLI público solo lista IDs: el nombre visible es el propio id. */
  name: string;
  context?: string;
  maxOutput?: string;
  thinking?: boolean;
  images?: boolean;
}

/** Corre el comando fijo y resuelve solo con stdout (el stderr se descarta). */
export type ListModelsRunner = () => Promise<string>;

export const LIST_MODELS_COMMAND = 'gentle-shell';
export const LIST_MODELS_ARGS = ['--offline', '--list-models'] as const;
export const LIST_MODELS_TIMEOUT_MS = 20_000;
export const LIST_MODELS_MAX_BUFFER = 1024 * 1024;
/** Cache corto compartido: pedidos cercanos reusan la misma ejecución. */
const CACHE_TTL_MS = 30_000;

export const CATALOG_ERROR_MESSAGE =
  'No se pudo obtener el catálogo de modelos conectados. Inténtalo nuevamente en unos segundos.';
const METHOD_NOT_ALLOWED_MESSAGE = 'Método no permitido: usa GET.';
const BAD_REQUEST_MESSAGE = 'Petición inválida: este endpoint no acepta parámetros.';
const FORBIDDEN_MESSAGE = 'Acceso permitido solo desde la propia aplicación local.';

export function createListModelsRunner(): ListModelsRunner {
  return () =>
    new Promise<string>((resolve, reject) => {
      execFile(
        LIST_MODELS_COMMAND,
        [...LIST_MODELS_ARGS],
        {
          timeout: LIST_MODELS_TIMEOUT_MS,
          maxBuffer: LIST_MODELS_MAX_BUFFER,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          resolve(stdout);
        },
      );
    });
}

const HEADER_RE = /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/i;

function parseFlag(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === 'yes' || normalized === 'true') return true;
  if (normalized === 'no' || normalized === 'false') return false;
  throw new Error('Valor booleano inesperado en la tabla del catálogo');
}

/**
 * Parsea la tabla pública del CLI: ignora líneas previas al encabezado
 * (advertencias de arranque) y falla cerrado ante cualquier fila con
 * columnas o valores inesperados. Deduplica por par proveedor:id.
 */
export function parseListModelsOutput(stdout: string): ModelCatalogEntry[] {
  const lines = stdout.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => HEADER_RE.test(line.trim()));
  if (headerIndex === -1) {
    throw new Error('El encabezado del catálogo no fue reconocido');
  }
  const seen = new Set<string>();
  const entries: ModelCatalogEntry[] = [];
  for (const raw of lines.slice(headerIndex + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    if (columns.length !== 6) {
      throw new Error('Fila del catálogo con columnas inesperadas');
    }
    const [provider, id, context, maxOutput, thinking, images] = columns;
    const key = `${provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      provider,
      id,
      name: id,
      context,
      maxOutput,
      thinking: parseFlag(thinking),
      images: parseFlag(images),
    });
  }
  return entries;
}

/** Tipos estructurales mínimos (compatibles con connect/http de Node). */
interface IncomingHeaders {
  [name: string]: string | string[] | undefined;
}

export interface ApiRequest {
  method?: string;
  url?: string;
  headers: IncomingHeaders;
}

export interface ApiResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

export type ModelsApiMiddleware = (req: ApiRequest, res: ApiResponse, next: () => void) => void;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Extrae el hostname de un valor Host/Origin host:port (IPv6 entre corchetes). */
function hostNameOf(hostHeaderValue: string): string {
  const host = hostHeaderValue.trim().toLowerCase();
  if (host.startsWith('[')) {
    const closing = host.indexOf(']');
    return closing === -1 ? host : host.slice(0, closing + 1);
  }
  // IPv6 sin corchetes solo aparece sin puerto: no separar por ':'.
  if ((host.match(/:/g) ?? []).length > 1) return host;
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function firstHeader(headers: IncomingHeaders, name: string): string | null {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function sendJson(res: ApiResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export interface CreateModelsMiddlewareOptions {
  /** Inyectable para pruebas: nunca se pasa nada originado en el navegador. */
  runner?: ListModelsRunner;
}

/**
 * Cabecera fija que la propia app envía cuando el usuario pide explícitamente
 * «Actualizar catálogo». Su valor nunca se interpola en el comando: solo decide
 * si se saltea la cache corta. Cualquier otro valor se trata como un pedido normal.
 */
export const CATALOG_REFRESH_HEADER = 'x-restube-catalog';
export const CATALOG_REFRESH_HEADER_VALUE = 'refresh';

export function createModelsMiddleware(
  options: CreateModelsMiddlewareOptions = {},
): ModelsApiMiddleware {
  const runner = options.runner ?? createListModelsRunner();
  let cache: { at: number; entries: ModelCatalogEntry[] } | null = null;
  let inflight: Promise<ModelCatalogEntry[]> | null = null;

  function loadCatalog(force: boolean): Promise<ModelCatalogEntry[]> {
    if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return Promise.resolve(cache.entries);
    }
    if (!inflight) {
      inflight = runner()
        .then((stdout) => {
          const entries = parseListModelsOutput(stdout);
          cache = { at: Date.now(), entries };
          return entries;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return function modelsApi(req, res, next) {
    const url = req.url ?? '';
    const pathname = url.split('?')[0].split('#')[0];
    // Rutas distintas no son de este endpoint: siguen el flujo normal de Vite.
    if (pathname !== '/api/models') {
      next();
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: METHOD_NOT_ALLOWED_MESSAGE });
      return;
    }

    // Ruta estricta: sin query strings ni fragmentos.
    if (url.includes('?') || url.includes('#')) {
      sendJson(res, 400, { error: BAD_REQUEST_MESSAGE });
      return;
    }

    // Solo loopback: el bridge nunca está expuesto a otros hosts (DNS rebinding).
    const hostHeader = firstHeader(req.headers, 'host');
    if (!hostHeader || !LOOPBACK_HOSTNAMES.has(hostNameOf(hostHeader))) {
      sendJson(res, 403, { error: FORBIDDEN_MESSAGE });
      return;
    }

    // Sin CORS permisivo: un Origin presente debe ser exactamente este host:puerto.
    const origin = firstHeader(req.headers, 'origin');
    if (origin !== null) {
      let originHost: string | null = null;
      let originHostname: string | null = null;
      try {
        const parsed = new URL(origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          originHost = parsed.host.toLowerCase();
          originHostname = hostNameOf(originHost);
        }
      } catch {
        originHost = null;
      }
      if (!originHost || originHost !== hostHeader.trim().toLowerCase() || !originHostname || !LOOPBACK_HOSTNAMES.has(originHostname)) {
        sendJson(res, 403, { error: FORBIDDEN_MESSAGE });
        return;
      }
    }

    // Recarga explícita del usuario: saltea la cache corta, sin aportar datos al comando.
    const forceRefresh = firstHeader(req.headers, CATALOG_REFRESH_HEADER) === CATALOG_REFRESH_HEADER_VALUE;

    loadCatalog(forceRefresh).then(
      (entries) => {
        sendJson(res, 200, { models: entries });
      },
      () => {
        // Error genérico: nunca se reenvían stderr, códigos ni salida cruda.
        sendJson(res, 500, { error: CATALOG_ERROR_MESSAGE });
      },
    );
  };
}

export interface MiddlewareHost {
  middlewares: { use(fn: (req: unknown, res: unknown, next: () => void) => void): void };
}

/** Plugin de Vite: sirve GET /api/models en `dev` y en `preview`. */
export function modelsApiPlugin(): {
  name: string;
  configureServer(server: MiddlewareHost): void;
  configurePreviewServer(server: MiddlewareHost): void;
} {
  const middleware = createModelsMiddleware();
  const adapter = (req: unknown, res: unknown, next: () => void) => {
    middleware(req as ApiRequest, res as ApiResponse, next);
  };
  return {
    name: 'restube-models-api',
    configureServer(server) {
      server.middlewares.use(adapter);
    },
    configurePreviewServer(server) {
      server.middlewares.use(adapter);
    },
  };
}
