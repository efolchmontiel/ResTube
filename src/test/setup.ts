import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';

beforeAll(() => {
  // jsdom no implementa scrollIntoView (usado al enfocar mensajes de validación)
  if (typeof Element !== 'undefined') Element.prototype.scrollIntoView = vi.fn();
  // jsdom no implementa <dialog>.showModal/close: stubs mínimos con la semántica
  // de atributo 'open' y evento 'close' para probar el diálogo nativo de autorización.
  if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      if (this.hasAttribute('open')) {
        throw new DOMException('El diálogo ya está abierto', 'InvalidStateError');
      }
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
