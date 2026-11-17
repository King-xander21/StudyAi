-- ============ PLAN GATING: usage counters ============
-- Run once in the Supabase SQL Editor.

create table if not exists usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default current_date,
  kind text not null,               -- 'chat' | 'generate' | 'ingest'
  count int not null default 0,
  primary key (user_id, day, kind)
);

alter table usage_daily enable row level security;
drop policy if exists "own usage read" on usage_daily;
create policy "own usage read" on usage_daily
  for select to authenticated using (auth.uid() = user_id);
-- (writes happen only through the SECURITY DEFINER function below / service role)

-- Atomically increment today's counter for (user, kind) and report whether
-- the new count is still within the given limit. Returns TRUE if allowed.
create or replace function bump_usage(p_user uuid, p_kind text, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare cur int;
begin
  insert into usage_daily (user_id, day, kind, count)
  values (p_user, current_date, p_kind, 1)
  on conflict (user_id, day, kind)
  do update set count = usage_daily.count + 1
  returning count into cur;
  return cur <= p_limit;
end;
$$;
