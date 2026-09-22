import {
  AuthClient,
  ScheduleClient,
  getBrowserTimezone,
  getServiceHealth,
  readConfig,
  statusText,
} from "./app.js";

const icon = (path) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

function scheduleDate(schedule) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(new Date(schedule.start_at));
}
function scheduleTime(schedule) {
  return schedule.all_day
    ? "하루 종일"
    : new Intl.DateTimeFormat("ko-KR", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(schedule.start_at));
}
function emptyMarkup() {
  return `<div class="empty"><strong>아직 일정이 없습니다.</strong><span>첫 일정을 추가하면 여기에서 확인할 수 있어요.</span></div>`;
}
function loadingMarkup() {
  return `<div class="loading"><span class="spinner"></span><div>일정을 불러오는 중입니다.</div></div>`;
}
function errorMarkup(message) {
  return `<div class="api-error"><p>${escapeHtml(message)}</p><button class="btn btn-secondary" type="button" data-reload>다시 시도</button></div>`;
}
function scheduleItem(schedule) {
  return `<li class="schedule-item"><span class="schedule-date">${scheduleDate(schedule)}</span><div><strong>${escapeHtml(schedule.title)}</strong><p>${escapeHtml(schedule.location || "장소 없음")}</p></div><span class="schedule-time">${scheduleTime(schedule)}</span></li>`;
}
function dashboardView(state) {
  const upcoming = state.items.filter(
    (item) => new Date(item.start_at) >= new Date(),
  );
  const body = state.loading
    ? loadingMarkup()
    : state.error
      ? errorMarkup(state.error)
      : upcoming.length
        ? `<ul class="schedule-list">${upcoming.slice(0, 5).map(scheduleItem).join("")}</ul>`
        : emptyMarkup();
  return `<div class="page-heading"><div><h1>내 일정</h1><p>다가오는 일정만 간단히 보여드립니다.</p></div><a class="btn btn-primary" href="#create">${icon("M12 5v14M5 12h14")}일정 만들기</a></div><section class="card"><div class="card-head"><div><h2>다가오는 일정</h2><p>Core API에서 가져온 실제 일정입니다.</p></div><a href="#schedules">전체 보기</a></div>${body}</section>`;
}
function schedulesView(state) {
  const rows = state.items
    .map(
      (item) =>
        `<tr><td><strong>${escapeHtml(item.title)}</strong></td><td>${scheduleDate(item)} ${scheduleTime(item)}</td><td>${escapeHtml(item.location || "-")}</td><td><span class="badge">${escapeHtml(item.status || "confirmed")}</span></td></tr>`,
    )
    .join("");
  const body = state.loading
    ? loadingMarkup()
    : state.error
      ? errorMarkup(state.error)
      : state.items.length
        ? `<div class="table-wrap"><table class="schedule-table"><thead><tr><th>제목</th><th>일시</th><th>장소</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : emptyMarkup();
  return `<div class="page-heading"><div><h1>모든 일정</h1><p>Core API에서 관리되는 내 일정입니다.</p></div><a class="btn btn-primary" href="#create">${icon("M12 5v14M5 12h14")}일정 만들기</a></div><section class="card">${body}</section>`;
}
function createView(draft = {}) {
  const now =
    draft.start_at ||
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  return `<div class="page-heading"><div><h1>일정 만들기</h1><p>저장하면 Core API에 바로 반영됩니다.</p></div></div><form class="card form-card" data-schedule-form><div class="form-grid"><label class="field"><span>제목</span><input class="input" name="title" maxlength="255" required placeholder="팀 회의" value="${escapeHtml(draft.title || "")}"></label><label class="field"><span>시작 시간</span><input class="input" name="start_at" type="datetime-local" required value="${escapeHtml(now)}"></label><label class="field"><span>장소</span><input class="input" name="location" maxlength="255" placeholder="온라인 또는 장소" value="${escapeHtml(draft.location || "")}"></label><label class="field"><span>상태</span><select class="select" name="status"><option value="confirmed" ${draft.status === "tentative" || draft.status === "cancelled" ? "" : "selected"}>확정</option><option value="tentative" ${draft.status === "tentative" ? "selected" : ""}>미정</option><option value="cancelled" ${draft.status === "cancelled" ? "selected" : ""}>취소</option></select></label><label class="field span-2"><span>설명</span><textarea class="textarea" name="description" placeholder="선택 사항">${escapeHtml(draft.description || "")}</textarea></label></div><div class="form-actions"><a class="btn btn-secondary" href="#schedules">취소</a><span class="spacer"></span><button type="submit" class="btn btn-primary">일정 저장</button></div></form>`;
}

function init() {
  const config = readConfig();
  const auth = new AuthClient({ config });
  const schedules = new ScheduleClient({ config, authClient: auth });
  const anonymous = document.querySelector("[data-auth-anonymous]");
  const application = document.querySelector("[data-authenticated]");
  const view = document.querySelector("[data-view]");
  const toast = document.querySelector("[data-toast]");
  const state = { items: [], loading: false, error: "", draft: {} };
  const titles = {
    dashboard: ["WORKSPACE", "개요"],
    schedules: ["SCHEDULES", "모든 일정"],
    create: ["SCHEDULES", "일정 만들기"],
  };
  let toastTimer;
  const currentRoute = () =>
    titles[location.hash.slice(1)] ? location.hash.slice(1) : "dashboard";
  const setBusy = (form, busy, label) => {
    const button = form.querySelector("button[type=submit]");
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? label : button.dataset.label;
  };
  const feedback = (message, type = "info") => {
    const target = document.querySelector("[data-auth-message]");
    target.textContent = message;
    target.className = `alert ${type}`;
  };
  const notify = (message, error = false) => {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast${error ? " error" : ""}`;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 4200);
  };
  const menuButton = document.querySelector("button[data-menu-toggle]");
  const sidebar = document.querySelector(".d-sidebar");
  const closeMenu = () => {
    const restoreFocus =
      application.classList.contains("menu-open") &&
      sidebar.contains(document.activeElement);
    application.classList.remove("menu-open");
    menuButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) menuButton.focus();
  };
  const toggleMenu = () => {
    const open = application.classList.toggle("menu-open");
    menuButton.setAttribute("aria-expanded", String(open));
    if (open) sidebar.querySelector("[data-route]").focus();
  };
  const setMode = (mode) => {
    const register = mode === "register";
    document.querySelector("[data-login-form]").hidden = register;
    document.querySelector("[data-register-form]").hidden = !register;
    document.querySelectorAll("[data-auth-mode]").forEach((button) => {
      const active = button.dataset.authMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelector("[data-auth-title]").textContent = register
      ? "계정을 만들어요"
      : "다시 만나서 반가워요";
    document.querySelector("[data-auth-subtitle]").textContent = register
      ? "가입 후 바로 로그인할 수 있어요."
      : "계속하려면 로그인하세요.";
    feedback(
      register ? "가입 후 바로 로그인됩니다." : "API Gateway에 연결합니다.",
    );
  };
  const render = () => {
    const route = currentRoute();
    document
      .querySelectorAll("[data-route]")
      .forEach((link) =>
        link.classList.toggle("is-active", link.dataset.route === route),
      );
    document.querySelector("[data-page-kicker]").textContent = titles[route][0];
    document.querySelector("[data-page-title]").textContent = titles[route][1];
    view.innerHTML =
      route === "schedules"
        ? schedulesView(state)
        : route === "create"
          ? createView(state.draft)
          : dashboardView(state);
    view
      .querySelector("[data-reload]")
      ?.addEventListener("click", loadSchedules);
    view
      .querySelector("[data-schedule-form]")
      ?.addEventListener("submit", saveSchedule);
  };
  const loadSchedules = async () => {
    state.loading = true;
    state.error = "";
    render();
    try {
      state.items = await schedules.list();
    } catch (error) {
      state.items = [];
      state.error = `일정을 불러오지 못했습니다. API Gateway 연결을 확인한 뒤 다시 시도하세요. (${error.message})`;
    } finally {
      state.loading = false;
      render();
    }
  };
  const openApp = async (restore = false) => {
    if (restore) {
      try {
        await auth.refresh();
      } catch (error) {
        auth.clear();
        anonymous.hidden = false;
        application.hidden = true;
        feedback(error.message, "error");
        return;
      }
    }
    anonymous.hidden = true;
    application.hidden = false;
    closeMenu();
    if (!location.hash) location.hash = "#dashboard";
    await loadSchedules();
  };
  const saveSchedule = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    state.draft = values;
    form.querySelector(".alert")?.remove();
    setBusy(form, true, "저장 중…");
    try {
      await schedules.create({
        title: values.title,
        start_at: new Date(values.start_at).toISOString(),
        location: values.location || null,
        description: values.description || null,
        status: values.status,
        all_day: false,
        source: "manual",
      });
      state.draft = {};
      notify("일정이 저장되었습니다.");
      location.hash = "#schedules";
      await loadSchedules();
    } catch (error) {
      setBusy(form, false);
      const alert = document.createElement("div");
      alert.className = "alert error";
      alert.setAttribute("role", "alert");
      alert.textContent = `일정을 저장하지 못했습니다. ${error.message}`;
      form.prepend(alert);
    }
  };
  document.querySelector("[data-timezone]").value = getBrowserTimezone();
  document.querySelectorAll("[data-version]").forEach((element) => {
    element.textContent = config.version;
  });
  document.documentElement.dataset.theme =
    localStorage.getItem("svc-web.theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document
    .querySelector("[data-theme-toggle]")
    .addEventListener("click", () => {
      const next =
        document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("svc-web.theme", next);
    });
  menuButton.setAttribute("aria-expanded", "false");
  document
    .querySelectorAll("[data-menu-toggle]")
    .forEach((button) => button.addEventListener("click", toggleMenu));
  document
    .querySelectorAll("[data-route]")
    .forEach((link) => link.addEventListener("click", closeMenu));
  document
    .querySelectorAll("[data-auth-mode]")
    .forEach((button) =>
      button.addEventListener("click", () => setMode(button.dataset.authMode)),
    );
  document
    .querySelector("[data-login-form]")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      setBusy(form, true, "로그인 중…");
      try {
        await auth.login(Object.fromEntries(new FormData(form)));
        setBusy(form, false);
        await openApp();
        notify("로그인되었습니다.");
      } catch (error) {
        setBusy(form, false);
        feedback(error.message, "error");
      }
    });
  document
    .querySelector("[data-register-form]")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const fields = Object.fromEntries(new FormData(form));
      setBusy(form, true, "계정 만드는 중…");
      try {
        await auth.register(fields);
        await auth.login({ email: fields.email, password: fields.password });
        setBusy(form, false);
        await openApp();
        notify("계정을 만들고 로그인했습니다.");
      } catch (error) {
        setBusy(form, false);
        feedback(error.message, "error");
      }
    });
  document
    .querySelector("[data-logout]")
    .addEventListener("click", async () => {
      try {
        await auth.logout();
        notify("로그아웃되었습니다.");
      } catch {
        notify(
          "이 탭의 로그인 정보는 삭제했습니다. 서버 로그아웃은 다시 시도하세요.",
          true,
        );
      }
      state.items = [];
      state.draft = {};
      state.error = "";
      view.replaceChildren();
      closeMenu();
      anonymous.hidden = false;
      application.hidden = true;
      document.querySelectorAll(".auth-form").forEach((form) => {
        form.reset();
        setBusy(form, false);
      });
      document.querySelector("[data-timezone]").value = getBrowserTimezone();
      setMode("login");
    });
  window.addEventListener("hashchange", render);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  getServiceHealth().then((payload) =>
    document.querySelectorAll("[data-status]").forEach((element) => {
      element.classList.toggle("ready", statusText(payload) === "ready");
      element.title = statusText(payload);
    }),
  );
  if (auth.hasSession()) openApp(true);
  else setMode("login");
}

if (typeof document !== "undefined") init();
