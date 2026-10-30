import { describe, expect, it, vi } from 'vitest';
import {
  createModelsMiddleware,
  modelsApiPlugin,
  parseListModelsOutput,
  type ListModelsRunner,
  type ModelsApiMiddleware,
} from '../../server/modelsApi';

/**
 * Tabla sintética del CLI: nunca IDs reales del usuario. Incluye una línea
 * de advertencia previa al encabezado (que debe ignorarse) y el mismo id
 * bajo dos proveedores distintos (que deben conservarse ambos).
 */
const TABLE = [
  'advertencia inofensiva del arranque (antes del encabezado)',
  'provider model context max-out thinking images',
  'proveedor-demo modelo-a 1.0M 131.1K yes yes',
  'proveedor-demo modelo-b 262.1K 65.5K yes no',
  'proveedor-abierto modelo-a 128K 16K no yes',
  '',
].join('\n');

const EXPECTED_MODELS = [
  {
    provider: 'proveedor-demo',
    id: 'modelo-a',
    name: 'modelo-a',
    context: '1.0M',
    maxOutput: '131.1K',
    thinking: true,
    images: true,
  },
  {
    provider: 'proveedor-demo',
    id: 'modelo-b',
    name: 'modelo-b',
    context: '262.1K',
    maxOutput: '65.5K',
    thinking: true,
    images: false,
  },
  {
    provider: 'proveedor-abierto',
    id: 'modelo-a',
    name: 'modelo-a',
    context: '128K',
    maxOutput: '16K',
    thinking: false,
    images: true,
  },
];

interface FakeReq {
  method?: string;
  url?: string;
  headers: Record<string, string>;
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string | null;
  done: Promise<void>;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function makeReq(opts: {
  method?: string;
  url?: string;
  host?: string;
  origin?: string;
  headers?: Record<string, string>;
}): FakeReq {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.host !== undefined) headers.host = opts.host;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  return { method: opts.method ?? 'GET', url: opts.url ?? '/api/models', headers };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: null,
    done: null as unknown as Promise<void>,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    end(body) {
      res.body = body ?? null;
    },
  };
  let resolve!: () => void;
  res.done = new Promise<void>((r) => {
    resolve = r;
  });
  const originalEnd = res.end.bind(res);
  res.end = (body?: string) => {
    originalEnd(body);
    resolve();
  };
  return res;
}

function runnerMock(stdout: string = TABLE) {
  return vi.fn<ListModelsRunner>(async () => stdout);
}

function middlewareWith(stdout: string = TABLE): { middleware: ModelsApiMiddleware; runner: ReturnType<typeof runnerMock> } {
  const runner = runnerMock(stdout);
  return { middleware: createModelsMiddleware({ runner }), runner };
}

async function call(middleware: ModelsApiMiddleware, req: FakeReq): Promise<FakeRes> {
  const res = makeRes();
  middleware(req, res, () => {
    res.statusCode = 404;
    res.end('{"error":"no encontrado"}');
  });
  await res.done;
  return res;
}

describe('GET /api/models — handler público (runner sintético inyectado)', () => {
  it('responde 200 con el catálogo exacto y allowlisted', async () => {
    const { middleware, runner } = middlewareWith();
    const res = await call(middleware, makeReq({ host: '127.0.0.1:5173' }));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body ?? '{}')).toEqual({ models: EXPECTED_MODELS });
    // Sin campos fuera de la allowlist
    for (const model of (JSON.parse(res.body ?? '{}') as { models: Record<string, unknown>[] }).models) {
      expect(Object.keys(model).sort()).toEqual(
        ['context', 'id', 'images', 'maxOutput', 'name', 'provider', 'thinking'].sort(),
      );
    }
  });

  it('deduplica pares proveedor:id repetidos y conserva el mismo id bajo proveedores distintos', async () => {
    const duplicated = [
      'provider model context max-out thinking images',
      'p-demo modelo-x 1M 10K yes no',
      'p-demo modelo-x 1M 10K yes no',
      'p-otro modelo-x 2M 20K no yes',
    ].join('\n');
    const { middleware } = middlewareWith(duplicated);
    const res = await call(middleware, makeReq({ host: 'localhost:4173' }));
    expect(res.statusCode).toBe(200);
    const { models } = JSON.parse(res.body ?? '{}') as { models: { provider: string; id: string }[] };
    expect(models).toHaveLength(2);
    expect(models.map((m) => `${m.provider}:${m.id}`)).toEqual(['p-demo:modelo-x', 'p-otro:modelo-x']);
  });

  it('devuelve un catálogo vacío honesto cuando el CLI no lista modelos', async () => {
    const { middleware } = middlewareWith('provider model context max-out thinking images\n');
    const res = await call(middleware, makeReq({ host: 'localhost:5173' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ models: [] });
  });

  it('rechaza métodos distintos de GET sin invocar el runner', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const { middleware, runner } = middlewareWith();
      const res = await call(middleware, makeReq({ method, host: '127.0.0.1:5173' }));
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('GET');
      expect(JSON.parse(res.body ?? '{}').error).toBeTruthy();
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it('rechaza query strings sin invocar el runner', async () => {
    const { middleware, runner } = middlewareWith();
    const res = await call(middleware, makeReq({ url: '/api/models?provider=openai', host: '127.0.0.1:5173' }));
    expect(res.statusCode).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it('rechaza Host no loopback (DNS rebinding) y Host ausente sin invocar el runner', async () => {
    for (const host of ['atacante.example:5173', 'evil.example']) {
      const { middleware, runner } = middlewareWith();
      const res = await call(middleware, makeReq({ host }));
      expect(res.statusCode).toBe(403);
      expect(runner).not.toHaveBeenCalled();
    }
    const { middleware, runner } = middlewareWith();
    const req = makeReq({ host: '127.0.0.1:5173' });
    delete req.headers.host;
    const res = await call(middleware, req);
    expect(res.statusCode).toBe(403);
    expect(runner).not.toHaveBeenCalled();
  });

  it('rechaza Origin cross-origin aunque sea loopback en otro puerto, y acepta el Origin que coincide con Host', async () => {
    const { middleware, runner } = middlewareWith();
    const res = await call(
      middleware,
      makeReq({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:9999' }),
    );
    expect(res.statusCode).toBe(403);
    expect(runner).not.toHaveBeenCalled();

    const { middleware: mw2 } = middlewareWith();
    const res2 = await call(
      mw2,
      makeReq({ host: '127.0.0.1:5173', origin: 'http://evil.example' }),
    );
    expect(res2.statusCode).toBe(403);

    const { middleware: mw3 } = middlewareWith();
    const res3 = await call(
      mw3,
      makeReq({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }),
    );
    expect(res3.statusCode).toBe(200);
  });

  it('deja pasar rutas distintas de /api/models al siguiente middleware', async () => {
    const { middleware, runner } = middlewareWith();
    const res = makeRes();
    const next = vi.fn(() => {
      res.statusCode = 404;
      res.end('otra ruta');
    });
    middleware(makeReq({ url: '/index.html', host: '127.0.0.1:5173' }), res, next);
    await res.done;
    expect(next).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it('falla con error genérico en español, sin stderr ni secretos, y sin fallback a datos', async () => {
    const runner = vi.fn<ListModelsRunner>(async () => {
      const err = Object.assign(new Error('el comando salió con código 1'), {
        stderr: 'SECRET-SENTINEL clave-supersecreta del entorno',
        stdout: '',
      });
      throw err;
    });
    const middleware = createModelsMiddleware({ runner });
    const res = await call(middleware, makeReq({ host: '127.0.0.1:5173' }));
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body ?? '{}') as { error: string; models?: unknown };
    expect(body.models).toBeUndefined();
    expect(body.error).toMatch(/catálogo de modelos/i);
    expect(body.error).not.toContain('SECRET');
    expect(res.body).not.toContain('SECRET-SENTINEL');
    expect(res.body).not.toContain('clave-supersecreta');
  });

  it('falla cerrado ante filas con columnas inesperadas y ante salida sin encabezado', () => {
    expect(() =>
      parseListModelsOutput(
        ['provider model context max-out thinking images', 'p-demo modelo-rota 1M 10K yes'].join('\n'),
      ),
    ).toThrow();
    expect(() => parseListModelsOutput('salida sin encabezado\np-demo modelo-a 1M 10K yes no')).toThrow();
  });

  it('falla cerrado ante valores booleanos no reconocidos en la tabla', () => {
    expect(() =>
      parseListModelsOutput(
        ['provider model context max-out thinking images', 'p-demo modelo-a 1M 10K quizás no'].join('\n'),
      ),
    ).toThrow();
  });

  it('comparte una única ejecución del runner entre pedidos concurrentes/cercanos (dedupe en vuelo + cache corto)', async () => {
    const { middleware, runner } = middlewareWith();
    const resA = makeRes();
    const resB = makeRes();
    middleware(makeReq({ host: '127.0.0.1:5173' }), resA, () => {});
    middleware(makeReq({ host: '127.0.0.1:5173' }), resB, () => {});
    await Promise.all([resA.done, resB.done]);
    const resC = await call(middleware, makeReq({ host: '127.0.0.1:5173' }));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    expect(resC.statusCode).toBe(200);
  });

  it('la recarga explícita del catálogo saltea la cache y vuelve a ejecutar el comando', async () => {
    const { middleware, runner } = middlewareWith();
    await call(middleware, makeReq({ host: '127.0.0.1:5173' }));
    expect(runner).toHaveBeenCalledTimes(1);

    // Dentro de la ventana de cache, un pedido normal sigue sirviendo la cache...
    await call(middleware, makeReq({ host: '127.0.0.1:5173' }));
    expect(runner).toHaveBeenCalledTimes(1);

    // ...pero el click explícito "Actualizar catálogo" (header fijo) la saltea.
    const res = await call(
      middleware,
      makeReq({ host: '127.0.0.1:5173', headers: { 'x-restube-catalog': 'refresh' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ models: EXPECTED_MODELS });
  });

  it('varias recargas explicitas concurrentes siguen lanzando un solo subprocess (dedupe en vuelo)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner = vi.fn<ListModelsRunner>(async () => {
      await gate;
      return TABLE;
    });
    const middleware = createModelsMiddleware({ runner });

    const resA = makeRes();
    const resB = makeRes();
    const resC = makeRes();
    const headers = { 'x-restube-catalog': 'refresh' };
    middleware(makeReq({ host: '127.0.0.1:5173', headers }), resA, () => {});
    middleware(makeReq({ host: '127.0.0.1:5173', headers }), resB, () => {});
    middleware(makeReq({ host: '127.0.0.1:5173' }), resC, () => {});

    release();
    await Promise.all([resA.done, resB.done, resC.done]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    expect(resC.statusCode).toBe(200);
  });

  it('un valor aproximado del header de recarga NO saltea la cache (comparación exacta)', async () => {
    const { middleware, runner } = middlewareWith();
    await call(middleware, makeReq({ host: '127.0.0.1:5173' }));
    expect(runner).toHaveBeenCalledTimes(1);

    for (const near of ['Refresh', 'REFRESH', ' refresh', 'refresh ', 'refreshed', '']) {
      const res = await call(
        middleware,
        makeReq({ host: '127.0.0.1:5173', headers: { 'x-restube-catalog': near } }),
      );
      // Sirve igual el catálogo cacheado: nunca lanza un segundo subprocess.
      expect(res.statusCode).toBe(200);
      expect(runner).toHaveBeenCalledTimes(1);
    }
  });

  it('una recarga explícita que falla responde 500 sin servir la cache como éxito', async () => {
    let fail = false;
    const runner = vi.fn<ListModelsRunner>(async () => {
      if (fail) throw new Error('el comando salió con código 1');
      return TABLE;
    });
    const middleware = createModelsMiddleware({ runner });

    await call(middleware, makeReq({ host: '127.0.0.1:5173' }));
    expect(runner).toHaveBeenCalledTimes(1);

    fail = true;
    const res = await call(
      middleware,
      makeReq({ host: '127.0.0.1:5173', headers: { 'x-restube-catalog': 'refresh' } }),
    );
    expect(runner).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body ?? '{}') as { error: string; models?: unknown };
    expect(body.models).toBeUndefined();
    expect(body.error).toMatch(/catálogo de modelos/i);

    // Intento fallido不等于 cache vaciada: dentro del TTL un pedido normal
    // sigue recibiendo el último catálogo bueno (solo lectura, nunca un éxito falso).
    const ok = await call(middleware, makeReq({ host: '127.0.0.1:5173' }));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body ?? '{}')).toEqual({ models: EXPECTED_MODELS });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('el header de recarga nunca aporta datos al subprocess y sigue exigiendo Host/Origin', async () => {
    const { middleware, runner } = middlewareWith();
    const evilHost = await call(
      middleware,
      makeReq({ host: 'evil.example', headers: { 'x-restube-catalog': 'refresh' } }),
    );
    expect(evilHost.statusCode).toBe(403);
    expect(runner).not.toHaveBeenCalled();

    const badMethod = await call(
      middleware,
      makeReq({
        method: 'POST',
        host: '127.0.0.1:5173',
        headers: { 'x-restube-catalog': 'refresh; rm -rf /' },
      }),
    );
    expect(badMethod.statusCode).toBe(405);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('modelsApiPlugin — registro en dev y preview', () => {
  it('registra el mismo middleware en configureServer y configurePreviewServer', () => {
    const plugin = modelsApiPlugin();
    const used: unknown[] = [];
    const fakeServer = { middlewares: { use: (fn: unknown) => used.push(fn) } };
    if (typeof plugin.configureServer !== 'function' || typeof plugin.configurePreviewServer !== 'function') {
      throw new Error('el plugin debe registrar configureServer y configurePreviewServer');
    }
    plugin.configureServer(fakeServer);
    plugin.configurePreviewServer(fakeServer);
    expect(used).toHaveLength(2);
    expect(used[0]).toBe(used[1]);
  });
});
