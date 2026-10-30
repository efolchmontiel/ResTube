import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Intercepta solo los temporizadores largos de la app (550 ms de generación simulada
 * y 3500 ms de auto-desestimación del toast) y los deja en cola hasta que el test los
 * descarga con flush(). Los demás setTimeout se dejan pasar: user-event y React act
 * dependen de temporizadores de 0 ms.
 */
export function installDeferredTimers(): () => void {
  const queue: Array<() => void> = [];
  const real = globalThis.setTimeout;
  const stub = ((cb: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 550 || ms === 3500) {
      queue.push(cb);
      return queue.length;
    }
    return real(cb as never, ms as never, ...(rest as never[]));
  }) as unknown as typeof setTimeout;
  vi.stubGlobal('setTimeout', stub);
  return () =>
    act(() => {
      while (queue.length > 0) {
        const cb = queue.shift();
        cb?.();
      }
    });
}
