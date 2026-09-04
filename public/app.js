const accountsRoot = document.querySelector("#accounts");
const accountTemplate = document.querySelector("#account-template");
const limitWindowTemplate = document.querySelector("#limit-window-template");
const refreshButton = document.querySelector("#refresh-button");
const overallStatus = document.querySelector("#overall-status");
const overallStatusText = document.querySelector("#overall-status-text");
const overallStatusAnchor = document.querySelector(".status-anchor");
const nativeApi = window.rateLimitAPI || null;
const serverToken = document.querySelector('meta[name="rate-limit-server-token"]')?.content || "";

let state = null;
let accountElements = new Map();
let accountStates = new Map();
let refreshInFlight = null;
let unsubscribeSnapshot = null;
let countdownTimer = null;
let statusHeartbeat = null;
let lastSnapshotAt = null;
let rowsExpanded = true;

// Background usage refresh runs every 60s. If no live snapshot has arrived in
// ~2.5 cycles, the data source is effectively down — the status dot must show
// that rather than staying on the last (now stale) green.
const STALE_MS = 150000;

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

function logoutAccount(accountId, removeLogin = false) {
  if (nativeApi) {
    return nativeApi.logoutAccount(accountId, removeLogin);
  }

  return requestJson(`/api/accounts/${accountId}/logout`, {
    method: "POST",
    body: JSON.stringify({ removeLogin })
  });
}

function removeAccount(accountId) {
  if (nativeApi) {
    return nativeApi.removeAccount(accountId);
  }

  return requestJson(`/api/accounts/${accountId}`, {
    method: "DELETE"
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
  return /No auth\.json found|Run login|Re-run login|wrong Codex login|Duplicate Codex login|not logged in|auth was rejected|saved Claude Code login|Sign in to Claude|login_required|claude auth status --json/i.test(error || "");
}

function compactWindowLabel(label) {
  if (/5-hour/i.test(label || "")) {
    return "5h";
  }

  if (/week/i.test(label || "")) {
    return "wk";
  }

  return String(label || "Allowance").trim();
}

function usageWindows(data) {
  if (!Array.isArray(data?.windows) || !data.windows.length) {
    return [];
  }

  return data.windows.filter((window) => window && typeof window === "object");
}

// Band order: the 5-hour allowance on top, weekly beneath it.
function windowOrder(window) {
  if (/5-hour/i.test(window?.label || "")) return 0;
  if (/week/i.test(window?.label || "")) return 1;
  return 2;
}

function displayWindowLabel(label) {
  if (/5-hour/i.test(label || "")) return "5-hour";
  if (/week/i.test(label || "")) return "Weekly";
  return String(label || "Allowance").trim();
}

// At or below this share remaining, the meter fill turns red.
const LOW_REMAINING_PERCENT = 15;

function isLowRemaining(window) {
  return (Number(window?.remainingPercent) || 0) <= LOW_REMAINING_PERCENT;
}

const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

// Count the displayed percent from its previous value to the new one.
function animatePercent(node, from, to) {
  if (from === to || reducedMotion?.matches || typeof requestAnimationFrame !== "function") {
    node.textContent = `${Math.round(to)}%`;
    return;
  }

  const start = performance.now();
  const duration = 900;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = `${Math.round(from + (to - from) * eased)}%`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Retain the window count for the account layout; tracks use each window's own value.
function paintRowMeter(elements, windows) {
  const row = elements?.row;
  if (!row?.dataset) return;
  row.dataset.bands = String(Math.min(2, windows.length));
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

// Two-unit countdown to a reset. Shows the largest non-zero unit plus the next
// one down: days+hours, else hours+minutes, else minutes+seconds (always two).
function formatResetCountdown(targetDate) {
  if (!targetDate) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.floor((targetDate.getTime() - Date.now()) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

function resetDetail(window) {
  const countdown = formatResetCountdown(getResetDate(window));
  if (countdown) {
    return `resets in ${countdown}`;
  }
  const reset = getWindowReset(window, true);
  return reset ? `resets ${reset}` : "reset not reported";
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
      const reset = resetDetail(window);
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
      const reset = resetDetail(window);
      return reset ? `${compactWindowLabel(window.label)} ${reset}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

function renderLimitWindows(elements, data, options = {}) {
  const animate = options.animate !== false;
  const displayWindows = usageWindows(data).slice().sort((a, b) => windowOrder(a) - windowOrder(b));
  const previous = new Map(
    [...elements.limitGrid.querySelectorAll?.(".limit-window") ?? []].map((node) => [node.dataset.label, Number(node.dataset.remaining)])
  );
  paintRowMeter(elements, displayWindows);
  elements.limitGrid.replaceChildren(...displayWindows.map((window) => {
    const root = limitWindowTemplate.content.firstElementChild.cloneNode(true);
    const resetDate = getResetDate(window);
    const label = displayWindowLabel(window.label);
    const remaining = Math.min(100, Math.max(0, Number(window.remainingPercent) || 0));
    const before = previous.has(label) ? previous.get(label) : 0;
    root.dataset.label = label;
    root.dataset.remaining = remaining.toFixed(1);
    root.style?.setProperty("--remaining", `${remaining}%`);
    root.querySelector(".limit-label").textContent = label;
    const value = root.querySelector(".limit-value");
    if (animate) animatePercent(value, before, remaining);
    else value.textContent = `${Math.round(remaining)}%`;
    root.classList.toggle("low", isLowRemaining(window));
    const reset = root.querySelector(".limit-reset");
    reset.textContent = resetDetail(window);
    reset.title = resetDate ? `Resets ${formatResetTime(resetDate.toISOString(), true)}` : "Reset time not reported.";
    return root;
  }));
  elements.limitGrid.classList.toggle("hidden", !displayWindows.length);
}

function showStatusSummary(elements, text, className, title = "") {
  paintRowMeter(elements, []);
  elements.limitGrid.replaceChildren();
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

function confirmAccountRemoval(account) {
  const name = buildAccountName(account);
  return window.confirm(
    `Delete ${name} from Usage Meter?\n\n` +
    "This removes its cached usage and any UsageMeter-managed login copy. " +
    "It will not sign you out of the main Claude Code or Codex app."
  );
}

function confirmLoginRemoval(account) {
  const name = buildAccountName(account);
  return window.confirm(
    `Log out and remove the saved login for ${name}?\n\n` +
    "This removes matching credentials from this computer and cannot be undone. " +
    "The row will stay in Usage Meter so you can sign in again."
  );
}

function setOverallStatus(statusText, className) {
  overallStatusAnchor?.classList.toggle("hidden", !statusText);
  overallStatus.className = `header-status ${className}`;
  overallStatus.title = statusText;
  overallStatus.setAttribute("aria-label", statusText);
  if (overallStatusText) overallStatusText.textContent = statusText;
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
  } else if (entries.some((entry) => entry.kind === "stale")) {
    headline = "Showing cached data";
    className = "status-stale";
  } else if (entries.every((entry) => entry.kind === "ok")) {
    headline = "";
    className = "status-ok";
  } else if (entries.some((entry) => entry.detail === "Loading…")) {
    headline = "Refreshing usage";
  }

  // Live-health guard: a healthy (green) status is only true if fresh data is
  // still arriving. If the last snapshot is older than STALE_MS, the source is
  // down — surface that instead of a stale green.
  if (className === "status-ok" && lastSnapshotAt && Date.now() - lastSnapshotAt > STALE_MS) {
    const ageSeconds = Math.round((Date.now() - lastSnapshotAt) / 1000);
    headline = `No live data — last update ${ageSeconds}s ago`;
    className = "status-error";
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
    // The identity is not drawn; it is available as the tooltip of the name block.
    // (The row's own tooltip is reserved for the cached-data detail.)
    const meta = elements.name?.parentElement;
    if (meta) meta.title = nextState.name;
  }

  syncOverallStatus();
}

function setLoading(accountId) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  setStalePresentation(accountId, elements, false);
  showStatusSummary(elements, "Loading…", "pending");
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.actions.classList.add("hidden");
  elements.connectButton.classList.add("hidden");
  elements.deleteButton.classList.add("hidden");
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

  setStalePresentation(accountId, elements, false);
  showStatusSummary(elements, "Waiting…", "pending");
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.actions.classList.add("hidden");
  elements.connectButton.classList.add("hidden");
  elements.deleteButton.classList.add("hidden");
  elements.connectButton.textContent = "Connect";
  updateAccountState(accountId, {
    kind: "pending",
    detail: "Waiting for refresh"
  });
}

function setStalePresentation(accountId, elements, stale, error = null) {
  const type = getAccount(accountId)?.type === "claude" ? "Claude" : "Codex";
  const detail = stale
    ? ["Cached data", String(error || "").trim()].filter(Boolean).join(" · ")
    : "";

  elements.row.classList.toggle("is-stale", stale);
  elements.row.title = detail;
  elements.typeTag.textContent = stale ? `${type} · Cached` : type;
  elements.typeTag.title = detail;
  elements.limitGrid.setAttribute("aria-label", stale ? "Cached usage limits" : "Usage limits");
}

function renderConnected(accountId, data, metadata = {}) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  const stale = metadata.stale === true;
  const summary = buildSummary(data);
  setStalePresentation(accountId, elements, stale, metadata.error);
  renderLimitWindows(elements, data, { animate: !stale });
  elements.summary.textContent = "";
  elements.summary.title = buildResetTitle(data);
  elements.summary.className = "account-summary hidden";
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.actions.classList.add("hidden");
  elements.connectButton.classList.add("hidden");
  elements.deleteButton.classList.add("hidden");
  elements.connectButton.textContent = "Sign in";
  elements.connectButton.title = "";
  elements.connectButton.dataset.action = "login";
  updateAccountState(accountId, {
    kind: stale ? "stale" : "ok",
    detail: stale ? "Cached data" : summary,
    data,
    stale,
    error: stale ? metadata.error || "Live refresh unavailable." : null
  });
}

function renderDisconnected(accountId, error = null) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  const detail = error?.message || String(error || "");
  setStalePresentation(accountId, elements, false);
  showStatusSummary(
    elements,
    detail ? `Could not open sign-in · ${detail}` : "",
    detail ? "error" : "hidden",
    detail
  );
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.actions.classList.remove("hidden");
  elements.connectButton.classList.remove("hidden");
  elements.connectButton.textContent = "Sign in";
  elements.connectButton.title = "Open sign-in in Google Chrome";
  elements.connectButton.dataset.action = "login";
  elements.deleteButton.classList.remove("hidden");
  elements.deleteButton.textContent = "Delete";
  elements.deleteButton.title = "Delete this account from Usage Meter";
  updateAccountState(accountId, {
    kind: "disconnected",
    detail: detail || "Sign in required",
    data: null,
    stale: false,
    error: detail || null
  });
}

function renderError(accountId, error) {
  const elements = accountElements.get(accountId);
  if (!elements) {
    return;
  }

  const detail = String(error || "Unavailable");
  setStalePresentation(accountId, elements, false);
  showStatusSummary(elements, `Unavailable · ${detail}`, "error", detail);
  elements.row.classList.toggle("expanded", rowsExpanded);
  elements.actions.classList.remove("hidden");
  elements.connectButton.classList.remove("hidden");
  elements.connectButton.textContent = "Retry";
  elements.connectButton.title = "Try refreshing usage again";
  elements.connectButton.dataset.action = "retry";
  elements.deleteButton.classList.add("hidden");
  updateAccountState(accountId, {
    kind: "error",
    detail,
    data: null,
    stale: false,
    error: detail
  });
}

function renderResult(result) {
  if (result.ok) {
    renderConnected(result.accountId, result.data, {
      stale: result.stale,
      error: result.error || result.staleReason || result.data?.staleReason
    });
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

  lastSnapshotAt = Date.now();

  if (snapshot.config?.accounts) {
    syncAccountsFromConfig(snapshot.config);
  }

  for (const result of snapshot.results) {
    renderResult(result);
  }

  syncViewSize();
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
      const existingState = accountStates.get(account.id);
      setStalePresentation(account.id, existing, existingState?.stale === true, existingState?.error);
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
  const typeTag = node.querySelector(".account-type");
  const limitGrid = node.querySelector(".limit-grid");
  const summary = node.querySelector(".account-summary");
  const actions = node.querySelector(".account-actions");
  const connectButton = node.querySelector(".connect-button");
  const deleteButton = node.querySelector(".delete-button");

  node.classList.add(account.type === "claude" ? "account-row-claude" : "account-row-codex");
  typeTag.textContent = account.type === "claude" ? "Claude" : "Codex";
  name.textContent = buildAccountName(account);
  showStatusSummary(
    {
      row: node,
      limitGrid,
      summary
    },
    "Loading…",
    "pending"
  );

  connectButton.addEventListener("click", async () => {
    if (connectButton.dataset.action === "retry") {
      await refreshAll();
      return;
    }
    connectButton.disabled = true;
    connectButton.textContent = "Opening…";
    updateAccountState(account.id, {
      kind: "pending",
      detail: "Opening sign-in",
      data: null,
      stale: false,
      error: null
    });

    try {
      await openAccountLogin(account.id);
      renderDisconnected(account.id);
    } catch (error) {
      renderDisconnected(account.id, error);
    } finally {
      connectButton.disabled = false;
    }
  });

  node.addEventListener?.("contextmenu", async (event) => {
    if (!nativeApi?.showAccountMenu) return;
    event.preventDefault();

    const action = await nativeApi.showAccountMenu(account.id);
    if (!action) return;

    if (action === "delete-row") {
      deleteButton.click();
      return;
    }

    const removeLogin = action === "remove-login";
    if (removeLogin && !confirmLoginRemoval(account)) return;

    connectButton.disabled = true;
    deleteButton.disabled = true;
    showStatusSummary(
      { row: node, limitGrid, summary },
      removeLogin ? "Removing login…" : "Logging out…",
      "pending"
    );

    try {
      const loggedOut = await logoutAccount(account.id, removeLogin);
      syncAccountsFromConfig(loggedOut.config);
      renderDisconnected(account.id);
    } catch (error) {
      renderError(account.id, error?.message || "Couldn’t log out.");
    } finally {
      connectButton.disabled = false;
      deleteButton.disabled = false;
    }
  });

  deleteButton.addEventListener("click", async () => {
    if (!confirmAccountRemoval(account)) {
      return;
    }

    connectButton.disabled = true;
    deleteButton.disabled = true;
    deleteButton.textContent = "Deleting…";
    updateAccountState(account.id, {
      kind: "pending",
      detail: "Deleting account",
      data: null,
      stale: false,
      error: null
    });

    try {
      const removed = await removeAccount(account.id);
      syncAccountsFromConfig(removed.config);
    } catch (error) {
      renderDisconnected(account.id);
      showStatusSummary(
        { row: node, limitGrid, summary },
        "Couldn’t delete",
        "error",
        error?.message || "Account deletion failed."
      );
    } finally {
      connectButton.disabled = false;
      deleteButton.disabled = false;
      deleteButton.textContent = "Delete";
    }
  });

  accountElements.set(account.id, {
    row: node,
    typeTag,
    name,
    limitGrid,
    summary,
    actions,
    connectButton,
    deleteButton
  });

  return node;
}

function renderCurrentRows() {
  for (const [accountId, elements] of accountElements) {
    const existing = accountStates.get(accountId);
    elements.row.classList.toggle("expanded", rowsExpanded);

    if (existing?.kind === "ok" && existing.data) {
      renderConnected(accountId, existing.data, {
        stale: existing.stale,
        error: existing.error
      });
    }
  }
}

function updateCountdowns() {
  renderCurrentRows();
}

function measureContentHeight() {
  if (!accountsRoot) {
    return null;
  }

  // Use layout dimensions, not transformed bounds: the 3D pose must never
  // feed back into native window sizing. Include gaps and the transparent stage.
  const header = document.querySelector(".sculpture-header");
  const footer = document.querySelector(".widget-bar");
  const stage = document.querySelector(".spatial-stage");
  const listStyle = getComputedStyle(accountsRoot);
  const stageStyle = stage ? getComputedStyle(stage) : null;
  const paddingY = (style) => style
    ? (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    : 0;
  const rowsHeight = [...accountsRoot.children].reduce(
    (height, row) => height + row.offsetHeight, 0
  );
  const gaps = Math.max(0, accountsRoot.children.length - 1) * (parseFloat(listStyle.rowGap) || 0);
  return Math.ceil(rowsHeight + gaps + paddingY(listStyle) + paddingY(stageStyle) +
    (header?.offsetHeight || 0) + (footer?.offsetHeight || 0));
}

function syncViewSize(expanded = rowsExpanded) {
  nativeApi?.setExpandedView?.(
    expanded,
    state?.config?.accounts?.length || 1,
    measureContentHeight()
  );
}

// Rows change height whenever an account changes state — connected, refreshing,
// cached, signed out — and each of those has to move the window with it. Left to
// explicit calls the two drift apart, and a window shorter than its rows scrolls
// the top of the meter out of sight.
let viewSizeFrame = 0;

function queueViewSizeSync() {
  if (viewSizeFrame) return;
  viewSizeFrame = requestAnimationFrame(() => {
    viewSizeFrame = 0;
    syncViewSize();
  });
}

new ResizeObserver(queueViewSizeSync).observe(accountsRoot);

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

document.querySelector("#history-button")?.addEventListener("click", () => {
  nativeApi?.openHistory?.();
});

// The bottom bar stays down until the pointer comes near the bottom edge, so
// the popover is only the meters at rest. While open, confirm the real macOS
// cursor position: if the frameless window resizes beneath a stationary cursor,
// no new mousemove arrives to clear the old position.
const widgetShell = document.querySelector(".widget-shell");
const barZone = 30;
let barCursorTimer = null;
let barCursorCheckInFlight = false;

function setBottomBarOpen(open) {
  widgetShell?.classList.toggle("bar-open", open);

  if (!open && barCursorTimer) {
    clearInterval(barCursorTimer);
    barCursorTimer = null;
  }

  if (open && nativeApi?.isCursorNearBottom && !barCursorTimer) {
    barCursorTimer = window.setInterval(reconcileBottomBarWithCursor, 100);
  }
}

async function reconcileBottomBarWithCursor() {
  if (!widgetShell?.classList.contains("bar-open") || barCursorCheckInFlight) return;
  barCursorCheckInFlight = true;

  try {
    if (!await nativeApi.isCursorNearBottom(barZone)) {
      setBottomBarOpen(false);
    }
  } catch {
    setBottomBarOpen(false);
  } finally {
    barCursorCheckInFlight = false;
  }
}

widgetShell?.addEventListener("mousemove", (event) => {
  setBottomBarOpen(event.clientY >= widgetShell.offsetHeight - barZone);
});

widgetShell?.addEventListener("mouseleave", () => {
  setBottomBarOpen(false);
});

const updatePill = document.querySelector("#update-pill");

function renderUpdateState(update) {
  if (!updatePill || !window.usageMeterUpdatePresentation) return;
  const presentation = window.usageMeterUpdatePresentation.describeUpdate(update);
  updatePill.textContent = presentation.label;
  updatePill.title = presentation.title;
  updatePill.disabled = Boolean(presentation.disabled);
  updatePill.dataset.updateState = update?.status || "idle";
  updatePill.dataset.updateAction = presentation.action;
  updatePill.classList.toggle("hidden", !presentation.visible);
}

updatePill?.addEventListener("click", () => {
  const action = updatePill.dataset.updateAction;
  if (action === "download") {
    nativeApi?.downloadUpdate?.().catch((error) => {
      renderUpdateState({ status: "failed", error: error?.message || "Update failed." });
    });
  } else if (action === "restart") {
    nativeApi?.restartUpdate?.();
  } else if (action === "shell") {
    nativeApi?.openShellUpdate?.();
  }
});

if (nativeApi?.onUpdateState) {
  nativeApi.onUpdateState(renderUpdateState);
}

await loadState();
syncViewSize();
countdownTimer = window.setInterval(updateCountdowns, 60000);
// Re-evaluate live health independently of incoming snapshots so the dot flips
// to "down" when fresh data stops arriving.
statusHeartbeat = window.setInterval(syncOverallStatus, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    syncOverallStatus();
    // Re-assert the fit on show. Content changes move the window on their own;
    // this catches a window that is out of step for any other reason, so the
    // popover is never revealed at the wrong height.
    queueViewSizeSync();
  }
});

for (const account of state.config.accounts) {
  setIdle(account.id);
}

syncViewSize();

if (nativeApi) {
  unsubscribeSnapshot = nativeApi.onSnapshot((snapshot) => {
    applySnapshot(snapshot);
  });
}

const snapshot = await loadSnapshot();
if (snapshot) {
  applySnapshot(snapshot);
}

// An update may have been detected before this renderer subscribed.
if (nativeApi?.getUpdate) {
  nativeApi.getUpdate().then((update) => renderUpdateState(update)).catch(() => {});
}

// The fixed shell clears an update rollback only after the Core renderer has
// completed its own initialization, rather than merely loading this document.
nativeApi?.reportCoreHealthy?.();

window.addEventListener("beforeunload", () => {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
  }

  if (statusHeartbeat) {
    window.clearInterval(statusHeartbeat);
  }

  if (typeof unsubscribeSnapshot === "function") {
    unsubscribeSnapshot();
  }
});
