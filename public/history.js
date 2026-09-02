const nativeApi = window.rateLimitAPI || null;
const serverToken = document.querySelector('meta[name="rate-limit-server-token"]')?.content || "";

let rangeDays = 30;
let metric = "tokens"; // Daily chart: tokens | cost
let data = null;
let loadRequestId = 0;
let unsubscribeHistory = null;

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CLI_COLORS = { claude: "var(--tint-claude)", codex: "var(--tint-codex)" };
const NEUTRAL_BAR = "var(--bar-neutral)";

/* ---------- formatting ---------- */
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
const fmtDollars = (n) => n == null || !Number.isFinite(Number(n))
  ? "—"
  : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPerCall = (n) => n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Number(n).toFixed(4);
const fmtDay = (s) => new Date(s + "T00:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const pricingCoverageText = (pricing) => pricing && !pricing.complete
  ? `${Math.round((Number(pricing.coverage) || 0) * 100)}% priced · ${fmtTokens(pricing.unpricedTokens)} tok unpriced`
  : "";

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
  const barW = Math.max(1.5, bw * 0.68);
  const rx = Math.min(2, barW / 2);
  const bars = days.map((d, i) => {
    const x = pad + i * bw + (bw - barW) / 2;
    let y = base;
    return segFn(d).map((seg) => {
      const h = (seg.value / max) * plot;
      y -= h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="${rx}" fill="${seg.color}"></rect>`;
    }).join("");
  }).join("");
  const hits = days.map((d, i) => `<rect class="bar-hit" data-idx="${i}" x="${(pad + i * bw).toFixed(1)}" y="${pad}" width="${bw.toFixed(1)}" height="${plot}"></rect>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${bars}${hits}</svg>`;
  el.querySelector("svg")?.setAttribute("aria-hidden", "true");
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
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"><path d="${area}" fill="color-mix(in srgb, var(--blue) 12%, transparent)"></path><path d="${line}" fill="none" stroke="var(--blue)" stroke-width="1.5" stroke-linejoin="round"></path>${hits}</svg>`;
  el.querySelector("svg")?.setAttribute("aria-hidden", "true");
  attachHover(el, ".bar-hit", (hit) => {
    const p = pts[+hit.dataset.idx];
    return `<div class="tt-date">${fmtDay(p.day.day)}</div><div class="tt-row"><span>Cumulative</span><b>${fmtDollars(p.cum)}</b></div><div class="tt-row"><span>That day</span><span>${fmtDollars(p.day.dollars)}</span></div>`;
  });
}

function hBars(el, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  el.innerHTML = rows.map((r) => `
    <div class="hbar"${r.title ? ` title="${esc(r.title)}"` : ""}>
      <span class="hbar-label">${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${((r.value / max) * 100).toFixed(1)}%;background:${r.color || NEUTRAL_BAR}"></span></span>
      <span class="hbar-val">${esc(r.valueText)}</span>
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
    const unpriced = d.pricing && !d.pricing.complete
      ? `<div class="tt-row"><span>Unpriced</span><b>${fmtTokens(d.pricing.unpricedTokens)} tok</b></div>`
      : "";
    return `<div class="tt-date">${fmtDay(d.day)}</div><div class="tt-row"><span>Priced cost</span><b>${fmtDollars(d.dollars)}</b></div><div class="tt-row tt-claude"><span>Claude</span><span>${fmtDollars(d.byCli.claude.dollars)}</span></div><div class="tt-row tt-codex"><span>Codex</span><span>${fmtDollars(d.byCli.codex.dollars)}</span></div><div class="tt-row"><span>Model calls</span><b>${d.tokens.calls.toLocaleString()}</b></div>${unpriced}`;
  });
}

function card(label, value, sub) {
  return `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(value)}</span><span class="stat-sub">${esc(sub || "")}</span></div>`;
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
  const unpriced = d.pricing && !d.pricing.complete
    ? `<div class="tt-row"><span>Unpriced</span><b>${fmtTokens(d.pricing.unpricedTokens)} tok</b></div>`
    : "";
  return `<div class="tt-date">${fmtDay(d.day)}</div>
    <div class="tt-row"><span>Priced cost</span><b>${fmtDollars(d.dollars)}</b></div>
    <div class="tt-row tt-claude"><span>Claude</span><span>${fmtDollars(d.byCli.claude.dollars)}</span></div>
    <div class="tt-row tt-codex"><span>Codex</span><span>${fmtDollars(d.byCli.codex.dollars)}</span></div>
    <div class="tt-row"><span>Model calls</span><b>${d.tokens.calls.toLocaleString()}</b></div>${unpriced}`;
}

/* ---------- subscription value (live windows) ---------- */
const WINDOW_ORDER = { fiveHour: 0, week: 1 };
const CLI_ORDER = { claude: 0, codex: 1 };
const CLI_LABEL = { claude: "Claude", codex: "Codex" };
const WINDOW_LABEL = { fiveHour: "5-hour", week: "Weekly" };
const LOW_REMAINING_PERCENT = 15;

function formatResetAt(resetAt) {
  const when = Date.parse(resetAt);
  if (!Number.isFinite(when)) return "Reset unavailable";
  const remainingMinutes = Math.max(0, Math.round((when - Date.now()) / 60000));
  if (remainingMinutes < 60) return `Resets in ${remainingMinutes}m`;
  if (remainingMinutes < 24 * 60) return `Resets in ${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m`;
  return `Resets ${new Date(when).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
}

function renderWindowValues(rows) {
  const el = document.querySelector("#ec-value");
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = `<p class="history-note">Live limit data isn't available yet — open the menu-bar popover to refresh limits, then reopen this window.</p>`;
    return;
  }
  const sorted = [...rows].sort((a, b) =>
    ((CLI_ORDER[a.cli] ?? 99) - (CLI_ORDER[b.cli] ?? 99)) ||
    ((WINDOW_ORDER[a.kind] ?? 99) - (WINDOW_ORDER[b.kind] ?? 99)));
  el.innerHTML = sorted.map((w, index) => {
    const pct = Math.min(100, Math.max(0, w.usedPercent));
    const service = CLI_LABEL[w.cli] || w.cli;
    const rawLabel = String(w.label || "");
    const window = WINDOW_LABEL[w.kind] || (rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1));
    const pricingComplete = w.pricingComplete !== false;
    const projectionLabel = !pricingComplete ? "Projection unavailable" : w.full ? "Full-window value" : "Projected value";
    const projection = w.projectedDollars == null ? "—" : fmtDollars(w.projectedDollars);
    const usedLabel = pricingComplete ? "Value used" : "Unpriced usage";
    const usedValue = pricingComplete ? fmtDollars(w.usedDollars) : `${fmtTokens(w.unpricedTokens)} tok`;
    return `
    <article class="allowance-row allowance-row--${esc(w.cli)}">
      <div class="allowance-ring" data-ring="${index}" role="progressbar" aria-label="${esc(service)} ${esc(window)} allowance used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(1)}"></div>
      <div class="allowance-id">
        <span class="allowance-service">${esc(service)}</span>
        <span class="allowance-kind">${esc(window)}</span>
      </div>
      <div class="allowance-metric"><small>${usedLabel}</small><b>${usedValue}</b></div>
      <div class="allowance-metric"><small>${projectionLabel}</small><b>${projection}</b></div>
      <div class="allowance-metric"><small>Used</small><b>${Math.round(pct)}%</b></div>
      <span class="allowance-reset">${formatResetAt(w.resetAt)}</span>
    </article>`;
  }).join("");
  if (window.UMRing) {
    for (const host of el.querySelectorAll(".allowance-ring[data-ring]")) {
      const w = sorted[Number(host.dataset.ring)];
      const remaining = 100 - Math.min(100, Math.max(0, w.usedPercent));
      window.UMRing.renderRing(host, [{ remainingPercent: remaining, low: remaining <= LOW_REMAINING_PERCENT }]);
    }
  }
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
  const rows = r.days.map((day) => `<tr><th scope="row">${esc(fmtDay(day.day))}</th><td>${esc(fmtTokens(day.tokens.total))}</td><td>${esc(fmtDollars(day.dollars))}</td><td>${day.tokens.calls.toLocaleString()}</td></tr>`).join("");
  document.querySelector("#daily-table").innerHTML = `<table><thead><tr><th>Date</th><th>Tokens</th><th>Cost</th><th>Calls</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- diagnostics ---------- */
function diagnosticsReport(d) {
  const dg = d.diagnostics;
  const r = d.range;
  const lines = [
    "Usage Meter diagnostics",
    `app version: ${d.appVersion || "?"}`,
    `scanned: ${d.computedAt || d.scannedAt || "?"}`,
    "home: ~",
    `env: CLAUDE_CONFIG_DIR=${dg.env.CLAUDE_CONFIG_DIR ? "(custom path configured)" : "(unset)"}, CODEX_HOME=${dg.env.CODEX_HOME ? "(custom path configured)" : "(unset)"}`,
    `cache: ~/.rate-limit-tool/${String(dg.cache.path || "").split(/[\\/]/).at(-1) || "usage-index.json"} (v${dg.cache.version})`,
    "",
    "Claude projects: default Claude projects folder",
    `  exists=${dg.claude.exists} readable=${dg.claude.readable} files=${dg.claude.files}`,
    "Codex homes:"
  ];
  for (const [index, c] of dg.codex.entries()) {
    lines.push(`  Codex home ${index + 1}${c.configured ? " (custom)" : ""}`);
    lines.push(`    exists=${c.exists} readable=${c.readable} sessionFiles=${c.sessionsFiles}`);
  }
  lines.push("");
  lines.push(`Found: claude ${dg.totals.claudeFiles} files, codex ${dg.totals.codexFiles} files`);
  lines.push(`Parsed (${rangeDays}d): ${r.tokens.calls.toLocaleString()} model calls, ${r.tokens.total.toLocaleString()} tokens, ${fmtDollars(r.dollars)} priced`);
  if (r.pricing && !r.pricing.complete) lines.push(`Pricing coverage: ${pricingCoverageText(r.pricing)}`);
  return lines.join("\n");
}

function renderDiagnostics(d) {
  const body = document.querySelector("#diag-body");
  const copyBtn = document.querySelector("#diag-copy");
  const repairBtn = document.querySelector("#diag-repair");
  if (!body) return;
  const dg = d.diagnostics;
  if (!dg) {
    body.innerHTML = `<p class="history-note">Diagnostics aren't available in this build. Re-download the latest version.</p>`;
    if (copyBtn) copyBtn.style.display = "none";
    return;
  }
  if (copyBtn) copyBtn.style.display = "";
  if (repairBtn) repairBtn.style.display = nativeApi?.repairUsageHistory ? "" : "none";

  const mark = (b) => (b ? "✓" : "✗");
  const row = (label, val) => `<div class="diag-row"><span>${label}</span><b>${val}</b></div>`;
  const head = (t) => `<div class="diag-head">${t}</div>`;
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
  out.push(row(`Parsed (${rangeDays}d)`, `${r.tokens.calls.toLocaleString()} calls · ${r.tokens.total.toLocaleString()} tok · ${fmtDollars(r.dollars)} priced`));
  if (r.pricing && !r.pricing.complete) out.push(row("Pricing coverage", pricingCoverageText(r.pricing)));
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

  if (repairBtn && nativeApi?.repairUsageHistory && !repairBtn.dataset.wired) {
    repairBtn.dataset.wired = "1";
    repairBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Rebuild the local usage index from current transcripts? This can take about a minute."
      );
      if (!confirmed) return;

      const original = repairBtn.textContent;
      repairBtn.disabled = true;
      repairBtn.textContent = "Rebuilding…";
      try {
        data = await nativeApi.repairUsageHistory({ rangeDays });
        renderAll(data);
        document.querySelector("#history-note").textContent = "Usage index rebuilt from current transcripts.";
        repairBtn.textContent = "Rebuilt";
      } catch (error) {
        document.querySelector("#history-note").textContent = `Index rebuild failed: ${error.message}`;
        repairBtn.textContent = "Rebuild failed";
      } finally {
        setTimeout(() => {
          repairBtn.disabled = false;
          repairBtn.textContent = original;
        }, 1800);
      }
    });
  }
}

// Help panel content is regenerated from the current diagnostics state every render.
function renderHelp(dg) {
  const panel = document.querySelector("#diag-help-panel");
  const btn = document.querySelector("#diag-help");
  if (!panel) return;
  const items = window.UMHelp ? window.UMHelp.buildHelp(dg) : [];
  const levelClass = (lvl) => (lvl === "ok" ? "help-ok" : lvl === "warn" ? "help-warn" : "help-info");
  panel.innerHTML = items
    .map((it) => `<div class="help-item ${levelClass(it.level)}">${esc(it.text)}</div>`)
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
              `<div class="folder-row"><span>${esc(p)}</span><button class="mini-toggle diag-remove" data-cli="${cli}" data-path="${encodeURIComponent(p)}">Remove</button></div>`
          )
          .join("")
      : `<div class="folder-empty">No extra folders. Scanning the default locations only.</div>`;
    return `<div class="folder-group"><div class="folder-group-head"><span>${label}</span><button class="mini-toggle diag-add" data-cli="${cli}">Add folder</button></div>${rows}</div>`;
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
      ? `<div class="empty-state">No CLI usage found in the last ${rangeDays} days. Usage history is built only from local <b>Claude Code</b> and <b>Codex</b> CLI transcripts. API, SDK, and IDE usage isn't counted. Open <b>Diagnostics</b> from the toolbar to see exactly what was scanned.</div>`
      : "";
  }

  // summary cards
  const todayPricing = pricingCoverageText(d.today.pricing);
  const rangePricing = pricingCoverageText(r.pricing);
  document.querySelector("#sum-cards").innerHTML =
    card(d.today.pricing?.complete === false ? "Today · priced" : "Today", fmtDollars(d.today.dollars), todayPricing || fmtTokens(d.today.tokens.total) + " tok") +
    card(r.pricing?.complete === false ? "Range · priced" : "Range total", fmtDollars(r.dollars), rangePricing || fmtTokens(r.tokens.total) + " tok") +
    card(r.pricing?.complete === false ? "Priced avg / day" : "Avg / day", fmtDollars(r.dollars / rangeDays), "over " + rangeDays + "d") +
    card("Model calls", r.tokens.calls.toLocaleString(), fmtPerCall(r.avgCostPerCall) + " / call");

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
    label: fmtDay(day.day), value: day.dollars, valueText: fmtDollars(day.dollars), color: NEUTRAL_BAR
  })));

  hBars(document.querySelector("#top-models"), r.byModel.slice(0, 8).map((model) => ({
    label: `${CLI_LABEL[model.cli] || model.cli} · ${model.model}`,
    value: model.dollars || model.tokens.total,
    valueText: model.dollars == null ? `${fmtTokens(model.tokens.total)} tok` : fmtDollars(model.dollars),
    color: CLI_COLORS[model.cli] || NEUTRAL_BAR
  })));
  hBars(document.querySelector("#top-projects"), r.byProject.slice(0, 8).map((project) => ({
    label: project.parentLabel ? `${project.parentLabel}/${project.label}` : project.label,
    value: project.dollars || project.tokens.total,
    valueText: project.pricing?.complete === false ? `${fmtTokens(project.tokens.total)} tok` : fmtDollars(project.dollars),
    title: project.path || project.label,
    color: NEUTRAL_BAR
  })));

  // diagnostics panel (rendered even when hidden so it's correct when opened)
  renderDiagnostics(d);

  // transparency footer
  const ts = d.computedAt || d.scannedAt || "?";
  const footer = document.querySelector("#footer-transparency");
  if (footer) footer.textContent =
    `Data: local Claude Code + Codex CLI transcripts only · $ = estimated API-equivalent priced subtotal (effective-dated catalog) · last computed ${ts}`;
}

/* ---------- data ---------- */
async function fetchUsageHistory(requestedRangeDays) {
  if (nativeApi?.getUsageHistory) return nativeApi.getUsageHistory({ rangeDays: requestedRangeDays });
  const response = await fetch(`/api/usage-history?rangeDays=${requestedRangeDays}`, {
    headers: serverToken ? { "X-Rate-Limit-Tool-Token": serverToken } : {}
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Failed to load usage history.");
  return payload;
}

async function load() {
  const requestId = ++loadRequestId;
  const requestedRangeDays = rangeDays;
  try {
    const payload = await fetchUsageHistory(requestedRangeDays);
    if (requestId !== loadRequestId || requestedRangeDays !== rangeDays) return;
    data = payload;
    const unpriced = data.flags?.unpricedModels || [];
    document.querySelector("#history-note").textContent = unpriced.length
      ? `Unpriced model${unpriced.length === 1 ? "" : "s"}: ${unpriced.map(({ cli, model }) => `${CLI_LABEL[cli] || cli} · ${model}`).join(", ")}. Tokens and calls are included; dollar views show only models with known rates.`
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
    document.querySelectorAll(".range-toggle button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    load();
  });
}
document.querySelector("#ov-metric").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metric]");
  if (!btn) return;
  metric = btn.dataset.metric;
  document.querySelectorAll("#ov-metric button").forEach((b) => {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-pressed", String(b === btn));
  });
  if (data) renderDaily(data);
});

const diagToggle = document.querySelector("#diag-toggle");
if (diagToggle && !diagToggle.dataset.wired) {
  diagToggle.dataset.wired = "1";
  diagToggle.addEventListener("click", () => {
    const hidden = document.querySelector("#diag-panel").classList.toggle("hidden");
    diagToggle.setAttribute("aria-expanded", String(!hidden));
  });
}

document.querySelectorAll(".range-toggle button").forEach((button) => {
  button.setAttribute("aria-pressed", String(button.classList.contains("active")));
});

if (nativeApi?.onUsageHistoryUpdated) {
  unsubscribeHistory = nativeApi.onUsageHistoryUpdated((payloads) => {
    const payload = payloads?.[rangeDays];
    if (!payload) return;
    loadRequestId += 1;
    data = payload;
    renderAll(data);
  });
}

window.addEventListener("beforeunload", () => unsubscribeHistory?.());
load();
