#!/usr/bin/env sh
set -eu

APP_VERSION="${APP_VERSION:-dev}"

case "$APP_VERSION" in
  *[!A-Za-z0-9._-]*) echo "APP_VERSION may contain only letters, numbers, dot, underscore, and hyphen" >&2; exit 1 ;;
esac

mkdir -p /tmp/html /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp
cp -R /usr/share/nginx/html/. /tmp/html/

cat > /tmp/html/runtime-config.js <<EOF
window.appConfig = {
  serviceName: "web",
  version: "$APP_VERSION"
};
EOF

exec nginx -c /etc/nginx/nginx.conf -g 'daemon off;'
