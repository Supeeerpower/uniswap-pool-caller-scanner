import { selectorOf } from "./abi.js";
import { chains, chainById, rpcForChain, makeCustomChain } from "./chains.js";
import {
  classifyCode,
  codeSize,
  decodeAddressWord,
  decodeMaybeString,
  decodeUint,
  formatFee,
  normalizeAddress,
} from "./decode.js";
import { getChainId, mapPool, rpcCall, rpcRetry } from "./rpc.js";

const SYMBOL = "0x95d89b41";

async function ethCall(url, to, data, options) {
  try {
    const result = await rpcRetry(
      () => rpcCall(url, "eth_call", [{ to, data }, "latest"], options),
      { ...options, retries: 1 },
    );
    if (typeof result !== "string" || result === "0x" || result.startsWith("0x08c379a0")) return null;
    return result;
  } catch {
    return null;
  }
}

export async function probeVersion(url, pool, options = {}) {
  const slot0 = await ethCall(url, pool, selectorOf("v3", "slot0"), options);
  const reserves = await ethCall(url, pool, selectorOf("v2", "getReserves"), options);
  const slot0ok = typeof slot0 === "string" && slot0.length >= 2 + 64 * 7;
  const reservesOk = typeof reserves === "string" && reserves.length >= 2 + 64 * 3;
  let version = null;
  if (slot0ok && !reservesOk) version = "v3";
  else if (reservesOk && !slot0ok) version = "v2";
  else if (slot0ok && reservesOk) version = "both";
  return { version, slot0ok, reservesOk };
}

async function readTokens(url, pool, version, options) {
  const token0 = decodeAddressWord(await ethCall(url, pool, selectorOf("v2", "token0"), options));
  const token1 = decodeAddressWord(await ethCall(url, pool, selectorOf("v2", "token1"), options));
  const fee = version === "v3" || version === "both"
    ? decodeUint(await ethCall(url, pool, selectorOf("v3", "fee"), options))
    : null;
  const [symbol0, symbol1] = await Promise.all([
    token0 ? ethCall(url, token0, SYMBOL, options).then(decodeMaybeString) : null,
    token1 ? ethCall(url, token1, SYMBOL, options).then(decodeMaybeString) : null,
  ]);
  return {
    token0,
    token1,
    symbol0,
    symbol1,
    fee,
    feeLabel: formatFee(fee),
  };
}

async function describe(url, pool, chain, options) {
  const code = await rpcRetry(
    () => rpcCall(url, "eth_getCode", [pool, "latest"], options),
    { ...options, retries: 1 },
  );
  if (classifyCode(code) !== "contract") {
    throw new Error(`No contract code at ${pool} via ${chain.name}.`);
  }
  const versionInfo = await probeVersion(url, pool, options);
  const tokens = await readTokens(url, pool, versionInfo.version, options);
  return {
    pool,
    chain,
    rpcUrl: url,
    codeBytes: codeSize(code),
    ...versionInfo,
    ...tokens,
  };
}

export async function detectPool({ address, chainId = null, rpcUrl = null, onLog, signal }) {
  const pool = normalizeAddress(address);
  const options = { timeoutMs: 12_000, signal };

  if (rpcUrl && chainId == null) {
    const id = await getChainId(rpcUrl, options);
    const chain = chainById(id) || makeCustomChain(id);
    onLog?.(`Custom RPC reports chain id ${id} (${chain.name}).`);
    const found = await describe(rpcUrl, pool, chain, options);
    return { ...found, alsoFound: [] };
  }

  if (chainId != null) {
    const chain = chainById(chainId) || makeCustomChain(chainId);
    const url = rpcUrl || rpcForChain(chain).url;
    if (!url) throw new Error("This chain needs an RPC URL.");
    const found = await describe(url, pool, chain, options);
    return { ...found, alsoFound: [] };
  }

  onLog?.(`No chain selected. Checking ${chains.length} default RPCs for contract code.`);
  const hits = [];
  await mapPool(chains, 6, async (candidate) => {
    const url = rpcForChain(candidate).url;
    try {
      const code = await rpcCall(url, "eth_getCode", [pool, "latest"], options);
      if (classifyCode(code) === "contract") hits.push({ chain: candidate, url, code });
    } catch (err) {
      onLog?.(`${candidate.name} probe failed: ${err.message}`);
    }
  });

  if (hits.length === 0) {
    throw new Error("No contract code at that address on the probed chains. Choose a chain or paste an RPC.");
  }

  const ranked = [];
  for (const hit of hits) {
    const versionInfo = await probeVersion(hit.url, pool, options);
    ranked.push({ ...hit, versionInfo });
  }
  ranked.sort((a, b) => {
    const score = (item) => (item.versionInfo.version && item.versionInfo.version !== "both" ? 0 : 1);
    const diff = score(a) - score(b);
    if (diff !== 0) return diff;
    return chains.findIndex((c) => c.chainId === a.chain.chainId) - chains.findIndex((c) => c.chainId === b.chain.chainId);
  });
  const chosen = ranked[0];
  const alsoFound = ranked.slice(1).map((item) => item.chain.name);
  if (alsoFound.length) {
    onLog?.(`Code also exists on ${alsoFound.join(", ")}. Using ${chosen.chain.name}.`);
  } else {
    onLog?.(`Found code on ${chosen.chain.name}.`);
  }
  const tokens = await readTokens(chosen.url, pool, chosen.versionInfo.version, options);
  return {
    pool,
    chain: chosen.chain,
    rpcUrl: chosen.url,
    codeBytes: codeSize(chosen.code),
    ...chosen.versionInfo,
    ...tokens,
    alsoFound,
  };
}
