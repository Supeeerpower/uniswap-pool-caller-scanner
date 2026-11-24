import { hexQty } from "./decode.js";

const CALL_TYPES = new Set(["call", "staticcall", "delegatecall", "callcode"]);

export function parseParityTraces(traces) {
  if (!Array.isArray(traces)) return [];
  const out = [];
  for (const trace of traces) {
    if (!trace || trace.type !== "call" || !trace.action) continue;
    const callType = String(trace.action.callType || "call").toLowerCase();
    if (!CALL_TYPES.has(callType)) continue;
    const blockNumber = hexQty(trace.blockNumber);
    out.push({
      from: trace.action.from || null,
      to: trace.action.to || null,
      input: trace.action.input || "0x",
      callType,
      blockNumber,
      txHash: trace.transactionHash || null,
      traceAddress: Array.isArray(trace.traceAddress) ? trace.traceAddress.join(".") : "",
    });
  }
  return out;
}

function unwrapDebug(entry) {
  if (!entry || typeof entry !== "object") return null;
  const txHash = entry.txHash || entry.transactionHash || null;
  if (entry.result && typeof entry.result === "object") {
    return { txHash, tree: entry.result };
  }
  if (entry.from || entry.to || entry.calls) return { txHash, tree: entry };
  return null;
}

function walk(node, txHash, blockNumber, path, out) {
  if (!node || typeof node !== "object") return;
  const callType = String(node.type || "").toLowerCase();
  if (CALL_TYPES.has(callType)) {
    out.push({
      from: node.from || null,
      to: node.to || null,
      input: node.input || "0x",
      callType,
      blockNumber,
      txHash,
      traceAddress: path.join("."),
    });
  }
  if (Array.isArray(node.calls)) {
    node.calls.forEach((child, index) => walk(child, txHash, blockNumber, path.concat(index), out));
  }
}

export function parseDebugBlock(entries, blockNumber) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    const unwrapped = unwrapDebug(entry);
    if (!unwrapped) continue;
    walk(unwrapped.tree, unwrapped.txHash, blockNumber, [], out);
  }
  return out;
}

export function poolCallsFromParsed(parsed, poolLower) {
  const out = [];
  for (const call of parsed) {
    const to = String(call.to || "").toLowerCase();
    const from = String(call.from || "").toLowerCase();
    if (!to || to !== poolLower || !from || from === poolLower) continue;
    const input = String(call.input || "0x").toLowerCase();
    if (!input.startsWith("0x") || input.length < 10) continue;
    if (!Number.isInteger(call.blockNumber)) continue;
    out.push({
      from,
      to,
      selector: input.slice(0, 10),
      callType: call.callType,
      blockNumber: call.blockNumber,
      txHash: String(call.txHash || "").toLowerCase(),
      traceAddress: call.traceAddress || "",
    });
  }
  return out;
}

export function createAggregator(selectorMap, maxTx = null) {
  const rows = new Map();
  const txs = new Set();
  const seen = new Set();
  const blocks = new Set();
  let matched = 0;
  let stopped = false;

  function add(calls) {
    let added = 0;
    for (const call of calls) {
      blocks.add(call.blockNumber);
      const info = selectorMap.get(call.selector);
      if (!info) continue;
      const id = `${call.txHash}:${call.traceAddress}:${call.selector}:${call.from}`;
      if (seen.has(id)) continue;
      if (maxTx && !txs.has(call.txHash) && txs.size >= maxTx) {
        stopped = true;
        continue;
      }
      seen.add(id);
      txs.add(call.txHash);
      matched += 1;
      added += 1;
      const key = `${call.from}|${call.selector}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          caller: call.from,
          selector: call.selector,
          functionName: info.names.join(" / "),
          signature: info.signatures.join(" / "),
          version: info.versions.join("/"),
          callTypes: [],
          count: 0,
          firstBlock: call.blockNumber,
          lastBlock: call.blockNumber,
          exampleTx: call.txHash,
          exampleTrace: call.traceAddress,
        };
        rows.set(key, row);
      }
      row.count += 1;
      if (call.blockNumber < row.firstBlock) row.firstBlock = call.blockNumber;
      if (call.blockNumber > row.lastBlock) row.lastBlock = call.blockNumber;
      if (!row.callTypes.includes(call.callType)) row.callTypes.push(call.callType);
    }
    return added;
  }

  function snapshot() {
    const list = [...rows.values()].sort((a, b) => b.count - a.count || a.functionName.localeCompare(b.functionName) || a.caller.localeCompare(b.caller));
    return {
      rows: list,
      txCount: txs.size,
      matched,
      stopped,
      blocksWithPoolCalls: blocks.size,
      poolBlocks: blocks,
    };
  }

  function load(savedRows) {
    for (const row of savedRows || []) {
      const caller = String(row.caller || "").toLowerCase();
      const selector = String(row.selector || "").toLowerCase();
      if (!caller || !selector) continue;
      const key = `${caller}|${selector}`;
      if (rows.has(key)) continue;
      rows.set(key, {
        caller,
        selector,
        functionName: row.functionName,
        signature: row.signature,
        version: row.version,
        callTypes: [...(row.callTypes || [])],
        count: row.count || 0,
        firstBlock: row.firstBlock,
        lastBlock: row.lastBlock,
        exampleTx: row.exampleTx || null,
        exampleTrace: row.exampleTrace || "",
      });
      matched += row.count || 0;
    }
  }

  return {
    add,
    load,
    snapshot,
    get stopped() {
      return stopped;
    },
  };
}
