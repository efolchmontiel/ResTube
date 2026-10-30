// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseModelJson } from '../../server/inference';

const answer = { takeaways: [{ num: '01', time: '00:00', heading: 'h', text: 't' }] };

describe('reading a model answer', () => {
  it('reads a pure JSON answer', () => {
    expect(parseModelJson(JSON.stringify(answer))).toEqual(answer);
  });
  it('reads the complete object when prose or a second payload follows it', () => {
    expect(parseModelJson(`${JSON.stringify(answer)}\n\nNota: resumen generado.`)).toEqual(answer);
    expect(parseModelJson(`Aquí está el resumen:\n${JSON.stringify(answer)}`)).toEqual(answer);
    expect(parseModelJson(`${JSON.stringify(answer)}\n{"extra":true}`)).toEqual(answer);
  });
  it('keeps braces and escaped quotes inside strings intact', () => {
    const tricky = { takeaways: [{ num: '01', time: '00:00', heading: 'Un {} con "comillas" y \\ barra', text: 'ok' }] };
    expect(parseModelJson(`${JSON.stringify(tricky)} trailing`)).toEqual(tricky);
  });
  it('rejects an incomplete answer instead of inventing the rest', () => {
    expect(() => parseModelJson('{"takeaways":[{"num":"01","time":"00:00","hea')).toThrow();
    expect(() => parseModelJson('sin json')).toThrow();
    expect(() => parseModelJson('')).toThrow();
  });
  it('still rejects a wrong-typed closing run: the bounded recovery lives above the strict parser', () => {
    // The exact MiMo defect shape: `}]` emitted where the nesting requires `]}`.
    expect(() => parseModelJson('{"deepdive":{"paragraphs":["p"}]}')).toThrow();
    expect(() => parseModelJson('{"a":["b}],"c":"d"}')).toThrow();
    // The exact GLM defect shape: `]}]` emitted where the nesting requires `}]}`.
    expect(() => parseModelJson('{"notes":[{"start":0,"text":"a"]}]')).toThrow();
  });
});
