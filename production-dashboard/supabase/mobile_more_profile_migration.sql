-- 모바일 더보기: 프로필 사진, 연락처, 조직도에 필요한 최소 변경
-- 운영 DB에는 자동 실행하지 않습니다. Supabase SQL Editor에서 검토 후 실행하세요.

alter table public.profiles
  add column if not exists department text,
  add column if not exists phone text,
  add column if not exists avatar_path text,
  add column if not exists organization_visible boolean not null default true,
  add column if not exists sort_order integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();

-- 일반 사용자는 역할·승인 상태를 직접 바꾸지 못하고 연락처와 본인 사진 경로만 수정합니다.
create or replace function public.update_my_profile(
  p_phone text default null,
  p_avatar_path text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  next_avatar_path text;
begin
  if not public.is_approved_user() then
    raise exception 'permission denied';
  end if;

  next_avatar_path := nullif(trim(coalesce(p_avatar_path, '')), '');
  if next_avatar_path is not null
     and split_part(next_avatar_path, '/', 1) <> auth.uid()::text then
    raise exception 'invalid avatar path';
  end if;

  update public.profiles
  set phone = nullif(left(trim(coalesce(p_phone, '')), 60), ''),
      avatar_path = next_avatar_path,
      updated_at = now()
  where id = auth.uid();
end;
$$;

revoke all on function public.update_my_profile(text, text) from public;
grant execute on function public.update_my_profile(text, text) to authenticated;

-- 승인된 사용자가 볼 수 있는 조직도 공개 필드만 반환합니다.
create or replace function public.get_organization_directory()
returns table (
  id uuid,
  name text,
  position text,
  department text,
  role text,
  status text,
  approved boolean,
  avatar_path text,
  organization_visible boolean,
  sort_order integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_approved_user() then
    raise exception 'permission denied';
  end if;

  return query
  select p.id, p.name, p.position, p.department, p.role, p.status, p.approved,
         p.avatar_path, p.organization_visible, p.sort_order, p.created_at
  from public.profiles p
  where p.approved = true
    and p.status = 'approved'
    and p.organization_visible = true
  order by p.sort_order asc, p.name asc;
end;
$$;

revoke all on function public.get_organization_directory() from public;
grant execute on function public.get_organization_directory() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-images',
  'profile-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "profile_images_select_approved" on storage.objects;
create policy "profile_images_select_approved"
on storage.objects for select
to authenticated
using (bucket_id = 'profile-images' and public.is_approved_user());

drop policy if exists "profile_images_insert_own" on storage.objects;
create policy "profile_images_insert_own"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'profile-images'
  and public.is_approved_user()
  and split_part(name, '/', 1) = auth.uid()::text
  and lower(coalesce(metadata->>'mimetype', '')) in ('image/jpeg', 'image/png', 'image/webp')
);

drop policy if exists "profile_images_delete_own_or_admin" on storage.objects;
create policy "profile_images_delete_own_or_admin"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'profile-images'
  and (split_part(name, '/', 1) = auth.uid()::text or public.is_admin_user())
);

-- Rollback (필요할 때만 수동 실행)
-- drop policy if exists "profile_images_select_approved" on storage.objects;
-- drop policy if exists "profile_images_insert_own" on storage.objects;
-- drop policy if exists "profile_images_delete_own_or_admin" on storage.objects;
-- delete from storage.buckets where id = 'profile-images';
-- drop function if exists public.get_organization_directory();
-- drop function if exists public.update_my_profile(text, text);
-- alter table public.profiles
--   drop column if exists updated_at,
--   drop column if exists sort_order,
--   drop column if exists organization_visible,
--   drop column if exists avatar_path,
--   drop column if exists phone,
--   drop column if exists department;
