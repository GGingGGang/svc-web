const defaultConfig = {
  serviceName: "web",
  version: "dev",
  authBasePath: "https://api.ggang.cloud/v1/auth",
  scheduleBasePath: "https://api.ggang.cloud/v1/core",
};

const accessTokenKey = "svc-web.access-token";
const refreshTokenKey = "svc-web.refresh-token";
const expiresAtKey = "svc-web.access-expires-at";

export function readConfig(source = globalThis.window?.appConfig) {
  return { ...defaultConfig, ...(source ?? {}) };
}

export function authUrl(config, path) {
  return `${config.authBasePath.replace(/\/+$/, "")}${path}`;
}

export function getBrowserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function errorMessage(status, payload) {
  const messages = {
    account_locked: "이 계정은 잠겨 있습니다.",
    email_already_registered: "이미 등록된 이메일입니다.",
    invalid_credentials: "이메일 또는 비밀번호를 확인하세요.",
    invalid_refresh_token: "로그인 정보가 만료되었습니다.",
    rate_limited: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.",
    refresh_reuse_detected: "로그인 정보가 만료되었습니다. 다시 로그인하세요.",
  };
  return (
    messages[payload?.error] ?? `요청을 완료하지 못했습니다. (HTTP ${status})`
  );
}

async function safeJson(response) {
  return response.json().catch(() => ({}));
}

export class AuthClient {
  constructor({
    config,
    storage = globalThis.sessionStorage,
    fetchImpl = globalThis.fetch?.bind(globalThis),
  } = {}) {
    this.config = config ?? readConfig();
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.sessionVersion = 0;
  }

  hasSession() {
    return Boolean(this.storage?.getItem(refreshTokenKey));
  }
  getAccessToken() {
    return this.storage?.getItem(accessTokenKey) ?? null;
  }
  getAccessExpiresAt() {
    return Number(this.storage?.getItem(expiresAtKey) ?? 0);
  }

  clear() {
    this.sessionVersion++;
    this.refreshPromise = null;
    this.storage?.removeItem(accessTokenKey);
    this.storage?.removeItem(refreshTokenKey);
    this.storage?.removeItem(expiresAtKey);
  }

  saveTokenPair(payload) {
    if (
      !payload?.access_token ||
      !payload?.refresh_token ||
      !Number.isFinite(payload.expires_in)
    ) {
      throw new Error("Invalid token response");
    }
    this.storage?.setItem(accessTokenKey, payload.access_token);
    this.storage?.setItem(refreshTokenKey, payload.refresh_token);
    this.storage?.setItem(
      expiresAtKey,
      String(Date.now() + payload.expires_in * 1000),
    );
  }

  async request(path, body) {
    const response = await this.fetchImpl(authUrl(this.config, path), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      const error = new Error(errorMessage(response.status, payload));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async register(fields) {
    return this.request("/register", fields);
  }

  async login(credentials) {
    const pair = await this.request("/login", credentials);
    this.saveTokenPair(pair);
    this.sessionVersion++;
    return pair;
  }

  refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    const refreshToken = this.storage?.getItem(refreshTokenKey);
    if (!refreshToken) return Promise.resolve(null);
    const sessionVersion = this.sessionVersion;
    const pending = this.request("/refresh", { refresh_token: refreshToken })
      .then((pair) => {
        if (this.sessionVersion !== sessionVersion || this.storage?.getItem(refreshTokenKey) !== refreshToken) return null;
        this.saveTokenPair(pair);
        return pair;
      })
      .catch((error) => {
        if (error.status === 401 && this.sessionVersion === sessionVersion && this.storage?.getItem(refreshTokenKey) === refreshToken) this.clear();
        throw error;
      });
    const tracked = pending.finally(() => {
      if (this.refreshPromise === tracked) this.refreshPromise = null;
    });
    this.refreshPromise = tracked;
    return this.refreshPromise;
  }

  async logout() {
    const refreshToken = this.storage?.getItem(refreshTokenKey);
    try {
      if (refreshToken)
        await this.request("/logout", { refresh_token: refreshToken });
    } finally {
      this.clear();
    }
  }
}

export class ScheduleClient {
  constructor({
    config,
    authClient,
    fetchImpl = globalThis.fetch?.bind(globalThis),
  } = {}) {
    this.config = config ?? readConfig();
    this.authClient = authClient;
    this.fetchImpl = fetchImpl;
  }

  url(path = "") {
    return `${this.config.scheduleBasePath.replace(/\/+$/, "")}/schedules${path}`;
  }

  async request(path = "", options = {}) {
    const token = this.authClient?.getAccessToken();
    const sessionVersion = this.authClient?.sessionVersion;
    if (!token) throw new Error("Sign in is required to load schedules.");
    const send = (accessToken) => this.fetchImpl(this.url(path), {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    let response = await send(token);
    if (response.status === 401 && this.authClient?.hasSession?.() && this.authClient.sessionVersion === sessionVersion) {
      if (this.authClient.getAccessToken() === token) await this.authClient.refresh();
      const renewedToken = this.authClient.getAccessToken();
      if (renewedToken && this.authClient.sessionVersion === sessionVersion) response = await send(renewedToken);
    }
    if (!response.ok) {
      const error = new Error(
        `Schedule request failed (HTTP ${response.status})`,
      );
      error.status = response.status;
      error.code = (await safeJson(response)).error;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  list({ from, to, status } = {}) {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (status) query.set("status", status);
    return this.request(query.size ? `?${query}` : "").then(
      (payload) => payload.schedules ?? [],
    );
  }

  create(schedule, idempotencyKey) {
    return this.request("", {
      method: "POST",
      body: JSON.stringify(schedule),
      ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  extract({ text, now, timezone, apiKey, signal }) {
    return this.request("/extract", {
      method: "POST",
      body: JSON.stringify({ text, now, timezone }),
      signal,
      ...(apiKey ? { headers: { "X-Gemini-Key": apiKey } } : {}),
    });
  }

  update(id, changes) {
    return this.request(`/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
  }

  delete(id) {
    return this.request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

export async function fetchJson(path, fallback) {
  try {
    const response = await fetch(path, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getServiceHealth() {
  return fetchJson("/readyz", { status: "unreachable" });
}

export function statusText(payload) {
  return payload?.status ?? "unknown";
}
