const ALERT_STATE_VERSION = 1;

function emptyAlertState() {
  return { version: ALERT_STATE_VERSION, sent: {} };
}

function normalizeAlertState(state) {
  if (!state || typeof state !== "object" || !state.sent || typeof state.sent !== "object" || Array.isArray(state.sent)) {
    return emptyAlertState();
  }

  const sent = {};
  for (const [key, value] of Object.entries(state.sent)) {
    const resetAt = Date.parse(value?.resetAt);
    if (Number.isFinite(resetAt)) {
      sent[key] = {
        resetAt: new Date(resetAt).toISOString(),
        notifiedAt: typeof value.notifiedAt === "string" ? value.notifiedAt : null
      };
    }
  }
  return { version: ALERT_STATE_VERSION, sent };
}

function runwayAlertKey(cli, window) {
  return [cli, window.kind || window.label || "allowance", window.resetAt].join("|");
}

function selectRunwayAlerts(runways, { nowMs = Date.now(), state } = {}) {
  const normalized = normalizeAlertState(state);
  const sent = {};
  let pruned = false;

  for (const [key, value] of Object.entries(normalized.sent)) {
    if (Date.parse(value.resetAt) > nowMs) {
      sent[key] = value;
    } else {
      pruned = true;
    }
  }

  const alerts = [];
  for (const runway of runways || []) {
    if (runway?.status !== "ready") continue;

    for (const window of runway.windows || []) {
      const estimatedMinutes = Number(window?.estimatedMinutes);
      const resetMs = Date.parse(window?.resetAt);
      if (
        window?.lastsUntilReset ||
        !Number.isFinite(estimatedMinutes) ||
        estimatedMinutes < 0 ||
        !Number.isFinite(resetMs) ||
        resetMs <= nowMs
      ) {
        continue;
      }

      const key = runwayAlertKey(runway.cli, window);
      if (sent[key]) continue;

      alerts.push({
        key,
        cli: runway.cli,
        label: window.label || "Allowance",
        resetAt: new Date(resetMs).toISOString(),
        estimatedMinutes,
        exhaustsAt: new Date(nowMs + estimatedMinutes * 60000).toISOString(),
        tokensPerDay: Number(runway.tokensPerDay) || 0
      });
    }
  }

  return { alerts, state: { version: ALERT_STATE_VERSION, sent }, pruned };
}

function markRunwayAlertSent(state, alert, notifiedAt = new Date().toISOString()) {
  const normalized = normalizeAlertState(state);
  return {
    ...normalized,
    sent: {
      ...normalized.sent,
      [alert.key]: {
        resetAt: alert.resetAt,
        notifiedAt
      }
    }
  };
}

module.exports = {
  ALERT_STATE_VERSION,
  emptyAlertState,
  normalizeAlertState,
  runwayAlertKey,
  selectRunwayAlerts,
  markRunwayAlertSent
};
