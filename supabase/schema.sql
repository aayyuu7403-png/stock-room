-- Stock Room — Supabase setup.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.

-- 1. Products table -----------------------------------------------------------
create table if not exists public.products (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  sku         text not null default '',
  category    text not null default 'uncategorized',
  quantity    integer not null default 0 check (quantity >= 0),
  cost        numeric(12,2) not null default 0 check (cost >= 0),
  price       numeric(12,2) not null default 0 check (price >= 0),
  low         integer not null default 5 check (low >= 0),
  notes       text not null default '',
  image_path  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists products_user_idx on public.products (user_id);

-- 2. Row-level security: every user sees and edits only their own products ----
alter table public.products enable row level security;

drop policy if exists "products: own rows" on public.products;
create policy "products: own rows" on public.products
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 3. Live updates across devices ----------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.products;
exception when duplicate_object then null; end $$;

-- 4. Private photo bucket (files stored under <user id>/...) -------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg','image/png','image/webp','image/gif','image/heic'])
on conflict (id) do nothing;

drop policy if exists "photos: read own"   on storage.objects;
drop policy if exists "photos: insert own" on storage.objects;
drop policy if exists "photos: update own" on storage.objects;
drop policy if exists "photos: delete own" on storage.objects;

create policy "photos: read own" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: update own" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
