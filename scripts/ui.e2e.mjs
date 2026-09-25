import { test, expect } from "@playwright/test";

const apiOrigin = "https://api.example.test";
const tokens = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 };

// No account or schedule is written to a real service by these browser checks.
async function mockApi(page) {
  const state = { loginStatus: 200, registerStatus: 201, registerMessage: "Invalid email", refreshStatus: 200, listStatus: 200, requestId: null, serviceStatus: { schedules: "available", followup: "available" }, saveStatus: 201, saveResponseLost: false, createResults: new Map(), failTitle: null, extractStatus: 200, extractErrorCode: "extraction_failed", extractCandidates: [], extractTruncated: false, updateStatus: 200, deleteStatus: 204, deleteGate: null, detailGate: null, detailStatus: 200, reminderStatus: 201, reminderGate: null, reminders: [], schedules: [], calls: [] };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === "http://127.0.0.1:5179") {
      if (url.pathname !== "/runtime-config.js") return route.continue();
      return route.fulfill({ contentType: "text/javascript", body: `window.appConfig = ${JSON.stringify({
        version: "browser-test",
        authBasePath: `${apiOrigin}/v1/auth`,
        scheduleBasePath: `${apiOrigin}/v1/core`
      })};` });
    }
    if (url.origin !== apiOrigin) return route.abort();
    const method = request.method();
    const body = request.postDataJSON();
    state.calls.push({ path: url.pathname, method, body, headers: request.headers(), query: url.search });
    if (url.pathname.endsWith("/login")) return route.fulfill({ status: state.loginStatus, json: state.loginStatus === 200 ? tokens : { error: "invalid_credentials" } });
    if (url.pathname.endsWith("/refresh")) return route.fulfill({ status: state.refreshStatus, json: state.refreshStatus === 200 ? tokens : { error: "invalid_refresh_token" } });
    if (url.pathname.endsWith("/register")) return route.fulfill({ status: state.registerStatus, json: state.registerStatus === 201 ? { id: "test-user" } : state.registerStatus === 400 ? { statusCode: 400, error: "Bad Request", message: state.registerMessage } : { error: "email_already_registered" } });
    if (url.pathname.endsWith("/logout")) return route.fulfill({ status: 204 });
    if (url.pathname === "/v1/core/status") return route.fulfill({ status: state.serviceStatus.schedules === "unavailable" ? 503 : 200, json: state.serviceStatus });
    if (url.pathname === "/v1/core/schedules/extract") return route.fulfill({ status: state.extractStatus, json: state.extractStatus === 200 ? { candidates: state.extractCandidates, truncated: state.extractTruncated } : { error: state.extractErrorCode } });
    if (url.pathname.includes("/reminders") && method === "POST") {
      if (state.reminderGate) await state.reminderGate;
      if (state.reminderStatus === 201) state.reminders.push({ id: "test-reminder", ...body });
      return route.fulfill({ status: state.reminderStatus, json: state.reminderStatus === 201 ? { id: "test-reminder" } : { error: "inaccessible" } });
    }
    if (url.pathname === "/v1/core/schedules") {
      if (method === "GET") return state.listStatus === 0 ? route.abort("failed") : route.fulfill({ status: state.listStatus, headers: state.requestId ? { "X-Request-ID": state.requestId, "Access-Control-Expose-Headers": "X-Request-ID" } : {}, json: { schedules: state.schedules } });
      if (method === "POST") {
        if (state.saveStatus !== 201 || body.title === state.failTitle) return route.fulfill({ status: state.saveStatus !== 201 ? state.saveStatus : 503, json: { error: "unavailable" } });
        const key = request.headers()["idempotency-key"];
        if (key && state.createResults.has(key)) return route.fulfill({ status: 201, json: state.createResults.get(key) });
        const schedule = { id: "test-schedule", ...body };
        state.schedules.push(schedule);
        if (key) state.createResults.set(key, schedule);
        if (state.saveResponseLost) { state.saveResponseLost = false; return route.abort("failed"); }
        return route.fulfill({ status: 201, json: schedule });
      }
    }
    if (method === "GET" && url.pathname.startsWith("/v1/core/schedules/")) {
      if (state.detailGate) await state.detailGate;
      if (state.detailStatus !== 200) return route.fulfill({ status: state.detailStatus, json: { error: "inaccessible" } });
      const schedule = state.schedules.find((item) => item.id === url.pathname.split("/").at(-1));
      return route.fulfill({ status: schedule ? 200 : 404, json: schedule ? { ...schedule, reminders: state.reminders } : { error: "not_found" } });
    }
    if (method === "PATCH" && url.pathname.startsWith("/v1/core/schedules/")) {
      if (state.updateStatus !== 200) return route.fulfill({ status: state.updateStatus, json: { error: "unavailable" } });
      const schedule = state.schedules.find((item) => item.id === url.pathname.split("/").at(-1));
      if (!schedule) return route.fulfill({ status: 404, json: { error: "not_found" } });
      Object.assign(schedule, body);
      return route.fulfill({ status: 200, json: schedule });
    }
    if (method === "DELETE" && url.pathname.startsWith("/v1/core/schedules/")) {
      if (state.deleteGate) await state.deleteGate;
      if (state.deleteStatus !== 204) return route.fulfill({ status: state.deleteStatus, json: { error: "unavailable" } });
      state.schedules = state.schedules.filter((schedule) => schedule.id !== url.pathname.split("/").at(-1));
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: "unexpected_test_request" } });
  });
  return state;
}

async function login(page) {
  const form = page.locator("[data-login-form]");
  await form.locator("[name=email]").fill("browser@example.test");
  await form.locator("[name=password]").fill("Test-password-123!");
  await form.locator("button[type=submit]").click();
}

async function navigate(page, route) {
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  const menu = page.locator("button[data-menu-toggle]").first();
  const link = page.locator(`[data-route="${route}"]`);
  if (!(await link.isVisible()) && await menu.isVisible()) await menu.click();
  await link.click();
}

async function noPageOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test("auth panels, failures, logout and re-login remain usable", async ({ page }, testInfo) => {
  const state = await mockApi(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("[data-login-form]")).toBeVisible();
  await expect(page.locator("[data-register-form]")).toBeHidden();
  await expect(page.locator("[data-authenticated]")).toBeHidden();
  await noPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("login.png"), fullPage: true, animations: "disabled" });

  await page.locator('[data-auth-mode="register"]').click();
  await expect(page.locator("[data-login-form]")).toBeHidden();
  await expect(page.locator("[data-register-form]")).toBeVisible();
  await page.locator('[data-auth-mode="login"]').click();
  state.loginStatus = 401;
  await login(page);
  await expect(page.locator("[data-auth-message]")).toContainText("이메일 또는 비밀번호");
  await expect(page.locator("[data-login-form] button[type=submit]")).toBeEnabled();
  state.loginStatus = 200;
  await login(page);
  await expect(page.locator("[data-auth-anonymous]")).toBeHidden();
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator("[data-logout]")).toBeVisible();
  }
  await expect.poll(() => state.calls.some((call) => call.path.endsWith("/schedules"))).toBe(true);
  await noPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("dashboard-empty.png"), fullPage: true, animations: "disabled" });
  await navigate(page, "create");
  await page.locator("[data-schedule-form] [name=title]").fill("첫 계정의 비공개 초안");
  const menu = page.locator("button[data-menu-toggle]").first();
  if (await menu.isVisible()) await menu.click();
  await page.locator("[data-logout]").click();
  await expect(page.locator("[data-authenticated]")).toBeHidden();
  await expect(page.locator("[data-login-form] button[type=submit]")).toBeEnabled();
  await login(page);
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  await expect(page.locator("[data-schedule-form] [name=title]")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("registration and reload restore a session, expired refresh returns to login", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await page.locator('[data-auth-mode="register"]').click();
  const form = page.locator("[data-register-form]");
  await form.locator("[name=display_name]").fill("Browser Test");
  await form.locator("[name=email]").fill("browser@example.test");
  await form.locator("[name=password]").fill("Test-password-123!");
  await form.locator("[name=password_confirmation]").fill("Test-password-123!");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  expect(state.calls.find((call) => call.path.endsWith("/register")).body).toMatchObject({ display_name: "Browser Test", email: "browser@example.test" });
  expect(state.calls.find((call) => call.path.endsWith("/register")).body).not.toHaveProperty("password_confirmation");
  await page.reload();
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  expect(state.calls.some((call) => call.path.endsWith("/refresh"))).toBe(true);
  state.refreshStatus = 401;
  await page.reload();
  await expect(page.locator("[data-login-form]")).toBeVisible();
  await expect(page.locator("[data-authenticated]")).toBeHidden();
  await expect(page.locator("[data-auth-message]")).toContainText("만료");
  expect(await page.evaluate(() => sessionStorage.getItem("svc-web.refresh-token"))).toBeNull();
});

test("registration validates fields before request and keeps successful account after login failure", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await page.locator('[data-auth-mode="register"]').click();
  const form = page.locator("[data-register-form]");
  await form.locator("[name=display_name]").fill("   ");
  await form.locator("[name=email]").fill("invalid");
  await form.locator("[name=password]").fill("short");
  await form.locator("[name=password_confirmation]").fill("different");
  await form.locator("button[type=submit]").click();
  for (const name of ["display_name", "email", "password", "password_confirmation"])
    await expect(form.locator(`[data-error-for="${name}"]`)).not.toBeEmpty();
  expect(state.calls.filter((call) => call.path.endsWith("/register"))).toHaveLength(0);

  await form.locator("[name=display_name]").fill("  Browser Test  ");
  await form.locator("[name=email]").fill("browser@example..test");
  await form.locator("[name=password]").fill("Test-password-123!");
  await form.locator("[name=password_confirmation]").fill("Test-password-123!");
  await form.locator("button[type=submit]").click();
  await expect(form.locator('[data-error-for="email"]')).toContainText("올바른 이메일 형식");
  expect(state.calls.filter((call) => call.path.endsWith("/register"))).toHaveLength(0);

  await form.locator("[name=email]").fill("  Browser@Example.Test  ");
  state.registerStatus = 400;
  await form.locator("button[type=submit]").click();
  await expect(form.locator('[data-error-for="email"]')).toContainText("입력값을 확인하세요");
  state.registerStatus = 409;
  await form.locator("button[type=submit]").click();
  await expect(page.locator("[data-auth-message]")).toContainText("로그인 화면에서 다시 시도하세요");
  state.registerStatus = 201;
  state.loginStatus = 401;
  await form.locator("button[type=submit]").click();
  await expect(page.locator("[data-login-form]")).toBeVisible();
  await expect(page.locator("[data-auth-message]")).toContainText("계정은 생성됐습니다");
  await expect(page.locator("[data-login-form] [name=email]")).toHaveValue("browser@example.test");
  expect(state.calls.filter((call) => call.path.endsWith("/register"))).toHaveLength(3);
  expect(state.calls.findLast((call) => call.path.endsWith("/register")).body).toEqual({
    display_name: "Browser Test", email: "browser@example.test", password: "Test-password-123!", timezone: expect.any(String)
  });
});

test("list retry and failed save preserve input, successful save renders escaped data", async ({ page }, testInfo) => {
  const state = await mockApi(page);
  state.schedules = [
    { id: "past", title: "지난 일정", start_at: "2020-06-15T05:30:00Z", location: "온라인", status: "confirmed" },
    { id: "future", title: "프로젝트 회고", start_at: "2099-06-15T05:30:00Z", location: "회의실", status: "confirmed" }
  ];
  state.listStatus = 503;
  await page.goto("/");
  await login(page);
  await expect(page.locator("[data-reload]")).toBeVisible();
  state.listStatus = 200;
  await page.locator("[data-reload]").click();
  await expect(page.locator("[data-reload]")).toBeHidden();
  await expect(page.locator("[data-view]")).toContainText("프로젝트 회고");
  await expect(page.locator("[data-view]")).not.toContainText("지난 일정");
  await page.screenshot({ path: testInfo.outputPath("dashboard-populated.png"), fullPage: true, animations: "disabled" });
  await navigate(page, "schedules");
  await page.locator("[data-toggle-past]").click();
  await expect(page.locator("[data-view]")).toContainText("지난 일정");
  expect(state.calls.findLast((call) => call.method === "GET" && call.path.endsWith("/schedules")).query).toBe("");
  await navigate(page, "create");
  const form = page.locator("[data-schedule-form]");
  const title = '<img src=x onerror="alert(1)"> 회의';
  await form.locator("[name=title]").fill(title);
  await form.locator("[name=start_at]").fill("2030-06-15T14:30");
  await form.locator("[name=location]").fill("온라인");
  await form.locator("[name=description]").fill("실패 후에도 남아 있어야 하는 메모");
  state.saveStatus = 503;
  await form.locator("button[type=submit]").click();
  await expect(form.locator("button[type=submit]")).toBeEnabled();
  await expect(form.locator("[name=title]")).toHaveValue(title);
  await expect(form.locator("[name=description]")).toHaveValue("실패 후에도 남아 있어야 하는 메모");
  await expect(page.locator("[data-view]")).toContainText("저장하지 못");
  await noPageOverflow(page);
  state.saveStatus = 201;
  await form.locator("button[type=submit]").click();
  await expect(page).toHaveURL(/#schedules$/);
  await expect(page.locator("[data-view]")).toContainText(title);
  await expect(page.locator("[data-view] img")).toHaveCount(0);
  const saved = state.calls.findLast((call) => call.method === "POST" && call.path.endsWith("/schedules"));
  expect(saved.headers.authorization).toBe("Bearer test-access");
  expect(saved.headers["idempotency-key"]).toBeTruthy();
  expect(state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/schedules")).map((call) => call.headers["idempotency-key"])).toEqual([saved.headers["idempotency-key"], saved.headers["idempotency-key"]]);
  expect(saved.body).toMatchObject({ title, location: "온라인", status: "confirmed", all_day: false, source: "manual" });
  await noPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("schedules.png"), fullPage: true, animations: "disabled" });
});

test("expired schedule access is distinct from an empty list", async ({ page }) => {
  const state = await mockApi(page);
  state.listStatus = 401;
  await page.goto("/");
  await login(page);
  await expect(page.locator("[data-view]")).toContainText("로그인이 만료되었습니다");
  await expect(page.locator("[data-view]")).not.toContainText("아직 일정이 없습니다");
});

test("schedule errors distinguish permission, limit, server, and connection", async ({ page }) => {
  const state = await mockApi(page);
  state.listStatus = 403;
  await page.goto("/");
  await login(page);
  for (const [status, message] of [[403, "권한이 없습니다"], [429, "요청이 너무 많습니다"], [503, "서버에 문제가"], [0, "통신이 끊겼습니다"]]) {
    state.listStatus = status;
    if (status !== 403) await page.locator("[data-reload]").click();
    await expect(page.locator("[data-view]")).toContainText(message);
    await expect(page.locator("[data-view]")).not.toContainText("아직 일정이 없습니다");
  }
});

test("schedule failures show the server correlation ID", async ({ page }) => {
  const state = await mockApi(page);
  state.listStatus = 503;
  state.requestId = "123e4567-e89b-12d3-a456-426614174000";
  await page.goto("/");
  await login(page);
  await expect(page.locator("[data-view]")).toContainText(`오류 ID: ${state.requestId}`);
});

test("service status distinguishes followup delay from unavailable schedules", async ({ page }) => {
  const state = await mockApi(page);
  state.serviceStatus = { schedules: "available", followup: "delayed" };
  await page.goto("/");
  await login(page);
  await expect(page.locator("[data-service-status]")).toContainText("일정 기능은 사용 가능하지만 후속 처리 전달이 지연 중");
  state.serviceStatus = { schedules: "unavailable", followup: "delayed" };
  await page.reload();
  await expect(page.locator("[data-service-status]")).toContainText("일정 기능을 현재 사용할 수 없습니다");
  state.serviceStatus = { schedules: "available", followup: "available" };
  await page.reload();
  await expect(page.locator("[data-service-status]")).toBeHidden();
});

test("schedule deletion confirms the title and waits for the server", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = [{ id: "future", title: "프로젝트 회고", start_at: "2099-06-15T05:30:00Z", status: "confirmed" }];
  page.on("dialog", async (dialog) => {
    expect(dialog.message()).toContain("프로젝트 회고");
    expect(dialog.message()).toContain("복구할 수 없습니다");
    await dialog.accept();
  });
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  const row = page.locator("tr", { hasText: "프로젝트 회고" });
  state.deleteStatus = 503;
  await row.getByRole("button", { name: "프로젝트 회고 일정 삭제" }).click();
  await expect(page.locator("[data-toast]")).toContainText("삭제하지 못했습니다");
  await expect(row).toBeVisible();
  state.deleteStatus = 204;
  let completeDelete;
  state.deleteGate = new Promise((resolve) => { completeDelete = resolve; });
  await row.getByRole("button", { name: "프로젝트 회고 일정 삭제" }).click();
  await expect(row.getByRole("button", { name: "프로젝트 회고 일정 삭제" })).toBeDisabled();
  await expect(row).toBeVisible();
  completeDelete();
  await expect(row).toHaveCount(0);
  await expect(page.locator("[data-toast]")).toContainText("삭제되었습니다");
  expect(state.calls.findLast((call) => call.method === "DELETE").path).toBe("/v1/core/schedules/future");
  const deletes = state.calls.filter((call) => call.method === "DELETE");
  expect(deletes[0].headers["idempotency-key"]).toBeTruthy();
  expect(deletes[1].headers["idempotency-key"]).toBe(deletes[0].headers["idempotency-key"]);
  await navigate(page, "dashboard");
  await expect(page.locator("[data-view]")).not.toContainText("프로젝트 회고");
});

test("core schedule actions work by keyboard and detail returns focus", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  const loginForm = page.locator("[data-login-form]");
  await loginForm.getByLabel("이메일").fill("browser@example.test");
  await loginForm.getByLabel("비밀번호").fill("Test-password-123!");
  await loginForm.locator("button[type=submit]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  await navigate(page, "create");
  const form = page.locator("[data-schedule-form]");
  await form.getByLabel("제목").fill("키보드 일정");
  await form.getByLabel("시작 시간").fill("2099-06-15T14:30");
  await form.locator("button[type=submit]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-view]")).toContainText("키보드 일정");
  const detail = page.locator("[data-detail-id]");
  await detail.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("dialog").contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(detail).toBeFocused();
  await page.locator("[data-edit-id]").focus();
  await page.keyboard.press("Enter");
  await form.getByLabel("제목").fill("수정한 키보드 일정");
  await form.locator("button[type=submit]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-view]")).toContainText("수정한 키보드 일정");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-delete-id]").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.schedules.length).toBe(0);
});

test("schedule edit preserves fields on failure and updates only after success", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = [{ id: "future", title: "프로젝트 회고", start_at: "2099-06-15T05:30:00Z", location: "회의실", description: "기존 메모", status: "confirmed", all_day: false }];
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  await page.getByRole("button", { name: "프로젝트 회고 일정 수정" }).click();
  const form = page.locator("[data-schedule-form]");
  await expect(form.locator("[name=title]")).toHaveValue("프로젝트 회고");
  await form.locator("[name=title]").fill("변경된 회고");
  await form.locator("[name=location]").fill("");
  state.updateStatus = 503;
  await form.locator("button[type=submit]").click();
  await expect(form.locator("[name=title]")).toHaveValue("변경된 회고");
  await expect(page.locator("[data-view]")).toContainText("저장하지 못");
  state.updateStatus = 200;
  await form.locator("button[type=submit]").click();
  await expect(page).toHaveURL(/#schedules$/);
  await expect(page.locator("[data-view]")).toContainText("변경된 회고");
  const request = state.calls.findLast((call) => call.method === "PATCH");
  expect(request.path).toBe("/v1/core/schedules/future");
  expect(request.body).toMatchObject({ title: "변경된 회고", location: null, status: "confirmed" });
  expect(request.body).not.toHaveProperty("source");
  expect(request.body).not.toHaveProperty("all_day");
  const updates = state.calls.filter((call) => call.method === "PATCH");
  expect(updates[0].headers["idempotency-key"]).toBeTruthy();
  expect(updates[1].headers["idempotency-key"]).toBe(updates[0].headers["idempotency-key"]);
});

test("theme persists and mobile navigation closes on Escape and selection", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await login(page);
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  await page.locator("[data-theme-toggle]").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (testInfo.project.name === "mobile") {
    const menu = page.locator("button[data-menu-toggle]").first();
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({ path: testInfo.outputPath("drawer-dark.png"), fullPage: true, animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    await navigate(page, "schedules");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
  }
  await noPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("dashboard-dark.png"), fullPage: true, animations: "disabled" });
});

test("AI candidates require confirmation and only failed saves retry with the same key", async ({ page }) => {
  const state = await mockApi(page);
  state.extractTruncated = true;
  state.extractCandidates = [
    { title: "First", start_at: "2030-06-15T05:30:00Z", end_at: null, all_day: false, location: null, description: "", confidence: 0.9 },
    { title: "Second", start_at: null, end_at: null, all_day: false, location: null, description: "", confidence: 0.4, needs_confirmation: true, issues: ["missing_start_at"] },
  ];
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  const form = page.locator("[data-extract-form]");
  await form.locator("[name=text]").fill("First tomorrow; Second next week");
  await form.locator("[name=api_key]").fill("private-test-key");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("[data-candidate]")).toHaveCount(2);
  await expect(page.locator("[data-candidates-form]")).toContainText("일부만 추출됐습니다");
  await noPageOverflow(page);
  expect(state.schedules).toHaveLength(0);
  const extract = state.calls.find((call) => call.path.endsWith("/extract"));
  expect(extract.body).toMatchObject({ text: "First tomorrow; Second next week", timezone: expect.any(String), now: expect.any(String) });
  expect(extract.headers["x-gemini-key"]).toBe("private-test-key");
  const second = page.locator('[data-candidate="1"]');
  await expect(second).toContainText("확인 필요");
  state.failTitle = "Second";
  await page.locator("[data-candidates-form] button[type=submit]").click();
  expect(state.schedules).toHaveLength(0); // unresolved candidate blocks the batch
  await second.locator("[name=selected]").uncheck();
  await page.locator("[data-candidates-form] button[type=submit]").click();
  await expect(page.locator('[data-candidate="0"]')).toContainText("저장됨");
  expect(state.schedules).toHaveLength(1); // excluded incomplete candidate does not block
  await second.locator("[name=selected]").check();
  await second.locator("[name=start_at]").fill("2030-06-16T14:30");
  await second.locator("[name=confirmed]").check();
  await page.locator("[data-candidates-form] button[type=submit]").click();
  await expect(page.locator('[data-candidate="1"]')).toContainText("저장 실패");
  expect(state.schedules).toHaveLength(1);
  const firstSave = state.calls.filter((call) => call.method === "POST" && call.path === "/v1/core/schedules");
  expect(firstSave.map((call) => call.body.source)).toEqual(["ai", "ai"]);
  expect(firstSave[0].headers["idempotency-key"]).not.toBe(firstSave[1].headers["idempotency-key"]);
  state.failTitle = null;
  await page.locator("[data-candidates-form] button[type=submit]").click();
  await expect(page.locator('[data-candidate="1"]')).toContainText("저장됨");
  expect(state.schedules).toHaveLength(2);
  const saves = state.calls.filter((call) => call.method === "POST" && call.path === "/v1/core/schedules");
  expect(saves.map((call) => call.body.title)).toEqual(["First", "Second", "Second"]);
  expect(saves[1].headers["idempotency-key"]).toBe(saves[2].headers["idempotency-key"]);
  expect(await page.evaluate(() => Object.keys(sessionStorage).some((key) => key.includes("gemini")))).toBe(false);
  await navigate(page, "schedules");
  await navigate(page, "extract");
  await expect(page.locator("[data-extract-form] [name=api_key]")).toHaveValue("");
});

test("AI rate limiting keeps the text and manual creation available", async ({ page }) => {
  const state = await mockApi(page);
  state.extractStatus = 429;
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  const form = page.locator("[data-extract-form]");
  await form.locator("[name=text]").fill("Tomorrow at 3 PM");
  await form.locator("button[type=submit]").click();
  await expect(form.locator("[name=text]")).toHaveValue("Tomorrow at 3 PM");
  await expect(form.locator("[role=alert]")).toContainText("사용량 제한");
  await expect(page.locator('[data-view] a[href="#create"]')).toBeVisible();
  expect(state.schedules).toHaveLength(0);
});

test("AI upstream failure is distinguished from usage limits", async ({ page }) => {
  const state = await mockApi(page);
  state.extractStatus = 503;
  state.extractErrorCode = "ai_upstream_unavailable";
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  const form = page.locator("[data-extract-form]");
  await form.locator("[name=text]").fill("Tomorrow at 3 PM");
  await form.locator("button[type=submit]").click();
  await expect(form.locator("[name=text]")).toHaveValue("Tomorrow at 3 PM");
  await expect(form.locator("[role=alert]")).toContainText("외부 AI 서비스에 문제가");
  await expect(form.locator("[role=alert]")).not.toContainText("사용량 제한");
  await expect(page.locator('[data-view] a[href="#create"]')).toBeVisible();
});

test("invalid private AI key is identified", async ({ page }) => {
  const state = await mockApi(page);
  state.extractStatus = 502;
  state.extractErrorCode = "ai_key_invalid";
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  const form = page.locator("[data-extract-form]");
  await form.locator("[name=text]").fill("Tomorrow at 3 PM");
  await form.locator("[name=api_key]").fill("private-test-key");
  await form.locator("button[type=submit]").click();
  await expect(form.locator("[name=text]")).toHaveValue("Tomorrow at 3 PM");
  await expect(form.locator("[role=alert]")).toContainText("개인 AI 키가 올바르지 않습니다");
  await expect(page.locator('[data-view] a[href="#create"]')).toBeVisible();
});

test("AI input errors stay beside the field and focus the first invalid value", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  const form = page.locator("[data-extract-form]");
  await form.locator("[name=text]").fill("   ");
  await form.locator("button[type=submit]").click();
  await expect(form.locator('[data-field-error="text"]')).toContainText("공백만 입력할 수 없고");
  await expect(form.locator("[name=text]")).toBeFocused();
  await form.locator("[name=text]").fill("가".repeat(10001));
  await form.locator("button[type=submit]").click();
  await expect(form.locator('[data-field-error="text"]')).toContainText("10,000자");
  await form.locator("[name=text]").fill("내일 회의");
  await form.locator("[name=timezone]").fill("invalid/zone");
  await form.locator("button[type=submit]").click();
  await expect(form.locator('[data-field-error="timezone"]')).toContainText("IANA 시간대");
  await expect(form.locator("[name=timezone]")).toBeFocused();
  expect(state.calls.filter((call) => call.path.endsWith("/extract"))).toHaveLength(0);
});

test("AI with no events shows zero candidates and creates nothing", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  await page.locator("[data-extract-form] [name=text]").fill("일정 없는 메모");
  await page.locator("[data-extract-form] button[type=submit]").click();
  await expect(page.locator("[data-view]")).toContainText("추출된 일정 후보가 없습니다");
  await expect(page.locator("[data-candidate]")).toHaveCount(0);
  expect(state.calls.filter((call) => call.method === "POST" && call.path === "/v1/core/schedules")).toHaveLength(0);
});

test("AI reference instant and timezone can be reviewed and changed", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  const form = page.locator("[data-extract-form]");
  await expect(form).toContainText("기준 일시 (브라우저 시간대");
  await form.locator("[name=text]").fill("다음 주 회의");
  await form.locator("[name=now]").fill("2030-06-15T09:00");
  await form.locator("[name=timezone]").fill("Asia/Seoul");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("[data-extract-form] button[type=submit]")).toBeEnabled();
  const first = state.calls.find((call) => call.path.endsWith("/extract"));
  await form.locator("[name=now]").fill("2030-06-16T09:00");
  await form.locator("button[type=submit]").click();
  await expect.poll(() => state.calls.filter((call) => call.path.endsWith("/extract")).length).toBe(2);
  const second = state.calls.findLast((call) => call.path.endsWith("/extract"));
  expect(second.body.now).not.toBe(first.body.now);
  expect(second.body.timezone).toBe("Asia/Seoul");
});

test("AI with no configured key is disabled until a private key is entered", async ({ page }) => {
  const state = await mockApi(page);
  state.extractStatus = 502;
  state.extractErrorCode = "ai_key_unavailable";
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  const form = page.locator("[data-extract-form]");
  await form.locator("[name=text]").fill("Tomorrow at 3 PM");
  await form.locator("button[type=submit]").click();
  await expect(form.locator("[role=alert]")).toContainText("공용 키가 설정되지 않았습니다");
  await expect(form.locator("button[type=submit]")).toBeDisabled();
  await expect(page.locator('[data-view] a[href="#create"]')).toBeVisible();
  await form.locator("[name=api_key]").fill("private-test-key");
  await expect(form.locator("button[type=submit]")).toBeEnabled();
});

test("manual schedule keeps optional time fields and verifies the saved detail", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await login(page);
  await navigate(page, "create");
  const form = page.locator("[data-schedule-form]");
  await form.locator("[name=title]").fill("종일 행사");
  await form.locator("[name=start_at]").fill("2030-01-02T09:00");
  await form.locator("[name=end_at]").fill("2030-01-02T10:00");
  await form.locator("[name=all_day]").check();
  await form.locator("[name=reminder_minutes]").fill("10");
  await form.locator("button[type=submit]").click();
  await expect(page).toHaveURL(/#schedules$/);
  const create = state.calls.find((call) => call.method === "POST" && call.path.endsWith("/schedules"));
  expect(create.body).toMatchObject({ all_day: true, reminders: [{ minutes_before: 10, channel: "none" }] });
  expect(state.calls.some((call) => call.method === "GET" && call.path.endsWith("/schedules/test-schedule"))).toBe(true);
  await page.locator("[data-detail-id]").click();
  await expect(page.locator("dialog")).toContainText("종일 행사");
  await page.locator("[data-close-detail]").click();
});

test("past schedule can be recorded without promising a new reminder delivery", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await login(page);
  await navigate(page, "create");
  const form = page.locator("[data-schedule-form]");
  await expect(page.locator("[data-view]")).toContainText("실제 발송 알림은 현재 지원하지 않습니다");
  await form.locator("[name=title]").fill("지난 기록");
  await form.locator("[name=start_at]").fill("2020-01-02T09:00");
  await form.locator("[name=reminder_minutes]").fill("10");
  await form.locator("button[type=submit]").click();
  await expect(page).toHaveURL(/#schedules$/);
  const create = state.calls.find((call) => call.method === "POST" && call.path === "/v1/core/schedules");
  expect(new Date(create.body.start_at).getTime()).toBeLessThan(Date.now());
  expect(create.body.reminders).toEqual([{ minutes_before: 10, channel: "none" }]);
  await page.locator("[data-toggle-past]").click();
  await expect(page.locator("[data-view]")).toContainText("지난 기록");
});

test("logout discards a late detail response", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = [{ id: "future", title: "비공개 일정", start_at: "2030-01-02T09:00:00Z", status: "confirmed", source: "manual" }];
  let release;
  state.detailGate = new Promise((resolve) => { release = resolve; });
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  await page.locator("[data-detail-id]").click();
  await expect.poll(() => state.calls.some((call) => call.method === "GET" && call.path.endsWith("/schedules/future"))).toBe(true);
  const menu = page.locator("button[data-menu-toggle]").first();
  if (await menu.isVisible()) await menu.click();
  await page.locator("[data-logout]").click();
  release();
  await expect(page.locator("[data-authenticated]")).toBeHidden();
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.locator("[data-view]")).toBeEmpty();
});

test("inaccessible detail removes private list content", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = [{ id: "inaccessible", title: "비공개 상세", start_at: "2099-01-01T09:00:00Z", status: "confirmed" }];
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  state.detailStatus = 403;
  await page.locator("[data-detail-id]").click();
  await expect(page.locator("[data-view]")).not.toContainText("비공개 상세");
  await expect(page.locator("[data-toast]")).toContainText("접근 권한이 사라졌습니다");
  await expect(page.locator("dialog")).toHaveCount(0);
});

test("deleted detail closes when a reminder action returns 404", async ({ page }) => {
  const state = await mockApi(page);
  state.reminderStatus = 404;
  state.schedules = [{ id: "removed", title: "삭제된 비공개 일정", start_at: "2099-01-01T09:00:00Z", status: "confirmed" }];
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  await page.locator("[data-detail-id]").click();
  await expect(page.locator("dialog")).toContainText("삭제된 비공개 일정");
  await page.locator("[data-add-reminder] button[type=submit]").click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.locator("[data-view]")).not.toContainText("삭제된 비공개 일정");
  await expect(page.locator("[data-toast]")).toContainText("목록에서 제거했습니다");
});

test("reminder action shows progress and restores its button after failure", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = [{ id: "reminder", title: "리마인더 일정", start_at: "2099-01-01T09:00:00Z", status: "confirmed" }];
  state.reminderStatus = 503;
  let releaseReminder;
  state.reminderGate = new Promise((resolve) => { releaseReminder = resolve; });
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  await page.locator("[data-detail-id]").click();
  const button = page.locator("[data-add-reminder] button[type=submit]");
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText("추가 중…");
  releaseReminder();
  await expect(button).toBeEnabled();
  await expect(button).toHaveText("리마인더 추가");
  state.reminderStatus = 201;
  state.reminderGate = null;
  await button.click();
  await expect(page.locator("dialog")).toContainText("10분 전");
});

test("logout discards a late delete response", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = [{ id: "late-delete", title: "첫 계정 일정", start_at: "2099-01-01T09:00:00Z", status: "confirmed" }];
  let releaseDelete;
  state.deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-delete-id]").click();
  await expect(page.locator("[data-delete-id]")).toBeDisabled();
  const menu = page.locator("button[data-menu-toggle]").first();
  if (await menu.isVisible()) await menu.click();
  await page.locator("[data-logout]").click();
  releaseDelete();
  await expect(page.locator("[data-authenticated]")).toBeHidden();
  await expect(page.locator("[data-view]")).toBeEmpty();
  await expect(page.locator("[data-toast]")).not.toContainText("일정이 삭제되었습니다");
});

test("schedule period uses an inclusive local end date and keeps dashboard data", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = [{ id: "future", title: "기간 일정", start_at: "2030-01-02T09:00:00Z", status: "confirmed", source: "manual" }];
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  const form = page.locator("[data-period-form]");
  await form.locator("[name=from]").fill("2030-01-01");
  await form.locator("[name=to]").fill("2030-01-02");
  await form.locator("button[type=submit]").click();
  await expect.poll(() => state.calls.findLast((call) => call.method === "GET" && call.path.endsWith("/schedules"))?.query).toContain("from=");
  const query = new URLSearchParams(state.calls.findLast((call) => call.method === "GET" && call.path.endsWith("/schedules")).query);
  expect(new Date(query.get("to")).getTime() - new Date(query.get("from")).getTime()).toBe(2 * 86400000);
  await expect(page.locator("[data-view]")).toContainText("기간 일정");
  await navigate(page, "dashboard");
  await expect(page.locator("[data-view]")).toContainText("기간 일정");
});

test("stable schedule pages avoid duplicates and refresh latest results", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = Array.from({ length: 25 }, (_, index) => ({ id: `s-${index}`, title: `일정 ${String(index).padStart(2, "0")}`, start_at: `2030-02-${String(index + 1).padStart(2, "0")}T09:00:00Z`, status: "confirmed", source: "manual" }));
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  await expect(page.locator("[data-view]")).toContainText("1 / 2쪽");
  await expect(page.locator("[data-view]")).toContainText("일정 00");
  await page.locator("[data-page=next]").click();
  await expect(page.locator("[data-view]")).toContainText("일정 20");
  await expect(page.locator("[data-view]")).not.toContainText("일정 00");
  state.schedules.push({ id: "s-25", title: "일정 25", start_at: "2030-02-26T09:00:00Z", status: "confirmed", source: "manual" });
  await page.locator("[data-refresh-list]").click();
  await expect(page.locator("[data-view]")).toContainText("일정 25");
});

test("changing display timezone leaves stored instants unchanged", async ({ page }) => {
  const state = await mockApi(page);
  state.schedules = [{ id: "future", title: "세계 회의", start_at: "2030-01-02T09:00:00Z", status: "confirmed", source: "manual" }];
  await page.goto("/");
  await login(page);
  await navigate(page, "schedules");
  await page.locator("[data-display-timezone]").selectOption("UTC");
  await expect(page.locator("[data-view]")).toContainText("오전 9:00");
  await page.locator("[data-detail-id]").click();
  await expect(page.locator("dialog")).toContainText("표시 시간대: UTC");
  expect(state.schedules[0].start_at).toBe("2030-01-02T09:00:00Z");
});

test("dashboard counts real owned schedules and excludes cancelled entries", async ({ page }) => {
  const state = await mockApi(page);
  const today = new Date();
  const todayAtNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const tomorrow = new Date(todayAtNoon);
  tomorrow.setDate(tomorrow.getDate() + 1);
  state.schedules = [
    { id: "a", title: "오늘 하나", start_at: todayAtNoon.toISOString(), status: "confirmed" },
    { id: "b", title: "오늘 둘", start_at: todayAtNoon.toISOString(), status: "tentative" },
    { id: "c", title: "취소 일정", start_at: todayAtNoon.toISOString(), status: "cancelled" },
    { id: "d", title: "내일 일정", start_at: tomorrow.toISOString(), status: "confirmed" },
  ];
  await page.goto("/");
  await login(page);
  await expect(page.locator("[aria-label='일정 개수']")).toContainText("오늘 2개");
  await expect(page.locator("[aria-label='일정 개수']")).toContainText("취소 제외");
  await expect(page.locator("[data-view]")).not.toContainText("취소 일정");
});

test("schedule errors appear beside fields and focus the first invalid field", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await login(page);
  await navigate(page, "create");
  const form = page.locator("[data-schedule-form]");
  await form.locator("[name=title]").fill("   ");
  await form.locator("[name=start_at]").fill("2030-01-02T10:00");
  await form.locator("[name=end_at]").fill("2030-01-02T09:00");
  await form.locator("button[type=submit]").click();
  await expect(form.locator('[data-field-error="title"]')).toContainText("제목을 입력");
  await expect(form.locator('[data-field-error="end_at"]')).toContainText("종료 시간");
  await expect(form.locator("[name=title]")).toBeFocused();
  await form.locator("[name=title]").fill("정상 일정");
  await form.locator("button[type=submit]").click();
  await expect(form.locator("[name=end_at]")).toBeFocused();
  expect(state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/schedules"))).toHaveLength(0);
});

test("malformed AI candidate is isolated and cannot be saved before correction", async ({ page }) => {
  const state = await mockApi(page);
  state.extractCandidates = [
    { title: "정상", start_at: "2030-01-02T09:00:00Z", all_day: false, issues: [] },
    { title: 42, start_at: "not-a-date", issues: "invalid" },
  ];
  await page.goto("/");
  await login(page);
  await navigate(page, "extract");
  await page.locator("[data-extract-form] [name=text]").fill("정상 일정과 잘못된 일정");
  await page.locator("[data-extract-form] button[type=submit]").click();
  await expect(page.locator("[data-candidate]")).toHaveCount(2);
  await expect(page.locator('[data-candidate="1"]')).toContainText("AI 후보 필드 형식");
  await page.locator("[data-candidates-form] button[type=submit]").click();
  await expect(page.locator('[data-candidate="1"] [data-field-error="start_at"]')).toContainText("올바른 시작 시간");
  expect(state.schedules).toHaveLength(0);
  await page.locator('[data-candidate="1"] [name=selected]').uncheck();
  await page.locator("[data-candidates-form] button[type=submit]").click();
  await expect(page.locator('[data-candidate="0"]')).toContainText("저장됨");
  expect(state.schedules).toHaveLength(1);
});

test("lost create response offers confirmation with the same operation key", async ({ page }) => {
  const state = await mockApi(page);
  state.saveResponseLost = true;
  await page.goto("/");
  await login(page);
  await navigate(page, "create");
  const form = page.locator("[data-schedule-form]");
  await form.locator("[name=title]").fill("응답 유실 일정");
  await form.locator("[name=start_at]").fill("2030-01-02T09:00");
  await form.locator("button[type=submit]").click();
  await expect(form.locator("[role=alert]")).toContainText("저장 여부를 확인할 수 없습니다");
  await form.getByRole("button", { name: "같은 작업 결과 확인" }).click();
  await expect(page).toHaveURL(/#schedules$/);
  const calls = state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/schedules"));
  expect(calls).toHaveLength(2);
  expect(calls[0].headers["idempotency-key"]).toBe(calls[1].headers["idempotency-key"]);
  expect(state.schedules).toHaveLength(1);
});
