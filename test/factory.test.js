import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import { parseFactoryLog } from "../src/factory.js";
import { amountUsd, isStableSymbol } from "../src/prices.js";

test("factory logs decode pool addresses and creation blocks", () => {
  const pair = "0x773e663753c4a021f9e328a7227a802baec1ac90";
  const v2 = parseFactoryLog({
    topics: [
      id("PairCreated(address,address,address,uint256)"),
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
    ],
    data: `0x${pair.slice(2).padStart(64, "0")}${"3".padStart(64, "0")}`,
    blockNumber: "0x10",
  });
  assert.equal(v2.kind, "v2");
  assert.equal(v2.pool, pair);
  assert.equal(v2.creationBlock, 16);
  assert.equal(v2.token0, `0x${"11".repeat(20)}`);

  const pool = "0xb49d3e76d953c72ea2872893048597108f68db2b";
  const v3 = parseFactoryLog({
    topics: [
      id("PoolCreated(address,address,uint24,int24,address)"),
      `0x${"ab".repeat(32)}`,
      `0x${"cd".repeat(32)}`,
      `0x${(500).toString(16).padStart(64, "0")}`,
    ],
    data: `0x${(60).toString(16).padStart(64, "0")}${pool.slice(2).padStart(64, "0")}`,
    blockNumber: 99,
  });
  assert.equal(v3.kind, "v3");
  assert.equal(v3.pool, pool);
  assert.equal(v3.fee, 500);
  assert.equal(v3.tickSpacing, 60);
});

test("usd value respects decimals and the stablecoin fallback", () => {
  assert.equal(amountUsd("1000000", 6, 1), 1);
  assert.equal(amountUsd("1500000000000000000", 18, 2000), 3000);
  assert.equal(isStableSymbol("USDC.e"), true);
  assert.equal(amountUsd(null, 18, 1), null);
});
