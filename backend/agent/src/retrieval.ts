import {
  COLLECTIONS,
  SEARCH_INDEXES,
  type ChunkDoc,
  type DocumentDoc,
  type Locator
} from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';
import { type Spend } from './llm.js';
import { embedQuery } from './query-embedding.js';

export type RetrievedChunk = {
  docId: string;
  title: string;
  /** The whole chunk. It becomes the citation snippet verbatim — see the note below. */
  text: string;
  locator: Locator;
};

/** Reciprocal rank fusion. 60 is the constant from the original paper and the common default. */
const RRF_K = 60;
const CANDIDATES = 150;
const PER_LIST = 20;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Local-dev fallback for a plain mongod, which has no Search. It is an exact scan, which is
 * why /health has to name which backend served a recall number: an exact scan and an ANN
 * index are not the same measurement and the difference is not visible in the result.
 */
async function cosineScan(
  filter: Record<string, unknown>,
  queryVector: number[],
  limit: number
): Promise<ChunkDoc[]> {
  const rows = await (await db()).collection<ChunkDoc>(COLLECTIONS.chunks).find(filter).toArray();
  return rows
    .map((r) => ({ r, score: cosine(queryVector, r.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ r }) => r);
}

/**
 * Hybrid retrieval: the vector half and the BM25 half, fused by RRF.
 *
 * `spaceId` is a filter INSIDE $vectorSearch, not a $match after it. A post-filter asks the
 * index for the global top-k and then discards everything from other Spaces, so a Space whose
 * chunks are not globally top-k returns nothing and looks like poor recall rather than the
 * leak-shaped bug it is.
 */
export async function searchDocuments(opts: {
  userId: string;
  spaceId: string;
  query: string;
  limit?: number;
  spend?: Spend;
}): Promise<RetrievedChunk[]> {
  const { userId, spaceId, query, limit = 5, spend } = opts;
  const chunks = (await db()).collection<ChunkDoc>(COLLECTIONS.chunks);
  const queryVector = await embedQuery(query, spend);

  let vectorHits: ChunkDoc[];
  let textHits: ChunkDoc[] = [];

  if (env.vectorBackend === 'mongo-cosine-scan') {
    vectorHits = await cosineScan({ spaceId, userId }, queryVector, PER_LIST);
  } else {
    vectorHits = (await chunks
      .aggregate<ChunkDoc>([
        {
          $vectorSearch: {
            index: SEARCH_INDEXES.chunksVector,
            path: 'embedding',
            queryVector,
            numCandidates: CANDIDATES,
            limit: PER_LIST,
            filter: { spaceId, userId }
          }
        }
      ])
      .toArray()) as ChunkDoc[];

    textHits = (await chunks
      .aggregate<ChunkDoc>([
        {
          $search: {
            index: SEARCH_INDEXES.chunksText,
            compound: {
              must: [{ text: { query, path: 'text' } }],
              filter: [
                { equals: { path: 'spaceId', value: spaceId } },
                { equals: { path: 'userId', value: userId } }
              ]
            }
          }
        },
        { $limit: PER_LIST }
      ])
      .toArray()) as ChunkDoc[];
  }

  const fused = new Map<string, { doc: ChunkDoc; score: number }>();
  for (const list of [vectorHits, textHits]) {
    list.forEach((doc, rank) => {
      const key = String(doc._id);
      const prev = fused.get(key);
      const score = 1 / (RRF_K + rank + 1);
      if (prev) prev.score += score;
      else fused.set(key, { doc, score });
    });
  }

  const top = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  if (top.length === 0) return [];

  // Chunks carry a docId, not a title, and a citation chip needs something a person can read.
  const docIds = [...new Set(top.map((t) => t.doc.docId))];
  const titles = new Map(
    (
      await (await db())
        .collection<DocumentDoc>(COLLECTIONS.documents)
        .find({ _id: { $in: docIds } })
        .project<{ _id: string; title: string }>({ title: 1 })
        .toArray()
    ).map((d) => [d._id, d.title])
  );

  return top.map(({ doc }) => ({
    docId: doc.docId,
    title: titles.get(doc.docId) ?? doc.docId,
    // The WHOLE chunk becomes the snippet. recall@5 asks whether a short gold anchor appears
    // inside the snippet, so truncating here throws away recall for no benefit.
    text: doc.text,
    locator: doc.locator
  }));
}
