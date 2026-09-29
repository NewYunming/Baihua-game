-- 白桦大冒险 Supabase schema。
-- 所有表开启 RLS 且零策略：anon/authenticated 一律拒绝，只有 Edge Function 持有的
-- service_role 能读写，函数因此是唯一访问入口（密码哈希、会话令牌不外泄）。

create table if not exists public.users (
  id uuid primary key,
  username text not null unique,
  password_hash text not null,
  password_salt text not null,
  created_at bigint not null,
  last_seen bigint not null
);

create table if not exists public.sessions (
  token_hash text primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  expires_at bigint not null
);

create table if not exists public.login_attempts (
  key text primary key,
  failures bigint not null,
  window_start bigint not null
);

create table if not exists public.scores (
  id uuid primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  mode text not null,
  wave bigint not null,
  kills bigint not null,
  duration_ms bigint not null,
  weapon text not null,
  source text not null,
  created_at bigint not null
);

create table if not exists public.friendships (
  id uuid primary key,
  requester_id uuid not null references public.users (id) on delete cascade,
  recipient_id uuid not null references public.users (id) on delete cascade,
  status text not null,
  created_at bigint not null,
  unique (requester_id, recipient_id),
  check (requester_id <> recipient_id)
);

create table if not exists public.matches (
  id uuid primary key,
  player1_id uuid not null references public.users (id) on delete cascade,
  player2_id uuid not null references public.users (id) on delete cascade,
  status text not null,
  state jsonb not null,
  version bigint not null,
  updated_at bigint not null
);

create index if not exists sessions_user_idx on public.sessions (user_id);
create index if not exists scores_user_time_idx on public.scores (user_id, created_at);
create index if not exists scores_board_idx on public.scores (mode, source, wave, kills);
create index if not exists friend_requester_idx on public.friendships (requester_id, status);
create index if not exists friend_recipient_idx on public.friendships (recipient_id, status);
create index if not exists matches_p1_idx on public.matches (player1_id, updated_at);
create index if not exists matches_p2_idx on public.matches (player2_id, updated_at);

alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.login_attempts enable row level security;
alter table public.scores enable row level security;
alter table public.friendships enable row level security;
alter table public.matches enable row level security;
