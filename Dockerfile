FROM docker.io/library/node:22-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY public ./public
COPY scripts ./scripts
COPY nginx.conf docker-entrypoint.sh ./
RUN npm test && npm run build

FROM docker.io/nginxinc/nginx-unprivileged:alpine
ARG GIT_SHA=unknown
ENV APP_VERSION=${GIT_SHA}
USER root
COPY nginx.conf /etc/nginx/nginx.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY --from=builder /src/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
