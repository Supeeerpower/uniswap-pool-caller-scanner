import { getAddress } from "ethers";

export function normalizeAddress(input) {
  const s = String(input || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new Error("Expected a 0x-prefixed 20-byte address.");
  }
  return getAddress(s.toLowerCase());
}

export function normalizeRpcUrl(input) {
  if (input == null || String(input).trim() === "") return null;
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error("RPC URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RPC URL must start with http:// or https://.");
  }
  return url.toString();
}

export function hexQty(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return Number.parseInt(s, 16);
    if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  }
  return null;
}

export function toHex(n) {
  return `0x${Number(n).toString(16)}`;
}

export function decodeAddressWord(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.replace(/^0x/, "");
  if (h.length < 64) return null;
  const addr = `0x${h.slice(24, 64)}`;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
  try {
    return getAddress(addr);
  } catch {
    return null;
  }
}

export function decodeUint(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.replace(/^0x/, "").slice(0, 64);
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  return Number.parseInt(h, 16);
}

export function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length < 128 || h.length % 2 !== 0) return null;
  const offset = Number.parseInt(h.slice(0, 64), 16);
  if (!Number.isFinite(offset) || offset < 0 || offset * 2 + 64 > h.length) return null;
  const len = Number.parseInt(h.slice(offset * 2, offset * 2 + 64), 16);
  if (!Number.isFinite(len) || len < 0 || len > 128) return null;
  const start = offset * 2 + 64;
  const data = h.slice(start, start + len * 2);
  if (data.length !== len * 2) return null;
  const text = Buffer.from(data, "hex").toString("utf8");
  if (!/^[\x20-\x7e]+$/.test(text)) return null;
  return text;
}

export function decodeMaybeString(hex) {
  const asString = decodeAbiString(hex);
  if (asString) return asString;
  const h = String(hex || "").replace(/^0x/, "");
  if (h.length !== 64) return null;
  const buf = Buffer.from(h, "hex");
  const end = buf.indexOf(0);
  const text = buf.slice(0, end === -1 ? buf.length : end).toString("utf8");
  if (!/^[\x20-\x7e]{1,32}$/.test(text)) return null;
  return text;
}

export function codeSize(hex) {
  if (!hex || hex === "0x") return 0;
  const body = String(hex).replace(/^0x/, "");
  if (body.length % 2 !== 0) return 0;
  return body.length / 2;
}

// EIP-7702 delegation designator. These accounts are EOAs with delegated code.
export function isDelegatedEoa(hex) {
  return typeof hex === "string" && hex.toLowerCase().startsWith("0xef0100");
}

export function classifyCode(hex) {
  if (hex == null) return "unknown";
  if (isDelegatedEoa(hex)) return "eoa";
  if (codeSize(hex) === 0) return "eoa";
  return "contract";
}

export function formatFee(fee) {
  if (!Number.isInteger(fee)) return null;
  const text = (fee / 10_000).toFixed(4).replace(/\.?0+$/, "");
  return `${text}%`;
}

export function blockChunks(start, end, size) {
  const step = Math.max(1, size);
  const out = [];
  for (let n = start; n <= end; n += step) {
    out.push([n, Math.min(end, n + step - 1)]);
  }
  return out;
}

export function resolveRange({ startBlock, endBlock, maxBlocks, head, cap }) {
  if (!Number.isInteger(startBlock) || startBlock < 0) {
    throw new Error("Start block must be a non-negative integer.");
  }
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1) {
    throw new Error("Max blocks must be a positive integer.");
  }
  if (maxBlocks > cap) {
    throw new Error(`Max blocks is capped at ${cap} on this server.`);
  }
  if (!Number.isInteger(head) || head < 0) {
    throw new Error("Could not read the chain head.");
  }
  if (startBlock > head) {
    throw new Error(`Start block ${startBlock} is after the chain head (${head}).`);
  }
  let end = head;
  let note = null;
  if (endBlock == null) {
    end = Math.min(head, startBlock + maxBlocks - 1);
  } else {
    if (!Number.isInteger(endBlock) || endBlock < startBlock) {
      throw new Error("End block must be an integer greater than or equal to the start block.");
    }
    if (endBlock > head) {
      note = `End block ${endBlock} is past the head. Scanning through ${head}.`;
      end = head;
    } else {
      end = endBlock;
    }
    const span = end - startBlock + 1;
    if (span > maxBlocks) {
      end = startBlock + maxBlocks - 1;
      note = `Range capped at ${maxBlocks} blocks (${startBlock}–${end}).`;
    }
  }
  return { start: startBlock, end, note };
}
