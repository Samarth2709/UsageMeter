// Offline integration check: every HTTPS request is served by a local fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const { ClaudeWebUsage } = require("../claude-web-usage");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-web-fixture-"));
app.setPath("userData", profile);
const org = "11111111-1111-4111-8111-111111111111";
const account = { id: "offline-fixture", type: "claude", providerAccountId: "fixture-account", email: "fixture@example.test", organization: org };
let reader;
let failed = false;
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  let utilization = 1;
  let status = 200;
  let requests = 0;
  const webSession = session.fromPartition("offline-chrome-page-fixture");
  await webSession.protocol.handle("https", (request) => {
    requests += 1;
    const url = new URL(request.url);
    if (url.origin !== "https://claude.ai") throw new Error("Unexpected fixture origin");
    if (url.pathname === "/settings/usage") {
      return new Response(`<!doctype html><title>Offline usage fixture</title><script>
        fetch('/edge-api/bootstrap/${org}/app_start').then(r => r.json());
        fetch('/api/organizations/${org}/usage').then(r => r.json());
      </script>`, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
    }
    if (url.pathname.endsWith("/app_start")) {
      return Response.json({ account: { uuid: account.providerAccountId, email_address: account.email } });
    }
    if (url.pathname.endsWith("/usage")) {
      return Response.json({ five_hour: { utilization, resets_at: "2026-09-06T05:00:00Z" }, seven_day: { utilization: 0, resets_at: null } }, { status, headers: { "Retry-After": "3600", "Cache-Control": "no-store" } });
    }
    return new Response("", { status: 404 });
  });
  const window = new BrowserWindow({ show: false, webPreferences: { session: webSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL("https://claude.ai/settings/usage");
  reader = new ClaudeWebUsage({ timeoutMs: 10000, run: async ({ script }) => JSON.parse(await window.webContents.executeJavaScript(script)) });
  reader.tabs[account.id] = "offline-fixture";
  const first = await reader.read(account);
  assert.equal(first.source, "claude_web_usage");
  assert.equal(first.windows[0].usedPercent, 1);

  await window.webContents.executeJavaScript("performance.clearResourceTimings()");
  utilization = 2;
  const second = await reader.read(account);
  assert.equal(second.windows[0].usedPercent, 2);
  assert.ok(Date.parse(second.fetchedAt) >= Date.parse(first.fetchedAt));
  status = 429;
  await assert.rejects(reader.read(account), /rate limiting/);
  const requestsBeforeBackoff = requests;
  await assert.rejects(reader.read(account), /rate limiting/);
  assert.equal(requests, requestsBeforeBackoff);
  await reader.logout(account);

  console.log(JSON.stringify({ ok: true, checks: ["actual Chromium page collector", "identity before and after usage", "changed allowance after cleared resource timings", "429 backoff", "disconnect"], externalRequests: 0 }));
}).catch((error) => {
  failed = true;
  console.error(error.stack);
}).finally(() => {
  reader?.close();
  app.exit(failed ? 1 : 0);
});
app.on("quit", () => fs.rmSync(profile, { recursive: true, force: true }));
