// Defaults verified with live JSON-RPC calls on 24 Nov 2026.
// `trace` describes the free endpoint, not every possible provider.
//   filter — trace_filter answered and included staticcalls
//   debug  — debug_traceBlockByNumber (callTracer) answered; parity trace_ did not on the free tier
//   none   — free endpoint did not serve traces that day; paste your own RPC

export const chains = [
  {
    chainId: 1,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    defaultRpc: "https://eth.drpc.org",
    trace: "filter",
    hint: "Free default is dRPC. trace_filter is on and, in spot checks, still served Ethereum history back to block 13,000,000. Calls are chunked so a public rate limit does not take the whole scan down.",
  },
  {
    chainId: 8453,
    name: "Base",
    explorer: "https://basescan.org",
    defaultRpc: "https://base.drpc.org",
    trace: "filter",
    hint: "Free default is dRPC. trace_filter works. That endpoint rejects ranges over 100 blocks, so the scanner sends smaller chunks.",
  },
  {
    chainId: 10,
    name: "Optimism",
    explorer: "https://optimistic.etherscan.io",
    defaultRpc: "https://optimism.drpc.org",
    trace: "filter",
    hint: "Free default is dRPC. trace_filter answered, including internal calls.",
  },
  {
    chainId: 42161,
    name: "Arbitrum",
    explorer: "https://arbiscan.io",
    defaultRpc: "https://arbitrum.drpc.org",
    trace: "debug",
    hint: "Free default is dRPC. trace_filter and trace_block are not available. The scanner falls back to debug_traceBlockByNumber, one block at a time. Arbitrum blocks are short, so raise the block count if a range looks empty.",
  },
  {
    chainId: 137,
    name: "Polygon",
    explorer: "https://polygonscan.com",
    defaultRpc: "https://polygon.drpc.org",
    trace: "debug",
    hint: "Free default is dRPC. trace_filter is paywalled. debug_traceBlockByNumber with callTracer works and is heavier than trace_filter.",
  },
  {
    chainId: 56,
    name: "BNB Smart Chain",
    explorer: "https://bscscan.com",
    defaultRpc: "https://bsc.drpc.org",
    trace: "none",
    hint: "The public dRPC endpoint rate-limited basic reads during testing, and the free Binance dataseeds do not expose traces. Paste a trace-capable RPC before scanning.",
  },
  {
    chainId: 43114,
    name: "Avalanche",
    explorer: "https://snowtrace.io",
    defaultRpc: "https://avalanche.drpc.org",
    trace: "none",
    hint: "Reads work on public dRPC. trace_filter is missing, and debug_traceBlockByNumber asks for a registered account. Paste your own trace RPC.",
  },
  {
    chainId: 100,
    name: "Gnosis",
    explorer: "https://gnosisscan.io",
    defaultRpc: "https://gnosis.drpc.org",
    trace: "filter",
    hint: "Free default is dRPC. trace_filter answered.",
  },
  {
    chainId: 59144,
    name: "Linea",
    explorer: "https://lineascan.build",
    defaultRpc: "https://linea.drpc.org",
    trace: "debug",
    hint: "Free default is dRPC. trace_filter could not be routed. debug_traceBlockByNumber answered.",
  },
  {
    chainId: 130,
    name: "Unichain",
    explorer: "https://uniscan.xyz",
    defaultRpc: "https://unichain.drpc.org",
    trace: "filter",
    hint: "Free default is dRPC. trace_filter answered.",
  },
  {
    chainId: 146,
    name: "Sonic",
    explorer: "https://sonicscan.org",
    defaultRpc: "https://sonic.drpc.org",
    trace: "filter",
    hint: "Free default is dRPC. trace_filter answered. debug_traceBlockByNumber did not.",
  },
  {
    chainId: 534352,
    name: "Scroll",
    explorer: "https://scrollscan.com",
    defaultRpc: "https://scroll.drpc.org",
    trace: "none",
    hint: "On 24 Nov 2026 the free dRPC endpoint did not serve trace_filter or debug_traceBlockByNumber. Paste a trace-capable RPC.",
  },
  {
    chainId: 324,
    name: "zkSync Era",
    explorer: "https://era.zksync.network",
    defaultRpc: "https://zksync.drpc.org",
    trace: "none",
    hint: "zkSync is not stock EVM. The public endpoint returned method-not-found for both trace_filter and debug_traceBlockByNumber.",
  },
  {
    chainId: 81457,
    name: "Blast",
    explorer: "https://blastscan.io",
    defaultRpc: "https://blast-rpc.publicnode.com",
    trace: "none",
    hint: "dRPC's free tier does not serve Blast. The default is a PublicNode read endpoint, which does not expose traces without a personal token. Paste a trace-capable RPC.",
  },
  {
    chainId: 5000,
    name: "Mantle",
    explorer: "https://mantlescan.xyz",
    defaultRpc: "https://mantle.drpc.org",
    trace: "none",
    hint: "Reads answered. Trace methods returned a temporary error on the free tier during testing. Treat traces as unavailable unless you supply a node.",
  },
  {
    chainId: 42220,
    name: "Celo",
    explorer: "https://celoscan.io",
    defaultRpc: "https://celo.drpc.org",
    trace: "none",
    hint: "Reads answered. Trace methods returned a temporary error on the free tier during testing. Paste a trace-capable RPC if the default fails.",
  },
  {
    chainId: 480,
    name: "World Chain",
    explorer: "https://worldscan.org",
    defaultRpc: "https://worldchain.drpc.org",
    trace: "none",
    hint: "Reads answered. Trace methods returned a temporary error on the free tier during testing.",
  },
];

export const examples = [
  {
    id: "eth-v2-usdc-weth",
    label: "Ethereum V2 USDC/WETH",
    chainId: 1,
    address: "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc",
    functions: ["v2:getReserves"],
    maxBlocks: 200,
    blurb: "Canonical Uniswap V2 pair. getReserves shows up as a staticcall from routers and aggregators.",
  },
  {
    id: "eth-v3-usdc-weth",
    label: "Ethereum V3 USDC/WETH 0.05%",
    chainId: 1,
    address: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    functions: ["v3:slot0"],
    maxBlocks: 40,
    blurb: "Canonical Uniswap V3 pool. slot0 is read inside many on-chain swaps.",
  },
  {
    id: "base-v3-weth-usdc",
    label: "Base V3 WETH/USDC 0.05%",
    chainId: 8453,
    address: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
    functions: ["v3:slot0", "v3:liquidity"],
    maxBlocks: 80,
    blurb: "Uniswap V3 pool on Base. The free RPC caps each trace_filter at 100 blocks; the scan is chunked under that.",
  },
];

export function chainById(chainId) {
  return chains.find((c) => c.chainId === Number(chainId)) || null;
}

export function rpcForChain(chain) {
  const override = process.env[`RPC_URL_${chain.chainId}`];
  if (override && override.trim()) {
    return { url: override.trim(), fromEnv: true };
  }
  return { url: chain.defaultRpc, fromEnv: false };
}

export function publicHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "custom";
  }
}

export function makeCustomChain(chainId) {
  return {
    chainId: Number(chainId),
    name: `Chain ${chainId}`,
    explorer: null,
    defaultRpc: null,
    trace: "none",
    hint: "Custom chain. Traces depend entirely on the RPC you pasted.",
  };
}
