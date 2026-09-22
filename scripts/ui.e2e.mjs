import { test, expect } from "@playwright/test";

const apiOrigin = "https://api.example.test";
const tokens = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 };

// No account or schedule is written to a real service by these browser checks.
async function mockApi(page) {
  const state = { loginStatus: 200, refreshStatus: 200, listStatus: 200, saveStatus: 201, schedules: [], calls: [] };
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
    if (url.pathname.endsWith("/register")) return route.fulfill({ status: 201, json: { id: "test-user" } });
    if (url.pathname.endsWith("/logout")) return route.fulfill({ status: 204 });
    if (url.pathname === "/v1/core/schedules") {
      if (method === "GET") return route.fulfill({ status: state.listStatus, json: { schedules: state.schedules } });
      if (method === "POST") {
        if (state.saveStatus !== 201) return route.fulfill({ status: state.saveStatus, json: { error: "unavailable" } });
        const schedule = { id: "test-schedule", ...body };
        state.schedules.push(schedule);
        return route.fulfill({ status: 201, json: schedule });
      }
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
  await form.locator("button[type=submit]").click();
  await expect(page.locator("[data-authenticated]")).toBeVisible();
  expect(state.calls.find((call) => call.path.endsWith("/register")).body).toMatchObject({ display_name: "Browser Test", email: "browser@example.test" });
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
  expect(saved.body).toMatchObject({ title, location: "온라인", status: "confirmed", all_day: false, source: "manual" });
  await noPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("schedules.png"), fullPage: true, animations: "disabled" });
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
