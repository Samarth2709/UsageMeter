function usageWindowKey(window) {
  const stableId = String(window?.id || "").trim();
  if (stableId) {
    return stableId.toLowerCase();
  }

  const label = String(window?.label || "");

  if (/5[-\s]?hour|5h|session/i.test(label)) {
    return "fiveHour";
  }

  if (/week|7[-\s]?day|7d/i.test(label)) {
    return "week";
  }

  return label.trim().toLowerCase() || null;
}

function coerceResetAt(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 100000000000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }

  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return coerceResetAt(Number(value));
  }

  return value;
}

function mergeUsageWindows(existingWindows = [], incomingWindows = []) {
  const incomingByKey = new Map();
  const usedIncoming = new Set();

  for (const window of incomingWindows) {
    const key = usageWindowKey(window);
    if (key) {
      incomingByKey.set(key, window);
    }
  }

  const merged = existingWindows.map((existing) => {
    const key = usageWindowKey(existing);
    const incoming = key ? incomingByKey.get(key) : null;

    if (!incoming) {
      return existing;
    }

    usedIncoming.add(incoming);

    return {
      ...existing,
      ...incoming,
      resetAt: coerceResetAt(incoming.resetAt) || existing.resetAt || null,
      resetText: incoming.resetText || existing.resetText || null,
      resetAfterSeconds: incoming.resetAfterSeconds ?? existing.resetAfterSeconds
    };
  });

  for (const incoming of incomingWindows) {
    if (!usedIncoming.has(incoming)) {
      merged.push({
        ...incoming,
        resetAt: coerceResetAt(incoming.resetAt)
      });
    }
  }

  return merged;
}

module.exports = {
  coerceResetAt,
  mergeUsageWindows,
  usageWindowKey
};
