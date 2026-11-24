function positive(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export const config = {
  port: positive("PORT", 47821),
  chunkBlocks: Math.min(50, positive("TRACE_CHUNK_BLOCKS", 20)),
  concurrency: Math.min(6, positive("TRACE_CONCURRENCY", 2)),
  timeoutMs: positive("RPC_TIMEOUT_MS", 45_000),
  maxBlocksCap: Math.min(10_000, positive("MAX_BLOCKS_CAP", 2000)),
  pageSize: Math.min(2000, positive("TRACE_PAGE_SIZE", 400)),
  maxResponseBytes: positive("RPC_MAX_BYTES", 64 * 1024 * 1024),
};
