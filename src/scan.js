import { getAddress } from "ethers";
import { functionsById, selectorMap } from "./abi.js";
import { publicHost, rpcCandidates } from "./chains.js";
import { config } from "./config.js";
import { detectPool } from "./detect.js";
import { blockChunks, codeSize, hexQty, isDelegatedEoa, resolveRange, toHex } from "./decode.js";
import { labelFor } from "./labels.js";
import { backoffDelay, cancelled, classifyError, createEndpointPool, getBlockNumber, mapPool, rpcBatch, rpcCall, rpcRetry, sleep } from "./rpc.js";
import { createAggregator, parseDebugBlock, parseParityTraces, poolCallsFromParsed } from "./traces.js";

// Canonical pool-event topics. Checked in test/unit.test.js against ethers.id.
export const POOL_EVENT_TOPICS = [
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
  "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",
  "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f",
  "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496",
];

const METHODS = ["trace_filter", "trace_block", "debug_traceBlockByNumber", "debug_traceTransaction"];

function checksum(address) {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

export async function runScan(request, { emit, signal }) {
  const warnings = [];
  const warningSet = new Set();
  const codes = new Map();
  const origins = new Map();
  const failed = new Set();
  let blocksDone = 0;
  let method = null;
  let traceUrls = [];
  let endpointPool = null;
  let detection = null;
  let consecutiveTraceFailures = 0;
  let fatalTrace = null;
  let range = null;
  let aggregator = null;
  let limitNoted = false;
  let cancelFlag = false;

  const log = (message, level = "info") => emit("log", { level, message });
  const warn = (message) => {
    if (warningSet.has(message)) return;
    warningSet.add(message);
    warnings.push(message);
    log(message, "warn");
  };

  const rpcOptions = () => ({
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    signal,
  });

  function materialize(extra = {}) {
    const snap = aggregator
      ? aggregator.snapshot()
      : { rows: [], txCount: 0, matched: 0, stopped: false, blocksWithPoolCalls: 0 };
    const rows = [];
    const excluded = [];
    for (const row of snap.rows) {
      const meta = codes.get(row.caller) || {
        kind: "unknown",
        codeBytes: null,
        reason: "code not checked yet",
      };
      const shaped = {
        caller: checksum(row.caller),
        label: labelFor(row.caller),
        selector: row.selector,
        functionName: row.functionName,
        signature: row.signature,
        version: row.version,
        callTypes: row.callTypes,
        count: row.count,
        firstBlock: row.firstBlock,
        lastBlock: row.lastBlock,
        exampleTx: row.exampleTx || null,
        exampleTrace: row.exampleTrace || "",
        exampleOrigin: origins.get(row.exampleTx) || null,
        callerKind: meta.kind,
        codeBytes: meta.codeBytes,
        codeNote: meta.reason,
      };
      if (meta.kind === "eoa") {
        excluded.push({
          caller: shaped.caller,
          label: shaped.label,
          functionName: shaped.functionName,
          count: shaped.count,
          reason: meta.reason || "no code",
        });
      } else {
        rows.push(shaped);
      }
    }
    const stats = {
      pool: detection?.pool || null,
      chainId: detection?.chain?.chainId ?? null,
      chainName: detection?.chain?.name ?? null,
      explorer: detection?.chain?.explorer ?? null,
      version: detection?.version ?? null,
      symbol0: detection?.symbol0 ?? null,
      symbol1: detection?.symbol1 ?? null,
      feeLabel: detection?.feeLabel ?? null,
      token0: detection?.token0 ?? null,
      token1: detection?.token1 ?? null,
      rpcHost: detection ? publicHost(detection.rpcUrl) : null,
      method,
      start: range?.start ?? null,
      end: range?.end ?? null,
      blocksDone,
      blocksTotal: range ? range.end - range.start + 1 : null,
      blocksFailed: failed.size,
      blocksWithPoolCalls: snap.blocksWithPoolCalls,
      matchedCalls: snap.matched,
      matchingTxs: snap.txCount,
      contractRows: rows.length,
      excludedEoas: excluded.length,
      eventBlocks: extra.cross?.eventBlocks ?? null,
      eventBlocksMissingTraces: extra.cross?.missing ?? null,
      warnings: [...warnings],
      cancelled: Boolean(extra.cancelled),
      limitHit: Boolean(snap.stopped),
    };
    return { rows, excluded, stats };
  }

  function publish(phase) {
    const snap = materialize();
    emit("progress", {
      blocksDone,
      blocksTotal: range ? range.end - range.start + 1 : null,
      method,
      matchedCalls: snap.stats.matchedCalls,
      callers: snap.rows.length,
      phase,
    });
    emit("snapshot", snap);
    return snap;
  }

  async function classifyCallers() {
    if (!aggregator || !detection) return;
    const callers = [...new Set(aggregator.snapshot().rows.map((row) => row.caller))];
    const pending = callers.filter((caller) => !codes.has(caller));
    if (pending.length === 0) return;
    const latest = await codeAt(detection.rpcUrl, pending, "latest", rpcOptions());
    const needHistory = [];
    for (const caller of pending) {
      const code = latest.has(caller) ? latest.get(caller) : null;
      if (code == null) {
        codes.set(caller, { kind: "unknown", codeBytes: null, reason: "eth_getCode failed" });
        continue;
      }
      if (isDelegatedEoa(code)) {
        codes.set(caller, { kind: "eoa", codeBytes: codeSize(code), reason: "EIP-7702 delegated account" });
        continue;
      }
      if (codeSize(code) === 0) {
        needHistory.push(caller);
        continue;
      }
      codes.set(caller, { kind: "contract", codeBytes: codeSize(code), reason: null });
    }

    const byBlock = new Map();
    const rows = aggregator.snapshot().rows;
    for (const caller of needHistory) {
      const last = rows.filter((row) => row.caller === caller).reduce((max, row) => Math.max(max, row.lastBlock), -1);
      if (last < 0) {
        codes.set(caller, { kind: "eoa", codeBytes: 0, reason: "no code" });
        continue;
      }
      const group = byBlock.get(last) || [];
      group.push(caller);
      byBlock.set(last, group);
    }
    for (const [block, group] of byBlock) {
      let historical = new Map();
      try {
        historical = await codeAt(detection.rpcUrl, group, toHex(block), rpcOptions());
      } catch {
        historical = new Map();
      }
      for (const caller of group) {
        if (!historical.has(caller) || historical.get(caller) == null) {
          codes.set(caller, {
            kind: "unknown",
            codeBytes: null,
            reason: "no code at latest; archive lookup failed",
          });
          continue;
        }
        const code = historical.get(caller);
        if (isDelegatedEoa(code)) {
          codes.set(caller, { kind: "eoa", codeBytes: codeSize(code), reason: "EIP-7702 delegated account" });
        } else if (codeSize(code) > 0) {
          codes.set(caller, {
            kind: "contract",
            codeBytes: codeSize(code),
            reason: "code present at the last seen block, empty at latest",
          });
        } else {
          codes.set(caller, { kind: "eoa", codeBytes: 0, reason: "no code" });
        }
      }
    }
  }

  async function processRange(from, to, depth = 0) {
    if (signal?.aborted) {
      cancelFlag = true;
      return;
    }
    if (cancelFlag || aggregator.stopped) return;
    try {
      const parsed = await fetchRange(traceUrls, method, detection.pool, from, to, rpcOptions(), endpointPool);
      aggregator.add(poolCallsFromParsed(parsed, detection.pool.toLowerCase()));
      blocksDone += to - from + 1;
      consecutiveTraceFailures = 0;
      try {
        await classifyCallers();
      } catch (codeErr) {
        warn(`Code check failed: ${codeErr.message}`);
      }
      if (aggregator.stopped && !limitNoted) {
        limitNoted = true;
        log(`Stopped after ${request.maxTx} matching transactions.`);
      }
      publish("scanning");
      if (request.ordered) emit("checkpoint", { lastBlock: to, snapshot: materialize() });
    } catch (err) {
      if (err.code === "CANCELLED" || signal?.aborted) {
        cancelFlag = true;
        return;
      }
      const kind = classifyError(err);
      if ((kind === "range" || kind === "timeout" || kind === "pruned") && to > from && depth < 12) {
        const mid = Math.floor((from + to) / 2);
        log(`Blocks ${from}–${to} hit ${kind}. Splitting the chunk.`);
        await processRange(from, mid, depth + 1);
        await processRange(mid + 1, to, depth + 1);
        return;
      }
      consecutiveTraceFailures += 1;
      const heavy = method === "trace_block" || method === "debug_traceBlockByNumber";
      if (heavy || consecutiveTraceFailures >= 4) {
        fatalTrace = `The RPC stopped answering ${method || "traces"} (${err.message}). Saved progress stops before block ${from.toLocaleString("en-US")}. Resume to continue.`;
        warn(fatalTrace);
        cancelFlag = true;
        return;
      }
      for (let n = from; n <= to; n += 1) failed.add(n);
      blocksDone += to - from + 1;
      warn(`Blocks ${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")} failed: ${err.message}`);
      publish("scanning");
      if (request.ordered) emit("checkpoint", { lastBlock: to, snapshot: materialize() });
    }
  }

  async function traceLoggedTransactions() {
    warn("This RPC exposes debug_traceTransaction only. The scan traces transactions that emitted a pool Swap, Sync, Mint, or Burn. A view call in any other transaction is not visible.");
    const logs = await logsInRange(detection.rpcUrl, detection.pool, range.start, range.end, rpcOptions());
    const byHash = new Map();
    for (const entry of logs) {
      const hash = String(entry.transactionHash || "").toLowerCase();
      const block = hexQty(entry.blockNumber);
      if (!/^0x[0-9a-f]{64}$/.test(hash) || !Number.isInteger(block)) continue;
      if (!byHash.has(hash)) byHash.set(hash, block);
    }
    let jobs = [...byHash.entries()].map(([hash, block]) => ({ hash, block }));
    jobs.sort((a, b) => b.block - a.block);
    if (jobs.length > 400) {
      warn(`This range has ${jobs.length} pool-event transactions. Tracing the most recent 400.`);
      jobs = jobs.slice(0, 400);
    }
    blocksDone = range.end - range.start + 1;
    log(jobs.length
      ? `Tracing ${jobs.length} pool-event transactions.`
      : "No pool Swap, Sync, Mint, or Burn logs in this range, so debug_traceTransaction has nothing to trace.");
    let txsDone = 0;
    const publishTx = () => {
      const snap = materialize();
      emit("progress", {
        blocksDone,
        blocksTotal: blocksDone,
        txsDone,
        txsTotal: jobs.length,
        method,
        matchedCalls: snap.stats.matchedCalls,
        callers: snap.rows.length,
        phase: "scanning",
      });
      emit("snapshot", snap);
    };
    publishTx();
    await mapPool(jobs, request.maxTx ? 1 : config.concurrency, async (job) => {
      if (signal?.aborted) {
        cancelFlag = true;
        return;
      }
      if (cancelFlag || aggregator.stopped) return;
      try {
        const tree = await debugCall(detection.rpcUrl, "debug_traceTransaction", [job.hash, {
          tracer: "callTracer",
          tracerConfig: { onlyTopCall: false },
        }], rpcOptions());
        const parsed = parseDebugBlock([{ txHash: job.hash, result: tree }], job.block);
        aggregator.add(poolCallsFromParsed(parsed, detection.pool.toLowerCase()));
        try {
          await classifyCallers();
        } catch (codeErr) {
          warn(`Code check failed: ${codeErr.message}`);
        }
      } catch (err) {
        if (err.code === "CANCELLED" || signal?.aborted) {
          cancelFlag = true;
          return;
        }
        warn(`Transaction ${job.hash} failed: ${err.message}`);
      } finally {
        txsDone += 1;
        if (txsDone === jobs.length || txsDone % 5 === 0) publishTx();
      }
    });
    publishTx();
  }

  try {
    const functions = functionsById(request.functions);
    aggregator = createAggregator(selectorMap(functions), request.maxTx);
    if (Array.isArray(request.initialRows) && request.initialRows.length) aggregator.load(request.initialRows);
    detection = await detectPool({
      address: request.address,
      chainId: request.chainId,
      rpcUrl: request.rpcUrl,
      signal,
      onLog: (message) => log(message),
    });
    if (signal?.aborted) throw cancelled();

    const versionLabel = detection.version === "v3"
      ? "Uniswap V3-style pool (slot0 answered)"
      : detection.version === "v2"
        ? "Uniswap V2-style pair (getReserves answered)"
        : detection.version === "both"
          ? "Both slot0 and getReserves answered"
          : "Neither slot0 nor getReserves answered. Selected selectors are still applied.";
    const pair = [detection.symbol0, detection.symbol1].filter(Boolean).join(" / ");
    log(`${detection.chain.name} · ${pair || detection.pool} · ${versionLabel}${detection.feeLabel ? ` · fee ${detection.feeLabel}` : ""}.`);
    if (detection.alsoFound?.length) {
      warn(`Code was also found on ${detection.alsoFound.join(", ")}. This scan uses ${detection.chain.name} only.`);
    }
    emit("meta", {
      pool: detection.pool,
      chainId: detection.chain.chainId,
      chainName: detection.chain.name,
      explorer: detection.chain.explorer,
      version: detection.version,
      symbol0: detection.symbol0,
      symbol1: detection.symbol1,
      token0: detection.token0,
      token1: detection.token1,
      feeLabel: detection.feeLabel,
      codeBytes: detection.codeBytes,
      rpcHost: publicHost(detection.rpcUrl),
      alsoFound: detection.alsoFound || [],
    });

    const head = await getBlockNumber(detection.rpcUrl, rpcOptions());
    range = resolveRange({
      startBlock: request.startBlock,
      endBlock: request.endBlock,
      maxBlocks: request.maxBlocks,
      head,
      cap: config.maxBlocksCap,
    });
    if (range.note) log(range.note);
    traceUrls = rpcCandidates(detection.chain, request.rpcUrl || detection.rpcUrl);
    log(`Scanning blocks ${range.start.toLocaleString("en-US")}–${range.end.toLocaleString("en-US")} (${range.end - range.start + 1} blocks).`);

    const probed = await probeMethod(traceUrls, detection.pool, range.start, rpcOptions(), log);
    method = probed.method;
    traceUrls = probed.urls;
    if (method === "trace_block" || method === "debug_traceBlockByNumber") {
      endpointPool = createEndpointPool(traceUrls);
    }
    log(`Trace method: ${method} via ${publicHost(traceUrls[0])}.`);

    if (method === "debug_traceTransaction") {
      await traceLoggedTransactions();
    } else {
      const heavy = method !== "trace_filter";
      const chunkSize = heavy ? 1 : config.chunkBlocks;
      const chunks = blockChunks(range.start, range.end, chunkSize);
      publish("scanning");
      const parallel = heavy || request.ordered || request.maxTx ? 1 : config.concurrency;
      await mapPool(chunks, parallel, async ([from, to]) => {
        if (fatalTrace || cancelFlag) return;
        await processRange(from, to);
      });
    }

    if (fatalTrace) {
      emit("error", { message: fatalTrace });
      return;
    }

    if (signal?.aborted || cancelFlag) {
      await classifyCallers();
      const snap = publish("cancelled");
      emit("done", { ...snap.stats, cancelled: true });
      return;
    }

    log("Resolving transaction senders for the example hashes…");
    try {
      await classifyCallers();
    } catch (err) {
      warn(`Code check failed: ${err.message}`);
    }
    try {
      await loadOrigins(detection.rpcUrl, aggregator, origins, rpcOptions());
    } catch (err) {
      warn(`Could not load example transaction senders: ${err.message}`);
    }
    const cross = await crossCheckLogs(detection.rpcUrl, detection.pool, range, aggregator, failed, rpcOptions(), warn);
    const finalSnap = materialize({ cross });
    emit("progress", {
      blocksDone,
      blocksTotal: range.end - range.start + 1,
      method,
      matchedCalls: finalSnap.stats.matchedCalls,
      callers: finalSnap.rows.length,
      phase: "done",
    });
    emit("snapshot", finalSnap);
    emit("done", finalSnap.stats);
  } catch (err) {
    if (err.code === "CANCELLED" || cancelFlag || signal?.aborted) {
      const snap = materialize({ cancelled: true });
      emit("snapshot", snap);
      emit("done", { ...snap.stats, cancelled: true });
      return;
    }
    emit("error", { message: err.message || String(err) });
  }
}

async function probeMethod(urls, pool, block, options, log) {
  const errors = [];
  const hosts = urls.map((url) => publicHost(url)).join(", ");
  for (const candidate of METHODS) {
    let logged = false;
    for (const url of urls) {
      try {
        await probeOne(candidate, url, pool, block, options);
        const ordered = [url, ...urls.filter((item) => item !== url)];
        if (url !== urls[0]) log(`${candidate} is available on ${publicHost(url)} (${hosts}).`);
        return { method: candidate, urls: ordered };
      } catch (err) {
        if (err.code === "CANCELLED") throw err;
        errors.push(`${candidate} @ ${publicHost(url)}: ${err.message}`);
        if (!logged) {
          log(`${candidate} is not usable here (${err.message}).`);
          logged = true;
        }
      }
    }
  }
  throw new Error(
    `This RPC does not expose a usable trace method. slot0 and getReserves are ordinary internal calls, so they are invisible without trace_filter, trace_block, debug_traceBlockByNumber, or debug_traceTransaction.\n${errors.join("\n")}`,
  );
}

async function probeOne(candidate, url, pool, block, options) {
  const poolLower = pool.toLowerCase();
  if (candidate === "trace_filter") {
    const filter = {
      fromBlock: toHex(block),
      toBlock: toHex(block),
      toAddress: [poolLower],
    };
    try {
      await rpcRetry(
        () => rpcCall(url, "trace_filter", [{ ...filter, count: 1 }], options),
        { ...options, retries: 1 },
      );
    } catch (err) {
      if (!/count|after|invalid param|invalid argument/i.test(err.message)) throw err;
      await rpcRetry(() => rpcCall(url, "trace_filter", [filter], options), { ...options, retries: 0 });
    }
    return;
  }
  if (candidate === "trace_block") {
    await rpcRetry(() => rpcCall(url, "trace_block", [toHex(block)], { ...options, timeoutMs: 20_000 }), { ...options, retries: 1 });
    return;
  }
  if (candidate === "debug_traceBlockByNumber") {
    await debugCall(url, "debug_traceBlockByNumber", [toHex(block), {
      tracer: "callTracer",
      tracerConfig: { onlyTopCall: true },
    }], options);
    return;
  }
  const tx = await findRecentTx(url, block, options);
  if (!tx) throw new Error("no transaction in the nearby blocks to probe");
  await debugCall(url, "debug_traceTransaction", [tx, {
    tracer: "callTracer",
    tracerConfig: { onlyTopCall: true },
  }], options);
}

async function debugCall(url, method, params, options) {
  try {
    return await rpcRetry(() => rpcCall(url, method, params, options), options);
  } catch (err) {
    if (err.code === "CANCELLED") throw err;
    if (!/tracerConfig|invalid param|invalid argument/i.test(String(err.message))) throw err;
    const bare = params.slice();
    if (bare[1] && typeof bare[1] === "object") bare[1] = { tracer: "callTracer" };
    return rpcRetry(() => rpcCall(url, method, bare, options), options);
  }
}

async function findRecentTx(url, block, options) {
  for (let i = 0; i < 20; i += 1) {
    const n = block - i;
    if (n < 0) break;
    try {
      const result = await rpcCall(url, "eth_getBlockByNumber", [toHex(n), false], options);
      const txs = result?.transactions;
      if (Array.isArray(txs) && typeof txs[0] === "string") return txs[0];
    } catch {
      return null;
    }
  }
  return null;
}

async function logsInRange(url, pool, from, to, options, depth = 0) {
  try {
    const logs = await rpcRetry(
      () => rpcCall(url, "eth_getLogs", [{
        address: pool.toLowerCase(),
        fromBlock: toHex(from),
        toBlock: toHex(to),
        topics: [POOL_EVENT_TOPICS],
      }], options),
      { ...options, retries: 1 },
    );
    return Array.isArray(logs) ? logs : [];
  } catch (err) {
    if (err.code === "CANCELLED") throw err;
    if (to > from && depth < 12 && /range|too many|more than|limit|response|timeout|large|exceed/i.test(String(err.message))) {
      const mid = Math.floor((from + to) / 2);
      const left = await logsInRange(url, pool, from, mid, options, depth + 1);
      const right = await logsInRange(url, pool, mid + 1, to, options, depth + 1);
      return left.concat(right);
    }
    throw err;
  }
}

async function fetchRange(urls, activeMethod, poolAddress, from, to, options, pace) {
  if (activeMethod === "trace_filter") return fetchTraceFilter(urls, poolAddress, from, to, options);
  const parsed = [];
  for (let block = from; block <= to; block += 1) {
    if (options.signal?.aborted) throw cancelled();
    if (activeMethod === "trace_block") {
      const traces = await heavyCall(pace, urls, "trace_block", [toHex(block)], options);
      parsed.push(...parseParityTraces(traces));
    } else {
      const entries = await fetchDebugBlock(pace, urls, block, options);
      parsed.push(...parseDebugBlock(entries, block));
    }
  }
  return parsed;
}

async function heavyCall(pace, urls, method, params, options) {
  const timeoutMs = Math.min(options.timeoutMs ?? 30_000, 30_000);
  let last;
  const attempts = Math.max(urls.length, 1) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const slot = pace
      ? await pace.acquire(options.signal)
      : { url: urls[attempt % urls.length], release() {} };
    try {
      const result = await rpcCall(slot.url, method, params, { ...options, timeoutMs });
      slot.release("ok");
      return result;
    } catch (err) {
      last = err;
      const kind = classifyError(err);
      slot.release(kind);
      if (err.code === "CANCELLED" || kind === "cancelled") throw err;
      if ((kind === "pruned" || kind === "fatal") && kind !== "unsupported") throw err;
      if (attempt === attempts - 1) throw err;
      await sleep(backoffDelay(attempt), options.signal);
    }
  }
  throw last;
}

function fetchDebugBlock(pace, urls, block, options) {
  const params = [toHex(block), {
    tracer: "callTracer",
    tracerConfig: { onlyTopCall: false },
  }];
  return heavyCall(pace, urls, "debug_traceBlockByNumber", params, options).catch(async (err) => {
    if (!/tracerConfig|invalid param|invalid argument/i.test(String(err.message))) throw err;
    return heavyCall(pace, urls, "debug_traceBlockByNumber", [toHex(block), { tracer: "callTracer" }], options);
  });
}

async function fetchTraceFilter(urls, pool, from, to, options) {
  const base = {
    fromBlock: toHex(from),
    toBlock: toHex(to),
    toAddress: [pool.toLowerCase()],
  };
  const out = [];
  let after = 0;
  let guard = null;
  let paging = true;
  for (let page = 0; page < 1000; page += 1) {
    if (options.signal?.aborted) throw cancelled();
    const filter = paging ? { ...base, after, count: config.pageSize } : base;
    let result;
    try {
      result = await traceFilterCall(urls, filter, options);
    } catch (err) {
      if (page === 0 && paging && /count|after|invalid param|invalid argument/i.test(err.message)) {
        paging = false;
        continue;
      }
      throw err;
    }
    if (!Array.isArray(result)) throw new Error("trace_filter did not return a list");
    if (result.length === 0) break;
    const parsed = parseParityTraces(result);
    const first = parsed[0];
    const sig = first ? `${first.txHash}:${first.traceAddress}:${first.input}` : `raw:${result.length}:${after}`;
    if (sig === guard) break;
    guard = sig;
    out.push(...parsed);
    if (!paging || result.length < config.pageSize) break;
    after += result.length;
  }
  return out;
}

async function traceFilterCall(urls, filter, options) {
  let last;
  for (const url of urls) {
    try {
      return await rpcRetry(() => rpcCall(url, "trace_filter", [filter], options), options);
    } catch (err) {
      last = err;
      const kind = classifyError(err);
      if (kind === "cancelled" || kind === "range" || kind === "pruned" || kind === "fatal") throw err;
    }
  }
  throw last || new Error("trace_filter failed");
}

async function codeAt(url, addresses, blockTag, options) {
  const map = new Map();
  if (addresses.length === 0) return map;
  try {
    const results = await rpcBatch(
      url,
      addresses.map((address) => ({ method: "eth_getCode", params: [address, blockTag] })),
      options,
    );
    results.forEach((item, index) => {
      if (item.ok) map.set(addresses[index], item.result);
    });
  } catch {
    // Single calls below cover endpoints that reject batches.
  }
  for (const address of addresses) {
    if (map.has(address)) continue;
    try {
      const code = await rpcRetry(
        () => rpcCall(url, "eth_getCode", [address, blockTag], options),
        { ...options, retries: 1 },
      );
      map.set(address, code);
    } catch {
      map.set(address, null);
    }
  }
  return map;
}

async function loadOrigins(url, aggregator, origins, options) {
  const hashes = [...new Set(aggregator.snapshot().rows.map((row) => row.exampleTx).filter(Boolean))].slice(0, 80);
  if (hashes.length === 0) return;
  const missing = new Set(hashes);
  try {
    const results = await rpcBatch(
      url,
      hashes.map((hash) => ({ method: "eth_getTransactionByHash", params: [hash] })),
      options,
    );
    results.forEach((item, index) => {
      const from = item.ok ? item.result?.from : null;
      if (!from) return;
      origins.set(hashes[index], checksum(from));
      missing.delete(hashes[index]);
    });
  } catch {
    // Some public RPCs reject batches. The loop below asks for each hash on its own.
  }
  for (const hash of missing) {
    try {
      const tx = await rpcRetry(
        () => rpcCall(url, "eth_getTransactionByHash", [hash], options),
        { ...options, retries: 1 },
      );
      if (tx?.from) origins.set(hash, checksum(tx.from));
    } catch {
      // The example sender is optional.
    }
  }
}

async function crossCheckLogs(url, pool, range, aggregator, failed, options, warn) {
  const eventBlocks = new Set();
  const chunks = blockChunks(range.start, range.end, 80);
  for (const [from, to] of chunks) {
    try {
      const logs = await rpcRetry(
        () => rpcCall(url, "eth_getLogs", [{
          address: pool.toLowerCase(),
          fromBlock: toHex(from),
          toBlock: toHex(to),
          topics: [POOL_EVENT_TOPICS],
        }], options),
        { ...options, retries: 1 },
      );
      if (!Array.isArray(logs)) continue;
      for (const entry of logs) {
        const block = hexQty(entry.blockNumber);
        if (Number.isInteger(block)) eventBlocks.add(block);
      }
    } catch (err) {
      warn(`Event cross-check stopped: ${err.message}`);
      return { eventBlocks: eventBlocks.size, missing: null };
    }
  }
  const traced = aggregator.snapshot().poolBlocks;
  let missing = 0;
  for (const block of eventBlocks) {
    if (!traced.has(block)) missing += 1;
  }
  if (missing > 0) {
    warn(`${missing} block(s) emitted Swap, Sync, Mint, or Burn from the pool, but the trace RPC returned no call to the pool in those blocks. The caller list is incomplete there.`);
  }
  void failed;
  return { eventBlocks: eventBlocks.size, missing };
}
