import { hexQty } from "./decode.js";

export class RpcError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "RpcError";
    this.status = extra.status ?? null;
    this.code = extra.code ?? null;
    this.method = extra.method ?? null;
  }
}

export function classifyError(err) {
  if (!err) return "fatal";
  if (err.code === "CANCELLED" || err.name === "Cancelled") return "cancelled";
  const msg = String(err.message || err);
  const status = err.status;
  if (status === 429 || /rate limit|too many requests|cu limit|exceeded.*quota/i.test(msg)) {
    return "rate";
  }
  if (
    err.code === -32601 ||
    /method .*(not found|not available|does not exist|not supported)|does not exist\/is not available|method is not available|not allowed|disabled|upgrade to paid|unregistered account|personal token|api key required/i.test(
      msg,
    )
  ) {
    return "unsupported";
  }
  if (
    /block range too large|ranges over \d+ blocks|too many blocks|response too large|query returned more than|log response size exceeded|more than \d+ results/i.test(
      msg,
    )
  ) {
    return "range";
  }
  if (/pruned|missing trie|historical state|state is not available|history is not available/i.test(msg)) {
    return "pruned";
  }
  if (err.code === "TIMEOUT" || /timeout|timed out|aborted/i.test(msg)) return "timeout";
  if (
    (status != null && status >= 500) ||
    /temporary internal error|bad gateway|gateway timeout|econnreset|socket hang up|fetch failed/i.test(msg)
  ) {
    return "transient";
  }
  return "fatal";
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function cancelled() {
  const err = new Error("Scan cancelled");
  err.code = "CANCELLED";
  err.name = "Cancelled";
  return err;
}

export async function mapPool(items, limit, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export async function rpcCall(url, method, params, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const text = await readLimited(res, maxBytes);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RpcError(`RPC returned non-JSON (${res.status}): ${text.slice(0, 180)}`, {
        status: res.status,
        method,
      });
    }
    if (json.error) {
      const message = json.error.message || JSON.stringify(json.error);
      throw new RpcError(message, { status: res.status, code: json.error.code, method });
    }
    if (res.status === 429) {
      throw new RpcError(json.error?.message || "rate limit", { status: 429, method });
    }
    if (!res.ok) {
      throw new RpcError(`HTTP ${res.status}`, { status: res.status, method });
    }
    return json.result;
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (options.signal?.aborted) throw cancelled();
    if (err?.name === "AbortError") {
      throw new RpcError(`RPC timeout after ${timeoutMs}ms`, { code: "TIMEOUT", method });
    }
    throw new RpcError(err.message || String(err), { method });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RpcError(`response too large (${declared} bytes)`, { status: res.status, code: "TOO_LARGE" });
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new RpcError(`response too large (>${maxBytes} bytes)`, { status: res.status, code: "TOO_LARGE" });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export async function rpcRetry(fn, options = {}) {
  const retries = options.retries ?? 4;
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (options.signal?.aborted || err.code === "CANCELLED") throw cancelled();
      const kind = classifyError(err);
      if (kind === "unsupported" || kind === "pruned" || kind === "fatal" || kind === "range" || kind === "cancelled") {
        throw err;
      }
      if (attempt === retries) throw err;
      const delay = Math.min(10_000, 500 * 2 ** attempt);
      options.onRetry?.({ attempt: attempt + 1, delay, kind, message: err.message });
      await sleep(delay, options.signal);
    }
  }
  throw last;
}

export async function rpcBatch(url, calls, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const body = calls.map((call, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: call.method,
      params: call.params,
    }));
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RpcError("Batch RPC returned non-JSON", { status: res.status });
    }
    if (!Array.isArray(json)) {
      throw new RpcError(json.error?.message || "Batch RPC is not supported", {
        status: res.status,
        code: json.error?.code,
      });
    }
    const byId = new Map(json.map((item) => [item.id, item]));
    return calls.map((_, index) => {
      const item = byId.get(index);
      if (!item) return { ok: false, error: "missing batch item" };
      if (item.error) return { ok: false, error: item.error.message || "batch item error" };
      return { ok: true, result: item.result };
    });
  } catch (err) {
    if (options.signal?.aborted) throw cancelled();
    throw err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function getBlockNumber(url, options) {
  const result = await rpcRetry(() => rpcCall(url, "eth_blockNumber", [], options), options);
  const n = hexQty(result);
  if (!Number.isInteger(n)) throw new RpcError("eth_blockNumber returned no block");
  return n;
}

export async function getChainId(url, options) {
  const result = await rpcRetry(() => rpcCall(url, "eth_chainId", [], options), {
    ...options,
    retries: 1,
  });
  const n = hexQty(result);
  if (!Number.isInteger(n)) throw new RpcError("eth_chainId returned no id");
  return n;
}
