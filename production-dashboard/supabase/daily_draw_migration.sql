-- 오늘의 제비뽑기: 조직 범위, 1일 1회 결과, 216개 문구, RLS, 보안 RPC
-- Supabase SQL Editor에서 한 번 실행하세요.
create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

insert into public.organizations (id, name)
values ('00000000-0000-4000-8000-000000000001', '기본 조직')
on conflict (id) do nothing;

alter table public.profiles
  add column if not exists organization_id uuid references public.organizations(id);

update public.profiles
set organization_id = '00000000-0000-4000-8000-000000000001'
where organization_id is null;

alter table public.profiles
  alter column organization_id set default '00000000-0000-4000-8000-000000000001',
  alter column organization_id set not null;

create table if not exists public.draw_messages (
  id text primary key,
  min_score smallint not null check (min_score between 1 and 100),
  max_score smallint not null check (max_score between 1 and 100 and max_score >= min_score),
  message text not null unique,
  category text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_draw_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  draw_date date not null,
  draw_score smallint not null check (draw_score between 1 and 100),
  draw_message_id text not null references public.draw_messages(id),
  draw_message text not null,
  created_at timestamptz not null default now(),
  unique (user_id, draw_date)
);

create index if not exists daily_draw_results_org_date_score_idx
  on public.daily_draw_results (organization_id, draw_date, draw_score desc);
create index if not exists daily_draw_results_user_recent_idx
  on public.daily_draw_results (user_id, draw_date desc);

-- 9개 점수 구간 × 24개 주제 = 216개 문구.
-- 문구는 UI가 아닌 DB 데이터로 관리하며 각 결과에 ID와 실제 문장을 함께 보존합니다.
with score_bands(band_id, min_score, max_score, opening) as (
  values
    ('90', 90, 100, '오늘은 좋은 흐름이 또렷합니다.'),
    ('80', 80, 89,  '기분 좋은 탄력이 붙는 날입니다.'),
    ('70', 70, 79,  '차분히 밀고 가면 성과가 보입니다.'),
    ('60', 60, 69,  '기본에 충실할수록 흐름이 좋아집니다.'),
    ('50', 50, 59,  '서두르지 않으면 충분히 괜찮은 날입니다.'),
    ('40', 40, 49,  '한 번 더 확인하는 여유가 도움이 됩니다.'),
    ('30', 30, 39,  '우선순위를 작게 나누면 부담이 줄어듭니다.'),
    ('20', 20, 29,  '속도를 조금 낮추고 안전하게 가보세요.'),
    ('01', 1, 19,   '오늘은 조심성이 가장 든든한 기술입니다.')
),
themes(theme_id, category, line) as (
  values
    ('01', '업무 진행', '가장 선명한 업무부터 끝내면 다음 선택도 쉬워집니다.'),
    ('02', '일정', '일정표의 빈칸 하나가 예상 밖의 여유를 만들어 줄 수 있습니다.'),
    ('03', '마감', '마감보다 한 박자 먼저 움직인 사람이 저녁을 편하게 맞습니다.'),
    ('04', '회의', '회의 목적을 한 문장으로 적어두면 끝나는 시간도 가까워집니다.'),
    ('05', '촬영', '촬영 전 배터리와 메모리 확인이 오늘의 작은 영웅입니다.'),
    ('06', '편집', '첫 편집점이 막히면 과감히 다음 컷부터 붙여보세요.'),
    ('07', '렌더링', '렌더링 버튼을 누르기 전 출력 범위를 살피면 마음이 평안합니다.'),
    ('08', '파일 저장', '저장 단축키를 자주 누른 손끝에 작은 행운이 머뭅니다.'),
    ('09', '백업', '백업 한 벌이 미래의 나에게 보내는 가장 실용적인 선물입니다.'),
    ('10', '수정사항', '수정사항은 받은 순서보다 영향이 큰 순서로 보면 빠르게 정리됩니다.'),
    ('11', '커뮤니케이션', '애매한 요청은 짧게 되묻는 순간 명확한 업무로 바뀝니다.'),
    ('12', '협업', '동료에게 진행 상황 한 줄을 먼저 건네면 협업의 속도가 맞아갑니다.'),
    ('13', '집중력', '알림을 잠시 닫고 25분만 몰입하면 생각보다 멀리 갑니다.'),
    ('14', '점심', '점심 메뉴를 빨리 정하면 뜻밖의 집중 시간을 확보할 수 있습니다.'),
    ('15', '커피', '두 번째 커피보다 물 한 잔이 편집 타임라인을 더 오래 지켜줄지 모릅니다.'),
    ('16', '작은 행운', '찾던 파일은 검색어를 짧게 바꾸는 순간 나타날 가능성이 있습니다.'),
    ('17', '사명', '맡은 일의 의미를 떠올리면 사소한 한 컷에도 방향이 생깁니다.'),
    ('18', '은혜갚자', '받은 도움을 짧은 감사로 돌려주면 팀의 분위기가 한결 따뜻해집니다.'),
    ('19', '촬영', '현장 도착 전 콜시트를 다시 본 사람이 결국 가장 여유롭게 웃습니다.'),
    ('20', '편집', '파일명에 진짜최종을 붙이기 전에 버전 번호부터 올려보세요.'),
    ('21', '커뮤니케이션', '간단한 수정이라는 말은 범위를 확인한 뒤 믿어도 늦지 않습니다.'),
    ('22', '협업', '혼자 붙들던 문제를 화면 공유하면 답이 의외로 가까이 있습니다.'),
    ('23', '집중력', '작은 완료 표시 하나가 다음 업무를 움직이는 힘이 됩니다.'),
    ('24', '사명', '오늘 맡은 몫을 성실히 채우는 시간이 은혜를 기억하게 합니다.')
)
insert into public.draw_messages (id, min_score, max_score, message, category, is_active)
select
  'draw-' || band_id || '-' || theme_id,
  min_score,
  max_score,
  opening || ' ' || line,
  category,
  true
from score_bands
cross join themes
on conflict (id) do update
set min_score = excluded.min_score,
    max_score = excluded.max_score,
    message = excluded.message,
    category = excluded.category,
    is_active = true;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, email, name, position, role, status, approved, organization_id
  )
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    coalesce(new.raw_user_meta_data->>'position', '과원'),
    'user',
    'pending',
    false,
    '00000000-0000-4000-8000-000000000001'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.profiles
  where id = auth.uid()
    and approved = true
    and status = 'approved';
$$;

alter table public.organizations enable row level security;
alter table public.draw_messages enable row level security;
alter table public.daily_draw_results enable row level security;

drop policy if exists "organizations_select_own" on public.organizations;
create policy "organizations_select_own"
on public.organizations for select
using (id = public.current_organization_id());

drop policy if exists "draw_results_select_same_org" on public.daily_draw_results;
create policy "draw_results_select_same_org"
on public.daily_draw_results for select
using (
  public.is_approved_user()
  and organization_id = public.current_organization_id()
);

-- INSERT 정책은 소유자·한국 날짜를 검증하지만, 테이블 INSERT 권한은 회수합니다.
-- 실제 생성은 점수와 문구를 서버에서 결정하는 draw_today()만 수행합니다.
drop policy if exists "draw_results_insert_own_today" on public.daily_draw_results;
create policy "draw_results_insert_own_today"
on public.daily_draw_results for insert
with check (
  public.is_approved_user()
  and user_id = auth.uid()
  and organization_id = public.current_organization_id()
  and draw_date = (timezone('Asia/Seoul', now()))::date
);

revoke all on public.draw_messages from anon, authenticated;
revoke insert, update, delete on public.daily_draw_results from anon, authenticated;
grant select on public.daily_draw_results to authenticated;
grant select on public.organizations to authenticated;

create or replace function public.get_today_draw_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_today date := (timezone('Asia/Seoul', now()))::date;
  v_result jsonb;
  v_ranking jsonb;
  v_members jsonb;
begin
  if v_user_id is null or not public.is_approved_user() then
    raise exception 'approved user required';
  end if;

  v_org_id := public.current_organization_id();
  if v_org_id is null then
    raise exception 'organization required';
  end if;

  select jsonb_build_object(
    'id', result.id,
    'drawDate', result.draw_date,
    'drawScore', result.draw_score,
    'drawMessageId', result.draw_message_id,
    'drawMessage', result.draw_message,
    'createdAt', result.created_at
  )
  into v_result
  from public.daily_draw_results result
  where result.user_id = v_user_id
    and result.draw_date = v_today;

  with ranked as (
    select
      result.user_id,
      profile.name,
      result.draw_score,
      rank() over (order by result.draw_score desc) as competition_rank
    from public.daily_draw_results result
    join public.profiles profile on profile.id = result.user_id
    where result.organization_id = v_org_id
      and result.draw_date = v_today
      and profile.approved = true
      and profile.status = 'approved'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', ranked.user_id,
    'name', coalesce(ranked.name, '구성원'),
    'drawScore', ranked.draw_score,
    'rank', ranked.competition_rank,
    'isMe', ranked.user_id = v_user_id
  ) order by ranked.draw_score desc, ranked.name), '[]'::jsonb)
  into v_ranking
  from ranked;

  with member_rows as (
    select
      profile.id as user_id,
      coalesce(profile.name, profile.email, '구성원') as name,
      result.draw_score,
      case when result.draw_score is null then null
        else rank() over (
          partition by (result.draw_score is null)
          order by result.draw_score desc
        )
      end as competition_rank
    from public.profiles profile
    left join public.daily_draw_results result
      on result.user_id = profile.id
      and result.draw_date = v_today
      and result.organization_id = v_org_id
    where profile.organization_id = v_org_id
      and profile.approved = true
      and profile.status = 'approved'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', member_rows.user_id,
    'name', member_rows.name,
    'drawScore', member_rows.draw_score,
    'rank', member_rows.competition_rank,
    'isMe', member_rows.user_id = v_user_id
  ) order by member_rows.draw_score desc nulls last, member_rows.name), '[]'::jsonb)
  into v_members
  from member_rows;

  return jsonb_build_object(
    'drawDate', v_today,
    'result', v_result,
    'ranking', v_ranking,
    'members', v_members
  );
end;
$$;

-- 이전 버전의 기본 인수 함수가 PostgREST에서 no-arg 호출과 충돌하지 않게 제거합니다.
drop function if exists public.draw_today(date);
drop function if exists public.draw_today();

create function public.draw_today()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_today date := (timezone('Asia/Seoul', now()))::date;
  v_score smallint;
  v_message public.draw_messages%rowtype;
begin
  if v_user_id is null or not public.is_approved_user() then
    raise exception 'approved user required';
  end if;
  v_org_id := public.current_organization_id();
  if v_org_id is null then
    raise exception 'organization required';
  end if;

  -- 동일 사용자·동일 날짜 요청을 직렬화합니다.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || v_today::text, 0));

  if not exists (
    select 1 from public.daily_draw_results
    where user_id = v_user_id and draw_date = v_today
  ) then
    v_score := (get_byte(gen_random_bytes(1), 0) % 100 + 1)::smallint;

    select message_row.*
    into v_message
    from public.draw_messages message_row
    where message_row.is_active = true
      and v_score between message_row.min_score and message_row.max_score
      and not exists (
        select 1
        from public.daily_draw_results recent
        where recent.user_id = v_user_id
          and recent.draw_date >= v_today - 14
          and recent.draw_message_id = message_row.id
      )
    order by random()
    limit 1;

    -- 후보를 모두 사용한 경우 가장 오래 전에 받은 문구부터 재사용합니다.
    if v_message.id is null then
      select message_row.*
      into v_message
      from public.draw_messages message_row
      left join public.daily_draw_results history
        on history.user_id = v_user_id
        and history.draw_message_id = message_row.id
      where message_row.is_active = true
        and v_score between message_row.min_score and message_row.max_score
      group by message_row.id
      order by max(history.draw_date) asc nulls first, random()
      limit 1;
    end if;

    if v_message.id is null then
      raise exception 'active draw message not found';
    end if;

    insert into public.daily_draw_results (
      organization_id, user_id, draw_date, draw_score, draw_message_id, draw_message
    )
    values (
      v_org_id, v_user_id, v_today, v_score, v_message.id, v_message.message
    )
    on conflict (user_id, draw_date) do nothing;
  end if;

  return public.get_today_draw_dashboard();
end;
$$;

revoke all on function public.current_organization_id() from public;
revoke all on function public.get_today_draw_dashboard() from public;
revoke all on function public.draw_today() from public;
grant execute on function public.current_organization_id() to authenticated;
grant execute on function public.get_today_draw_dashboard() to authenticated;
grant execute on function public.draw_today() to authenticated;

comment on table public.daily_draw_results is
  '사용자별 한국 날짜 기준 1일 1회 제비뽑기 결과. UPDATE/DELETE 경로를 제공하지 않는다.';

-- 새 RPC 시그니처를 Supabase REST API가 즉시 다시 읽게 합니다.
notify pgrst, 'reload schema';
