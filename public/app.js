const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  scanId: null,
  source: null,
  pool: null,
  snapshot: null,
  sortKey: "count",
  sortDir: -1,
  busy: false,
};

const num = new Intl.NumberFormat("en-US");

boot().catch((err) => setFormError(err.message));

async function boot() {
  const res = await fetch("/api/meta");
  if (!res.ok) throw new Error("Could not load chain and ABI metadata.");
  state.meta = await res.json();
  renderChains();
  renderFunctions();
  renderExamples();
  $("chain").addEventListener("change", () => {
    toggleCustom();
    showHint();
  });
  $("scan-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) cancelScan();
    else startScan();
  });
  $("detect").addEventListener("click", detect);
  $("recent").addEventListener("click", fillRecent);
  $("fn-v2").addEventListener("click", () => setChecks((fn) => fn.version === "v2" && fn.view));
  $("fn-v3").addEventListener("click", () => setChecks((fn) => fn.version === "v3" && fn.view));
  $("fn-clear").addEventListener("click", () => setChecks(() => false));
  $("csv").addEventListener("click", exportCsv);
  $("json").addEventListener("click", exportJson);
  $("filter").addEventListener("input", renderTable);
  document.querySelectorAll("th button[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else {
        state.sortKey = key;
        state.sortDir = key === "caller" || key === "functionName" ? 1 : -1;
      }
      renderTable();
    });
  });
  toggleCustom();
  showHint();
  const defaults = new Set(["v2:getReserves", "v3:slot0"]);
  setChecks((fn) => defaults.has(fn.id));
  initFactory();
}

function renderChains() {
  const select = $("chain");
  select.replaceChildren();
  select.append(option("auto", "Auto-detect chain"));
  const groups = [
    ["Free trace RPC", (chain) => chain.trace === "filter" || chain.trace === "block" || chain.trace === "debug" || chain.trace === "tx"],
    ["Needs a trace-capable RPC", (chain) => chain.trace === "none"],
  ];
  for (const [label, pred] of groups) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const chain of state.meta.chains.filter(pred)) {
      group.append(option(String(chain.chainId), `${chain.name} · ${chain.chainId}`));
    }
    select.append(group);
  }
  select.append(option("custom", "Custom chain ID"));
}

function renderFunctions() {
  const root = $("functions");
  root.replaceChildren();
  for (const version of ["v2", "v3"]) {
    const col = document.createElement("div");
    col.className = "fn-col";
    const title = document.createElement("h3");
    title.textContent = version === "v2" ? "V2 pair" : "V3 pool";
    col.append(title);
    const fns = state.meta.functions.filter((fn) => fn.version === version);
    for (const group of [["view", true], ["state-changing", false]]) {
      const head = document.createElement("div");
      head.className = "subhead";
      head.textContent = group[0];
      col.append(head);
      for (const fn of fns.filter((item) => item.view === group[1])) col.append(fnRow(fn));
    }
    root.append(col);
  }
}

function fnRow(fn) {
  const label = document.createElement("label");
  label.className = "fn";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = fn.id;
  input.dataset.version = fn.version;
  input.dataset.view = fn.view ? "1" : "0";
  const name = document.createElement("b");
  name.textContent = fn.signature;
  const sel = document.createElement("code");
  sel.textContent = fn.selector;
  label.append(input, name, sel);
  return label;
}

function renderExamples() {
  const root = $("examples");
  root.replaceChildren();
  for (const example of state.meta.examples) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = example.label;
    button.title = example.blurb;
    button.addEventListener("click", () => loadExample(example));
    root.append(button);
  }
}

async function loadExample(example) {
  $("chain").value = String(example.chainId);
  toggleCustom();
  showHint();
  $("address").value = example.address;
  $("max-blocks").value = String(example.maxBlocks);
  $("end").value = "";
  $("rpc").value = "";
  setChecks((fn) => example.functions.includes(fn.id));
  setFormError("");
  await fillRecent();
  const headNote = $("detect-out").textContent;
  $("detect-out").textContent = headNote ? `${example.blurb} ${headNote}` : example.blurb;
}

function setChecks(pred) {
  document.querySelectorAll("#functions input").forEach((input) => {
    const fn = state.meta.functions.find((item) => item.id === input.value);
    input.checked = pred(fn);
  });
}

function selectedFunctions() {
  return [...document.querySelectorAll("#functions input:checked")].map((input) => input.value);
}

function chainSelection() {
  const value = $("chain").value;
  if (value === "auto") return { chainId: null };
  if (value === "custom") {
    const chainId = Number($("custom-chain-id").value.trim());
    if (!Number.isInteger(chainId) || chainId < 1) throw new Error("Enter a positive custom chain id.");
    return { chainId };
  }
  return { chainId: Number(value) };
}

function toggleCustom() {
  $("custom-chain-field").hidden = $("chain").value !== "custom";
}

function showHint() {
  const value = $("chain").value;
  const el = $("chain-hint");
  if (value === "auto") {
    el.textContent = "Auto-detect probes the listed chains with eth_getCode, then slot0 and getReserves. Block numbers must belong to the chain it finds.";
    return;
  }
  if (value === "custom") {
    el.textContent = "Custom chains use only the RPC URL above. It needs trace_filter, trace_block, or debug_traceBlockByNumber.";
    return;
  }
  const chain = state.meta.chains.find((item) => item.chainId === Number(value));
  el.textContent = chain ? `${chain.hint} Default host: ${chain.rpcHost}.` : "";
}

function formBody() {
  const address = $("address").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Enter a 0x pool address.");
  const { chainId } = chainSelection();
  const rpc = $("rpc").value.trim();
  if (chainId == null && $("chain").value === "custom") throw new Error("Enter a custom chain id.");
  if ($("chain").value === "custom" && !rpc) throw new Error("A custom chain needs an RPC URL.");
  const startBlock = readInt($("start").value, "Start block");
  const endRaw = $("end").value.trim();
  const endBlock = endRaw ? readInt(endRaw, "End block") : null;
  const maxBlocks = readInt($("max-blocks").value || "20", "Max blocks");
  const maxRaw = $("max-tx").value.trim();
  const maxTx = maxRaw ? readInt(maxRaw, "Max transactions") : null;
  const functions = selectedFunctions();
  if (functions.length === 0) throw new Error("Pick at least one function.");
  return { address, chainId, rpcUrl: rpc || null, startBlock, endBlock, maxBlocks, maxTx, functions };
}

function readInt(value, name) {
  if (!/^\d+$/.test(String(value).trim())) throw new Error(`${name} must be a non-negative integer.`);
  return Number(String(value).trim());
}

async function detect() {
  setFormError("");
  $("detect-out").textContent = "Probing…";
  try {
    const address = $("address").value.trim();
    const { chainId } = chainSelection();
    const rpcUrl = $("rpc").value.trim() || null;
    const res = await fetch("/api/detect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, chainId, rpcUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Detect failed");
    state.pool = data;
    if ($("chain").value === "auto") {
      const known = state.meta.chains.some((chain) => chain.chainId === data.chainId);
      $("chain").value = known ? String(data.chainId) : "custom";
      if (!known) $("custom-chain-id").value = String(data.chainId);
      toggleCustom();
      showHint();
    }
    const pair = [data.symbol0, data.symbol1].filter(Boolean).join(" / ") || "tokens unknown";
    const version = data.version === "v3" ? "V3" : data.version === "v2" ? "V2" : data.version === "both" ? "V2 and V3 methods both answered" : "unrecognized ABI";
    const fee = data.feeLabel ? ` · fee ${data.feeLabel}` : "";
    const also = data.alsoFound?.length ? ` Code also on ${data.alsoFound.join(", ")}.` : "";
    $("detect-out").textContent = `${data.chainName} · ${version} · ${pair}${fee} · ${num.format(data.codeBytes)} bytes of code · ${data.rpcHost}.${also}`;
  } catch (err) {
    $("detect-out").textContent = "";
    setFormError(err.message);
  }
}

async function fillRecent() {
  setFormError("");
  try {
    const { chainId } = chainSelection();
    if (chainId == null) throw new Error("Pick a chain before filling the latest blocks.");
    const params = new URLSearchParams({ chainId: String(chainId) });
    if ($("rpc").value.trim()) params.set("rpcUrl", $("rpc").value.trim());
    const res = await fetch(`/api/head?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not read the chain head");
    const maxBlocks = readInt($("max-blocks").value || "20", "Max blocks");
    $("start").value = String(Math.max(0, data.block - maxBlocks + 1));
    $("end").value = "";
    $("detect-out").textContent = `${data.rpcHost} head is ${num.format(data.block)}. Start set to ${num.format(Number($("start").value))}.`;
  } catch (err) {
    setFormError(err.message);
  }
}

async function startScan() {
  setFormError("");
  let body;
  try {
    body = formBody();
  } catch (err) {
    setFormError(err.message);
    return;
  }
  setBusy(true);
  clearOutput();
  $("progress-wrap").hidden = false;
  $("log").hidden = false;
  $("empty").hidden = true;
  appendLog({ level: "info", message: "Starting scan…" });
  try {
    const res = await fetch("/api/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not start the scan");
    state.scanId = data.id;
    const source = new EventSource(`/api/scans/${data.id}/events`);
    state.source = source;
    source.addEventListener("meta", (event) => {
      state.pool = JSON.parse(event.data);
      renderSummary();
    });
    source.addEventListener("logHistory", (event) => {
      $("log").replaceChildren();
      for (const line of JSON.parse(event.data)) appendLog(line);
    });
    source.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
    source.addEventListener("progress", (event) => renderProgress(JSON.parse(event.data)));
    source.addEventListener("snapshot", (event) => {
      state.snapshot = JSON.parse(event.data);
      renderSummary();
      renderTable();
    });
    source.addEventListener("done", (event) => finish(JSON.parse(event.data), null));
    source.addEventListener("error", (event) => {
      if (!event.data) return;
      try {
        finish(null, JSON.parse(event.data).message);
      } catch {
        finish(null, "The scan connection dropped.");
      }
    });
  } catch (err) {
    finish(null, err.message);
  }
}

async function cancelScan() {
  if (!state.scanId) return;
  $("go").disabled = true;
  await fetch(`/api/scans/${state.scanId}/cancel`, { method: "POST" });
}

function finish(stats, error) {
  if (!state.busy && !state.source) return;
  state.source?.close();
  state.source = null;
  state.scanId = null;
  setBusy(false);
  if (stats) {
    state.snapshot = state.snapshot || { rows: [], excluded: [], stats };
    state.snapshot.stats = { ...state.snapshot.stats, ...stats };
    renderSummary();
    renderTable();
    renderProgress({
      blocksDone: stats.blocksDone,
      blocksTotal: stats.blocksTotal,
      method: stats.method,
      matchedCalls: stats.matchedCalls,
      callers: stats.contractRows,
      phase: stats.cancelled ? "cancelled" : "done",
    });
  }
  if (error) setFormError(error);
  const hasTable = Boolean(state.snapshot);
  $("csv").disabled = !hasTable;
  $("json").disabled = !hasTable;
}

function setBusy(busy) {
  state.busy = busy;
  $("go").textContent = busy ? "Cancel" : "Scan";
  $("go").disabled = false;
  for (const id of ["detect", "recent", "csv", "json"]) $(id).disabled = busy || (id !== "detect" && id !== "recent" && !state.snapshot);
  if (!busy && state.snapshot) {
    $("csv").disabled = false;
    $("json").disabled = false;
  }
}

function clearOutput() {
  state.snapshot = null;
  state.pool = state.pool && state.pool.pool ? state.pool : null;
  $("rows").replaceChildren();
  $("warnings").replaceChildren();
  $("log").replaceChildren();
  $("count-line").textContent = "";
  $("excluded-wrap").hidden = true;
  $("bar").style.width = "0%";
  $("empty").hidden = false;
  $("empty").textContent = "Scanning…";
  renderSummary();
}

function renderSummary() {
  const pool = state.pool;
  const stats = state.snapshot?.stats;
  if (!pool && !stats) {
    $("summary").textContent = "No scan yet. Load an example or fill the form.";
    return;
  }
  const bits = [];
  if (pool?.chainName) bits.push(pool.chainName);
  if (pool?.symbol0 || pool?.symbol1) bits.push([pool.symbol0, pool.symbol1].filter(Boolean).join(" / "));
  if (pool?.version === "v2" || pool?.version === "v3") bits.push(pool.version.toUpperCase());
  if (pool?.feeLabel) bits.push(`fee ${pool.feeLabel}`);
  if (stats?.method) bits.push(stats.method);
  if (stats?.rpcHost) bits.push(stats.rpcHost);
  if (stats?.start != null) bits.push(`blocks ${num.format(stats.start)}–${num.format(stats.end)}`);
  $("summary").textContent = bits.join(" · ") || "Scan in progress.";
  const warnings = stats?.warnings || [];
  const box = $("warnings");
  box.replaceChildren();
  if (warnings.length) {
    const list = document.createElement("div");
    list.className = "warn-list";
    for (const warning of warnings) {
      const p = document.createElement("p");
      p.textContent = warning;
      list.append(p);
    }
    box.append(list);
  }
}

function renderProgress(progress) {
  $("progress-wrap").hidden = false;
  const total = progress.blocksTotal || 0;
  const done = progress.blocksDone || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $("bar").style.width = `${pct}%`;
  const phase = progress.phase === "cancelled" ? "Cancelled" : progress.phase === "done" ? "Finished" : "Scanning";
  const txs = progress.txsTotal
    ? ` · ${num.format(progress.txsDone || 0)} / ${num.format(progress.txsTotal)} event txs`
    : "";
  $("progress-text").textContent = `${phase} · ${num.format(done)} / ${num.format(total)} blocks${txs} · ${progress.method || "choosing a trace method"} · ${num.format(progress.callers || 0)} contracts · ${num.format(progress.matchedCalls || 0)} matching calls`;
}

function appendLog(line) {
  const row = document.createElement("div");
  row.className = line.level === "warn" ? "warn" : "";
  row.textContent = line.message;
  $("log").append(row);
  $("log").scrollTop = $("log").scrollHeight;
}

function renderTable() {
  const snapshot = state.snapshot;
  const body = $("rows");
  body.replaceChildren();
  if (!snapshot) return;
  const filter = $("filter").value.trim().toLowerCase();
  const rows = [...snapshot.rows].filter((row) => {
    if (!filter) return true;
    return [row.caller, row.label, row.functionName, row.signature, row.selector, row.exampleTx]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(filter));
  });
  rows.sort((a, b) => compare(a, b, state.sortKey) * state.sortDir);
  const explorer = snapshot.stats?.explorer || state.pool?.explorer || null;
  for (const row of rows) body.append(renderRow(row, explorer));
  const excluded = snapshot.excluded || [];
  $("count-line").textContent = `${num.format(rows.length)} shown · ${num.format(snapshot.stats?.matchedCalls || 0)} matching calls · ${num.format(snapshot.stats?.excludedEoas || excluded.length)} EOAs hidden`;
  $("empty").hidden = rows.length > 0;
  if (rows.length === 0) {
    $("empty").textContent = snapshot.rows.length
      ? "Nothing matches that filter."
      : "No contract callers matched these functions in the scanned blocks.";
  }
  const wrap = $("excluded-wrap");
  wrap.hidden = excluded.length === 0;
  $("excluded-summary").textContent = `${num.format(excluded.length)} EOA caller${excluded.length === 1 ? "" : "s"} hidden`;
  const list = $("excluded");
  list.replaceChildren();
  for (const item of excluded) {
    const li = document.createElement("li");
    li.textContent = `${item.caller} · ${item.functionName} · ${item.count} · ${item.reason}`;
    list.append(li);
  }
}

function renderRow(row, explorer) {
  const tr = document.createElement("tr");
  tr.append(callerCell(row, explorer));
  const fn = document.createElement("td");
  fn.className = "fn-cell";
  const name = document.createElement("div");
  name.textContent = row.functionName;
  const sub = document.createElement("small");
  sub.textContent = `${row.callTypes.join(", ")} · ${row.selector}`;
  fn.append(name, sub);
  const count = document.createElement("td");
  count.textContent = num.format(row.count);
  const first = document.createElement("td");
  first.textContent = num.format(row.firstBlock);
  const last = document.createElement("td");
  last.textContent = num.format(row.lastBlock);
  tr.append(fn, count, first, last, txCell(row, explorer));
  return tr;
}

function callerCell(row, explorer) {
  const td = document.createElement("td");
  const who = document.createElement("div");
  who.className = "who";
  if (row.label) {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = row.label;
    who.append(label);
  }
  const line = document.createElement("div");
  const link = addressLink(explorer, row.caller);
  line.append(link);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    navigator.clipboard?.writeText(row.caller).catch(() => {});
  });
  line.append(copy);
  who.append(line);
  if (row.callerKind === "unknown") {
    const note = document.createElement("small");
    note.textContent = row.codeNote || "code check failed";
    who.append(note);
  } else if (row.codeNote) {
    const note = document.createElement("small");
    note.textContent = row.codeNote;
    who.append(note);
  }
  td.append(who);
  return td;
}

function txCell(row, explorer) {
  const td = document.createElement("td");
  td.className = "tx";
  if (!row.exampleTx) {
    td.textContent = "—";
    return td;
  }
  td.append(explorerLink(explorer, "tx", row.exampleTx, shortHex(row.exampleTx), "addr"));
  if (row.exampleOrigin) {
    const small = document.createElement("small");
    small.textContent = `from ${shortHex(row.exampleOrigin)}`;
    td.append(small);
  }
  return td;
}

function explorerHref(explorer, kind, value) {
  if (!explorer || !value) return null;
  const base = String(explorer).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return null;
  if (kind === "tx") return /^0x[0-9a-fA-F]{64}$/.test(value) ? `${base}/tx/${value}` : null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return `${base}/address/${value}`;
}

function explorerLink(explorer, kind, value, label, className) {
  const href = explorerHref(explorer, kind, value);
  const node = document.createElement(href ? "a" : "span");
  if (href) {
    node.href = href;
    node.target = "_blank";
    node.rel = "noreferrer";
  }
  if (className) node.className = className;
  node.textContent = label || "";
  if (value) node.title = value;
  return node;
}

function addressLink(explorer, address) {
  return explorerLink(explorer, "address", address, shortHex(address), "addr");
}

function shortHex(value) {
  if (!value || value.length < 14) return value || "";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function compare(a, b, key) {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av || "").localeCompare(String(bv || ""));
}

function exportCsv() {
  if (!state.snapshot) return;
  const header = ["caller", "label", "function", "signature", "selector", "callTypes", "count", "firstBlock", "lastBlock", "exampleTx", "exampleOrigin", "callerKind", "codeBytes"];
  const lines = [header.join(",")];
  for (const row of state.snapshot.rows) {
    lines.push([
      row.caller,
      row.label,
      row.functionName,
      row.signature,
      row.selector,
      row.callTypes.join("|"),
      row.count,
      row.firstBlock,
      row.lastBlock,
      row.exampleTx,
      row.exampleOrigin,
      row.callerKind,
      row.codeBytes,
    ].map(csv).join(","));
  }
  download(`\uFEFF${lines.join("\n")}`, "pool-callers.csv", "text/csv");
}

function exportJson() {
  if (!state.snapshot) return;
  download(JSON.stringify({ pool: state.pool, ...state.snapshot }, null, 2), "pool-callers.json", "application/json");
}

function csv(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function download(contents, name, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function setFormError(message) {
  const el = $("form-error");
  el.hidden = !message;
  el.textContent = message || "";
}

function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

const factoryState = {
  id: null,
  chainId: null,
  explorer: null,
  pools: [],
  scans: [],
  source: null,
  jobId: null,
  activeJobId: null,
  poll: null,
  openScanId: null,
  detail: null,
  checked: new Set(),
  renderTimer: null,
};

function initFactory() {
  const select = $("factory-chain");
  select.replaceChildren();
  for (const group of $("chain").querySelectorAll("optgroup")) {
    select.append(group.cloneNode(true));
  }
  $("tab-pool").addEventListener("click", () => setTab("pool"));
  $("tab-factory").addEventListener("click", () => setTab("factory"));
  $("factory-chain").addEventListener("change", showFactoryHint);
  $("factory-form").addEventListener("submit", (event) => {
    event.preventDefault();
    discoverFactory();
  });
  $("factory-cancel").addEventListener("click", cancelFactoryJob);
  $("scan-selected").addEventListener("click", () => scanPools(false));
  $("scan-all").addEventListener("click", () => scanPools(true));
  $("export-pools").addEventListener("click", exportPools);
  const katana = document.createElement("button");
  katana.type = "button";
  katana.className = "ghost";
  katana.textContent = "Katana V2 factory";
  katana.addEventListener("click", () => {
    $("factory-chain").value = "747474";
    $("factory-address").value = "0x72D111b4d6f31B38919ae39779f570b747d6Acd9";
    $("factory-from").value = "";
    $("factory-to").value = "";
    showFactoryHint();
  });
  $("factory-examples").append(katana);
  showFactoryHint();
  refreshFactories();
}

function setTab(which) {
  $("tab-pool").classList.toggle("on", which === "pool");
  $("tab-factory").classList.toggle("on", which === "factory");
  $("pool-view").hidden = which !== "pool";
  $("factory-view").hidden = which !== "factory";
}

function showFactoryHint() {
  const chain = state.meta.chains.find((item) => item.chainId === Number($("factory-chain").value));
  $("factory-hint").textContent = chain ? chain.hint : "";
}

async function refreshFactories() {
  const box = $("saved-factories");
  try {
    const res = await fetch("/api/factories");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    box.replaceChildren();
    if (!data.factories.length) {
      box.textContent = "No factories saved yet.";
      return;
    }
    for (const factory of data.factories) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = `${factory.chainName} ${shortHex(factory.address)} · ${factory.poolCount} pools${factory.activeJobId ? " · scanning" : ""}`;
      button.addEventListener("click", () => loadFactory(factory.id));
      box.append(button);
    }
    if (!factoryState.id) {
      const live = data.factories.find((factory) => factory.activeJobId);
      if (live) await loadFactory(live.id);
    }
  } catch (err) {
    box.textContent = err.message;
  }
}

async function discoverFactory() {
  setFactoryError("");
  const chainId = Number($("factory-chain").value);
  const address = $("factory-address").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    setFactoryError("Enter a factory address.");
    return;
  }
  const body = {
    address,
    chainId,
    fromBlock: $("factory-from").value.trim() || null,
    toBlock: $("factory-to").value.trim() || null,
  };
  $("discover").disabled = true;
  $("factory-cancel").hidden = false;
  $("factory-log").hidden = false;
  $("factory-log").replaceChildren();
  factoryLog("Discovering pools…");
  try {
    const res = await fetch("/api/factories/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await listenJob(data.id, async (event, payload) => {
      if (event === "progress") factoryLog(progressLine(payload));
      if (event === "done") {
        factoryState.id = payload.factoryId;
        await loadFactory(payload.factoryId);
        await refreshFactories();
      }
      if (event === "error") setFactoryError(payload.message);
    });
  } catch (err) {
    setFactoryError(err.message);
  } finally {
    $("discover").disabled = false;
    $("factory-cancel").hidden = true;
  }
}

async function loadFactory(id) {
  await reloadFactoryData(id);
  ensurePoll();
  maybeFollow(factoryState.activeJobId);
}

async function reloadFactoryData(id = factoryState.id) {
  if (!id) return;
  const res = await fetch(`/api/factories/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  const wrap = document.querySelector("#factory-view .table-wrap");
  const scrollLeft = wrap ? wrap.scrollLeft : 0;
  factoryState.id = id;
  factoryState.pools = data.pools;
  factoryState.scans = data.scans;
  const factory = data.factory;
  factoryState.chainId = factory.chainId;
  factoryState.explorer = factory.explorer || chainExplorer(factory.chainId);
  factoryState.activeJobId = factory.activeJobId || null;
  $("factory-summary").textContent = `${factory.chainName} ${factory.kind} via ${factory.mode} · ${factory.poolCount} pools · ${factory.rpcHost}`;
  $("factory-address").value = factory.address;
  if ([...$("factory-chain").options].some((option) => option.value === String(factory.chainId))) {
    $("factory-chain").value = String(factory.chainId);
  }
  renderPoolTable();
  renderSavedScans();
  $("scan-selected").disabled = false;
  $("scan-all").disabled = false;
  $("export-pools").disabled = false;
  if (wrap) wrap.scrollLeft = scrollLeft;
  if (factoryState.openScanId) refreshOpenDetail();
}

function chainExplorer(chainId) {
  const chain = state.meta?.chains?.find((item) => item.chainId === Number(chainId));
  return chain?.explorer || null;
}

function factoryExplorer() {
  return factoryState.explorer || chainExplorer(factoryState.chainId);
}

function scanForPool(pool) {
  const address = pool.address.toLowerCase();
  return factoryState.scans.find((scan) => scan.address.toLowerCase() === address) || null;
}

function renderPoolTable() {
  const body = $("pool-rows");
  body.replaceChildren();
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const explorer = factoryExplorer();
  for (const pool of factoryState.pools) {
    const scan = scanForPool(pool);
    const tr = document.createElement("tr");
    if (scan?.status === "running") tr.className = "scanning";
    const pick = document.createElement("td");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "pick";
    box.value = pool.address;
    box.checked = factoryState.checked.has(pool.address.toLowerCase());
    box.addEventListener("change", () => {
      const key = pool.address.toLowerCase();
      if (box.checked) factoryState.checked.add(key);
      else factoryState.checked.delete(key);
    });
    pick.append(box);
    tr.append(pick, poolCell(pool, explorer), blockCell(pool.creationBlock), pairCell(pool, explorer), balanceCell(pool), usdCell(pool, usd), statusCell(pool, scan));
    body.append(tr);
    if (scan && factoryState.openScanId === scan.id) body.append(detailRow(pool, scan));
  }
}

function poolCell(pool, explorer) {
  const td = document.createElement("td");
  const pairName = `${pool.symbol0 || "token0"} / ${pool.symbol1 || "token1"}`;
  const name = explorerLink(explorer, "address", pool.address, pairName, "pool-name");
  const addr = explorerLink(explorer, "address", pool.address, shortHex(pool.address), "addr");
  td.append(name, addr);
  return td;
}

function pairCell(pool, explorer) {
  const td = document.createElement("td");
  td.append(
    explorerLink(explorer, "address", pool.token0, pool.symbol0 || shortHex(pool.token0), "token-link"),
    document.createTextNode(" / "),
    explorerLink(explorer, "address", pool.token1, pool.symbol1 || shortHex(pool.token1), "token-link"),
  );
  return td;
}

function blockCell(block) {
  const td = document.createElement("td");
  td.textContent = block == null ? "—" : num.format(block);
  return td;
}

function balanceCell(pool) {
  const td = document.createElement("td");
  td.className = "balances";
  td.textContent = `${pool.reserve0 ?? "—"} / ${pool.reserve1 ?? "—"}`;
  return td;
}

function usdCell(pool, usd) {
  const td = document.createElement("td");
  td.className = "usd";
  td.textContent = pool.usd == null ? "—" : usd.format(pool.usd);
  td.title = [pool.price0Source, pool.price1Source].filter(Boolean).join(", ");
  return td;
}

function statusCell(pool, scan) {
  const td = document.createElement("td");
  td.className = "status-cell";
  const line = document.createElement("div");
  line.className = "status-line";
  const label = statusLabel(scan);
  const pill = document.createElement("span");
  pill.className = `status-pill ${label.kind}`;
  pill.textContent = label.text;
  if (scan?.error) pill.title = scan.error;
  line.append(pill);
  if (scan && canView(scan)) {
    const view = document.createElement("button");
    view.type = "button";
    view.className = "texty";
    const open = factoryState.openScanId === scan.id;
    view.textContent = open ? "Hide" : "View callers";
    view.addEventListener("click", () => toggleCallers(scan));
    line.append(view);
  }
  if (scan && scan.status !== "done" && scan.status !== "queued" && scan.status !== "running") {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "texty";
    resume.textContent = "Resume";
    resume.addEventListener("click", () => resumeScan(scan));
    line.append(resume);
  }
  td.append(line);
  return td;
}

function statusLabel(scan) {
  if (!scan) return { kind: "idle", text: "Not scanned" };
  if (scan.status === "queued") return { kind: "queued", text: "Queued" };
  if (scan.status === "running") {
    const pct = scan.progress?.pct;
    const block = scan.lastScannedBlock;
    const started = Number.isInteger(block) && Number.isInteger(scan.creationBlock) && block >= scan.creationBlock;
    const parts = ["Scanning"];
    if (Number.isInteger(pct)) parts.push(`${pct}%`);
    parts.push(started ? `block ${num.format(block)}` : "starting");
    return { kind: "running", text: parts.join(" · ") };
  }
  if (scan.status === "done") {
    const count = scan.callers || 0;
    return { kind: "done", text: `Done · ${num.format(count)} caller${count === 1 ? "" : "s"}` };
  }
  if (scan.status === "error") return { kind: "error", text: "Error" };
  if (scan.status === "paused") {
    const block = Number.isInteger(scan.lastScannedBlock) ? ` · block ${num.format(scan.lastScannedBlock)}` : "";
    return { kind: "paused", text: `Paused${block}` };
  }
  return { kind: "idle", text: scan.status || "Not scanned" };
}

function canView(scan) {
  if (!scan) return false;
  if (scan.status === "done" || scan.status === "paused" || scan.status === "error") return true;
  return scan.status === "running" && (scan.callers || 0) > 0;
}

function detailRow(pool, scan) {
  const tr = document.createElement("tr");
  tr.className = "pool-detail";
  const td = document.createElement("td");
  td.colSpan = 7;
  const panel = document.createElement("div");
  panel.className = "caller-panel";
  const title = document.createElement("h3");
  const fn = String(scan.functionId || "").split(":").pop() || "call";
  const pair = `${pool.symbol0 || "token0"} / ${pool.symbol1 || "token1"}`;
  title.textContent = `${pair} · ${fn}`;
  panel.append(title);
  const detail = factoryState.detail;
  if (!detail || detail.id !== scan.id || detail.loading) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Loading callers from the saved scan…";
    panel.append(note);
  } else if (detail.error) {
    const note = document.createElement("p");
    note.className = "error";
    note.textContent = detail.error;
    panel.append(note);
  } else if (!detail.rows?.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "No contract callers saved for this pool yet.";
    panel.append(note);
  } else {
    panel.append(callerTable(detail.rows, factoryExplorer()));
  }
  td.append(panel);
  tr.append(td);
  return tr;
}

function callerTable(rows, explorer) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "data detail-table";
  const head = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const label of ["Caller", "Function", "Calls", "First block", "Last block", "Example tx"]) {
    const th = document.createElement("th");
    th.textContent = label;
    hr.append(th);
  }
  head.append(hr);
  const body = document.createElement("tbody");
  for (const row of rows) body.append(renderRow(row, explorer));
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

async function toggleCallers(scan) {
  if (factoryState.openScanId === scan.id) {
    factoryState.openScanId = null;
    factoryState.detail = null;
    renderPoolTable();
    return;
  }
  factoryState.openScanId = scan.id;
  factoryState.detail = { id: scan.id, rows: null, loading: true };
  renderPoolTable();
  await refreshOpenDetail();
}

async function refreshOpenDetail() {
  const id = factoryState.openScanId;
  if (!id) return;
  try {
    const res = await fetch(`/api/saved-scans/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (factoryState.openScanId !== id) return;
    if (!res.ok) throw new Error(data.error);
    factoryState.detail = { id, rows: data.rows || [], loading: false };
    renderPoolTable();
  } catch (err) {
    if (factoryState.openScanId !== id) return;
    factoryState.detail = { id, rows: [], loading: false, error: err.message };
    renderPoolTable();
  }
}

function renderSavedScans() {
  const box = $("saved-scans");
  box.replaceChildren();
  if (!factoryState.scans.length) {
    box.textContent = "None yet.";
    return;
  }
  for (const scan of factoryState.scans) {
    const line = document.createElement("div");
    line.className = "scan-line";
    const label = document.createElement("span");
    const through = scan.lastScannedBlock == null ? "not started" : `through ${num.format(scan.lastScannedBlock)}`;
    label.textContent = `${scan.symbol0 || ""}/${scan.symbol1 || ""} ${shortHex(scan.address)} · ${scan.status} · ${through} · ${scan.callers} callers`;
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "texty";
    resume.textContent = scan.status === "done" ? "Run again" : "Resume";
    resume.addEventListener("click", () => resumeScan(scan));
    line.append(label, resume);
    box.append(line);
  }
}

async function scanPools(all) {
  const addresses = all
    ? []
    : [...document.querySelectorAll("#pool-rows .pick:checked")].map((box) => box.value);
  if (!all && addresses.length === 0) {
    setFactoryError("Select at least one pool, or use Scan all.");
    return;
  }
  setFactoryError("");
  await postFactoryJob(`/api/factories/${encodeURIComponent(factoryState.id)}/scan`, { addresses });
}

async function resumeScan(scan) {
  if (scan.status === "done") {
    await postFactoryJob(`/api/factories/${encodeURIComponent(factoryState.id)}/scan`, { addresses: [scan.address] });
    return;
  }
  await postFactoryJob(`/api/saved-scans/${encodeURIComponent(scan.id)}/resume`, {});
}

async function postFactoryJob(url, body) {
  $("factory-log").hidden = false;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  factoryState.jobId = data.id;
  $("factory-cancel").hidden = false;
  ensurePoll();
  if (factoryState.id) await reloadFactoryData();
  try {
    await listenJob(data.id, handleFactoryEvent);
  } finally {
    if (factoryState.jobId === data.id) factoryState.jobId = null;
    $("factory-cancel").hidden = true;
    if (factoryState.id) await reloadFactoryData();
  }
}

function maybeFollow(jobId) {
  if (!jobId || factoryState.source || factoryState.jobId === jobId) return;
  factoryState.jobId = jobId;
  $("factory-cancel").hidden = false;
  ensurePoll();
  listenJob(jobId, handleFactoryEvent).finally(async () => {
    const ended = factoryState.jobId === jobId;
    if (ended) factoryState.jobId = null;
    $("factory-cancel").hidden = Boolean(factoryState.jobId);
    if (factoryState.id) await reloadFactoryData().catch((err) => setFactoryError(err.message));
    if (!ended || factoryState.activeJobId !== jobId || factoryState.source) return;
    const check = await fetch(`/api/scans/${encodeURIComponent(jobId)}`).catch(() => null);
    if (check?.ok) maybeFollow(jobId);
  });
}

function ensurePoll() {
  const live = () => factoryState.activeJobId || factoryState.jobId || factoryState.scans.some((scan) => scan.status === "queued" || scan.status === "running");
  if (factoryState.poll) return;
  if (!live()) return;
  factoryState.poll = setInterval(async () => {
    if (!live()) {
      clearInterval(factoryState.poll);
      factoryState.poll = null;
      return;
    }
    if (!factoryState.id) return;
    try {
      await reloadFactoryData();
      if (factoryState.activeJobId && !factoryState.source) maybeFollow(factoryState.activeJobId);
    } catch (err) {
      setFactoryError(err.message);
    }
  }, 2000);
}

async function handleFactoryEvent(event, payload) {
  if (event === "log") factoryLog(payload.message);
  if (event === "progress" || event === "checkpoint") applyLiveProgress(payload);
  if (event === "poolDone") {
    if (payload?.scanId && payload.rows && factoryState.openScanId === payload.scanId) {
      factoryState.detail = { id: payload.scanId, rows: payload.rows, loading: false };
    }
    if (factoryState.id) await reloadFactoryData();
  }
  if (event === "done" && factoryState.id) await reloadFactoryData();
  if (event === "error") setFactoryError(payload.message || payload.error || "Scan failed");
}

function applyLiveProgress(payload) {
  const address = String(payload?.address || "").toLowerCase();
  if (!address) return;
  const scan = factoryState.scans.find((item) => item.address.toLowerCase() === address);
  if (!scan) return;
  if (payload.status === "done" || payload.status === "error" || payload.status === "paused" || payload.status === "running") {
    scan.status = payload.status === "running" ? "running" : payload.status;
  } else {
    scan.status = "running";
  }
  if (Number.isInteger(payload.lastBlock) || Number.isInteger(payload.lastScannedBlock)) {
    scan.lastScannedBlock = payload.lastScannedBlock ?? payload.lastBlock;
  }
  if (Number.isInteger(payload.targetEnd)) scan.targetEnd = payload.targetEnd;
  if (payload.callers != null) scan.callers = payload.callers;
  else if (payload.rows != null && !Array.isArray(payload.rows)) scan.callers = payload.rows;
  if (payload.matchedCalls != null) scan.matchedCalls = payload.matchedCalls;
  if (payload.error) scan.error = payload.error;
  scan.progress = progressFromScan(scan);
  schedulePoolRender();
}

function progressFromScan(scan) {
  const start = scan.creationBlock;
  const end = scan.targetEnd;
  const last = scan.lastScannedBlock;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    return { pct: null, block: Number.isInteger(last) ? last : null };
  }
  const span = end - start + 1;
  const done = Number.isInteger(last) ? Math.max(0, Math.min(span, last - start + 1)) : 0;
  return { pct: Math.round((done / span) * 100), block: Number.isInteger(last) ? last : null, done, span };
}

function schedulePoolRender() {
  if (factoryState.renderTimer) return;
  factoryState.renderTimer = setTimeout(() => {
    factoryState.renderTimer = null;
    const wrap = document.querySelector("#factory-view .table-wrap");
    const scrollLeft = wrap ? wrap.scrollLeft : 0;
    renderPoolTable();
    if (wrap) wrap.scrollLeft = scrollLeft;
  }, 250);
}

async function exportPools() {
  const res = await fetch(`/api/factories/${encodeURIComponent(factoryState.id)}/export`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  download(JSON.stringify(data, null, 2), "pools.json", "application/json");
}

async function listenJob(id, onEvent) {
  await new Promise((resolve, reject) => {
    const source = new EventSource(`/api/scans/${id}/events`);
    factoryState.source = source;
    const finish = () => {
      source.close();
      factoryState.source = null;
      resolve();
    };
    for (const name of ["progress", "log", "poolDone", "done", "error", "snapshot"]) {
      source.addEventListener(name, (event) => {
        let payload = null;
        try { payload = JSON.parse(event.data); } catch { payload = {}; }
        Promise.resolve(onEvent(name, payload)).catch((err) => setFactoryError(err.message));
        if (name === "done" || name === "error") finish();
      });
    }
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) finish();
    });
  });
}

async function cancelFactoryJob() {
  if (!factoryState.jobId) return;
  await fetch(`/api/scans/${factoryState.jobId}/cancel`, { method: "POST" });
}

function factoryLog(message) {
  if (!message) return;
  const line = document.createElement("div");
  line.textContent = message;
  $("factory-log").append(line);
  $("factory-log").scrollTop = $("factory-log").scrollHeight;
}

function progressLine(progress) {
  if (progress.phase === "enumerate") return `Reading pairs ${progress.done || 0} / ${progress.total || "?"}`;
  if (progress.phase === "creation") return `Creation blocks ${progress.done || 0} / ${progress.total || "?"}`;
  if (progress.phase === "metadata") return `Token metadata ${progress.done || 0} / ${progress.total || "?"}`;
  if (progress.phase === "logs") return `Logs through ${progress.lastBlock} · ${progress.found || 0} pools`;
  return JSON.stringify(progress);
}

function setFactoryError(message) {
  const el = $("factory-error");
  el.hidden = !message;
  el.textContent = message || "";
}
