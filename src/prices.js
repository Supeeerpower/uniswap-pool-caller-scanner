// DefiLlama's free coins API. No key. https://coins.llama.fi/prices/current/{chain}:{address}
// Chain slugs are DefiLlama's names, not chain ids. Unknown chains fall through
// to a stablecoin symbol heuristic (USDC, USDT, DAI, and common bridged variants = $1).

export const LLAMA_CHAIN = {
  1: "ethereum",
  10: "optimism",
  14: "flare",
  56: "bsc",
  100: "gnosis",
  130: "unichain",
  137: "polygon",
  143: "monad",
  146: "sonic",
  196: "xlayer",
  324: "era",
  369: "pulse",
  999: "hyperliquid",
  1101: "polygon_zkevm",
  1868: "soneium",
  5000: "mantle",
  8453: "base",
  34443: "mode",
  42161: "arbitrum",
  42220: "celo",
  43114: "avax",
  57073: "ink",
  59144: "linea",
  81457: "blast",
  534352: "scroll",
  747474: "katana",
};

const STABLES = new Set([
  "USDC", "USDT", "DAI", "USDC.E", "USDCE", "USDT.E", "USDTE", "USDBC", "USDbC",
  "USDT0", "GHO", "FRAX", "LUSD", "CRVUSD", "USDE", "USD0", "USDS", "PYUSD",
  "TUSD", "USDP", "GUSD", "USD+", "USDC.E", "AXLUSDC", "USDC.E",
]);

export function isStableSymbol(symbol) {
  if (!symbol) return false;
  return STABLES.has(symbol.toUpperCase());
}

export function amountUsd(raw, decimals, price) {
  if (raw == null || decimals == null || price == null) return null;
  let value;
  try {
    value = BigInt(raw);
  } catch {
    return null;
  }
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const amount = Number(whole) + Number(frac) / Number(scale);
  const usd = amount * Number(price);
  return Number.isFinite(usd) ? usd : null;
}

export function formatUnits(raw, decimals) {
  if (raw == null || decimals == null) return null;
  let value;
  try {
    value = BigInt(raw);
  } catch {
    return null;
  }
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export async function fetchLlamaPrices(chainId, addresses) {
  const slug = LLAMA_CHAIN[Number(chainId)];
  const unique = [...new Set(addresses.map((a) => String(a || "").toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
  const prices = new Map();
  if (!slug || unique.length === 0) return { prices, slug: slug || null };
  for (let i = 0; i < unique.length; i += 40) {
    const batch = unique.slice(i, i + 40).map((a) => `${slug}:${a}`).join(",");
    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${batch}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) continue;
      const body = await res.json();
      for (const [key, coin] of Object.entries(body.coins || {})) {
        const addr = key.split(":")[1];
        if (addr && coin && Number.isFinite(Number(coin.price))) prices.set(addr.toLowerCase(), Number(coin.price));
      }
    } catch {
      // A missing price is shown as blank. The stablecoin fallback still applies.
    }
  }
  return { prices, slug };
}

export function priceFor(token, llamaPrices) {
  const addr = String(token || "").toLowerCase();
  if (llamaPrices.has(addr)) return { price: llamaPrices.get(addr), source: "defillama" };
  return { price: null, source: null };
}

export function priceForSymbol(symbol, llamaHit) {
  if (llamaHit.price != null) return llamaHit;
  if (isStableSymbol(symbol)) return { price: 1, source: "stablecoin" };
  return { price: null, source: null };
}
