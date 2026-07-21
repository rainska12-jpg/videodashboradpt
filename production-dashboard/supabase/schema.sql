-- Supabase SQL Editor에 그대로 붙여넣어 실행하세요.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  position text default '과원',
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'inactive')),
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.dashboard_state (
  id text primary key default 'main',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  entity_type text not null check (entity_type in ('project', 'work')),
  entity_id text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_type, entity_id)
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, position, role, status, approved)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    coalesce(new.raw_user_meta_data->>'position', '과원'),
    'user',
    'pending',
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_approved_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and approved = true
      and status = 'approved'
  );
$$;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and approved = true
      and status = 'approved'
      and role = 'admin'
  );
$$;

alter table public.profiles enable row level security;
alter table public.dashboard_state enable row level security;
alter table public.share_links enable row level security;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles for select
using (id = auth.uid() or public.is_admin_user());

drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin"
on public.profiles for update
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "profiles_delete_admin" on public.profiles;
create policy "profiles_delete_admin"
on public.profiles for delete
using (public.is_admin_user());

drop policy if exists "dashboard_select_approved" on public.dashboard_state;
create policy "dashboard_select_approved"
on public.dashboard_state for select
using (public.is_approved_user());

drop policy if exists "dashboard_insert_approved" on public.dashboard_state;
create policy "dashboard_insert_approved"
on public.dashboard_state for insert
with check (public.is_approved_user());

drop policy if exists "dashboard_update_approved" on public.dashboard_state;
create policy "dashboard_update_approved"
on public.dashboard_state for update
using (public.is_approved_user())
with check (public.is_approved_user());

drop policy if exists "dashboard_delete_admin" on public.dashboard_state;
create policy "dashboard_delete_admin"
on public.dashboard_state for delete
using (public.is_admin_user());

-- 공유 링크는 테이블을 직접 공개하지 않고 아래 보안 함수를 통해서만 사용합니다.
revoke all on public.share_links from anon, authenticated;

create or replace function public.create_share_link(p_entity_type text, p_entity_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid;
  v_exists boolean;
  v_collection text;
begin
  if not public.is_approved_user() then
    raise exception 'approved user required';
  end if;

  if p_entity_type not in ('project', 'work') or coalesce(trim(p_entity_id), '') = '' then
    raise exception 'invalid share target';
  end if;

  v_collection := case when p_entity_type = 'project' then 'projects' else 'works' end;
  select exists (
    select 1
    from public.dashboard_state state_row,
      jsonb_array_elements(coalesce(state_row.data -> v_collection, '[]'::jsonb)) entity
    where state_row.id = 'main'
      and entity ->> 'id' = p_entity_id
  ) into v_exists;

  if not v_exists then
    raise exception 'share target not found';
  end if;

  insert into public.share_links (entity_type, entity_id, created_by, active)
  values (p_entity_type, p_entity_id, auth.uid(), true)
  on conflict (entity_type, entity_id)
  do update set active = true, updated_at = now()
  returning token into v_token;

  return v_token;
end;
$$;

create or replace function public.get_shared_item(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link public.share_links%rowtype;
  v_state jsonb;
  v_entity jsonb;
  v_owners jsonb;
  v_tasks jsonb;
  v_collection text;
begin
  select * into v_link
  from public.share_links
  where token = p_token and active = true;

  if not found then
    return null;
  end if;

  select data into v_state
  from public.dashboard_state
  where id = 'main';

  v_collection := case when v_link.entity_type = 'project' then 'projects' else 'works' end;
  select entity into v_entity
  from jsonb_array_elements(coalesce(v_state -> v_collection, '[]'::jsonb)) entity
  where entity ->> 'id' = v_link.entity_id
  limit 1;

  if v_entity is null then
    return null;
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', owner ->> 'id',
      'name', owner ->> 'name',
      'status', coalesce(owner ->> 'status', 'active')
    )),
    '[]'::jsonb
  ) into v_owners
  from jsonb_array_elements(coalesce(v_state -> 'owners', '[]'::jsonb)) owner
  where coalesce(owner ->> 'status', 'active') <> 'deleted';

  if v_link.entity_type = 'project' then
    select coalesce(jsonb_agg(task), '[]'::jsonb) into v_tasks
    from jsonb_array_elements(coalesce(v_state -> 'tasks', '[]'::jsonb)) task
    where task ->> 'projectId' = v_link.entity_id;
  else
    v_tasks := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'entityType', v_link.entity_type,
    'entityId', v_link.entity_id,
    'entity', v_entity,
    'options', coalesce(v_state -> 'options', '{}'::jsonb),
    'optionColors', coalesce(v_state -> 'optionColors', '{}'::jsonb),
    'owners', v_owners,
    'tasks', v_tasks,
    'sharedAt', v_link.updated_at
  );
end;
$$;

revoke all on function public.create_share_link(text, text) from public;
revoke all on function public.get_shared_item(uuid) from public;
grant execute on function public.create_share_link(text, text) to authenticated;
grant execute on function public.get_shared_item(uuid) to anon, authenticated;

-- 초기 관리자 생성 순서
-- 1) Supabase Dashboard > Authentication > Users에서 관리자 이메일 계정을 직접 생성합니다.
-- 2) 아래 이메일을 실제 관리자 이메일로 바꾼 뒤 실행합니다.
-- update public.profiles
-- set role = 'admin', status = 'approved', approved = true, position = '관리자', name = '관리자'
-- where email = '관리자이메일@example.com';
