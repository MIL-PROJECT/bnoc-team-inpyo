# BNOC 업무 관리

> 팀 공유 스냅샷: 원본 설문·스크린샷·첨부 원문·실행 DB/첨부·비밀·원시 검증 증거와 원 저장소 Git 이력은 제외했다. 과거 커밋·증거 경로는 비공개 원본 이력이며 이 저장소에서 조회되지 않는다.

## 폴더 안내

```text
frontend/          웹 화면
backend/           업무 서버
mock-provider/     모의 인증·GPS·CPCON 제공자
docs/spec/         요구사항·유스케이스·명세·설계 웹
docs/reference/    대회·조사 근거와 AI 개발 방식
docs/records/      개발·작업·AI 활용·검증 기록
docker/            컨테이너 실행·검증 도구
scripts/           개발·검사·공유 명령
e2e/               API·브라우저 업무 검사
experiments/       AI 워크플로 검사 실험
design/            공통 디자인 자산
runtime/           로컬 실행 자료·검증 증거
.local/            로컬 비밀·도구·공유본 준비 공간
```

팀 공유본에는 선별한 소스·문서·설정만 포함한다. `runtime/`, `.local/`, 원본 PDF·설문은 게시하지 않는다. `docs/sources/`와 기존 원본 설문 폴더는 비공개 원본 위치를 유지한다.

<a id="agent-handoff"></a>
## 팀원·AI 에이전트 인수 시작

이 프로젝트를 받은 에이전트는 `AGENTS.md`와 `.agents/skills/bnoc-workflow/SKILL.md`, 최신 `docs/records/개발진행.md`를 먼저 읽는다. 개인 PC의 대화 이력·스킬 설치를 전제하지 않는다. 팀 기본 작업은 Docker 경로를 사용하며 아래 기존 macOS 명령은 원 개발환경 유지용이다.

1. Git에서 받은 작업 폴더의 브랜치·커밋·기존 변경을 확인한다. 이미 변경이 있으면 보존한다. 새 기능 시작 전 main 최신화·기능별 브랜치 생성, 작업 중 갱신·동시 작업은 [코드를 받는 시점과 여러 기능 작업](#team-git-sync)을 따른다.
2. Node.js 22 이상과 실행 중인 Docker 엔진·Compose가 필요하다. Mac은 CPU에 맞는 Docker Desktop, Windows는 지원되는 Windows·WSL 2의 Linux 컨테이너 구성을 준비한다. 설치 프로그램·권한·재부팅이 필요하면 사람에게 해당 단계만 요청한다.
3. 다음 명령을 저장소 루트에서 순서대로 실행한다. 애플리케이션 도구와 의존성은 이미지 안에서 설치·빌드되므로 호스트 Java·Gradle·MySQL·pnpm 설치는 필요 없다.

```bash
npm run team:doctor
npm run team:check
npm run team:test
npm run team:setup
npm run team:verify
```

개발 주소는 기본 `http://127.0.0.1:18081`이다. 역할을 선택해 로그인한다. 검증은 별도 프로젝트에서 기존 HTTP·Chromium/Firefox PC1280/1440 시험과 요청/첨부 재시작 보존을 실행하고 결과를 `runtime/evidence/team-collaboration-20261017/verify/<실행시각>/`에 남긴다. 개발 서버 재시작 때 로그인 세션은 다시 인증할 수 있지만 저장된 업무 자료는 보존된다. 검증용 내부 Origin은8083이며 호스트 게시 포트18083은 자동 시험용이다. 검증은 끝나면 해당 서비스를 중지하고 개발 서비스는 유지한다. 기존 macOS 전용 저장/민감도 실행기는 별도 실행 경로이며 이 명령이 그 전체 검사를 대신한다고 보고하지 않는다.

```bash
npm run team:status
npm run team:down
```

최초에는 `team:setup`으로 도구·의존성·개발 서버를 준비한다. 이후 서버 시작은 `team:up`, 종료는 `team:down`이다. 화면 소스는 저장 후 자동 반영하고, 서버 소스는 필요한 컴파일 뒤 서버 프로세스만 자동 재시작한다. 일반 수정에 Docker 이미지 재빌드는 필요 없다. 라이브러리 잠금파일·빌드 설정·개발 도구를 바꾸면 AI가 `team:up`을 다시 실행해 필요한 준비를 갱신한다. `team:down`은 이 체크아웃의 개발·검증 서비스를 종료하고 DB·첨부 볼륨을 보존한다. 첫 빌드는 인터넷과 이미지 저장 공간이 필요하다. 실행 오류는 실제 출력·로그로 진단하고, 해결을 위해 DB·볼륨·`.local/team` 비밀을 삭제하지 않는다. secret 파일만 잃고 DB 볼륨이 남으면 기존 자격 증명 복구가 필요하다.

<a id="team-db-environment-updates"></a>
### 코드를 받은 뒤 DB·실행환경 반영

- [ ] **화면·업무 코드 변경:** [코드를 받는 시점과 여러 기능 작업](#team-git-sync)에 따라 main을 갱신하거나 자기 기능 브랜치에 최신 main을 병합한다. 개발 서버가 켜져 있으면 자동 반영·백엔드 재시작을 기다리고, 꺼져 있으면 `npm run team:up`으로 시작한다. 기존 Docker 이미지·DB를 사용한다.
- [ ] **DB 테이블·열 변경:** AI가 구조 변경 명령인 마이그레이션도 함께 커밋한다. 받은 코드의 백엔드가 재시작할 때 자기 DB에 변경을 적용한다. 현재 시작 코드는 [Database.kt](backend/src/main/kotlin/bnoc/Database.kt)의 테이블·열 생성과 변경 이력을 사용한다. 기존 테이블의 형식 변경·삭제에는 그에 맞는 명시적 변경 코드가 필요하다. AI는 빈 DB와 기존 자료가 있는 DB에서 적용·자료 보존을 확인한다. GitHub로 공유하는 것은 구조 변경 코드이며 각 PC의 실제 DB 자료는 별도로 유지한다.
- [ ] **라이브러리·프레임워크·Java·Node.js 등 변경:** 현재 개발환경에서는 `npm run team:up`으로 필요한 도구 이미지·의존성을 갱신한다. 기존 빌드 캐시를 재사용한다.
- [ ] **MySQL 자체 버전 변경:** AI가 버전 호환성과 기존 자료의 백업·복원 절차를 확인하고 격리 환경에서 검증한 뒤 적용한다. 보통 새 버전의 공식 이미지를 받아 DB 컨테이너를 교체한다. DB 볼륨·비밀을 유지하며, 업데이트 오류를 DB 초기화로 해결하지 않는다. 테이블 변경과 DB 엔진 버전 변경은 구분한다.

기본 프로젝트명은 체크아웃 경로 해시로 구별하며 개발·검증을 다시 나눈다. 각 PC의 자료는 공유되지 않는다. 같은 PC에서 여러 체크아웃을 동시에 실행하려면 개발 `BNOC_TEAM_PORT`를 구분하고 검증은 순서대로 실행한다. 경로를 옮기면 프로젝트명이 바뀌므로 기존 저장소를 자동 재사용하지 않는다. 계속 같은 저장소를 사용할 필요가 있으면 `BNOC_TEAM_PROJECT`를 일관되게 지정하되 다른 작업에 중복 지정하지 않는다. 포트·프로젝트 변수는 현재 셸의 OS 방식으로 지정하며 에이전트가 환경에 맞게 설정한다. 다른 폴더/PC의 `.local`을 복제하지 않는다.

사람은 아래 [기능 추가 체크리스트](#team-feature-guide)를 사용한다. 에이전트는 관련 설계·검사·미실행을 기존 기록에 남긴다. 테스트용 가짜 인물·계급이나 실제 부대 자료를 만들지 않고 기존 역할·최소 합성 자료를 사용한다.

<a id="team-github"></a>
## 팀 GitHub 협업

팀원은 같은 팀 저장소의 기능 브랜치·PR로 개발하고 소유자 `JunH1004`만 승인·main 갱신·통합한다. 소유자 본인 작업은 독립 검토·검증 후 PR 없이 main에 반영한다. 이 원본 폴더는 비공개 자료·기존 이력 보관용이며 두 저장소에서 같은 기능을 따로 개발하지 않는다.

팀 개발본은 [JunH1004/bnoc-team](https://github.com/JunH1004/bnoc-team) 비공개 저장소로 관리한다. 원본 Git 이력은 포함하지 않는다. 게시 결과·주소·권한 상태는 [협업 작업 기록](docs/records/작업기록.md#team-collaboration-20261017)에 남긴다. 기존 공개 `JunH1004/bnoc`는 별도 과거 스냅샷이며 자동 동기화하지 않는다.

팀원은 독립 기능별 브랜치에서 작업하고 PR을 제출한다. 따로 완성·검증할 수 없는 변경의 묶음과 코드 갱신 시점은 [협업 절차](#team-git-sync)를 따른다. 승인과 병합은 `JunH1004`만 한다. 소유자 본인 작업에는 PR을 만들지 않으며 검토·검증과 사용자 게시 승인을 거쳐 main에 직접 반영한다. Issue는 필요할 때만 사용하며 팀 사전 합의는 시작 조건이 아니다. PR 템플릿에는 변경 근거·실제 검사·사람 사용 결과를 적는다. `Team verification / verify`는 Ubuntu AMD64에서 Docker 전체 빌드·기존 API/PC 시험·보존 검사를 실행한다. GitHub 실행 결과와 각자의 Mac/Windows 설치 성공은 구분한다. 소유자 전용 승인·갱신과 필수 CI·최신 기준 검사·대화 해결·강제 푸시/main 삭제 금지의 실제 설정은 [최신 협업 기록](docs/records/작업기록.md#owner-main-20261019)에서 확인한다. 자동 배포·자동 병합은 하지 않는다.

원본의 승인된 변경을 팀 저장소에 최초 이관하거나 이번 협업 도구 변경을 반영할 때만, 담당자는 모든 포함 변경을 커밋한 뒤 `npm run team:share`로 `.local/team-share/`에 새 스냅샷을 만든다. 이 도구는 원본 PDF·실행 데이터·비밀·빌드 산출물·Git 이력을 제외하고 대회정보의 개인 준비 내용은 출력본에서만 일반화한다. 공유본 이력과 원본 이력을 합치지 않으며 기존 팀 기여를 덮어쓰지 않는다. 최초 게시 뒤부터는 팀 저장소가 협업 기준이며 팀원은 브랜치/PR, 소유자는 검토·검증·게시 승인 후 PR 없는 main 반영을 사용한다. `.github/`·`.agents/`·`.codex/`·Docker·잠금파일도 함께 받아야 한다.

통신 지원 요청·작업 진행과 부서 운영 현황을 관리하는 PC용 웹 서비스다. React 화면·Spring Boot 서버·MySQL 저장소와 요구사항부터 검증까지의 개발 문서를 함께 제공한다. 실제 공군 SSO·GPS·CPCON 연결은 후속 범위이며 현재 별도 모의 제공자를 사용한다.

## 처음 보는 분을 위한 안내

- **제품과 구현 상태:** [현재 제품](#현재-제품), [개발 진행](docs/records/개발진행.md). 공개 시연 주소는 컴퓨터·MySQL·서버·터널 실행에 의존한다.
- **설계 산출물:** 현재 계약은 [아키텍처 Markdown](docs/spec/아키텍처설계.md)에서 확인한다. [설계 웹](docs/spec/아키텍처설계.html)은 과거 검토 이력이며 2026-10-21 이후 갱신·검토하지 않는다.
- **문서 읽는 순서:** [요구사항](docs/spec/요구사항.md), [유스케이스](docs/spec/유스케이스.md), [시스템 요구사항](docs/spec/시스템요구사항.md), [아키텍처 설계](docs/spec/아키텍처설계.md), [개발 명세서](docs/spec/개발명세서.md).
- **검증과 개발 과정:** [업무 검증 기록](docs/records/업무검증기록.md), [AI 활용 기록](docs/records/AI활용기록.md), [작업 기록](docs/records/작업기록.md), [비식별 조사 요약](docs/reference/조사근거.md).
- **직접 실행:** [실행과 검증](#실행과-검증). 소스는 `frontend/`, `backend/`, `mock-provider/`, 실행 도구는 `scripts/`, 업무 검사는 `e2e/`에 있다.

공개 저장소: **[JunH1004/bnoc](https://github.com/JunH1004/bnoc)**. 공개본은 2026-10-14 기준 스냅샷이며 이후 진행한 설계 0.8 구현 변경은 아직 반영하지 않았다. 현재 로컬 제품 상태와 공개 시연 결과는 [개발 진행](docs/records/개발진행.md)을 따른다.

공개 배포본은 개인정보·첨부 원문·실행 DB/첨부·비밀·원시 실행 증거와 원 저장소의 Git 이력을 제외한 별도 스냅샷으로 만든다. 문서의 과거 커밋 해시·증거 경로는 비공개 작업 이력의 출처다. 해당 원본과 삭제된 과거 문서는 공개 저장소에서 조회할 수 없다. 공개 준비와 실제 업로드 완료 상태는 [작업 기록](docs/records/작업기록.md#github-publication-20261014)을 따른다.

**설계 0.7의 업무·저장 기반 위에 승인된 0.8 사용성 개선을 구현하고 검증했다.** 단위54/54·HTTP26/26·PC 화면48/48·DB 보존3개·민감도 정상98/오류8 검사를 통과했다. 현업 과제 검수와 실제 공군 연동·이식성 고도화는 남아 있다. 실행 결과와 제한은 [개발 진행](docs/records/개발진행.md)에 연결한다.

**PC 전용 완성도 개선 구현은 완료했다.** 모바일 지원은 제외하고 오류·저장·조회 안내, 집계 단위와 정보 배치를 다듬었다. 자동 검사와 공개 접속 확인은 통과했으며 실제 사용 효용은 현업 과제로 확인해야 한다. [변경·합격 기준·실행 기록](docs/records/작업기록.md#desktop-quality-20261014)과 최신 [0.8 구현 결과](docs/records/작업기록.md#usability-design-20261017)를 구분한다.

- **팀원이 기능을 추가할 때:** [AI 지시·사람 검수·GitHub 협업·환경 전달 가이드](#team-feature-guide).

## 설계 검토

2026-10-22 로그인 롤백 결정: 부서별 작업반 계정은 유지하며 같은 부서 내부의 행정병·작업병을 로그인에서 구분하지 않는다. 이번 추가 기능 작업의 로그인·계정 선택·인증 흐름 변경은 모두 기준051444d로 복원한다. 데모 전용 로그인/계정/세션·권한 관리 화면 대체를 제거하며 기존 SSO/부서 계정을 그대로 사용한다. 따라서 독립 Vite5173의 데모 로그인 버튼은 제공하지 않는다. 업무 시안은 기존 인증이 실행되는 앱에서 로그인한 후 `?preview=survey`로 확인한다.

2026-10-22 후속 결정으로 가용 자원 기능을 철회했다. 자원 목록·가용 안내 메뉴와 신청 중 조회 패널은 제공하지 않는다. [변경 근거와 결과](docs/records/작업기록.md#resource-availability-withdrawal-20261022)를 따른다.

2026-10-24 설문 기반 추가 기능 FR-038 상태 안내, FR-041 요청·문서 검색, FR-042 HWP/PDF 보기·본문·메타데이터와 팀원 피드백 FR-045~049를 제품에 구현했다. FR-042는 OCR을 사용하지 않는다. PDF의 내장 텍스트는 추출·검색하며 텍스트 없는 스캔 PDF는 원본 보기·다운로드만 제공한다. 기존 첨부는 순차 재분석되므로 완료 전까지 내용 검색이 대기 상태일 수 있다. FR-039 유형별 추가 입력·복수 대상과 FR-040 자원 가용 기능은 철회 상태다. 공개 시연은 현재 JAR를 반영해 화면 200·익명 세션 401·패키지 해시 일치를 확인했다. 실제 HWP 표·복잡한 PDF 추출 품질과 공개 DB의 기존 문서 재분석 완료는 미검증이다. PR #4는 2026-10-22에 GitHub main에 병합됐다. 최신 범위·검증은 [작업 기록](docs/records/작업기록.md#document-ocr-removal-20261024)을 따른다. 이전 `/requests?preview=survey`는 브라우저 메모리 시안이며 실제 제품 기능 검증 주소로 쓰지 않는다.

[아키텍처 설계 웹](docs/spec/아키텍처설계.html)은 과거 설계 검토 이력이다. 2026-10-21 사용자 결정에 따라 이후 기능 설계는 관련 Markdown 명세를 갱신하고 이 웹은 더 이상 갱신·검토하지 않는다. 계획 정비는 구현 승인 전 설계 초안이다. 원본 복구본은 Git `fed2b10`에 보존했다.

[대회용 모의 연동 계약](docs/spec/개발명세서.md#competition-integration): 별도 제공자가 모의 인증·GPS/CPCON 정보를 제공하고 BNOC 서버가 세션·권한·수집·저장을 처리한다. 실제 모의 구현 여부는 기술 문서·서버 설정·검증 기록에 남기며 사용자 화면에는 구현 구분 문구를 넣지 않는다. 실제 공군 연결 완료로 보고하지 않는다.

핵심 명세·설계는 `docs/spec/`, 근거는 `docs/reference/`, 작업·검증 기록은 `docs/records/`에 있다. `재설계/`와 `백엔드설계/`는 통합·제거했다.

| 문서 | 확인할 내용 |
| --- | --- |
| [요구사항](docs/spec/요구사항.md) | 최신 사용자 결정, 대회 필수 기능, 제외 범위, 남은 결정 |
| [유스케이스](docs/spec/유스케이스.md) | 누가 어떤 화면에서 입력·저장·조회하는지, 실패·예외 동작 |
| [시스템 요구사항](docs/spec/시스템요구사항.md) | 요구사항·유스케이스를 구체화한 기능별 동작·입력·출력·예외 |
| [아키텍처 설계](docs/spec/아키텍처설계.md) | 기능 명세의 담당 모듈 배정·실행 경계·함수·입출력 |
| [개발 명세서](docs/spec/개발명세서.md) | 백엔드·기술 선택·API·저장 계약과 과거 데모 기준선 |
| [작업 규칙](AGENTS.md) | 문서 우선순위, 문서 중심 작업, 새 문서 종류의 사전 승인 |

각 문서의 접힌 ‘웹 데모 기준선’은 과거 계약이다. 현재 업무 계약과 구현은 문서 첫 부분을 따른다. 예전 루트 개발명세서는 새 통합 명세로 대체했다.

근거와 이력: [대회 정보](docs/reference/대회정보.md), [조사근거](docs/reference/조사근거.md), [작업 기록](docs/records/작업기록.md), [개발 진행](docs/records/개발진행.md), [AI 활용 기록](docs/records/AI활용기록.md), [업무 검증 기록](docs/records/업무검증기록.md). 삭제한 과거 문서는 Git 이력에 남아 있다. 검증 산출물의 과거 경로·해시는 당시 증거로 유지한다.

## 현재 제품

React 화면과 API를 하나의 Spring Boot JAR에서 제공한다. 요청·작업·이력·알림·명부·병력·야간 근무·공지는 MySQL에 저장하며 첨부 내용은 비공개 파일 경로에 보관한다. 서버 세션과 현재 권한을 검사한다. 사용자 화면은 역할명으로 로그인하며 명부는 비어 있는 상태에서 부서 담당자가 입력한다. 자체 회원가입·가짜 이름·합성 계급·임시 단계는 사용하지 않는다.

현재 공개 시연 주소: **[BNOC 업무·부대 운영](https://services-local-impressive-roy.trycloudflare.com)**. 최신 기능 JAR 반영 후 공개 화면 HTTP 200, 익명 세션 HTTP 401, 실행 패키지 해시 일치를 확인했다. 컴퓨터·MySQL·서버·터널이 실행 중일 때 이용하는 임시 주소다. 상시 호스팅 완료는 아니다. 현재 주소와 실행 상태는 `npm run server:public-status`로 확인한다. 실제 로그인은 기존 계정이 필요하다.

2026-10-14 로그인·상단·인증 창·GPS/CPCON의 구현 설명을 제거하고 같은 공개 주소에 반영했다. 최신 [실행 결과](docs/records/개발진행.md)는 이번 표시 검사와 이전 전체 업무 검증을 구별한다.

`a10bb49`의 [기존 공개 정적 데모](https://bnoc-operations.allsoft1004.chatgpt.site)는 과거 배포본이다. 이번 JVM/DB 제품을 그 주소에 배포하지 않았다. 로컬 실행의 기본 주소는 `http://127.0.0.1:8081`이다.

## 실행과 검증

Node.js 22 이상·Java 17·Gradle 9.3.0·MySQL 8.4가 필요하다. 이 작업환경에는 도구를 준비했다. 실행기는 기본으로 `.local/dependencies/gradle-9.3.0`과 `.local/dependencies/mysql-8.4.11-macos15-arm64`를 사용한다. 다른 설치 경로는 `BNOC_GRADLE` 실행 파일·`BNOC_MYSQL_HOME` 설치 디렉터리로 지정한다.

```bash
npm install
npm --prefix frontend install
npm run server:build
npm run server:start
npm run server:status
```

제품은 8081, 별도 모의 제공자는 8082, 이 프로젝트의 MySQL은 3307에서 실행한다. 시작 실행기가 자기 서비스를 백그라운드로 유지한다. 새로고침과 업무 서버 재시작이 DB·첨부를 초기화하지 않는다. 비밀·DB·첨부·프로세스 기록은 Git에서 제외한 `.local/bnoc-runtime/`에 보관하며 기존 3306 DB를 사용하지 않는다. 종료는 `npm run server:stop`이다.

공개 시연 실행기는 `npm run server:public-start`다. 공식 [cloudflared](https://developers.cloudflare.com/tunnel/downloads/)를 `.local/dependencies/cloudflared/cloudflared`에 준비하고 위 도구·JAR을 사용한다. 별도 8085 서버·8086 모의 제공자·`bnoc_public_demo` DB·`.local/bnoc-public/attachments`를 사용하며 기존 제품·검증 DB를 복제하지 않는다. 브라우저 로그인도 공개 서비스의 `/identity`를 사용한다. MySQL·컴퓨터·공개 서버·터널이 실행 중이어야 접속하며 터널을 새로 시작하면 주소가 바뀐다. 상태/현재 URL은 `npm run server:public-status`, 저장을 유지한 서버 재시작은 `npm run server:public-restart`, 공개 서비스만 종료하려면 `npm run server:public-stop`이다. 이는 상시 호스팅이 아니다.

로그인에서 역할을 선택해 요청자·BNOC·작업반·부서 담당자·권한 관리자 흐름을 확인한다. 역할 변경은 로그아웃 후 다시 로그인한다. 추가 부서는 `BNOC_DEPARTMENTS`의 쉼표 구분 목록으로 서버 시작 시 등록하고 권한 관리 화면에서 부서 담당자를 지정한다.

검사는 별도 8083 서버·`bnoc_verify` DB·첨부 경로를 사용한다. HTTP·브라우저·저장 검사는 모의 제공자의 상태를 바꾸므로 순서대로 실행한다.

```bash
npm run server:verify-start
npm test
npm run test:provider
npm run test:server
npm run test:e2e
npm run test:server-storage
npm run test:server-sensitivity
```

과거 데모의 단위 검사·업무 흐름 원본은 보존한다. 새 제품 검사는 API 사용·DB 보존을 확인하므로 새로고침 초기화를 기대하는 옛 브라우저 검사를 현재 제품의 합격 기준으로 사용하지 않는다. 실행 결과는 [개발 진행](docs/records/개발진행.md)과 [업무 검증 기록](docs/records/업무검증기록.md)에 연결한다. 2026-10-14 최종 JAR은 서버 35/35·화면 단위 48/48·모의 제공자 3/3·HTTP 26/26·전체 UI 54/54를 통과했다. 공개 HTTPS 독립 검증 10/10·두 브라우저/세 너비·공개 서버 재시작/첨부 보존도 확인했다. 2026-10-13의 실제 DB 동시 저장·롤백·재시작/첨부 보존과 당시 8081 검사 증거는 수행판을 구분해 보존한다.

과거 설계 웹의 정적·브라우저 검사와 격리 오류 16건 탐지 결과는 [개발 진행](docs/records/개발진행.md)에 보존했다. 2026-10-21 이후 기능 설계·검토에서는 이 웹과 웹 검사 명령을 사용하지 않는다. 제품 검증과 당시 웹 검증 결과는 구별한다.

<a id="team-feature-guide"></a>
## 팀원의 AI 기능 추가 가이드

2026-10-17 팀 협업 준비 안내에 2026-10-19 소유자 단독 승인 결정을 반영했다. 팀원은 기능 브랜치 PR, 소유자 `JunH1004`는 검토·검증 후 PR 없는 main 반영을 사용한다. 사용성 0.8 구현 이후 기준 제품에 추가할 기능을 함께 개발하기 위한 절차다. 추가 기능 선정·구현·공개 배포를 일괄 승인하는 문서가 아니다. 최신 구현·검증 상태는 [개발 진행](docs/records/개발진행.md)을 확인한다.

### 1단계: 이번 작업 단위를 정한다

- [ ] 독립적으로 완성·검증할 기능을 한 문장으로 적는다. 분리할 수 없는 기능은 이유를 남겨 하나의 작업 단위로 묶는다.
- [ ] [코드 갱신·브랜치 절차](#team-git-sync)에 따라 최신 main에서 시작한다. 여러 기능을 동시에 만들면 작업 단위별 브랜치·폴더를 구분한다.

### 2단계: AI와 기능을 의논한다

- [ ] 아래 프롬프트로 대화한다.

```text
BNOC에 [기능]을 추가하고 싶어. 아직 파일은 수정하지 마.
AGENTS.md와 관련 스킬, docs/spec/요구사항.md·docs/spec/유스케이스.md·docs/records/개발진행.md를 확인해줘.
누가 어떤 상황에서 사용하는지, 지금 무엇이 불편한지, 원하는 결과가 무엇인지 나와 의논해줘.
기존 문서에 답이 있는 내용은 먼저 설명하고, 필요한 질문만 해줘.
```

### 3단계: 문서 수정이 필요한지 판단한다

- [ ] 아래 프롬프트를 전달한다.

```text
의논한 기능에 문서 수정이 필요한지, 이유와 영향부터 설명하고 나와 의논해줘.
필요하면 관련 문서만 수정하고 연결된 설계와 모순되지 않게 맞춰줘.
문서 수정이 필요 없으면 그 이유와 구현 범위를 정리해줘. 제품 코드는 아직 수정하지 마.
```

문서 역할: [요구사항](docs/spec/요구사항.md)은 기능의 목적·범위, [유스케이스](docs/spec/유스케이스.md)는 사용 흐름, [시스템 요구사항](docs/spec/시스템요구사항.md)은 동작 조건, [아키텍처](docs/spec/아키텍처설계.md)는 모듈 연결, [개발 명세](docs/spec/개발명세서.md)는 구현 계약이다.

### 4단계: 설계를 확인한다

- [ ] AI가 정리한 구현 범위와 수정한 Markdown 명세를 확인한다. 과거 설계 웹은 검토 대상에서 제외한다.
- [ ] 원하는 내용이 될 때까지 AI와 수정한다.

### 5단계: UI 데모를 요청한 경우 기존 앱에서 먼저 확인한다

- [ ] 데모를 요청했으면 기존 경로·로그인·메뉴 셸 안에서 화면을 구성한다. 별도 앱이나 우회 페이지를 만들지 않는다.
- [ ] `design/tokens.css`와 `frontend/src/ui/`의 공통 컴포넌트를 조립한다. 계획 기능의 쓰기는 fixture 메모리에만 두고 기존 API·DB에 저장하지 않는다.
- [ ] 접근 링크, 사용 절차, 확인 목표를 함께 안내하고 화면 피드백을 반영한다. 데모 승인은 실제 API·DB 동작 승인이 아니다. 데모를 요청하지 않았으면 이 단계를 건너뛴다.

### 6단계: 구현을 지시한다

- [ ] 설계 확인 및 요청한 데모 승인 뒤 아래 프롬프트를 전달한다. 화면은 공통 토큰·컴포넌트로 조립하고 화면별 CSS는 기능 배치에만 사용한다.

```text
확인한 설계대로 [기능]을 구현해줘.
AGENTS.md의 작업·검토·검증 절차를 따르고 다른 사람의 변경을 보존해줘.
기존 Docker 인수·검증 명령을 사용해줘. 공유 서버 배포·main 반영은 제외해줘.
DB 구조 변경이 필요하면 마이그레이션도 포함하고 빈 DB·기존 자료가 있는 DB에서 검증해줘.
실행환경 변경이 필요하면 인수 가이드의 DB·실행환경 반영 기준에 맞춰 적용해줘.
```

### 7단계: AI의 검사 결과를 확인한다

- [ ] 아래 프롬프트로 결과를 받는다.

```text
실제 검사 결과와 남은 문제, 내가 기능을 확인할 실행 주소를 알려줘.
실패·미실행이 있으면 설명하고 관련 docs/records/업무검증기록.md와 연결해줘.
```

### 8단계: 직접 사용해본다

- [ ] 실제로 사용해보고 의도한 기능인지 판단한다.

### 9단계: 문제가 있으면 수정시킨다

- [ ] 문제가 있으면 아래 프롬프트로 전달하고 수정 결과를 다시 확인한다.

```text
[어떤 행동]을 했을 때 [기대한 결과] 대신 [실제 결과]가 나왔어.
원인을 확인해 수정하고 다시 검증해줘.
```

### 10단계: 결과를 기록하고 저장한다

- [ ] 아래 프롬프트를 전달한다.

```text
실제 결과를 docs/records/개발진행.md·docs/records/작업기록.md·docs/records/AI활용기록.md에 반영해줘.
발견한 문제는 docs/records/업무검증기록.md에 남겨줘.
최신 main을 내 기능 브랜치에 병합하고 충돌 해결·관련 검사를 마친 뒤 이번 변경만 커밋해줘.
JunH1004가 검토·승인할 PR 초안을 준비해줘. 아직 병합·공유 서버 배포는 하지 마.
```

소유자 `JunH1004`의 본인 작업은 PR 없이 진행한다. 1~8단계의 검토·검증 뒤 아래처럼 지시한다.

```text
실제 결과를 기존 개발·작업·AI 활용 기록에 반영하고 이번 변경만 커밋해줘.
PR은 만들지 마. main에 올리라는 내 명시적 승인이 있으면 main에 직접 반영하고 필수 CI 결과까지 확인해줘.
아직 게시 승인이 없으면 main push·공유 서버 배포는 하지 마.
```

### 참고: GitHub로 협업하는 방법

[비공개 팀 저장소](https://github.com/JunH1004/bnoc-team)의 `main`을 공통 기준으로 사용한다. 기존 공개 `JunH1004/bnoc`는 별도 과거 스냅샷이다. 팀원은 GitHub 아이디 확인·초대 수락 뒤 접근한다.

1. 통합 담당자가 최신 검증 결과와 기준 커밋을 공유한다. 진행 중인 미커밋 작업을 ZIP으로 나눠 개발 기준으로 삼지 않는다.
2. 각자 저장소를 복제하고 [코드 갱신·브랜치 절차](#team-git-sync)에 따라 최신 main에서 기능별 `codex/<기능이름>` 브랜치를 만든다. 같은 브랜치·같은 작업 폴더를 여러 사람이 공유하지 않는다.
3. AI와 기능을 구체화하고 본인이 설계를 확인한 뒤 자기 브랜치에서 구현·검증한다. Issue는 기록이 필요할 때 사용한다. GitHub Desktop으로 복제·브랜치·변경 비교·업로드를 수행할 수 있다.
4. 팀원은 PR을 만들어 변경 설명·시험 결과·직접 검수 절차를 공유한다. 승인자는 소유자 `JunH1004` 한 명이다. 소유자 본인 작업은 독립 검토·검증 후 PR 없이 main에 반영한다.
5. `JunH1004`가 팀원 PR을 검토·승인·병합한다. 충돌은 두 기능의 의도를 대조해 해결하고 관련 검사를 다시 실행한다. AI에게 한쪽 변경을 통째로 버리게 하지 않는다.
6. 통합된 코드에서 관련 회귀 검사를 수행하고, 같은 커밋의 제품을 공동 검수 서버에 반영한다. 담당자가 직접 최종 과제를 확인한다.

`main` 갱신·통합은 `JunH1004`만 수행한다. 팀원 PR은 `.github/CODEOWNERS`의 `* @JunH1004`에 따라 소유자 승인을 받는다. 소유자는 본인 작업의 PR 없이 main에 반영할 수 있으며, 에이전트는 해당 변경의 사용자 게시 승인 후에만 push한다. 필수 `verify`·최신 기준 검사·대화 해결은 유지하고 강제 푸시와 main 삭제는 금지한다. 완료 기능·임시 검증 브랜치는 main에 내용 보존을 확인한 뒤 아래 기준으로 정리한다. `Team verification`은 main·`codex/**` push와 PR에서 자동 실행한다. 실제 보호 설정·PR #1 취소·main 반영·CI 상태는 [2026-10-19 작업 기록](docs/records/작업기록.md#owner-main-20261019)을 따른다. 실제 실행자·커밋·명령·결과를 기존 기록과 팀원 PR에 명시한다. 커밋에는 기존 규칙의 `AI-Tool:`, `AI-Session:`, `AI-Feature:`를 남긴다.

<a id="team-git-sync"></a>
#### 코드를 받는 시점과 여러 기능 작업

명령은 팀 저장소의 작업 폴더에서 실행한다. `git status`로 브랜치와 변경을 확인하고, 미커밋 변경은 해당 기능 브랜치에 커밋하거나 임시 보관(stash)한 뒤 전환·갱신한다. 보관할 때는 필요한 새 파일도 포함됐는지 확인하고 원래 기능 브랜치로 돌아와 복원한다. 다른 기능의 변경을 가져가거나 변경을 버려 갱신 오류를 해결하지 않는다.

**새 기능을 시작하기 전:** `main`에서 최신 코드를 받은 뒤 새 기능 브랜치를 만든다. 아래는 공지 검색 기능의 예시다.

```bash
git status
git switch main
git pull --ff-only origin main
git switch --no-track -c codex/notice-search
```

`--ff-only`가 거절되면 로컬 main의 별도 커밋과 원격 변경을 확인한다. 강제 초기화·강제 push로 맞추지 않는다. GitHub Desktop에서는 **Current Branch**에서 `main` 선택, **Fetch origin**, 변경이 있으면 **Pull origin**, **New Branch**에서 기능 브랜치 생성 순서다. `Pull origin`은 현재 선택한 브랜치를 갱신하므로 먼저 `main` 선택을 확인한다.

**작업 중 main 변경을 전달받았을 때와 PR 제출 직전:** 자기 기능 브랜치에서 최신 main을 병합한다. 진행 중인 변경을 먼저 보존한 뒤 실행한다.

```bash
git switch codex/notice-search
git fetch origin
git merge origin/main
```

충돌은 두 변경의 의도를 확인해 해결하고 병합을 마친 뒤 관련 검사·직접 사용 검수를 다시 한다. 팀원 PR에 새 커밋을 push한 뒤 CI 결과도 확인한다. 기능 브랜치의 `git pull`만으로 main 변경을 받았다고 판단하지 않는다. GitHub Desktop에서는 먼저 `main`을 **Fetch origin / Pull origin**으로 갱신하고, **Current Branch**에서 자기 기능 브랜치로 돌아와 **Choose a branch to merge into …**에서 `main`을 선택해 병합한다. 다른 worktree가 main을 사용 중이면 그 폴더에서 main을 갱신하거나 위 CLI의 `origin/main` 병합을 사용한다.

**PR이 main에 병합된 후:** 변경이 모두 저장됐는지 확인하고 `git switch main`, `git pull --ff-only origin main` 순서로 받는다. GitHub Desktop은 `main` 선택 후 **Fetch origin / Pull origin**이다. 다음 기능은 이 최신 main에서 새 브랜치로 시작한다. worktree 때문에 main 전환이 거절되면 `git worktree list`로 main을 사용하는 폴더를 찾아 그 폴더에서 갱신한다. 다른 기능을 계속 개발할 때는 그 기능 브랜치에 위 방식으로 최신 main을 병합한다. 받은 코드의 서버·DB 반영은 [DB·실행환경 반영](#team-db-environment-updates)을 따른다.

**여러 기능을 만들 때:** 공지 검색과 통계처럼 독립적으로 완성·검증할 수 있으면 `codex/notice-search`, `codex/stats`처럼 기능별 브랜치를 만든다. 따로 완성·검증할 수 없는 변경은 하나의 작업 단위·브랜치·PR로 묶고 이유를 남긴다. 각 작업 단위에 위 1~9단계를 적용한다.

한 폴더에서 순차 작업할 때는 변경을 보존한 뒤 브랜치를 전환한다. 여러 AI가 동시에 작업할 때는 worktree로 폴더를 나누고 각 AI에 자기 폴더를 지정한다. 예를 들어 공지 검색 브랜치에서 작업 중 통계를 별도로 시작한다면 아래처럼 최신 `origin/main`에서 새 폴더·브랜치를 만든다. 현재 공지 검색 브랜치에서 통계 브랜치를 파생하지 않는다.

```bash
git fetch origin
git worktree add --no-track -b codex/stats ../bnoc-stats origin/main
```

`--no-track`은 새 기능 브랜치가 원격 main을 자기 업로드/수신 대상으로 추적하지 않게 한다. 처음 게시할 때는 해당 기능 폴더에서 `git push -u origin codex/stats`처럼 같은 이름의 원격 기능 브랜치를 지정한다. 공지 검색은 `git push -u origin codex/notice-search`를 사용한다. GitHub Desktop은 현재 기능 브랜치를 확인한 뒤 **Publish branch**로 게시한다.

각 폴더에서 [최초 준비](#agent-handoff)를 수행한다. 같은 PC에서 동시에 실행할 때 개발 `BNOC_TEAM_PORT`를 각각 다른 값으로 지정한다. 기본 Compose 프로젝트는 체크아웃 경로 해시로 구별되고 DB·첨부·비밀도 각각 유지한다. `.local`을 복제하거나 같은 `BNOC_TEAM_PROJECT`를 여러 폴더에 중복 지정하지 않는다. 검증은 순서대로 실행한다. 포트·프로젝트 지정과 자료 보존은 [DB·실행환경 반영](#team-db-environment-updates)을 따른다.

**완료 브랜치 정리:** 소유자가 main 반영·검증과 내용 보존을 확인한 뒤, 남은 변경·미반영 커밋과 진행 중인 작업이 없는 완료 기능·임시 검증 브랜치만 정리한다. squash 병합은 커밋 해시가 달라 Git이 미병합으로 표시할 수 있으므로 표시만 보고 강제 삭제하지 않고 PR·main 반영 내용을 대조한다. worktree를 정리하기 전에는 서비스를 종료하고 DB·첨부·비밀 보존 여부도 확인한다. 폴더를 지우는 일과 브랜치를 지우는 일을 구분한다. `main` 삭제와 강제 push는 계속 금지한다.

현재 원격 브랜치를 main 하나로 정리하는 기준은 작업 종료 상태다. 이후 개발할 기능 브랜치와 필수 CI를 위한 임시 검증 브랜치는 만들 수 있으며, 완료 뒤 위 기준으로 정리한다. 소유자 본인 작업도 아래 필수 CI·명시적 게시 승인을 지킨다.

명령과 Desktop 조작 근거: [Git pull](https://git-scm.com/docs/git-pull), [Git worktree](https://git-scm.com/docs/git-worktree), [GitHub Desktop 브랜치 동기화](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/syncing-your-branch-in-github-desktop).

소유자의 새 커밋도 main 반영 전에 필수 검사를 통과해야 한다. PR 없이 진행할 때는 `codex/<기능이름>` 기능·검증 브랜치에 커밋을 push한다. `Team verification`은 main과 `codex/**` 브랜치의 push, 팀원 PR에서 자동 실행된다. GitHub Actions에서 게시할 정확한 커밋·이벤트 `push`의 `verify` 성공을 확인한 뒤 같은 커밋을 main에 비강제 fast-forward한다. main push 뒤에도 자동 검사는 다시 실행된다. `Run workflow` 수동 실행은 추가 확인용이며 [필수 검사 인정 조건](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated)에 따라 push/PR 자동 검사를 대신하지 못한다.

### 참고: 서버가 있는 프로젝트 인수

소스·지침은 GitHub로 받고 서버·MySQL·모의 제공자는 [에이전트 인수 절차](#agent-handoff)의 Docker 명령으로 각 PC에서 실행한다. DB·첨부는 각자의 독립 볼륨에 보존되며 개인 계정·비밀·실자료는 전달하지 않는다. Mac/Windows 설치와 실행 성공은 실제 해당 PC에서 확인한다. 기존 macOS 전용 설치 설명은 원 개발환경에만 적용한다.

### 참고: 개발·자동 검사·공동 검수 환경

Docker 개발과 자동 검사는 별도 프로젝트·DB·첨부·provider 상태를 사용한다. 기존 macOS 제품8081·검증8083·임시 공개8085와도 분리한다. 공동 검수 주소는 통합 담당자가 반영한 버전을 보는 곳이며 각자의 변경이 자동 배포되지는 않는다. 공동 시연 DB에 자동 검사를 연결하지 않는다.

환경 구성은 [Docker Compose 시작 순서](https://docs.docker.com/compose/how-tos/startup-order/)·[비밀 파일](https://docs.docker.com/compose/how-tos/use-secrets/), 브랜치·PR은 [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow)를 참고했다. 실제 검증·게시 상태는 [협업 작업 기록](docs/records/작업기록.md#team-collaboration-20261017)을 따른다.
