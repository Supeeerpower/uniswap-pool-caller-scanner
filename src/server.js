import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { functionCatalog } from "./abi.js";
import { chainById, chains, examples, makeCustomChain, publicHost, rpcForChain } from "./chains.js";
import { config } from "./config.js";
import { normalizeAddress, normalizeRpcUrl } from "./decode.js";
import { detectPool } from "./detect.js";
import { getBlockNumber, getChainId } from "./rpc.js";
import { runScan } from "./scan.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const app = express();
const jobs = new Map();

app.use(express.json({ limit: "256kb" }));
app.use(express.static(publicDir, { etag: false, maxAge: 0, index: "index.html" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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
  if ([...jobs.values()].some((job) => job.status === "running")) {
    res.status(409).json({ error: "A scan is already running. Cancel it before starting another." });
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
  });
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

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Pool callers listening on http://127.0.0.1:${config.port}`);
});

server.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
