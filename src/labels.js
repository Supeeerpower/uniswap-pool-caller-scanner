// Public, well-known addresses. Same CREATE2 address on many chains where noted.
// Unknown callers stay unlabeled rather than guessed.
const LABELS = {
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router02",
  "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 SwapRouter",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 SwapRouter02",
  "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap V3 SwapRouter02 (Base)",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router",
  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af": "Uniswap Universal Router 2",
  "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b": "Uniswap Universal Router (legacy)",
  "0xb27308f9f90d607463bb33ea1bebb41c27ce5ab6": "Uniswap V3 Quoter",
  "0x61ffe014ba17989e743c5f6cb21bf9697530b21e": "Uniswap V3 QuoterV2",
  "0x1111111254fb6c44bac0bed2854e76f90643097d": "1inch Aggregation Router V4",
  "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch Aggregation Router V5",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch Aggregation Router V6",
  "0xdef171fe48cf0115b1d80b88dc8eab59176fee57": "Paraswap Augustus V5",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x Exchange Proxy",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0x51c72848c68a965f66fa7a88855f9f7784502a7f": "Wintermute market maker",
};

export function labelFor(address) {
  if (!address) return null;
  return LABELS[address.toLowerCase()] || null;
}
