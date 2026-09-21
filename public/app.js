const defaultConfig = {
  serviceName: "web",
  version: "dev",
  authBasePath: "/v1/auth"
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
    refresh_reuse_detected: "로그인 정보가 만료되었습니다. 다시 로그인하세요."
  };
  return messages[payload?.error] ?? `요청을 완료하지 못했습니다. (HTTP ${status})`;
}

async function safeJson(response) {
  return response.json().catch(() => ({}));
}

export class AuthClient {
  constructor({ config, storage = globalThis.sessionStorage, fetchImpl = globalThis.fetch } = {}) {
    this.config = config ?? readConfig();
    this.storage = storage;
    this.fetchImpl = fetchImpl;
  }

  hasSession() { return Boolean(this.storage?.getItem(refreshTokenKey)); }
  getAccessToken() { return this.storage?.getItem(accessTokenKey) ?? null; }
  getAccessExpiresAt() { return Number(this.storage?.getItem(expiresAtKey) ?? 0); }

  clear() {
    this.storage?.removeItem(accessTokenKey);
    this.storage?.removeItem(refreshTokenKey);
    this.storage?.removeItem(expiresAtKey);
  }

  saveTokenPair(payload) {
    if (!payload?.access_token || !payload?.refresh_token || !Number.isFinite(payload.expires_in)) {
      throw new Error("Invalid token response");
    }
    this.storage?.setItem(accessTokenKey, payload.access_token);
    this.storage?.setItem(refreshTokenKey, payload.refresh_token);
    this.storage?.setItem(expiresAtKey, String(Date.now() + payload.expires_in * 1000));
  }

  async request(path, body) {
    const response = await this.fetchImpl(authUrl(this.config, path), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      const error = new Error(errorMessage(response.status, payload));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async register(fields) { return this.request("/register", fields); }

  async login(credentials) {
    const pair = await this.request("/login", credentials);
    this.saveTokenPair(pair);
    return pair;
  }

  async refresh() {
    const refreshToken = this.storage?.getItem(refreshTokenKey);
    if (!refreshToken) return null;
    try {
      const pair = await this.request("/refresh", { refresh_token: refreshToken });
      this.saveTokenPair(pair);
      return pair;
    } catch (error) {
      if (error.status === 401) this.clear();
      throw error;
    }
  }

  async logout() {
    const refreshToken = this.storage?.getItem(refreshTokenKey);
    try {
      if (refreshToken) await this.request("/logout", { refresh_token: refreshToken });
    } finally { this.clear(); }
  }
}

export async function fetchJson(path, fallback) {
  try {
    const response = await fetch(path, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    return { ...fallback, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getServiceHealth() {
  return fetchJson("/readyz", { status: "unreachable" });
}

export function statusText(payload) {
  return payload?.status ?? "unknown";
}

async function refreshHealth(statusEl, outputEl) {
  const payload = await getServiceHealth();
  statusEl.textContent = statusText(payload);
  statusEl.classList.toggle("ready", payload.status === "ready");
  outputEl.textContent = JSON.stringify(payload, null, 2);
}

function readForm(form) {
  return Object.fromEntries(new FormData(form));
}

function setMessage(element, message, type = "") {
  element.textContent = message;
  element.className = `notice${type ? ` ${type}` : ""}`;
}

export function init() {
  const config = readConfig();
  const client = new AuthClient({ config });
  const statusEl = document.querySelector("[data-status]");
  const versionEl = document.querySelector("[data-version]");
  const outputEl = document.querySelector("[data-output]");
  const refreshButton = document.querySelector("[data-refresh]");
  const messageEl = document.querySelector("[data-auth-message]");
  const anonymousEl = document.querySelector("[data-auth-anonymous]");
  const authenticatedEl = document.querySelector("[data-authenticated]");
  let refreshTimer;

  const updateAuthUi = (message) => {
    const signedIn = client.hasSession();
    anonymousEl.hidden = signedIn;
    authenticatedEl.hidden = !signedIn;
    if (message) setMessage(messageEl, message, signedIn ? "success" : "");
  };

  const refreshSession = async () => {
    try {
      await client.refresh();
      updateAuthUi("로그인 정보를 갱신했습니다.");
      scheduleRefresh();
    } catch (error) {
      updateAuthUi();
      setMessage(messageEl, error.message, "error");
    }
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    if (!client.hasSession()) return;
    const delay = Math.max(0, client.getAccessExpiresAt() - Date.now() - 60_000);
    refreshTimer = setTimeout(refreshSession, Math.min(delay, 2_147_483_647));
  };

  versionEl.textContent = config.version;
  document.querySelector("[data-timezone]").value = getBrowserTimezone();
  refreshButton.addEventListener("click", () => refreshHealth(statusEl, outputEl));
  document.querySelector("[data-login-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await client.login(readForm(event.currentTarget));
      updateAuthUi("로그인했습니다.");
      scheduleRefresh();
    } catch (error) {
      setMessage(messageEl, error.message, "error");
    }
  });
  document.querySelector("[data-register-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = readForm(event.currentTarget);
    try {
      await client.register(fields);
      await client.login({ email: fields.email, password: fields.password });
      updateAuthUi("계정을 만들고 로그인했습니다.");
      scheduleRefresh();
    } catch (error) {
      setMessage(messageEl, error.message, "error");
    }
  });
  document.querySelector("[data-logout]").addEventListener("click", async () => {
    try {
      await client.logout();
      clearTimeout(refreshTimer);
      updateAuthUi("로그아웃했습니다.");
    } catch (error) {
      updateAuthUi();
      setMessage(messageEl, error.message, "error");
    }
  });

  updateAuthUi();
  if (client.hasSession()) {
    refreshSession();
  }
  refreshHealth(statusEl, outputEl);
}

if (typeof document !== "undefined") {
  init();
}
