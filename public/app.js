const accountsRoot = document.querySelector("#accounts");
const accountTemplate = document.querySelector("#account-template");
const refreshButton = document.querySelector("#refresh-button");
const overallStatus = document.querySelector("#overall-status");
const nativeApi = window.rateLimitAPI || null;

let state = null;
let accountElements = new Map();
let accountStates = new Map();
let refreshInFlight = null;
let unsubscribeSnapshot = null;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
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
  return /No auth\.json found|Run login|not logged in|auth was rejected/i.test(error || "");
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

function compactEmail(email) {
  const local = String(email || "").split("@")[0].trim();

  if (!local) {
    return "";
  }

  return `${local.slice(0, 8).replace(/[._-]+$/g, "")}...`;
}

function buildSummary(data) {
  if (!Array.isArray(data.windows) || !data.windows.length) {
    return "No limit data";
  }

  return data.windows
    .map((window) => `${compactWindowLabel(window.label)} ${Math.round(window.remainingPercent)}%`)
    .join("  ") + buildResetSuffix(data);
}

function formatResetTime(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value).replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function getFiveHourWindow(data) {
  if (!Array.isArray(data?.windows)) {
    return null;
  }

  return data.windows.find((window) => /5-hour/i.test(window.label || "")) || null;
}

function getWindowReset(window) {
  return formatResetTime(window?.resetAt || window?.resetText);
}

function buildResetSuffix(data) {
  const reset = getWindowReset(getFiveHourWindow(data));
  return reset ? `  r ${reset}` : "";
}

function buildResetTitle(data) {
  if (!Array.isArray(data?.windows)) {
    return "";
  }

  return data.windows
    .map((window) => {
      const reset = getWindowReset(window);
      return reset ? `${compactWindowLabel(window.label)} resets ${reset}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

function getAccount(accountId) {
  return state?.config.accounts.find((account) => account.id === accountId) || null;
}

function baseAccountName(account) {
  if (!account) {
    return "Account";
  }

  return account.type === "claude" ? "Claude" : "Codex";
}

function buildAccountName(account, data) {
  const emailLabel = compactEmail(data?.email);

  if (!emailLabel) {
    return baseAccountName(account);
  }

  return `${baseAccountName(account)} (${emailLabel})`;
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

  if (entries.some((entry) => entry.kind === "error" || entry.kind === "disconnected")) {
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

  elements.summary.textContent = "Loading…";
  elements.summary.title = "";
  elements.summary.className = "account-summary pending";
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

  elements.summary.textContent = "Waiting…";
  elements.summary.title = "";
  elements.summary.className = "account-summary pending";
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
  elements.summary.textContent = summary;
  elements.summary.title = buildResetTitle(data);
  elements.summary.className = "account-summary";
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

  elements.summary.textContent = "Not connected";
  elements.summary.title = "";
  elements.summary.className = "account-summary error";
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
  elements.summary.textContent = "Unavailable";
  elements.summary.title = detail;
  elements.summary.className = "account-summary error";
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

  for (const result of snapshot.results) {
    renderResult(result);
  }
}

function createAccountRow(account) {
  const node = accountTemplate.content.firstElementChild.cloneNode(true);
  const name = node.querySelector(".account-name");
  const summary = node.querySelector(".account-summary");
  const connectButton = node.querySelector(".connect-button");

  name.textContent = buildAccountName(account);
  summary.textContent = "Loading…";
  summary.title = "";
  summary.className = "account-summary pending";

  connectButton.addEventListener("click", async () => {
    connectButton.disabled = true;
    connectButton.textContent = "Opening…";
    summary.textContent = "Waiting for login…";
    summary.title = "";
    summary.className = "account-summary pending";
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
    name,
    summary,
    connectButton
  });

  return node;
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
  if (typeof unsubscribeSnapshot === "function") {
    unsubscribeSnapshot();
  }
});
