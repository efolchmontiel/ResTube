// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { failedRules, inferSummary, INFERENCE_ARGS, STAGE_ATTEMPTS } from '../../server/inference';
import { splitTranscript, CHUNK_MAX_CHARS, MAX_CHUNKS } from '../../server/transcriptChunks';
import type { CommandRunner } from '../../server/processRunner';
import type { Transcript } from '../../server/youtube';

const model = { provider: 'fixture', id: 'model-a', name: 'Model A' };
const video = { source: 'youtube' as const, id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Long source', author: 'Actual author', duration: 8000, language: 'es' };
const summary = { takeaways: [{ num: '01', time: '00:00', heading: 'All blocks', text: 'Combined result' }], deepdive: { heading: 'Analysis', tone: 'accent', paragraphs: ['Combined analysis'] }, actions: { heading: 'Actions', tone: 'blue', items: ['Check source'] }, quote: null };
const long: Transcript = { video, cues: Array.from({ length: 12 }, (_, i) => ({ start: i * 600, text: `Block ${i}: ${'content '.repeat(900)}` })) };
const notesFor = (cues: Transcript['cues']) => ({ notes: [{ start: cues[0].start, text: `Notes for ${cues[0].start}` }] });

describe('bounded sequential long-video inference', () => {
  it('splits losslessly, including one large cue, escaping and surrogate pairs', () => {
    const cues = [{ start: 1.25, text: '😀"\\'.repeat(12_000) }, { start: 750, text: 'final source' }];
    const chunks = splitTranscript(cues);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map(c => c.text).join('')).toBe(cues.map(c => c.text).join(''));
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
      for (const cue of chunk) {
        expect(cues.map(c => c.start)).toContain(cue.start);
        expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(cue.text)).toBe(false);
      }
    }
  });
  it('keeps short input on exactly one original structured-summary call', async () => {
    const runner = vi.fn<CommandRunner>(async () => JSON.stringify(summary));
    const source = { video, cues: [{ start: 0, text: 'Short source' }] };
    expect(await inferSummary(source, model, runner, new AbortController().signal)).toEqual(summary);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runner.mock.calls[0][0].input!).subtitles).toEqual(source.cues);
    expect(runner.mock.calls[0][0].args.slice(0, INFERENCE_ARGS.length)).toEqual(INFERENCE_ARGS);
  });
  it('sends every source cue once, then all per-block notes to one final call that never mirrors the output or input shape', async () => {
    let active = 0; let maximum = 0;
    const inputs: Record<string, unknown>[] = [];
    const runner = vi.fn<CommandRunner>(async (command) => {
      active++; maximum = Math.max(maximum, active);
      const input = JSON.parse(command.input!); inputs.push(input);
      await Promise.resolve(); active--;
      return JSON.stringify(input.subtitles ? notesFor(input.subtitles) : summary);
    });
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    const maps = inputs.filter(input => input.subtitles);
    expect(maps.length).toBeGreaterThan(1);
    expect(maps.flatMap(input => input.subtitles as Transcript['cues']).map(c => c.text).join('')).toBe(long.cues.map(c => c.text).join(''));
    const final = inputs.at(-1)!;
    for (const echoed of ['notes', 'title', 'author', 'language']) expect(Object.hasOwn(final, echoed)).toBe(false);
    expect(final.blocks).toHaveLength(maps.length);
    expect((final.blocks as { notes: unknown[] }[]).flatMap(block => block.notes)).toEqual(maps.flatMap(map => notesFor(map.subtitles as Transcript['cues']).notes));
    expect(runner).toHaveBeenCalledTimes(maps.length + 1); expect(maximum).toBe(1);
    for (const [command] of runner.mock.calls) {
      expect(command.input!.length).toBeLessThanOrEqual(32_000);
      expect(command.args.slice(0, INFERENCE_ARGS.length + 4)).toEqual([...INFERENCE_ARGS, '--provider', model.provider, '--model', model.id]);
    }
  });
  it('the final synthesis system prompt pins the four-field skeleton and forbids the input-only fields', async () => {
    const runner = vi.fn<CommandRunner>(async command => JSON.stringify(command.input!.includes('"subtitles"') ? notesFor(JSON.parse(command.input!).subtitles) : summary));
    await inferSummary(long, model, runner, new AbortController().signal);
    const prompt = runner.mock.calls.at(-1)![0].args.at(-1)!;
    for (const required of ['"takeaways"', '"deepdive"', '"actions"', '"quote"']) expect(prompt).toContain(required);
    expect(prompt).toContain('INPUT-ONLY');
    expect(prompt).toContain('"title"'); expect(prompt).toContain('"author"'); expect(prompt).toContain('"language"'); expect(prompt).toContain('"notes"');
    expect(prompt).toMatch(/nunca/i);
    expect(prompt).toContain('menos de 7000 caracteres');
    expect(prompt).toMatch(/Máximo 8 puntos/);
    expect(prompt).toMatch(/ÚNICO|único/);
  });
  it('rejects the real echo failure verbatim: synthesis that answers with the input schema is MODEL_RESPONSE', async () => {
    const echo = { title: 'Video de prueba', author: 'Autor', language: 'es', notes: [{ start: 0, quote: null, summary: 'Introducción al tema central del video.' }, { start: 300, quote: null, summary: 'Desarrollo de los procesos medibles.' }] };
    const runner = vi.fn<CommandRunner>(async command => JSON.stringify(command.input!.includes('"subtitles"') ? notesFor(JSON.parse(command.input!).subtitles) : echo));
    await expect(inferSummary(long, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
    const calls = runner.mock.calls.filter(([command]) => !command.input!.includes('"subtitles"'));
    expect(calls).toHaveLength(STAGE_ATTEMPTS);
    expect(JSON.parse(calls[0][0].input!)).not.toHaveProperty('subtitles');
  });
  it('accepts whole-second rounding inside its block but still rejects a note mapped to another block', async () => {
    const source: Transcript = { video, cues: [{ start: 0.654, text: 'a '.repeat(7_000) }, { start: 1417.919, text: 'b '.repeat(7_000) }] };
    expect(splitTranscript(source.cues).length).toBeGreaterThan(1);
    const rounding = vi.fn<CommandRunner>(async command => JSON.stringify(command.input!.includes('"subtitles"')
      ? { notes: [{ start: Math.floor((JSON.parse(command.input!).subtitles as Transcript['cues'])[0].start), text: 'Rounded down to the whole second' }] }
      : summary));
    expect(await inferSummary(source, model, rounding, new AbortController().signal)).toEqual(summary);
    expect(rounding).toHaveBeenCalledTimes(splitTranscript(source.cues).length + 1);
    const foreign = vi.fn<CommandRunner>(async command => JSON.stringify(command.input!.includes('"subtitles"') ? { notes: [{ start: 9_000, text: 'Belongs to another part' }] } : summary));
    await expect(inferSummary(source, model, foreign, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
    expect(foreign).toHaveBeenCalledTimes(STAGE_ATTEMPTS);
  });
  it('diagnoses a rejected summary structurally without logging transcript or note text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const many = Array.from({ length: 21 }, (_, i) => ({ num: String(i + 1).padStart(2, '0'), time: '00:00', heading: 'h', text: 'SECRET summary body' }));
    const runner = vi.fn<CommandRunner>(async command => JSON.stringify(command.input!.includes('"subtitles"') ? { notes: [{ start: JSON.parse(command.input!).subtitles[0].start, text: 'SECRET note body' }] } : { ...summary, takeaways: many }));
    await expect(inferSummary(long, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
    expect(warn).toHaveBeenCalledTimes(STAGE_ATTEMPTS);
    const line = String(warn.mock.calls.at(-1)![0]);
    expect(line).toContain('stage=synthesis'); expect(line).toContain('takeawayCount'); expect(line).toContain('rules=takeawayCount'); expect(line).toContain(`attempt=${STAGE_ATTEMPTS}`);
    expect(line).not.toContain('SECRET'); expect(line).not.toContain(long.cues[0].text.slice(0, 20));
    warn.mockRestore();
  });
  it('recovers from one malformed answer with a single bounded retry of the same stage', async () => {
    let synthesisCalls = 0;
    const runner = vi.fn<CommandRunner>(async command => {
      if (command.input!.includes('"subtitles"')) return JSON.stringify(notesFor(JSON.parse(command.input!).subtitles));
      synthesisCalls += 1;
      return JSON.stringify(synthesisCalls === 1 ? { ...summary, takeaways: [] } : summary);
    });
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    expect(synthesisCalls).toBe(2);
  });
  it('does not retry a failed process, only a malformed answer', async () => {
    const runner = vi.fn<CommandRunner>(async () => { throw new Error('PRIVATE stderr'); });
    await expect(inferSummary(long, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it('aborts before launching another block or synthesis', async () => {
    const controller = new AbortController();
    const runner = vi.fn<CommandRunner>(async command => { const input = JSON.parse(command.input!); controller.abort(); return JSON.stringify(notesFor(input.subtitles)); });
    await expect(inferSummary(long, model, runner, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it.each([
    { notes: [{ start: -1, text: 'invented location' }] },
    { notes: [{ start: 0, text: 'x'.repeat(601) }] },
    { notes: Array.from({ length: 13 }, () => ({ start: 0, text: 'note' })) },
    { notes: [{ start: 0, text: 'note' }], secret: 'extra field' },
  ])('rejects malformed intermediate notes and never synthesizes: %j', async invalid => {
    const runner = vi.fn<CommandRunner>(async () => JSON.stringify(invalid));
    await expect(inferSummary(long, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
    expect(runner).toHaveBeenCalledTimes(STAGE_ATTEMPTS);
  });
  it('accepts a dense block note of 600 characters and refuses to synthesize an oversized notes payload', async () => {
    const dense: Transcript = { video, cues: Array.from({ length: MAX_CHUNKS }, (_, i) => ({ start: i * 600, text: 'n '.repeat(11_900) })) };
    const longNote = (start: number) => ({ notes: [{ start, text: 'n'.repeat(600) }] });
    const runner = vi.fn<CommandRunner>(async command => JSON.stringify(command.input!.includes('"subtitles"')
      ? longNote((JSON.parse(command.input!).subtitles as Transcript['cues'])[0].start) : summary));
    expect(splitTranscript(dense.cues)).toHaveLength(MAX_CHUNKS);
    expect(await inferSummary(dense, model, runner, new AbortController().signal)).toEqual(summary);
    const oversized = vi.fn<CommandRunner>(async command => JSON.stringify(command.input!.includes('"subtitles"')
      ? { notes: Array.from({ length: 8 }, () => ({ start: (JSON.parse(command.input!).subtitles as Transcript['cues'])[0].start, text: 'n'.repeat(600) })) }
      : summary));
    await expect(inferSummary(dense, model, oversized, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSCRIPT_LIMIT' });
    expect(oversized.mock.calls.filter(([command]) => !command.input!.includes('"subtitles"'))).toHaveLength(0);
  });
  it('la etapa fallida alimenta el segundo intento con retroalimentación acotada y limpia por bloque', async () => {
    const prompts: string[] = []; const inputs: string[] = []; let notesCalls = 0;
    const runner = vi.fn<CommandRunner>(async command => {
      prompts.push(command.args.at(-1)!); inputs.push(command.input!);
      if (!command.input!.includes('"subtitles"')) return JSON.stringify(summary);
      notesCalls += 1;
      return notesCalls % 2 === 1
        ? JSON.stringify({ notes: Array.from({ length: 13 }, (_, i) => ({ start: JSON.parse(command.input!).subtitles[0].start, text: `SECRET note ${i}` })) })
        : JSON.stringify(notesFor(JSON.parse(command.input!).subtitles));
    });
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    const notesPrompts = prompts.filter((_, i) => inputs[i].includes('"subtitles"'));
    expect(notesPrompts.length).toBeGreaterThanOrEqual(3);
    expect(inputs[0]).toBe(inputs[1]);
    expect(notesPrompts[0]).not.toContain('CORRECCIÓN');
    expect(notesPrompts[1].startsWith(notesPrompts[0])).toBe(true);
    expect(notesPrompts[1]).toContain('CORRECCIÓN');
    expect(notesPrompts[1]).toContain('13');
    expect(notesPrompts[1]).toContain('1 y 8');
    expect(notesPrompts[1]).not.toContain('SECRET');
    expect(notesPrompts[1]).not.toContain('Block 0:');
    expect(notesPrompts[2]).toBe(notesPrompts[0]);
  });
  it.each([
    { name: 'trece notas', scalar: '13', invalid: (start: number) => ({ notes: Array.from({ length: 13 }, () => ({ start, text: 'note' })) }) },
    { name: 'cero notas', scalar: '0', invalid: () => ({ notes: [] }) },
    { name: 'notes que no es lista', scalar: 'lista', invalid: () => ({ notes: 'no' }) },
  ])('diagnóstico cerrado para $name: cifra segura en el segundo intento, nunca texto', async ({ scalar, invalid }) => {
    const prompts: string[] = []; let notesCalls = 0;
    const runner = vi.fn<CommandRunner>(async command => {
      if (!command.input!.includes('"subtitles"')) return JSON.stringify(summary);
      prompts.push(command.args.at(-1)!);
      notesCalls += 1;
      return notesCalls % 2 === 1 ? JSON.stringify(invalid(JSON.parse(command.input!).subtitles[0].start)) : JSON.stringify(notesFor(JSON.parse(command.input!).subtitles));
    });
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    expect(prompts[1].startsWith(prompts[0])).toBe(true);
    expect(prompts[1]).toContain('CORRECCIÓN');
    expect(prompts[1]).toContain(scalar);
  });
  it('JSON inválido recibe un recordatorio constante sin la respuesta cruda del modelo', async () => {
    const prompts: string[] = []; let notesCalls = 0;
    const runner = vi.fn<CommandRunner>(async command => {
      if (!command.input!.includes('"subtitles"')) return JSON.stringify(summary);
      prompts.push(command.args.at(-1)!);
      notesCalls += 1;
      return notesCalls % 2 === 1 ? '```json SECRET respuesta cruda inválida' : JSON.stringify(notesFor(JSON.parse(command.input!).subtitles));
    });
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    expect(prompts[0]).not.toContain('CORRECCIÓN');
    expect(prompts[1].startsWith(prompts[0])).toBe(true);
    expect(prompts[1]).toContain('CORRECCIÓN');
    expect(prompts[1]).toContain('JSON');
    expect(prompts[1]).not.toContain('SECRET');
  });
  it('los fallos de cantidad registran tipo/cantidad/largo JSON seguros sin texto de notas', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const runner = vi.fn<CommandRunner>(async command => command.input!.includes('"subtitles"')
      ? JSON.stringify({ notes: Array.from({ length: 13 }, (_, i) => ({ start: JSON.parse(command.input!).subtitles[0].start, text: `SECRET note ${i}` })) })
      : JSON.stringify(summary));
    await expect(inferSummary(long, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
    const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('rules=count'));
    expect(lines.length).toBe(STAGE_ATTEMPTS);
    expect(lines[0]).toMatch(/notesType=array count=13 jsonLength=\d+/);
    expect(lines.every(l => !l.includes('SECRET'))).toBe(true);
    warn.mockRestore();
  });
  it('una respuesta recuperada en sintaxis pero inválida en cantidad se diagnostica por reglas de etapa, no como notJson', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const runner = notesRunner(cues => glmTail(JSON.stringify({ notes: Array.from({ length: 13 }, () => ({ start: cues[0].start, text: 'note' })) })));
    await expect(inferSummary(long, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
    expect(runner).toHaveBeenCalledTimes(STAGE_ATTEMPTS);
    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('reason=notJson'))).toBe(false);
    expect(lines.filter(l => l.includes('rules=count')).length).toBe(STAGE_ATTEMPTS);
    warn.mockRestore();
  });
  it('el rechazo agotado de notas lleva mensaje curado con bloque, total y cantidad segura', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const runner = vi.fn<CommandRunner>(async command => command.input!.includes('"subtitles"')
      ? JSON.stringify({ notes: Array.from({ length: 13 }, () => ({ start: JSON.parse(command.input!).subtitles[0].start, text: 'note' })) })
      : JSON.stringify(summary));
    let error!: Error;
    await inferSummary(long, model, runner, new AbortController().signal).catch((reason: unknown) => { error = reason as Error; });
    expect(error).toMatchObject({ code: 'MODEL_RESPONSE' });
    expect(error.message.startsWith('El modelo devolvió un resumen con un formato inválido.')).toBe(true);
    expect(error.message).toMatch(/bloque de notas 1 de \d+/);
    expect(error.message).toContain('13');
    expect(error.message.length).toBeLessThanOrEqual(400);
    expect(error.message).not.toContain('note');
    warn.mockRestore();
  });
  it('el rechazo agotado de la síntesis lleva mensaje curado cerrado sin contenido del modelo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const echo = { title: 'Video privado', author: 'Autor privado', language: 'es', notes: [{ start: 0, summary: 'Contenido privado del eco.' }] };
    const runner = vi.fn<CommandRunner>(async command => JSON.stringify(command.input!.includes('"subtitles"') ? notesFor(JSON.parse(command.input!).subtitles) : echo));
    let error!: Error;
    await inferSummary(long, model, runner, new AbortController().signal).catch((reason: unknown) => { error = reason as Error; });
    expect(error).toMatchObject({ code: 'MODEL_RESPONSE' });
    expect(error.message.startsWith('El modelo devolvió un resumen con un formato inválido.')).toBe(true);
    expect(error.message).toContain('síntesis final');
    expect(error.message.length).toBeLessThanOrEqual(400);
    expect(error.message).not.toContain('privado');
    warn.mockRestore();
  });
  it('el diagnóstico de reglas coincide con el validador canónico en los bordes conocidos', () => {
    const base = { takeaways: [{ num: '01', time: '5:30', heading: 'h', text: 't' }], deepdive: { heading: 'd', tone: 'accent', paragraphs: ['p'] }, actions: { heading: 'a', tone: 'blue', items: ['i'] }, quote: null };
    expect(failedRules(base)).toEqual([]);
    expect(failedRules({ ...base, deepdive: { ...base.deepdive, code: 'x'.repeat(8001) } })).toContain('deepdive');
    expect(failedRules({ ...base, deepdive: { ...base.deepdive, code: 'código de análisis' } })).toEqual([]);
  });
  it('a later block failure rejects the entire operation without a fabricated partial result', async () => {
    const runner = vi.fn<CommandRunner>(async command => JSON.stringify(notesFor(JSON.parse(command.input!).subtitles)));
    runner.mockImplementationOnce(async command => JSON.stringify(notesFor(JSON.parse(command.input!).subtitles))).mockRejectedValueOnce(new Error('PRIVATE stderr'));
    await expect(inferSummary(long, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it('rejects an over-budget plan before any model call', async () => {
    const runner = vi.fn<CommandRunner>();
    const cues = Array.from({ length: MAX_CHUNKS + 1 }, (_, start) => ({ start, text: 'x'.repeat(CHUNK_MAX_CHARS - 100) }));
    await expect(inferSummary({ video, cues }, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSCRIPT_LIMIT' });
    expect(runner).not.toHaveBeenCalled();
  });
  /** Swaps exactly the `]}` pair at the end of `marker` — the two characters whose order MiMo inverted. */
  const swapPair = (valid: string, marker: string) => {
    const at = valid.indexOf(marker) + marker.length - 2;
    expect(valid.slice(at, at + 2)).toBe(']}');
    return { inverted: valid.slice(0, at) + '}]' + valid.slice(at + 2), at };
  };
  it('accepts a synthesis that inverts exactly one array/object closer, with content unchanged and no extra model call', async () => {
    const valid = JSON.stringify(summary);
    const { inverted, at } = swapPair(valid, '"Combined analysis"]}');
    expect(() => JSON.parse(inverted)).toThrow();
    // Content identity: only the two swapped delimiter characters differ from the valid answer.
    expect(inverted.slice(0, at) + inverted.slice(at + 2)).toBe(valid.slice(0, at) + valid.slice(at + 2));
    let synthesisCalls = 0;
    const runner = vi.fn<CommandRunner>(async command => {
      if (command.input!.includes('"subtitles"')) return JSON.stringify(notesFor(JSON.parse(command.input!).subtitles));
      synthesisCalls += 1;
      return inverted;
    });
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    expect(synthesisCalls).toBe(1);
    expect(runner.mock.calls.filter(([command]) => !command.input!.includes('"subtitles"'))).toHaveLength(1);
  });
  it('keeps prior valid synthesis paths intact: fences, prose and escaped closers inside strings', async () => {
    const fenced = vi.fn<CommandRunner>(async command => command.input!.includes('"subtitles"')
      ? JSON.stringify(notesFor(JSON.parse(command.input!).subtitles))
      : `Claro, aquí está:\n\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``);
    expect(await inferSummary(long, model, fenced, new AbortController().signal)).toEqual(summary);
    const inStringSummary = { ...summary, deepdive: { ...summary.deepdive, paragraphs: ['Text with }] and "]} inside strings'] } };
    const inString = vi.fn<CommandRunner>(async command => command.input!.includes('"subtitles"')
      ? JSON.stringify(notesFor(JSON.parse(command.input!).subtitles))
      : JSON.stringify(inStringSummary));
    expect(await inferSummary(long, model, inString, new AbortController().signal)).toEqual(inStringSummary);
  });
  it.each([
    { name: 'multiple inversions', body: () => swapPair(swapPair(JSON.stringify(summary), '"Combined analysis"]}').inverted, '"Check source"]}').inverted },
    { name: 'inverted text only inside strings plus a truncated tail', body: () => `${JSON.stringify(summary).slice(0, -6)}"}]"` },
    { name: 'missing closing delimiters', body: () => JSON.stringify(summary).slice(0, -4) },
    { name: 'invalid summary schema even after the syntactic fix', body: () => swapPair(JSON.stringify({ ...summary, deepdive: { ...summary.deepdive, tone: 'purple' } }), '"Combined analysis"]}').inverted },
  ])('rejects $name without partial success', async ({ body }) => {
    const malformed = body();
    const synthesis = vi.fn<CommandRunner>(async command => command.input!.includes('"subtitles"')
      ? JSON.stringify(notesFor(JSON.parse(command.input!).subtitles)) : malformed);
    await expect(inferSummary(long, model, synthesis, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
    expect(synthesis.mock.calls.filter(([command]) => !command.input!.includes('"subtitles"'))).toHaveLength(STAGE_ATTEMPTS);
  });
  /** GLM defect: the closing tokens keep their positions but carry the wrong TYPE — `]}]` emitted where the nesting stack demands `}]}`. */
  const glmTail = (valid: string) => {
    expect(valid.slice(-3)).toBe('}]}');
    return valid.slice(0, -3) + ']}]';
  };
  const notesRunner = (malformed: (cues: Transcript['cues']) => string) => vi.fn<CommandRunner>(async command => {
    const input = JSON.parse(command.input!);
    return input.subtitles ? malformed(input.subtitles as Transcript['cues']) : JSON.stringify(summary);
  });
  it('recovers the legacy inverted notes answer too: one `}]` typed where `]}` is demanded, with no MiMo-specific inference', async () => {
    const runner = notesRunner(cues => JSON.stringify(notesFor(cues)).replace('"}]}', '"}}]'));
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    expect(runner.mock.calls.filter(([command]) => command.input!.includes('"subtitles"')))
      .toHaveLength(splitTranscript(long.cues).length);
  });
  it('retypes one wrong-typed closing run in notes answers (GLM `]}]` where `}]}` is demanded): content unchanged, no retry', async () => {
    const runner = notesRunner(cues => glmTail(JSON.stringify(notesFor(cues))));
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    const notesCalls = runner.mock.calls.filter(([command]) => command.input!.includes('"subtitles"'));
    expect(notesCalls).toHaveLength(splitTranscript(long.cues).length);
    const final = JSON.parse(runner.mock.calls.at(-1)![0].input!);
    expect((final.blocks as { notes: { start: number; text: string }[] }[]).map(block => block.notes))
      .toEqual(splitTranscript(long.cues).map(cues => notesFor(cues).notes));
  });
  it('recovers the last block notes in an 8-block sequence with one call each and no retry, then synthesizes without data loss', async () => {
    const cues = Array.from({ length: 8 }, (_, i) => [{ start: i * 800, text: 'replay '.repeat(1300) }, { start: i * 800 + 700, text: 'replay '.repeat(1300) }]).flat();
    const source: Transcript = { video, cues };
    expect(splitTranscript(source.cues)).toHaveLength(8);
    const runner = vi.fn<CommandRunner>(async command => {
      const input = JSON.parse(command.input!);
      if (!input.subtitles) return JSON.stringify(summary);
      const valid = JSON.stringify(notesFor(input.subtitles as Transcript['cues']));
      return (input.part as { index: number }).index === 8 ? glmTail(valid) : valid;
    });
    expect(await inferSummary(source, model, runner, new AbortController().signal)).toEqual(summary);
    expect(runner.mock.calls.filter(([command]) => command.input!.includes('"subtitles"'))).toHaveLength(8);
    const final = JSON.parse(runner.mock.calls.at(-1)![0].input!);
    expect(final.blocks).toHaveLength(8);
    expect(final.blocks[7].notes).toEqual([{ start: 5600, text: 'Notes for 5600' }]);
  });
  it('keeps notes answers with brackets, quotes and unicode inside strings intact while recovering the structural tail', async () => {
    const runner = notesRunner(cues => glmTail(JSON.stringify({ notes: [{ start: cues[0].start, text: 'Cierra con ]} "así" ñandú [{(' }] })));
    expect(await inferSummary(long, model, runner, new AbortController().signal)).toEqual(summary);
    const final = JSON.parse(runner.mock.calls.at(-1)![0].input!);
    expect(final.blocks[0].notes).toEqual([{ start: 0, text: 'Cierra con ]} "así" ñandú [{(' }]);
  });
  it.each([
    { name: 'two separate wrong-typed closers', malformed: (cues: Transcript['cues']) =>
      JSON.stringify({ notes: [{ start: cues[0].start, text: 'a' }, { start: cues[0].start + 1, text: 'b' }] })
        .replace('"a"}', '"a"]').replace('"b"}]', '"b"]') },
    { name: 'a closing run longer than three', malformed: (cues: Transcript['cues']) =>
      JSON.stringify(notesFor(cues)).slice(0, -3) + ']]]}}' },
    { name: 'a single wrong closer (run of one)', malformed: (cues: Transcript['cues']) =>
      JSON.stringify({ notes: [{ start: cues[0].start, text: 'a' }, { start: cues[0].start + 1, text: 'b' }] })
        .replace('"a"}', '"a"]') },
    { name: 'truncated answer missing its closers', malformed: (cues: Transcript['cues']) =>
      JSON.stringify(notesFor(cues)).slice(0, -2) },
    { name: 'a missing closer it must not complete', malformed: (cues: Transcript['cues']) =>
      JSON.stringify(notesFor(cues)).slice(0, -1) },
    { name: 'a comma defect it must not fix', malformed: (cues: Transcript['cues']) =>
      JSON.stringify(notesFor(cues)).replace(/"\}\]\}$/, '"},]}') },
    { name: 'a quote defect it must not fix', malformed: (cues: Transcript['cues']) =>
      JSON.stringify(notesFor(cues)).replace(/"\}\]\}$/, ']}') },
    { name: 'an opener defect it must not fix', malformed: (cues: Transcript['cues']) =>
      JSON.stringify(notesFor(cues)).replace('"notes":[{"start"', '"notes":[["start"') },
    { name: 'a note start outside its own block even after the syntactic retype', malformed: (cues: Transcript['cues']) =>
      glmTail(JSON.stringify({ notes: [{ start: cues[0].start + 5000, text: 'Far from this block' }] })) },
    { name: 'note text longer than 600 even after the syntactic retype', malformed: (cues: Transcript['cues']) =>
      glmTail(JSON.stringify({ notes: [{ start: cues[0].start, text: 'x'.repeat(601) }] })) },
    { name: 'too many notes even after the syntactic retype', malformed: (cues: Transcript['cues']) =>
      glmTail(JSON.stringify({ notes: Array.from({ length: 13 }, () => ({ start: cues[0].start, text: 'note' })) })) },
    { name: 'an extra field even after the syntactic retype', malformed: (cues: Transcript['cues']) =>
      glmTail(JSON.stringify({ secret: 'extra', notes: [{ start: cues[0].start, text: 'note' }] })) },
  ])('rejects $name with both attempts spent on notes and no partial synthesis', async ({ malformed }) => {
    const runner = notesRunner(malformed);
    await expect(inferSummary(long, model, runner, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_RESPONSE' });
    expect(runner).toHaveBeenCalledTimes(STAGE_ATTEMPTS);
    expect(runner.mock.calls.every(([command]) => command.input!.includes('"subtitles"'))).toBe(true);
  });
});
