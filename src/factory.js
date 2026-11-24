import { id } from "ethers";
import { decodeMaybeString, decodeUint, hexQty, toHex } from "./decode.js";
import { amountUsd, fetchLlamaPrices, formatUnits, priceFor, priceForSymbol } from "./prices.js";
import { mapPool, rpcCall } from "./rpc.js";

const ALL_PAIRS_LENGTH = "0x574f2ba3";
const ALL_PAIRS = "0x1e3dd18b";
const TOKEN0 = "0x0dfe1681";
const TOKEN1 = "0xd21220a7";
const GET_RESERVES = "0x0902f1ac";
const SYMBOL = "0x95d89b41";
const DECIMALS = "0x313ce567";
const BALANCE_OF = "0x70a08231";
const STABLE = id("stable()").slice(0, 10);

export const FACTORY_TOPICS = [
  {
    kind: "v2",
    topic: id("PairCreated(address,address,address,uint256)"),
    poolWord: 0,
  },
  {
    kind: "solidly",
    topic: id("PairCreated(address,address,bool,address,uint256)"),
    poolWord: 1,
    stableWord: 0,
  },
  {
    kind: "v3",
    topic: id("PoolCreated(address,address,uint24,int24,address)"),
    poolWord: 1,
    tickWord: 0,
    feeTopic: 3,
  },
  {
    kind: "slipstream",
    topic: id("PoolCreated(address,address,int24,address)"),
    poolWord: 0,
    tickTopic: 3,
  },
  {
    kind: "algebra",
    topic: id("Pool(address,address,address)"),
    poolWord: 0,
  },
];

const TOPIC_BY_HASH = new Map(FACTORY_TOPICS.map((item) => [item.topic.toLowerCase(), item]));

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(data, index) {
  const hex = String(data || "").replace(/^0x/, "");
  const slice = hex.slice(index * 64, index * 64 + 64);
  if (slice.length < 64) return null;
  const addr = `0x${slice.slice(24)}`;
  return /^0x[0-9a-f]{40}$/.test(addr) && !/^0x0{40}$/.test(addr) ? addr : null;
}

function topicAddress(topic) {
  if (!topic || topic.length < 66) return null;
  const addr = `0x${topic.slice(-40)}`;
  return /^0x[0-9a-f]{40}$/.test(addr) && !/^0x0{40}$/.test(addr) ? addr : null;
}

export function parseFactoryLog(log) {
  const spec = TOPIC_BY_HASH.get(String(log.topics?.[0] || "").toLowerCase());
  if (!spec) return null;
  const pool = addressWord(log.data, spec.poolWord);
  if (!pool) return null;
  const block = hexQty(log.blockNumber);
  if (!Number.isInteger(block)) return null;
  const fee = spec.feeTopic != null ? hexQty(log.topics[spec.feeTopic]) : null;
  const tickSpacing = spec.tickTopic != null
    ? hexQty(log.topics[spec.tickTopic])
    : spec.tickWord != null
      ? signedWord(log.data, spec.tickWord)
      : null;
  const stable = spec.stableWord != null ? hexQty(wordOf(log.data, spec.stableWord)) === 1 : null;
  return {
    kind: spec.kind,
    pool,
    creationBlock: block,
    token0: topicAddress(log.topics[1]),
    token1: topicAddress(log.topics[2]),
    fee,
    tickSpacing,
    stable,
    tx: log.transactionHash || null,
  };
}

function wordOf(data, index) {
  const hex = String(data || "").replace(/^0x/, "");
  return `0x${hex.slice(index * 64, index * 64 + 64)}`;
}

function signedWord(data, index) {
  const raw = wordOf(data, index).replace(/^0x/, "");
  if (raw.length !== 64) return null;
  let value = BigInt(`0x${raw}`);
  const sign = 1n << 255n;
  if (value >= sign) value -= 1n << 256n;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function call(url, to, data, block = "latest") {
  try {
    const result = await rpcCall(url, "eth_call", [{ to, data }, block], { timeoutMs: 20_000 });
    if (typeof result !== "string" || result === "0x") return null;
    return result;
  } catch {
    return null;
  }
}

export async function findDeploymentBlock(url, address, head) {
  let lo = 0;
  let hi = head;
  let found = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await rpcCall(url, "eth_getCode", [address, toHex(mid)], { timeoutMs: 20_000 }).catch(() => "0x");
    if (code && code !== "0x" && code !== "0x0") {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

async function allPairsAt(url, factory, index) {
  const result = await call(url, factory, ALL_PAIRS + word(index));
  return result ? addressWord(result, 0) : null;
}

async function allPairsLength(url, factory) {
  const result = await call(url, factory, ALL_PAIRS_LENGTH);
  if (!result || result.length < 66) return null;
  try {
    const n = Number(BigInt(result));
    if (!Number.isInteger(n) || n < 0 || n > 5_000_000) return null;
    return n;
  } catch {
    return null;
  }
}

function reservesOf(hex) {
  if (!hex || hex.length < 2 + 64 * 2) return null;
  const body = hex.replace(/^0x/, "");
  try {
    return [BigInt(`0x${body.slice(0, 64)}`).toString(), BigInt(`0x${body.slice(64, 128)}`).toString()];
  } catch {
    return null;
  }
}

function balanceOfData(holder) {
  return BALANCE_OF + word(holder);
}

async function enrichPool(url, pool) {
  const token0 = pool.token0 || addressWord(await call(url, pool.pool, TOKEN0), 0);
  const token1 = pool.token1 || addressWord(await call(url, pool.pool, TOKEN1), 0);
  const [symbol0, symbol1, dec0, dec1, reservesHex, bal0, bal1, stableHex] = await Promise.all([
    token0 ? call(url, token0, SYMBOL) : null,
    token1 ? call(url, token1, SYMBOL) : null,
    token0 ? call(url, token0, DECIMALS) : null,
    token1 ? call(url, token1, DECIMALS) : null,
    call(url, pool.pool, GET_RESERVES),
    token0 ? call(url, token0, balanceOfData(pool.pool)) : null,
    token1 ? call(url, token1, balanceOfData(pool.pool)) : null,
    pool.kind === "v2" || pool.kind === "solidly" ? call(url, pool.pool, STABLE) : null,
  ]);
  const reserves = reservesOf(reservesHex);
  const balance0 = reserves ? reserves[0] : uintString(bal0);
  const balance1 = reserves ? reserves[1] : uintString(bal1);
  const decimals0 = dec0 ? decodeUint(dec0) : null;
  const decimals1 = dec1 ? decodeUint(dec1) : null;
  const stable = stableHex ? decodeUint(stableHex) === 1 : pool.stable;
  const kind = stable ? "solidly" : pool.kind;
  return {
    ...pool,
    token0,
    token1,
    symbol0: decodeMaybeString(symbol0),
    symbol1: decodeMaybeString(symbol1),
    decimals0,
    decimals1,
    reserve0: balance0,
    reserve1: balance1,
    reserveSource: reserves ? "getReserves" : "balanceOf",
    stable: Boolean(stable),
    kind,
  };
}

function uintString(hex) {
  if (!hex || hex === "0x") return null;
  try {
    return BigInt(hex).toString();
  } catch {
    return null;
  }
}

async function attachPrices(chainId, pools) {
  const tokens = pools.flatMap((pool) => [pool.token0, pool.token1]);
  const { prices, slug } = await fetchLlamaPrices(chainId, tokens);
  return pools.map((pool) => {
    const left = priceForSymbol(pool.symbol0, priceFor(pool.token0, prices));
    const right = priceForSymbol(pool.symbol1, priceFor(pool.token1, prices));
    const usd0 = amountUsd(pool.reserve0, pool.decimals0, left.price);
    const usd1 = amountUsd(pool.reserve1, pool.decimals1, right.price);
    const usd = usd0 == null && usd1 == null ? null : (usd0 || 0) + (usd1 || 0);
    return {
      ...pool,
      price0: left.price,
      price1: right.price,
      price0Source: left.source,
      price1Source: right.source,
      usd0,
      usd1,
      usd,
      reserve0Text: formatUnits(pool.reserve0, pool.decimals0),
      reserve1Text: formatUnits(pool.reserve1, pool.decimals1),
      llamaChain: slug,
    };
  });
}

async function enumeratePairs(url, factory, count, onProgress, signal) {
  const pools = [];
  const step = 20;
  for (let start = 0; start < count; start += step) {
    if (signal?.aborted) break;
    const indexes = [];
    for (let i = start; i < Math.min(count, start + step); i += 1) indexes.push(i);
    const found = await mapPool(indexes, 6, async (index) => {
      const pool = await allPairsAt(url, factory, index);
      return pool ? { pool, index } : null;
    });
    for (const item of found) {
      if (item) pools.push({ kind: "v2", pool: item.pool, allPairsIndex: item.index, creationBlock: null, token0: null, token1: null });
    }
    onProgress?.({ phase: "enumerate", done: pools.length, total: count });
  }
  return pools;
}

async function creationBlocks(url, pools, head, onProgress, signal) {
  let done = 0;
  await mapPool(pools, 4, async (pool) => {
    if (signal?.aborted || pool.creationBlock != null) return;
    try {
      pool.creationBlock = await findDeploymentBlock(url, pool.pool, head);
    } catch {
      pool.creationBlock = null;
    }
    done += 1;
    if (done % 3 === 0) onProgress?.({ phase: "creation", done, total: pools.length });
  });
}

async function logsForTopics(url, factory, fromBlock, toBlock, onProgress, signal) {
  const found = new Map();
  const span = toBlock - fromBlock + 1;
  const step = 80;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    if (signal?.aborted) break;
    const end = Math.min(toBlock, cursor + step - 1);
    try {
      const logs = await rpcCall(url, "eth_getLogs", [{
        address: factory,
        topics: [FACTORY_TOPICS.map((item) => item.topic)],
        fromBlock: toHex(cursor),
        toBlock: toHex(end),
      }], { timeoutMs: 25_000 });
      if (Array.isArray(logs)) {
        for (const log of logs) {
          const parsed = parseFactoryLog(log);
          if (!parsed) continue;
          const key = parsed.pool.toLowerCase();
          if (!found.has(key)) found.set(key, parsed);
        }
      }
    } catch (err) {
      if (end > cursor && /range|too many|more than|limit|response|large/i.test(err.message)) {
        const mid = Math.floor((cursor + end) / 2);
        const left = await logsForTopics(url, factory, cursor, mid, onProgress, signal);
        const right = await logsForTopics(url, factory, mid + 1, end, onProgress, signal);
        for (const pool of [...left, ...right]) found.set(pool.pool.toLowerCase(), pool);
        cursor = end + 1;
        continue;
      }
      throw err;
    }
    onProgress?.({ phase: "logs", lastBlock: end, fromBlock, toBlock, found: found.size, fraction: (end - fromBlock + 1) / span });
    cursor = end + 1;
  }
  return [...found.values()];
}

export async function discoverFactory({ rpcUrl, factory, chainId, fromBlock = null, toBlock = null, onProgress, signal }) {
  const head = hexQty(await rpcCall(rpcUrl, "eth_blockNumber", [], { timeoutMs: 15_000 }));
  const upper = toBlock == null ? head : Math.min(toBlock, head);
  const length = await allPairsLength(rpcUrl, factory);
  let pools = [];
  let kind = "unknown";
  let mode = "logs";
  if (length != null && fromBlock == null) {
    mode = "allPairs";
    kind = "v2";
    onProgress?.({ phase: "enumerate", done: 0, total: length, mode });
    pools = await enumeratePairs(rpcUrl, factory, length, onProgress, signal);
    if (pools[0]) {
      const stable = await call(rpcUrl, pools[0].pool, STABLE);
      if (stable && decodeUint(stable) != null) kind = "solidly";
    }
    await creationBlocks(rpcUrl, pools, head, onProgress, signal);
  } else {
    const deployment = fromBlock ?? await findDeploymentBlock(rpcUrl, factory, head);
    if (deployment == null) throw new Error("Could not find the factory deployment block. Pass a start block.");
    const start = fromBlock == null ? deployment : Math.max(fromBlock, deployment);
    onProgress?.({ phase: "logs", lastBlock: start, fromBlock: start, toBlock: upper, found: 0, deployment });
    pools = await logsForTopics(rpcUrl, factory, start, upper, onProgress, signal);
    kind = pools[0]?.kind || "v3";
  }
  onProgress?.({ phase: "metadata", done: 0, total: pools.length });
  const enriched = [];
  for (let i = 0; i < pools.length; i += 8) {
    if (signal?.aborted) break;
    const slice = pools.slice(i, i + 8);
    const batch = await mapPool(slice, 4, (pool) => enrichPool(rpcUrl, pool));
    enriched.push(...batch);
    onProgress?.({ phase: "metadata", done: enriched.length, total: pools.length });
  }
  const priced = await attachPrices(chainId, enriched);
  return {
    kind,
    mode,
    head,
    poolCount: priced.length,
    pools: priced.map((pool) => ({ ...pool, kind: pool.kind || kind })),
  };
}

export function scanFunctionFor(kind) {
  if (kind === "v3" || kind === "slipstream" || kind === "algebra") return "v3:slot0";
  return "v2:getReserves";
}

export { amountUsd };
