import { Interface } from "ethers";

// Selectors depend only on the name and the input types. Return types are kept
// so the human-readable fragment still parses.
const V2 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function PERMIT_TYPEHASH() view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
  "function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "function MINIMUM_LIQUIDITY() view returns (uint256)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function price0CumulativeLast() view returns (uint256)",
  "function price1CumulativeLast() view returns (uint256)",
  "function kLast() view returns (uint256)",
  "function mint(address) returns (uint256)",
  "function burn(address) returns (uint256,uint256)",
  "function swap(uint256,uint256,address,bytes)",
  "function skim(address)",
  "function sync()",
  "function initialize(address,address)",
];

const V3 = [
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function maxLiquidityPerTick() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  "function protocolFees() view returns (uint128,uint128)",
  "function liquidity() view returns (uint128)",
  "function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
  "function tickBitmap(int16) view returns (uint256)",
  "function positions(bytes32) view returns (uint128,uint256,uint256,uint128,uint128)",
  "function observations(uint256) view returns (uint32,int56,uint160,bool)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
  "function snapshotCumulativesInside(int24,int24) view returns (int56,uint160,uint32)",
  "function increaseObservationCardinalityNext(uint16)",
  "function initialize(uint160)",
  "function mint(address,int24,int24,uint128,bytes) returns (uint256,uint256)",
  "function collect(address,int24,int24,uint128,uint128) returns (uint128,uint128)",
  "function burn(int24,int24,uint128) returns (uint256,uint256)",
  "function swap(address,bool,int256,uint160,bytes) returns (int256,int256)",
  "function flash(address,uint256,uint256,bytes)",
  "function setFeeProtocol(uint8,uint8)",
  "function collectProtocol(address,uint128,uint128) returns (uint128,uint128)",
];

const HEADLINE = [
  "slot0",
  "getReserves",
  "observe",
  "liquidity",
  "ticks",
  "tickBitmap",
  "snapshotCumulativesInside",
  "token0",
  "token1",
  "fee",
  "price0CumulativeLast",
  "price1CumulativeLast",
  "kLast",
  "protocolFees",
  "feeGrowthGlobal0X128",
  "feeGrowthGlobal1X128",
];

function build(version, signatures) {
  const iface = new Interface(signatures);
  return signatures.map((sig) => {
    const name = sig.match(/function\s+(\w+)/)[1];
    const frag = iface.getFunction(name);
    const mutability = frag.stateMutability;
    return {
      id: `${version}:${frag.name}`,
      version,
      name: frag.name,
      signature: frag.format("sighash"),
      selector: frag.selector.toLowerCase(),
      mutability,
      view: mutability === "view" || mutability === "pure",
    };
  });
}

let cached;

export function functionCatalog() {
  if (!cached) {
    const all = [...build("v2", V2), ...build("v3", V3)];
    all.sort((a, b) => {
      if (a.version !== b.version) return a.version < b.version ? -1 : 1;
      if (a.view !== b.view) return a.view ? -1 : 1;
      const ah = HEADLINE.indexOf(a.name);
      const bh = HEADLINE.indexOf(b.name);
      if (ah !== -1 || bh !== -1) {
        if (ah === -1) return 1;
        if (bh === -1) return -1;
        return ah - bh;
      }
      return a.name.localeCompare(b.name);
    });
    cached = all;
  }
  return cached;
}

export function functionsById(ids) {
  const wanted = new Set(ids);
  const found = functionCatalog().filter((fn) => wanted.has(fn.id));
  if (found.length !== wanted.size) {
    const known = new Set(found.map((fn) => fn.id));
    const missing = [...wanted].filter((id) => !known.has(id));
    throw new Error(`Unknown function id: ${missing.join(", ")}`);
  }
  return found;
}

export function selectorMap(functions) {
  const map = new Map();
  for (const fn of functions) {
    const prev = map.get(fn.selector);
    if (!prev) {
      map.set(fn.selector, {
        selector: fn.selector,
        names: [fn.name],
        signatures: [fn.signature],
        versions: [fn.version],
      });
    } else {
      if (!prev.names.includes(fn.name)) prev.names.push(fn.name);
      if (!prev.signatures.includes(fn.signature)) prev.signatures.push(fn.signature);
      if (!prev.versions.includes(fn.version)) prev.versions.push(fn.version);
    }
  }
  return map;
}

export function selectorOf(version, name) {
  const fn = functionCatalog().find((item) => item.version === version && item.name === name);
  if (!fn) throw new Error(`No ${version} function ${name}`);
  return fn.selector;
}
