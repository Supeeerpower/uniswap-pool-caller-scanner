import { chainById, makeCustomChain, publicHost, rpcForChain } from "./chains.js";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { discoverFactory, scanFunctionFor } from "./factory.js";
import { getBlockNumber } from "./rpc.js";
import { runScan } from "./scan.js";

function factoryId(chainId, address) {
  return `${chainId}:${address.toLowerCase()}`;
}

function poolId(chainId, address) {
  return `${chainId}:${address.toLowerCase()}`;
}

export function scanProgress(scan) {
  const start = scan?.creationBlock;
  const end = scan?.targetEnd;
  const last = scan?.lastScannedBlock;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    return { pct: null, block: Number.isInteger(last) ? last : null };
  }
  const span = end - start + 1;
  const done = Number.isInteger(last) ? Math.max(0, Math.min(span, last - start + 1)) : 0;
  return {
    pct: Math.round((done / span) * 100),
    block: Number.isInteger(last) ? last : null,
    done,
    span,
  };
}

const progressTimers = new Map();

// Debounced so a chunk-by-chunk trace does not rewrite the scan document on every
// response. A late write cannot clobber a terminal status.
export function scheduleScanProgress(scanId, fields) {
  const prev = progressTimers.get(scanId);
  if (prev) {
    prev.fields = fields;
    return prev.promise;
  }
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const slot = { fields, promise };
  progressTimers.set(scanId, slot);
  setTimeout(async () => {
    progressTimers.delete(scanId);
    try {
      const db = await getDb();
      await db.collection("scans").updateOne(
        { _id: scanId, status: { $in: ["queued", "running"] } },
        { $set: { status: "running", ...slot.fields, error: null, updatedAt: new Date() } },
      );
    } catch {
      // The segment-end update still records the checkpoint.
    } finally {
      resolve();
    }
  }, 700);
  return promise;
}

export async function saveDiscovery({ chain, rpcUrl, factory, fromBlock, result }) {
  const db = await getDb();
  const id = factoryId(chain.chainId, factory);
  const now = new Date();
  await db.collection("factories").updateOne(
    { _id: id },
    {
      $set: {
        _id: id,
        chainId: chain.chainId,
        chainName: chain.name,
        explorer: chain.explorer,
        rpcHost: publicHost(rpcUrl),
        address: factory,
        kind: result.kind,
        mode: result.mode,
        poolCount: result.poolCount,
        head: result.head,
        fromBlock: fromBlock ?? null,
        status: "discovered",
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  if (result.pools.length) {
    await db.collection("pools").bulkWrite(result.pools.map((pool) => ({
      updateOne: {
        filter: { _id: poolId(chain.chainId, pool.pool) },
        update: {
          $set: {
            ...pool,
            _id: poolId(chain.chainId, pool.pool),
            factoryId: id,
            chainId: chain.chainId,
            address: pool.pool,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    })), { ordered: false });
  }
  return id;
}

export async function listFactories() {
  const db = await getDb();
  return db.collection("factories").find({}).sort({ updatedAt: -1 }).limit(40).toArray();
}

export async function factoryWithPools(id) {
  const db = await getDb();
  const factory = await db.collection("factories").findOne({ _id: id });
  if (!factory) return null;
  const pools = await db.collection("pools").find({ factoryId: id }).sort({ creationBlock: 1, address: 1 }).toArray();
  const scans = await db.collection("scans").find({ factoryId: id }).sort({ updatedAt: -1 }).toArray();
  return { factory, pools, scans };
}

export async function getSavedScan(id) {
  const db = await getDb();
  return db.collection("scans").findOne({ _id: id });
}

export async function setActiveJob(factoryId, jobId) {
  const db = await getDb();
  await db.collection("factories").updateOne(
    { _id: factoryId },
    { $set: { activeJobId: jobId, updatedAt: new Date() } },
  );
}

export async function clearActiveJob(factoryId, jobId) {
  const db = await getDb();
  await db.collection("factories").updateOne(
    { _id: factoryId, activeJobId: jobId },
    { $unset: { activeJobId: "" }, $set: { updatedAt: new Date() } },
  );
}

export async function runDiscovery({ chain, rpcUrl, factory, fromBlock, toBlock, signal, onProgress }) {
  const result = await discoverFactory({
    rpcUrl,
    factory,
    chainId: chain.chainId,
    fromBlock,
    toBlock,
    signal,
    onProgress,
  });
  const id = await saveDiscovery({ chain, rpcUrl, factory, fromBlock, result });
  return { id, ...result };
}

function scanKind(pool) {
  return scanFunctionFor(pool.kind);
}

export async function runSavedPoolScan({ scanId, signal, emit, finalEvent = "done" }) {
  const db = await getDb();
  const scan = await db.collection("scans").findOne({ _id: scanId });
  if (!scan) throw new Error("Unknown saved scan.");
  const pool = await db.collection("pools").findOne({ _id: scan.poolId });
  if (!pool) throw new Error("The pool for this scan is no longer stored.");
  const chain = chainById(scan.chainId) || makeCustomChain(scan.chainId);
  const rpcUrl = rpcForChain(chain).url;
  const head = await getBlockNumber(rpcUrl, { timeoutMs: 15_000 });
  const target = Math.max(scan.targetEnd || 0, head);
  let last = Number.isInteger(scan.lastScannedBlock) ? scan.lastScannedBlock : pool.creationBlock - 1;
  let rows = scan.rows || [];
  await db.collection("scans").updateOne({ _id: scanId }, {
    $set: { status: "running", targetEnd: target, updatedAt: new Date(), error: null },
  });
  emit("log", { level: "info", message: `${pool.symbol0 || "token0"} / ${pool.symbol1 || "token1"} ${pool.address} from block ${last + 1} through ${target}.` });
  emit("progress", {
    phase: "scanning",
    status: "running",
    scanId,
    address: pool.address,
    creationBlock: pool.creationBlock,
    targetEnd: target,
    lastBlock: last,
    callers: rows.length,
    matchedCalls: scan.matchedCalls || 0,
  });
  while (last < target) {
    if (signal?.aborted) break;
    const start = last + 1;
    const end = Math.min(target, start + config.maxBlocksCap - 1);
    emit("log", { level: "info", message: `Segment ${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")}.` });
    const outcome = await runSegment({
      scan,
      pool,
      chainId: scan.chainId,
      rpcUrl,
      start,
      end,
      rows,
      signal,
      emit,
      targetEnd: target,
    });
    if (outcome.cancelled) {
      await db.collection("scans").updateOne({ _id: scanId }, {
        $set: { status: "paused", lastScannedBlock: outcome.lastBlock ?? last, rows: outcome.rows, updatedAt: new Date() },
      });
      emit(finalEvent, { status: "paused", scanId, lastScannedBlock: outcome.lastBlock ?? last, targetEnd: target });
      return;
    }
    if (outcome.error) {
      const errorPayload = {
        status: "error",
        scanId,
        address: pool.address,
        error: outcome.error,
        message: outcome.error,
        lastScannedBlock: outcome.lastBlock ?? last,
        targetEnd: target,
        rows: outcome.rows || [],
      };
      await db.collection("scans").updateOne({ _id: scanId }, {
        $set: {
          status: "error",
          error: outcome.error,
          rows: outcome.rows,
          lastScannedBlock: outcome.lastBlock ?? last,
          updatedAt: new Date(),
        },
      });
      // A failed pool in a Scan All queue must not end the whole job.
      if (finalEvent === "poolDone") emit("poolDone", errorPayload);
      else emit("error", errorPayload);
      return;
    }
    last = outcome.lastBlock ?? end;
    rows = outcome.rows;
    const done = last >= target;
    await db.collection("scans").updateOne({ _id: scanId }, {
      $set: {
        status: done ? "done" : "running",
        lastScannedBlock: last,
        targetEnd: target,
        rows,
        matchedCalls: outcome.matchedCalls,
        method: outcome.method,
        updatedAt: new Date(),
      },
    });
    emit("checkpoint", {
      scanId,
      address: pool.address,
      lastScannedBlock: last,
      targetEnd: target,
      callers: rows.length,
      rows: rows.length,
      status: done ? "done" : "running",
    });
  }
  const fresh = await db.collection("scans").findOne({ _id: scanId });
  emit(finalEvent, {
    status: fresh.status,
    scanId,
    address: pool.address,
    lastScannedBlock: fresh.lastScannedBlock,
    targetEnd: fresh.targetEnd,
    rows: fresh.rows || [],
    error: fresh.error || null,
  });
}

function runSegment({ scan, pool, chainId, start, end, rows, signal, emit, targetEnd }) {
  return new Promise((resolve) => {
    let lastBlock = start - 1;
    let latestRows = rows;
    let method = null;
    let matchedCalls = 0;
    let failed = false;
    let pendingWrite = Promise.resolve();
    const publishProgress = (block, phase = "scanning") => {
      if (Number.isInteger(block)) lastBlock = block;
      const payload = {
        phase,
        status: "running",
        scanId: scan._id,
        address: pool.address,
        creationBlock: pool.creationBlock,
        targetEnd,
        lastBlock,
        callers: latestRows.length,
        matchedCalls,
        method,
      };
      emit("progress", payload);
      pendingWrite = scheduleScanProgress(scan._id, {
        lastScannedBlock: lastBlock,
        rows: latestRows,
        matchedCalls,
        method,
        targetEnd,
      });
    };
    runScan({
      address: pool.address,
      chainId,
      rpcUrl: null,
      startBlock: start,
      endBlock: end,
      maxBlocks: end - start + 1,
      maxTx: null,
      functions: [scan.functionId],
      initialRows: rows,
      ordered: true,
    }, {
      signal,
      emit: (event, data) => {
        if (event === "log" || event === "meta") emit(event, data);
        if (event === "snapshot" && data?.rows) latestRows = data.rows;
        if (event === "progress") {
          const block = Number.isInteger(data?.blocksDone) ? start + data.blocksDone - 1 : lastBlock;
          if (data?.matchedCalls != null) matchedCalls = data.matchedCalls;
          if (data?.method) method = data.method;
          publishProgress(block, data?.phase || "scanning");
        }
        if (event === "checkpoint") {
          if (data.snapshot?.rows) latestRows = data.snapshot.rows;
          method = data.snapshot?.stats?.method || method;
          matchedCalls = data.snapshot?.stats?.matchedCalls ?? matchedCalls;
          emit("snapshot", data.snapshot);
          publishProgress(data.lastBlock, "scanning");
        }
        if (event === "error") failed = data.message || "Scan failed";
        if (event === "done") {
          if (data?.method) method = data.method;
          if (data?.matchedCalls != null) matchedCalls = data.matchedCalls;
        }
      },
    }).then(async () => {
      await pendingWrite;
      if (signal?.aborted) {
        resolve({ cancelled: true, lastBlock, rows: latestRows, method, matchedCalls });
        return;
      }
      if (failed) {
        resolve({ error: failed, lastBlock, rows: latestRows, method, matchedCalls });
        return;
      }
      resolve({ lastBlock: Math.max(lastBlock, end), rows: latestRows, method, matchedCalls });
    }).catch((err) => {
      resolve({ error: err.message || String(err), lastBlock, rows: latestRows, method, matchedCalls });
    });
  });
}

export async function createScans({ factoryId, addresses }) {
  const db = await getDb();
  const factory = await db.collection("factories").findOne({ _id: factoryId });
  if (!factory) throw new Error("Unknown factory. Discover it first.");
  const chain = chainById(factory.chainId) || makeCustomChain(factory.chainId);
  const head = await getBlockNumber(rpcForChain(chain).url, { timeoutMs: 15_000 });
  const wanted = new Set((addresses || []).map((a) => a.toLowerCase()));
  const pools = await db.collection("pools").find({ factoryId }).toArray();
  const chosen = pools.filter((pool) => wanted.size === 0 || wanted.has(pool.address.toLowerCase()));
  chosen.sort((a, b) => (a.creationBlock - b.creationBlock) || String(a.address).localeCompare(String(b.address)));
  if (!chosen.length) throw new Error("No pools matched that selection.");
  const now = new Date();
  const ids = [];
  for (const pool of chosen) {
    if (!Number.isInteger(pool.creationBlock)) {
      throw new Error(`Pool ${pool.address} has no creation block, so a full-range scan cannot start.`);
    }
    const id = `${factoryId}:${pool.address.toLowerCase()}`;
    const fn = scanKind(pool);
    await db.collection("scans").updateOne(
      { _id: id },
      {
        $set: {
          factoryId,
          poolId: pool._id,
          chainId: factory.chainId,
          address: pool.address,
          symbol0: pool.symbol0,
          symbol1: pool.symbol1,
          kind: pool.kind,
          functionId: fn,
          creationBlock: pool.creationBlock,
          targetEnd: head,
          status: "queued",
          lastScannedBlock: pool.creationBlock - 1,
          rows: [],
          matchedCalls: 0,
          error: null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    ids.push(id);
  }
  return { head, scanIds: ids };
}

export function publicPool(pool) {
  return {
    address: pool.address,
    kind: pool.kind,
    creationBlock: pool.creationBlock,
    token0: pool.token0,
    token1: pool.token1,
    symbol0: pool.symbol0,
    symbol1: pool.symbol1,
    decimals0: pool.decimals0,
    decimals1: pool.decimals1,
    reserve0: pool.reserve0Text,
    reserve1: pool.reserve1Text,
    reserveSource: pool.reserveSource,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    stable: pool.stable,
    price0: pool.price0,
    price1: pool.price1,
    price0Source: pool.price0Source,
    price1Source: pool.price1Source,
    usd: pool.usd,
    llamaChain: pool.llamaChain,
  };
}

export function publicScan(scan) {
  return {
    id: scan._id,
    factoryId: scan.factoryId,
    address: scan.address,
    symbol0: scan.symbol0,
    symbol1: scan.symbol1,
    kind: scan.kind,
    functionId: scan.functionId,
    creationBlock: scan.creationBlock,
    lastScannedBlock: scan.lastScannedBlock,
    targetEnd: scan.targetEnd,
    status: scan.status,
    method: scan.method || null,
    matchedCalls: scan.matchedCalls || 0,
    callers: (scan.rows || []).length,
    progress: scanProgress(scan),
    error: scan.error || null,
    updatedAt: scan.updatedAt,
  };
}
