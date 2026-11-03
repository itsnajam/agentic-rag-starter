// Chunking that keeps sentences whole where it can. Fixed character windows cut
// mid-sentence and produce retrievals that read like a ransom note, so the unit
// here is a paragraph, then a sentence, and only then a hard split.

export type ChunkOptions = {
  /** Target maximum characters per chunk. */
  size: number;
  /** Characters of the previous chunk carried into the next one, so a fact that
   *  straddles a boundary is still retrievable as one piece. */
  overlap: number;
};

const SEP = "\n\n";

function splitLong(unit: string, size: number): string[] {
  if (unit.length <= size) return [unit];
  // Sentence boundaries first, then whitespace, then nothing left but a hard cut.
  const sentences = unit.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length > 1 && sentences.every((s) => s.length <= size)) {
    return sentences;
  }
  const out: string[] = [];
  let rest = unit;
  while (rest.length > size) {
    const cut = rest.lastIndexOf(" ", size);
    const at = cut > size * 0.5 ? cut : size;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** The smallest pieces the packer is allowed to put in a chunk. */
function units(text: string, size: number): string[] {
  const flat = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ");
  const paragraphs = flat.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.flatMap((p) => splitLong(p, size));
}

export function chunk(text: string, opts: ChunkOptions): string[] {
  if (!Number.isInteger(opts.size) || opts.size <= 0) throw new Error("chunk size must be a positive integer");
  if (!Number.isInteger(opts.overlap) || opts.overlap < 0 || opts.overlap >= opts.size) {
    throw new Error(`overlap must be a whole number from 0 up to but not including the chunk size (${opts.size})`);
  }
  const pieces = units(text, opts.size);
  if (pieces.length === 0) return [];

  const out: string[] = [];
  let buffer = "";

  for (const piece of pieces) {
    if (buffer.length === 0) {
      buffer = piece;
      continue;
    }
    if (buffer.length + SEP.length + piece.length <= opts.size) {
      buffer += SEP + piece;
      continue;
    }
    out.push(buffer);

    // Carry the tail of what was just emitted into the next chunk, snapped to a
    // word boundary so the carry never starts mid-sentence. The carry is capped
    // so that carry + separator + the next piece still fits the size.
    let carry = "";
    if (opts.overlap > 0) {
      const room = Math.min(opts.overlap, opts.size - SEP.length - piece.length);
      if (room > 0) {
        carry = buffer.slice(-room);
        const spaceAt = carry.indexOf(" ");
        if (spaceAt > 0) carry = carry.slice(spaceAt + 1);
      }
    }
    buffer = carry ? carry + SEP + piece : piece;
  }
  if (buffer.length > 0) out.push(buffer);

  return out;
}
