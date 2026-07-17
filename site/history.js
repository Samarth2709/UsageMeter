const nativeApi = window.rateLimitAPI || null;
const serverToken = document.querySelector('meta[name="rate-limit-server-token"]')?.content || "";

let rangeDays = 30;
let metric = "tokens"; // Daily chart: tokens | cost
let data = null;

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CLI_COLORS = { claude: "#f4ab5e", codex: "#74c278" };
const MODEL_PALETTE = ["#74c278", "#f4ab5e", "#d7c56f", "#5fa8d3", "#c98bdb", "#e0796a"];
const OTHER_COLOR = "rgba(244,240,231,0.28)";

/* ---------- formatting ---------- */
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
const fmtDollars = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDollars0 = (n) => "$" + Math.round(Number(n) || 0).toLocaleString();
const fmtPerPrompt = (n) => "$" + (Number(n) || 0).toFixed(4);
const fmtPct = (n) => (Number(n) || 0).toFixed(0) + "%";
const fmtDay = (s) => new Date(s + "T00:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

/* ---------- tooltip ---------- */
let tooltipEl = null;
function ensureTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "chart-tooltip hidden";
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}
function showTooltip(html, x, y) {
  const t = ensureTooltip();
  t.innerHTML = html;
  t.classList.remove("hidden");
  const r = t.getBoundingClientRect();
  const pad = 14;
  let left = x + pad, top = y + pad;
  if (left + r.width > window.innerWidth) left = x - r.width - pad;
  if (top + r.height > window.innerHeight) top = y - r.height - pad;
  t.style.left = Math.max(4, left) + "px";
  t.style.top = Math.max(4, top) + "px";
}
function hideTooltip() { if (tooltipEl) tooltipEl.classList.add("hidden"); }
function attachHover(container, selector, getHtml) {
  // Charts re-render into persistent containers (#ov-chart, etc.) on every render.
  // Store the current selector/handler on the element and bind the listeners only
  // once, so repeated renders don't stack duplicate listeners (a slow leak).
  container._hover = { selector, getHtml };
  if (container._hoverBound) return;
  container._hoverBound = true;
  container.addEventListener("mousemove", (e) => {
    const h = container._hover;
    if (!h) return;
    const hit = e.target.closest(h.selector);
    const html = hit ? h.getHtml(hit) : null;
    if (html) showTooltip(html, e.clientX, e.clientY);
    else hideTooltip();
  });
  container.addEventListener("mouseleave", hideTooltip);
}

/* ---------- chart primitives ---------- */
// Stacked day bars. segFn(day) -> [{value, color}] bottom-up. hoverFn(day) -> html.
function dayBars(el, days, segFn, hoverFn) {
  const W = 700, H = 180, pad = 16, base = H - pad, plot = H - pad * 2;
  const max = Math.max(1, ...days.map((d) => segFn(d).reduce((s, x) => s + x.value, 0)));
  const bw = (W - pad * 2) / Math.max(1, days.length);
  const bars = days.map((d, i) => {
    const x = pad + i * bw;
    let y = base;
    return segFn(d).map((seg) => {
      const h = (seg.value / max) * plot;
      y -= h;
      return `<rect x="${(x + 0.7).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 1.4).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${seg.color}"></rect>`;
    }).join("");
  }).join("");
  const hits = days.map((d, i) => `<rect class="bar-hit" data-idx="${i}" x="${(pad + i * bw).toFixed(1)}" y="${pad}" width="${bw.toFixed(1)}" height="${plot}"></rect>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${bars}${hits}</svg>`;
  attachHover(el, ".bar-hit", (hit) => hoverFn(days[+hit.dataset.idx]));
}

function cumulativeLine(el, days) {
  const W = 700, H = 150, pad = 18, base = H - pad, plot = H - pad * 2;
  let cum = 0;
  const pts = days.map((d, i) => { cum += d.dollars; return { i, cum, day: d }; });
  const max = Math.max(1, cum);
  const bw = (W - pad * 2) / Math.max(1, days.length - 1);
  const xy = pts.map((p) => [pad + p.i * bw, base - (p.cum / max) * plot]);
  const line = xy.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${xy.at(-1)[0].toFixed(1)} ${base} L${xy[0][0].toFixed(1)} ${base} Z`;
  const hits = pts.map((p, i) => `<rect class="bar-hit" data-idx="${i}" x="${(pad + (i - 0.5) * bw).toFixed(1)}" y="${pad}" width="${bw.toFixed(1)}" height="${plot}"></rect>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"><path d="${area}" fill="rgba(116,194,120,0.16)"></path><path d="${line}" fill="none" stroke="#74c278" stroke-width="2"></path>${hits}</svg>`;
  attachHover(el, ".bar-hit", (hit) => {
    const p = pts[+hit.dataset.idx];
    return `<div class="tt-date">${fmtDay(p.day.day)}</div><div class="tt-row"><span>Cumulative</span><b>${fmtDollars(p.cum)}</b></div><div class="tt-row"><span>That day</span><span>${fmtDollars(p.day.dollars)}</span></div>`;
  });
}

function hBars(el, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  el.innerHTML = rows.map((r) => `
    <div class="hbar"${r.title ? ` title="${r.title}"` : ""}>
      <span class="hbar-label">${r.label}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${((r.value / max) * 100).toFixed(1)}%;background:${r.color || "var(--accent)"}"></span></span>
      <span class="hbar-val">${r.valueText}</span>
    </div>`).join("");
}

function heatmap(el, days) {
  if (!days.length) { el.innerHTML = ""; return; }
  const max = Math.max(0, ...days.map((d) => d.dollars));
  const level = (c) => (c <= 0 || max <= 0) ? 0 : (c / max <= 0.25 ? 1 : c / max <= 0.5 ? 2 : c / max <= 0.75 ? 3 : 4);
  const first = new Date(days[0].day + "T00:00:00");
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<div class="hm-cell hm-empty"></div>');
  for (let i = 0; i < days.length; i++) cells.push(`<div class="hm-cell hm-l${level(days[i].dollars)}" data-idx="${i}"></div>`);
  el.innerHTML = `<div class="hm-grid">${cells.join("")}</div><div class="hm-legend">Less<span class="hm-cell hm-l0"></span><span class="hm-cell hm-l1"></span><span class="hm-cell hm-l2"></span><span class="hm-cell hm-l3"></span><span class="hm-cell hm-l4"></span>More</div>`;
  attachHover(el, ".hm-cell[data-idx]", (hit) => {
    const d = days[+hit.dataset.idx];
    return `<div class="tt-date">${fmtDay(d.day)}</div><div class="tt-row"><span>Cost</span><b>${fmtDollars(d.dollars)}</b></div><div class="tt-row tt-claude"><span>Claude</span><span>${fmtDollars(d.byCli.claude.dollars)}</span></div><div class="tt-row tt-codex"><span>Codex</span><span>${fmtDollars(d.byCli.codex.dollars)}</span></div><div class="tt-row"><span>Prompts</span><b>${d.tokens.prompts.toLocaleString()}</b></div>`;
  });
}

function card(label, value, sub) {
  return `<div class="card"><span class="card-label">${label}</span><span class="card-value">${value}</span><span class="card-sub">${sub || ""}</span></div>`;
}

/* ---------- per-day hover bodies ---------- */
function dayTokenHover(d) {
  return `<div class="tt-date">${fmtDay(d.day)}</div>
    <div class="tt-row"><span>Total</span><b>${fmtTokens(d.tokens.total)} tok</b></div>
    <div class="tt-row tt-claude"><span>Claude</span><span>${fmtTokens(d.byCli.claude.tokens.total)} · ${fmtDollars(d.byCli.claude.dollars)}</span></div>
    <div class="tt-row tt-codex"><span>Codex</span><span>${fmtTokens(d.byCli.codex.tokens.total)} · ${fmtDollars(d.byCli.codex.dollars)}</span></div>
    <div class="tt-row"><span>Cost</span><b>${fmtDollars(d.dollars)}</b></div>`;
}
function dayCostHover(d) {
  return `<div class="tt-date">${fmtDay(d.day)}</div>
    <div class="tt-row"><span>Cost</span><b>${fmtDollars(d.dollars)}</b></div>
    <div class="tt-row tt-claude"><span>Claude</span><span>${fmtDollars(d.byCli.claude.dollars)}</span></div>
    <div class="tt-row tt-codex"><span>Codex</span><span>${fmtDollars(d.byCli.codex.dollars)}</span></div>
    <div class="tt-row"><span>Prompts</span><b>${d.tokens.prompts.toLocaleString()}</b></div>`;
}

/* ---------- subscription value (live windows) ---------- */
const WINDOW_ORDER = { fiveHour: 0, week: 1 };
const CLI_ORDER = { claude: 0, codex: 1 };
const CLI_LABEL = { claude: "Claude", codex: "Codex" };
const WINDOW_LABEL = { fiveHour: "5H", week: "Week" };

function windowValueText(w) {
  const used = fmtDollars(w.usedDollars) + " used";
  if (w.full) return used + " · full";
  if (w.projectedDollars != null) return used + " · ~" + fmtDollars0(w.projectedDollars) + " full value";
  return used;
}

function renderWindowValues(rows) {
  const el = document.querySelector("#ec-value");
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = `<p class="history-note">Live limit data isn't available yet — open the menu-bar popover to refresh limits, then reopen this window.</p>`;
    return;
  }
  const sorted = [...rows].sort((a, b) =>
    (CLI_ORDER[a.cli] - CLI_ORDER[b.cli]) || (WINDOW_ORDER[a.kind] - WINDOW_ORDER[b.kind]));
  el.innerHTML = sorted.map((w) => {
    const pct = Math.min(100, Math.max(0, w.usedPercent));
    const label = `${CLI_LABEL[w.cli] || w.cli} · ${WINDOW_LABEL[w.kind] || w.label}`;
    return `
    <div class="hbar">
      <span class="hbar-label">${label}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${pct.toFixed(1)}%;background:${CLI_COLORS[w.cli] || "var(--accent)"}"></span></span>
      <span class="hbar-val">${Math.round(w.usedPercent)}%&nbsp;·&nbsp;${windowValueText(w)}</span>
    </div>`;
  }).join("");
}

/* ---------- sections ---------- */
// Daily usage bars — re-rendered on its own when the Tokens/Cost toggle flips.
function renderDaily(d) {
  const r = d.range;
  const useCost = metric === "cost";
  dayBars(
    document.querySelector("#ov-chart"),
    r.days,
    (day) => useCost
      ? [{ value: day.byCli.claude.dollars, color: CLI_COLORS.claude }, { value: day.byCli.codex.dollars, color: CLI_COLORS.codex }]
      : [{ value: day.byCli.claude.tokens.total, color: CLI_COLORS.claude }, { value: day.byCli.codex.tokens.total, color: CLI_COLORS.codex }],
    useCost ? dayCostHover : dayTokenHover
  );
}

function renderModelsSection(d) {
  const r = d.range;
  const colorMap = {};
  r.byModel.slice(0, MODEL_PALETTE.length).forEach((m, i) => { colorMap[`${m.cli}::${m.model}`] = MODEL_PALETTE[i]; });
  const colorFor = (key) => colorMap[key] || OTHER_COLOR;

  // model mix over time (stacked by model, cost)
  const keys = Object.keys(colorMap);
  dayBars(
    document.querySelector("#md-mix"),
    r.days,
    (day) => {
      const segs = keys.map((k) => ({ value: (day.models[k]?.dollars || 0), color: colorFor(k) }));
      let other = 0;
      for (const [k, v] of Object.entries(day.models)) if (!colorMap[k]) other += v.dollars;
      if (other > 0) segs.push({ value: other, color: OTHER_COLOR });
      return segs;
    },
    (day) => {
      const rows = Object.entries(day.models).sort((a, b) => b[1].dollars - a[1].dollars).slice(0, 6)
        .map(([k, v]) => `<div class="tt-row"><span><span class="tt-dot" style="background:${colorFor(k)}"></span>${esc(k.split("::").slice(1).join("::"))}</span><span>${fmtDollars(v.dollars)}</span></div>`).join("");
      return `<div class="tt-date">${fmtDay(day.day)}</div>${rows || "<div class='tt-row'><span>no usage</span></div>"}`;
    }
  );
  const top = r.byModel.slice(0, MODEL_PALETTE.length);
  document.querySelector("#md-mix-legend").innerHTML = top.map((m, i) => `<span class="lg-row"><span class="lg-dot" style="background:${MODEL_PALETTE[i]}"></span>${esc(m.model)}</span>`).join("");

  const tbody = document.querySelector("#md-table tbody");
  tbody.innerHTML = "";
  for (const m of r.byModel) {
    const tr = document.createElement("tr");
    [
      m.model + (m.modelKnown ? "" : " *"), m.cli,
      m.prompts.toLocaleString(),
      fmtTokens(m.tokens.input), fmtTokens(m.tokens.cachedRead),
      fmtTokens(m.tokens.cacheWrite), fmtTokens(m.tokens.output),
      fmtTokens(m.tokens.total), fmtDollars(m.dollars), fmtPerPrompt(m.costPerPrompt)
    ].forEach((t, i) => { const td = document.createElement("td"); if (i >= 2) td.className = "num"; td.textContent = t; tr.appendChild(td); });
    tbody.appendChild(tr);
  }
}

/* ---------- diagnostics ---------- */
function diagnosticsReport(d) {
  const dg = d.diagnostics;
  const r = d.range;
  const lines = [
    "Usage Meter diagnostics",
    `app version: ${d.appVersion || "?"}`,
    `scanned: ${d.computedAt || d.scannedAt || "?"}`,
    `home: ${dg.homeDir}`,
    `env: CLAUDE_CONFIG_DIR=${dg.env.CLAUDE_CONFIG_DIR || "(unset)"}, CODEX_HOME=${dg.env.CODEX_HOME || "(unset)"}`,
    `cache: ${dg.cache.path} (v${dg.cache.version})`,
    "",
    `Claude projects: ${dg.claude.dir}`,
    `  exists=${dg.claude.exists} readable=${dg.claude.readable} files=${dg.claude.files}`,
    "Codex homes:"
  ];
  for (const c of dg.codex) {
    lines.push(`  ${c.root}`);
    lines.push(`    exists=${c.exists} readable=${c.readable} sessionFiles=${c.sessionsFiles}`);
  }
  lines.push("");
  lines.push(`Found: claude ${dg.totals.claudeFiles} files, codex ${dg.totals.codexFiles} files`);
  lines.push(`Parsed (${rangeDays}d): ${r.tokens.prompts.toLocaleString()} prompts, ${r.tokens.total.toLocaleString()} tokens, ${fmtDollars(r.dollars)}`);
  return lines.join("\n");
}

function renderDiagnostics(d) {
  const body = document.querySelector("#diag-body");
  const copyBtn = document.querySelector("#diag-copy");
  if (!body) return;
  const dg = d.diagnostics;
  if (!dg) {
    body.innerHTML = `<p class="history-note">Diagnostics aren't available in this build. Re-download the latest version.</p>`;
    if (copyBtn) copyBtn.style.display = "none";
    return;
  }
  if (copyBtn) copyBtn.style.display = "";

  const mark = (b) => (b ? "✓" : "✗");
  const row = (label, val) =>
    `<div style="display:flex;justify-content:space-between;gap:16px;padding:4px 0;border-bottom:1px solid rgba(244,240,231,0.08);font-size:0.8rem"><span style="color:var(--muted);word-break:break-all">${label}</span><b style="color:var(--fg);text-align:right;white-space:nowrap">${val}</b></div>`;
  const head = (t) => `<div style="margin-top:14px;margin-bottom:4px;font-weight:600;font-size:0.82rem;color:var(--fg)">${t}</div>`;
  const r = d.range;

  const out = [];
  out.push(row("App version", esc(d.appVersion || "?")));
  out.push(row("Home", esc(dg.homeDir)));
  out.push(row("CLAUDE_CONFIG_DIR", esc(dg.env.CLAUDE_CONFIG_DIR || "(unset)")));
  out.push(row("CODEX_HOME", esc(dg.env.CODEX_HOME || "(unset)")));

  out.push(head("Claude transcripts"));
  out.push(row(`${mark(dg.claude.exists)} ${esc(dg.claude.dir)}`, `${dg.claude.files} files${dg.claude.readable ? "" : " · NOT READABLE"}`));
  for (const c of dg.configuredClaude || []) {
    out.push(row(`${mark(c.exists)} ${esc(c.dir)} (added)`, `${c.files} files${c.readable ? "" : " · NOT READABLE"}`));
  }

  out.push(head("Codex homes"));
  for (const c of dg.codex) {
    out.push(row(`${mark(c.exists)} ${esc(c.root)}${c.configured ? " (added)" : ""}`, `${c.sessionsFiles} files${c.readable ? "" : " · NOT READABLE"}`));
  }

  out.push(head("Found / parsed"));
  out.push(row("Transcripts found", `Claude ${dg.totals.claudeFiles} · Codex ${dg.totals.codexFiles}`));
  out.push(row(`Parsed (${rangeDays}d)`, `${r.tokens.prompts.toLocaleString()} prompts · ${r.tokens.total.toLocaleString()} tok · ${fmtDollars(r.dollars)}`));
  body.innerHTML = out.join("");

  renderHelp(dg);
  renderFolderEditor(dg);

  if (copyBtn && !copyBtn.dataset.wired) {
    copyBtn.dataset.wired = "1";
    copyBtn.addEventListener("click", async () => {
      const orig = copyBtn.textContent;
      try {
        await navigator.clipboard.writeText(diagnosticsReport(data));
        copyBtn.textContent = "Copied!";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    });
  }
}

// Help panel content is regenerated from the current diagnostics state every render.
function renderHelp(dg) {
  const panel = document.querySelector("#diag-help-panel");
  const btn = document.querySelector("#diag-help");
  if (!panel) return;
  const items = window.UMHelp ? window.UMHelp.buildHelp(dg) : [];
  const color = (lvl) => (lvl === "ok" ? "#74c278" : lvl === "warn" ? "#e0796a" : "var(--muted)");
  panel.innerHTML = items
    .map((it) => `<div style="border-left:3px solid ${color(it.level)};padding:6px 10px;margin:6px 0;font-size:0.8rem;line-height:1.45;color:var(--fg)">${esc(it.text)}</div>`)
    .join("");
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => panel.classList.toggle("hidden"));
  }
}

function renderFolderEditor(dg) {
  const host = document.querySelector("#diag-folders");
  if (!host) return;
  if (!nativeApi?.saveConfig || !nativeApi?.getState) {
    host.innerHTML = `<p class="history-note">Folder editing is available in the app.</p>`;
    return;
  }
  const conf = dg.configured || { claude: [], codex: [] };
  const group = (cli, label, paths) => {
    const rows = (paths || []).length
      ? (paths || [])
          .map(
            (p) =>
              `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:4px 0;font-size:0.8rem"><span style="color:var(--fg);word-break:break-all">${esc(p)}</span><button class="mini-toggle diag-remove" data-cli="${cli}" data-path="${encodeURIComponent(p)}">Remove</button></div>`
          )
          .join("")
      : `<div style="color:var(--muted);font-size:0.8rem;padding:4px 0">No extra folders — scanning defaults only.</div>`;
    return `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:0.82rem">${label}</b><button class="mini-toggle diag-add" data-cli="${cli}">+ Add folder</button></div>${rows}</div>`;
  };
  host.innerHTML = group("claude", "Claude folders", conf.claude) + group("codex", "Codex folders", conf.codex);
  wireFolderEditor();
}

function wireFolderEditor() {
  const host = document.querySelector("#diag-folders");
  if (!host || host.dataset.wired) return;
  host.dataset.wired = "1";
  host.addEventListener("click", async (e) => {
    const add = e.target.closest(".diag-add");
    const rem = e.target.closest(".diag-remove");
    if (add) {
      const picked = await nativeApi.pickFolder?.();
      if (picked) await mutateScanRoots(add.dataset.cli, picked, "add");
    } else if (rem) {
      await mutateScanRoots(rem.dataset.cli, decodeURIComponent(rem.dataset.path), "remove");
    }
  });
}

async function mutateScanRoots(cli, folder, op) {
  const state = await nativeApi.getState();
  const config = state.config;
  config.scanRoots = config.scanRoots || { claude: [], codex: [] };
  const list = config.scanRoots[cli] || [];
  config.scanRoots[cli] = op === "add"
    ? (list.includes(folder) ? list : [...list, folder])
    : list.filter((x) => x !== folder);
  await nativeApi.saveConfig(config);
  await load(); // history is recomputed with the new folders; re-render everything
}

/* ---------- render everything ---------- */
function renderAll(d) {
  hideTooltip();
  const r = d.range;

  // empty-state banner
  const empty = document.querySelector("#ov-empty");
  if (empty) {
    empty.innerHTML = r.tokens.total === 0
      ? `<div style="border:1px solid var(--accent);border-radius:8px;padding:12px 14px;margin-bottom:12px;color:var(--fg);font-size:0.82rem;line-height:1.45">No CLI usage found in the last ${rangeDays} days. Usage history is built only from local <b>Claude Code</b> &amp; <b>Codex</b> CLI transcripts — API/SDK or IDE usage isn't counted. Open the <b>Diagnostics</b> panel (⚙) to see exactly what was scanned.</div>`
      : "";
  }

  // summary cards
  document.querySelector("#sum-cards").innerHTML =
    card("Today", fmtDollars(d.today.dollars), fmtTokens(d.today.tokens.total) + " tok") +
    card("Range total", fmtDollars(r.dollars), fmtTokens(r.tokens.total) + " tok") +
    card("Avg / day", fmtDollars(r.dollars / rangeDays), "over " + rangeDays + "d") +
    card("Prompts", r.tokens.prompts.toLocaleString(), fmtPerPrompt(r.avgCostPerPrompt) + " / prompt");

  // subscription value (live windows)
  renderWindowValues(d.windowValues);

  // daily usage
  renderDaily(d);

  // cumulative spend
  cumulativeLine(document.querySelector("#ot-cumulative"), r.days);

  // heatmap + most expensive days
  heatmap(document.querySelector("#ot-heatmap"), r.days);
  const topDays = [...r.days].sort((a, b) => b.dollars - a.dollars).slice(0, 7);
  hBars(document.querySelector("#ec-top-days"), topDays.map((day) => ({
    label: fmtDay(day.day), value: day.dollars, valueText: fmtDollars(day.dollars), color: "var(--accent)"
  })));

  // models
  renderModelsSection(d);

  // diagnostics panel (rendered even when hidden so it's correct when opened)
  renderDiagnostics(d);

  // transparency footer
  const ts = d.computedAt || d.scannedAt || "?";
  const footer = document.querySelector("#footer-transparency");
  if (footer) footer.textContent =
    `Data: local Claude Code + Codex CLI transcripts only · $ = estimated API-equivalent pricing (built-in table) · last computed ${ts}`;
}

/* ---------- data ---------- */
async function fetchUsageHistory() {
  if (nativeApi?.getUsageHistory) return nativeApi.getUsageHistory({ rangeDays });
  const response = await fetch(`/api/usage-history?rangeDays=${rangeDays}`, {
    headers: serverToken ? { "X-Rate-Limit-Tool-Token": serverToken } : {}
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Failed to load usage history.");
  return payload;
}

async function load() {
  try {
    data = await fetchUsageHistory();
    document.querySelector("#history-note").textContent = data.flags.unknownModels.length
      ? `* unknown model, priced at fallback rate: ${data.flags.unknownModels.join(", ")}`
      : "";
    renderAll(data);
  } catch (error) {
    document.querySelector("#history-note").textContent = error.message;
  }
}

/* ---------- controls ---------- */
for (const btn of document.querySelectorAll(".range-toggle button")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    rangeDays = Number(btn.dataset.range);
    load();
  });
}
document.querySelector("#ov-metric").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metric]");
  if (!btn) return;
  metric = btn.dataset.metric;
  document.querySelectorAll("#ov-metric button").forEach((b) => b.classList.toggle("active", b === btn));
  if (data) renderDaily(data);
});

const diagToggle = document.querySelector("#diag-toggle");
if (diagToggle && !diagToggle.dataset.wired) {
  diagToggle.dataset.wired = "1";
  diagToggle.addEventListener("click", () => {
    document.querySelector("#diag-panel").classList.toggle("hidden");
  });
}

load();
