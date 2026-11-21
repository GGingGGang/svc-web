// runtime-config.js is fetched even when the mail link opens a cached HTML document.
if (/^\/account\/(action|resend-verification)\/?$/.test(location.pathname)
    && document.documentElement.dataset.webVersion !== window.appConfig.version) {
  const fresh = new URL(location.href);
  if (fresh.searchParams.get("v") !== window.appConfig.version) {
    fresh.searchParams.set("v", window.appConfig.version);
    // Only the new document should submit the one-time token.
    history.replaceState(null, "", location.pathname + location.search);
    location.replace(fresh.href);
  }
}
