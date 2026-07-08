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

-- 초기 관리자 생성 순서
-- 1) Supabase Dashboard > Authentication > Users에서 관리자 이메일 계정을 직접 생성합니다.
-- 2) 아래 이메일을 실제 관리자 이메일로 바꾼 뒤 실행합니다.
-- update public.profiles
-- set role = 'admin', status = 'approved', approved = true, position = '관리자', name = '관리자'
-- where email = '관리자이메일@example.com';
