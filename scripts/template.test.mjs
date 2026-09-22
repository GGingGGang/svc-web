import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("static shell keeps runtime configuration external", async () => {
  const html = await readFile(join(root, "public", "index.html"), "utf8");
  assert.match(html, /runtime-config\.js/);
  assert.match(html, /type="module" src="\/ui\.js"/);
  assert.match(html, /data-auth-message/);
  assert.match(html, /data-view/);
  assert.doesNotMatch(html, /mini-calendar/);
});

test("nginx exposes its own probes", async () => {
  const nginx = await readFile(join(root, "nginx.conf"), "utf8");
  assert.match(nginx, /location = \/healthz/);
  assert.match(nginx, /location = \/readyz/);
  assert.match(nginx, /root \/tmp\/html/);
  assert.doesNotMatch(nginx, /proxy_pass/);
  assert.doesNotMatch(nginx, /__[A-Z][A-Z0-9_]*__/);
});

test("entrypoint renders runtime files under tmp", async () => {
  const entrypoint = await readFile(join(root, "docker-entrypoint.sh"), "utf8");
  assert.match(entrypoint, /\/tmp\/html/);
  assert.match(entrypoint, /SCHEDULE_BASE_PATH/);
  assert.match(entrypoint, /A-Za-z0-9\.:\/_-/);
  assert.match(entrypoint, /exec nginx -c \/etc\/nginx\/nginx\.conf/);
});

test("build script emits browser assets", async () => {
  const dist = join(root, "dist");
  await import("./build.mjs");
  await stat(join(dist, "index.html"));
  await stat(join(dist, "app.js"));
  await stat(join(dist, "ui.js"));
  await stat(join(dist, "adminator.css"));
  await stat(join(dist, "vendors", "adminator", "LICENSE.txt"));
  await stat(join(dist, "runtime-config.js"));
});

test("browser helpers read config and format service status", async () => {
  const { readConfig, statusText } = await import("../public/app.js");
  assert.deepEqual(readConfig({ serviceName: "svc-web", version: "abc123" }), {
    serviceName: "svc-web",
    version: "abc123",
    authBasePath: "https://api.ggang.cloud/v1/auth",
    scheduleBasePath: "https://api.ggang.cloud/v1/core"
  });
  assert.equal(statusText({ status: "ready" }), "ready");
  assert.equal(statusText({}), "unknown");
});

test("dev server serves probes and runtime browser assets", async (t) => {
  const child = spawn(process.execPath, ["scripts/dev-server.mjs"], {
    cwd: root,
    env: { ...process.env, HTTP_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());

  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dev server did not start")), 5000);
    child.stdout.on("data", (data) => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr.on("data", (data) => reject(new Error(data.toString())));
    child.on("exit", (code) => reject(new Error(`dev server exited with ${code}`)));
  });

  const health = await fetch(`${baseUrl}/healthz`);
  assert.deepEqual(await health.json(), { status: "ok" });

  const { getServiceHealth } = await import("../public/app.js");
  const nativeFetch = globalThis.fetch;
  const requests = [];
  t.mock.method(globalThis, "fetch", (path, options) => {
    requests.push(path);
    return nativeFetch(new URL(path, baseUrl), options);
  });
  assert.deepEqual(await getServiceHealth(), { status: "ready" });
  assert.deepEqual(requests, ["/readyz"]);

  const runtime = await fetch(`${baseUrl}/runtime-config.js`);
  assert.equal(runtime.headers.get("cache-control"), "no-store");
  assert.match(await runtime.text(), /window\.appConfig/);

  const script = await fetch(`${baseUrl}/app.js`);
  assert.match(await script.text(), /getServiceHealth/);
});
