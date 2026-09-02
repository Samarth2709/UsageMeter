const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { getClaudeAuthStatus, _test } = require("../server");
const packageJson = require("../package.json");

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fakeJwt(payload) {
  return `${base64UrlJson({ alg: "none" })}.${base64UrlJson(payload)}.signature`;
}

test("default config does not pre-create Codex account slots", () => {
  const config = _test.defaultConfig();

  assert.deepEqual(
    config.identities.map((identity) => identity.id),
    ["claude-1"]
  );
  assert.deepEqual(
    config.identities.map((identity) => identity.type),
    ["claude"]
  );
});

test("an explicit empty identity list stays empty while a missing list gets the default Claude slot", () => {
  const normalized = _test.normalizeConfig({ identities: [] });
  const serialized = _test.serializeConfig(normalized);
  const defaults = _test.normalizeConfig({});

  assert.equal(serialized.accounts.length, 0);
  assert.deepEqual(defaults.identities.map((identity) => identity.id), ["claude-1"]);
});

test("logged-out identity state survives normalization and blocks stale refresh data", () => {
  const latest = _test.normalizeConfig({
    identities: [{
      id: "claude-saved",
      type: "claude",
      label: "saved@example.com",
      workspace: process.cwd(),
      email: "saved@example.com",
      loggedOut: true
    }]
  });
  const staleRefresh = _test.normalizeConfig({
    identities: [{
      ...latest.identities[0],
      loggedOut: false,
      lastUsage: {
        service: "claude",
        windows: [{ label: "5-hour", remainingPercent: 87 }]
      }
    }]
  });

  const merged = _test.mergeRefreshedConfig(latest, staleRefresh);

  assert.equal(_test.serializeConfig(latest).accounts[0].loggedOut, true);
  assert.equal(merged.identities[0].loggedOut, true);
  assert.equal(merged.identities[0].lastUsage, null);
});

test("logging out keeps the row while login removal preserves non-secret identity metadata", () => {
  const account = _test.normalizeConfig({
    identities: [{
      id: "codex-saved",
      type: "codex",
      label: "saved@example.com",
      codeHome: "/tmp/codex-saved",
      email: "saved@example.com",
      providerAccountId: "acct_saved",
      lastUsage: { service: "codex", windows: [] }
    }]
  }).identities[0];

  const loggedOut = _test.loggedOutIdentity(account, false);
  assert.equal(loggedOut.id, account.id);
  assert.equal(loggedOut.loggedOut, true);
  assert.equal(loggedOut.email, "saved@example.com");
  assert.equal(loggedOut.lastUsage, null);

  const forgotten = _test.loggedOutIdentity(account, true);
  assert.equal(forgotten.id, account.id);
  assert.equal(forgotten.label, "saved@example.com");
  assert.equal(forgotten.email, "saved@example.com");
  assert.equal(forgotten.providerAccountId, "acct_saved");
  assert.equal(forgotten.lastUsage, null);
});

test("provider logout commands are scoped to the selected row", async () => {
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.join(" ") === "auth status --json") {
      return { stdout: JSON.stringify({ loggedIn: true, email: "saved@example.com" }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  await _test.runLogoutForAccount({
    id: "codex-saved",
    type: "codex",
    codeHome: "/tmp/codex-saved"
  }, false, runCommand);
  await _test.runLogoutForAccount({
    id: "claude-saved",
    type: "claude",
    label: "saved@example.com",
    email: "saved@example.com",
    workspace: "/tmp/claude-saved"
  }, false, runCommand);

  assert.deepEqual(calls[0].args, ["logout"]);
  assert.equal(calls[0].options.env.CODEX_HOME, "/tmp/codex-saved");
  assert.deepEqual(calls[1].args, ["auth", "status", "--json"]);
  assert.deepEqual(calls[2].args, ["auth", "logout"]);
  assert.equal(calls[2].options.cwd, "/tmp/claude-saved");
});

test("Claude logout refuses to sign out a different active account", async () => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify({ loggedIn: true, email: "other@example.com" }),
      stderr: ""
    };
  };

  await assert.rejects(
    _test.runLogoutForAccount({
      id: "claude-saved",
      type: "claude",
      label: "saved@example.com",
      email: "saved@example.com",
      workspace: "/tmp/claude-saved"
    }, false, runCommand),
    /currently logged in as other@example\.com/
  );
  assert.deepEqual(calls, [["auth", "status", "--json"]]);
});

test("Claude logout refuses to act when the selected row has no verifiable identity", async () => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify({ loggedIn: true, email: "active@example.com" }),
      stderr: ""
    };
  };

  await assert.rejects(
    _test.runLogoutForAccount({
      id: "claude-unknown",
      type: "claude",
      label: "Claude",
      workspace: "/tmp/claude-unknown"
    }, false, runCommand),
    /Could not verify the active Claude account/
  );
  assert.deepEqual(calls, [["auth", "status", "--json"]]);
});

test("login removal logs out every matching Codex credential home and leaves unrelated homes alone", async () => {
  const homes = [];
  const account = {
    id: "codex-saved",
    type: "codex",
    label: "saved@example.com",
    codeHome: "/managed/selected",
    email: "saved@example.com",
    providerAccountId: "acct_saved"
  };
  const storedIdentities = [
    { ...account, codeHome: "/managed/copy" },
    {
      id: "codex-other",
      type: "codex",
      label: "other@example.com",
      codeHome: "/managed/other",
      email: "other@example.com",
      providerAccountId: "acct_other"
    }
  ];

  await _test.runLogoutForAccount(account, true, async (command, args, options) => {
    homes.push(options.env.CODEX_HOME);
    return { stdout: "", stderr: "" };
  }, {
    storedIdentities,
    defaultCodexHome: "/default/codex",
    defaultAuth: {
      email: "saved@example.com",
      tokens: { account_id: "acct_saved" }
    }
  });

  assert.deepEqual(homes, ["/managed/selected", "/managed/copy", "/default/codex"]);
});

test("logged-out rows do not attempt a usage refresh", async () => {
  const identity = _test.normalizeConfig({
    identities: [{
      id: "codex-saved",
      type: "codex",
      label: "Saved",
      codeHome: "/path/that/does/not/exist",
      loggedOut: true
    }]
  }).identities[0];

  const result = await _test.refreshIdentity({ identities: [identity] }, identity);

  assert.equal(result.ok, false);
  assert.match(result.error, /logged out/i);
});

test("Codex usage windows use reported durations and do not invent a missing 5-hour limit", () => {
  const windows = _test.normalizeCodexRateWindows({
    secondary_window: {
      used_percent: 43,
      limit_window_seconds: 7 * 24 * 60 * 60,
      reset_after_seconds: 3600,
      reset_at: 1893456000
    }
  });

  assert.deepEqual(windows, [{
    id: "secondary_window",
    label: "weekly",
    usedPercent: 43,
    remainingPercent: 57,
    resetAt: "2030-01-01T00:00:00.000Z",
    resetAfterSeconds: 3600,
    durationSeconds: 7 * 24 * 60 * 60,
    source: "secondary_window"
  }]);
});

test("Codex usage windows fall back to neutral labels when the server omits duration metadata", () => {
  const windows = _test.normalizeCodexRateWindows({
    primary_window: { used_percent: 12, reset_at: 1893456000 },
    secondary_window: { used_percent: 34, reset_at: 1893460000 }
  });

  assert.deepEqual(windows.map((window) => [window.id, window.label, window.durationSeconds]), [
    ["primary_window", "Current allowance", null],
    ["secondary_window", "Secondary allowance", null]
  ]);
});

test("legacy first-run Codex placeholders are filtered out", () => {
  const normalized = _test.normalizeConfig({
    identities: [
      {
        id: "codex-1",
        type: "codex",
        label: "Codex Account 1",
        codeHome: path.join(os.homedir(), ".codex")
      },
      {
        id: "codex-2",
        type: "codex",
        label: "Codex Account 2",
        codeHome: path.join(os.homedir(), ".rate-limit-tool", "codex-account-2")
      },
      {
        id: "claude-1",
        type: "claude",
        label: "Claude Code"
      }
    ]
  });

  assert.deepEqual(
    normalized.identities.map((identity) => identity.id),
    ["claude-1"]
  );
});

test("stored Codex identity homes load dynamically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-codex-"));

  try {
    const firstHome = path.join(root, "first");
    const secondHome = path.join(root, "second");
    const ignoredHome = path.join(root, "ignored");

    await fs.mkdir(firstHome);
    await fs.mkdir(secondHome);
    await fs.mkdir(ignoredHome);
    await fs.writeFile(
      path.join(firstHome, "auth.json"),
      JSON.stringify({
        email: "first@example.com",
        tokens: {
          account_id: "acct_first"
        }
      })
    );
    await fs.writeFile(
      path.join(secondHome, "auth.json"),
      JSON.stringify({
        tokens: {
          account_id: "acct_second"
        }
      })
    );

    const identities = await _test.loadStoredCodexIdentities(root);

    assert.deepEqual(
      identities.map((identity) => identity.providerAccountId),
      ["acct_first", "acct_second"]
    );
    assert.deepEqual(
      identities.map((identity) => identity.codeHome),
      [firstHome, secondHome]
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removing a Codex account deletes every matching UsageMeter auth copy only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-remove-codex-"));
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-external-codex-"));

  try {
    const matchingByEmail = path.join(root, "matching-email");
    const matchingById = path.join(root, "matching-id");
    const otherAccount = path.join(root, "other-account");
    await Promise.all([
      fs.mkdir(matchingByEmail),
      fs.mkdir(matchingById),
      fs.mkdir(otherAccount)
    ]);
    const matchingAuth = JSON.stringify({
      email: "saved@example.com",
      tokens: { account_id: "acct_saved" }
    });
    await Promise.all([
      fs.writeFile(path.join(matchingByEmail, "auth.json"), matchingAuth),
      fs.writeFile(path.join(matchingById, "auth.json"), matchingAuth),
      fs.writeFile(
        path.join(otherAccount, "auth.json"),
        JSON.stringify({ email: "other@example.com", tokens: { account_id: "acct_other" } })
      ),
      fs.writeFile(path.join(externalRoot, "auth.json"), matchingAuth)
    ]);

    const removed = await _test.removeManagedCodexIdentityHomes({
      id: "codex-saved",
      type: "codex",
      email: "saved@example.com",
      providerAccountId: "acct_saved"
    }, root);

    assert.deepEqual(new Set(removed), new Set([matchingByEmail, matchingById]));
    await assert.rejects(fs.access(matchingByEmail), { code: "ENOENT" });
    await assert.rejects(fs.access(matchingById), { code: "ENOENT" });
    await fs.access(otherAccount);
    await fs.access(path.join(externalRoot, "auth.json"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(externalRoot, { recursive: true, force: true });
  }
});

test("a removed identity is filtered from stale config and managed auth hydration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-removed-race-"));
  const account = {
    id: "codex-removed",
    type: "codex",
    label: "Removed",
    codeHome: path.join(root, "removed"),
    email: "removed@example.com",
    providerAccountId: "acct_removed"
  };

  try {
    await fs.mkdir(account.codeHome);
    await fs.writeFile(
      path.join(account.codeHome, "auth.json"),
      JSON.stringify({
        email: account.email,
        tokens: { account_id: account.providerAccountId }
      })
    );
    _test.removedIdentities.set(account.id, account);
    const staleConfig = _test.normalizeConfig({ identities: [account] });
    const hydrated = await _test.hydrateConfigFromStoredIdentities(staleConfig, root);
    const merged = _test.mergeRefreshedConfig({
      identities: [],
      scanRoots: { claude: [], codex: [] }
    }, staleConfig);

    assert.deepEqual(hydrated.identities, []);
    assert.deepEqual(merged.identities, []);
  } finally {
    _test.removedIdentities.delete(account.id);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("managed auth hydration resolves an id collision with an unrelated config identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-hydration-id-"));
  const storedProviderAccountId = "acct_stored";
  const collidingId = _test.buildIdentityId("codex", {
    providerAccountId: storedProviderAccountId
  });

  try {
    const storedHome = path.join(root, "stored");
    await fs.mkdir(storedHome);
    await fs.writeFile(
      path.join(storedHome, "auth.json"),
      JSON.stringify({
        email: "stored@example.com",
        tokens: { account_id: storedProviderAccountId }
      })
    );
    const config = _test.normalizeConfig({
      identities: [{
        id: collidingId,
        type: "codex",
        label: "Configured",
        codeHome: "/tmp/configured-codex",
        email: "configured@example.com",
        providerAccountId: "acct_configured"
      }]
    });
    const hydrated = await _test.hydrateConfigFromStoredIdentities(config, root);

    assert.equal(hydrated.identities.length, 2);
    assert.equal(new Set(hydrated.identities.map((identity) => identity.id)).size, 2);
    assert.deepEqual(
      hydrated.identities.map((identity) => identity.providerAccountId),
      ["acct_configured", storedProviderAccountId]
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a tombstone does not match the same local id with a conflicting provider account", async () => {
  const removed = {
    id: "codex-shared-local-id",
    type: "codex",
    label: "Removed",
    codeHome: "/tmp/codex-removed",
    email: "shared@example.com",
    providerAccountId: "acct_removed"
  };
  const unrelated = {
    ...removed,
    label: "Unrelated",
    codeHome: "/tmp/codex-unrelated",
    providerAccountId: "acct_unrelated"
  };

  try {
    _test.removedIdentities.set(removed.id, removed);
    const refreshed = _test.normalizeConfig({ identities: [unrelated] });
    const merged = _test.mergeRefreshedConfig({
      identities: [],
      scanRoots: { claude: [], codex: [] }
    }, refreshed);

    assert.deepEqual(
      merged.identities.map((identity) => identity.providerAccountId),
      ["acct_unrelated"]
    );
  } finally {
    _test.removedIdentities.delete(removed.id);
  }
});

test("identity serialization preserves last successful usage", () => {
  const normalized = _test.normalizeConfig({
    identities: [
      {
        id: "codex-saved",
        type: "codex",
        label: "Saved Codex",
        codeHome: path.join(os.homedir(), ".rate-limit-tool", "codex-identities", "saved"),
        lastUsage: {
          service: "codex",
          providerAccountId: "acct_saved",
          email: "saved@example.com",
          windows: [
            {
              label: "5-hour",
              remainingPercent: 64,
              resetAt: "2026-05-05T20:00:00.000Z"
            }
          ],
          fetchedAt: "2026-05-05T19:00:00.000Z"
        }
      }
    ]
  });
  const serialized = _test.serializeConfig(normalized);

  assert.equal(serialized.accounts[0].lastUsage.providerAccountId, "acct_saved");
  assert.equal(serialized.accounts[0].lastUsage.windows[0].remainingPercent, 64);
});

test("refresh config merges identity updates without reverting scan roots", () => {
  const latest = _test.normalizeConfig({
    identities: [
      {
        id: "claude-1",
        type: "claude",
        label: "Claude Code",
        workspace: process.cwd()
      }
    ],
    scanRoots: { claude: ["~/new-claude-sessions"], codex: [] }
  });
  const refreshed = _test.normalizeConfig({
    identities: [
      {
        ...latest.identities[0],
        lastUsage: {
          service: "claude",
          windows: [{ label: "5-hour", remainingPercent: 55 }]
        }
      }
    ],
    scanRoots: { claude: [], codex: ["~/stale-codex-sessions"] }
  });

  const merged = _test.mergeRefreshedConfig(latest, refreshed);

  assert.deepEqual(merged.scanRoots, latest.scanRoots);
  assert.equal(merged.identities[0].lastUsage.windows[0].remainingPercent, 55);
});

test("identity refresh metadata merges by stable id before changed email", () => {
  const merged = _test.mergeRefreshedConfig(
    _test.normalizeConfig({
      identities: [{
        id: "codex-stable",
        type: "codex",
        label: "Work",
        codeHome: "/tmp/codex-work",
        email: "old@example.com"
      }]
    }),
    _test.normalizeConfig({
      identities: [{
        id: "codex-stable",
        type: "codex",
        label: "Work",
        codeHome: "/tmp/codex-work",
        email: "new@example.com",
        providerAccountId: "acct-stable"
      }]
    })
  );
  const identities = merged.identities.filter((identity) => identity.type === "codex");
  assert.equal(identities.length, 1);
  assert.equal(identities[0].id, "codex-stable");
  assert.equal(identities[0].email, "new@example.com");
  assert.equal(identities[0].providerAccountId, "acct-stable");
});

test("same email cannot merge identities with conflicting provider ids", () => {
  const normalized = _test.normalizeConfig({
    identities: [
      {
        id: "codex-one",
        type: "codex",
        label: "One",
        codeHome: "/tmp/codex-one",
        email: "shared@example.com",
        providerAccountId: "acct-one"
      },
      {
        id: "codex-two",
        type: "codex",
        label: "Two",
        codeHome: "/tmp/codex-two",
        email: "shared@example.com",
        providerAccountId: "acct-two"
      }
    ]
  });

  assert.deepEqual(
    normalized.identities.filter((identity) => identity.type === "codex").map((identity) => identity.providerAccountId),
    ["acct-one", "acct-two"]
  );
});

test("conflicting provider accounts receive unique local ids and delete independently", () => {
  const normalized = _test.normalizeConfig({
    identities: [
      {
        id: "codex-shared-local-id",
        type: "codex",
        label: "One",
        codeHome: "/tmp/codex-one",
        email: "shared@example.com",
        providerAccountId: "acct-one"
      },
      {
        id: "codex-shared-local-id",
        type: "codex",
        label: "Two",
        codeHome: "/tmp/codex-two",
        email: "shared@example.com",
        providerAccountId: "acct-two"
      }
    ]
  });
  const ids = normalized.identities.map((identity) => identity.id);

  assert.equal(new Set(ids).size, 2);
  const removal = _test.removeIdentityFromConfig(normalized, ids[0]);
  assert.equal(removal.account.providerAccountId, "acct-one");
  assert.deepEqual(
    removal.config.identities.map((identity) => identity.providerAccountId),
    ["acct-two"]
  );
});

test("deleted rows stay deleted across config reload while the provider login remains external", () => {
  const account = {
    id: "codex-saved",
    type: "codex",
    label: "saved@example.com",
    codeHome: "/managed/codex-saved",
    email: "saved@example.com",
    providerAccountId: "acct_saved",
    lastUsage: { service: "codex", windows: [] }
  };
  const normalized = _test.normalizeConfig({ identities: [account] });
  const removal = _test.removeIdentityFromConfig(normalized, account.id);
  const serialized = _test.serializeConfig(removal.config);

  assert.equal(removal.config.identities.length, 0);
  assert.equal(serialized.deletedIdentities.length, 1);
  assert.equal("codeHome" in serialized.deletedIdentities[0], false);
  assert.equal("lastUsage" in serialized.deletedIdentities[0], false);

  const reloaded = _test.normalizeConfig({
    identities: [account],
    deletedIdentities: serialized.deletedIdentities
  });
  assert.equal(reloaded.identities.length, 0);

  const unrelated = _test.normalizeConfig({
    identities: [{
      ...account,
      id: "codex-other",
      email: "other@example.com",
      providerAccountId: "acct_other"
    }],
    deletedIdentities: serialized.deletedIdentities
  });
  assert.equal(unrelated.identities.length, 1);
});

test("a row stays deleted after its saved login has been removed", () => {
  const account = {
    id: "claude-saved",
    type: "claude",
    label: "saved@example.com",
    workspace: "/managed/claude-saved",
    email: "saved@example.com",
    organization: "org-shared"
  };
  const loggedOut = _test.loggedOutIdentity(account, true);
  const normalized = _test.normalizeConfig({ identities: [loggedOut] });
  const removal = _test.removeIdentityFromConfig(normalized, loggedOut.id);
  const serialized = _test.serializeConfig(removal.config);

  const rediscovered = _test.normalizeConfig({
    identities: [{
      ...account,
      id: "claude-rediscovered"
    }],
    deletedIdentities: serialized.deletedIdentities
  });

  assert.equal(rediscovered.identities.length, 0);
});

test("a Claude deletion tombstone does not suppress another user in the same organization", () => {
  const deleted = {
    id: "claude-deleted",
    type: "claude",
    label: "deleted@example.com",
    workspace: "/managed/claude-deleted",
    email: "deleted@example.com",
    organization: "org-shared"
  };
  const other = {
    ...deleted,
    id: "claude-other",
    label: "other@example.com",
    email: "other@example.com"
  };

  const normalized = _test.normalizeConfig({
    identities: [other],
    deletedIdentities: [deleted]
  });

  assert.deepEqual(normalized.identities.map((identity) => identity.email), ["other@example.com"]);
});

test("persistent deletion suppresses matching managed Codex credential hydration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-deleted-hydration-"));
  const account = {
    id: "codex-saved",
    type: "codex",
    label: "saved@example.com",
    email: "saved@example.com",
    providerAccountId: "acct_saved"
  };

  try {
    const storedHome = path.join(root, "saved");
    await fs.mkdir(storedHome);
    await fs.writeFile(path.join(storedHome, "auth.json"), JSON.stringify({
      email: account.email,
      tokens: { account_id: account.providerAccountId }
    }));
    const config = _test.normalizeConfig({
      identities: [],
      deletedIdentities: [account]
    });

    const hydrated = await _test.hydrateConfigFromStoredIdentities(config, root);
    assert.equal(hydrated.identities.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("provider ids that sanitize alike still get distinct local ids and auth homes", () => {
  const first = { providerAccountId: "acct/a" };
  const second = { providerAccountId: "acct-a" };

  assert.notEqual(_test.buildIdentityId("codex", first), _test.buildIdentityId("codex", second));
  assert.notEqual(_test.codexIdentityHome(first), _test.codexIdentityHome(second));
});

test("stable Codex auth replacement is atomic and private", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-auth-copy-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  try {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "auth.json"), '{"token":"one"}\n');
    assert.equal(await _test.copyCodexAuth(source, target), true);
    assert.equal(await fs.readFile(path.join(target, "auth.json"), "utf8"), '{"token":"one"}\n');
    assert.equal((await fs.stat(path.join(target, "auth.json"))).mode & 0o777, 0o600);

    await fs.writeFile(path.join(source, "auth.json"), '{"token":"two"}\n');
    assert.equal(await _test.copyCodexAuth(source, target), true);
    assert.equal(await fs.readFile(path.join(target, "auth.json"), "utf8"), '{"token":"two"}\n');
    assert.deepEqual((await fs.readdir(target)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("provider id is authoritative over changed or shared email metadata", () => {
  assert.equal(_test.usageBelongsToIdentity(
    { providerAccountId: "acct-one", email: "old@example.com" },
    { providerAccountId: "acct-one", email: "new@example.com" }
  ), true);
  assert.equal(_test.usageBelongsToIdentity(
    { providerAccountId: "acct-one", email: "shared@example.com" },
    { providerAccountId: "acct-two", email: "shared@example.com" }
  ), false);
});

test("provider usage cannot claim a same-email identity with a conflicting provider id", () => {
  const identities = [
    { type: "codex", providerAccountId: "acct-one", email: "shared@example.com" },
    { type: "codex", providerAccountId: "acct-two", email: "shared@example.com" }
  ];

  assert.equal(_test.findIdentityForUsage(identities, "codex", {
    providerAccountId: "acct-three",
    email: "shared@example.com"
  }), null);
});

test("Claude usage requires an exact stored organization or email", () => {
  const identities = [{
    id: "claude-one",
    type: "claude",
    email: "one@example.com",
    organization: "org-one"
  }];

  assert.equal(_test.findIdentityForUsage(identities, "claude", {}, { requireStrong: true }), null);
  assert.equal(_test.findIdentityForUsage(identities, "claude", { organization: "org-two" }, { requireStrong: true }), null);
  assert.equal(_test.findIdentityForUsage(identities, "claude", { organization: "org-one" }, { requireStrong: true }), null);
  assert.equal(
    _test.findIdentityForUsage(identities, "claude", {
      organization: "org-one",
      email: "one@example.com"
    }, { requireStrong: true }),
    identities[0]
  );
});

test("Claude OAuth credentials are read from Keychain without exposing a refresh token", async () => {
  const calls = [];
  const credentials = await _test.readClaudeOAuthCredentials(async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: JSON.stringify({
        claudeAiOauth: {
          accessToken: "saved-access-token",
          refreshToken: "must-not-leave-keychain-reader",
          expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
          subscriptionType: "team"
        }
      })
    };
  }, Date.parse("2026-09-02T00:00:00.000Z"));

  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [{
    command: "/usr/bin/security",
    args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"]
  }]);
  assert.equal(credentials.accessToken, "saved-access-token");
  assert.equal(credentials.subscriptionType, "team");
  assert.equal(Object.prototype.hasOwnProperty.call(credentials, "refreshToken"), false);
  assert.equal(calls[0].options.timeout, 10000);
});

test("Claude OAuth credential expiry requires explicit sign-in instead of token refresh", async () => {
  let calls = 0;
  await assert.rejects(
    _test.readClaudeOAuthCredentials(async () => {
      calls += 1;
      return {
        stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-access-token",
            refreshToken: "unused-refresh-token",
            expiresAt: Date.parse("2026-09-01T00:00:00.000Z")
          }
        })
      };
    }, Date.parse("2026-09-02T00:00:00.000Z")),
    /expired.*Sign in/i
  );
  assert.equal(calls, 1);
});

test("Claude usage reads profile and fresh windows directly without launching Claude", async () => {
  const calls = [];
  const data = await _test.fetchClaudeUsage({ type: "claude" }, {
    now: new Date("2026-09-02T12:00:00.000Z"),
    readCredentials: async () => ({
      accessToken: "saved-access-token",
      subscriptionType: "team"
    }),
    requestJson: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      if (url.endsWith("/profile")) {
        return {
          response: { ok: true, status: 200 },
          payload: {
            account: { uuid: "acct-claude", email: "samarthk@cantina.security" },
            organization: { uuid: "org-cantina", rate_limit_tier: "team" }
          }
        };
      }
      return {
        response: { ok: true, status: 200 },
        payload: {
          seven_day: { utilization: 31, resets_at: "2026-09-08T12:00:00.000Z" }
        }
      };
    }
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.anthropic.com/api/oauth/profile",
    "https://api.anthropic.com/api/oauth/usage"
  ]);
  assert.equal(calls.every((call) => call.options.headers.Authorization === "Bearer saved-access-token"), true);
  assert.equal(calls.every((call) => call.options.headers["anthropic-beta"] === "oauth-2025-04-20"), true);
  assert.equal(calls.every((call) => call.timeoutMs === _test.claudeUsageRequestTimeoutMs), true);
  assert.equal(data.providerAccountId, "acct-claude");
  assert.equal(data.email, "samarthk@cantina.security");
  assert.equal(data.organization, "org-cantina");
  assert.deepEqual(data.windows.map((window) => window.label), ["weekly"]);
  assert.equal(data.windows[0].remainingPercent, 69);
});

test("a strongly identified Claude response claims the single default placeholder", async () => {
  const config = _test.normalizeConfig({
    identities: [{
      id: "claude-1",
      type: "claude",
      label: "Claude Code",
      workspace: process.cwd()
    }]
  });
  const data = {
    service: "claude",
    providerAccountId: "acct-cantina",
    email: "samarthk@cantina.security",
    organization: "org-cantina",
    windows: [{ label: "weekly", usedPercent: 15, remainingPercent: 85 }],
    fetchedAt: "2026-09-02T12:00:00.000Z"
  };

  const discovery = await _test.discoverCurrentClaudeIdentity(config, async () => data);

  assert.equal(discovery.ok, true);
  assert.equal(discovery.identity.id, "claude-1");
  assert.equal(config.identities.length, 1);
  assert.equal(config.identities[0].providerAccountId, "acct-cantina");
  assert.equal(config.identities[0].email, "samarthk@cantina.security");
});

test("Claude discovery fails closed when multiple unclaimed rows are ambiguous", async () => {
  const config = _test.normalizeConfig({
    identities: [
      { id: "claude-1", type: "claude", workspace: process.cwd() },
      { id: "claude-2", type: "claude", workspace: process.cwd() }
    ]
  });

  const discovery = await _test.discoverCurrentClaudeIdentity(config, async () => ({
    service: "claude",
    providerAccountId: "acct-cantina",
    email: "samarthk@cantina.security",
    windows: [{ label: "weekly", remainingPercent: 85 }]
  }));

  assert.equal(discovery.ok, false);
  assert.match(discovery.error, /Multiple unclaimed Claude rows/);
  assert.equal(config.identities.length, 2);
  assert.equal(config.identities.every((identity) => !identity.providerAccountId), true);
});

test("Claude discovery respects deletion tombstones and never recreates the account", async () => {
  const deleted = {
    id: "claude-cantina",
    type: "claude",
    email: "samarthk@cantina.security",
    providerAccountId: "acct-cantina",
    organization: "org-cantina"
  };
  const config = _test.normalizeConfig({ identities: [], deletedIdentities: [deleted] });

  const discovery = await _test.discoverCurrentClaudeIdentity(config, async () => ({
    service: "claude",
    ...deleted,
    windows: [{ label: "weekly", remainingPercent: 85 }]
  }));

  assert.equal(discovery.ok, false);
  assert.match(discovery.error, /deleted from Usage Meter/);
  assert.equal(config.identities.length, 0);
});

test("Claude discovery cannot repaint a logged-out identity", async () => {
  const config = _test.normalizeConfig({
    identities: [{
      id: "claude-cantina",
      type: "claude",
      email: "samarthk@cantina.security",
      providerAccountId: "acct-cantina",
      organization: "org-cantina",
      workspace: process.cwd(),
      loggedOut: true
    }]
  });

  const discovery = await _test.discoverCurrentClaudeIdentity(config, async () => ({
    service: "claude",
    email: "samarthk@cantina.security",
    providerAccountId: "acct-cantina",
    organization: "org-cantina",
    windows: [{ label: "weekly", remainingPercent: 85 }]
  }));

  assert.equal(discovery.ok, false);
  assert.match(discovery.error, /logged out/);
  assert.equal(config.identities[0].loggedOut, true);
  assert.equal(config.identities[0].lastUsage, null);
});

test("a partial fresh Claude response drops cached windows absent from the API", async () => {
  const config = _test.normalizeConfig({
    identities: [{
      id: "claude-cantina",
      type: "claude",
      email: "samarthk@cantina.security",
      providerAccountId: "acct-cantina",
      workspace: process.cwd(),
      lastUsage: {
        service: "claude",
        providerAccountId: "acct-cantina",
        email: "samarthk@cantina.security",
        fetchedAt: "2026-09-01T12:00:00.000Z",
        windows: [
          { label: "5-hour", remainingPercent: 40 },
          { label: "weekly", remainingPercent: 70 }
        ]
      }
    }]
  });

  const discovery = await _test.discoverCurrentClaudeIdentity(config, async () => ({
    service: "claude",
    providerAccountId: "acct-cantina",
    email: "samarthk@cantina.security",
    fetchedAt: "2026-09-02T12:00:00.000Z",
    windows: [{ label: "weekly", remainingPercent: 65 }]
  }));

  assert.equal(discovery.ok, true);
  assert.deepEqual(config.identities[0].lastUsage.windows.map((window) => window.label), ["weekly"]);
  assert.equal(config.identities[0].lastUsage.windows[0].remainingPercent, 65);
});

test("refresh falls back to last successful usage when live auth is unavailable", async () => {
  const config = { identities: [] };
  const identity = _test.normalizeConfig({
    identities: [
      {
        id: "codex-offline",
        type: "codex",
        label: "Offline Codex",
        codeHome: path.join(os.tmpdir(), "usage-meter-missing-auth"),
        lastUsage: {
          service: "codex",
          providerAccountId: "acct_offline",
          windows: [
            {
              label: "5-hour",
              remainingPercent: 42
            }
          ]
        }
      }
    ]
  }).identities[0];

  const result = await _test.refreshIdentity(config, identity);

  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
  assert.equal(result.data.providerAccountId, "acct_offline");
  assert.match(result.error, /No saved Codex auth/);
});

test("expired saved Codex auth refreshes before usage lookup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-codex-auth-"));
  const authPath = path.join(root, "auth.json");
  const originalFetch = global.fetch;
  const calls = [];

  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: fakeJwt({ exp: 1 }),
        refresh_token: "saved-refresh-token",
        id_token: "saved-id-token",
        account_id: "acct_saved"
      }
    })
  );

  global.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      headers: options.headers,
      body: options.body?.toString()
    });

    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({
        access_token: fakeJwt({ exp: 4102444800 }),
        refresh_token: "rotated-refresh-token",
        id_token: "rotated-id-token"
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    assert.equal(options.headers.Authorization.startsWith("Bearer "), true);
    assert.notEqual(options.headers.Authorization, `Bearer ${fakeJwt({ exp: 1 })}`);
    assert.equal(options.headers["ChatGPT-Account-ID"], "acct_saved");

    return new Response(JSON.stringify({
      email: "saved@example.com",
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 25,
          reset_at: 1893456000,
          reset_after_seconds: 60
        }
      },
      credits: {
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: 0
      }
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  try {
    const data = await _test.fetchCodexUsage({
      id: "codex-saved",
      type: "codex",
      label: "Saved Codex",
      codeHome: root
    });
    const savedAuth = JSON.parse(await fs.readFile(authPath, "utf8"));

    assert.deepEqual(
      calls.map((call) => call.url.includes("/oauth/token") ? "refresh" : "usage"),
      ["refresh", "usage"]
    );
    assert.match(calls[0].body, /grant_type=refresh_token/);
    assert.match(calls[0].body, /refresh_token=saved-refresh-token/);
    assert.equal(savedAuth.tokens.refresh_token, "rotated-refresh-token");
    assert.equal(savedAuth.tokens.id_token, "rotated-id-token");
    assert.equal(savedAuth.tokens.account_id, "acct_saved");
    assert.equal(data.providerAccountId, "acct_saved");
    assert.equal(data.email, "saved@example.com");
  } finally {
    global.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejected saved Codex access token refreshes and retries usage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-codex-retry-"));
  const authPath = path.join(root, "auth.json");
  const originalFetch = global.fetch;
  const calls = [];

  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: fakeJwt({ exp: 4102444800 }),
        refresh_token: "retry-refresh-token",
        account_id: "acct_retry"
      }
    })
  );

  global.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      authorization: options.headers?.Authorization || null
    });

    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({
        access_token: "retry-access-token"
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    if (calls.filter((call) => !call.url.includes("/oauth/token")).length === 1) {
      return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
    }

    assert.equal(options.headers.Authorization, "Bearer retry-access-token");

    return new Response(JSON.stringify({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 10,
          reset_at: 1893456000,
          reset_after_seconds: 60
        }
      },
      credits: {}
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  try {
    const data = await _test.fetchCodexUsage({
      id: "codex-retry",
      type: "codex",
      label: "Retry Codex",
      codeHome: root
    });
    const savedAuth = JSON.parse(await fs.readFile(authPath, "utf8"));

    assert.deepEqual(
      calls.map((call) => call.url.includes("/oauth/token") ? "refresh" : "usage"),
      ["usage", "refresh", "usage"]
    );
    assert.equal(savedAuth.tokens.access_token, "retry-access-token");
    assert.equal(savedAuth.tokens.refresh_token, "retry-refresh-token");
    assert.equal(savedAuth.tokens.account_id, "acct_retry");
    assert.equal(data.providerAccountId, "acct_retry");
  } finally {
    global.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refreshed Codex auth keeps the existing refresh token when none is returned", () => {
  const merged = _test.mergeRefreshedCodexAuth(
    {
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        account_id: "acct_existing"
      }
    },
    {
      access_token: "new-access"
    },
    new Date("2026-05-02T12:00:00.000Z")
  );

  assert.equal(merged.tokens.access_token, "new-access");
  assert.equal(merged.tokens.refresh_token, "old-refresh");
  assert.equal(merged.tokens.account_id, "acct_existing");
  assert.equal(merged.last_refresh, "2026-05-02T12:00:00.000Z");
});

test("Codex access token refresh check respects JWT expiry", () => {
  const now = Date.parse("2026-05-02T12:00:00.000Z");

  assert.equal(_test.codexAccessTokenNeedsRefresh(fakeJwt({ exp: (now / 1000) - 1 }), now), true);
  assert.equal(_test.codexAccessTokenNeedsRefresh(fakeJwt({ exp: (now / 1000) + 120 }), now), false);
});

test("Codex usage requests allow normal network latency", () => {
  assert.equal(_test.codexUsageRequestTimeoutMs >= 5000, true);
});

test("Claude reset text parses into a concrete future timestamp", () => {
  const now = new Date(2026, 4, 2, 15, 0, 0, 0);
  const expected = new Date(2026, 4, 2, 17, 0, 0, 0).toISOString();

  assert.equal(_test.parseClaudeResetAt("May 2 at 5pm", now), expected);
});

test("Claude 5-hour windows reject a stale time rolled into the next day", () => {
  const now = new Date("2026-07-27T21:32:01.798Z");
  const screen = [
    "Current session",
    "100% used",
    "Resets 5:20pm (America/New_York)",
    "Current week (all models)",
    "29% used",
    "Resets Aug 3 at 2am (America/New_York)"
  ].join("\n");

  const { windows } = _test.parseClaudeUsageScreen(screen, now);
  const session = windows.find((window) => window.label === "5-hour");

  assert.ok(session, "5-hour window should still be parsed");
  assert.equal(session.resetAt, null);
  assert.equal(session.resetText, null);
});

test("stored Claude usage drops impossible 5-hour reset timestamps", () => {
  const normalized = _test.normalizeConfig({
    identities: [{
      id: "claude-1",
      type: "claude",
      label: "Claude Code",
      workspace: process.cwd(),
      lastUsage: {
        service: "claude",
        fetchedAt: "2026-07-27T21:32:01.798Z",
        windows: [{
          label: "5-hour",
          usedPercent: 100,
          remainingPercent: 0,
          resetText: "5:20pm (America/New_York)",
          resetAt: "2026-07-28T21:20:00.000Z"
        }]
      }
    }]
  });
  const session = normalized.identities[0].lastUsage.windows[0];

  assert.equal(session.resetAt, null);
  assert.equal(session.resetText, null);
});

test("Claude auth status accepts logged-out JSON from a nonzero CLI exit", async () => {
  for (const outputField of ["stdout", "stderr"]) {
    const error = new Error("Command failed");
    error[outputField] = JSON.stringify({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty"
    });

    const result = await getClaudeAuthStatus("/tmp", async () => {
      throw error;
    });

    assert.deepEqual(result, {
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty"
    });
  }
});

test("Claude auth status allows enough time for a cold CLI startup", async () => {
  let receivedOptions = null;

  const result = await getClaudeAuthStatus("/tmp", async (command, args, options) => {
    receivedOptions = options;
    return {
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none" })
    };
  });

  assert.equal(receivedOptions.timeout, 10000);
  assert.deepEqual(result, { loggedIn: false, authMethod: "none" });
});

test("Claude auth status retries one transient cold-start failure", async () => {
  let attempts = 0;

  const result = await getClaudeAuthStatus("/tmp", async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("Cold start failed");
    }
    return {
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none" })
    };
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, { loggedIn: false, authMethod: "none" });
});

test("Claude auth status preserves a failed command with unrelated valid JSON", async () => {
  for (const payload of [{}, { loggedIn: true }, []]) {
    const error = new Error("Command failed");
    error.stdout = JSON.stringify(payload);

    await assert.rejects(
      getClaudeAuthStatus("/tmp", async () => {
        throw error;
      }),
      (received) => received === error
    );
  }
});

test("production package config does not force unsigned mac builds", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(packageJson.build.mac, "identity"), false);
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
});

test("browser server injects the session token without inline script", () => {
  const html = _test.createBrowserIndexHtml("<html><head></head><body></body></html>", 'a"b<c&d');

  assert.match(html, /<meta name="rate-limit-server-token" content="a&quot;b&lt;c&amp;d" \/>/);
  assert.equal(html.includes("window.__RATE_LIMIT_SERVER_TOKEN__"), false);
  assert.equal(html.includes("<script>"), false);
});

test("Claude CLI paths do not use permission bypass flags", async () => {
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");

  assert.equal(serverSource.includes("--dangerously-skip-permissions"), false);
  assert.equal(serverSource.includes("bypassPermissions"), false);
});

test("Electron toggle path does not create implicit globals", async () => {
  const electronSource = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");

  assert.equal(electronSource.includes("lastPopoverBounds"), false);
});

test("Electron refresh uses Keychain-backed Claude usage and never starts Claude automatically", async () => {
  const electronSource = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");

  assert.ok(electronSource.includes("snapshot = await refreshAllAccounts()"));
  assert.ok(serverSource.includes('"/usr/bin/security"'));
  assert.ok(serverSource.includes("async function fetchClaudeUsage"));
  assert.ok(serverSource.includes("async function discoverCurrentClaudeIdentity"));
  assert.equal(electronSource.includes("persist:claude-usage"), false);
  assert.equal(electronSource.includes("claude.ai/settings/usage"), false);
  assert.equal(electronSource.includes("forceClaudeCliUsage"), false);
  assert.equal(electronSource.includes("claudeCliUsageRefreshMs"), false);
  assert.equal(electronSource.includes("refreshClaudeCliUsage"), false);
  assert.equal(serverSource.includes("refreshToken: firstString(oauth?.refreshToken)"), false);
  assert.equal(serverSource.includes("async function captureClaudeUsage"), false);
  assert.equal(serverSource.includes("async function triggerClaudeTimer"), false);
  assert.equal(
    (serverSource.match(/\bclaudeBin\b/g) || []).length,
    4,
    "Claude executable references must stay limited to its declaration plus explicit auth status, login, and logout"
  );
  assert.match(serverSource, /if \(!account \|\| account\.type === "claude" \|\| !result\.ok\)/);
});

test("Electron account deletion invalidates and reconciles in-flight refresh snapshots", async () => {
  const electronSource = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");

  assert.ok(electronSource.includes("accountMutationGeneration += 1"));
  assert.ok(electronSource.includes("refreshAccountGeneration !== accountMutationGeneration"));
  assert.ok(electronSource.includes("reconcileSnapshotWithConfig(nextSnapshot, currentState.config)"));
});

test("Electron reconciliation cannot repaint a logged-out row from a stale refresh", async () => {
  const electronSource = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const start = electronSource.indexOf("function reconcileSnapshotWithConfig(");
  const end = electronSource.indexOf("function markAccountLoggedOut(", start);
  const context = {};

  vm.runInNewContext(
    `${electronSource.slice(start, end)}\nthis.reconcileSnapshotWithConfig = reconcileSnapshotWithConfig;`,
    context
  );

  const reconciled = context.reconcileSnapshotWithConfig({
    results: [
      { accountId: "claude-1", ok: true, data: { windows: [] } },
      { accountId: "codex-1", ok: true, data: { windows: [] } }
    ]
  }, {
    accounts: [
      { id: "claude-1", loggedOut: true },
      { id: "codex-1" }
    ]
  });

  assert.equal(reconciled.results[0].ok, false);
  assert.match(reconciled.results[0].error, /logged out/i);
  assert.equal(reconciled.results[1].ok, true);
});

test("timed-out live values retain their stale reason for the renderer", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const start = source.indexOf("function preserveRecentSuccessfulResults(");
  const end = source.indexOf("function broadcastSnapshot(", start);
  const context = {};

  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.preserveRecentSuccessfulResults = preserveRecentSuccessfulResults;`,
    context
  );

  const cached = {
    service: "claude",
    windows: [{ label: "5-hour", remainingPercent: 42 }]
  };
  const result = context.preserveRecentSuccessfulResults({
    results: [{
      accountId: "claude-1",
      ok: false,
      error: "Claude usage request timed out."
    }]
  }, {
    results: [{ accountId: "claude-1", ok: true, data: cached }]
  });

  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].stale, true);
  assert.equal(result.results[0].error, "Claude usage request timed out.");
  assert.equal(result.results[0].staleReason, "Claude usage request timed out.");
  assert.equal(result.results[0].data.staleReason, "Claude usage request timed out.");
});

test("parseClaudeUsageScreen uses the all-models weekly limit, not a 0% model-only sub-limit", () => {
  // Mimics the current /status Usage screen, which lists several weekly limits.
  const screen = [
    "Current session",
    "█████████ 19% used",
    "Resets 3:30pm (America/New_York)",
    "Current week (all models)",
    "███████ 14% used",
    "Resets Jun 22 at 2am (America/New_York)",
    "Current week (Sonnet only)",
    "0% used",
    "Approximate, based on local sessions on this machine"
  ].join("\n");

  const { windows } = _test.parseClaudeUsageScreen(screen);
  const week = windows.find((w) => w.label === "weekly");
  assert.ok(week, "weekly window should be parsed");
  assert.equal(week.usedPercent, 14);
  assert.equal(week.remainingPercent, 86);

  const session = windows.find((w) => w.label === "5-hour");
  assert.equal(session.usedPercent, 19);
});

test("parseClaudeUsageScreen recovers the 5-hour reset from a partial trailing redraw", () => {
  // The PTY /status capture caught a fresh redraw mid-paint: a trailing "Current
  // session" header + percent with no "Resets" line yet, after a complete block.
  // The parser must prefer the earlier block that still has the reset, not the
  // partial last one (which would drop the countdown).
  const screen = [
    "Current session",
    "█████████ 73% used",
    "Resets 1:50am (America/New_York)",
    "Current week (all models)",
    "███████ 31% used",
    "Resets Jun 24 at 2am (America/New_York)",
    "",
    "Current session",
    "█████████ 73% used"
  ].join("\n");

  const now = new Date("2026-06-24T05:00:00.000Z");
  const { windows } = _test.parseClaudeUsageScreen(screen, now);
  const session = windows.find((w) => w.label === "5-hour");
  assert.ok(session, "5-hour window should be parsed");
  assert.equal(session.usedPercent, 73);
  assert.ok(session.resetText, "5-hour reset text should be recovered");
  assert.ok(session.resetAt, "5-hour resetAt should be recovered");
  assert.equal(session.resetAt, "2026-06-24T05:50:00.000Z");
});

test("Claude reset time honors an explicit IANA timezone", () => {
  const now = new Date("2026-07-27T20:00:00.000Z");
  assert.equal(
    _test.parseClaudeResetAt("5:20pm (America/New_York)", now),
    "2026-07-27T21:20:00.000Z"
  );
});

test("Claude reset time accepts single-component UTC timezone", () => {
  const now = new Date("2026-07-27T17:00:00.000Z");
  assert.equal(
    _test.parseClaudeResetAt("6:00pm (UTC)", now),
    "2026-07-27T18:00:00.000Z"
  );
});
