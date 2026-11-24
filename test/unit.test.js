import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import { functionCatalog, selectorOf } from "../src/abi.js";
import { chainById, chains, rpcCandidates, segmentBlockCap } from "../src/chains.js";
import { scanProgress } from "../src/factoryJobs.js";
import { backoffDelay } from "../src/rpc.js";
import {
  classifyCode,
  codeSize,
  decodeAbiString,
  decodeAddressWord,
  formatFee,
  isDelegatedEoa,
  resolveRange,
} from "../src/decode.js";
import { labelFor } from "../src/labels.js";
import { RpcError, classifyError } from "../src/rpc.js";
import { POOL_EVENT_TOPICS } from "../src/scan.js";
import { createAggregator, parseDebugBlock, parseParityTraces, poolCallsFromParsed } from "../src/traces.js";

const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const CALLER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const OTHER = "0x111111125421ca6dc452d289314280a0f8842a65";

test("scan progress is the share of blocks from creation through the target", () => {
  assert.deepEqual(scanProgress({ creationBlock: 100, targetEnd: 199, lastScannedBlock: 149 }), {
    pct: 50,
    block: 149,
    done: 50,
    span: 100,
  });
  assert.equal(scanProgress({ creationBlock: 100, targetEnd: 199, lastScannedBlock: 99 }).pct, 0);
  assert.equal(scanProgress({ creationBlock: 100, targetEnd: 199, lastScannedBlock: 199 }).pct, 100);
  assert.equal(scanProgress({ creationBlock: null, targetEnd: 10, lastScannedBlock: 1 }).pct, null);
});

test("each supported chain has an http explorer base URL", () => {
  const byId = new Map(chains.map((chain) => [chain.chainId, chain.explorer]));
  assert.equal(byId.get(1), "https://etherscan.io");
  assert.equal(byId.get(8453), "https://basescan.org");
  assert.equal(byId.get(42161), "https://arbiscan.io");
  assert.equal(byId.get(369), "https://scan.pulsechain.com");
  assert.equal(byId.get(747474), "https://katanascan.com");
  for (const chain of chains) {
    assert.equal(typeof chain.name, "string");
    assert.ok(chain.explorer == null || /^https:\/\/\S+$/.test(chain.explorer), chain.name);
  }
});

test("pulsechain tries the trace_filter endpoint before the official trace_block RPC", () => {
  const urls = rpcCandidates(chainById(369));
  assert.equal(urls[0], "https://rpc-pulsechain.g4mm4.io");
  assert.ok(urls.includes("https://rpc.pulsechain.com"));
  assert.equal(segmentBlockCap(chainById(369)), null);
  assert.equal(segmentBlockCap({ trace: "block" }), 40);
});

test("rpc backoff grows inside a capped window", () => {
  for (let i = 0; i < 30; i += 1) {
    const first = backoffDelay(0);
    assert.ok(first >= 200 && first <= 400, String(first));
    const later = backoffDelay(4);
    assert.ok(later >= 3200 && later <= 6400, String(later));
  }
});

test("canonical selectors are derived from the ABI", () => {
  assert.equal(selectorOf("v2", "getReserves"), "0x0902f1ac");
  assert.equal(selectorOf("v3", "slot0"), "0x3850c7bd");
  assert.equal(selectorOf("v2", "swap"), "0x022c0d9f");
  assert.equal(selectorOf("v3", "swap"), "0x128acb08");
  assert.equal(selectorOf("v2", "token0"), selectorOf("v3", "token0"));
  const ids = functionCatalog().map((fn) => fn.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(functionCatalog().every((fn) => /^0x[0-9a-f]{8}$/.test(fn.selector)));
});

test("pool event topics match the canonical signatures", () => {
  const signatures = [
    "Swap(address,address,int256,int256,uint160,uint128,int24)",
    "Mint(address,address,int24,int24,uint128,uint256,uint256)",
    "Burn(address,int24,int24,uint128,uint256,uint256)",
    "Sync(uint112,uint112)",
    "Swap(address,uint256,uint256,uint256,uint256,address)",
    "Mint(address,uint256,uint256)",
    "Burn(address,uint256,uint256,address)",
  ];
  assert.deepEqual(POOL_EVENT_TOPICS, signatures.map((sig) => id(sig)));
});

test("parity traces keep staticcalls to the pool and drop the pool itself", () => {
  const parsed = parseParityTraces([
    {
      type: "call",
      action: { callType: "staticcall", from: CALLER, to: POOL, input: "0x3850c7bd" },
      blockNumber: "0x10",
      transactionHash: "0xabc",
      traceAddress: [0, 1],
    },
    {
      type: "call",
      action: { callType: "call", from: POOL, to: POOL, input: "0x3850c7bd" },
      blockNumber: 16,
      transactionHash: "0xabc",
      traceAddress: [0, 2],
    },
    {
      type: "create",
      action: { from: CALLER },
      blockNumber: "0x10",
      transactionHash: "0xabc",
      traceAddress: [],
    },
  ]);
  const calls = poolCallsFromParsed(parsed, POOL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selector, "0x3850c7bd");
  assert.equal(calls[0].blockNumber, 16);
  assert.equal(calls[0].traceAddress, "0.1");
  assert.equal(calls[0].callType, "staticcall");
});

test("debug call trees are walked, including nested staticcalls", () => {
  const parsed = parseDebugBlock([
    {
      txHash: "0xtx",
      result: {
        from: "0x1111111111111111111111111111111111111111",
        to: OTHER,
        input: "0x12345678",
        type: "CALL",
        calls: [
          {
            from: OTHER,
            to: POOL,
            input: "0x0902f1ac",
            type: "STATICCALL",
            calls: [
              {
                from: POOL,
                to: "0x2222222222222222222222222222222222222222",
                input: "0xaaaaaaaa",
                type: "DELEGATECALL",
              },
            ],
          },
        ],
      },
    },
    { txHash: "0xfailed", error: "reverted" },
  ], 90);
  const calls = poolCallsFromParsed(parsed, POOL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, OTHER);
  assert.equal(calls[0].callType, "staticcall");
  assert.equal(calls[0].blockNumber, 90);
  assert.equal(calls[0].traceAddress, "0");
});

test("aggregator dedupes by caller and selector and honors the transaction cap", () => {
  const map = new Map([
    ["0x3850c7bd", { names: ["slot0"], signatures: ["slot0()"], versions: ["v3"] }],
    ["0x0902f1ac", { names: ["getReserves"], signatures: ["getReserves()"], versions: ["v2"] }],
  ]);
  const agg = createAggregator(map, 1);
  const base = {
    to: POOL,
    blockNumber: 5,
    txHash: "0x1",
    traceAddress: "0",
  };
  agg.add([
    { ...base, from: CALLER, selector: "0x3850c7bd", callType: "staticcall" },
    { ...base, from: CALLER, selector: "0x3850c7bd", callType: "staticcall", traceAddress: "1" },
    { ...base, from: CALLER, selector: "0x3850c7bd", callType: "staticcall", traceAddress: "1" },
    { ...base, from: OTHER, selector: "0x0902f1ac", callType: "staticcall", txHash: "0x2", blockNumber: 9 },
    { ...base, from: OTHER, selector: "0xdeadbeef", callType: "call", txHash: "0x2" },
  ]);
  const snap = agg.snapshot();
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].count, 2);
  assert.equal(snap.rows[0].functionName, "slot0");
  assert.equal(snap.txCount, 1);
  assert.equal(snap.stopped, true);
  assert.equal(snap.blocksWithPoolCalls, 2);
});

test("code classification separates contracts, EOAs, and delegated EOAs", () => {
  assert.equal(classifyCode("0x"), "eoa");
  assert.equal(classifyCode("0x60016000"), "contract");
  assert.equal(codeSize("0x6001"), 2);
  const delegated = `0xef0100${"11".repeat(20)}`;
  assert.equal(isDelegatedEoa(delegated), true);
  assert.equal(classifyCode(delegated), "eoa");
  assert.equal(classifyCode(null), "unknown");
});

test("range resolution clamps to the head and the max block count", () => {
  assert.deepEqual(resolveRange({ startBlock: 10, endBlock: null, maxBlocks: 5, head: 100, cap: 50 }), {
    start: 10,
    end: 14,
    note: null,
  });
  const capped = resolveRange({ startBlock: 10, endBlock: 80, maxBlocks: 5, head: 100, cap: 50 });
  assert.equal(capped.end, 14);
  assert.match(capped.note, /capped/i);
  const pastHead = resolveRange({ startBlock: 90, endBlock: 200, maxBlocks: 50, head: 100, cap: 50 });
  assert.equal(pastHead.end, 100);
  assert.throws(() => resolveRange({ startBlock: 5, endBlock: null, maxBlocks: 3, head: 4, cap: 2 }), /capped at 2/);
});

test("rpc errors are classified for retry versus method fallback", () => {
  assert.equal(classifyError(new RpcError("method is not available", { code: -32601 })), "unsupported");
  assert.equal(classifyError(new RpcError("rate limit", { status: 429 })), "rate");
  assert.equal(classifyError(new RpcError("Block range too large")), "range");
  assert.equal(classifyError(new RpcError("missing trie node")), "pruned");
  assert.equal(classifyError(Object.assign(new Error("Scan cancelled"), { code: "CANCELLED" })), "cancelled");
});

test("abi words decode to addresses, strings, and fee labels", () => {
  const word = `0x${"0".repeat(24)}b4e16d0168e52d35cacd2c6185b44281ec28c9dc`;
  assert.equal(decodeAddressWord(word), "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc");
  const text = Buffer.from("USDC", "utf8").toString("hex");
  const encoded = `0x${"0".repeat(62)}20${(4).toString(16).padStart(64, "0")}${text.padEnd(64, "0")}`;
  assert.equal(decodeAbiString(encoded), "USDC");
  assert.equal(formatFee(500), "0.05%");
  assert.equal(formatFee(3000), "0.3%");
  assert.equal(formatFee(10000), "1%");
  assert.equal(labelFor(CALLER), "Uniswap V3 SwapRouter02");
});
