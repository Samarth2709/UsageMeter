const accountsRoot = document.querySelector("#accounts");
const accountTemplate = document.querySelector("#account-template");
const refreshButton = document.querySelector("#refresh-button");
const nativeApi = window.rateLimitAPI || null;

let state = null;
let accountElements = new Map();
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

function buildSummary(data) {
  if (!Array.isArray(data.windows) || !data.windows.length) {
    return "No limit data";
  }

  return data.windows
    .map((window) => `${compactWindowLabel(window.label)} ${Math.round(window.remainingPercent)}%`)
    .join("  ");
}

function setLoading(accountId) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  elements.summary.textContent = "Loading…";
  elements.summary.className = "account-summary pending";
  elements.connectButton.classList.add("hidden");
}

function setIdle(accountId) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  elements.summary.textContent = "Waiting…";
  elements.summary.className = "account-summary pending";
  elements.connectButton.classList.add("hidden");
}

function renderConnected(accountId, data) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  elements.summary.textContent = buildSummary(data);
  elements.summary.className = "account-summary";
  elements.connectButton.classList.add("hidden");
}

function renderDisconnected(accountId) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  elements.summary.textContent = "Not connected";
  elements.connectButton.classList.remove("hidden");
}

function renderError(accountId) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  elements.summary.textContent = "Unavailable";
  elements.summary.className = "account-summary error";
  elements.connectButton.classList.add("hidden");
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

  renderError(result.accountId);
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

  name.textContent = account.label;
  summary.textContent = "Loading…";
  summary.className = "account-summary pending";

  connectButton.addEventListener("click", async () => {
    connectButton.disabled = true;
    connectButton.textContent = "Opening…";
    summary.textContent = "Waiting for login…";
    summary.className = "account-summary pending";

    try {
      await openAccountLogin(account.id);
      connectButton.textContent = "Waiting…";
    } catch {
      connectButton.textContent = "Retry";
      summary.textContent = "Not connected";
      summary.className = "account-summary";
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

    applySnapshot(await refreshAppUsage());
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
