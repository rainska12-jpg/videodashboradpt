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

## 3. 환경변수 등록

로컬 테스트용 파일은 `.env.local.example`을 복사해서 만듭니다.

```bash
cp .env.local.example .env.local
```

Supabase 프로젝트의 Project Settings(프로젝트 설정) > API에서 값을 확인해 입력합니다.

```bash
SUPABASE_URL=Supabase Project URL
SUPABASE_ANON_KEY=Supabase anon public key
```

Vercel에도 같은 값을 등록해야 합니다.

1. Vercel 프로젝트로 이동합니다.
2. Settings(설정) > Environment Variables(환경변수)를 엽니다.
3. 아래 2개를 추가합니다.
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
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

## 파일 설명

- `index.html`: 화면 구조
- `app.js`: 대시보드 기능
- `styles.css`: 디자인
- `api/env.js`: Vercel 환경변수를 브라우저에 전달
- `vercel.json`: Vercel 배포 설정
- `.env.local.example`: 환경변수 예시
- `supabase/schema.sql`: Supabase 테이블, 트리거, RLS 설정

## 주의사항

- `.env.local`은 GitHub에 올리면 안 됩니다.
- Supabase Service Role Key(서비스 역할 키)는 프론트엔드에 넣지 마세요.
- 실제 운영 전에는 Supabase Authentication(인증)의 Email confirmation(이메일 확인) 설정을 운영 방식에 맞게 확인하세요.
