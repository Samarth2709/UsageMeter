const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  appendRecords,
  mergeContribution,
  mergeProjectContribution,
  recordsToContribution,
  recordsToMinuteContribution,
  recordsToProjectContribution
} = require("./contributions");
const { parseClaudeTranscriptChunk } = require("./parseClaude");
const { parseCodexTranscriptChunk } = require("./parseCodex");
const { listAllTranscriptFiles } = require("./sources");
const { loadCache } = require("./store");
const { localDay } = require("./day");
const {
  filenameSessionIdentity,
  structuralSessionIdentity
} = require("./session-identity");
const { atomicWriteJsonSync } = require("../atomic-file");

const INDEX_FILE = "usage-index.json";
const INDEX_VERSION = 4;
const LEGACY_POINTS_FILE = "window-points.json";
const LEGACY_POINTS_VERSION = 3;
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const RECENT_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
const HISTORY_RETENTION_DAYS = 90;
const READ_BUFFER_BYTES = 4 * 1024 * 1024;
const TAIL_HASH_BYTES = 4096;
const SESSION_ID_SCAN_BYTES = 256 * 1024;
const MAX_JSONL_LINE_BYTES = 128 * 1024 * 1024;
const REBUILD_CHECKPOINT_FILES = 1000;

function freshIndex() {
  return {
    version: INDEX_VERSION,
    lastReconciledAt: 0,
    needsClaudeRebuild: false,
    files: {},
    duplicates: {}
  };
}

function legacyIndex(dataDir) {
  const history = loadCache(dataDir);
  const points = loadCache(dataDir, LEGACY_POINTS_FILE, LEGACY_POINTS_VERSION);
  if (!Object.keys(history.files).length) return freshIndex();

  const index = freshIndex();
  for (const [filePath, entry] of Object.entries(history.files)) {
    const pointEntry = points.files[filePath];
    const matchingPoints = pointEntry
      && pointEntry.mtimeMs === entry.mtimeMs
      && pointEntry.size === entry.size
      && pointEntry.cli === entry.cli;
    index.files[filePath] = {
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      cli: entry.cli,
      dev: null,
      ino: null,
      processedBytes: entry.size,
      parserState: null,
      tailHash: null,
      appendReady: false,
      // Public legacy caches were produced before the corrected Claude
      // streaming and Codex cumulative-snapshot semantics. Rebuild every live
      // transcript once; cached aggregates remain the only fallback for files
      // that have already been deleted.
      needsRebuild: true,
      contribution: entry.contribution || {},
      projectContribution: entry.projectContribution || {},
      minuteContribution: matchingPoints
        ? recordsToMinuteContribution((pointEntry.records || []).map((record) => ({
          ...record,
          cli: record.cli || entry.cli
        })))
        : {}
    };
  }
  return index;
}

function contentTranscriptIdentity(filePath, cli) {
  let fd;
  let bytesRead = 0;
  let identity = null;
  let fingerprint = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    fingerprint = {
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size
    };
    const size = Math.min(stat.size, SESSION_ID_SCAN_BYTES);
    const buffer = Buffer.allocUnsafe(size);
    const count = fs.readSync(fd, buffer, 0, size, 0);
    bytesRead = count;
    for (const line of buffer.subarray(0, count).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      const candidate = structuralSessionIdentity(cli, value);
      if (!candidate) continue;
      if (!identity || candidate.startsWith("agent-")) identity = candidate;
      if (cli !== "claude" || candidate.startsWith("agent-")) {
        return { identity, bytesRead, fingerprint };
      }
    }
  } catch {
    return { identity: null, bytesRead, fingerprint };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { identity, bytesRead, fingerprint };
}

function statFingerprint(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

function fingerprintMatches(fingerprint, stat) {
  return Boolean(
    fingerprint
    && fingerprint.dev === stat.dev
    && fingerprint.ino === stat.ino
    && fingerprint.mtimeMs === stat.mtimeMs
    && fingerprint.size === stat.size
  );
}

function transcriptIdentity(file, entry = null, cachedDuplicate = false) {
  const filenameIdentity = filenameSessionIdentity(file.path);
  let sameIndexedFile = false;
  let sameIndexedContents = false;
  let sameLegacyFile = false;
  if (entry && entry.cli === file.cli) {
    try {
      const stat = fs.statSync(file.path);
      file.identityFingerprint = statFingerprint(stat);
      sameIndexedFile = entry.dev === stat.dev && entry.ino === stat.ino;
      sameIndexedContents = (
        sameIndexedFile
        && entry.mtimeMs === stat.mtimeMs
        && entry.size === stat.size
      );
      sameLegacyFile = (
        entry.dev === null
        && entry.ino === null
        && entry.appendReady === false
        && entry.mtimeMs === stat.mtimeMs
        && entry.size === stat.size
      );
    } catch { /* discovery tolerates files disappearing mid-scan */ }
  }
  if (cachedDuplicate) file.cachedDuplicateChanged = !sameIndexedContents;
  else if (entry) file.indexedPrimaryChanged = !sameIndexedContents && !sameLegacyFile;
  const trustedIndexedIdentity = sameIndexedFile && (!cachedDuplicate || sameIndexedContents);
  if ((trustedIndexedIdentity || sameLegacyFile) && entry.sessionIdentity) {
    return entry.sessionIdentity;
  }
  if (sameLegacyFile) return filenameIdentity;
  if (trustedIndexedIdentity && filenameIdentity) return filenameIdentity;
  if (trustedIndexedIdentity && entry.identityScanComplete) return null;

  const scanned = contentTranscriptIdentity(file.path, file.cli);
  file.identityScanComplete = true;
  file.identityBytesRead = scanned.bytesRead;
  file.identityFingerprint = scanned.fingerprint;
  if (
    file.cli === "claude"
    && filenameIdentity?.startsWith("agent-")
    && !scanned.identity?.startsWith("agent-")
  ) {
    return filenameIdentity;
  }
  if (file.cli === "claude" && !filenameIdentity && !scanned.identity?.startsWith("agent-")) {
    return null;
  }
  return scanned.identity || filenameIdentity;
}

function deduplicateFoundTranscripts(
  found,
  index,
  { preferExisting = true, revalidateAggregateLosers = false } = {}
) {
  const groups = new Map();
  const ungrouped = [];
  for (const file of found) {
    const cachedDuplicate = index.duplicates?.[file.path] || null;
    const cachedEntry = index.files[file.path] || cachedDuplicate;
    const identity = transcriptIdentity(file, cachedEntry, Boolean(cachedDuplicate));
    if (!identity) {
      ungrouped.push(file);
      continue;
    }
    file.sessionIdentity = identity;
    const key = `${file.cli}:${identity}`;
    const group = groups.get(key) || [];
    group.push(file);
    groups.set(key, group);
  }

  const selected = [...ungrouped];
  const duplicates = [];
  for (const group of groups.values()) {
    const existingPrimary = group.filter((file) => index.files[file.path]);
    const existingDuplicate = group.filter((file) => index.duplicates?.[file.path]);
    const changedDuplicates = group.filter((file) => file.cachedDuplicateChanged);
    const changedPrimary = existingPrimary.some((file) => file.indexedPrimaryChanged);
    const uncached = group.filter(
      (file) => !index.files[file.path] && !index.duplicates?.[file.path]
    );
    const preferredExisting = [
      ...existingPrimary,
      ...(changedPrimary ? existingDuplicate : []),
      ...changedDuplicates,
      ...uncached
    ];
    const candidates = !preferExisting
      ? group
      : (preferredExisting.length
        ? preferredExisting
        : (existingDuplicate.length ? existingDuplicate : group));
    const winner = candidates.reduce((best, file) => {
      if (!best) return file;
      let bestSize;
      let fileSize;
      try {
        bestSize = fs.statSync(best.path).size;
        fileSize = fs.statSync(file.path).size;
      } catch { /* discovery already tolerates files disappearing mid-scan */ }
      if (!Number.isFinite(bestSize)) {
        bestSize = index.files[best.path]?.size || index.duplicates?.[best.path]?.size;
      }
      if (!Number.isFinite(fileSize)) {
        fileSize = index.files[file.path]?.size || index.duplicates?.[file.path]?.size;
      }
      return (fileSize || 0) > (bestSize || 0) ? file : best;
    }, null);
    const changedAggregateLosers = group.filter((file) => (
      file.path !== winner.path
      && index.files[file.path]
      && (
        file.indexedPrimaryChanged
        || index.files[file.path].needsRebuild
        || revalidateAggregateLosers
      )
    ));
    const changedAggregatePaths = new Set(
      changedAggregateLosers.map((file) => file.path)
    );
    winner.duplicateFiles = group.filter((file) => (
      file.path !== winner.path && !changedAggregatePaths.has(file.path)
    ));
    if (changedAggregateLosers.length) {
      const transaction = {
        failed: false,
        originals: new Map(changedAggregateLosers.map((file) => [
          file.path,
          structuredClone(index.files[file.path])
        ]))
      };
      winner.aggregateRevalidationTransaction = transaction;
      for (const file of changedAggregateLosers) {
        file.aggregateRevalidationTransaction = transaction;
        file.requiresFullRevalidation = true;
      }
    }
    selected.push(...changedAggregateLosers);
    selected.push(winner);
    duplicates.push(...winner.duplicateFiles);
  }
  return { selected, duplicates };
}

function cachedDuplicateEntry(file, previous = null) {
  let stat;
  try { stat = fs.statSync(file.path); } catch { return null; }
  if (!fingerprintMatches(file.identityFingerprint, stat)) return null;
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    cli: file.cli,
    dev: stat.dev,
    ino: stat.ino,
    sessionIdentity: file.sessionIdentity || previous?.sessionIdentity || null,
    identityScanComplete: Boolean(file.identityScanComplete || previous?.identityScanComplete)
  };
}

function moveIndexedFileToDuplicate(index, filePath) {
  const entry = index.files[filePath];
  if (!entry) return false;
  index.duplicates[filePath] = {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    cli: entry.cli,
    dev: entry.dev,
    ino: entry.ino,
    sessionIdentity: entry.sessionIdentity || filenameSessionIdentity(filePath),
    identityScanComplete: Boolean(entry.identityScanComplete)
  };
  delete index.files[filePath];
  return true;
}

function commitDuplicateGroup(index, duplicates, cli, sessionIdentity) {
  let changed = false;
  const revalidate = [];
  for (const duplicate of duplicates || []) {
    const aggregate = index.files[duplicate.path];
    if (
      aggregate
      && (
        aggregate.cli !== cli
        || aggregate.sessionIdentity !== sessionIdentity
      )
    ) continue;
    const previous = index.duplicates[duplicate.path];
    const cached = cachedDuplicateEntry(duplicate, previous);
    if (!cached) {
      revalidate.push(duplicate);
      continue;
    }
    if (index.files[duplicate.path]) {
      delete index.files[duplicate.path];
      changed = true;
    }
    if (JSON.stringify(cached) !== JSON.stringify(previous)) {
      index.duplicates[duplicate.path] = cached;
      changed = true;
    }
  }
  return { changed, revalidate };
}

function enqueueIdentityRevalidation(found, file) {
  if (file.queuedForIdentityRevalidation) return;
  file.queuedForIdentityRevalidation = true;
  file.requiresFullRevalidation = true;
  file.duplicateFiles = [];
  file.attemptedGroupPaths = new Set([file.path]);
  found.push(file);
}

function failAggregateRevalidation(index, transaction) {
  transaction.failed = true;
  for (const [filePath, original] of transaction.originals) {
    index.files[filePath] = {
      ...structuredClone(original),
      needsRebuild: true,
      appendReady: false
    };
  }
}

function commitDuplicatesOrQueue(index, found, duplicates, cli, sessionIdentity) {
  const committed = commitDuplicateGroup(index, duplicates, cli, sessionIdentity);
  for (const file of committed.revalidate) enqueueIdentityRevalidation(found, file);
  return committed.changed;
}

function enqueueDuplicateFallback(found, failedFile, { excludeAttempted = false } = {}) {
  const attempted = failedFile.attemptedGroupPaths || new Set([failedFile.path]);
  const group = [failedFile, ...(failedFile.duplicateFiles || [])];
  const candidates = [];
  for (const candidate of group) {
    if (attempted.has(candidate.path)) continue;
    try {
      candidates.push({ file: candidate, size: fs.statSync(candidate.path).size });
    } catch { /* another group member may still be available */ }
  }
  if (!candidates.length) return false;
  const fallback = candidates.reduce(
    (best, candidate) => candidate.size > best.size ? candidate : best
  ).file;
  attempted.add(fallback.path);
  fallback.attemptedGroupPaths = attempted;
  fallback.duplicateFiles = group.filter((candidate) => (
    candidate.path !== fallback.path
    && (!excludeAttempted || !attempted.has(candidate.path))
  ));
  found.push(fallback);
  return true;
}

function deduplicateIndexedSessions(index, foundPaths) {
  const groups = new Map();
  for (const [filePath, entry] of Object.entries(index.files)) {
    const identity = entry.sessionIdentity || filenameSessionIdentity(filePath);
    if (!identity) continue;
    const key = `${entry.cli}:${identity}`;
    const group = groups.get(key) || [];
    group.push(filePath);
    groups.set(key, group);
  }

  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const live = group.filter((filePath) => foundPaths.has(filePath));
    const candidates = live.length ? live : group;
    const winner = candidates.reduce((best, filePath) => {
      if (!best) return filePath;
      return (index.files[filePath]?.size || 0) > (index.files[best]?.size || 0)
        ? filePath
        : best;
    }, null);
    for (const filePath of group) {
      if (filePath === winner) continue;
      if (moveIndexedFileToDuplicate(index, filePath)) removed += 1;
    }
    delete index.duplicates[winner];
  }
  return removed;
}

function migrateVersionTwoIndex(dataDir, parsed) {
  const index = {
    ...parsed,
    version: INDEX_VERSION,
    lastReconciledAt: 0,
    files: {},
    duplicates: {}
  };
  const knownIdentities = new Set();

  for (const [filePath, entry] of Object.entries(parsed.files || {})) {
    const identity = entry.sessionIdentity || filenameSessionIdentity(filePath);
    if (identity) knownIdentities.add(`${entry.cli}:${identity}`);
    index.files[filePath] = {
      ...entry,
      parserState: null,
      appendReady: false,
      needsRebuild: true,
      missing: false,
      missingSince: null
    };
  }

  // Version 2 deleted an indexed contribution as soon as Claude Code removed
  // its transcript. Recover exact historical aggregates still present in the
  // legacy cache. A matching session identity is already represented by the v2 index
  // (possibly at a new path), so do not import it a second time.
  const legacy = legacyIndex(dataDir);
  for (const [filePath, entry] of Object.entries(legacy.files)) {
    const identity = entry.sessionIdentity || filenameSessionIdentity(filePath);
    const identityKey = identity ? `${entry.cli}:${identity}` : null;
    if (index.files[filePath] || (identityKey && knownIdentities.has(identityKey))) continue;
    if (identityKey) knownIdentities.add(identityKey);
    index.files[filePath] = {
      ...entry,
      missing: true,
      missingSince: null
    };
  }

  return index;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validIndexShape(parsed) {
  return Boolean(
    plainObject(parsed)
    && plainObject(parsed.files)
    && Object.values(parsed.files).every((entry) => (
      plainObject(entry)
      && typeof entry.cli === "string"
      && plainObject(entry.contribution)
      && plainObject(entry.projectContribution)
      && plainObject(entry.minuteContribution)
    ))
    && (parsed.duplicates === undefined || plainObject(parsed.duplicates))
  );
}

function migratePreviousIndex(dataDir, parsed) {
  const prior = parsed.version === 2 ? migrateVersionTwoIndex(dataDir, parsed) : parsed;
  const index = {
    ...prior,
    version: INDEX_VERSION,
    lastReconciledAt: 0,
    needsClaudeRebuild: true,
    files: {},
    duplicates: plainObject(prior.duplicates) ? prior.duplicates : {}
  };
  for (const [filePath, entry] of Object.entries(prior.files || {})) {
    const sessionIdentity = (
      entry.sessionIdentity
      || entry.parserState?.sessionIdentity
      || filenameSessionIdentity(filePath)
      || null
    );
    index.files[filePath] = {
      ...entry,
      sessionIdentity,
      parserState: null,
      appendReady: false,
      needsRebuild: true,
      ...(entry.cli === "claude" ? {
        claudeEvents: {},
        unkeyedContribution: structuredClone(entry.contribution || {}),
        unkeyedProjectContribution: structuredClone(entry.projectContribution || {}),
        unkeyedMinuteContribution: structuredClone(entry.minuteContribution || {})
      } : {})
    };
  }
  return index;
}

function loadUsageIndex(dataDir) {
  if (!dataDir) return freshIndex();
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, INDEX_FILE), "utf8")
    );
    if (
      parsed.version === INDEX_VERSION
      && validIndexShape(parsed)
    ) {
      if (!parsed.duplicates || typeof parsed.duplicates !== "object") {
        parsed.duplicates = {};
      }
      return parsed;
    }
    if ((parsed?.version === 2 || parsed?.version === 3) && validIndexShape(parsed)) {
      return migratePreviousIndex(dataDir, parsed);
    }
    // An explicit schema mismatch must rebuild from transcripts. Retained legacy
    // caches may be older than the index they would otherwise replace.
    return freshIndex();
  } catch (error) {
    if (error?.code !== "ENOENT") return freshIndex();
  }
  return legacyIndex(dataDir);
}

function saveUsageIndex(dataDir, index) {
  if (!dataDir) return;
  atomicWriteJsonSync(path.join(dataDir, INDEX_FILE), index, { pretty: false });
}

function emptyFileEntry(cli, sessionIdentity = null, identityScanComplete = false) {
  return {
    mtimeMs: 0,
    size: 0,
    cli,
    dev: null,
    ino: null,
    processedBytes: 0,
    parserState: null,
    sessionIdentity,
    identityScanComplete,
    tailHash: null,
    appendReady: true,
    needsRebuild: false,
    contribution: {},
    projectContribution: {},
    minuteContribution: {},
    ...(cli === "claude" ? {
      claudeEvents: {},
      unkeyedContribution: {},
      unkeyedProjectContribution: {},
      unkeyedMinuteContribution: {}
    } : {})
  };
}

function parseChunk(cli, text, state) {
  return cli === "codex"
    ? parseCodexTranscriptChunk(text, state || {})
    : parseClaudeTranscriptChunk(text, state || {});
}

function parserStateForEntry(entry, cli) {
  const state = structuredClone(entry?.parserState || {});
  if (cli !== "claude") return state;
  state.usageById = Object.fromEntries(
    Object.entries(entry?.claudeEvents || {}).map(([eventId, record]) => [eventId, {
      inputTokens: record.inputTokens || 0,
      cachedReadTokens: record.cachedReadTokens || 0,
      cacheWriteTokens: record.cacheWriteTokens || 0,
      cacheWrite1hTokens: record.cacheWrite1hTokens || 0,
      outputTokens: record.outputTokens || 0
    }])
  );
  return state;
}

function validJsonLine(buffer) {
  const text = buffer.toString("utf8").trim();
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function readAppendedRecords(filePath, cli, startOffset, initialState, targetSize, onRecords) {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let readPosition = startOffset;
  let processedBytes = startOffset;
  let pendingChunks = [];
  let pendingBytes = 0;
  let parserState = initialState || {};
  let bytesRead = 0;

  try {
    while (readPosition < targetSize) {
      const wanted = Math.min(buffer.length, targetSize - readPosition);
      const count = fs.readSync(fd, buffer, 0, wanted, readPosition);
      if (!count) break;
      readPosition += count;
      bytesRead += count;

      const chunk = Buffer.from(buffer.subarray(0, count));
      const newline = chunk.lastIndexOf(0x0a);
      if (newline < 0) {
        pendingChunks.push(chunk);
        pendingBytes += chunk.length;
        if (pendingBytes > MAX_JSONL_LINE_BYTES) {
          throw new Error("Transcript contains an oversized JSONL record.");
        }
        continue;
      }

      const prefix = chunk.subarray(0, newline + 1);
      const complete = pendingChunks.length
        ? Buffer.concat([...pendingChunks, prefix], pendingBytes + prefix.length)
        : prefix;
      const suffix = Buffer.from(chunk.subarray(newline + 1));
      pendingChunks = suffix.length ? [suffix] : [];
      pendingBytes = suffix.length;
      const parsed = parseChunk(cli, complete.toString("utf8"), parserState);
      parserState = parsed.state;
      if (parsed.records.length) onRecords(parsed.records);
      processedBytes += complete.length;
    }

    const pending = pendingChunks.length
      ? Buffer.concat(pendingChunks, pendingBytes)
      : Buffer.alloc(0);
    if (pending.length && validJsonLine(pending)) {
      const parsed = parseChunk(cli, pending.toString("utf8"), parserState);
      parserState = parsed.state;
      if (parsed.records.length) onRecords(parsed.records);
      processedBytes += pending.length;
    }
  } finally {
    fs.closeSync(fd);
  }

  return { bytesRead, parserState, processedBytes };
}

function tailHash(filePath, processedBytes) {
  if (!(processedBytes > 0)) return null;
  const length = Math.min(TAIL_HASH_BYTES, processedBytes);
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, "r");
  try {
    const count = fs.readSync(
      fd,
      buffer,
      0,
      length,
      processedBytes - length
    );
    return crypto
      .createHash("sha256")
      .update(buffer.subarray(0, count))
      .digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function canAppend(entry, filePath, cli, stat) {
  if (!entry?.appendReady || entry.cli !== cli) return false;
  if (entry.dev !== stat.dev || entry.ino !== stat.ino) return false;
  if (!(stat.size > entry.size) || entry.processedBytes > entry.size) return false;
  return entry.tailHash === tailHash(filePath, entry.processedBytes);
}

function transientFileReadError(error) {
  return ["ENOENT", "EACCES", "EPERM", "ESTALE", "EIO", "EBUSY"].includes(error?.code);
}

function pruneRecentMinutes(entry, cutoff) {
  let changed = false;
  const firstMinute = Math.floor(cutoff / 60000) * 60000;
  for (const minute of Object.keys(entry.minuteContribution || {})) {
    if (Number(minute) < firstMinute) {
      delete entry.minuteContribution[minute];
      changed = true;
    }
  }
  return changed;
}

function historyCutoffDay(nowMs) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (HISTORY_RETENTION_DAYS - 1));
  return localDay(date.getTime());
}

function pruneDailyHistory(entry, cutoffDay) {
  let changed = false;
  for (const field of ["contribution", "projectContribution"]) {
    for (const day of Object.keys(entry[field] || {})) {
      if (day < cutoffDay) {
        delete entry[field][day];
        changed = true;
      }
    }
  }
  return changed;
}

function hasDailyHistory(entry) {
  return Object.keys(entry.contribution || {}).length > 0;
}

function pruneClaudeEvents(entry, cutoffDay) {
  let changed = false;
  for (const [eventId, record] of Object.entries(entry.claudeEvents || {})) {
    if (!record || record.day < cutoffDay) {
      delete entry.claudeEvents[eventId];
      changed = true;
    }
  }
  return changed;
}

function rebuildClaudeContributions(index, cutoffDay, cutoffMinute) {
  const seenEvents = new Set();
  for (const filePath of Object.keys(index.files).sort()) {
    const entry = index.files[filePath];
    if (entry.cli !== "claude") continue;
    pruneClaudeEvents(entry, cutoffDay);
    entry.contribution = structuredClone(entry.unkeyedContribution || {});
    entry.projectContribution = structuredClone(entry.unkeyedProjectContribution || {});
    entry.minuteContribution = structuredClone(entry.unkeyedMinuteContribution || {});
    for (const [eventId, record] of Object.entries(entry.claudeEvents || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (seenEvents.has(eventId)) continue;
      seenEvents.add(eventId);
      mergeContribution(entry.contribution, recordsToContribution([record]));
      mergeProjectContribution(
        entry.projectContribution,
        recordsToProjectContribution([record], filePath, "claude")
      );
      mergeContribution(entry.minuteContribution, recordsToMinuteContribution([record]));
    }
    pruneDailyHistory(entry, cutoffDay);
    pruneRecentMinutes(entry, cutoffMinute);
  }
}

function updateUsageIndex({
  homeDir,
  dataDir = null,
  nowMs = Date.now(),
  extraRoots = {},
  index: providedIndex = null,
  forceRebuild = false
}) {
  const index = providedIndex || loadUsageIndex(dataDir);
  if (!index.duplicates || typeof index.duplicates !== "object") index.duplicates = {};
  let dirty = false;
  let claudeDirty = index.needsClaudeRebuild === true;
  let rebuiltSinceCheckpoint = 0;
  if (forceRebuild) {
    if (Object.keys(index.duplicates).length) {
      index.duplicates = {};
      dirty = true;
    }
    for (const entry of Object.values(index.files)) {
      entry.needsRebuild = true;
      entry.appendReady = false;
      if (entry.cli === "claude") claudeDirty = true;
    }
    dirty = true;
    if (claudeDirty) index.needsClaudeRebuild = true;
  }
  const discovered = listAllTranscriptFiles(homeDir, extraRoots);
  const discoveredPaths = new Set(discovered.map(({ path: filePath }) => filePath));
  const { selected: found } = deduplicateFoundTranscripts(discovered, index, {
    preferExisting: !forceRebuild,
    revalidateAggregateLosers: forceRebuild
  });
  for (const file of found) {
    file.attemptedGroupPaths = new Set([file.path]);
  }
  for (const filePath of Object.keys(index.duplicates)) {
    if (!discoveredPaths.has(filePath)) {
      delete index.duplicates[filePath];
      dirty = true;
    }
  }
  const foundPaths = new Set(found.map(({ path: filePath }) => filePath));
  for (const file of found) {
    for (const duplicate of file.duplicateFiles || []) {
      foundPaths.add(duplicate.path);
    }
  }
  const missingByIdentity = new Map();
  const missingBySessionIdentity = new Map();
  for (const [filePath, entry] of Object.entries(index.files)) {
    if (foundPaths.has(filePath)) continue;
    if (
      entry.dev !== null
      && entry.dev !== undefined
      && entry.ino !== null
      && entry.ino !== undefined
    ) missingByIdentity.set(`${entry.cli}:${entry.dev}:${entry.ino}`, filePath);
    const sessionIdentity = entry.sessionIdentity || filenameSessionIdentity(filePath);
    if (sessionIdentity) {
      const key = `${entry.cli}:${sessionIdentity}`;
      const paths = missingBySessionIdentity.get(key) || [];
      paths.push(filePath);
      missingBySessionIdentity.set(key, paths);
    }
  }
  const reconcile = (
    !Number.isFinite(index.lastReconciledAt)
    || nowMs - index.lastReconciledAt >= RECONCILE_INTERVAL_MS
  );
  const identityBytesRead = discovered.reduce(
    (total, file) => total + (file.identityBytesRead || 0),
    0
  );
  const stats = {
    discoveredFiles: found.length,
    appendedFiles: 0,
    rebuiltFiles: 0,
    removedFiles: 0,
    retainedMissingFiles: 0,
    identityBytesRead,
    parserBytesRead: 0,
    bytesRead: 0
  };
  const dailyCutoff = historyCutoffDay(nowMs);
  const cutoff = nowMs - RECENT_LOOKBACK_MS;

  if (reconcile) {
    for (const filePath of Object.keys(index.files)) {
      if (!foundPaths.has(filePath)) {
        const entry = index.files[filePath];
        entry.missing = true;
        entry.missingSince = entry.missingSince || nowMs;
        pruneDailyHistory(entry, dailyCutoff);
        pruneRecentMinutes(entry, cutoff);
        if (entry.cli === "claude") {
          pruneClaudeEvents(entry, dailyCutoff);
          claudeDirty = true;
        }
        if (hasDailyHistory(entry)) {
          stats.retainedMissingFiles += 1;
        } else {
          delete index.files[filePath];
          stats.removedFiles += 1;
        }
        dirty = true;
      }
    }
    index.lastReconciledAt = nowMs;
    dirty = true;
  }

  for (const file of found) {
    const revalidationTransaction = file.aggregateRevalidationTransaction;
    if (revalidationTransaction?.failed) continue;
    const {
      path: filePath,
      cli,
      sessionIdentity = null,
      identityScanComplete = false,
      duplicateFiles = []
    } = file;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      foundPaths.delete(filePath);
      discoveredPaths.delete(filePath);
      if (revalidationTransaction) {
        failAggregateRevalidation(index, revalidationTransaction);
        dirty = true;
      } else {
        enqueueDuplicateFallback(found, file);
      }
      continue;
    }

    let entry = index.files[filePath];
    let pendingPreviousPath = null;
    let pendingPreviousEntry = null;
    let pendingMatchingSessionPaths = [];
    let pendingInodeKey = null;
    let pendingSessionKey = null;
    if (!entry) {
      const inodeKey = `${cli}:${stat.dev}:${stat.ino}`;
      const sessionKey = sessionIdentity ? `${cli}:${sessionIdentity}` : null;
      const matchingSessionPaths = sessionKey
        ? missingBySessionIdentity.get(sessionKey) || []
        : [];
      const previousPath = missingByIdentity.get(inodeKey) || matchingSessionPaths[0];
      if (previousPath && index.files[previousPath]) {
        entry = index.files[previousPath];
        pendingPreviousPath = previousPath;
        pendingPreviousEntry = entry;
        pendingMatchingSessionPaths = matchingSessionPaths;
        pendingInodeKey = inodeKey;
        pendingSessionKey = sessionKey;
      }
    }
    const identityMatches = (
      entry?.dev === null && entry?.ino === null && entry?.appendReady === false
    ) || (
      entry?.dev === stat.dev && entry?.ino === stat.ino
    );
      const unchanged = entry
      && !file.requiresFullRevalidation
      && !entry.needsRebuild
      && entry.mtimeMs === stat.mtimeMs
      && entry.size === stat.size
      && entry.cli === cli
      && identityMatches;
    if (unchanged) {
      if (pendingPreviousPath) {
        delete index.files[pendingPreviousPath];
        for (const duplicatePath of pendingMatchingSessionPaths) {
          if (duplicatePath !== pendingPreviousPath) delete index.files[duplicatePath];
        }
        index.files[filePath] = entry;
        missingByIdentity.delete(pendingInodeKey);
        if (pendingSessionKey) missingBySessionIdentity.delete(pendingSessionKey);
        dirty = true;
        if (cli === "claude") claudeDirty = true;
      }
      if (sessionIdentity && !entry.sessionIdentity) {
        entry.sessionIdentity = sessionIdentity;
        dirty = true;
      }
      if (identityScanComplete && !entry.identityScanComplete) {
        entry.identityScanComplete = true;
        dirty = true;
      }
      if (entry.missing || entry.missingSince) {
        entry.missing = false;
        entry.missingSince = null;
        dirty = true;
      }
      if (pruneRecentMinutes(entry, cutoff) || pruneDailyHistory(entry, dailyCutoff)) {
        dirty = true;
        if (cli === "claude") claudeDirty = true;
      }
      if (
        sessionIdentity
        && entry.sessionIdentity === sessionIdentity
        && commitDuplicatesOrQueue(index, found, duplicateFiles, cli, sessionIdentity)
      ) {
        dirty = true;
        if (cli === "claude") claudeDirty = true;
      }
      if (index.duplicates[filePath]) {
        delete index.duplicates[filePath];
        dirty = true;
      }
      continue;
    }

    let append;
    let result;
    let nextTailHash;
    let nextEntry;
    try {
      append = !file.requiresFullRevalidation && canAppend(entry, filePath, cli, stat);
      nextEntry = append
        ? structuredClone(entry)
        : emptyFileEntry(cli, sessionIdentity, identityScanComplete);
      const startOffset = append ? nextEntry.processedBytes : 0;
      const parserState = append
        ? parserStateForEntry(nextEntry, cli)
        : null;
      result = readAppendedRecords(
        filePath,
        cli,
        startOffset,
        parserState,
        stat.size,
        (records) => appendRecords(nextEntry, records, filePath, cli)
      );
      nextTailHash = tailHash(filePath, result.processedBytes);
    } catch (error) {
      if (!transientFileReadError(error)) throw error;
      if (error?.code === "ENOENT") {
        foundPaths.delete(filePath);
        discoveredPaths.delete(filePath);
      }
      if (revalidationTransaction) {
        failAggregateRevalidation(index, revalidationTransaction);
        dirty = true;
      } else {
        enqueueDuplicateFallback(found, file);
      }
      continue;
    }
    entry = nextEntry;

    entry.mtimeMs = stat.mtimeMs;
    entry.size = stat.size;
    entry.cli = cli;
    entry.dev = stat.dev;
    entry.ino = stat.ino;
    entry.processedBytes = result.processedBytes;
    entry.parserState = result.parserState;
    if (cli === "claude" && entry.parserState) {
      delete entry.parserState.usageById;
      delete entry.parserState.seenIds;
    }
    const parsedSessionIdentity = result.parserState.sessionIdentity || null;
    const currentFilenameIdentity = filenameSessionIdentity(filePath);
    entry.sessionIdentity = (
      cli === "claude"
      && currentFilenameIdentity?.startsWith("agent-")
      && !parsedSessionIdentity?.startsWith("agent-")
    )
      ? currentFilenameIdentity
      : (parsedSessionIdentity || currentFilenameIdentity || null);
    entry.identityScanComplete = true;
    entry.tailHash = nextTailHash;
    entry.appendReady = true;
    entry.needsRebuild = false;
    entry.missing = false;
    entry.missingSince = null;
    pruneRecentMinutes(entry, cutoff);
    pruneDailyHistory(entry, dailyCutoff);
    if (cli === "claude") {
      pruneClaudeEvents(entry, dailyCutoff);
      claudeDirty = true;
    }
    const confirmedDiscoveryIdentity = (
      sessionIdentity
      && entry.sessionIdentity === sessionIdentity
    );
    if (confirmedDiscoveryIdentity) {
      if (
        commitDuplicatesOrQueue(index, found, duplicateFiles, cli, sessionIdentity)
      ) {
        dirty = true;
        if (cli === "claude") claudeDirty = true;
      }
    }
    if (pendingPreviousPath) {
      const previousIdentity = (
        pendingPreviousEntry.sessionIdentity
        || filenameSessionIdentity(pendingPreviousPath)
      );
      const samePreviousInode = (
        pendingPreviousEntry.dev === stat.dev
        && pendingPreviousEntry.ino === stat.ino
      );
      const confirmedPreviousSession = (
        sessionIdentity
        && entry.sessionIdentity === sessionIdentity
        && previousIdentity === sessionIdentity
      );
      if (samePreviousInode || confirmedPreviousSession) {
        delete index.files[pendingPreviousPath];
        for (const duplicatePath of pendingMatchingSessionPaths) {
          if (duplicatePath !== pendingPreviousPath) delete index.files[duplicatePath];
        }
        missingByIdentity.delete(pendingInodeKey);
        if (pendingSessionKey) missingBySessionIdentity.delete(pendingSessionKey);
      }
    }
    if (index.duplicates[filePath]) delete index.duplicates[filePath];
    index.files[filePath] = entry;
    if (sessionIdentity && entry.sessionIdentity !== sessionIdentity) {
      enqueueDuplicateFallback(found, file, { excludeAttempted: true });
    }

    stats.parserBytesRead += result.bytesRead;
    stats.bytesRead += result.bytesRead;
    if (append) stats.appendedFiles += 1;
    else {
      stats.rebuiltFiles += 1;
      rebuiltSinceCheckpoint += 1;
    }
    dirty = true;
    if (
      dataDir
      && rebuiltSinceCheckpoint >= REBUILD_CHECKPOINT_FILES
    ) {
      if (claudeDirty) index.needsClaudeRebuild = true;
      saveUsageIndex(dataDir, index);
      rebuiltSinceCheckpoint = 0;
    }
  }

  const claudePathsBeforeDedup = Object.entries(index.files)
    .filter(([, entry]) => entry.cli === "claude")
    .map(([filePath]) => filePath)
    .sort()
    .join("\n");
  if (deduplicateIndexedSessions(index, foundPaths)) {
    dirty = true;
    const claudePathsAfterDedup = Object.entries(index.files)
      .filter(([, entry]) => entry.cli === "claude")
      .map(([filePath]) => filePath)
      .sort()
      .join("\n");
    if (claudePathsAfterDedup !== claudePathsBeforeDedup) claudeDirty = true;
  }

  if (claudeDirty) {
    rebuildClaudeContributions(index, dailyCutoff, cutoff);
    index.needsClaudeRebuild = false;
    dirty = true;
  }

  if (dirty) saveUsageIndex(dataDir, index);
  return { index, stats };
}

module.exports = {
  INDEX_FILE,
  INDEX_VERSION,
  RECONCILE_INTERVAL_MS,
  HISTORY_RETENTION_DAYS,
  loadUsageIndex,
  saveUsageIndex,
  updateUsageIndex
};
