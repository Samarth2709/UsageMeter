const path = require("node:path");

const EMPTY = () => ({
  inputTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  calls: 0
});

function addBuckets(target, src) {
  target.inputTokens += src.inputTokens || 0;
  target.cachedReadTokens += src.cachedReadTokens || 0;
  target.cacheWriteTokens += src.cacheWriteTokens || 0;
  target.outputTokens += src.outputTokens || 0;
  for (const field of [
    "cacheWrite1hTokens",
    "longContextInputTokens",
    "longContextCachedReadTokens",
    "longContextCacheWriteTokens",
    "longContextOutputTokens"
  ]) {
    if (src[field]) target[field] = (target[field] || 0) + src[field];
  }
  target.calls += src.calls || 0;
  return target;
}

function recordsToContribution(records) {
  const contribution = {};
  for (const record of records) {
    const dayMap = (contribution[record.day] = contribution[record.day] || {});
    const key = `${record.cli}::${record.model}`;
    const bucket = dayMap[key] || EMPTY();
    addBuckets(bucket, record);
    bucket.calls += record.isCorrection ? 0 : 1;
    dayMap[key] = bucket;
  }
  return contribution;
}

function projectForRecord(record, filePath, cli) {
  if (typeof record.projectPath === "string" && path.isAbsolute(record.projectPath)) {
    return {
      key: `path:${record.projectPath}`,
      path: record.projectPath,
      label: path.basename(record.projectPath) || record.projectPath,
      parentLabel: path.basename(path.dirname(record.projectPath)) || null
    };
  }

  if (cli === "claude") {
    const parts = filePath.split(path.sep);
    const projectsIndex = parts.lastIndexOf("projects");
    const folder = projectsIndex >= 0 ? parts[projectsIndex + 1] : null;
    if (folder) {
      return {
        key: `claude-folder:${folder}`,
        path: null,
        label: folder,
        parentLabel: null
      };
    }
  }

  return {
    key: "unattributed",
    path: null,
    label: "Unattributed",
    parentLabel: null
  };
}

function recordsToProjectContribution(records, filePath, cli) {
  const contribution = {};
  for (const record of records) {
    const project = projectForRecord(record, filePath, cli);
    const dayMap = (contribution[record.day] = contribution[record.day] || {});
    const entry = (dayMap[project.key] = dayMap[project.key] || {
      ...project,
      models: {}
    });
    const modelKey = `${record.cli}::${record.model}`;
    const bucket = entry.models[modelKey] || EMPTY();
    addBuckets(bucket, record);
    bucket.calls += record.isCorrection ? 0 : 1;
    entry.models[modelKey] = bucket;
  }
  return contribution;
}

function recordsToMinuteContribution(records) {
  const contribution = {};
  for (const record of records) {
    const minute = String(Math.floor(record.timestampMs / 60000) * 60000);
    const modelKey = `${record.cli}::${record.model}`;
    const minuteMap = (contribution[minute] = contribution[minute] || {});
    const bucket = minuteMap[modelKey] || EMPTY();
    addBuckets(bucket, record);
    bucket.calls += record.isCorrection ? 0 : 1;
    minuteMap[modelKey] = bucket;
  }
  return contribution;
}

function mergeContribution(target, source) {
  for (const [outerKey, sourceBuckets] of Object.entries(source || {})) {
    const targetBuckets = (target[outerKey] = target[outerKey] || {});
    for (const [key, bucket] of Object.entries(sourceBuckets)) {
      targetBuckets[key] = addBuckets(targetBuckets[key] || EMPTY(), bucket);
    }
  }
  return target;
}

function mergeProjectContribution(target, source) {
  for (const [day, projects] of Object.entries(source || {})) {
    const targetProjects = (target[day] = target[day] || {});
    for (const [projectKey, project] of Object.entries(projects)) {
      const targetProject = (targetProjects[projectKey] = targetProjects[projectKey] || {
        key: project.key,
        path: project.path || null,
        label: project.label || "Unattributed",
        parentLabel: project.parentLabel || null,
        models: {}
      });
      for (const [modelKey, bucket] of Object.entries(project.models || {})) {
        targetProject.models[modelKey] = addBuckets(
          targetProject.models[modelKey] || EMPTY(),
          bucket
        );
      }
    }
  }
  return target;
}

function appendRecords(entry, records, filePath, cli) {
  if (cli === "claude") {
    entry.claudeEvents = entry.claudeEvents || {};
    const unkeyed = [];
    for (const record of records) {
      if (!record.eventId) {
        unkeyed.push(record);
        continue;
      }
      const previous = entry.claudeEvents[record.eventId];
      if (previous && record.isCorrection) {
        const corrected = { ...previous };
        addBuckets(corrected, record);
        corrected.timestampMs = record.timestampMs;
        corrected.day = record.day;
        corrected.model = record.model;
        corrected.projectPath = record.projectPath || previous.projectPath;
        corrected.isSidechain = record.isSidechain;
        corrected.isCorrection = false;
        corrected.calls = 0;
        entry.claudeEvents[record.eventId] = corrected;
      } else if (!previous) {
        entry.claudeEvents[record.eventId] = {
          ...record,
          isCorrection: false,
          calls: 0
        };
      }
    }
    if (!unkeyed.length) return;
    entry.unkeyedContribution = entry.unkeyedContribution || {};
    entry.unkeyedProjectContribution = entry.unkeyedProjectContribution || {};
    entry.unkeyedMinuteContribution = entry.unkeyedMinuteContribution || {};
    mergeContribution(entry.unkeyedContribution, recordsToContribution(unkeyed));
    mergeProjectContribution(
      entry.unkeyedProjectContribution,
      recordsToProjectContribution(unkeyed, filePath, cli)
    );
    mergeContribution(entry.unkeyedMinuteContribution, recordsToMinuteContribution(unkeyed));
    return;
  }
  mergeContribution(entry.contribution, recordsToContribution(records));
  mergeProjectContribution(
    entry.projectContribution,
    recordsToProjectContribution(records, filePath, cli)
  );
  mergeContribution(
    entry.minuteContribution,
    recordsToMinuteContribution(records)
  );
}

module.exports = {
  EMPTY,
  addBuckets,
  appendRecords,
  mergeContribution,
  mergeProjectContribution,
  projectForRecord,
  recordsToContribution,
  recordsToMinuteContribution,
  recordsToProjectContribution
};
