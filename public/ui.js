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
function localDateTime(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
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
        `<tr><td><strong>${escapeHtml(item.title)}</strong></td><td>${scheduleDate(item)} ${scheduleTime(item)}</td><td>${escapeHtml(item.location || "-")}</td><td><span class="badge">${escapeHtml(item.status || "confirmed")}</span></td><td><button class="btn btn-secondary" type="button" data-edit-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 수정">수정</button> <button class="btn btn-secondary" type="button" data-delete-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 삭제">삭제</button></td></tr>`,
    )
    .join("");
  const body = state.loading
    ? loadingMarkup()
    : state.error
      ? errorMarkup(state.error)
      : state.items.length
        ? `<div class="table-wrap"><table class="schedule-table"><thead><tr><th>제목</th><th>일시</th><th>장소</th><th>상태</th><th>작업</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : emptyMarkup();
  return `<div class="page-heading"><div><h1>모든 일정</h1><p>Core API에서 관리되는 내 일정입니다.</p></div><a class="btn btn-primary" href="#create">${icon("M12 5v14M5 12h14")}일정 만들기</a></div><section class="card">${body}</section>`;
}
function createView(draft = {}, editing = false) {
  const now =
    draft.start_at ||
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  return `<div class="page-heading"><div><h1>${editing ? "일정 수정" : "일정 만들기"}</h1><p>저장하면 Core API에 바로 반영됩니다.</p></div></div><form class="card form-card" data-schedule-form><div class="form-grid"><label class="field"><span>제목</span><input class="input" name="title" maxlength="255" required placeholder="팀 회의" value="${escapeHtml(draft.title || "")}"></label><label class="field"><span>시작 시간</span><input class="input" name="start_at" type="datetime-local" required value="${escapeHtml(now)}"></label><label class="field"><span>장소</span><input class="input" name="location" maxlength="255" placeholder="온라인 또는 장소" value="${escapeHtml(draft.location || "")}"></label><label class="field"><span>상태</span><select class="select" name="status"><option value="confirmed" ${draft.status === "tentative" || draft.status === "cancelled" ? "" : "selected"}>확정</option><option value="tentative" ${draft.status === "tentative" ? "selected" : ""}>미정</option><option value="cancelled" ${draft.status === "cancelled" ? "selected" : ""}>취소</option></select></label><label class="field span-2"><span>설명</span><textarea class="textarea" name="description" placeholder="선택 사항">${escapeHtml(draft.description || "")}</textarea></label></div><div class="form-actions"><a class="btn btn-secondary" href="#schedules">취소</a><span class="spacer"></span><button type="submit" class="btn btn-primary">일정 저장</button></div></form>`;
}

function candidateView(candidate, index) {
  const item = candidate.data;
  const start = item.start_at && !Number.isNaN(Date.parse(item.start_at)) ? localDateTime(item.start_at) : "";
  const end = item.end_at && !Number.isNaN(Date.parse(item.end_at)) ? localDateTime(item.end_at) : "";
  return `<fieldset class="card form-card" data-candidate="${index}" ${candidate.saved ? "disabled" : ""}>
    <legend>후보 ${index + 1}${candidate.saved ? " · 저장됨" : candidate.data.needs_confirmation ? " · 확인 필요" : ""}</legend>
    <label class="field"><input type="checkbox" name="selected" ${candidate.selected ? "checked" : ""}> 이 후보 저장</label>
    ${candidate.data.issues?.length ? `<p>확인 항목: ${escapeHtml(candidate.data.issues.join(", "))}</p>` : ""}
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
        <label class="field"><span>기준 일시</span><input class="input" name="now" type="datetime-local" required value="${escapeHtml(draft.now)}"></label>
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
  const view = document.querySelector("[data-view]");
  const toast = document.querySelector("[data-toast]");
  const state = { items: [], loading: false, error: "", draft: {}, editDraft: {}, editingId: null, createKey: null, createFingerprint: null,
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
    const draft = state.extract;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    draft.text = values.text;
    draft.now = values.now;
    draft.timezone = values.timezone.trim();
    draft.error = "";
    if (!draft.text.trim() || [...draft.text].length > 10000 || new TextEncoder().encode(draft.text).length > 65536) {
      draft.error = "원문은 공백만 입력할 수 없고 10,000자·64KiB 이하여야 합니다.";
      render();
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
      if (!Array.isArray(payload?.candidates) || payload.candidates.length > 20) throw new Error("AI 응답의 후보 형식이 올바르지 않습니다.");
      if (generation !== draft.generation || currentRoute() !== "extract") return;
      draft.candidates = payload.candidates.map((data) => ({ data: data && typeof data === "object" ? data : {}, selected: true, saved: false, error: "", key: null, fingerprint: null }));
      draft.extracted = true;
      draft.truncated = payload.truncated === true;
      draft.keyUnavailable = false;
    } catch (error) {
      if (generation !== draft.generation || currentRoute() !== "extract") return;
      draft.error = controller.signal.aborted
        ? "AI 추출 시간이 초과되거나 요청이 취소되었습니다. 원문을 확인하고 다시 시도하세요."
        : error.status === 429
          ? "AI 사용량 제한에 도달했습니다. 잠시 후 다시 시도하세요."
          : error.code === "ai_key_unavailable"
            ? "AI 공용 키가 설정되지 않았습니다. 개인 키를 입력하거나 직접 일정을 만드세요."
          : error.status === 502
            ? "AI 서비스 또는 키를 사용할 수 없습니다. 키를 확인하거나 직접 일정을 만드세요."
            : `AI 후보를 추출하지 못했습니다. ${error.message}`;
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
      for (const name of ["title", "start_at"]) {
        if (!fieldset.querySelector(`[name=${name}]`).reportValidity()) return;
      }
      const value = (name) => fieldset.querySelector(`[name=${name}]`).value;
      const schedule = {
        title: value("title").trim(),
        start_at: new Date(value("start_at")).toISOString(),
        end_at: value("end_at") ? new Date(value("end_at")).toISOString() : null,
        location: value("location") || null,
        description: value("description") || null,
        all_day: fieldset.querySelector("[name=all_day]").checked,
        status: "confirmed",
        source: "ai",
      };
      candidate.data = { ...candidate.data, ...schedule };
      candidate.error = "";
      if (!schedule.title || (schedule.end_at && schedule.end_at <= schedule.start_at)) {
        candidate.error = !schedule.title ? "제목을 입력하세요." : "종료는 시작보다 늦어야 합니다.";
        continue;
      }
      const fingerprint = JSON.stringify(schedule);
      if (candidate.fingerprint !== fingerprint) {
        candidate.fingerprint = fingerprint;
        candidate.key = crypto.randomUUID();
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
        candidate.saved = true;
        candidate.selected = false;
      } catch (error) {
        candidate.error = `저장 실패 (HTTP ${error.status ?? "연결 오류"}). 수정하거나 다시 시도하세요.`;
      }
    }
    draft.saving = false;
    render();
    if (selected.some(({ candidate }) => candidate.saved)) await loadSchedules();
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
  const editSchedule = (event) => {
    const item = state.items.find((schedule) => schedule.id === event.currentTarget.dataset.editId);
    if (!item) return;
    state.editingId = item.id;
    state.editDraft = { ...item, start_at: localDateTime(item.start_at) };
    location.hash = "#edit";
    render();
  };
  const saveSchedule = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const editing = currentRoute() === "edit";
    if (editing) state.editDraft = values;
    else state.draft = values;
    form.querySelector(".alert")?.remove();
    setBusy(form, true, "저장 중…");
    try {
      const changes = {
        title: values.title,
        start_at: new Date(values.start_at).toISOString(),
        location: values.location || null,
        description: values.description || null,
        status: values.status,
      };
      if (editing) {
        await schedules.update(state.editingId, changes);
        state.editDraft = {};
        state.editingId = null;
      } else {
        const schedule = { ...changes, all_day: false, source: "manual" };
        const fingerprint = JSON.stringify(schedule);
        if (state.createFingerprint !== fingerprint) {
          state.createFingerprint = fingerprint;
          state.createKey = crypto.randomUUID();
        }
        await schedules.create(schedule, state.createKey);
        state.draft = {};
        state.createKey = null;
        state.createFingerprint = null;
      }
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
  const deleteSchedule = async (event) => {
    const button = event.currentTarget;
    const item = state.items.find((schedule) => schedule.id === button.dataset.deleteId);
    if (!item || !confirm(`'${item.title}' 일정을 삭제할까요? 삭제하면 복구할 수 없습니다.`)) return;
    button.disabled = true;
    button.textContent = "삭제 중…";
    try {
      await schedules.delete(item.id);
      state.items = state.items.filter((schedule) => schedule.id !== item.id);
      render();
      notify("일정이 삭제되었습니다.");
    } catch (error) {
      button.disabled = false;
      button.textContent = "삭제";
      notify(`일정을 삭제하지 못했습니다. 다시 시도하세요. (${error.message})`, true);
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
      state.createKey = null;
      state.createFingerprint = null;
      state.editDraft = {};
      state.editingId = null;
      extractController?.abort();
      state.extract.generation++;
      state.extract.key = "";
      state.extract.candidates = [];
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
  if (auth.hasSession()) openApp(true);
  else setMode("login");
}

if (typeof document !== "undefined") init();
