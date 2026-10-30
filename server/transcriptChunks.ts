import { SummaryError } from '../src/data/summary';
import type { Cue } from './youtube';

// Limits count serialized characters, including escaping and cue timestamps.
export const CHUNK_MAX_CHARS = 24_000;
export const MAX_CHUNKS = 12;

function* pieces(cue: Cue): Generator<Cue> {
  if (JSON.stringify([cue]).length <= CHUNK_MAX_CHARS) { yield cue; return; }
  // Array.from keeps surrogate pairs intact when one cue alone exceeds a block.
  const characters = Array.from(cue.text);
  let offset = 0;
  while (offset < characters.length) {
    let low = 1; let high = characters.length - offset; let fit = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const part = { start: cue.start, text: characters.slice(offset, offset + middle).join('') };
      if (JSON.stringify([part]).length <= CHUNK_MAX_CHARS) { fit = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (!fit) throw new SummaryError('TRANSCRIPT_LIMIT');
    yield { start: cue.start, text: characters.slice(offset, offset + fit).join('') };
    offset += fit;
  }
}

/** Every source character is assigned once; the complete plan is checked before inference. */
export function splitTranscript(cues: Cue[]): Cue[][] {
  const chunks: Cue[][] = [];
  let current: Cue[] = []; let size = 2;
  for (const cue of cues) for (const part of pieces(cue)) {
    const length = JSON.stringify(part).length;
    if (size + length + (current.length ? 1 : 0) > CHUNK_MAX_CHARS) {
      chunks.push(current); current = []; size = 2;
      if (chunks.length >= MAX_CHUNKS) throw new SummaryError('TRANSCRIPT_LIMIT');
    }
    size += length + (current.length ? 1 : 0);
    current.push(part);
  }
  if (current.length) chunks.push(current);
  if (!chunks.length) throw new SummaryError('NO_CAPTIONS');
  return chunks;
}
