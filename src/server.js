import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { functionCatalog } from "./abi.js";
import { chainById, chains, examples, makeCustomChain, publicHost, rpcForChain } from "./chains.js";
import { config } from "./config.js";
import { normalizeAddress, normalizeRpcUrl } from "./decode.js";
import { mongoStatus } from "./db.js";
import { detectPool } from "./detect.js";
import { clearActiveJob, createScans, factoryWithPools, getSavedScan, listFactories, publicPool, publicScan, runDiscovery, runSavedPoolScan, setActiveJob } from "./factoryJobs.js";
import { getBlockNumber, getChainId } from "./rpc.js";
import { runScan } from "./scan.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const app = express();
const jobs = new Map();
let busy = false;

function takeBusy() {
  if (busy) {
    const err = new Error("A scan is already running. Cancel it before starting another.");
    err.status = 409;
    throw err;
  }
  busy = true;
}

function freeBusy() {
  busy = false;
}

app.use(express.json({ limit: "256kb" }));
app.use(express.static(publicDir, { etag: false, maxAge: 0, index: "index.html" }));

app.get("/api/health", async (_req, res) => {
  const mongo = await mongoStatus();
  res.json({ ok: true, mongo });
});

app.get("/api/meta", (_req, res) => {
  res.json({
    chains: chains.map((chain) => {
      const rpc = rpcForChain(chain);
      return {
        chainId: chain.chainId,
        name: chain.name,
        explorer: chain.explorer,
        trace: chain.trace,
        rpcHost: publicHost(rpc.url),
        rpcFromEnv: rpc.fromEnv,
        hint: rpc.fromEnv
          ? `Using RPC_URL_${chain.chainId} from the environment (${publicHost(rpc.url)}). ${chain.hint}`
          : chain.hint,
      };
    }),
    functions: functionCatalog(),
    examples,
    defaults: {
      maxBlocks: 20,
      maxBlocksCap: config.maxBlocksCap,
    },
  });
});

app.get("/api/head", async (req, res) => {
  try {
    const chainId = parseChainId(req.query.chainId);
    const rpcUrl = normalizeRpcUrl(req.query.rpcUrl);
    if (chainId == null && !rpcUrl) throw new Error("Pick a chain or paste an RPC.");
    const chain = chainId == null ? null : chainById(chainId) || makeCustomChain(chainId);
    const url = rpcUrl || (chain ? rpcForChain(chain).url : null);
    if (!url) throw new Error("This chain needs an RPC URL.");
    const block = await getBlockNumber(url, { timeoutMs: 12_000 });
    const id = chain?.chainId ?? await getChainId(url, { timeoutMs: 12_000 });
    res.json({ block, chainId: id, rpcHost: publicHost(url) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/detect", async (req, res) => {
  try {
    const found = await detectPool({
      address: req.body?.address,
      chainId: parseChainId(req.body?.chainId),
      rpcUrl: normalizeRpcUrl(req.body?.rpcUrl),
    });
    res.json(publicDetection(found));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/scans", (req, res) => {
  try {
    takeBusy();
  } catch (err) {
    res.status(409).json({ error: err.message });
    return;
  }
  let request;
  try {
    request = parseScan(req.body || {});
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  trimJobs();
  const id = randomUUID();
  const job = createJob();
  jobs.set(id, job);
  res.json({ id });
  runScan(request, {
    signal: job.abort.signal,
    emit: (event, data) => job.push(event, data),
  }).catch((err) => {
    job.push("error", { message: err.message || String(err) });
  }).finally(freeBusy);
});

app.get("/api/factories", async (_req, res) => {
  try {
    const factories = await listFactories();
    res.json({ factories: factories.map(publicFactory) });
  } catch (err) {
    res.status(503).json({ error: `MongoDB is not available. ${err.message}` });
  }
});

app.get("/api/factories/:id", async (req, res) => {
  try {
    const found = await factoryWithPools(req.params.id);
    if (!found) {
      res.status(404).json({ error: "Unknown factory." });
      return;
    }
    res.json({
      factory: publicFactory(found.factory),
      pools: found.pools.map(publicPool),
      scans: found.scans.map(publicScan),
    });
  } catch (err) {
    res.status(503).json({ error: `MongoDB is not available. ${err.message}` });
  }
});

app.get("/api/factories/:id/export", async (req, res) => {
  try {
    const found = await factoryWithPools(req.params.id);
    if (!found) {
      res.status(404).json({ error: "Unknown factory." });
      return;
    }
    const rows = found.pools.map(publicPool);
    if (req.query.format === "csv") {
      sendCsv(res, `pools-${found.factory.chainId}.csv`, rows);
      return;
    }
    res.json({ factory: publicFactory(found.factory), pools: rows });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.post("/api/factories/discover", (req, res) => {
  let chain;
  let rpcUrl;
  let factory;
  let fromBlock = null;
  let toBlock = null;
  try {
    takeBusy();
    factory = normalizeAddress(req.body?.address);
    const chainId = parseChainId(req.body?.chainId);
    if (chainId == null) throw new Error("Pick a chain for factory discovery.");
    chain = chainById(chainId) || makeCustomChain(chainId);
    rpcUrl = normalizeRpcUrl(req.body?.rpcUrl) || rpcForChain(chain).url;
    if (!rpcUrl) throw new Error("This chain needs an RPC URL.");
    if (req.body?.fromBlock != null && req.body.fromBlock !== "") fromBlock = requireInt(req.body.fromBlock, "Start block");
    if (req.body?.toBlock != null && req.body.toBlock !== "") toBlock = requireInt(req.body.toBlock, "End block");
  } catch (err) {
    if (err.status !== 409) freeBusy();
    res.status(err.status || 400).json({ error: err.message });
    return;
  }
  const id = randomUUID();
  const job = createJob();
  jobs.set(id, job);
  res.json({ id });
  runDiscovery({
    chain,
    rpcUrl,
    factory,
    fromBlock,
    toBlock,
    signal: job.abort.signal,
    onProgress: (progress) => job.push("progress", progress),
  }).then((result) => {
    job.push("done", {
      factoryId: result.id,
      poolCount: result.poolCount,
      kind: result.kind,
      mode: result.mode,
      head: result.head,
    });
  }).catch((err) => {
    job.push("error", { message: err.message || String(err) });
  }).finally(freeBusy);
});

app.post("/api/factories/:id/scan", async (req, res) => {
  const factoryId = req.params.id;
  try {
    takeBusy();
    const created = await createScans({
      factoryId,
      addresses: Array.isArray(req.body?.addresses) ? req.body.addresses : [],
    });
    const id = randomUUID();
    const job = createJob();
    jobs.set(id, job);
    await setActiveJob(factoryId, id);
    res.json({ id, scanIds: created.scanIds, head: created.head });
    runScanQueue(factoryId, created.scanIds, job).finally(() => {
      clearActiveJob(factoryId, id).catch(() => {});
      freeBusy();
    });
  } catch (err) {
    if (err.status !== 409) freeBusy();
    if (!res.headersSent) res.status(err.status || 400).json({ error: err.message });
  }
});

app.post("/api/saved-scans/:id/resume", async (req, res) => {
  try {
    takeBusy();
  } catch (err) {
    res.status(409).json({ error: err.message });
    return;
  }
  const scanId = decodeURIComponent(req.params.id);
  const id = randomUUID();
  const job = createJob();
  jobs.set(id, job);
  let factoryId = null;
  try {
    const scan = await getSavedScan(scanId);
    if (!scan) throw new Error("Unknown saved scan.");
    factoryId = scan.factoryId;
    await setActiveJob(factoryId, id);
  } catch (err) {
    freeBusy();
    res.status(404).json({ error: err.message });
    return;
  }
  res.json({ id, scanId });
  runSavedPoolScan({
    scanId,
    signal: job.abort.signal,
    emit: (event, data) => job.push(event, data),
  }).catch((err) => {
    job.push("error", { message: err.message || String(err) });
  }).finally(() => {
    if (factoryId) clearActiveJob(factoryId, id).catch(() => {});
    freeBusy();
  });
});

app.get("/api/saved-scans/:id", async (req, res) => {
  try {
    const scan = await getSavedScan(decodeURIComponent(req.params.id));
    if (!scan) {
      res.status(404).json({ error: "Unknown saved scan." });
      return;
    }
    res.json({ scan: publicScan(scan), rows: scan.rows || [] });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get("/api/saved-scans/:id/export", async (req, res) => {
  try {
    const found = await factoryWithPools(req.query.factoryId);
    const scan = found?.scans?.find((item) => item._id === decodeURIComponent(req.params.id));
    if (!scan) {
      res.status(404).json({ error: "Unknown saved scan." });
      return;
    }
    if (req.query.format === "csv") {
      sendCsv(res, "callers.csv", scan.rows || []);
      return;
    }
    res.json({ scan: publicScan(scan), rows: scan.rows || [] });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get("/api/scans/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Unknown scan." });
    return;
  }
  res.json({
    id: req.params.id,
    status: job.status,
    meta: job.meta,
    progress: job.progress,
    snapshot: job.snapshot,
    error: job.error,
  });
});

app.get("/api/scans/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Unknown scan." });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  if (job.meta) send("meta", job.meta);
  if (job.progress) send("progress", job.progress);
  send("logHistory", job.logs);
  if (job.snapshot) send("snapshot", job.snapshot);
  if (job.terminal) {
    send(job.terminal.event, job.terminal.data);
    res.end();
    return;
  }
  const listener = (event, data) => {
    send(event, data);
    if (event === "done" || event === "error") res.end();
  };
  job.listeners.add(listener);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: ping\n\n`);
  }, 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    job.listeners.delete(listener);
  });
});

app.post("/api/scans/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Unknown scan." });
    return;
  }
  job.abort.abort();
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || "Could not read that request." });
});

function createJob() {
  return {
    status: "running",
    abort: new AbortController(),
    logs: [],
    meta: null,
    progress: null,
    snapshot: null,
    error: null,
    terminal: null,
    listeners: new Set(),
    createdAt: Date.now(),
    push(event, data) {
      if (event === "log") this.logs.push(data);
      if (event === "meta") this.meta = data;
      if (event === "progress") this.progress = data;
      if (event === "snapshot") this.snapshot = data;
      if (event === "done") {
        this.status = data?.cancelled ? "cancelled" : "done";
        this.terminal = { event, data };
      }
      if (event === "error") {
        this.status = "error";
        this.error = data;
        this.terminal = { event, data };
      }
      if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
      for (const listener of this.listeners) listener(event, data);
    },
  };
}

function trimJobs() {
  const finished = [...jobs.entries()].filter(([, job]) => job.status !== "running");
  while (jobs.size > 20 && finished.length) {
    const [id] = finished.shift();
    jobs.delete(id);
  }
}

function parseScan(body) {
  const address = normalizeAddress(body.address);
  const rpcUrl = normalizeRpcUrl(body.rpcUrl);
  const chainId = parseChainId(body.chainId);
  const startBlock = requireInt(body.startBlock, "Start block");
  const endBlock = body.endBlock == null || body.endBlock === "" ? null : requireInt(body.endBlock, "End block");
  const maxBlocks = body.maxBlocks == null || body.maxBlocks === "" ? 20 : requireInt(body.maxBlocks, "Max blocks");
  const maxTx = body.maxTx == null || body.maxTx === "" ? null : requireInt(body.maxTx, "Max transactions");
  if (startBlock < 0) throw new Error("Start block must be a non-negative integer.");
  if (maxBlocks < 1) throw new Error("Max blocks must be a positive integer.");
  if (maxTx != null && (maxTx < 1 || maxTx > 100_000)) {
    throw new Error("Max transactions must be between 1 and 100000.");
  }
  if (!Array.isArray(body.functions) || body.functions.length === 0) {
    throw new Error("Pick at least one function.");
  }
  if (chainId != null && !chainById(chainId) && !rpcUrl) {
    throw new Error("A custom chain id needs an RPC URL.");
  }
  return {
    address,
    rpcUrl,
    chainId,
    startBlock,
    endBlock,
    maxBlocks,
    maxTx,
    functions: body.functions.map(String),
  };
}

function parseChainId(value) {
  if (value == null || value === "" || value === "auto") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1) throw new Error("Chain id must be a positive integer.");
  return n;
}

function requireInt(value, name) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  throw new Error(`${name} must be an integer.`);
}

function publicDetection(found) {
  return {
    pool: found.pool,
    chainId: found.chain.chainId,
    chainName: found.chain.name,
    explorer: found.chain.explorer,
    version: found.version,
    symbol0: found.symbol0,
    symbol1: found.symbol1,
    token0: found.token0,
    token1: found.token1,
    fee: found.fee,
    feeLabel: found.feeLabel,
    codeBytes: found.codeBytes,
    rpcHost: publicHost(found.rpcUrl),
    alsoFound: found.alsoFound || [],
  };
}

async function runScanQueue(factoryId, scanIds, job) {
  const finished = [];
  try {
    for (const scanId of scanIds) {
      if (job.abort.signal.aborted) break;
      job.push("log", { level: "info", message: `Pool scan ${scanId}` });
      await runSavedPoolScan({
        scanId,
        signal: job.abort.signal,
        emit: (event, data) => job.push(event, data),
        finalEvent: "poolDone",
      });
      finished.push(scanId);
    }
    job.push("done", { status: job.abort.signal.aborted ? "paused" : "done", scanIds: finished, factoryId });
  } catch (err) {
    job.push("error", { message: err.message || String(err) });
  }
}

function publicFactory(doc) {
  return {
    id: doc._id,
    chainId: doc.chainId,
    chainName: doc.chainName,
    address: doc.address,
    kind: doc.kind,
    mode: doc.mode,
    poolCount: doc.poolCount,
    head: doc.head,
    status: doc.status,
    rpcHost: doc.rpcHost,
    explorer: doc.explorer,
    activeJobId: doc.activeJobId || null,
    updatedAt: doc.updatedAt,
  };
}

function sendCsv(res, filename, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = [...new Set(list.flatMap((row) => Object.keys(row).filter((key) => key !== "_id")))];
  const lines = [keys.join(",")];
  for (const row of list) lines.push(keys.map((key) => csvCell(row[key])).join(","));
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${filename}"`);
  res.send(`\uFEFF${lines.join("\n")}`);
}

function csvCell(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Pool callers listening on http://127.0.0.1:${config.port}`);
});

server.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
