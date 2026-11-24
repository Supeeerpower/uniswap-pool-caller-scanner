# Pool callers

Find **other contracts** that called a Uniswap V2 pair or V3 pool, including view functions such as `slot0` and `getReserves`.

Those calls usually happen inside someone else's transaction (a router, aggregator, market maker, or oracle). They do not emit a pool event, so `eth_getLogs` and explorer "internal transactions" miss them. The app reads **EVM execution traces**, keeps the immediate caller (`from` on the call frame whose `to` is the pool), drops EOAs, and dedupes by `(caller, function)`.

```bash
npm install
npm start
```

Open http://127.0.0.1:47821

`npm test` runs the unit tests (ABI selectors, trace walking, range caps). No RPC key is required for the default chains that answer traces.

## What you enter

- Pool address.
- Start block. This is the deployed block, or any later height you care about.
- Optional end block, max blocks (default 20, server cap 2000), and max matching transactions. The scan always stops at the chain head and at the max block count.
- Chain. The list covers Ethereum, Base, Optimism, Arbitrum, Polygon, BNB Smart Chain, Avalanche, Gnosis, Linea, Unichain, Sonic, Scroll, zkSync Era, Blast, Mantle, Celo, and World Chain, plus a custom chain id. Leave the chain on auto-detect to probe those defaults with `eth_getCode`.
- Optional RPC URL. It replaces the default for that scan. Use this when the chain is not in the list or the free endpoint does not trace.
- Functions from the Uniswap V2 pair ABI and V3 pool ABI. Selectors are computed in-process with `ethers.Interface` (first 4 bytes of keccak256 of the canonical signature), not hardcoded.

The table shows the caller, function, call count, first and last block, and an example transaction. CSV and JSON export use the same rows. Labels such as "Uniswap V2 Router02" come from a small built-in list of well-known addresses.

## How the scan gets the calls

On each scan the server asks the RPC, in order:

1. **`trace_filter`** with `toAddress` set to the pool. This is the one that scales. Pagination uses `count` / `after` (page size 400). A node that rejects those fields is retried once without them.
2. **`trace_block`**, one block at a time, if parity-style traces exist but `trace_filter` does not.
3. **`debug_traceBlockByNumber`** with `tracer: "callTracer"` and `onlyTopCall: false`. The call tree is walked for `CALL`, `STATICCALL`, `DELEGATECALL`, and `CALLCODE`. If the node rejects `tracerConfig` as an object (Mezo's public endpoint does), the same call is retried with only `{ tracer: "callTracer" }`.
4. **`debug_traceTransaction`** on transactions that emitted a pool Swap, Sync, Mint, or Burn. This is the last resort, for nodes that can trace one transaction and cannot trace a block. It cannot see a view call in a transaction that never emitted a pool event. At most 400 of those transactions are traced per scan.

The first method that answers is kept for the rest of the scan. Chunks default to 20 blocks for `trace_filter` (hard ceiling 50, under the 100-block cap seen on free dRPC) and 1 block for the other two methods. A "range too large", timeout, or pruned-history error splits the chunk. HTTP 429, 5xx, and timeouts retry with backoff (0.5s, 1s, 2s, 4s, 8s, capped at 10s). In-flight chunks default to 2 (`TRACE_CONCURRENCY`). A max-transaction cap forces one chunk at a time so the stop is tight.

Progress is server-sent events on `GET /api/scans/:id/events`. One scan runs at a time so a public RPC is not stampeded. Cancel with the button (`POST /api/scans/:id/cancel`).

After the traces, callers are classified with `eth_getCode`:

- Empty code at latest **and** at the last seen block: EOA, dropped.
- Code starting with `0xef0100`: EIP-7702 delegated EOA, dropped.
- Non-empty code: contract, kept. If latest is empty but the historical block still has code, the row is kept with a note.
- Lookup failed: kept as `unknown` rather than hidden.

A cross-check then requests pool `Swap` / `Mint` / `Burn` / `Sync` logs (80-block chunks, which fits the free dRPC `eth_getLogs` cap of 100). If a block has one of those logs but the trace stream never contained a call to the pool, the UI warns that the caller list is incomplete for that block. A swap log with no swap frame means the node did not really trace the block.

## What worked on 24 Nov 2026

Probed from this environment, no API key. "Works" means the method returned a real result that day, not a promise from a pricing page.

| Chain | Free RPC used | What answered |
| --- | --- | --- |
| Ethereum | `https://eth.drpc.org` | `trace_filter` and `trace_block`. A swap block on the USDC/WETH V3 pool returned the **same 4 pool calls** from both methods (`swap`, `token0`, `token1`, `slot0`). Spot checks of `trace_filter` still returned data at blocks 19,000,001, 15,000,000, and 13,000,000. |
| Base | `https://base.drpc.org` | `trace_filter`. Ranges over 100 blocks are rejected. |
| Optimism | `https://optimism.drpc.org` | `trace_filter` |
| Gnosis | `https://gnosis.drpc.org` | `trace_filter` |
| Unichain | `https://unichain.drpc.org` | `trace_filter` |
| Sonic | `https://sonic.drpc.org` | `trace_filter` (`debug_traceBlockByNumber` did not) |
| Arbitrum | `https://arbitrum.drpc.org` | `debug_traceBlockByNumber` only. `trace_*` is "not available". |
| Polygon | `https://polygon.drpc.org` | `debug_traceBlockByNumber` only. `trace_*` is paywalled on the free plan. A full block trace was about 1 MB. |
| Linea | `https://linea.drpc.org` | `debug_traceBlockByNumber`. `trace_filter` could not be routed. |
| BNB Smart Chain | `https://bsc.drpc.org` | Public tier rate-limited even `eth_blockNumber` during testing. Binance dataseeds do not expose traces. |
| Avalanche | `https://avalanche.drpc.org` | Reads work. `trace_filter` is missing. `debug_traceBlockByNumber` asks for a registered account. |
| Scroll, zkSync Era | dRPC public | Trace and debug methods were not available. zkSync is not stock EVM. |
| Blast | `https://blast-rpc.publicnode.com` | dRPC free does not serve the chain. PublicNode serves reads. Traces need a personal token. |
| Mantle | `https://mantle.drpc.org` | Needs your own trace RPC. Rechecked the same day: `rpc.mantle.xyz` does not whitelist traces, and public dRPC asks for a registered account. |
| Celo | `https://celo.drpc.org` | Needs your own trace RPC. Forno does not whitelist traces. Public dRPC still errors or reports the method missing. |
| World Chain | `https://worldchain.drpc.org` | Reads worked. Trace methods returned a temporary error. |

Also checked, and **not** used as defaults:

- **PublicNode** (`ethereum-rpc.publicnode.com` and the other chain hosts) answers ordinary reads. `debug_*` was "method not found". `trace_*` and archive reads returned HTTP 403, "personal token" required.
- **Nodeflare** public URLs (`rpc.nodeflare.app/*/public`) returned HTTP 403. An October 2026 public survey had seen traces there; they were closed on this date.
- **Valve** (`one.valve.city`) and **Nodereal**'s bare `/v1` path required a key.
- **Etherscan** `txlistinternal` is the wrong tool even with a free key. It lists value transfers and creates, not `staticcall`s of `slot0` or `getReserves`.

Alchemy, QuickNode, Infura, Chainstack, and a self-hosted Erigon / Reth / Nethermind node are all usable by pasting the URL (or setting `RPC_URL_<chainId>`). Whether traces are on depends on the plan. The scanner does not assume a vendor; it probes the four methods above and keeps the first one that answers.

### Networks added 24 Nov 2026

Same day, same machine, no API key. "Works free" means a trace method returned a real call list or call tree. "Needs own RPC" means reads worked and every trace method was missing, rejected, or key-gated. Those chains are still in the dropdown.

| Network | Chain ID | Default RPC | Method that worked | Status |
| --- | --- | --- | --- | --- |
| Monad | 143 | `https://rpc.monad.xyz` | `debug_traceBlockByNumber`, `debug_traceTransaction` | Works free |
| Elysium | 99901 | `https://rpc.elysium.kinetiq.xyz` | none | Needs own RPC. Public traces ask for an API key. |
| Robinhood Chain | 4663 | `https://rpc.mainnet.chain.robinhood.com` | none | Needs own RPC. Trace and debug methods are not on the public endpoint. |
| X Layer | 196 | `https://rpc.xlayer.tech` | none | Needs own RPC. Official endpoints do not whitelist traces. |
| STRATO | 123354377739506 | `https://noderpc.strato.nexus/rpc` | none | Needs own RPC. EVM JSON-RPC reads work. Trace methods are not found. |
| Soneium | 1868 | `https://rpc.soneium.org` | none | Needs own RPC. Official endpoint does not whitelist traces. |
| HyperEVM | 999 | `https://rpc.hyperliquid.xyz/evm` | none | Needs own RPC. Trace and debug methods are not found. |
| Arc | 5042 | `https://rpc.mainnet.arc.io` | none | Needs own RPC. Mainnet says those methods are not supported. |
| SupraEVM devnet | 535600 | `https://rpc-devnet.supra.com/rpc/v1/eth` | none | Needs own RPC. Devnet only. See unsupported mainnet below. |
| Injective EVM | 1776 | `https://sentry.evm-rpc.injective.network/` | `debug_traceBlockByNumber` | Works free. A 40-block sample at the head had no EVM transactions. |
| Pharos | 1672 | `https://rpc.pharos.xyz` | none | Needs own RPC. Public endpoint hides trace and debug methods. |
| Xphere | 20250217 | `https://rpc.x-phere.com` | none | Needs own RPC. Trace and debug methods are not available. |
| Flare | 14 | `https://flare.drpc.org` | `debug_traceBlockByNumber`, `debug_traceTransaction` | Works free. The official `flare-api` host does not. |
| RISE | 4153 | `https://rpc.risechain.com/` | `debug_traceBlockByNumber` | Works free. Block traces are large. |
| PulseChain | 369 | `https://rpc.pulsechain.com` | `trace_block` | Works free. `trace_filter` and debug methods are missing, so the scanner uses `trace_block`. |
| Katana | 747474 | `https://katana.drpc.org` | `trace_filter` (also trace_block and both debug methods) | Works free |
| Ink | 57073 | `https://rpc-qnd.inkonchain.com` | `debug_traceBlockByNumber`, `debug_traceTransaction` | Works free. `rpc-gel` does not whitelist them. |
| Mezo | 31612 | `https://mezo.drpc.org` | `debug_traceBlockByNumber`, `debug_traceTransaction` | Works free, without `tracerConfig`. Boar's public RPC has no debug methods. |
| Astar | 592 | `https://evm.astar.network` | none | Needs own RPC. |
| Tempo | 4217 | `https://rpc.tempo.xyz` | `trace_filter` (also trace_block and both debug methods) | Works free |
| Stable | 988 | `https://stable-mainnet.rpc.sentio.xyz` | none | Needs own RPC. |
| Kasplex | 202555 | `https://evmrpc.kasplex.org` | `debug_traceBlockByNumber`, `debug_traceTransaction` | Works free |
| Fluent | 25363 | `https://rpc.fluent.xyz/` | `debug_traceBlockByNumber`, `debug_traceTransaction` | Works free. EVM is one of Fluent's runtimes. |
| 0G | 16661 | `https://evmrpc.0g.ai` | none | Needs own RPC. |
| Bitkub Chain | 96 | `https://rpc.bitkubchain.io` | none | Needs own RPC. |
| Anubis | 6714 | `https://rpc.anubispace.org` | none | Needs own RPC. |
| Quai (Cyprus-1) | 9 | `https://rpc.quai.network/cyprus1` | none | Needs own RPC. EVM-compatible reads work. Addresses are zone-scoped. Qi's UTXO side is out of scope. |

### Not in the dropdown

- **Starknet.** Execution is Cairo, not the EVM. There is no `eth_getCode`, no Uniswap V2/V3 bytecode, and no `trace_filter` / `debug_traceTransaction` in the Ethereum sense. A Starknet trace API would be a different product.
- **Supra mainnet.** The production chain is SupraMVM (Move). It does not speak Ethereum JSON-RPC. SupraEVM exists on devnet (chain 535600) and is listed above as a devnet that still needs a trace RPC.
- **Injective inEVM as a separate chain.** The current EVM interface is Injective EVM, chain 1776, listed above. The old inEVM network is not a second chain to scan.
- **Quai's Qi ledger.** Qi is UTXO, not an account-model pool. The Cyprus-1 EVM zone is the entry above.

### Calls actually found

Ran through this app against `https://eth.drpc.org` and `https://arbitrum.drpc.org` on 24 Nov 2026.

**V2 USDC/WETH** `0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc`, Ethereum blocks 26,485,646–26,485,845 (200 blocks), method `trace_filter`. 16 `getReserves` staticcalls from 9 contracts. The top two were 1inch Aggregation Router V6 (`0x111111125421cA6dc452d289314280a0f8842A65`, 3 calls) and Uniswap V2 Router02 (`0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`, 3 calls). One EOA was hidden. The Swap/Sync/Mint/Burn cross-check reported no block where the pool logged an event but the trace had no call to the pool.

**V3 USDC/WETH 0.05%** `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`, Ethereum blocks 26,485,786–26,485,825 (40 blocks), same method. 19 `slot0` staticcalls, 6 contracts kept, 4 EIP-7702 delegated accounts dropped. Event cross-check clean (28 blocks with pool logs, none missing from the trace).

**V3 WETH/USDC 0.05% on Arbitrum** `0xC6962004f452bE9203591991D15f6b388e09E8D0`, blocks 527,153,863–527,153,902 (40 blocks). `trace_filter` is not on the free endpoint, so the scan used `debug_traceBlockByNumber` and still found 8 `slot0` staticcalls from 4 contracts.

On a single Ethereum swap block, `trace_filter` and `trace_block` returned the same 4 calls to the V3 pool (`swap`, `token0`, `token1`, `slot0`). That is why `trace_filter` is the default when the node has it: same calls, far less data. A direct probe also still returned traces at Ethereum blocks 19,000,001, 15,000,000, and 13,000,000, so the free Ethereum endpoint is not limited to the last few minutes, but that is a spot check, not a guarantee.

**PulseX V2 PLSX/WPLS** `0x1b45b9148791d3a104184Cd5DFE5CE57193a3ee9` on PulseChain, blocks 28,140,253–28,140,264. The public RPC has no `trace_filter`, so the app used `trace_block` and found 2 `getReserves` staticcalls from `0xD4E5B052AE95bB6c663bB1cC245C3076c259C694`. Katana's Sushi V3 pools answered `slot0` at the head, and `trace_filter` ran, but the KAT/vbETH and weETH pools had no matching calls in the recent ranges that were tried.

## Configuration

Copy `.env.example` to `.env`. Every variable is optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `47821` | HTTP port |
| `RPC_URL_<chainId>` | per-chain dRPC or PublicNode URL in `src/chains.js` | Overrides the default RPC. Example: `RPC_URL_1=https://eth-mainnet.g.alchemy.com/v2/…` |
| `TRACE_CHUNK_BLOCKS` | `20` (max 50) | `trace_filter` chunk size |
| `TRACE_CONCURRENCY` | `2` (max 6) | Chunks in flight |
| `RPC_TIMEOUT_MS` | `45000` | Per-request timeout |
| `MAX_BLOCKS_CAP` | `2000` | Server-side ceiling |
| `TRACE_PAGE_SIZE` | `400` | `trace_filter` page size |
| `RPC_MAX_BYTES` | `67108864` | Drop a single response larger than this |

The UI never receives the full RPC URL, only the host, so a key in the path is not echoed back.

## API

- `GET /api/meta` — chains, computed selectors, examples.
- `GET /api/head?chainId=&rpcUrl=` — latest block.
- `POST /api/detect` — `{ address, chainId, rpcUrl }`. Chain id may be null.
- `POST /api/scans` — `{ address, chainId, rpcUrl, startBlock, endBlock, maxBlocks, maxTx, functions: ["v2:getReserves", "v3:slot0"] }`. Returns `{ id }`.
- `GET /api/scans/:id/events` — SSE: `meta`, `log`, `progress`, `snapshot`, `done`, `error`.
- `GET /api/scans/:id` — last snapshot.
- `POST /api/scans/:id/cancel`.

`functions` entries are ids from `/api/meta` (`v2:getReserves`, `v3:slot0`, …).

## Limits

- **Off-chain reads are invisible.** A bot that `eth_call`s `slot0()` from its own process never puts that call in a block. Traces only show calls that executed inside a mined transaction.
- **Coverage is the blocks you scanned, on the RPC you asked.** A free public node can prune history, cap a response, or rate-limit mid-scan. Failed blocks are counted and the log says why. The event cross-check catches the specific case "the pool emitted a swap/sync/mint/burn, but this RPC returned no call to the pool." It cannot catch a view-only caller in a block whose trace was silently empty and which also emitted no pool log.
- **Immediate caller only.** If a router calls the pool, the router is the row, not the EOA that sent the transaction. The example tx's `from` is included when `eth_getTransactionByHash` succeeds.
- **EOA filter is best-effort.** A contract created and destroyed inside the same transaction can have empty code at the end of the block, so it is dropped. A lookup that fails is kept and marked unknown.
- **One scan at a time**, with a 2000-block cap, because these methods are heavy and the defaults are shared public endpoints.
- **Not every chain traces for free.** See the table. Paste a node that actually implements one of the three methods.
- **Reverted and successful calls both count.** The call happened.
- **The same 4-byte selector on V2 and V3** (`token0`, `token1`, `factory`) cannot be told apart. The row lists both names when both are selected.

## Layout

```
src/server.js     Express API and SSE
src/scan.js       method probe, chunks, retries, code filter, log cross-check
src/traces.js     parity traces, callTracer walk, dedupe
src/abi.js        V2/V3 fragments and selectors
src/detect.js     chain probe, slot0 vs getReserves
src/chains.js     default RPCs and the capability notes above
public/           the form, table, and CSV/JSON export
```
