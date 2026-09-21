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

test("auth client uses the configured same-origin auth path", () => {
  const config = readConfig({ authBasePath: "/v1/auth/" });
  assert.equal(authUrl(config, "/login"), "/v1/auth/login");
});

test("login saves the access and refresh pair in session storage", async () => {
  const calls = [];
  const client = new AuthClient({
    config: readConfig(),
    storage: storage(),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return tokenResponse(); }
  });

  await client.login({ email: "user@example.com", password: "secret" });
  assert.equal(calls[0].url, "/v1/auth/login");
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

test("logout revokes the stored refresh token and clears local session state", async () => {
  const calls = [];
  const client = new AuthClient({
    config: readConfig(),
    storage: storage(),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 204 }); }
  });
  client.saveTokenPair({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  await client.logout();
  assert.equal(calls[0].url, "/v1/auth/logout");
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
  assert.equal(calls[0].url, "/v1/core/schedules?status=confirmed");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-1");
});
