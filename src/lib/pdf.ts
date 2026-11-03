/**
 * PDF text extraction through unpdf, which runs on plain Node without a worker.
 * A scanned PDF has no text layer, and saying so beats indexing an empty chunk
 * that later shows up as a confident-looking source.
 */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(bytes);
  const { text } = await extractText(doc, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n\n") : String(text)).trim();
}
