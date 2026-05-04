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

test("Claude reset text parses into a concrete future timestamp", () => {
  const now = new Date(2026, 4, 2, 15, 0, 0, 0);
  const expected = new Date(2026, 4, 2, 17, 0, 0, 0).toISOString();

  assert.equal(_test.parseClaudeResetAt("May 2 at 5pm", now), expected);
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
