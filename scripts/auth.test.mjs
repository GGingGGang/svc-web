import test from "node:test";
import assert from "node:assert/strict";

import { AuthClient, ScheduleClient, authUrl, errorMessage, readConfig } from "../public/app.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

function tokenResponse(access = "access-1", refresh = "refresh-1") {
  return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 }), { status: 200 });
}

test("auth client uses the configured API origin", () => {
  const config = readConfig({ authBasePath: "https://api.ggang.cloud/v1/auth/" });
  assert.equal(authUrl(config, "/login"), "https://api.ggang.cloud/v1/auth/login");
});

test("both clients preserve the browser fetch receiver", async (t) => {
  t.mock.method(globalThis, "fetch", async function (url) {
    assert.equal(this, globalThis);
    return url.endsWith("/login")
      ? tokenResponse()
      : new Response(JSON.stringify({ schedules: [] }), { status: 200 });
  });
  const auth = new AuthClient({ storage: storage() });
  await auth.login({ email: "user@example.com", password: "secret" });
  const schedules = new ScheduleClient({ authClient: auth });
  assert.deepEqual(await schedules.list(), []);
});

test("login saves the access and refresh pair in session storage", async () => {
  const calls = [];
  const client = new AuthClient({
    config: readConfig(),
    storage: storage(),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return tokenResponse(); }
  });

  await client.login({ email: "user@example.com", password: "secret" });
  assert.equal(calls[0].url, "https://api.ggang.cloud/v1/auth/login");
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: "user@example.com", password: "secret" });
  assert.equal(client.getAccessToken(), "access-1");
  assert.equal(client.hasSession(), true);
});

test("refresh rotates the stored pair and clears an invalid session", async () => {
  const session = storage();
  const client = new AuthClient({ config: readConfig(), storage: session, fetchImpl: async () => tokenResponse("access-2", "refresh-2") });
  await client.login({ email: "user@example.com", password: "secret" });
  await client.refresh();
  assert.equal(client.getAccessToken(), "access-2");

  client.fetchImpl = async () => new Response(JSON.stringify({ error: "invalid_refresh_token" }), { status: 401 });
  await assert.rejects(() => client.refresh(), /로그인 정보가 만료/);
  assert.equal(client.hasSession(), false);
});

test("lost refresh response clears the uncertain token instead of sending it again", async () => {
  let refreshCalls = 0;
  const client = new AuthClient({
    storage: storage(),
    fetchImpl: async (url) => {
      if (url.endsWith("/refresh")) {
        refreshCalls++;
        throw new TypeError("network lost");
      }
      return tokenResponse();
    },
  });
  await client.login({ email: "user@example.com", password: "secret" });
  await assert.rejects(() => client.refresh(), /다시 로그인하세요/);
  assert.equal(client.hasSession(), false);
  assert.equal(client.getAccessToken(), null);
  assert.equal(await client.refresh(), null);
  assert.equal(refreshCalls, 1);
});

test("logout revokes the stored refresh token and clears local session state", async () => {
  const calls = [];
  const client = new AuthClient({
    config: readConfig(),
    storage: storage(),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 204 }); }
  });
  client.saveTokenPair({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  await client.logout();
  assert.equal(calls[0].url, "https://api.ggang.cloud/v1/auth/logout");
  assert.deepEqual(JSON.parse(calls[0].options.body), { refresh_token: "refresh" });
  assert.equal(client.hasSession(), false);
});

test("auth errors stay user-facing without exposing response content", () => {
  assert.equal(errorMessage(401, { error: "invalid_credentials" }), "이메일 또는 비밀번호를 확인하세요.");
  assert.match(errorMessage(503, {}), /HTTP 503/);
});

test("schedule client follows the core schedule contract with bearer auth", async () => {
  const session = storage();
  const auth = new AuthClient({ storage: session, fetchImpl: async () => tokenResponse() });
  await auth.login({ email: "user@example.com", password: "secret" });
  const calls = [];
  const schedules = new ScheduleClient({ authClient: auth, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ schedules: [] }), { status: 200 });
  } });
  assert.deepEqual(await schedules.list({ status: "confirmed" }), []);
  assert.equal(calls[0].url, "https://api.ggang.cloud/v1/core/schedules?status=confirmed");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-1");
});

test("schedule delete waits for a 204 response and reports failure", async () => {
  const calls = [];
  const schedules = new ScheduleClient({
    authClient: { getAccessToken: () => "access-1" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: calls.length === 1 ? 503 : 204 });
    },
  });
  await assert.rejects(() => schedules.delete("schedule-1"), /HTTP 503/);
  assert.equal(await schedules.delete("schedule-1"), null);
  assert.equal(calls[0].url, "https://api.ggang.cloud/v1/core/schedules/schedule-1");
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-1");
});

test("schedule update sends only editable fields to the owned resource", async () => {
  const calls = [];
  const schedules = new ScheduleClient({
    authClient: { getAccessToken: () => "access-1" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: "schedule-1", title: "수정" }), { status: 200 });
    },
  });
  await schedules.update("schedule-1", { title: "수정", location: null });
  assert.equal(calls[0].url, "https://api.ggang.cloud/v1/core/schedules/schedule-1");
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-1");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "수정", location: null });
});

test("concurrent schedule 401s share one refresh and retry once with the same create key", async () => {
  const session = storage();
  let releaseRefresh;
  let refreshCount = 0;
  const auth = new AuthClient({
    storage: session,
    fetchImpl: async (url) => {
      if (url.endsWith("/refresh")) {
        refreshCount++;
        await new Promise((resolve) => { releaseRefresh = resolve; });
        return tokenResponse("access-2", "refresh-2");
      }
      return tokenResponse();
    },
  });
  await auth.login({ email: "user@example.com", password: "secret" });
  const calls = [];
  const schedules = new ScheduleClient({
    authClient: auth,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return options.headers.Authorization === "Bearer access-1"
        ? new Response(null, { status: 401 })
        : new Response(JSON.stringify({ id: "schedule-1" }), { status: 201 });
    },
  });
  const first = schedules.create({ title: "Meeting" }, "create-key");
  const second = schedules.create({ title: "Meeting" }, "create-key");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCount, 1);
  releaseRefresh();
  assert.deepEqual(await Promise.all([first, second]), [{ id: "schedule-1" }, { id: "schedule-1" }]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ options }) => options.headers["Idempotency-Key"]), Array(4).fill("create-key"));
  assert.deepEqual(calls.map(({ options }) => options.body), Array(4).fill('{"title":"Meeting"}'));
  assert.deepEqual(calls.map(({ options }) => options.headers.Authorization), ["Bearer access-1", "Bearer access-1", "Bearer access-2", "Bearer access-2"]);
});

test("PATCH 401 refreshes once before its single retry", async () => {
  let refreshCalls = 0;
  const auth = new AuthClient({
    storage: storage(),
    fetchImpl: async (url) => {
      if (url.endsWith("/refresh")) {
        refreshCalls++;
        return tokenResponse("access-2", "refresh-2");
      }
      return tokenResponse();
    },
  });
  await auth.login({ email: "user@example.com", password: "secret" });
  const calls = [];
  const schedules = new ScheduleClient({
    authClient: auth,
    fetchImpl: async (_url, options) => {
      calls.push(options.headers.Authorization);
      return new Response(options.headers.Authorization === "Bearer access-1" ? null : JSON.stringify({ id: "schedule-1" }), {
        status: options.headers.Authorization === "Bearer access-1" ? 401 : 200,
      });
    },
  });
  await schedules.update("schedule-1", { title: "Meeting" });
  assert.equal(refreshCalls, 1);
  assert.deepEqual(calls, ["Bearer access-1", "Bearer access-2"]);
});

test("a late refresh response cannot restore a logged-out session", async () => {
  let releaseRefresh;
  const auth = new AuthClient({
    storage: storage(),
    fetchImpl: async (url) => url.endsWith("/refresh")
      ? new Promise((resolve) => { releaseRefresh = () => resolve(tokenResponse("access-2", "refresh-2")); })
      : tokenResponse(),
  });
  await auth.login({ email: "user@example.com", password: "secret" });
  const pending = auth.refresh();
  auth.clear();
  releaseRefresh();
  assert.equal(await pending, null);
  assert.equal(auth.hasSession(), false);
});

test("an old schedule request is not retried after a different login", async () => {
  let rejectOldRequest;
  let logins = 0;
  const auth = new AuthClient({
    storage: storage(),
    fetchImpl: async () => tokenResponse(`access-${++logins}`, `refresh-${logins}`),
  });
  await auth.login({ email: "first@example.com", password: "secret" });
  const calls = [];
  const schedules = new ScheduleClient({
    authClient: auth,
    fetchImpl: async (url, options) => {
      calls.push(options.headers.Authorization);
      return new Promise((resolve) => { rejectOldRequest = () => resolve(new Response(null, { status: 401 })); });
    },
  });
  const pending = schedules.list();
  auth.clear();
  await auth.login({ email: "second@example.com", password: "secret" });
  rejectOldRequest();
  await assert.rejects(pending, /HTTP 401/);
  assert.deepEqual(calls, ["Bearer access-1"]);
});

test("a pending refresh cannot retry an old request under a new login", async () => {
  let releaseRefresh;
  let logins = 0;
  const auth = new AuthClient({
    storage: storage(),
    fetchImpl: async (url) => url.endsWith("/refresh")
      ? new Promise((resolve) => { releaseRefresh = () => resolve(tokenResponse("late-access", "late-refresh")); })
      : tokenResponse(`access-${++logins}`, `refresh-${logins}`),
  });
  await auth.login({ email: "first@example.com", password: "secret" });
  const calls = [];
  const schedules = new ScheduleClient({
    authClient: auth,
    fetchImpl: async (url, options) => {
      calls.push(options.headers.Authorization);
      return new Response(null, { status: 401 });
    },
  });
  const pending = schedules.list();
  await new Promise((resolve) => setImmediate(resolve));
  auth.clear();
  await auth.login({ email: "second@example.com", password: "secret" });
  releaseRefresh();
  await assert.rejects(pending, /HTTP 401/);
  assert.equal(auth.getAccessToken(), "access-2");
  assert.deepEqual(calls, ["Bearer access-1"]);
});
