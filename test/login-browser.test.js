const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../server");

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("Claude sign-in forces the CLI OAuth page to open in Google Chrome", () => {
  const command = _test.loginCommandForAccount({ type: "claude" });

  assert.match(command, new RegExp(`export BROWSER='${chromePath}'`));
  assert.match(command, /'[^']*claude' auth login$/);
});

test("Codex sign-in opens its device authorization page in Google Chrome", () => {
  const command = _test.loginCommandForAccount({
    type: "codex",
    codeHome: "/tmp/Usage Meter Codex"
  });

  assert.match(command, /export CODEX_HOME='\/tmp\/Usage Meter Codex'/);
  assert.match(
    command,
    /\('\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome' 'https:\/\/auth\.openai\.com\/codex\/device' >\/dev\/null 2>&1 &\)/
  );
  assert.match(command, /'[^']*codex' login --device-auth$/);
  assert.equal(command.includes("export BROWSER="), false);
});

test("Electron delegates sign-in to the CLI path instead of an embedded browser", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");

  assert.equal(source.includes("showClaudeUsageLogin"), false);
  assert.equal(source.includes("claudeLoginWindow"), false);
  assert.match(source, /Sign in to Claude with Chrome/);
  assert.match(
    source,
    /ipcMain\.handle\("rate-limit:open-login",[\s\S]*?return openLoginForAccountById\(accountId\);/
  );
});
