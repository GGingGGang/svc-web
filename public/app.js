const defaultConfig = {
  serviceName: "web",
  version: "dev",
  authBasePath: "/v1/auth",
  scheduleBasePath: "/v1/core"
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

export class ScheduleClient {
  constructor({ config, authClient, fetchImpl = globalThis.fetch } = {}) {
    this.config = config ?? readConfig();
    this.authClient = authClient;
    this.fetchImpl = fetchImpl;
  }

  url(path = "") { return `${this.config.scheduleBasePath.replace(/\/+$/, "")}/schedules${path}`; }

  async request(path = "", options = {}) {
    const token = this.authClient?.getAccessToken();
    if (!token) throw new Error("Sign in is required to load schedules.");
    const response = await this.fetchImpl(this.url(path), {
      ...options,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    if (!response.ok) { const error = new Error(`Schedule request failed (HTTP ${response.status})`); error.status = response.status; throw error; }
    return response.status === 204 ? null : response.json();
  }

  list({ from, to, status } = {}) {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (status) query.set("status", status);
    return this.request(query.size ? `?${query}` : "").then((payload) => payload.schedules ?? []);
  }

  create(schedule) { return this.request("", { method: "POST", body: JSON.stringify(schedule) }); }
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

function escapeHtml(value = "") { return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]); }

function formatScheduleTime(schedule) {
  const start = new Date(schedule.start_at);
  if (schedule.all_day) return "All day";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(start);
}

function scheduleRow(schedule) {
  const date = new Date(schedule.start_at);
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date).toUpperCase();
  const number = new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(date);
  return `<div class="schedule-row"><span class="date-pill">${day}<br>${number}</span><div><strong>${escapeHtml(schedule.title)}</strong><p>${escapeHtml(schedule.location || "No location")}</p></div><span class="schedule-time">${formatScheduleTime(schedule)}</span></div>`;
}

function calendarMarkup() {
  const now = new Date(); const first = new Date(now.getFullYear(), now.getMonth(), 1); const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const labels = ["S", "M", "T", "W", "T", "F", "S"].map((label) => `<span>${label}</span>`).join("");
  const blanks = "<span></span>".repeat(first.getDay());
  const days = Array.from({ length: last.getDate() }, (_, index) => { const day = index + 1; return `<span class="day ${day === now.getDate() ? "today" : ""}">${day}</span>`; }).join("");
  return `${labels}${blanks}${days}`;
}

function dashboardView(schedules, apiUnavailable) {
  const upcoming = schedules.slice(0, 4);
  const rows = upcoming.length ? upcoming.map(scheduleRow).join("") : `<div class="empty"><div><span class="empty-icon">□</span><b>Nothing is scheduled yet</b><span>When you add a plan, it will appear here.</span></div></div>`;
  return `<div class="view-head"><div><h1>Your day at a glance</h1><p>Keep the next thing visible and the rest quiet.</p></div><a class="primary" href="#create">+ New schedule</a></div>${apiUnavailable ? '<p class="api-note">The schedule API is not reachable yet. Your dashboard is ready; sign in against a configured gateway to load live data.</p>' : ""}<section class="cards"><article class="metric"><span class="label">UPCOMING</span><strong>${schedules.length}</strong><small>scheduled from now</small></article><article class="metric"><span class="label">TODAY</span><strong>${schedules.filter((item) => new Date(item.start_at).toDateString() === new Date().toDateString()).length}</strong><small>plans on your calendar</small></article><article class="metric"><span class="label">FOCUS</span><strong>${upcoming[0] ? formatScheduleTime(upcoming[0]) : "Free"}</strong><small>${upcoming[0] ? escapeHtml(upcoming[0].title) : "No immediate plans"}</small></article></section><section class="dashboard-grid"><article class="card"><div class="card-title"><h2>Upcoming schedules</h2><a href="#schedules">View all →</a></div>${rows}</article><article class="card"><div class="card-title"><h2>This month</h2></div><div class="mini-calendar">${calendarMarkup()}</div></article></section>`;
}

function schedulesView(schedules, apiUnavailable) {
  const rows = schedules.length ? schedules.map((item) => `<tr><td><strong>${escapeHtml(item.title)}</strong></td><td>${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: item.all_day ? undefined : "numeric", minute: item.all_day ? undefined : "2-digit" }).format(new Date(item.start_at))}</td><td>${escapeHtml(item.location || "—")}</td><td><span class="tag">${escapeHtml(item.status || "confirmed")}</span></td></tr>`).join("") : '<tr><td colspan="4"><div class="empty"><div><span class="empty-icon">□</span><b>No schedules found</b><span>Add your first schedule to see it here.</span></div></div></td></tr>';
  return `<div class="view-head"><div><h1>All schedules</h1><p>Your upcoming plans, in one place.</p></div><a class="primary" href="#create">+ New schedule</a></div>${apiUnavailable ? '<p class="api-note">The schedule API is not reachable yet, so no live schedule data can be shown.</p>' : ""}<article class="card table-card"><table class="schedule-table"><thead><tr><th>TITLE</th><th>WHEN</th><th>WHERE</th><th>STATUS</th></tr></thead><tbody>${rows}</tbody></table></article>`;
}

function createView() { const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16); return `<div class="view-head"><div><h1>New schedule</h1><p>Add a plan manually. It will sync through the authenticated core API.</p></div></div><form class="card schedule-form" data-schedule-form><div class="form-grid"><label>Title<input name="title" maxlength="255" required placeholder="Team planning" /></label><label>When<input name="start_at" type="datetime-local" value="${local}" required /></label></div><div class="form-grid"><label>Location<input name="location" maxlength="255" placeholder="Online or a place" /></label><label>Status<select name="status"><option value="confirmed">Confirmed</option><option value="tentative">Tentative</option><option value="cancelled">Cancelled</option></select></label></div><label>Description<textarea name="description" rows="4" placeholder="Optional details"></textarea></label><div class="form-actions"><a class="secondary" href="#schedules">Cancel</a><button type="submit">Save schedule <span>→</span></button></div></form>`; }

function initDashboard() {
  const config = readConfig(); const client = new AuthClient({ config }); const schedules = new ScheduleClient({ config, authClient: client });
  const anonymousEl = document.querySelector(".auth-page"); const authenticatedEl = document.querySelector(".app-shell"); const messageEl = document.querySelector("[data-auth-message]"); const timezoneEl = document.querySelector("[data-timezone]"); const statusEls = document.querySelectorAll("[data-status]"); const versionEls = document.querySelectorAll("[data-version]"); const view = document.querySelector("[data-view]");
  let scheduleData = []; let apiUnavailable = false;
  const setMessage = (message, type = "") => { messageEl.textContent = message; messageEl.className = `notice${type ? ` ${type}` : ""}`; };
  const applyTheme = (theme) => { document.documentElement.dataset.theme = theme; localStorage.setItem("svc-web.theme", theme); };
  const render = () => { const route = location.hash.replace("#", "") || "dashboard"; document.querySelectorAll("[data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === route)); const titles = { dashboard:["OVERVIEW", "Good morning"], schedules:["SCHEDULES", "Your calendar"], create:["NEW SCHEDULE", "Make a plan"] }; document.querySelector("[data-page-kicker]").textContent = titles[route]?.[0] ?? "OVERVIEW"; document.querySelector("[data-page-title]").textContent = titles[route]?.[1] ?? "Good morning"; view.innerHTML = route === "schedules" ? schedulesView(scheduleData, apiUnavailable) : route === "create" ? createView() : dashboardView(scheduleData, apiUnavailable); if (route === "create") document.querySelector("[data-schedule-form]").addEventListener("submit", saveSchedule); };
  const loadSchedules = async () => { apiUnavailable = false; try { scheduleData = await schedules.list({ from: new Date().toISOString() }); } catch (error) { scheduleData = []; apiUnavailable = true; } render(); };
  const updateAuthUi = async () => { const signedIn = client.hasSession(); anonymousEl.hidden = signedIn; authenticatedEl.hidden = !signedIn; if (signedIn) { try { await client.refresh(); } catch { return updateAuthUi(); } await loadSchedules(); } };
  const saveSchedule = async (event) => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.currentTarget)); const button = event.currentTarget.querySelector("button"); button.disabled = true; try { await schedules.create({ title:fields.title, start_at:new Date(fields.start_at).toISOString(), location:fields.location || null, description:fields.description || null, status:fields.status, all_day:false, source:"manual" }); location.hash = "#schedules"; await loadSchedules(); } catch (error) { button.disabled = false; const note = document.createElement("p"); note.className = "api-note"; note.textContent = error.message; event.currentTarget.prepend(note); } };
  timezoneEl.value = getBrowserTimezone(); versionEls.forEach((element) => element.textContent = config.version); applyTheme(localStorage.getItem("svc-web.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); document.querySelectorAll("[data-theme-toggle]").forEach((button) => button.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"))); document.querySelectorAll("[data-menu-toggle]").forEach((button) => button.addEventListener("click", () => authenticatedEl.classList.toggle("menu-open")));
  document.querySelector("[data-login-form]").addEventListener("submit", async (event) => { event.preventDefault(); try { await client.login(readForm(event.currentTarget)); setMessage("Signed in successfully.", "success"); await updateAuthUi(); } catch (error) { setMessage(error.message, "error"); } }); document.querySelector("[data-register-form]").addEventListener("submit", async (event) => { event.preventDefault(); const fields = readForm(event.currentTarget); try { await client.register(fields); await client.login({ email:fields.email, password:fields.password }); setMessage("Your account is ready.", "success"); await updateAuthUi(); } catch (error) { setMessage(error.message, "error"); } }); document.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", async () => { await client.logout(); updateAuthUi(); })); window.addEventListener("hashchange", render); getServiceHealth().then((payload) => statusEls.forEach((element) => { element.classList.toggle("ready", payload.status === "ready"); element.title = statusText(payload); })); updateAuthUi();
}

if (typeof document !== "undefined") initDashboard();
