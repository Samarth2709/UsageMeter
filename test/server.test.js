const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../server");
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

test("empty configs normalize without Codex placeholders", () => {
  const normalized = _test.normalizeConfig({ identities: [] });
  const serialized = _test.serializeConfig(normalized);

  assert.equal(serialized.accounts.length, 1);
  assert.equal(serialized.accounts[0].id, "claude-1");
  assert.equal(serialized.accounts[0].type, "claude");
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

test("Claude web usage requires an exact stored organization or email", () => {
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

test("Electron refresh uses the throttled Claude CLI usage supplement", async () => {
  const electronSource = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");

  assert.equal(electronSource.includes("refreshClaudeFallbackUsage"), false);
  assert.equal(electronSource.includes("shouldRefreshClaudeFallback"), false);
  assert.ok(electronSource.includes("claudeCliUsageRefreshMs"));
  assert.equal(electronSource.includes('skipDiscoveryTypes: ["claude"]'), false);
  assert.ok(electronSource.includes('onlyAccountTypes: ["claude"]'));
  assert.ok(electronSource.includes("Never fan one"));
});

test("Claude CLI capture opens the usage screen, not status", async () => {
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");

  assert.ok(serverSource.includes("printf '/usage\\\\r';"));
  assert.equal(serverSource.includes("printf '/status\\\\r';"), false);
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
