const nativeApi = window.rateLimitAPI || null;
const serverToken = document.querySelector('meta[name="rate-limit-server-token"]')?.content || "";

let rangeDays = 30;
let metric = "tokens"; // Overview daily chart: tokens | cost
let currentPage = "overview";
let data = null;

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
const fmtDollars = (n) => "$" + (Number(n) || 0).toFixed(2);
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
  container.addEventListener("mousemove", (e) => {
    const hit = e.target.closest(selector);
    const html = hit ? getHtml(hit) : null;
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

function donut(el, slices, centerTop, centerBottom) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = slices.map((s) => {
    const len = (s.value / total) * C;
    const seg = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${s.color}" stroke-width="20" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"></circle>`;
    off += len;
    return seg;
  }).join("");
  const legend = slices.map((s) => `<div class="lg-row"><span class="lg-dot" style="background:${s.color}"></span><span class="lg-name">${s.label}</span><span class="lg-val">${s.sub || ""}</span></div>`).join("");
  el.innerHTML = `<div class="donut-wrap"><svg viewBox="0 0 140 140" width="132" height="132">${arcs}<text x="70" y="66" text-anchor="middle" class="donut-c1">${centerTop}</text><text x="70" y="85" text-anchor="middle" class="donut-c2">${centerBottom || ""}</text></svg><div class="donut-legend">${legend}</div></div>`;
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

/* ---------- pages ---------- */
function renderOverview(d) {
  const r = d.range;
  let cT = 0, xT = 0, cD = 0, xD = 0;
  for (const day of r.days) { cT += day.byCli.claude.tokens.total; xT += day.byCli.codex.tokens.total; cD += day.byCli.claude.dollars; xD += day.byCli.codex.dollars; }
  document.querySelector("#ov-cards").innerHTML =
    card("Today", fmtTokens(d.today.tokens.total) + " tok", fmtDollars(d.today.dollars)) +
    card("Range total", fmtTokens(r.tokens.total) + " tok", fmtDollars(r.dollars)) +
    card("Avg / prompt", fmtPerPrompt(r.avgCostPerPrompt), r.tokens.prompts.toLocaleString() + " prompts") +
    card("Claude / Codex", fmtTokens(cT) + " / " + fmtTokens(xT), fmtDollars(cD) + " / " + fmtDollars(xD));

  const useCost = metric === "cost";
  dayBars(
    document.querySelector("#ov-chart"),
    r.days,
    (day) => useCost
      ? [{ value: day.byCli.claude.dollars, color: CLI_COLORS.claude }, { value: day.byCli.codex.dollars, color: CLI_COLORS.codex }]
      : [{ value: day.byCli.claude.tokens.total, color: CLI_COLORS.claude }, { value: day.byCli.codex.tokens.total, color: CLI_COLORS.codex }],
    useCost ? dayCostHover : dayTokenHover
  );

  hBars(document.querySelector("#ov-top-models"), r.byModel.slice(0, 5).map((m, i) => ({
    label: m.model, color: MODEL_PALETTE[i % MODEL_PALETTE.length],
    value: m.dollars, valueText: fmtDollars(m.dollars)
  })));
}

function renderOverTime(d) {
  const r = d.range;
  const half = Math.floor(r.days.length / 2);
  const firstHalf = r.days.slice(0, half).reduce((s, x) => s + x.dollars, 0);
  const secondHalf = r.days.slice(half).reduce((s, x) => s + x.dollars, 0);
  const delta = firstHalf > 0 ? ((secondHalf - firstHalf) / firstHalf) * 100 : 0;
  const busiest = r.days.reduce((a, b) => (b.dollars > a.dollars ? b : a), r.days[0]);
  document.querySelector("#ot-stats").innerHTML =
    card("Total spend", fmtDollars(r.dollars), rangeDays + "d") +
    card("Avg / day", fmtDollars(r.dollars / rangeDays), "") +
    card("Busiest day", fmtDollars(busiest.dollars), fmtDay(busiest.day)) +
    card("2nd half vs 1st", (delta >= 0 ? "+" : "") + delta.toFixed(0) + "%", "spend momentum");

  dayBars(
    document.querySelector("#ot-cost-chart"),
    r.days,
    (day) => [{ value: day.byCli.claude.dollars, color: CLI_COLORS.claude }, { value: day.byCli.codex.dollars, color: CLI_COLORS.codex }],
    dayCostHover
  );

  cumulativeLine(document.querySelector("#ot-cumulative"), r.days);

  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const wd = names.map(() => ({ sum: 0, n: 0 }));
  for (const day of r.days) { const g = new Date(day.day + "T00:00:00").getDay(); wd[g].sum += day.dollars; wd[g].n += 1; }
  hBars(document.querySelector("#ot-weekday"), wd.map((w, i) => ({
    label: names[i], color: "var(--accent)",
    value: w.n ? w.sum / w.n : 0, valueText: fmtDollars(w.n ? w.sum / w.n : 0)
  })));

  heatmap(document.querySelector("#ot-heatmap"), r.days);
}

function renderModels(d) {
  const r = d.range;
  const colorMap = {};
  r.byModel.slice(0, MODEL_PALETTE.length).forEach((m, i) => { colorMap[`${m.cli}::${m.model}`] = MODEL_PALETTE[i]; });
  const colorFor = (key) => colorMap[key] || OTHER_COLOR;

  // donut by cost
  const top = r.byModel.slice(0, MODEL_PALETTE.length);
  const otherD = r.byModel.slice(MODEL_PALETTE.length).reduce((s, m) => s + m.dollars, 0);
  const slices = top.map((m, i) => ({ label: m.model, color: MODEL_PALETTE[i], value: m.dollars, sub: fmtDollars0(m.dollars) }));
  if (otherD > 0) slices.push({ label: "other", color: OTHER_COLOR, value: otherD, sub: fmtDollars0(otherD) });
  donut(document.querySelector("#md-donut"), slices, fmtDollars0(r.dollars), "total");

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
        .map(([k, v]) => `<div class="tt-row"><span><span class="tt-dot" style="background:${colorFor(k)}"></span>${k.split("::")[1]}</span><span>${fmtDollars(v.dollars)}</span></div>`).join("");
      return `<div class="tt-date">${fmtDay(day.day)}</div>${rows || "<div class='tt-row'><span>no usage</span></div>"}`;
    }
  );
  document.querySelector("#md-mix-legend").innerHTML = top.map((m, i) => `<span class="lg-row"><span class="lg-dot" style="background:${MODEL_PALETTE[i]}"></span>${m.model}</span>`).join("");

  const tbody = document.querySelector("#md-table tbody");
  tbody.innerHTML = "";
  for (const m of r.byModel) {
    const tr = document.createElement("tr");
    [m.model + (m.modelKnown ? "" : " *"), m.cli, m.prompts.toLocaleString(), fmtTokens(m.tokens.total), fmtDollars(m.dollars), fmtPerPrompt(m.costPerPrompt)]
      .forEach((t, i) => { const td = document.createElement("td"); if (i >= 2) td.className = "num"; td.textContent = t; tr.appendChild(td); });
    tbody.appendChild(tr);
  }
}

function renderEconomics(d) {
  const r = d.range;
  const effRate = r.tokens.total ? r.dollars / (r.tokens.total / 1e6) : 0;
  document.querySelector("#ec-cards").innerHTML =
    card("Total spend", fmtDollars(r.dollars), rangeDays + "d window") +
    card("Avg / day", fmtDollars(r.dollars / rangeDays), "") +
    card("Projected / mo", fmtDollars0((r.dollars / rangeDays) * 30), "at current rate") +
    card("Effective rate", "$" + effRate.toFixed(2) + "/M", "blended $/Mtok");

  const t = r.costByType;
  hBars(document.querySelector("#ec-type"), [
    { label: "Output", value: t.output, valueText: fmtDollars(t.output), color: "#e0796a" },
    { label: "Fresh input", value: t.input, valueText: fmtDollars(t.input), color: "#5fa8d3" },
    { label: "Cache write", value: t.cacheWrite, valueText: fmtDollars(t.cacheWrite), color: "#d7c56f" },
    { label: "Cache read", value: t.cachedRead, valueText: fmtDollars(t.cachedRead), color: "#74c278" }
  ]);

  let cD = 0, xD = 0;
  for (const day of r.days) { cD += day.byCli.claude.dollars; xD += day.byCli.codex.dollars; }
  hBars(document.querySelector("#ec-cli"), [
    { label: "Codex", value: xD, valueText: fmtDollars(xD), color: CLI_COLORS.codex },
    { label: "Claude", value: cD, valueText: fmtDollars(cD), color: CLI_COLORS.claude }
  ]);

  const topDays = [...r.days].sort((a, b) => b.dollars - a.dollars).slice(0, 7);
  hBars(document.querySelector("#ec-top-days"), topDays.map((day) => ({
    label: fmtDay(day.day), value: day.dollars, valueText: fmtDollars(day.dollars), color: "var(--accent)"
  })));
}

function renderEfficiency(d) {
  const r = d.range;
  const tot = r.tokens;
  const hitRate = (tot.input + tot.cachedRead) ? (tot.cachedRead / (tot.input + tot.cachedRead)) * 100 : 0;
  document.querySelector("#ef-cards").innerHTML =
    card("Cache hit rate", fmtPct(hitRate), "of input tokens") +
    card("Cache savings", fmtDollars0(r.cacheSavings), "vs uncached") +
    card("Would-be cost", fmtDollars0(r.dollars + r.cacheSavings), "without caching");

  const rows = r.byModel.filter((m) => m.tokens.input + m.tokens.cachedRead > 0).map((m, i) => {
    const rate = (m.tokens.cachedRead / (m.tokens.input + m.tokens.cachedRead)) * 100;
    return {
      label: m.model, value: rate, valueText: fmtPct(rate) + "  ·  saved " + fmtDollars0(m.cacheSavings),
      color: MODEL_PALETTE[i % MODEL_PALETTE.length],
      title: `${m.model}: ${fmtPct(rate)} cache hit, ${fmtDollars0(m.cacheSavings)} saved`
    };
  });
  hBars(document.querySelector("#ef-cache"), rows);
}

const RENDERERS = { overview: renderOverview, overtime: renderOverTime, models: renderModels, economics: renderEconomics, efficiency: renderEfficiency };

function renderCurrent() {
  hideTooltip();
  if (data) RENDERERS[currentPage](data);
}

function showPage(name) {
  currentPage = name;
  for (const btn of document.querySelectorAll(".page-tabs button")) btn.classList.toggle("active", btn.dataset.page === name);
  for (const sec of document.querySelectorAll(".page")) sec.classList.toggle("hidden", sec.id !== `page-${name}`);
  renderCurrent();
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
    renderCurrent();
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
for (const btn of document.querySelectorAll(".page-tabs button")) {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
}
document.querySelector("#ov-metric").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metric]");
  if (!btn) return;
  metric = btn.dataset.metric;
  document.querySelectorAll("#ov-metric button").forEach((b) => b.classList.toggle("active", b === btn));
  if (data) renderOverview(data);
});

load();
