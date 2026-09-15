# javascript-app

정적 웹 프런트엔드를 시작하기 위한 순수 JavaScript 템플릿입니다. 비특권 nginx가 8080 포트에서 기본 화면과 자체 `/healthz`, `/readyz`를 제공합니다. 화면은 자신의 `/readyz`만 확인합니다. 업무 기능과 다른 서비스 연동은 생성된 서비스에서 추가합니다.

## 구성

- `public/` - HTML, CSS, 브라우저 JavaScript 시작 화면.
- `scripts/` - 의존성 없는 Node 22 빌드, 개발 서버, 테스트.
- `Dockerfile` - Node 테스트/빌드 단계와 nginx 비특권 런타임.
- `nginx.conf` - 자체 `/healthz`, `/readyz`와 정적 파일·SPA fallback.
- `k8s-gitops/` - Deployment, Service, HTTPRoute, Kustomization, ArgoCD Application 조각.

## 1. 서비스 생성

아래 명령은 원본 `app-templates/javascript-app`에서 실행합니다. 생성된 서비스 저장소에서는 다음의 로컬 확인 절차부터 사용합니다.

```bash
bash sed-template.sh <ORG> web [OUTDIR] [HOSTNAME]
```

예시 — `app-templates` 저장소 루트에서 시작합니다:

```bash
cd javascript-app
bash sed-template.sh GGingGGang web ./_generated web.ggang.cloud
```

스크립트는 `svc-<SVC>` 빌드 저장소와 `gitops-<SVC>` 조각을 생성합니다. 이미 존재하는 출력 경로는 덮어쓰지 않습니다. `HOSTNAME`을 생략하면 `web.example.com`을 사용하며 대문자는 소문자로 정규화합니다. 실제 배포에서는 Gateway 인증서가 지원하는 호스트를 지정해야 합니다.

생성 결과는 `javascript-app/_generated/svc-web/`과 `javascript-app/_generated/gitops-web/`입니다. 이 문서의 이후 명령은 **생성된 `svc-web` 폴더에서** 실행합니다.

```bash
# 위 생성 명령에 이어서 실행
cd _generated/svc-web
```

## 2. 로컬 실행 · 테스트

```bash
npm ci
npm test
npm run build
npm run dev
```

`npm run dev`는 기본 `127.0.0.1:5173`에서 개발 서버를 띄웁니다. 포트는 `HTTP_PORT`, 바인드 주소는 `HTTP_HOST`로 바꿀 수 있습니다.

개발 서버도 정적 파일과 자체 상태 엔드포인트를 제공하므로 단독으로 실행할 수 있습니다.

## 3. 환경변수 · 배포 설정

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `APP_VERSION` | Docker `GIT_SHA` | `/runtime-config.js`에 기록할 버전 |

nginx는 고정 설정 파일을 사용하며, 브라우저의 버전 정보는 컨테이너 시작 시 `/tmp` 아래에 기록됩니다. Kubernetes 매니페스트는 `readOnlyRootFilesystem: true`, 비특권 UID/GID 101, `/tmp` `emptyDir` 마운트를 사용합니다.

이 정적 웹 템플릿에는 Prometheus exporter가 없어 `/metrics`와 ServiceMonitor는 포함하지 않습니다.

## 4. Docker 확인

생성된 웹 서비스 폴더에서 정적 페이지·자체 상태 확인·읽기 전용 파일시스템 설정을 확인합니다.

```bash
docker build -t svc-web:local .
docker run -d --rm --name web-smoke --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -p 127.0.0.1:8080:8080 svc-web:local
curl http://127.0.0.1:8080/
curl http://127.0.0.1:8080/runtime-config.js
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
docker stop web-smoke
```

## 5. CI 등록 · 온보딩

첫 push 전에 `jenkins-shared-library/resources/ci/services.yaml`의 기존 `services` 항목에 추가합니다:

```yaml
  web:
    language: node
```

다른 이름으로 생성했다면 `web`을 해당 이름으로 바꿉니다. 테스트 게이트는 `npm ci && npm test`입니다.

GitOps 조각 이동, 네임스페이스·AppProject 등록, 이미지 pull Secret과 Jenkins 연결은 `app-templates/README.md`의 공통 온보딩 절차를 따릅니다.
