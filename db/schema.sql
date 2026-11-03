-- The vector column is sized by scripts/migrate.ts, which substitutes
-- __DIMENSIONS__ with EMBEDDING_DIMENSIONS. Keep the two in step: pgvector will
-- refuse an insert whose length differs, and that error looks like a provider bug.
-- Note that hnsw tops out at 2000 dimensions, so EMBEDDING_DIMENSIONS=2048 needs
-- ivfflat instead of the hnsw index below.
create extension if not exists vector;

create table if not exists chunks (
  id             bigserial primary key,
  -- Stable identity for a file, derived from its path so edits keep the same id.
  doc_id         text    not null,
  -- The permission key. Every read in this project filters on it inside the SQL.
  owner_id       text    not null,
  source_path    text    not null,
  chunk_index    integer not null,
  content        text    not null,
  content_hash   text    not null,
  token_estimate integer not null,
  embedding      vector(__DIMENSIONS__) not null,
  search         tsvector generated always as (to_tsvector('english', content)) stored,
  created_at     timestamptz not null default now()
);

create unique index if not exists chunks_doc_chunk_key on chunks (doc_id, owner_id, chunk_index);
create index if not exists chunks_owner_idx on chunks (owner_id);
create index if not exists chunks_embedding_hnsw on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_search_idx on chunks using gin (search);
