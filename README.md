# svc-web

Planned 일정 관리 웹입니다. 순수 JavaScript 정적 화면을 비특권 nginx로 제공하며, 브라우저가 API Gateway를 통해 auth/core 서비스를 호출합니다.

## 제공하는 화면

- 로그인·회원가입·로그아웃, 같은 탭에서 새로고침 시 세션 복원
- 다가오는 일정 개요, 과거 일정을 포함한 전체 목록, 일정 생성
- 로딩·빈 목록·실패·재시도·저장 성공 피드백
- 모바일 메뉴, 가로 스크롤 일정 표, 라이트·다크 테마

가짜 통계나 데모 일정은 화면에 넣지 않습니다. 일정 수정·삭제, 외부 캘린더 연결, 알림은 이 UI에 구현되어 있지 않습니다.

## UI 출처

[Adminator](https://github.com/puikinsh/Adminator-admin-dashboard)의 커밋 `3ec0b93b05a3d540e3562e4dd5e22fa58642e26c`을 기준으로 필요한 부분을 채택했습니다.

- `public/styles.css`: 원본 `src/assets/styles/2026/_tokens.scss`, `_base.scss`의 디자인 토큰과 reset/base 규칙
- `public/adminator.css`: 원본 shell, auth, component, form 스타일을 서비스 화면에 맞게 변형
- `public/index.html`: 분할 인증 화면, 사이드바·상단 바·본문으로 구성한 정적 셸
- `public/ui.js`: 화면 전환, 폼 동작, 로딩·오류·성공 표시
- `public/app.js`: 기존 API 계약을 사용하는 인증·일정 클라이언트

Adminator 전체 데모나 별도 UI 프레임워크를 실행하지 않습니다. 외부 CDN 글꼴 없이 시스템 글꼴로 표시합니다. MIT 고지는 [LICENSES/ADMINATOR.md](LICENSES/ADMINATOR.md)와 배포에 포함되는 [public/vendors/adminator/LICENSE.txt](public/vendors/adminator/LICENSE.txt)에 보존합니다.

## 로컬 실행과 검증

저장소 루트에서 Node.js 22 이상을 사용합니다.

```bash
npm ci
npm test
npm run build
npm run dev
```

개발 서버 기본 주소는 `http://127.0.0.1:5173`이며 `HTTP_PORT`, `HTTP_HOST`로 바꿀 수 있습니다. 빌드는 `dist/`를 생성합니다. 빌드와 일반 테스트는 Node 표준 라이브러리를 사용합니다.

브라우저 검사는 별도로 실행합니다.

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright가 `127.0.0.1:5179`에 테스트 서버를 띄워 데스크톱·모바일 Chromium을 검사합니다. API는 테스트 내부에서 가짜 응답으로 대체하고 외부 요청은 차단하므로 실제 계정·일정을 만들지 않습니다. 로그인 실패·재로그인, 가입·세션 복원·만료, 목록 재시도, 저장 실패 시 입력 보존, HTML 이스케이프, 테마와 모바일 메뉴를 확인합니다. 캡처는 `test-results/`에 저장됩니다.

이 검사는 운영 환경 E2E가 아닙니다. 실제 Gateway 라우팅, CORS, auth/core 연결은 배포 후 별도로 확인해야 합니다. Playwright는 개발 의존성이며 최종 nginx 이미지에는 브라우저나 Node 패키지가 포함되지 않습니다.

## 런타임 API 설정

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `APP_VERSION` | Docker `GIT_SHA` | 화면에 표시하는 배포 버전 |
| `AUTH_BASE_PATH` | `https://api.ggang.cloud/v1/auth` | 인증 API 기본 주소 |
| `SCHEDULE_BASE_PATH` | `https://api.ggang.cloud/v1/core` | 일정 API 기본 주소 |

컨테이너 시작 시 `docker-entrypoint.sh`가 환경변수로 `/tmp/html/runtime-config.js`를 생성합니다. HTTPS URL 또는 절대 경로를 지원합니다. 로컬 개발 서버는 `public/runtime-config.template.js`의 값을 제공합니다.

기본 구성은 웹과 API의 origin이 다릅니다. 브라우저는 API를 직접 호출하며 nginx는 API를 프록시하지 않습니다. API Gateway에서 허용된 웹 origin과 요청 헤더에 맞는 CORS 설정이 필요합니다.

- 회원가입: `/register`에 `email`, `password`, `display_name`, `timezone` 전송 후 자동 로그인
- 토큰: access/refresh 쌍을 탭 범위 `sessionStorage`에 보관; 테마만 `localStorage` 사용
- 복원: 기존 탭을 새로고침하면 `/refresh` 호출; 복원 실패 시 로그인 화면에 오류 표시
- 로그아웃: `/logout`에 refresh 토큰 전송; 실패해도 이 탭의 토큰 제거
- 일정: `/schedules`에 Bearer access 토큰으로 GET·POST

`/healthz`와 `/readyz`는 nginx 자체 상태입니다. 화면의 '웹 서버' 표시도 이 상태만 나타내며 auth/core의 정상 작동을 보장하지 않습니다.

## Docker와 CI

```bash
docker build -t svc-web:local .
docker run -d --rm --name web-smoke --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -p 127.0.0.1:8080:8080 svc-web:local
curl http://127.0.0.1:8080/
curl http://127.0.0.1:8080/runtime-config.js
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
docker stop web-smoke
```

Docker 빌더는 `npm ci`, `npm test`, `npm run build`를 실행하고 최종 이미지는 정적 자산만 포함합니다. 기존 CI의 일반 테스트 게이트에는 브라우저 다운로드가 필요하지 않습니다. 브라우저 검사는 `npm run test:e2e`로 별도 실행합니다.

배포 설정은 별도 GitOps 저장소에서 관리합니다. nginx는 포트 8080, UID/GID 101을 사용하고 읽기 전용 루트 파일시스템에서는 쓰기 가능한 `/tmp`가 필요합니다. Prometheus exporter는 포함하지 않습니다.
