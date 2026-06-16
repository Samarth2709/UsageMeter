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

  document.querySelector("#chart").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${bars}</svg>` +
    `<div class="legend"><span class="dot claude"></span>Claude<span class="dot codex"></span>Codex</div>`;
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

  renderChart(data.range.days);

  const tbody = document.querySelector("#model-table tbody");
  tbody.innerHTML = "";
  for (const m of data.range.byModel) {
    const tr = document.createElement("tr");
    const cells = [m.model + (m.modelKnown ? "" : " *"), m.cli, fmtTokens(m.tokens.total), fmtDollars(m.dollars)];
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
