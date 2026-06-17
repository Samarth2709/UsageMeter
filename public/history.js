const nativeApi = window.rateLimitAPI || null;
const serverToken = document.querySelector('meta[name="rate-limit-server-token"]')?.content || "";
let rangeDays = 30;

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function fmtDollars(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

// Per-prompt costs are small; show more precision.
function fmtPerPrompt(n) {
  return "$" + (Number(n) || 0).toFixed(4);
}

// Days for the current range, shared so chart/heatmap hover handlers can look up
// full detail by index without re-deriving it.
let currentDays = [];
let tooltipEl = null;

function ensureTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "chart-tooltip hidden";
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function moveTooltip(x, y) {
  const t = ensureTooltip();
  const r = t.getBoundingClientRect();
  const pad = 14;
  let left = x + pad;
  let top = y + pad;
  if (left + r.width > window.innerWidth) left = x - r.width - pad;
  if (top + r.height > window.innerHeight) top = y - r.height - pad;
  t.style.left = `${Math.max(4, left)}px`;
  t.style.top = `${Math.max(4, top)}px`;
}

function showTooltip(html, x, y) {
  const t = ensureTooltip();
  t.innerHTML = html;
  t.classList.remove("hidden");
  moveTooltip(x, y);
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.classList.add("hidden");
}

function dayTooltipHtml(d, kind) {
  const dt = new Date(d.day + "T00:00:00");
  const date = dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const c = d.byCli.claude;
  const x = d.byCli.codex;
  const rows = [];
  if (kind === "tokens") {
    rows.push(`<div class="tt-row"><span>Total</span><b>${fmtTokens(d.tokens.total)} tok</b></div>`);
    rows.push(`<div class="tt-row tt-claude"><span>Claude</span><span>${fmtTokens(c.tokens.total)} · ${fmtDollars(c.dollars)}</span></div>`);
    rows.push(`<div class="tt-row tt-codex"><span>Codex</span><span>${fmtTokens(x.tokens.total)} · ${fmtDollars(x.dollars)}</span></div>`);
    rows.push(`<div class="tt-row"><span>Cost</span><b>${fmtDollars(d.dollars)}</b></div>`);
  } else {
    rows.push(`<div class="tt-row"><span>Cost</span><b>${fmtDollars(d.dollars)}</b></div>`);
    rows.push(`<div class="tt-row tt-claude"><span>Claude</span><span>${fmtDollars(c.dollars)}</span></div>`);
    rows.push(`<div class="tt-row tt-codex"><span>Codex</span><span>${fmtDollars(x.dollars)}</span></div>`);
    rows.push(`<div class="tt-row"><span>Prompts</span><b>${d.tokens.prompts.toLocaleString()}</b></div>`);
  }
  return `<div class="tt-date">${date}</div>${rows.join("")}`;
}

// Delegate hover for any container holding elements with a data-idx into currentDays.
function attachDayHover(container, hitSelector, kind) {
  container.addEventListener("mousemove", (event) => {
    const hit = event.target.closest(hitSelector);
    if (!hit || hit.dataset.idx === undefined) {
      hideTooltip();
      return;
    }
    const day = currentDays[Number(hit.dataset.idx)];
    if (!day) {
      hideTooltip();
      return;
    }
    showTooltip(dayTooltipHtml(day, kind), event.clientX, event.clientY);
  });
  container.addEventListener("mouseleave", hideTooltip);
}

async function fetchUsageHistory() {
  if (nativeApi?.getUsageHistory) {
    return nativeApi.getUsageHistory({ rangeDays });
  }

  const response = await fetch(`/api/usage-history?rangeDays=${rangeDays}`, {
    headers: serverToken ? { "X-Rate-Limit-Tool-Token": serverToken } : {}
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Failed to load usage history.");
  }
  return payload;
}

function renderChart(days) {
  const W = 700;
  const H = 200;
  const pad = 24;
  const max = Math.max(1, ...days.map((d) => d.tokens.total));
  const bw = (W - pad * 2) / Math.max(1, days.length);
  const base = H - pad;

  const bars = days
    .map((d, i) => {
      const x = pad + i * bw;
      const ch = (d.byCli.claude.tokens.total / max) * (H - pad * 2);
      const co = (d.byCli.codex.tokens.total / max) * (H - pad * 2);
      const claude = `<rect x="${(x + 1).toFixed(1)}" y="${(base - ch).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${ch.toFixed(1)}" fill="#f4ab5e"></rect>`;
      const codex = `<rect x="${(x + 1).toFixed(1)}" y="${(base - ch - co).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${co.toFixed(1)}" fill="#74c278"></rect>`;
      return claude + codex;
    })
    .join("");

  // Full-height transparent hit columns per day → large hover targets (covers
  // zero-usage days too, so there are no dead zones).
  const hits = days
    .map((d, i) => {
      const x = pad + i * bw;
      return `<rect class="bar-hit" data-idx="${i}" x="${x.toFixed(1)}" y="${pad}" width="${bw.toFixed(1)}" height="${(H - pad * 2).toFixed(1)}"></rect>`;
    })
    .join("");

  const chart = document.querySelector("#chart");
  chart.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${bars}${hits}</svg>` +
    `<div class="legend"><span class="dot claude"></span>Claude<span class="dot codex"></span>Codex</div>`;
  attachDayHover(chart, ".bar-hit", "tokens");
}

// GitHub-activity-style calendar: one cell per day, colored by that day's cost.
function renderHeatmap(days) {
  const el = document.querySelector("#heatmap");
  if (!days || !days.length) { el.innerHTML = ""; return; }

  const max = Math.max(0, ...days.map((d) => d.dollars));
  const level = (cost) => {
    if (cost <= 0 || max <= 0) return 0;
    const f = cost / max;
    if (f <= 0.25) return 1;
    if (f <= 0.5) return 2;
    if (f <= 0.75) return 3;
    return 4;
  };

  // Pad the front so the first column aligns to the day of week (Sun-first).
  const first = new Date(days[0].day + "T00:00:00");
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) {
    cells.push('<div class="hm-cell hm-empty"></div>');
  }
  for (let i = 0; i < days.length; i++) {
    cells.push(`<div class="hm-cell hm-l${level(days[i].dollars)}" data-idx="${i}"></div>`);
  }

  el.innerHTML =
    `<div class="hm-grid">${cells.join("")}</div>` +
    `<div class="hm-legend">Less` +
    `<span class="hm-cell hm-l0"></span><span class="hm-cell hm-l1"></span><span class="hm-cell hm-l2"></span><span class="hm-cell hm-l3"></span><span class="hm-cell hm-l4"></span>` +
    `More</div>`;
  attachDayHover(el, ".hm-cell[data-idx]", "cost");
}

function render(data) {
  document.querySelector("#today-tokens").textContent = fmtTokens(data.today.tokens.total) + " tok";
  document.querySelector("#today-dollars").textContent = fmtDollars(data.today.dollars);
  document.querySelector("#range-tokens").textContent = fmtTokens(data.range.tokens.total) + " tok";
  document.querySelector("#range-dollars").textContent = fmtDollars(data.range.dollars);

  let claudeTokens = 0;
  let codexTokens = 0;
  let claudeDollars = 0;
  let codexDollars = 0;
  for (const d of data.range.days) {
    claudeTokens += d.byCli.claude.tokens.total;
    codexTokens += d.byCli.codex.tokens.total;
    claudeDollars += d.byCli.claude.dollars;
    codexDollars += d.byCli.codex.dollars;
  }
  document.querySelector("#cli-split").textContent = `${fmtTokens(claudeTokens)} / ${fmtTokens(codexTokens)}`;
  document.querySelector("#cli-split-dollars").textContent = `${fmtDollars(claudeDollars)} / ${fmtDollars(codexDollars)}`;

  document.querySelector("#avg-per-prompt").textContent = fmtPerPrompt(data.range.avgCostPerPrompt);
  document.querySelector("#avg-per-prompt-sub").textContent = `${data.range.tokens.prompts.toLocaleString()} prompts`;

  currentDays = data.range.days;
  hideTooltip();
  renderChart(data.range.days);
  renderHeatmap(data.range.days);

  const tbody = document.querySelector("#model-table tbody");
  tbody.innerHTML = "";
  for (const m of data.range.byModel) {
    const tr = document.createElement("tr");
    const cells = [
      m.model + (m.modelKnown ? "" : " *"),
      m.cli,
      m.prompts.toLocaleString(),
      fmtTokens(m.tokens.total),
      fmtDollars(m.dollars),
      fmtPerPrompt(m.costPerPrompt)
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      if (i >= 2) td.className = "num";
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  document.querySelector("#history-note").textContent = data.flags.unknownModels.length
    ? `* unknown model, priced at fallback rate: ${data.flags.unknownModels.join(", ")}`
    : "";
}

async function load() {
  try {
    render(await fetchUsageHistory());
  } catch (error) {
    document.querySelector("#history-note").textContent = error.message;
  }
}

for (const btn of document.querySelectorAll(".range-toggle button")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    rangeDays = Number(btn.dataset.range);
    load();
  });
}

load();
