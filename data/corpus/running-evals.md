# Running evals on a retrieval system

## What to measure

Two numbers carry most of the weight.

**Retrieval hit rate at k**: for a known question, did the chunk that contains the answer appear in the top k? This is the ceiling on everything downstream. If retrieval misses, a perfect model still cannot cite it, and the failure looks like a hallucination when it is really an index problem.

**Citation correctness**: did the answer cite the source that actually supports it, rather than some source that happened to be in context? An answer can be right and still cite the wrong chunk, which is worse than no answer because it trains nobody to trust the citations.

Report both separately. A single blended score hides which half is broken, and they need completely different fixes: chunking and embedding for the first, prompting and refusal thresholds for the second.

## Building a question set that is worth anything

Write questions from the documents you actually index, and store the expected source path with each one. Ten questions covering the real vocabulary of a corpus tell you more than a hundred synthetic paraphrases generated from the same text, because synthetic questions inherit the phrasing of their source and retrieval aces them by accident.

Include three kinds you will be tempted to skip:

- A question with **no answer** in the corpus. The correct behaviour is a refusal. If the system always answers, your hit rate is measuring something else.
- A question whose answer uses an **exact term**: a config key, an error string, a model id. This is where pure vector search falls over and hybrid earns its keep.
- A question whose answer is **split across two chunks**, so you learn whether overlap is doing its job.

## What a fake embedding proves, and what it does not

This project ships a deterministic local embedding provider so tests and `npm run eval` run with no key and no network. That is enough to prove the plumbing: chunking, owner filtering, fusion order, citation wiring, refusal paths, the agent's step and spend limits. It is not enough to claim search quality. A hash-based vector finds shared words, not meaning, so a hit rate measured with it says nothing about Voyage or any real model.

Read the provider name in the eval output before comparing any two runs. A number that moves because the chunk size changed is a retrieval result; a number that moves because a fake provider was swapped for a real one is mostly a different measurement.

## Keeping it honest

Run eval in CI on every change that touches chunking, fusion or the prompt. Commit the question set, because a metric without a fixed input is a mood. When a fix is needed, add the failing question first, keep it in the set afterwards, and it becomes a regression test for free.

Watch the refusals too. A threshold tuned until nothing is ever refused looks like a perfect hit rate and is just confidence theatre.
