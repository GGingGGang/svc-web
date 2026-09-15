const defaultConfig = {
  serviceName: "web",
  version: "dev"
};

export function readConfig(source = globalThis.window?.appConfig) {
  return { ...defaultConfig, ...(source ?? {}) };
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

export function init() {
  const config = readConfig();
  const statusEl = document.querySelector("[data-status]");
  const versionEl = document.querySelector("[data-version]");
  const outputEl = document.querySelector("[data-output]");
  const refreshButton = document.querySelector("[data-refresh]");

  versionEl.textContent = config.version;
  refreshButton.addEventListener("click", () => refreshHealth(statusEl, outputEl));
  refreshHealth(statusEl, outputEl);
}

if (typeof document !== "undefined") {
  init();
}
