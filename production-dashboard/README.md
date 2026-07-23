# 영상 업무 대시보드 배포 가이드

이 프로젝트는 Vercel에 바로 올릴 수 있는 정적 웹 대시보드입니다. 데이터 저장, 로그인, 회원가입은 Supabase를 사용합니다.

## 1. GitHub 업로드

터미널에서 이 폴더로 이동합니다.

```bash
cd /Users/YOOHEESOO/Documents/Codex/2026-07-02/d/outputs/production-dashboard
git init
git add .
git commit -m "Prepare Vercel Supabase deployment"
git branch -M main
git remote add origin https://github.com/깃허브아이디/저장소이름.git
git push -u origin main
```

이미 GitHub 저장소가 있다면 `git remote add origin ...` 주소만 본인 저장소 주소로 바꾸면 됩니다.

## 2. Supabase 연결

1. [Supabase](https://supabase.com)에 로그인합니다.
2. New project(새 프로젝트)를 누릅니다.
3. 프로젝트 이름과 Database Password(데이터베이스 비밀번호)를 입력합니다.
4. 프로젝트 생성 후 왼쪽 메뉴에서 SQL Editor(SQL 편집기)를 엽니다.
5. `supabase/schema.sql` 파일 내용을 전체 복사해 실행합니다.
6. Authentication(인증) > Users(사용자)에서 관리자 이메일 계정을 직접 만듭니다.
7. SQL Editor에서 `schema.sql` 맨 아래의 관리자 승인 SQL 예시를 실제 관리자 이메일로 바꿔 실행합니다.

기존 Supabase 프로젝트에도 영상·업무 공유 링크 기능을 사용하려면 최신 `supabase/schema.sql` 전체를 SQL Editor에서 다시 실행해야 합니다. 기존 데이터는 유지되고 공유 링크용 테이블과 보안 함수가 추가됩니다.

## 3. 환경변수 등록

로컬 테스트용 파일은 `.env.local.example`을 복사해서 만듭니다.

```bash
cp .env.local.example .env.local
```

Supabase 프로젝트의 Project Settings(프로젝트 설정) > API에서 값을 확인해 입력합니다.

```bash
SUPABASE_URL=Supabase Project URL
SUPABASE_ANON_KEY=Supabase anon public key
TELEGRAM_BOT_TOKEN=BotFather에서 받은 봇 토큰
TELEGRAM_CHAT_ID=텔레그램 그룹 chat id
SUPABASE_SECRET_KEY=Supabase 서버 전용 Secret key
CRON_SECRET=16자 이상의 임의 문자열
OPENAI_API_KEY=OpenAI 서버 전용 API 키
OPENAI_MONTHLY_REPORT_MODEL=gpt-5.6-luna
```

Vercel에도 같은 값을 등록해야 합니다.

1. Vercel 프로젝트로 이동합니다.
2. Settings(설정) > Environment Variables(환경변수)를 엽니다.
3. 아래 환경변수를 추가합니다.
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `SUPABASE_SECRET_KEY` 또는 기존 프로젝트의 `SUPABASE_SERVICE_ROLE_KEY`
   - `CRON_SECRET`
   - `OPENAI_API_KEY`
   - `OPENAI_MONTHLY_REPORT_MODEL` (선택, 기본값 `gpt-5.6-luna`)
4. 저장 후 Redeploy(다시 배포)를 실행합니다.

## 4. Vercel 배포

1. [Vercel](https://vercel.com)에 로그인합니다.
2. Add New(새로 추가) > Project(프로젝트)를 누릅니다.
3. GitHub에 올린 저장소를 Import(가져오기)합니다.
4. Framework Preset(프레임워크 설정)은 Other(기타)로 둡니다.
5. Build Command(빌드 명령어)는 비워둡니다.
6. Output Directory(출력 폴더)는 비워둡니다.
7. Environment Variables(환경변수)에 Supabase 값을 등록합니다.
8. Deploy(배포)를 누릅니다.

## 로그인과 회원가입

- 회원가입은 이메일, 비밀번호, 이름, 직책으로 신청합니다.
- 새 계정은 기본적으로 승인 대기 상태입니다.
- 관리자가 Supabase의 `profiles` 테이블에서 `approved = true`, `status = approved`로 바꾸면 로그인할 수 있습니다.
- 앱 안 관리자 모드에서도 계정 상태를 관리할 수 있습니다.

## 영상·업무 공유 링크

- 영상 상세의 `영상 공유`, 업무 상세의 `업무 공유` 버튼을 누르면 전용 링크가 복사됩니다.
- 링크를 아는 사람은 로그인하지 않아도 공유된 항목 1건만 읽기 전용으로 볼 수 있습니다.
- 로그인한 승인 사용자는 같은 링크에서 해당 항목을 수정할 수 있습니다.
- 공유 화면은 전체 대시보드 데이터를 내려받지 않고 Supabase 보안 함수를 통해 선택된 항목만 조회합니다.

## 텔레그램 데일리 브리핑

1. 텔레그램 `@BotFather`에서 봇을 만들고 그룹에 추가합니다.
2. Vercel 환경변수에 봇 토큰과 그룹 Chat ID를 등록합니다.
3. 예약 전송을 사용하려면 Supabase 프로젝트의 Settings > API Keys에서 서버 전용 Secret key를 발급해 `SUPABASE_SECRET_KEY`로 등록합니다.
4. 비밀번호 생성기로 16자 이상의 임의 문자열을 만들어 `CRON_SECRET`으로 등록합니다.
5. 재배포 후 대시보드의 관리자 모드 > 텔레그램 봇 관리에서 포함 항목, 공지 메시지, 전송 방식을 설정합니다.

직접 푸시는 관리자 계정의 Supabase 로그인 정보를 확인한 뒤 실행됩니다. 예약 푸시는 서버에서만 Secret key를 사용하며 브라우저에는 전달되지 않습니다. Vercel Hobby 요금제는 예약 실행 시간이 시간 단위이므로 선택한 시간대의 0~59분 사이에 전송될 수 있습니다.

## 월말보고서 작성

1. Vercel 환경변수에 `OPENAI_API_KEY`를 등록하고 다시 배포합니다.
2. 관리자 모드 > 보고서 작성 > `1. 자료 선택`에서 보고 월과 포함할 항목을 확인합니다.
3. `2. GPT 정리`에서 월말보고 작성 프롬프트를 확인하고 `보고서 정리 시작`을 누릅니다. 체크된 전체 보고서를 한 번에 검토해 중복 항목 통합, 하위 업무 흡수, 불필요한 항목 제외, 전체 문체와 항목 순서 정리를 수행합니다.
4. `3. 미리보기`에서 항목을 체크 해제하거나 문구를 직접 수정합니다.
5. `4. Word 출력`에서 파일명과 보고자를 확인하고 `.docx` 파일을 받습니다.

GPT 요청에는 관리기록 본문, 프로젝트 메모, 방송실 시간·장소·스탭 상세정보를 보내지 않습니다. GPT 결과에서 항목 누락·중복 또는 원본 제목·날짜 변경이 확인되면 기존 문구로 조용히 대체하지 않고 오류를 표시합니다. API 키는 서버 함수에서만 사용하며 브라우저 환경변수로 노출하지 않습니다.

Word 양식은 `templates/monthly-report-template.docx`에 둡니다. 양식을 교체할 때는 같은 파일명으로 덮어쓰되 `활동내용`, `제작물현황`, `차월계획`, 보고기간, 보고일, 보고자 위치는 유지해야 합니다. 활동내용은 상위 업무를 `- 상위업무`, 하위 업무를 `1) 하위업무`, `2) 하위업무` 형식으로 출력합니다. 선택한 보고 월이 `2026-07`이면 문서에는 `신천기 43(2026)년 7월분`, 보고일에는 `신천기 43(2026)년 7월 31일`이 입력되고 파일명은 `영상제작과_문화부_7월말보고서.docx`가 됩니다.

## 파일 설명

- `index.html`: 화면 구조
- `app.js`: 대시보드 기능
- `styles.css`: 디자인
- `api/env.js`: Vercel 환경변수를 브라우저에 전달
- `api/telegram-digest.js`: 관리자 직접 전송 및 미리보기 API
- `api/telegram-digest-cron-*.js`: 시간대별 예약 실행 API
- `api/monthly-report.js`: 관리자 인증 및 GPT 월말보고서 정리 API
- `lib/telegram-digest.js`: 브리핑 구성 및 텔레그램 전송 공통 로직
- `lib/monthly-report-core.js`: 월말보고서 데이터 수집·중복 제거·검증
- `lib/monthly-report-docx.js`: 월말보고서 Word 파일 생성
- `templates/monthly-report-template.docx`: 월말보고서 Word 원본 양식 사본
- `vercel.json`: Vercel 배포 설정
- `.env.local.example`: 환경변수 예시
- `supabase/schema.sql`: Supabase 테이블, 트리거, RLS 설정

## 주의사항

- `.env.local`은 GitHub에 올리면 안 됩니다.
- Supabase Service Role Key(서비스 역할 키)는 프론트엔드에 넣지 마세요.
- 실제 운영 전에는 Supabase Authentication(인증)의 Email confirmation(이메일 확인) 설정을 운영 방식에 맞게 확인하세요.


## PWA 설치

Vercel 배포 후 모바일 브라우저에서 앱처럼 설치할 수 있습니다.

### iPhone

1. Safari에서 배포 주소를 엽니다.
2. 공유 버튼을 누릅니다.
3. `홈 화면에 추가`를 선택합니다.

### Android

1. Chrome에서 배포 주소를 엽니다.
2. 메뉴를 누릅니다.
3. `앱 설치` 또는 `홈 화면에 추가`를 선택합니다.

주의: 로그인과 Supabase 데이터 저장은 온라인 연결이 필요합니다. 기본 화면 파일은 캐시되지만, 실시간 데이터는 Supabase 연결 상태에 따라 동작합니다.
