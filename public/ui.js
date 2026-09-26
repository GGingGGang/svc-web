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
let displayTimezone = getBrowserTimezone();
const displayZones = [...new Set([getBrowserTimezone(), "UTC", "Asia/Seoul", "America/New_York", "Europe/London"])];

function scheduleDate(schedule) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    timeZone: displayTimezone,
  }).format(new Date(schedule.start_at));
}
function scheduleTime(schedule) {
  return schedule.all_day
    ? "하루 종일"
    : new Intl.DateTimeFormat("ko-KR", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: displayTimezone,
      }).format(new Date(schedule.start_at));
}
function localDateTime(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function scheduleErrors(values) {
  const start = Date.parse(values.start_at);
  const end = values.end_at ? Date.parse(values.end_at) : null;
  const minutes = values.reminder_minutes;
  return {
    title: !values.title?.trim() ? "제목을 입력하세요." : [...values.title].length > 255 ? "제목은 255자 이하여야 합니다." : "",
    start_at: !values.start_at || Number.isNaN(start) ? "올바른 시작 시간을 입력하세요." : "",
    end_at: values.end_at && (Number.isNaN(end) || end <= start) ? "종료 시간은 시작보다 늦어야 합니다." : "",
    location: [...(values.location || "")].length > 255 ? "장소는 255자 이하여야 합니다." : "",
    description: [...(values.description || "")].length > 10000 ? "설명은 10,000자 이하여야 합니다." : "",
    ...(minutes === undefined ? {} : { reminder_minutes: minutes && (!Number.isInteger(Number(minutes)) || Number(minutes) < 0 || Number(minutes) > 10080) ? "리마인더는 0~10,080분 사이로 입력하세요." : "" }),
  };
}
function candidateError(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "AI 후보 형식이 올바르지 않습니다. 내용을 직접 확인·수정하세요.";
  if (typeof data.title !== "string" || typeof data.start_at !== "string" || (data.end_at != null && typeof data.end_at !== "string") || (data.location != null && typeof data.location !== "string") || (data.description != null && typeof data.description !== "string") || (data.all_day != null && typeof data.all_day !== "boolean") || (data.needs_confirmation != null && typeof data.needs_confirmation !== "boolean") || (data.issues != null && (!Array.isArray(data.issues) || data.issues.some((issue) => typeof issue !== "string")))) return "AI 후보 필드 형식이 올바르지 않습니다. 내용을 직접 확인·수정하세요.";
  return Object.values(scheduleErrors(data)).find(Boolean) || "";
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
function withRequestId(error, message) {
  return `${message}${error.requestId && !message.includes("오류 ID:") ? ` 오류 ID: ${error.requestId}` : ""}`;
}
function scheduleFailure(error, action) {
  const reason = error.status === 401 ? "로그인이 만료되었습니다. 다시 로그인하세요." : error.status === 403 ? "이 일정에 접근할 권한이 없습니다. 목록을 새로고침하세요." : error.status === 429 ? "요청이 너무 많습니다. 잠시 후 다시 시도하세요." : error.status >= 500 ? "서버에 문제가 생겼습니다. 잠시 후 다시 시도하세요." : error.status ? "입력값이나 요청 상태를 확인하세요." : "통신이 끊겼습니다. 연결을 확인하고 다시 시도하세요.";
  return withRequestId(error, `${action} ${reason}`);
}
function scheduleItem(schedule) {
  return `<li class="schedule-item"><span class="schedule-date">${scheduleDate(schedule)}</span><div><strong>${escapeHtml(schedule.title)}</strong><p>${escapeHtml(schedule.location || "장소 없음")}</p></div><span class="schedule-time">${scheduleTime(schedule)}</span></li>`;
}
function dashboardView(state) {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const weekStart = new Date(dayStart);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const nextWeek = new Date(weekStart);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const active = state.items.filter((item) => item.status !== "cancelled");
  const upcoming = active.filter((item) => new Date(item.start_at) >= now);
  const count = (from, to) => active.filter((item) => { const start = new Date(item.start_at); return start >= from && start < to; }).length;
  const summary = state.loading || state.error ? "" : `<div class="card form-actions" aria-label="일정 개수"><span>오늘 ${count(dayStart, nextDay)}개</span><span>이번 주 ${count(weekStart, nextWeek)}개</span><span>다가오는 일정 ${upcoming.length}개</span><small>브라우저 시간대 ${escapeHtml(getBrowserTimezone())} · 월요일 시작 · 취소 제외</small></div>`;
  const body = state.loading
    ? loadingMarkup()
    : state.error
      ? errorMarkup(state.error)
      : upcoming.length
        ? `<ul class="schedule-list">${upcoming.slice(0, 5).map(scheduleItem).join("")}</ul>`
        : emptyMarkup();
  return `<div class="page-heading"><div><h1>내 일정</h1><p>다가오는 일정만 간단히 보여드립니다.</p></div><a class="btn btn-primary" href="#create">${icon("M12 5v14M5 12h14")}일정 만들기</a></div>${summary}<section class="card"><div class="card-head"><div><h2>다가오는 일정</h2><p>Core API에서 가져온 실제 일정입니다.</p></div><a href="#schedules">전체 보기</a></div>${body}</section>`;
}
function schedulesView(state) {
  const shown = state.period ? state.periodItems : state.showPast ? state.items : state.items.filter((item) => new Date(item.start_at) >= new Date());
  const pageCount = Math.max(1, Math.ceil(shown.length / 20));
  const page = Math.min(state.page, pageCount - 1);
  const rows = shown.slice(page * 20, (page + 1) * 20)
    .map(
      (item) =>
        `<tr><td><strong>${escapeHtml(item.title)}</strong></td><td>${scheduleDate(item)} ${scheduleTime(item)}</td><td>${escapeHtml(item.location || "-")}</td><td><span class="badge">${escapeHtml(item.status || "confirmed")}</span></td><td><button class="btn btn-secondary" type="button" data-detail-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 상세">상세</button> <button class="btn btn-secondary" type="button" data-edit-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 수정">수정</button> <button class="btn btn-secondary" type="button" data-delete-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 삭제">삭제</button></td></tr>`,
    )
    .join("");
  const body = state.loading || state.periodLoading
    ? loadingMarkup()
    : state.periodError || state.error
      ? errorMarkup(state.periodError || state.error)
      : shown.length
        ? `<div class="table-wrap"><table class="schedule-table"><thead><tr><th>제목</th><th>일시</th><th>장소</th><th>상태</th><th>작업</th></tr></thead><tbody>${rows}</tbody></table></div><div class="form-actions"><button class="btn btn-secondary" type="button" data-page="previous" ${page === 0 ? "disabled" : ""}>이전</button><span>${page + 1} / ${pageCount}쪽 · ${shown.length}개</span><button class="btn btn-secondary" type="button" data-page="next" ${page + 1 >= pageCount ? "disabled" : ""}>다음</button></div>`
        : emptyMarkup();
  return `<div class="page-heading"><div><h1>모든 일정</h1><p>${state.period ? "선택 기간" : state.showPast ? "과거 일정 포함" : "현재 이후 일정"} · 시작 시각순</p></div><a class="btn btn-primary" href="#create">${icon("M12 5v14M5 12h14")}일정 만들기</a></div><section class="card"><label class="field"><span>표시 시간대</span><select class="select" data-display-timezone>${displayZones.map((zone) => `<option value="${escapeHtml(zone)}" ${zone === displayTimezone ? "selected" : ""}>${escapeHtml(zone)}</option>`).join("")}</select></label><form data-period-form class="form-actions"><label class="field"><span>시작 날짜 (브라우저 시간대)</span><input class="input" name="from" type="date" value="${escapeHtml(state.period?.from || "")}"></label><label class="field"><span>종료 날짜 (브라우저 시간대)</span><input class="input" name="to" type="date" value="${escapeHtml(state.period?.to || "")}"></label><button class="btn btn-secondary" type="submit">기간 조회</button><button class="btn btn-secondary" type="button" data-clear-period>기간 초기화</button></form><button class="btn btn-secondary" type="button" data-toggle-past>${state.showPast ? "다가오는 일정만" : "과거 일정도 보기"}</button> <button class="btn btn-secondary" type="button" data-refresh-list>새로고침</button>${body}</section>`;
}
function createView(draft = {}, editing = false) {
  const now =
    draft.start_at ||
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  return `<div class="page-heading"><div><h1>${editing ? "일정 수정" : "일정 만들기"}</h1><p>입력 시간대: ${escapeHtml(getBrowserTimezone())}. 실제 발송 알림은 현재 지원하지 않습니다.</p></div></div><form class="card form-card" data-schedule-form novalidate><div class="form-grid"><label class="field"><span>제목</span><input class="input" name="title" maxlength="255" required placeholder="팀 회의" value="${escapeHtml(draft.title || "")}"></label><label class="field"><span>시작 시간</span><input class="input" name="start_at" type="datetime-local" required value="${escapeHtml(now)}"></label><label class="field"><span>종료 시간 (선택)</span><input class="input" name="end_at" type="datetime-local" value="${escapeHtml(draft.end_at || "")}"></label><label class="field"><span>장소</span><input class="input" name="location" maxlength="255" placeholder="온라인 또는 장소" value="${escapeHtml(draft.location || "")}"></label><label class="field"><span>상태</span><select class="select" name="status"><option value="confirmed" ${draft.status === "tentative" || draft.status === "cancelled" ? "" : "selected"}>확정</option><option value="tentative" ${draft.status === "tentative" ? "selected" : ""}>미정</option><option value="cancelled" ${draft.status === "cancelled" ? "selected" : ""}>취소</option></select></label><label class="field"><span>종일</span><input type="checkbox" name="all_day" ${draft.all_day ? "checked" : ""}></label>${editing ? "" : `<label class="field"><span>리마인더 (분 전, 선택)</span><input class="input" name="reminder_minutes" type="number" min="0" max="10080" value="${escapeHtml(draft.reminder_minutes || "")}" placeholder="없음"></label>`}<label class="field span-2"><span>설명</span><textarea class="textarea" name="description" maxlength="10000" placeholder="선택 사항">${escapeHtml(draft.description || "")}</textarea></label></div><div class="form-actions"><a class="btn btn-secondary" href="#schedules">취소</a><span class="spacer"></span><button type="submit" class="btn btn-primary">일정 저장</button></div></form>`;
}

function candidateView(candidate, index) {
  const item = candidate.data;
  const start = item.start_at && !Number.isNaN(Date.parse(item.start_at)) ? localDateTime(item.start_at) : "";
  const end = item.end_at && !Number.isNaN(Date.parse(item.end_at)) ? localDateTime(item.end_at) : "";
  return `<fieldset class="card form-card" data-candidate="${index}" ${candidate.saved ? "disabled" : ""}>
    <legend>후보 ${index + 1}${candidate.saved ? " · 저장됨" : candidate.data.needs_confirmation ? " · 확인 필요" : ""}</legend>
    <label class="field"><input type="checkbox" name="selected" ${candidate.selected ? "checked" : ""}> 이 후보 저장</label>
    ${Array.isArray(candidate.data.issues) && candidate.data.issues.length ? `<p>확인 항목: ${escapeHtml(candidate.data.issues.join(", "))}</p>` : ""}
    ${candidate.data.needs_confirmation ? `<label class="field"><input type="checkbox" name="confirmed" ${candidate.confirmed ? "checked" : ""}> 불명확한 내용을 확인하고 직접 확정했습니다</label>` : ""}
    ${candidate.error ? `<p class="alert error" role="alert">${escapeHtml(candidate.error)}</p>` : ""}
    <div class="form-grid">
      <label class="field"><span>제목</span><input class="input" name="title" maxlength="255" required value="${escapeHtml(item.title || "")}"></label>
      <label class="field"><span>시작 (브라우저 시간대)</span><input class="input" type="datetime-local" name="start_at" required value="${escapeHtml(start)}"></label>
      <label class="field"><span>종료 (선택)</span><input class="input" type="datetime-local" name="end_at" value="${escapeHtml(end)}"></label>
      <label class="field"><span>장소</span><input class="input" name="location" maxlength="255" value="${escapeHtml(item.location || "")}"></label>
      <label class="field span-2"><span>설명</span><textarea class="textarea" name="description" maxlength="10000">${escapeHtml(item.description || "")}</textarea></label>
      <label class="field"><input type="checkbox" name="all_day" ${item.all_day ? "checked" : ""}> 종일</label>
    </div>
  </fieldset>`;
}

function extractView(state) {
  const draft = state.extract;
  return `<div class="page-heading"><div><h1>AI 일정 추출</h1><p>원문은 외부 AI로 전달됩니다. 개인정보와 비밀은 입력하지 마세요.</p></div><a class="btn btn-secondary" href="#create">직접 일정 만들기</a></div>
    <form class="card form-card" data-extract-form>
      ${draft.error ? `<div class="alert error" role="alert">${escapeHtml(draft.error)}</div>` : ""}
      <div class="form-grid">
        <label class="field span-2"><span>일정 원문</span><textarea class="textarea" name="text" required>${escapeHtml(draft.text)}</textarea></label>
        <label class="field"><span>기준 일시 (브라우저 시간대 ${escapeHtml(getBrowserTimezone())})</span><input class="input" name="now" type="datetime-local" required value="${escapeHtml(draft.now)}"></label>
        <label class="field"><span>해석 시간대 (IANA)</span><input class="input" name="timezone" required value="${escapeHtml(draft.timezone)}"></label>
        <label class="field span-2"><span>개인 Gemini 키 (선택, 이 화면의 메모리에만 유지)</span><input class="input" name="api_key" type="password" autocomplete="off"></label>
      </div><div class="form-actions"><button type="submit" class="btn btn-primary" ${draft.busy || (draft.keyUnavailable && !draft.key) ? "disabled" : ""}>${draft.busy ? "추출 중…" : "후보 추출"}</button></div>
    </form>
    ${draft.candidates.length ? `<form data-candidates-form novalidate><p>후보를 확인·수정하고 저장할 것만 선택하세요. 추출만으로는 저장되지 않습니다.${draft.truncated ? " 일부만 추출됐습니다. 원문을 나눠 다시 추출하세요." : ""}</p>${draft.candidates.map(candidateView).join("")}<div class="form-actions"><button type="submit" class="btn btn-primary" ${draft.saving || draft.candidates.every((item) => item.saved) ? "disabled" : ""}>${draft.saving ? "저장 중…" : "선택한 후보 저장"}</button></div></form>` : draft.extracted ? "<p>추출된 일정 후보가 없습니다. 원문을 바꿔 다시 시도하거나 직접 일정을 만드세요.</p>" : ""}`;
}

function init() {
  const config = readConfig();
  const auth = new AuthClient({ config });
  const schedules = new ScheduleClient({ config, authClient: auth });
  const anonymous = document.querySelector("[data-auth-anonymous]");
  const application = document.querySelector("[data-authenticated]");
  const serviceStatus = document.querySelector("[data-service-status]");
  const view = document.querySelector("[data-view]");
  const toast = document.querySelector("[data-toast]");
  const state = { items: [], loading: false, error: "", showPast: false, page: 0, period: null, periodItems: [], periodLoading: false, periodError: "", draft: {}, editDraft: {}, editingId: null, editKey: null, editKeyAt: 0, editFingerprint: null, deleteKeys: new Map(), createKey: null, createKeyAt: 0, createFingerprint: null,
    extract: { text: "", now: localDateTime(new Date()), timezone: getBrowserTimezone(), key: "", keyUnavailable: false, candidates: [], error: "", busy: false, saving: false, extracted: false, truncated: false, generation: 0 } };
  const titles = {
    extract: ["AI", "일정 추출"],
    dashboard: ["WORKSPACE", "개요"],
    schedules: ["SCHEDULES", "모든 일정"],
    create: ["SCHEDULES", "일정 만들기"],
    edit: ["SCHEDULES", "일정 수정"],
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
  const registerForm = document.querySelector("[data-register-form]");
  const registerError = (name, message) => {
    const input = registerForm.elements.namedItem(name);
    const error = registerForm.querySelector(`[data-error-for="${name}"]`);
    input.setAttribute("aria-invalid", String(Boolean(message)));
    error.textContent = message;
  };
  const fieldError = (scope, name, message) => {
    const input = scope.querySelector(`[name="${name}"]`);
    if (!input) return;
    let error = input.parentElement.querySelector(`[data-field-error="${name}"]`);
    if (!error) {
      error = document.createElement("small");
      error.className = "field-error";
      error.dataset.fieldError = name;
      error.id = `field-error-${scope.dataset.candidate ?? "schedule"}-${name}`;
      error.setAttribute("aria-live", "polite");
      input.insertAdjacentElement("afterend", error);
      input.setAttribute("aria-describedby", error.id);
      input.addEventListener("input", () => fieldError(scope, name, ""));
    }
    error.textContent = message;
    input.setAttribute("aria-invalid", String(Boolean(message)));
  };
  const validateRegistration = () => {
    const fields = Object.fromEntries(new FormData(registerForm));
    fields.email = fields.email.trim().toLowerCase();
    fields.display_name = fields.display_name.trim();
    fields.timezone = fields.timezone.trim();
    registerForm.elements.namedItem("email").value = fields.email;
    const errors = {
      display_name: !fields.display_name ? "이름을 입력하세요." : Array.from(fields.display_name).length > 100 ? "이름은 100자 이하여야 합니다." : "",
      email: !fields.email ? "이메일을 입력하세요." : Array.from(fields.email).length > 320 ? "이메일은 320자 이하여야 합니다." : !/^[^\s@.]+(?:\.[^\s@.]+)*@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(fields.email) ? "올바른 이메일 형식을 입력하세요." : "",
      password: Array.from(fields.password).length < 12 || Array.from(fields.password).length > 128 ? "비밀번호는 12~128자여야 합니다." : "",
      password_confirmation: fields.password_confirmation !== fields.password ? "비밀번호가 일치하지 않습니다." : "",
      timezone: !fields.timezone ? "시간대를 입력하세요." : Array.from(fields.timezone).length > 64 ? "시간대는 64자 이하여야 합니다." : "",
    };
    if (!errors.timezone) {
      try { new Intl.DateTimeFormat("en", { timeZone: fields.timezone }); }
      catch { errors.timezone = "올바른 시간대를 입력하세요."; }
    }
    Object.entries(errors).forEach(([name, message]) => registerError(name, message));
    const firstInvalid = Object.entries(errors).find(([, message]) => message);
    if (firstInvalid) registerForm.elements.namedItem(firstInvalid[0]).focus();
    delete fields.password_confirmation;
    return firstInvalid ? null : fields;
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
  const refreshServiceStatus = async () => {
    let message = "일정 API 상태를 확인할 수 없습니다. 연결을 확인하고 다시 시도하세요.";
    try {
      const response = await fetch(`${config.scheduleBasePath.replace(/\/+$/, "")}/status`, { signal: AbortSignal.timeout(5000) });
      const status = await response.json();
      if (status.schedules === "available" && status.followup === "available" && response.ok) message = "";
      else if (status.schedules === "available" && status.followup === "delayed" && response.ok) message = "일정 기능은 사용 가능하지만 후속 처리 전달이 지연 중입니다. 알림 등 후속 결과를 기다려 주세요.";
      else if (status.schedules === "unavailable") message = "일정 기능을 현재 사용할 수 없습니다. 잠시 후 다시 시도하세요.";
    } catch { /* A failed status check must not appear healthy. */ }
    serviceStatus.textContent = message;
    serviceStatus.hidden = !message;
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
    if (route === "edit" && !state.editingId) {
      location.hash = "#schedules";
      return;
    }
    document
      .querySelectorAll("[data-route]")
      .forEach((link) =>
        link.classList.toggle("is-active", link.dataset.route === route),
      );
    document.querySelector("[data-page-kicker]").textContent = titles[route][0];
    document.querySelector("[data-page-title]").textContent = titles[route][1];
    view.innerHTML =
      route === "extract"
        ? extractView(state)
        : route === "schedules"
        ? schedulesView(state)
        : route === "create" || route === "edit"
          ? createView(route === "edit" ? state.editDraft : state.draft, route === "edit")
          : dashboardView(state);
    view
      .querySelector("[data-reload]")
      ?.addEventListener("click", loadSchedules);
    view.querySelector("[data-toggle-past]")?.addEventListener("click", () => { state.showPast = !state.showPast; state.page = 0; render(); });
    view.querySelector("[data-display-timezone]")?.addEventListener("change", (event) => { displayTimezone = event.target.value; render(); });
    view.querySelector("[data-refresh-list]")?.addEventListener("click", loadSchedules);
    view.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => { state.page += button.dataset.page === "next" ? 1 : -1; render(); }));
    view.querySelector("[data-period-form]")?.addEventListener("submit", selectPeriod);
    view.querySelector("[data-clear-period]")?.addEventListener("click", () => { state.period = null; state.periodItems = []; state.periodError = ""; state.page = 0; render(); });
    view.querySelectorAll("[data-detail-id]").forEach((button) => button.addEventListener("click", showDetail));
    view
      .querySelector("[data-schedule-form]")
      ?.addEventListener("submit", saveSchedule);
    view.querySelector("[data-extract-form]")?.addEventListener("submit", extractSchedules);
    view.querySelector("[data-extract-form] [name=api_key]")?.addEventListener("input", (event) => {
      state.extract.key = event.target.value;
      view.querySelector("[data-extract-form] button[type=submit]").disabled = state.extract.busy || (state.extract.keyUnavailable && !state.extract.key);
    });
    if (route === "extract") view.querySelector("[name=api_key]").value = state.extract.key;
    view.querySelector("[data-candidates-form]")?.addEventListener("submit", saveCandidates);
    state.extract.candidates.forEach((candidate, index) => {
      const fieldset = view.querySelector(`[data-candidate="${index}"]`);
      if (fieldset) Object.entries(candidate.fieldErrors || {}).forEach(([name, message]) => fieldError(fieldset, name, message));
    });
    view.querySelectorAll("[data-delete-id]").forEach((button) =>
      button.addEventListener("click", deleteSchedule),
    );
    view.querySelectorAll("[data-edit-id]").forEach((button) =>
      button.addEventListener("click", editSchedule),
    );
  };
  let extractController;
  const extractSchedules = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const draft = state.extract;
    const values = Object.fromEntries(new FormData(form));
    draft.text = values.text;
    draft.now = values.now;
    draft.timezone = values.timezone.trim();
    draft.error = "";
    form.querySelector(".alert")?.remove();
    for (const name of ["text", "now", "timezone"]) fieldError(form, name, "");
    if (!draft.text.trim() || [...draft.text].length > 10000 || new TextEncoder().encode(draft.text).length > 65536) {
      fieldError(form, "text", "원문은 공백만 입력할 수 없고 10,000자·64KiB 이하여야 합니다.");
      form.elements.text.focus();
      return;
    }
    if (!Number.isFinite(Date.parse(draft.now))) {
      fieldError(form, "now", "올바른 기준 일시를 입력하세요.");
      form.elements.now.focus();
      return;
    }
    try { new Intl.DateTimeFormat("en", { timeZone: draft.timezone }); }
    catch {
      fieldError(form, "timezone", "올바른 IANA 시간대를 입력하세요.");
      form.elements.timezone.focus();
      return;
    }
    extractController?.abort();
    extractController = new AbortController();
    const controller = extractController;
    const generation = ++draft.generation;
    const timeout = setTimeout(() => controller.abort(), 20000);
    draft.busy = true;
    draft.candidates = [];
    draft.extracted = false;
    draft.truncated = false;
    render();
    try {
      const payload = await schedules.extract({ text: draft.text, now: new Date(draft.now).toISOString(), timezone: draft.timezone, apiKey: draft.key, signal: controller.signal });
      if (!Array.isArray(payload?.candidates) || payload.candidates.length > 20) throw Object.assign(new Error("AI 응답의 후보 형식이 올바르지 않습니다. 원문을 나눠 다시 추출하세요."), { code: "invalid_ai_response" });
      if (generation !== draft.generation || currentRoute() !== "extract") return;
      draft.candidates = payload.candidates.map((data) => ({ data: data && typeof data === "object" && !Array.isArray(data) ? data : {}, selected: true, saved: false, error: candidateError(data), key: null, fingerprint: null }));
      draft.extracted = true;
      draft.truncated = payload.truncated === true;
      draft.keyUnavailable = false;
    } catch (error) {
      if (generation !== draft.generation || currentRoute() !== "extract") return;
      draft.error = error.code === "invalid_ai_response" ? error.message : controller.signal.aborted
        ? "AI 추출 시간이 초과되거나 요청이 취소되었습니다. 원문을 확인하고 다시 시도하세요."
        : error.status === 429
          ? "AI 사용량 제한에 도달했습니다. 잠시 후 다시 시도하세요."
          : error.code === "ai_key_unavailable"
            ? "AI 공용 키가 설정되지 않았습니다. 개인 키를 입력하거나 직접 일정을 만드세요."
          : error.code === "ai_upstream_unavailable"
            ? "외부 AI 서비스에 문제가 생겼습니다. 원문을 유지한 채 나중에 다시 시도하거나 직접 일정을 만드세요."
          : error.code === "ai_model_unavailable"
            ? "AI 모델을 현재 사용할 수 없습니다. 원문을 유지한 채 나중에 다시 시도하거나 직접 일정을 만드세요."
          : error.code === "ai_key_invalid"
            ? "개인 AI 키가 올바르지 않습니다. 키를 확인하거나 직접 일정을 만드세요."
          : error.status === 502
            ? "AI 추출 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하거나 직접 일정을 만드세요."
            : scheduleFailure(error, "AI 후보를 추출하지 못했습니다.");
      draft.error = withRequestId(error, draft.error);
      draft.keyUnavailable = error.code === "ai_key_unavailable";
    } finally {
      clearTimeout(timeout);
      if (generation === draft.generation) {
        draft.busy = false;
        render();
      }
    }
  };
  const saveCandidates = async (event) => {
    event.preventDefault();
    const draft = state.extract;
    const sessionVersion = auth.sessionVersion;
    const selected = [];
    for (const fieldset of event.currentTarget.querySelectorAll("[data-candidate]")) {
      const candidate = draft.candidates[Number(fieldset.dataset.candidate)];
      if (candidate.saved) continue;
      candidate.selected = fieldset.querySelector("[name=selected]").checked;
      if (!candidate.selected) continue;
      candidate.confirmed = fieldset.querySelector("[name=confirmed]")?.checked ?? false;
      if (candidate.data.needs_confirmation && !candidate.confirmed) {
        fieldset.querySelector("[name=confirmed]").focus();
        notify("확인 필요 항목을 검토하고 직접 확정하세요.", true);
        return;
      }
      const value = (name) => fieldset.querySelector(`[name=${name}]`).value;
      const raw = { title: value("title"), start_at: value("start_at"), end_at: value("end_at"), location: value("location"), description: value("description") };
      const errors = scheduleErrors(raw);
      candidate.fieldErrors = errors;
      Object.entries(errors).forEach(([name, message]) => fieldError(fieldset, name, message));
      const firstError = Object.entries(errors).find(([, message]) => message);
      if (firstError) {
        candidate.error = "후보 입력값을 확인하세요.";
        fieldset.querySelector(`[name="${firstError[0]}"]`).focus();
        return;
      }
      const schedule = {
        title: raw.title.trim(),
        start_at: new Date(raw.start_at).toISOString(),
        end_at: raw.end_at ? new Date(raw.end_at).toISOString() : null,
        location: raw.location || null,
        description: raw.description || null,
        all_day: fieldset.querySelector("[name=all_day]").checked,
        status: "confirmed",
        source: "ai",
      };
      candidate.data = { ...candidate.data, ...schedule };
      candidate.error = "";
      const fingerprint = JSON.stringify(schedule);
      if (candidate.fingerprint !== fingerprint) {
        candidate.fingerprint = fingerprint;
        candidate.key = crypto.randomUUID();
        candidate.keyAt = Date.now();
      }
      if (Date.now() - candidate.keyAt >= 86400000) {
        candidate.error = "이 작업의 재시도 가능 시간이 지났습니다. 목록을 확인한 뒤 원문을 다시 추출해 새 작업으로 진행하세요.";
        continue;
      }
      selected.push({ candidate, schedule });
    }
    if (!selected.length) {
      render();
      return;
    }
    draft.saving = true;
    render();
    for (const { candidate, schedule } of selected) {
      try {
        await schedules.create(schedule, candidate.key);
        if (auth.sessionVersion !== sessionVersion || application.hidden) return;
        candidate.saved = true;
        candidate.selected = false;
      } catch (error) {
        if (auth.sessionVersion !== sessionVersion || application.hidden) return;
        candidate.error = error.status ? scheduleFailure(error, "저장 실패.") : "저장 결과를 확인할 수 없습니다. 목록을 확인한 뒤 같은 작업으로 다시 시도하세요.";
      }
    }
    draft.saving = false;
    render();
    if (selected.some(({ candidate }) => candidate.saved)) await loadSchedules();
  };
  let detailDialog;
  const clearPrivateState = () => {
    detailDialog?.close();
    state.items = [];
    displayTimezone = getBrowserTimezone();
    state.period = null;
    state.periodItems = [];
    state.draft = {};
    state.createKey = null;
    state.createKeyAt = 0;
    state.createFingerprint = null;
    state.editDraft = {};
    state.editingId = null;
    state.editKey = null;
    state.editFingerprint = null;
    state.deleteKeys.clear();
    extractController?.abort();
    state.extract.generation++;
    state.extract.key = "";
    state.extract.candidates = [];
    state.extract.text = "";
    state.extract.error = "";
    state.error = "";
    view.replaceChildren();
  };
  const removeInaccessibleDetail = (id) => {
    detailDialog?.close();
    state.items = state.items.filter((item) => item.id !== id);
    state.periodItems = state.periodItems.filter((item) => item.id !== id);
    location.hash = "#schedules";
    render();
    notify("일정이 삭제되었거나 접근 권한이 사라졌습니다. 목록에서 제거했습니다.", true);
  };
  const showDetail = async (event) => {
    const id = event.currentTarget.dataset.detailId;
    const trigger = event.currentTarget;
    const sessionVersion = auth.sessionVersion;
    trigger.disabled = true;
    trigger.textContent = "조회 중…";
    let item;
    try {
      item = await schedules.get(id);
    } catch (error) {
      if (auth.sessionVersion !== sessionVersion || application.hidden) return;
      if (error.status === 403 || error.status === 404) removeInaccessibleDetail(id);
      else notify(scheduleFailure(error, "상세를 불러오지 못했습니다."), true);
      if (error.status !== 403 && error.status !== 404) { trigger.disabled = false; trigger.textContent = "상세"; }
      return;
    }
    if (auth.sessionVersion !== sessionVersion || application.hidden) return;
    trigger.disabled = false;
    trigger.textContent = "상세";
    detailDialog?.close();
    const dialog = document.createElement("dialog");
    detailDialog = dialog;
    dialog.className = "card form-card";
    const draw = () => {
      dialog.innerHTML = `<h2>${escapeHtml(item.title)}</h2><p>표시 시간대: ${escapeHtml(displayTimezone)}<br>시작: ${escapeHtml(new Date(item.start_at).toLocaleString("ko-KR", { timeZone: displayTimezone }))}<br>종료: ${item.end_at ? escapeHtml(new Date(item.end_at).toLocaleString("ko-KR", { timeZone: displayTimezone })) : "없음"}<br>장소: ${escapeHtml(item.location || "없음")}<br>상태: ${escapeHtml(item.status)} · ${item.source === "ai" ? "AI 후보에서 확정" : "직접 입력"}</p><p>${escapeHtml(item.description || "설명 없음")}</p><h3>리마인더</h3><p>실제 발송은 비활성입니다. 저장된 예약만 표시합니다.</p><ul>${(item.reminders || []).map((reminder) => `<li>${reminder.minutes_before}분 전 · ${escapeHtml(reminder.channel)} <button type="button" class="btn btn-secondary" data-remove-reminder="${escapeHtml(reminder.id)}">제거</button></li>`).join("") || "<li>없음</li>"}</ul><form data-add-reminder><label class="field"><span>몇 분 전</span><input class="input" name="minutes_before" type="number" min="0" max="10080" value="10" required></label><label class="field"><span>채널</span><select class="select" name="channel"><option value="none">발송 비활성</option><option value="push">푸시 (발송 비활성)</option><option value="email">이메일 (발송 비활성)</option></select></label><button class="btn btn-secondary" type="submit">리마인더 추가</button></form><button class="btn btn-secondary" type="button" data-close-detail>닫기</button>`;
      dialog.querySelector("[data-close-detail]").addEventListener("click", () => dialog.close());
      dialog.querySelector("[data-add-reminder]").addEventListener("submit", async (submit) => {
        submit.preventDefault();
        const button = submit.currentTarget.querySelector("button[type=submit]");
        button.disabled = true;
        button.textContent = "추가 중…";
        try {
          const minutes_before = Number(submit.currentTarget.elements.minutes_before.value);
          await schedules.addReminder(id, { minutes_before, channel: submit.currentTarget.elements.channel.value });
          if (auth.sessionVersion !== sessionVersion || !dialog.isConnected) return;
          item = await schedules.get(id);
          if (auth.sessionVersion !== sessionVersion || !dialog.isConnected) return;
          draw();
        } catch (error) {
          if (auth.sessionVersion !== sessionVersion || !dialog.isConnected) return;
          if (error.status === 403 || error.status === 404) return removeInaccessibleDetail(id);
          button.disabled = false;
          button.textContent = "리마인더 추가";
          notify(withRequestId(error, "리마인더 결과를 확인할 수 없습니다. 상세를 다시 열어 확인하세요."), true);
        }
      });
      dialog.querySelectorAll("[data-remove-reminder]").forEach((button) => button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "제거 중…";
        try {
          await schedules.deleteReminder(id, button.dataset.removeReminder);
          if (auth.sessionVersion !== sessionVersion || !dialog.isConnected) return;
          item = await schedules.get(id);
          if (auth.sessionVersion !== sessionVersion || !dialog.isConnected) return;
          draw();
        } catch (error) {
          if (auth.sessionVersion !== sessionVersion || !dialog.isConnected) return;
          if (error.status === 403 || error.status === 404) return removeInaccessibleDetail(id);
          button.disabled = false;
          button.textContent = "제거";
          notify(withRequestId(error, "리마인더 제거 결과를 확인할 수 없습니다. 상세를 다시 열어 확인하세요."), true);
        }
      }));
    };
    draw();
    document.body.append(dialog);
    dialog.addEventListener("close", () => { dialog.remove(); if (detailDialog === dialog) detailDialog = null; if (!application.hidden && trigger.isConnected) trigger.focus(); });
    dialog.showModal();
  };
  const loadPeriod = async () => {
    const period = state.period;
    if (!period) return;
    const sessionVersion = auth.sessionVersion;
    state.periodLoading = true;
    state.periodError = "";
    render();
    try {
      const end = new Date(`${period.to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      const items = await schedules.list({ from: new Date(`${period.from}T00:00:00`).toISOString(), to: end.toISOString() });
      if (auth.sessionVersion !== sessionVersion || state.period !== period || application.hidden) return;
      state.periodItems = items;
    } catch (error) {
      if (auth.sessionVersion !== sessionVersion || state.period !== period || application.hidden) return;
      state.periodError = scheduleFailure(error, "선택 기간의 일정을 불러오지 못했습니다.");
    } finally {
      if (auth.sessionVersion !== sessionVersion || state.period !== period || application.hidden) return;
      state.periodLoading = false;
      render();
    }
  };
  const selectPeriod = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const from = form.elements.from.value;
    const to = form.elements.to.value;
    const days = (new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000;
    if (!from || !to || !Number.isFinite(days) || days < 0 || days >= 366) {
      const input = !from ? form.elements.from : form.elements.to;
      input.setCustomValidity("시작·종료 날짜를 366일 이내로 선택하세요.");
      input.reportValidity();
      input.focus();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    state.period = { from, to };
    state.periodItems = [];
    state.page = 0;
    loadPeriod();
  };
  const loadSchedules = async () => {
    const sessionVersion = auth.sessionVersion;
    state.loading = true;
    state.error = "";
    render();
    try {
      const items = await schedules.list();
      if (auth.sessionVersion !== sessionVersion || application.hidden) return;
      state.items = items;
    } catch (error) {
      if (auth.sessionVersion !== sessionVersion || application.hidden) return;
      state.items = [];
      state.error = scheduleFailure(error, "일정을 불러오지 못했습니다.");
    } finally {
      if (auth.sessionVersion !== sessionVersion || application.hidden) return;
      state.loading = false;
      render();
      if (state.period) await loadPeriod();
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
  const editSchedule = (event) => {
    const item = state.items.find((schedule) => schedule.id === event.currentTarget.dataset.editId);
    if (!item) return;
    if (state.editingId !== item.id) { state.editKey = null; state.editFingerprint = null; }
    state.editingId = item.id;
    state.editDraft = { ...item, start_at: localDateTime(item.start_at), end_at: item.end_at ? localDateTime(item.end_at) : "" };
    location.hash = "#edit";
    render();
  };
  const saveSchedule = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const sessionVersion = auth.sessionVersion;
    if (form.querySelector("button[type=submit]").disabled) return;
    const values = Object.fromEntries(new FormData(form));
    const editing = currentRoute() === "edit";
    if (editing) state.editDraft = values;
    else state.draft = values;
    form.querySelector(".alert")?.remove();
    const errors = scheduleErrors(values);
    Object.entries(errors).forEach(([name, message]) => fieldError(form, name, message));
    const invalid = Object.entries(errors).find(([, message]) => message);
    if (invalid) {
      form.querySelector(`[name="${invalid[0]}"]`).focus();
      return;
    }
    setBusy(form, true, "저장 중…");
    try {
      const changes = {
        title: values.title,
        start_at: new Date(values.start_at).toISOString(),
        end_at: values.end_at ? new Date(values.end_at).toISOString() : null,
        all_day: form.elements.namedItem("all_day").checked,
        location: values.location || null,
        description: values.description || null,
        status: values.status,
      };
      if (editing) {
        const original = state.items.find((item) => item.id === state.editingId);
        if (original && Boolean(original.all_day) === changes.all_day) delete changes.all_day;
        if (original && (original.end_at || null) === changes.end_at) delete changes.end_at;
        const fingerprint = JSON.stringify(changes);
        if (state.editFingerprint !== fingerprint) {
          state.editFingerprint = fingerprint;
          state.editKey = crypto.randomUUID();
          state.editKeyAt = Date.now();
        }
        if (Date.now() - state.editKeyAt >= 86400000) {
          const expired = new Error("중복 방지 시간이 지났습니다. 목록에서 현재 일정을 확인한 뒤 새 수정 작업을 시작하세요.");
          expired.code = "expired_key";
          throw expired;
        }
        await schedules.update(state.editingId, changes, state.editKey);
        if (auth.sessionVersion !== sessionVersion || application.hidden) return;
        await schedules.get(state.editingId);
        if (auth.sessionVersion !== sessionVersion || application.hidden) return;
        state.editDraft = {};
        state.editingId = null;
        state.editKey = null;
        state.editFingerprint = null;
      } else {
        const schedule = { ...changes, source: "manual", ...(values.reminder_minutes ? { reminders: [{ minutes_before: Number(values.reminder_minutes), channel: "none" }] } : {}) };
        const fingerprint = JSON.stringify(schedule);
        if (state.createFingerprint !== fingerprint) {
          state.createFingerprint = fingerprint;
          state.createKey = crypto.randomUUID();
          state.createKeyAt = Date.now();
        }
        if (Date.now() - state.createKeyAt >= 86400000) {
          const expired = new Error("중복 방지 시간이 지났습니다. 목록을 확인하고 새 일정으로 다시 입력하세요.");
          expired.code = "expired_key";
          throw expired;
        }
        const created = await schedules.create(schedule, state.createKey);
        if (auth.sessionVersion !== sessionVersion || application.hidden) return;
        await schedules.get(created.id);
        if (auth.sessionVersion !== sessionVersion || application.hidden) return;
        state.draft = {};
        state.createKey = null;
        state.createKeyAt = 0;
        state.createFingerprint = null;
      }
      notify("일정이 저장되었습니다.");
      location.hash = "#schedules";
      await loadSchedules();
    } catch (error) {
      if (auth.sessionVersion !== sessionVersion || application.hidden) return;
      setBusy(form, false);
      const alert = document.createElement("div");
      alert.className = "alert error";
      alert.setAttribute("role", "alert");
      alert.textContent = withRequestId(error, error.code === "expired_key" ? error.message : error.status === 409 ? "일정을 저장하지 못했습니다. 저장 내용이 충돌했습니다. 최신 목록을 확인하세요." : error.status ? scheduleFailure(error, "일정을 저장하지 못했습니다.") : `${error.name === "TimeoutError" ? "요청 시간이 초과됐습니다." : "응답을 받지 못했습니다."} 저장 여부를 확인할 수 없습니다. 목록을 확인하거나 같은 작업 결과를 다시 확인하세요.`);
      if (!error.status && error.code !== "expired_key") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn btn-secondary";
        retry.textContent = "같은 작업 결과 확인";
        retry.addEventListener("click", () => form.requestSubmit());
        alert.append(" ", retry);
      }
      form.prepend(alert);
    }
  };
  const deleteSchedule = async (event) => {
    const button = event.currentTarget;
    const sessionVersion = auth.sessionVersion;
    const item = state.items.find((schedule) => schedule.id === button.dataset.deleteId);
    if (!item || !confirm(`'${item.title}' 일정을 삭제할까요? 삭제하면 복구할 수 없습니다.`)) return;
    let operation = state.deleteKeys.get(item.id);
    if (!operation) {
      operation = { key: crypto.randomUUID(), at: Date.now() };
      state.deleteKeys.set(item.id, operation);
    }
    if (Date.now() - operation.at >= 86400000) {
      notify("삭제 결과를 목록에서 확인하세요. 중복 방지 시간이 지나 자동 재시도하지 않습니다.", true);
      return;
    }
    button.disabled = true;
    button.textContent = "삭제 중…";
    try {
      await schedules.delete(item.id, operation.key);
      if (auth.sessionVersion !== sessionVersion || application.hidden) return;
      state.deleteKeys.delete(item.id);
      state.items = state.items.filter((schedule) => schedule.id !== item.id);
      state.periodItems = state.periodItems.filter((schedule) => schedule.id !== item.id);
      render();
      notify("일정이 삭제되었습니다.");
    } catch (error) {
      if (auth.sessionVersion !== sessionVersion || application.hidden) return;
      button.disabled = false;
      button.textContent = "삭제";
      notify(error.status ? scheduleFailure(error, "일정을 삭제하지 못했습니다.") : "삭제 결과를 확인할 수 없습니다. 목록을 새로고침한 뒤 같은 삭제 작업으로 다시 시도하세요.", true);
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
      if (form.querySelector("button[type=submit]").disabled) return;
      setBusy(form, true, "로그인 중…");
      try {
        await auth.login(Object.fromEntries(new FormData(form)));
        setBusy(form, false);
        clearPrivateState();
        await openApp();
        notify("로그인되었습니다.");
      } catch (error) {
        setBusy(form, false);
        feedback(error.message, "error");
      }
    });
  registerForm.addEventListener("input", (event) => {
    if (event.target.name) registerError(event.target.name, "");
  });
  registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (registerForm.querySelector("button[type=submit]").disabled) return;
      const fields = validateRegistration();
      if (!fields) return;
      setBusy(registerForm, true, "계정 만드는 중…");
      try {
        await auth.register(fields);
      } catch (error) {
        setBusy(registerForm, false);
        const invalidField = error.status === 400 && ({
          "Invalid email": "email",
          "Password must be 12 to 128 characters": "password",
          "Display name must be 1 to 100 characters": "display_name",
          "Invalid timezone": "timezone",
        }[error.serverMessage] || /body\/(email|password|display_name|timezone)\b/.exec(error.serverMessage)?.[1]);
        if (invalidField) {
          registerError(invalidField, withRequestId(error, "입력값을 확인하세요."));
          registerForm.elements.namedItem(invalidField).focus();
          return;
        }
        feedback(withRequestId(error, error.status === 409 || !error.status
          ? "가입 여부를 확인할 수 없습니다. 이미 가입했다면 로그인 화면에서 다시 시도하세요."
          : error.message), "error");
        return;
      }
      try {
        await auth.login({ email: fields.email, password: fields.password });
      } catch (error) {
        setBusy(registerForm, false);
        setMode("login");
        document.querySelector("[data-login-form] [name=email]").value = fields.email;
        feedback(withRequestId(error, "계정은 생성됐습니다. 로그인에 실패했으니 로그인 화면에서 다시 시도하세요."), "error");
        return;
      }
      setBusy(registerForm, false);
      clearPrivateState();
      await openApp();
      notify("계정을 만들고 로그인했습니다.");
    });
  document
    .querySelector("[data-logout]")
    .addEventListener("click", async () => {
      const pending = auth.logout();
      clearPrivateState();
      closeMenu();
      anonymous.hidden = false;
      application.hidden = true;
      document.querySelectorAll(".auth-form").forEach((form) => {
        form.reset();
        setBusy(form, false);
      });
      registerForm.querySelectorAll("[data-error-for]").forEach((error) => registerError(error.dataset.errorFor, ""));
      document.querySelector("[data-timezone]").value = getBrowserTimezone();
      setMode("login");
      try {
        await pending;
        notify("로그아웃되었습니다.");
      } catch {
        notify("이 탭의 로그인 정보는 삭제했습니다. 서버 로그아웃 결과를 확인할 수 없습니다.", true);
      }
    });
  window.addEventListener("hashchange", () => {
    if (currentRoute() !== "extract") {
      extractController?.abort();
      state.extract.generation++;
      state.extract.busy = false;
      state.extract.key = "";
    }
    render();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  getServiceHealth().then((payload) =>
    document.querySelectorAll("[data-status]").forEach((element) => {
      element.classList.toggle("ready", statusText(payload) === "ready");
      element.title = statusText(payload);
    }),
  );
  refreshServiceStatus();
  setInterval(refreshServiceStatus, 30000);
  if (auth.hasSession()) openApp(true);
  else setMode("login");
}

if (typeof document !== "undefined") init();
