/**
 * LUMINA agent service — the AI backend. Provider keys live only in this process, and this
 * process is not publicly reachable: the deep-search daily cap is enforced here precisely
 * because a cap on the edge is a cap you bypass by calling the agent directly.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import express from 'express';
import multer from 'multer';
import pino from 'pino';
import { GridFSBucket, type Db } from 'mongodb';
import {
  ACCEPTED_UPLOAD_TYPES,
  newId,
  AskBody,
  COLLECTIONS,
  CreateSpaceBody,
  CreateThreadBody,
  GRIDFS_BUCKETS,
  MAX_UPLOAD_BYTES,
  type DocumentDoc,
  type HealthResponse,
  type JobDoc,
  type MessageDoc,
  type RequestDoc,
  type RunDoc,
  type SpaceDoc,
  type ThreadDoc
} from '@lumina/contract';
import { db, pingDb } from './db.js';
import { env } from './env.js';
import { newAskRecord, runAsk } from './loop.js';
import { deleteMemory, listMemories } from './memory.js';
import { writeRunLog } from './runlog.js';
import { SseStream } from './sse.js';
import { RequestTiming } from './timing.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.locals.receivedAt = performance.now();
  next();
});
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

mkdirSync(env.runsDir, { recursive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// ---------------------------------------------------------------- helpers

type Ctx = { userId: string; requestId: string };

/** `401` without X-User-Id on every route except /health, per the contract. */
function auth(req: express.Request, res: express.Response): Ctx | null {
  const userId = String(req.header('x-user-id') ?? '').trim();
  const requestId = String(req.header('x-request-id') ?? '').trim() || randomUUID();
  if (!userId) {
    res.status(401).json({ error: 'X-User-Id is required', status: 401, requestId });
    return null;
  }
  return { userId, requestId };
}

const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const nextUtcMidnight = () => {
  const d = startOfUtcDay();
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

/** One line per answer, and the row /stats reconciles against. */
async function recordRequest(database: Db, row: RequestDoc): Promise<void> {
  await database.collection<RequestDoc>(COLLECTIONS.requests).insertOne(row);
}

// ---------------------------------------------------------------- health & stats

app.get('/health', async (_req, res) => {
  const dbStatus = await pingDb();
  const body: HealthResponse = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' }
  };
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

app.get('/stats', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    const database = await db();
    const since = startOfUtcDay();
    const requests = database.collection<RequestDoc>(COLLECTIONS.requests);
    const runs = database.collection<RunDoc>(COLLECTIONS.runs);

    const today = await requests.find({ createdAt: { $gte: since } }).toArray();
    const answers = today.filter((r) => r.route.endsWith('/ask'));
    const ttfts = answers.map((r) => r.ms).sort((a, b) => a - b);
    const deepToday = await runs.countDocuments({
      userId: ctx.userId,
      depth: 'deep',
      createdAt: { $gte: since }
    });

    const cacheHits = answers.filter((r) => r.toolCalls !== undefined);
    res.json({
      requests: today.length,
      answers: answers.length,
      searchCacheHitRatePct: cacheHits.length
        ? Math.round((today.filter((r) => r.status === 200).length / today.length) * 100)
        : 0,
      ttftP95Ms: ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.floor(ttfts.length * 0.95))] : 0,
      costUsdToday: Number(today.reduce((sum, r) => sum + (r.costUsd ?? 0), 0).toFixed(6)),
      deepToday,
      deepDailyCap: env.deepDailyCap
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- threads

app.post('/threads', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    const body = CreateThreadBody.parse(req.body ?? {});
    const doc: ThreadDoc = {
      _id: newId('thr'),
      userId: ctx.userId,
      title: body.title ?? 'New thread',
      createdAt: new Date()
    };
    await (await db()).collection<ThreadDoc>(COLLECTIONS.threads).insertOne(doc);
    res.status(201).json({ threadId: doc._id });
  } catch (err) {
    next(err);
  }
});

app.get('/threads', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    const rows = await (await db())
      .collection<ThreadDoc>(COLLECTIONS.threads)
      .find({ userId: ctx.userId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({
      threads: rows.map((t) => ({
        threadId: t._id,
        title: t.title,
        createdAt: new Date(t.createdAt).toISOString()
      }))
    });
  } catch (err) {
    next(err);
  }
});

app.get('/threads/:threadId', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    const database = await db();
    const thread = await database
      .collection<ThreadDoc>(COLLECTIONS.threads)
      .findOne({ _id: req.params.threadId, userId: ctx.userId });
    if (!thread) return res.status(404).json({ error: 'no such thread', status: 404 });

    const messages = await database
      .collection<MessageDoc>(COLLECTIONS.messages)
      .find({ threadId: thread._id, userId: ctx.userId })
      .sort({ createdAt: 1 })
      .toArray();

    res.json({
      threadId: thread._id,
      title: thread.title,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        sources: m.sources ?? [],
        ...(m.answerId ? { answerId: m.answerId } : {}),
        ...(m.done ? { done: m.done } : {}),
        createdAt: new Date(m.createdAt).toISOString()
      }))
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- ask (SSE)

app.post('/threads/:threadId/ask', async (req, res) => {
  const ctx = auth(req, res);
  if (!ctx) return;

  const record = newAskRecord(new RequestTiming(res.locals.receivedAt));
  // Once per response, including rejected/failed quick requests. This runs when the stream
  // closes, before any later persistence failure could cause a second answer log.
  let timingLogged = false;
  const logTiming = () => {
    if (timingLogged || req.body?.depth === 'deep') return;
    timingLogged = true;
    log.info({
      requestId: ctx.requestId,
      depth: 'quick',
      status: res.statusCode,
      elapsedMs: record.timing.elapsedMs,
      searchCached: record.timing.searchCached,
      readers: record.readers
    }, 'quick_timing');
  };
  res.once('finish', logTiming);
  res.once('close', logTiming);

  const startedAt = Date.now();
  const database = await db();
  const threadId = req.params.threadId;

  // Everything that can produce a status code happens BEFORE the stream opens. Once a byte is
  // written the response is a 200 forever, so validation, 404 and the spend gate all run first.
  const parsed = AskBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid body', status: 400 });
  }
  const { query, mode, depth, spaceId } = parsed.data;

  // These are independent reads and every serial Atlas round trip lands directly on the path
  // to the first token, so they go together rather than one after another.
  const [thread, space, priorMessages] = await Promise.all([
    database.collection<ThreadDoc>(COLLECTIONS.threads).findOne({ _id: threadId, userId: ctx.userId }),
    spaceId
      ? database.collection<SpaceDoc>(COLLECTIONS.spaces).findOne({ _id: spaceId, userId: ctx.userId })
      : Promise.resolve(null),
    database
      .collection<MessageDoc>(COLLECTIONS.messages)
      .find({ threadId, userId: ctx.userId })
      .sort({ createdAt: 1 })
      .toArray()
  ]);

  if (!thread) return res.status(404).json({ error: 'no such thread', status: 404 });
  if (spaceId && !space) return res.status(404).json({ error: 'no such space', status: 404 });

  // The spend gate. Enforced here, in the service that holds the keys and the bill.
  if (depth === 'deep') {
    const spentToday = await database.collection<RunDoc>(COLLECTIONS.runs).countDocuments({
      userId: ctx.userId,
      depth: 'deep',
      createdAt: { $gte: startOfUtcDay() }
    });
    if (spentToday >= env.deepDailyCap) {
      return res.status(429).json({
        error: `deep search daily cap of ${env.deepDailyCap} reached`,
        status: 429,
        resetsAt: nextUtcMidnight().toISOString(),
        requestId: ctx.requestId
      });
    }
  }

  const history = priorMessages.map((m) => ({ role: m.role, content: m.content }));

  // The loop is given `query` directly and never reads this row back, so persisting it does
  // not have to block the research starting. It is awaited before the answer is stored, which
  // is what keeps the two in order.
  const userMessageWritten = database.collection<MessageDoc>(COLLECTIONS.messages).insertOne({
    _id: randomUUID(),
    threadId,
    userId: ctx.userId,
    role: 'user',
    content: query,
    sources: [],
    createdAt: new Date()
  });

  const stream = new SseStream(res);

  // Held out here so the catch below can read what the run had spent and done. A log written
  // from constants after an exception is a log that invents its own evidence.

  try {
    const out = await runAsk({
      requestId: ctx.requestId,
      userId: ctx.userId,
      threadId,
      query,
      mode,
      depth,
      spaceId,
      history,
      stream,
      record
    });

    const done = {
      answerId: out.answerId,
      latencyMs: out.latencyMs,
      ttftMs: out.ttftMs,
      model: env.llmModel,
      tokens: { in: out.spend.tokensIn, out: out.spend.tokensOut },
      costUsd: Number(out.spend.costUsd.toFixed(6)),
      searchCached: out.searchCached,
      terminated: out.terminated,
      depth,
      subQuestions: out.subQuestions.length
    };
    stream.send('done', done);
    stream.end();

    await userMessageWritten;
    await database.collection<MessageDoc>(COLLECTIONS.messages).insertOne({
      _id: randomUUID(),
      threadId,
      userId: ctx.userId,
      role: 'assistant',
      content: out.text,
      answerId: out.answerId,
      sources: out.sources,
      done,
      ...(out.subQuestions.length ? { subQuestions: out.subQuestions } : {}),
      createdAt: new Date()
    });

    await writeRunLog(
      ctx.requestId,
      {
        tokens: out.spend.totalTokens,
        wallClockSec: out.latencyMs / 1000,
        costUsd: Number(out.spend.costUsd.toFixed(6)),
        terminated: out.terminated,
        depth,
        toolCalls: out.toolCalls
      },
      { userId: ctx.userId, threadId, answerId: out.answerId, query }
    );

    await recordRequest(database, {
      requestId: ctx.requestId,
      userId: ctx.userId,
      route: 'POST /threads/:threadId/ask',
      status: 200,
      ms: out.ttftMs,
      tokensIn: out.spend.tokensIn,
      tokensOut: out.spend.tokensOut,
      costUsd: done.costUsd,
      toolCalls: out.toolCalls.length,
      terminated: out.terminated,
      depth,
      createdAt: new Date()
    });

    log.info(
      {
        requestId: ctx.requestId,
        userId: ctx.userId,
        toolCalls: out.toolCalls.length,
        terminated: out.terminated,
        tokens: done.tokens,
        costUsd: done.costUsd,
        searchCached: out.searchCached,
        ttftMs: out.ttftMs,
        latencyMs: out.latencyMs,
        depth,
        sources: out.sources.length,
        // Which reader grounded this answer, and how much extracted text the search provider
        // gave us to work with. `rawText.withText: 0` against a non-zero `total` on Tavily is
        // the signature of an extract request the provider ignored: every page silently falls
        // back to being downloaded and parsed, the answer is still correct, and the only thing
        // that changes is the latency this was meant to remove.
        readers: record.readers,
        rawText: record.rawText
      },
      'answer'
    );
  } catch (err) {
    // Fail loud. The run ends as an error, the caller is told 502, and nothing plausible is
    // invented to fill the gap — including in the telemetry. Every number below is measured:
    // the steps are the ones the loop actually emitted, and the cost is what this run really
    // spent before it died. A failure that reports $0 is a failure nobody budgets for.
    const message = err instanceof Error ? err.message : String(err);
    const costUsd = Number(record.spend.costUsd.toFixed(6));
    log.error(
      {
        err,
        requestId: ctx.requestId,
        userId: ctx.userId,
        depth,
        toolCalls: record.toolCalls.length,
        terminated: 'error',
        tokens: { in: record.spend.tokensIn, out: record.spend.tokensOut },
        costUsd,
        subQuestions: record.subQuestions.length,
        latencyMs: Date.now() - startedAt,
        // Reported on the failure path too: how far retrieval got before the run died is part
        // of reading the trajectory, and a reader that returned nothing is a candidate cause.
        readers: record.readers,
        rawText: record.rawText
      },
      'ask failed'
    );
    stream.fail(502, message);

    // The run log has no field for a failure that was not a tool's fault — `toolCalls[].name`
    // is the contract's tool enum, and inventing a member of it is how the last version of
    // this handler came to blame a search that had succeeded. A tool failure is already in
    // `record.toolCalls` with its own error string, courtesy of the loop; anything else is a
    // provider or synthesis failure, and the pino line above is where its message lives.
    await writeRunLog(
      ctx.requestId,
      {
        tokens: record.spend.totalTokens,
        wallClockSec: (Date.now() - startedAt) / 1000,
        costUsd,
        terminated: 'error',
        depth,
        toolCalls: record.toolCalls
      },
      { userId: ctx.userId, threadId, query }
    ).catch(() => undefined);

    await recordRequest(database, {
      requestId: ctx.requestId,
      userId: ctx.userId,
      route: 'POST /threads/:threadId/ask',
      status: 502,
      ms: Date.now() - startedAt,
      // `/stats` reconciles against this collection, so a failed run that omits its spend
      // makes costUsdToday quietly understate the day's bill.
      tokensIn: record.spend.tokensIn,
      tokensOut: record.spend.tokensOut,
      costUsd,
      toolCalls: record.toolCalls.length,
      terminated: 'error',
      depth,
      createdAt: new Date()
    }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------- memory

app.get('/memory', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    res.json({ memories: await listMemories(ctx.userId) });
  } catch (err) {
    next(err);
  }
});

app.delete('/memory/:memoryId', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    const removed = await deleteMemory(ctx.userId, req.params.memoryId);
    if (!removed) return res.status(404).json({ error: 'no such memory', status: 404 });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- spaces & documents

app.post('/spaces', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    const body = CreateSpaceBody.parse(req.body ?? {});
    const doc: SpaceDoc = {
      _id: newId('spc'),
      userId: ctx.userId,
      name: body.name,
      createdAt: new Date()
    };
    await (await db()).collection<SpaceDoc>(COLLECTIONS.spaces).insertOne(doc);
    res.status(201).json({ spaceId: doc._id, name: doc.name });
  } catch (err) {
    next(err);
  }
});

app.get('/spaces', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    const rows = await (await db())
      .collection<SpaceDoc>(COLLECTIONS.spaces)
      .find({ userId: ctx.userId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({
      spaces: rows.map((s) => ({
        spaceId: s._id,
        name: s.name,
        createdAt: new Date(s.createdAt).toISOString()
      }))
    });
  } catch (err) {
    next(err);
  }
});

app.post('/spaces/:spaceId/documents', (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    const ctx = auth(req, res);
    if (!ctx) return;

    if (uploadErr) {
      const tooBig = (uploadErr as { code?: string }).code === 'LIMIT_FILE_SIZE';
      return res
        .status(tooBig ? 413 : 400)
        .json({ error: tooBig ? `file exceeds ${MAX_UPLOAD_BYTES} bytes` : String(uploadErr), status: tooBig ? 413 : 400 });
    }

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'no file uploaded (field name: file)', status: 400 });
    if (!ACCEPTED_UPLOAD_TYPES.includes(file.mimetype as (typeof ACCEPTED_UPLOAD_TYPES)[number])) {
      return res.status(400).json({ error: `unsupported type ${file.mimetype}`, status: 400 });
    }

    try {
      const database = await db();
      const space = await database
        .collection<SpaceDoc>(COLLECTIONS.spaces)
        .findOne({ _id: req.params.spaceId, userId: ctx.userId });
      if (!space) return res.status(404).json({ error: 'no such space', status: 404 });

      // Store the bytes and queue the work. Parsing here would blow the 300ms accept budget and
      // put a 60-page PDF on the thread that is streaming somebody's answer.
      const bucket = new GridFSBucket(database, { bucketName: GRIDFS_BUCKETS.uploads });
      const fileId = await new Promise<string>((resolve, reject) => {
        const up = bucket.openUploadStream(file.originalname, { contentType: file.mimetype });
        up.on('error', reject);
        up.on('finish', () => resolve(String(up.id)));
        up.end(file.buffer);
      });

      const docId = newId('doc');
      await database.collection<DocumentDoc>(COLLECTIONS.documents).insertOne({
        _id: docId,
        spaceId: space._id,
        userId: ctx.userId,
        title: file.originalname,
        mimeType: file.mimetype,
        bytes: file.size,
        status: 'pending',
        pct: 0,
        fileId,
        createdAt: new Date()
      });

      await database.collection<JobDoc>(COLLECTIONS.jobs).insertOne({
        _id: randomUUID(),
        kind: 'index_document',
        status: 'pending',
        payload: { docId },
        userId: ctx.userId,
        attempts: 0,
        createdAt: new Date()
      });

      res.status(202).json({ docId, status: 'pending' });
    } catch (err) {
      log.error({ err }, 'upload failed');
      res.status(502).json({ error: err instanceof Error ? err.message : String(err), status: 502 });
    }
  });
});

app.get('/spaces/:spaceId/documents', async (req, res, next) => {
  const ctx = auth(req, res);
  if (!ctx) return;
  try {
    const rows = await (await db())
      .collection<DocumentDoc>(COLLECTIONS.documents)
      .find({ spaceId: req.params.spaceId, userId: ctx.userId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({
      documents: rows.map((d) => ({
        docId: d._id,
        title: d.title,
        status: d.status,
        pct: d.pct,
        ...(d.pages !== undefined ? { pages: d.pages } : {}),
        ...(d.chunks !== undefined ? { chunks: d.chunks } : {}),
        ...(d.error ? { error: d.error } : {})
      }))
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- fallbacks

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'agent error');
  if (res.headersSent) return;
  res.status(502).json({ error: err.message, status: 502 });
});

app.listen(env.port, () => {
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: {
          toolCalls: env.maxToolCallsDeep,
          wallClockSec: env.maxWallClockSecDeep,
          dailyCap: env.deepDailyCap
        }
      }
    },
    'agent up'
  );
});
