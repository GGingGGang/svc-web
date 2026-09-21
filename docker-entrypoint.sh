#!/usr/bin/env sh
set -eu

APP_VERSION="${APP_VERSION:-dev}"
AUTH_BASE_PATH="${AUTH_BASE_PATH:-https://api.ggang.cloud/v1/auth}"
SCHEDULE_BASE_PATH="${SCHEDULE_BASE_PATH:-https://api.ggang.cloud/v1/core}"

case "$APP_VERSION" in
  *[!A-Za-z0-9._-]*) echo "APP_VERSION may contain only letters, numbers, dot, underscore, and hyphen" >&2; exit 1 ;;
esac

case "$AUTH_BASE_PATH" in
  https://*|/*) ;;
  *) echo "AUTH_BASE_PATH must be an HTTPS URL or path" >&2; exit 1 ;;
esac

case "$AUTH_BASE_PATH" in
  *[!A-Za-z0-9._/-]*) echo "AUTH_BASE_PATH contains unsupported characters" >&2; exit 1 ;;
esac

case "$SCHEDULE_BASE_PATH" in
  https://*|/*) ;;
  *) echo "SCHEDULE_BASE_PATH must be an HTTPS URL or path" >&2; exit 1 ;;
esac

case "$SCHEDULE_BASE_PATH" in
  *[!A-Za-z0-9._/-]*) echo "SCHEDULE_BASE_PATH contains unsupported characters" >&2; exit 1 ;;
esac

mkdir -p /tmp/html /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp
cp -R /usr/share/nginx/html/. /tmp/html/

cat > /tmp/html/runtime-config.js <<EOF
window.appConfig = {
  serviceName: "web",
  version: "$APP_VERSION",
  authBasePath: "$AUTH_BASE_PATH",
  scheduleBasePath: "$SCHEDULE_BASE_PATH"
};
EOF

exec nginx -c /etc/nginx/nginx.conf -g 'daemon off;'
