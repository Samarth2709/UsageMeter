const accountsRoot = document.querySelector("#accounts");
const accountTemplate = document.querySelector("#account-template");
const refreshButton = document.querySelector("#refresh-button");
const overallStatus = document.querySelector("#overall-status");
const nativeApi = window.rateLimitAPI || null;
const serverToken = window.__RATE_LIMIT_SERVER_TOKEN__ || "";

let state = null;
let accountElements = new Map();
let accountStates = new Map();
let refreshInFlight = null;
let unsubscribeSnapshot = null;
let countdownTimer = null;
let rowsExpanded = true;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(serverToken ? { "X-Rate-Limit-Tool-Token": serverToken } : {})
    },
    ...options
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function loadAppState() {
  return nativeApi ? nativeApi.getState() : requestJson("/api/state");
}

function openAccountLogin(accountId) {
  if (nativeApi) {
    return nativeApi.openLogin(accountId);
  }

  return requestJson(`/api/accounts/${accountId}/login`, {
    method: "POST"
  });
}

function refreshAppUsage() {
  if (nativeApi) {
    return nativeApi.refresh();
  }

  return requestJson("/api/refresh", {
    method: "POST"
  });
}

function loadSnapshot() {
  if (nativeApi) {
    return nativeApi.getSnapshot();
  }

  return Promise.resolve(null);
}

function isLoginNeededError(error) {
  return /No auth\.json found|Run login|Re-run login|wrong Codex login|Duplicate Codex login|not logged in|auth was rejected|web login|login_required/i.test(error || "");
}

function compactWindowLabel(label) {
  if (/5-hour/i.test(label || "")) {
    return "5h";
  }

  if (/week/i.test(label || "")) {
    return "wk";
  }

  return String(label || "").toLowerCase();
}

function usageWindows(data) {
  if (!Array.isArray(data?.windows) || !data.windows.length) {
    return [];
  }

  return data.windows.filter((window) => /5-hour|week/i.test(window.label || ""));
}

function findUsageWindow(data, kind) {
  const pattern = kind === "week" ? /week/i : /5-hour/i;
  return usageWindows(data).find((window) => pattern.test(window.label || "")) || null;
}

function buildCompactSummary(data) {
  const windows = usageWindows(data);

  if (!windows.length) {
    return "No limit data";
  }

  return windows
    .map((window) => `${compactWindowLabel(window.label)} ${Math.round(window.remainingPercent)}%`)
    .join("  ");
}

function formatResetTime(value, includeDate = false) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value)
      .replace(/\([^)]*\)/g, "")
      .replace(/\b([A-Z][a-z]{2})(\d{1,2})\b/g, "$1 $2")
      .replace(/(\d)(?=[A-Za-z])/g, "$1 ")
      .replace(/\b([A-Z][a-z]{2}\s+\d{1,2})\s+t\s+(\d)/g, "$1 at $2")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!includeDate) {
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getWindowReset(window, includeDate = false) {
  return formatResetTime(window?.resetAt || window?.resetText, includeDate);
}

function getResetDate(window) {
  const resetAt = window?.resetAt;

  if (!resetAt) {
    return null;
  }

  const date = new Date(resetAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCountdown(targetDate) {
  if (!targetDate) {
    return null;
  }

  const remainingMs = targetDate.getTime() - Date.now();
  if (remainingMs <= 0) {
    return "0:00";
  }

  const totalMinutes = Math.ceil(remainingMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function buildResetDetailParts(window, includeDate = false, includeCountdown = true) {
  const resetDate = getResetDate(window);
  const countdown = includeCountdown ? formatCountdown(resetDate) : null;
  const reset = getWindowReset(window, includeDate);
  return { countdown, reset };
}

function buildResetDetail(window, includeDate = false) {
  const detail = buildResetDetailParts(window, includeDate, !includeDate);
  return [detail.countdown, detail.reset].filter(Boolean).join(" · ");
}

function buildExpandedSummary(data) {
  const windows = usageWindows(data);

  if (!windows.length) {
    return "No limit data";
  }

  return windows
    .map((window) => {
      const label = compactWindowLabel(window.label);
      const remaining = `${Math.round(window.remainingPercent)}% left`;
      const reset = buildResetDetail(window, /week/i.test(window.label || ""));
      return reset ? `${label} ${remaining}, ${reset}` : `${label} ${remaining}`;
    })
    .join(" · ");
}

function buildSummary(data) {
  return rowsExpanded ? buildExpandedSummary(data) : buildCompactSummary(data);
}

function buildResetTitle(data) {
  const windows = usageWindows(data);

  if (!windows.length) {
    return "";
  }

  return windows
    .map((window) => {
      const reset = buildResetDetail(window, /week/i.test(window.label || ""));
      return reset ? `${compactWindowLabel(window.label)} ${reset}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

function setLimitWindow(elements, kind, window) {
  const limit = elements.limits[kind];

  if (!limit) {
    return;
  }

  if (!window) {
    limit.value.textContent = "--";
    limit.countdown.textContent = "";
    limit.time.textContent = "";
    limit.separator.classList.add("hidden");
    limit.reset.classList.add("hidden");
    limit.root.classList.add("empty");
    return;
  }

  const reset = buildResetDetailParts(window, kind === "week", kind !== "week");
  limit.value.textContent = `${Math.round(window.remainingPercent)}%`;
  limit.countdown.textContent = reset.countdown || "";
  limit.time.textContent = reset.reset || "";
  limit.separator.classList.toggle("hidden", !reset.countdown || !reset.reset);
  limit.reset.classList.toggle("hidden", !reset.countdown && !reset.reset);
  limit.root.classList.remove("empty");
}

function renderLimitWindows(elements, data) {
  setLimitWindow(elements, "fiveHour", findUsageWindow(data, "fiveHour"));
  setLimitWindow(elements, "week", findUsageWindow(data, "week"));
}

function showStatusSummary(elements, text, className, title = "") {
  elements.limitGrid.classList.add("hidden");
  elements.summary.textContent = text;
  elements.summary.title = title;
  elements.summary.className = `account-summary ${className}`.trim();
}

function getAccount(accountId) {
  return state?.config.accounts.find((account) => account.id === accountId) || null;
}

function baseAccountName(account) {
  if (!account) {
    return "Account";
  }

  const fallback = account.type === "claude" ? "Usage" : "Account";
  const cleaned = String(account.label || "")
    .replace(/\b(?:codex|claude|clod|code)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || fallback;
}

function buildAccountName(account, data) {
  const expectedEmailLabel = String(account?.expectedEmail || account?.email || "").trim();
  if (expectedEmailLabel) {
    return expectedEmailLabel;
  }

  const emailLabel = String(data?.email || "").trim();

  if (!emailLabel) {
    return baseAccountName(account);
  }

  return emailLabel;
}

function setOverallStatus(statusText, className) {
  overallStatus.className = `header-status ${className}`;
  overallStatus.title = statusText;
  overallStatus.setAttribute("aria-label", statusText);
}

function syncOverallStatus() {
  if (!state) {
    return;
  }

  const entries = state.config.accounts.map((account) => {
    const existing = accountStates.get(account.id);

    if (existing) {
      return existing;
    }

    return {
      name: buildAccountName(account),
      kind: "pending",
      detail: "Waiting for refresh"
    };
  });

  let headline = "Waiting for refresh";
  let className = "status-pending";

  if (!entries.length) {
    headline = "No accounts configured";
    className = "status-error";
  } else if (entries.some((entry) => entry.kind === "error" || entry.kind === "disconnected")) {
    headline = "Some accounts need attention";
    className = "status-error";
  } else if (entries.every((entry) => entry.kind === "ok")) {
    headline = "All accounts connected";
    className = "status-ok";
  } else if (entries.some((entry) => entry.detail === "Loading…")) {
    headline = "Refreshing usage";
  }

  setOverallStatus(headline, className);
}

function updateAccountState(accountId, patch = {}) {
  const account = getAccount(accountId);
  const elements = accountElements.get(accountId);
  const existing = accountStates.get(accountId) || {};
  const data = patch.data !== undefined ? patch.data : existing.data;
  const nextState = {
    ...existing,
    ...patch,
    data,
    name: buildAccountName(account, data)
  };

  accountStates.set(accountId, nextState);

  if (elements) {
    elements.name.textContent = nextState.name;
  }

  syncOverallStatus();
}

function setLoading(accountId) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  showStatusSummary(elements, "Loading…", "pending");
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.connectButton.classList.add("hidden");
  elements.connectButton.textContent = "Connect";
  updateAccountState(accountId, {
    kind: "pending",
    detail: "Loading…"
  });
}

function setIdle(accountId) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  showStatusSummary(elements, "Waiting…", "pending");
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.connectButton.classList.add("hidden");
  elements.connectButton.textContent = "Connect";
  updateAccountState(accountId, {
    kind: "pending",
    detail: "Waiting for refresh"
  });
}

function renderConnected(accountId, data) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  const summary = buildSummary(data);
  renderLimitWindows(elements, data);
  elements.limitGrid.classList.remove("hidden");
  elements.summary.textContent = "";
  elements.summary.title = buildResetTitle(data);
  elements.summary.className = "account-summary hidden";
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.connectButton.classList.add("hidden");
  elements.connectButton.textContent = "Connect";
  updateAccountState(accountId, {
    kind: "ok",
    detail: summary,
    data
  });
}

function renderDisconnected(accountId) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  showStatusSummary(elements, "Not connected", "error");
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.connectButton.classList.remove("hidden");
  elements.connectButton.textContent = "Connect";
  updateAccountState(accountId, {
    kind: "disconnected",
    detail: "Not connected"
  });
}

function renderError(accountId, error) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  const detail = String(error || "Unavailable");
  showStatusSummary(elements, "Unavailable", "error", detail);
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.connectButton.classList.add("hidden");
  elements.connectButton.textContent = "Connect";
  updateAccountState(accountId, {
    kind: "error",
    detail
  });
}

function renderResult(result) {
  if (result.ok) {
    renderConnected(result.accountId, result.data);
    return;
  }

  if (isLoginNeededError(result.error)) {
    renderDisconnected(result.accountId);
    return;
  }

  renderError(result.accountId, result.error);
}

function applySnapshot(snapshot) {
  if (!snapshot?.results) {
    return;
  }

  if (snapshot.config?.accounts) {
    syncAccountsFromConfig(snapshot.config);
  }

  for (const result of snapshot.results) {
    renderResult(result);
  }
}

function syncAccountsFromConfig(config) {
  if (!state) {
    state = { config };
  } else {
    state = {
      ...state,
      config
    };
  }

  const nextIds = new Set(config.accounts.map((account) => account.id));

  for (const [accountId, elements] of accountElements) {
    if (!nextIds.has(accountId)) {
      elements.row.remove();
      accountElements.delete(accountId);
      accountStates.delete(accountId);
    }
  }

  for (const account of config.accounts) {
    const existing = accountElements.get(account.id);

    if (existing) {
      existing.row.classList.toggle("account-row-claude", account.type === "claude");
      existing.row.classList.toggle("account-row-codex", account.type !== "claude");
      existing.name.textContent = buildAccountName(account, accountStates.get(account.id)?.data);
      continue;
    }

    accountsRoot.appendChild(createAccountRow(account));
    setIdle(account.id);
  }

  syncViewSize();
  syncOverallStatus();
}

function createAccountRow(account) {
  const node = accountTemplate.content.firstElementChild.cloneNode(true);
  const name = node.querySelector(".account-name");
  const limitGrid = node.querySelector(".limit-grid");
  const summary = node.querySelector(".account-summary");
  const connectButton = node.querySelector(".connect-button");

  node.classList.add(account.type === "claude" ? "account-row-claude" : "account-row-codex");
  name.textContent = buildAccountName(account);
  showStatusSummary(
    {
      limitGrid,
      summary
    },
    "Loading…",
    "pending"
  );

  connectButton.addEventListener("click", async () => {
    connectButton.disabled = true;
    connectButton.textContent = "Opening…";
    showStatusSummary(
      {
        limitGrid,
        summary
      },
      "Waiting for login…",
      "pending"
    );
    updateAccountState(account.id, {
      kind: "pending",
      detail: "Waiting for login"
    });

    try {
      await openAccountLogin(account.id);
      connectButton.textContent = "Connect";
    } catch {
      renderDisconnected(account.id);
    } finally {
      connectButton.disabled = false;
    }
  });

  accountElements.set(account.id, {
    row: node,
    name,
    limitGrid,
    limits: {
      fiveHour: {
        root: node.querySelector('[data-window="5h"]'),
        value: node.querySelector('[data-window="5h"] .limit-value'),
        reset: node.querySelector('[data-window="5h"] .limit-reset'),
        countdown: node.querySelector('[data-window="5h"] .limit-countdown'),
        separator: node.querySelector('[data-window="5h"] .limit-separator'),
        time: node.querySelector('[data-window="5h"] .limit-time')
      },
      week: {
        root: node.querySelector('[data-window="week"]'),
        value: node.querySelector('[data-window="week"] .limit-value'),
        reset: node.querySelector('[data-window="week"] .limit-reset'),
        countdown: node.querySelector('[data-window="week"] .limit-countdown'),
        separator: node.querySelector('[data-window="week"] .limit-separator'),
        time: node.querySelector('[data-window="week"] .limit-time')
      }
    },
    summary,
    connectButton
  });

  return node;
}

function renderCurrentRows() {
  for (const [accountId, elements] of accountElements) {
    const existing = accountStates.get(accountId);
    elements.row.classList.toggle("expanded", rowsExpanded);

    if (existing?.kind === "ok" && existing.data) {
      renderConnected(accountId, existing.data);
    }
  }
}

function updateCountdowns() {
  renderCurrentRows();
}

function syncViewSize(expanded = rowsExpanded) {
  nativeApi?.setExpandedView?.(expanded, state?.config?.accounts?.length || 1);
}

async function loadState() {
  state = await loadAppState();
  accountElements = new Map();
  accountStates = new Map();
  accountsRoot.innerHTML = "";

  for (const account of state.config.accounts) {
    accountsRoot.appendChild(createAccountRow(account));
  }
}

async function refreshAll() {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    refreshButton.disabled = true;
    for (const account of state.config.accounts) {
      setLoading(account.id);
    }

    try {
      applySnapshot(await refreshAppUsage());
    } catch (error) {
      for (const account of state.config.accounts) {
        renderError(account.id, error?.message || "Unavailable");
      }
    }
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
    refreshButton.disabled = false;
  }
}

document.addEventListener("keydown", (event) => {
  const isToggleKey = event.key.toLowerCase() === "l" || event.code === "KeyL";
  if (nativeApi && event.ctrlKey && event.altKey && isToggleKey) {
    event.preventDefault();
    nativeApi.toggle();
  }
});

refreshButton.addEventListener("click", () => {
  refreshAll();
});

await loadState();
syncViewSize();
countdownTimer = window.setInterval(updateCountdowns, 60000);

for (const account of state.config.accounts) {
  setIdle(account.id);
}

if (nativeApi) {
  unsubscribeSnapshot = nativeApi.onSnapshot((snapshot) => {
    applySnapshot(snapshot);
  });
}

const snapshot = await loadSnapshot();
if (snapshot) {
  applySnapshot(snapshot);
}

window.addEventListener("beforeunload", () => {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
  }

  if (typeof unsubscribeSnapshot === "function") {
    unsubscribeSnapshot();
  }
});
