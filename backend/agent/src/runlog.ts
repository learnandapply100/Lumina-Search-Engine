import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLECTIONS, RunLog, type RunDoc } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';

/**
 * One file per answer, in the exact shape `quality/check.mjs` reads. Parsed through the
 * contract on the way out so a drift fails here — where the message names the field — rather
 * than three days later as an unexplained gate failure.
 *
 * Mirrored into Mongo as well: the file is what the grader reads, the collection is what
 * `/stats` reconciles against and what survives a container that does not keep its disk.
 */
export async function writeRunLog(
  requestId: string,
  log: RunLog,
  meta: { userId?: string; threadId?: string; answerId?: string; query?: string } = {}
): Promise<void> {
  const parsed = RunLog.parse(log);

  await writeFile(join(env.runsDir, `${requestId}.json`), JSON.stringify(parsed, null, 2), 'utf8');

  const doc: RunDoc = { ...parsed, requestId, ...meta, createdAt: new Date() };
  await (await db())
    .collection<RunDoc>(COLLECTIONS.runs)
    .updateOne({ requestId }, { $set: doc }, { upsert: true });
}
