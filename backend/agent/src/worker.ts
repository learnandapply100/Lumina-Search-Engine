/**
 * The jobs worker: GridFS → parse → chunk → embed → upsert → read-your-write probe → indexed.
 *
 * Runs as its own process. Parsing a PDF with pdfjs is CPU-bound and Node is single-threaded,
 * so doing it here rather than inside the agent service is what keeps a 60-page upload from
 * stalling the answer somebody else is streaming — which the bench measures directly as search
 * p95 during an ingest.
 */
import { randomUUID } from 'node:crypto';
import { GridFSBucket, type Db } from 'mongodb';
import pino from 'pino';
import {
  COLLECTIONS,
  GRIDFS_BUCKETS,
  SEARCH_INDEXES,
  type ChunkDoc,
  type DocumentDoc,
  type JobDoc,
  type Locator
} from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';
import { embed } from './llm.js';
import { sliceChars } from './text.js';

const log = pino({ level: env.logLevel });
const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

const POLL_MS = 1000;
/** A `running` row older than this belonged to a worker that died. */
const STALE_CLAIM_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH = 64;

const PROBE_TIMEOUT_MS = 90 * 1000;
const PROBE_INTERVAL_MS = 2000;

// ---------------------------------------------------------------- parsing

type ParsedUnit = { text: string; locator: Locator };

/** Page-aware, because a citation that cannot name a page is not a citation to a PDF. */
async function parsePdf(bytes: Buffer): Promise<{ units: ParsedUnit[]; pages: number }> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true
  }).promise;

  const units: ParsedUnit[] = [];
  for (let page = 1; page <= pdf.numPages; page++) {
    const content = await (await pdf.getPage(page)).getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) units.push({ text, locator: { page } });
  }
  return { units, pages: pdf.numPages };
}

/** Markdown and plain text: split on headings where there are any, else on line blocks. */
function parseText(raw: string, isMarkdown: boolean): { units: ParsedUnit[]; pages: number } {
  const lines = raw.split('\n');

  if (isMarkdown && /^#{1,6}\s/m.test(raw)) {
    const units: ParsedUnit[] = [];
    let heading = 'Introduction';
    let buffer: string[] = [];
    const flush = () => {
      const text = buffer.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text) units.push({ text, locator: { heading } });
      buffer = [];
    };
    for (const line of lines) {
      const match = line.match(/^#{1,6}\s+(.*)$/);
      if (match) {
        flush();
        heading = match[1]?.trim() || heading;
      } else {
        buffer.push(line);
      }
    }
    flush();
    return { units, pages: 1 };
  }

  const units: ParsedUnit[] = [];
  const PER_BLOCK = 40;
  for (let i = 0; i < lines.length; i += PER_BLOCK) {
    const text = lines.slice(i, i + PER_BLOCK).join('\n').trim();
    if (text) units.push({ text, locator: { line: i + 1 } });
  }
  return { units, pages: 1 };
}

/**
 * Split a unit that is too long, keeping its locator. Overlap so a fact sitting on a boundary
 * is whole in at least one chunk — a chunk is cited verbatim, so a sentence cut in half is a
 * citation that cannot be verified.
 */
function chunkUnit(unit: ParsedUnit): ParsedUnit[] {
  if (unit.text.length <= CHUNK_CHARS) return [unit];
  const out: ParsedUnit[] = [];
  let start = 0;
  while (start < unit.text.length) {
    const end = Math.min(start + CHUNK_CHARS, unit.text.length);
    // Windowed by code unit, so either end can land mid-surrogate-pair. A chunk is embedded
    // and later handed to the model verbatim, so half a character here breaks both calls.
    const slice = sliceChars(unit.text, start, end).trim();
    if (slice) out.push({ text: slice, locator: unit.locator });
    if (end >= unit.text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return out;
}

// ---------------------------------------------------------------- the probe

/**
 * "Upserted" is not "searchable". An Atlas Search index is eventually consistent, so a document
 * marked ready the moment its chunks are written is a document the UI says is available and
 * retrieval intermittently cannot find. The status only advances once the index hands a chunk
 * back.
 */
async function probeUntilSearchable(
  database: Db,
  doc: DocumentDoc,
  probeVector: number[]
): Promise<boolean> {
  const chunks = database.collection<ChunkDoc>(COLLECTIONS.chunks);
  const deadline = Date.now() + PROBE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (env.vectorBackend === 'mongo-cosine-scan') {
      // A plain mongod has no async index to wait for: the write is the read.
      return (await chunks.countDocuments({ docId: doc._id })) > 0;
    }
    const hits = await chunks
      .aggregate<{ docId: string }>([
        {
          $vectorSearch: {
            index: SEARCH_INDEXES.chunksVector,
            path: 'embedding',
            queryVector: probeVector,
            numCandidates: 100,
            limit: 10,
            filter: { spaceId: doc.spaceId, userId: doc.userId }
          }
        },
        { $project: { docId: 1 } }
      ])
      .toArray();
    if (hits.some((h) => h.docId === doc._id)) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return false;
}

// ---------------------------------------------------------------- the job

async function indexDocument(database: Db, docId: string): Promise<void> {
  const documents = database.collection<DocumentDoc>(COLLECTIONS.documents);
  const chunks = database.collection<ChunkDoc>(COLLECTIONS.chunks);

  const doc = await documents.findOne({ _id: docId });
  if (!doc) throw new Error(`document ${docId} vanished before indexing`);

  const setStatus = (status: DocumentDoc['status'], pct: number, extra: Partial<DocumentDoc> = {}) =>
    documents.updateOne({ _id: docId }, { $set: { status, pct, ...extra } });

  // Idempotent replay: a job re-queued by the sweeper must not re-embed what it already wrote.
  const existing = await chunks.countDocuments({ docId });
  let probeVector: number[] | undefined;

  if (existing === 0) {
    await setStatus('parsing', 10);

    const bucket = new GridFSBucket(database, { bucketName: GRIDFS_BUCKETS.uploads });
    const parts: Buffer[] = [];
    for await (const part of bucket.openDownloadStream(
      // GridFS ids round-trip as strings through the documents row.
      (await import('mongodb')).ObjectId.createFromHexString(doc.fileId)
    )) {
      parts.push(part as Buffer);
    }
    const bytes = Buffer.concat(parts);

    const parsed =
      doc.mimeType === 'application/pdf'
        ? await parsePdf(bytes)
        : parseText(bytes.toString('utf8'), doc.mimeType === 'text/markdown');

    const units = parsed.units.flatMap(chunkUnit);
    if (units.length === 0) throw new Error(`parsed ${doc.title} but found no text`);

    await setStatus('embedding', 40, { pages: parsed.pages, chunks: units.length });

    for (let i = 0; i < units.length; i += EMBED_BATCH) {
      const batch = units.slice(i, i + EMBED_BATCH);
      const vectors = await embed(batch.map((u) => u.text));
      await chunks.bulkWrite(
        batch.map((unit, j) => ({
          updateOne: {
            // Deterministic id: a replay overwrites its own chunk instead of adding a twin.
            filter: { _id: `${docId}:${i + j}` },
            update: {
              $set: {
                docId,
                spaceId: doc.spaceId,
                userId: doc.userId,
                text: unit.text,
                locator: unit.locator,
                ord: i + j,
                embedding: vectors[j]!,
                createdAt: new Date()
              }
            },
            upsert: true
          }
        }))
      );
      if (i === 0) probeVector = vectors[0];
      await setStatus('embedding', 40 + Math.round((50 * (i + batch.length)) / units.length));
    }
  }

  if (!probeVector) {
    const any = await chunks.findOne({ docId }, { sort: { ord: 1 } });
    if (!any) throw new Error(`no chunks for ${docId} after indexing`);
    probeVector = any.embedding;
  }

  await setStatus('embedding', 95);
  const searchable = await probeUntilSearchable(database, doc, probeVector);
  if (!searchable) {
    throw new Error(`chunks for ${doc.title} were written but the vector index did not return them in time`);
  }

  await setStatus('indexed', 100);
  log.info({ docId, title: doc.title }, 'document indexed and verified searchable');
}

// ---------------------------------------------------------------- the loop

async function claim(database: Db): Promise<JobDoc | null> {
  return database.collection<JobDoc>(COLLECTIONS.jobs).findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'running', claimedAt: new Date(), workerId }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
}

/** Returns rows whose worker died mid-job to the queue. Finished stages are not re-run. */
async function sweep(database: Db): Promise<void> {
  const res = await database.collection<JobDoc>(COLLECTIONS.jobs).updateMany(
    {
      status: 'running',
      claimedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) },
      attempts: { $lt: MAX_ATTEMPTS }
    },
    { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } }
  );
  if (res.modifiedCount) log.warn({ reclaimed: res.modifiedCount }, 'swept stale jobs back to pending');
}

async function main(): Promise<void> {
  const database = await db();
  log.info({ workerId, vectorStore: env.vectorBackend }, 'jobs worker up');

  setInterval(() => void sweep(database).catch((err) => log.error({ err }, 'sweep failed')), SWEEP_EVERY_MS);

  for (;;) {
    let job: JobDoc | null = null;
    try {
      job = await claim(database);
    } catch (err) {
      log.error({ err }, 'claim failed');
    }

    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    const jobs = database.collection<JobDoc>(COLLECTIONS.jobs);
    try {
      if (job.kind !== 'index_document') throw new Error(`unknown job kind ${job.kind}`);
      await indexDocument(database, String(job.payload.docId));
      await jobs.updateOne({ _id: job._id }, { $set: { status: 'done' } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, jobId: job._id }, 'job failed');
      const giveUp = (job.attempts ?? 1) >= MAX_ATTEMPTS;
      await jobs.updateOne(
        { _id: job._id },
        { $set: { status: giveUp ? 'failed' : 'pending', error: message } }
      );
      if (giveUp) {
        await database
          .collection<DocumentDoc>(COLLECTIONS.documents)
          .updateOne({ _id: String(job.payload.docId) }, { $set: { status: 'failed', error: message } });
      }
    }
  }
}

void main().catch((err) => {
  log.fatal({ err }, 'worker died');
  process.exit(1);
});
