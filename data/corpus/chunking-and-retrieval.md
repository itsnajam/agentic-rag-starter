# Chunking and hybrid retrieval

## Why chunking decides more than the model does

Retrieval returns a chunk, so a chunk has to be a unit that makes sense on its own. Too big and the answer is buried in unrelated paragraphs, and the model spends its context reading filler. Too small and a sentence loses the sentence before it, which is usually where the subject was named.

A practical starting point is 800 to 1200 characters, with 100 to 200 carried into the next chunk. The carry exists because a fact that straddles a boundary is otherwise unretrievable: the first half sits in one chunk, the second half in another, and neither alone answers the question.

Cut on structure before cutting on size. Paragraph boundaries, then sentence boundaries, then whitespace, and only then a hard slice. A chunk that begins mid-word retrieves fine and reads badly, and the reader cannot tell whether the system is wrong or the source is.

## Vectors are not enough on their own

Embedding similarity is good at paraphrase. It is weak at exactly matching things, which is what developers search for most: an error string, a config key, a function name, a model id, a product code. Ask for `RETRIEVAL_WEAK_SCORE` and a vector index will happily return something about scoring.

Full-text search is the opposite. Postgres `websearch_to_tsquery` finds that key exactly, weights rarer terms higher, and knows nothing about paraphrase.

So run both and fuse. This project uses reciprocal rank fusion: each list votes by position, one over the rank plus a constant, usually 60. Scores are positions rather than distances, which matters because cosine similarity and `ts_rank` are not on the same scale and a naive weighted sum would be nonsense. A chunk that both searches like rises above one only one of them found.

Fetch more candidates than you show, fuse, then keep the top k. Taking k from each list and stopping there loses the chunk that ranked 4th on one signal and 1st on the other.

## Choosing a vector index in pgvector

HNSW gives better recall at a given latency and builds slowly on a large table. IVFFlat builds faster and needs the `lists` tuning matched to row count, or recall drops. For a corpus under a few hundred thousand chunks, HNSW with cosine operators is the honest default. Measure with your own queries rather than trusting a benchmark for somebody else's data.

Store the embedding column with a fixed dimension and make the migration and the provider read the same config value. Mixing dimensions across a table produces insert errors that look like provider bugs.

## Keeping re-indexing boring

Index by content hash and the operation becomes idempotent: run it twice and nothing changes, change one file and only that file's chunks move. A document needs a stable identity that survives edits, which is why the doc id here comes from the file path and the change detection happens per chunk on its content hash. Without that, every edit appends a new copy of the corpus and retrieval starts returning the same paragraph twice with different dates.
