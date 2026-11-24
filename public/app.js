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
  const href = explorer && /^0x[0-9a-fA-F]{64}$/.test(row.exampleTx) ? `${explorer}/tx/${row.exampleTx}` : null;
  const link = document.createElement(href ? "a" : "span");
  if (href) {
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer";
  }
  link.className = "addr";
  link.textContent = shortHex(row.exampleTx);
  td.append(link);
  if (row.exampleOrigin) {
    const small = document.createElement("small");
    small.textContent = `from ${shortHex(row.exampleOrigin)}`;
    td.append(small);
  }
  return td;
}

function addressLink(explorer, address) {
  const href = explorer && /^0x[0-9a-fA-F]{40}$/.test(address) ? `${explorer}/address/${address}` : null;
  const node = document.createElement(href ? "a" : "span");
  if (href) {
    node.href = href;
    node.target = "_blank";
    node.rel = "noreferrer";
  }
  node.className = "addr";
  node.textContent = shortHex(address);
  node.title = address;
  return node;
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
