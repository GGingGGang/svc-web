import { test, expect } from "@playwright/test";

const apiOrigin = "https://api.example.test";
const tokens = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 };

// No account or schedule is written to a real service by these browser checks.
async function mockApi(page) {
  const state = { loginStatus: 200, registerStatus: 201, registerMessage: "Invalid email", refreshStatus: 200, listStatus: 200, saveStatus: 201, failTitle: null, extractStatus: 200, extractErrorCode: "extraction_failed", extractCandidates: [], extractTruncated: false, updateStatus: 200, deleteStatus: 204, deleteGate: null, schedules: [], calls: [] };
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
    if (url.pathname === "/v1/core/schedules/extract") return route.fulfill({ status: state.extractStatus, json: state.extractStatus === 200 ? { candidates: state.extractCandidates, truncated: state.extractTruncated } : { error: state.extractErrorCode } });
    if (url.pathname === "/v1/core/schedules") {
      if (method === "GET") return route.fulfill({ status: state.listStatus, json: { schedules: state.schedules } });
      if (method === "POST") {
        if (state.saveStatus !== 201 || body.title === state.failTitle) return route.fulfill({ status: state.saveStatus !== 201 ? state.saveStatus : 503, json: { error: "unavailable" } });
        const schedule = { id: "test-schedule", ...body };
        state.schedules.push(schedule);
        return route.fulfill({ status: 201, json: schedule });
      }
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
  const menu = page.locator("button[data-menu-toggle]").first();
  if (await menu.isVisible()) await menu.click();
  await page.locator(`[data-route="${route}"]`).click();
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
  await expect.poll(() => state.calls.some((call) => call.path.endsWith("/schedules"))).toBe(true);
  await noPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("dashboard-empty.png"), fullPage: true, animations: "disabled" });
  const menu = page.locator("button[data-menu-toggle]").first();
  if (await menu.isVisible()) await menu.click();
  await page.locator("[data-logout]").click();
  await expect(page.locator("[data-authenticated]")).toBeHidden();
  await expect(page.locator("[data-login-form] button[type=submit]")).toBeEnabled();
  await login(page);
  await expect(page.locator("[data-authenticated]")).toBeVisible();
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
  await navigate(page, "dashboard");
  await expect(page.locator("[data-view]")).not.toContainText("프로젝트 회고");
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
