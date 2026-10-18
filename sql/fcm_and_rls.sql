-- ================================================================
-- WhatsApp-style PWA - Final Supabase fix for FCM + Realtime + RLS
-- ================================================================

-- 1) Ensure required extensions
create extension if not exists pgcrypto;

-- 2) FCM tokens table
create table if not exists public.fcm_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid null,
  token text not null unique,
  platform text not null default 'web',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fcm_tokens_user_id_idx on public.fcm_tokens(user_id);

-- يدعم upsert المستخدم في الواجهة مع الحفاظ على token كمعرّف فريد للجهاز.
create unique index if not exists fcm_tokens_user_token_key
  on public.fcm_tokens(user_id, token);

-- 3) Typing status table
create table if not exists public.typing_status (
  conversation_id uuid not null,
  user_id uuid not null,
  is_typing boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists typing_status_conversation_idx on public.typing_status(conversation_id);

-- 4) Support table for conversations/messages if missing
-- These are expected by the app, but if they already exist they are left alone.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  admin_id uuid not null,
  last_message text,
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  sender_id uuid not null,
  content text,
  attachment_url text,
  attachment_type text,
  reply_to_id uuid,
  status text not null default 'sent',
  created_at timestamptz not null default now()
);

-- Optional if not already created
create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null,
  user_id uuid not null,
  emoji text not null,
  created_at timestamptz not null default now()
);

-- أعضاء كل محادثة وصلاحياتهم. لا تعتمد الواجهة على profiles.is_admin وحده.
create table if not exists public.chat_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'moderator', 'member')),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists chat_members_user_id_idx on public.chat_members(user_id);
create index if not exists chat_members_role_idx on public.chat_members(conversation_id, role);

-- ترحيل المحادثات القديمة إلى نموذج العضوية الجديد دون استبدال أدوار مخصصة.
insert into public.chat_members (conversation_id, user_id, role)
select c.id, c.user_id, 'member'
from public.conversations c
on conflict (conversation_id, user_id) do nothing;

insert into public.chat_members (conversation_id, user_id, role)
select c.id, c.admin_id, 'admin'
from public.conversations c
on conflict (conversation_id, user_id) do nothing;

update public.chat_members cm
set role = 'admin'
from public.conversations c
where cm.conversation_id = c.id
  and cm.user_id = c.admin_id
  and cm.role = 'member';

create or replace function public.sync_conversation_members()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.chat_members (conversation_id, user_id, role)
  values
    (new.id, new.user_id, 'member'),
    (new.id, new.admin_id, 'admin')
  on conflict (conversation_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_sync_conversation_members on public.conversations;
create trigger trg_sync_conversation_members
after insert on public.conversations
for each row execute function public.sync_conversation_members();

-- 5) Helpful trigger to update `updated_at`
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_fcm_tokens_updated on public.fcm_tokens;
create trigger trg_fcm_tokens_updated
before update on public.fcm_tokens
for each row execute function public.set_updated_at();

drop trigger if exists trg_typing_status_updated on public.typing_status;
create trigger trg_typing_status_updated
before update on public.typing_status
for each row execute function public.set_updated_at();

-- 6) Enable RLS
alter table public.fcm_tokens enable row level security;
alter table public.typing_status enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.chat_members enable row level security;

-- 7) RLS Policies for fcm_tokens
-- Users can manage only their own token row
drop policy if exists "Users can read own fcm token" on public.fcm_tokens;
create policy "Users can read own fcm token"
  on public.fcm_tokens
  for select
  using (auth.uid() = user_id or user_id is null);

drop policy if exists "Users can upsert own fcm token" on public.fcm_tokens;
create policy "Users can upsert own fcm token"
  on public.fcm_tokens
  for insert
  with check (auth.uid() = user_id or user_id is null);

drop policy if exists "Users can update own fcm token" on public.fcm_tokens;
create policy "Users can update own fcm token"
  on public.fcm_tokens
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own fcm token" on public.fcm_tokens;
create policy "Users can delete own fcm token"
  on public.fcm_tokens
  for delete
  using (auth.uid() = user_id);

-- تبديل ملكية رمز الجهاز بين حسابين لا يمكن تنفيذه بأمان عبر RLS وحدها،
-- لذلك توفر هذه الدالة عملية ذرية تتحقق من المستخدم الحالي ثم تحذف الملكية
-- القديمة وتنفذ upsert للمستخدم الجديد. لا تكشف أي بيانات لمالك الرمز السابق.
create or replace function public.claim_fcm_token(
  p_user_id uuid,
  p_token text,
  p_platform text default 'web'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'Only the authenticated user can claim their own FCM token';
  end if;

  delete from public.fcm_tokens
  where token = p_token
    and user_id is distinct from p_user_id;

  insert into public.fcm_tokens (user_id, token, platform, updated_at)
  values (p_user_id, p_token, coalesce(nullif(p_platform, ''), 'web'), now())
  on conflict (user_id, token) do update
    set platform = excluded.platform,
        updated_at = now();
end;
$$;

revoke all on function public.claim_fcm_token(uuid, text, text) from public;
grant execute on function public.claim_fcm_token(uuid, text, text) to authenticated;

-- 8) RLS Policies for typing_status
drop policy if exists "Users can read typing status in conversation they belong to" on public.typing_status;
drop policy if exists "Users can upsert their own typing status" on public.typing_status;
drop policy if exists "Users can update their own typing status" on public.typing_status;
drop policy if exists "Users can delete their own typing status" on public.typing_status;

drop policy if exists "Users can read typing status in conversation they belong to" on public.typing_status;
create policy "Users can read typing status in conversation they belong to"
  on public.typing_status
  for select
  using (
    exists (
      select 1 from public.conversations c
      where c.id = typing_status.conversation_id
        and (
          c.user_id = auth.uid() or c.admin_id = auth.uid()
        )
    )
  );

drop policy if exists "Users can upsert their own typing status" on public.typing_status;
create policy "Users can upsert their own typing status"
  on public.typing_status
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = typing_status.conversation_id
        and (c.user_id = auth.uid() or c.admin_id = auth.uid())
    )
  );

drop policy if exists "Users can update their own typing status" on public.typing_status;
create policy "Users can update their own typing status"
  on public.typing_status
  for update
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = typing_status.conversation_id
        and (c.user_id = auth.uid() or c.admin_id = auth.uid())
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = typing_status.conversation_id
        and (c.user_id = auth.uid() or c.admin_id = auth.uid())
    )
  );

drop policy if exists "Users can delete their own typing status" on public.typing_status;
create policy "Users can delete their own typing status"
  on public.typing_status
  for delete
  using (auth.uid() = user_id);

-- 9) RLS Policies for conversations
 drop policy if exists "Users can read their conversations" on public.conversations;
create policy "Users can read their conversations"
  on public.conversations
  for select
  using (exists (
    select 1 from public.chat_members cm
    where cm.conversation_id = conversations.id
      and cm.user_id = auth.uid()
  ));

drop policy if exists "Users can insert own conversation row" on public.conversations;
create policy "Users can insert own conversation row"
  on public.conversations
  for insert
  with check (auth.uid() = user_id or auth.uid() = admin_id);

drop policy if exists "Users can update their own conversation" on public.conversations;
create policy "Users can update their own conversation"
  on public.conversations
  for update
  using (exists (
    select 1 from public.chat_members cm
    where cm.conversation_id = conversations.id
      and cm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.chat_members cm
    where cm.conversation_id = conversations.id
      and cm.user_id = auth.uid()
  ));

-- 10) RLS Policies for chat_members
drop policy if exists "Members can read their own chat membership" on public.chat_members;
create policy "Members can read their own chat membership"
  on public.chat_members
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own chat membership" on public.chat_members;
create policy "Users can insert their own chat membership"
  on public.chat_members
  for insert
  with check (auth.uid() = user_id);

-- 11) RLS Policies for messages
 drop policy if exists "Users can read messages from their conversations" on public.messages;
create policy "Users can read messages from their conversations"
  on public.messages
  for select
  using (exists (
    select 1 from public.chat_members cm
    where cm.conversation_id = messages.conversation_id
      and cm.user_id = auth.uid()
  ));

drop policy if exists "Users can insert messages in their conversations" on public.messages;
create policy "Users can insert messages in their conversations"
  on public.messages
  for insert
  with check (
    auth.uid() = sender_id and exists (
      select 1 from public.chat_members cm
      where cm.conversation_id = messages.conversation_id
        and cm.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update message status in their conversations" on public.messages;
create policy "Users can update message status in their conversations"
  on public.messages
  for update
  using (exists (
    select 1 from public.chat_members cm
    where cm.conversation_id = messages.conversation_id
      and cm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.chat_members cm
    where cm.conversation_id = messages.conversation_id
      and cm.user_id = auth.uid()
  ));

-- 12) Reaction policy
drop policy if exists "Users can read reactions for their conversations" on public.message_reactions;
create policy "Users can read reactions for their conversations"
  on public.message_reactions
  for select
  using (
    exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_reactions.message_id
        and (c.user_id = auth.uid() or c.admin_id = auth.uid())
    )
  );

drop policy if exists "Users can insert reactions to their own messages or conversation messages" on public.message_reactions;
create policy "Users can insert reactions to their own messages or conversation messages"
  on public.message_reactions
  for insert
  with check (
    auth.uid() = user_id and exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_reactions.message_id
        and (c.user_id = auth.uid() or c.admin_id = auth.uid())
    )
  );

-- 13) Optional helper for admin visibility if needed
-- If you want a superadmin to see all rows universally, add this policy manually.
-- Example:
-- create policy "Superadmins can see all typing statuses" on public.typing_status for all using (
--   exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin = true)
-- );

-- ================================================================
-- End of SQL
-- ================================================================


-- 14) Moderator/admin destructive operations.
create or replace function public.is_chat_moderator(
  p_conversation_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id = auth.uid()
    and exists (
      select 1
      from public.chat_members cm
      where cm.conversation_id = p_conversation_id
        and cm.user_id = p_user_id
        and cm.role in ('admin', 'moderator')
    );
$$;

create or replace function public.delete_message_as_moderator(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation_id uuid;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where id = p_message_id;

  if v_conversation_id is null or not public.is_chat_moderator(v_conversation_id) then
    raise exception 'Only conversation admins or moderators can delete messages';
  end if;

  delete from public.messages where id = p_message_id;
end;
$$;

create or replace function public.remove_chat_member(
  p_conversation_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_chat_moderator(p_conversation_id) then
    raise exception 'Only conversation admins or moderators can remove members';
  end if;

  if exists (
    select 1 from public.chat_members
    where conversation_id = p_conversation_id
      and user_id = p_user_id
      and role in ('admin', 'moderator')
  ) then
    raise exception 'Admins and moderators cannot be removed by this action';
  end if;

  delete from public.chat_members
  where conversation_id = p_conversation_id
    and user_id = p_user_id;
end;
$$;

revoke all on function public.is_chat_moderator(uuid, uuid) from public;
revoke all on function public.delete_message_as_moderator(uuid) from public;
revoke all on function public.remove_chat_member(uuid, uuid) from public;
grant execute on function public.is_chat_moderator(uuid, uuid) to authenticated;
grant execute on function public.delete_message_as_moderator(uuid) to authenticated;
grant execute on function public.remove_chat_member(uuid, uuid) to authenticated;

-- يبقى الحذف محمياً أيضاً مباشرةً عبر RLS حتى لا يمكن تجاوزه من العميل.
drop policy if exists "Admins can delete messages" on public.messages;
drop policy if exists "Chat moderators can delete messages" on public.messages;
create policy "Chat moderators can delete messages"
  on public.messages for delete
  using (public.is_chat_moderator(messages.conversation_id));

drop policy if exists "Admins can delete ordinary-user conversations" on public.conversations;
drop policy if exists "Admins can delete ordinary-user conversations" on public.conversations;
create policy "Admins can delete ordinary-user conversations"
  on public.conversations for delete
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
    and exists (select 1 from public.profiles u where u.id = conversations.user_id and coalesce(u.is_admin, false) = false)
  );
