import { COLLECTIONS, SEARCH_INDEXES, newId, type Memory, type MemoryDoc } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';
import { embedOne, type Spend } from './llm.js';

const memories = async () => (await db()).collection<MemoryDoc>(COLLECTIONS.memories);

/**
 * Written only by an explicit save_memory tool call. Nothing else in the system may write
 * here: a memory the user cannot see in /memory is a memory they cannot delete, and the
 * assignment's rule is that deleting one makes its effect disappear.
 */
export async function saveMemory(opts: {
  userId: string;
  text: string;
  sourceThread?: string;
  spend?: Spend;
}): Promise<Memory> {
  const { userId, text, sourceThread, spend } = opts;
  const doc: MemoryDoc = {
    _id: newId('mem'),
    userId,
    text,
    embedding: await embedOne(text, spend),
    ...(sourceThread ? { sourceThread } : {}),
    createdAt: new Date()
  };
  await (await memories()).insertOne(doc);
  return {
    id: doc._id,
    text: doc.text,
    ...(sourceThread ? { sourceThread } : {}),
    createdAt: new Date(doc.createdAt).toISOString()
  };
}

/**
 * Semantic recall over the user's own memories. Filtered by userId inside the vector stage
 * for the same reason chunks are filtered by spaceId there: a post-filter would return one
 * user's memories to another before hiding them.
 */
export async function recallMemory(opts: {
  userId: string;
  query: string;
  limit?: number;
  spend?: Spend;
}): Promise<string[]> {
  const { userId, query, limit = 5, spend } = opts;
  const collection = await memories();
  const t0 = Date.now();
  const queryVector = await embedOne(query, spend);
  const t1 = Date.now();

  if (env.vectorBackend === 'mongo-cosine-scan') {
    const all = await collection.find({ userId }).toArray();
    return all
      .map((m) => {
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < queryVector.length; i++) {
          const x = queryVector[i] ?? 0;
          const y = m.embedding[i] ?? 0;
          dot += x * y;
          na += x * x;
          nb += y * y;
        }
        return { text: m.text, score: dot / (Math.sqrt(na) * Math.sqrt(nb) || 1) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((m) => m.text);
  }

  const hits = await collection
    .aggregate<{ text: string }>([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.memoriesVector,
          path: 'embedding',
          queryVector,
          numCandidates: 100,
          limit,
          filter: { userId }
        }
      },
      { $project: { text: 1 } }
    ])
    .toArray();
  const t2 = Date.now();
  console.log(`embed: ${t1 - t0}ms, vectorSearch: ${t2 - t1}ms`);

  return hits.map((h) => h.text);
}

export async function listMemories(userId: string): Promise<Memory[]> {
  const rows = await (await memories()).find({ userId }).sort({ createdAt: -1 }).toArray();
  return rows.map((r) => ({
    id: r._id,
    text: r.text,
    ...(r.sourceThread ? { sourceThread: r.sourceThread } : {}),
    createdAt: new Date(r.createdAt).toISOString()
  }));
}

/** Scoped by userId as well as id, so one user cannot delete another's memory by guessing. */
export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const res = await (await memories()).deleteOne({ _id: id, userId });
  return res.deletedCount === 1;
}
