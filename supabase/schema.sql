-- Boulekampen — databas för poängsystemet och företagsbokningar
-- ─────────────────────────────────────────────────────────────
-- Körs en gång i ett eget Supabase-projekt: SQL Editor → klistra in → Run.
-- Lägg sedan till arrangörerna längst ner (admins) och fyll i
-- SUPABASE_URL och SUPABASE_ANON_KEY i app/config.js.
--
-- Principer
--  • Allt som visas publikt (lag, matcher, tabeller) är läsbart för alla.
--    Slugs för företagsevent slumpas så att de inte går att gissa.
--  • Kontaktuppgifter, betalningar, specialkost, röster och bokningar
--    ligger i egna tabeller som bara arrangörer (admins) kommer åt.
--  • Domare skriver aldrig direkt i tabellerna. De går via score_match()
--    som kontrollerar domar-PIN:en mot en hash.
--  • Specialkost är hälsouppgifter. purge_personal_data() tömmer dem —
--    kör den senast 30 dagar efter eventet.

create extension if not exists pgcrypto with schema extensions;

-- ── Tabeller ──────────────────────────────────────────────────────────

create table if not exists admins (
  email text primary key
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  company text not null default '',
  contact_name text default '',
  email text default '',
  phone text default '',
  date date,
  time text default '',
  participants int default 0,
  venue text default '',
  status text not null default 'forfragan',
  notes text default '',
  items jsonb not null default '[]',
  checklist jsonb not null default '[]',
  plan jsonb not null default '{}',
  event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,60}$'),
  name text not null,
  kind text not null default 'turnering' check (kind in ('turnering', 'foretag')),
  status text not null default 'utkast' check (status in ('utkast', 'pagar', 'avslutad')),
  date date,
  venue text default '',
  listed boolean not null default false,
  config jsonb not null default '{}',
  booking_id uuid references bookings(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists event_secrets (
  event_id uuid primary key references events(id) on delete cascade,
  scorer_pin_hash text
);

-- Anmälningskoden för företagsevent står på QR-skylten och storbilden,
-- så den är ingen hemlighet och ligger i config.registration.code.
create index if not exists events_join_code on events ((upper(config -> 'registration' ->> 'code')));

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  members text[] not null default '{}',
  group_label text,
  seed int not null default 0,
  costume text default '',
  checked_in boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists teams_event on teams(event_id);

create table if not exists team_private (
  team_id uuid primary key references teams(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  contact_name text default '',
  phone text default '',
  email text default '',
  paid boolean not null default false,
  notes text default ''
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  team_id uuid references teams(id) on delete set null,
  name text not null check (char_length(name) between 1 and 60),
  department text default '' check (char_length(department) <= 60),
  inactive boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists players_event on players(event_id);

create table if not exists player_private (
  player_id uuid primary key references players(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  email text default '',
  diet text default ''
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  stage text not null check (stage in ('group', 'A', 'B', 'swiss', 'melee')),
  round int not null default 1,
  group_label text,
  label text,
  slot int not null default 0,
  court int,
  team_a uuid references teams(id) on delete set null,
  team_b uuid references teams(id) on delete set null,
  src_a jsonb,
  src_b jsonb,
  players_a uuid[],
  players_b uuid[],
  score_a int not null default 0 check (score_a between 0 and 99),
  score_b int not null default 0 check (score_b between 0 and 99),
  ends jsonb not null default '[]',
  status text not null default 'planned' check (status in ('planned', 'live', 'done')),
  bye boolean not null default false,
  bronze boolean not null default false,
  version int not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists matches_event on matches(event_id);

create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  unit text default 'poäng',
  higher_better boolean not null default true,
  sort int not null default 0
);

create table if not exists challenge_scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  challenge_id uuid not null references challenges(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  team_id uuid references teams(id) on delete cascade,
  value numeric not null,
  created_at timestamptz not null default now()
);
create index if not exists challenge_scores_event on challenge_scores(event_id);

create table if not exists votes (
  event_id uuid not null references events(id) on delete cascade,
  device text not null check (char_length(device) between 8 and 64),
  team_id uuid not null references teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, device)
);

create table if not exists settings (
  key text primary key,
  value jsonb not null default '{}'
);

-- ── updated_at ────────────────────────────────────────────────────────

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists events_touch on events;
create trigger events_touch before update on events for each row execute function touch_updated_at();
drop trigger if exists bookings_touch on bookings;
create trigger bookings_touch before update on bookings for each row execute function touch_updated_at();
drop trigger if exists matches_touch on matches;
create trigger matches_touch before update on matches for each row execute function touch_updated_at();

-- ── Behörighet ────────────────────────────────────────────────────────

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;

alter table admins            enable row level security;
alter table bookings          enable row level security;
alter table events            enable row level security;
alter table event_secrets     enable row level security;
alter table teams             enable row level security;
alter table team_private      enable row level security;
alter table players           enable row level security;
alter table player_private    enable row level security;
alter table matches           enable row level security;
alter table challenges        enable row level security;
alter table challenge_scores  enable row level security;
alter table votes             enable row level security;
alter table settings          enable row level security;

-- Publikt läsbart
do $$
declare t text;
begin
  foreach t in array array['events', 'teams', 'players', 'matches', 'challenges', 'challenge_scores'] loop
    execute format('drop policy if exists "%s_read" on %I', t, t);
    execute format('create policy "%s_read" on %I for select to anon, authenticated using (true)', t, t);
    execute format('drop policy if exists "%s_admin" on %I', t, t);
    execute format('create policy "%s_admin" on %I for all to authenticated using (is_admin()) with check (is_admin())', t, t);
  end loop;
  -- Bara arrangörer
  foreach t in array array['bookings', 'event_secrets', 'team_private', 'player_private', 'votes', 'settings'] loop
    execute format('drop policy if exists "%s_admin" on %I', t, t);
    execute format('create policy "%s_admin" on %I for all to authenticated using (is_admin()) with check (is_admin())', t, t);
  end loop;
end $$;

drop policy if exists "admins_read" on admins;
create policy "admins_read" on admins for select to authenticated using (is_admin());

-- ── Funktioner för domare, deltagare och röstning ─────────────────────

create or replace function pin_ok(p_event uuid, p_pin text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((
    select s.scorer_pin_hash is not null
       and s.scorer_pin_hash = crypt(coalesce(p_pin, ''), s.scorer_pin_hash)
    from event_secrets s where s.event_id = p_event
  ), false)
$$;

create or replace function check_pin(p_event uuid, p_pin text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or pin_ok(p_event, p_pin)
$$;

-- Arrangören sätter domar-PIN:en. Tom sträng tar bort den.
create or replace function set_scorer_pin(p_event uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Bara arrangörer' using errcode = '42501'; end if;
  insert into event_secrets(event_id) values (p_event) on conflict do nothing;
  update event_secrets set scorer_pin_hash =
    case when coalesce(p_pin, '') = '' then null else crypt(p_pin, gen_salt('bf')) end
  where event_id = p_event;
end $$;

create or replace function has_scorer_pin(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select scorer_pin_hash is not null from event_secrets where event_id = p_event), false)
$$;

-- Poäng från domarvyn. p_version skyddar mot att två telefoner skriver
-- över varandra: stämmer inte versionen skickas matchens läge tillbaka.
create or replace function score_match(
  p_event uuid, p_pin text, p_match uuid,
  p_score_a int, p_score_b int, p_ends jsonb, p_status text, p_version int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  if not check_pin(p_event, p_pin) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  select * into m from matches where id = p_match and event_id = p_event for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  if p_version is not null and m.version <> p_version then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'row', to_jsonb(m));
  end if;
  if p_status not in ('planned', 'live', 'done') then
    return jsonb_build_object('ok', false, 'error', 'status');
  end if;
  if jsonb_typeof(coalesce(p_ends, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_ends, '[]'::jsonb)) > 60 then
    return jsonb_build_object('ok', false, 'error', 'ends');
  end if;
  update matches set
    score_a = greatest(0, least(99, p_score_a)),
    score_b = greatest(0, least(99, p_score_b)),
    ends = coalesce(p_ends, '[]'::jsonb),
    status = p_status,
    version = m.version + 1
  where id = p_match
  returning * into m;
  return jsonb_build_object('ok', true, 'row', to_jsonb(m));
end $$;

-- Deltagare anmäler sig till ett företagsevent med koden på QR-skylten.
create or replace function join_event(
  p_code text, p_name text, p_department text, p_diet text, p_email text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e events; pid uuid;
begin
  select * into e from events
  where upper(config -> 'registration' ->> 'code') = upper(trim(p_code))
  order by created_at desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'code'); end if;
  if coalesce((e.config -> 'registration' ->> 'open')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 60 then
    return jsonb_build_object('ok', false, 'error', 'name');
  end if;
  if (select count(*) from players where event_id = e.id) >= 400 then
    return jsonb_build_object('ok', false, 'error', 'full');
  end if;
  insert into players(event_id, name, department)
  values (e.id, trim(p_name), left(trim(coalesce(p_department, '')), 60))
  returning id into pid;
  if coalesce(trim(p_diet), '') <> '' or coalesce(trim(p_email), '') <> '' then
    insert into player_private(player_id, event_id, diet, email)
    values (pid, e.id, left(trim(coalesce(p_diet, '')), 300), left(trim(coalesce(p_email, '')), 120));
  end if;
  return jsonb_build_object('ok', true, 'slug', e.slug, 'player_id', pid, 'event', e.name);
end $$;

create or replace function event_by_code(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('slug', e.slug, 'name', e.name, 'date', e.date, 'venue', e.venue,
                            'open', coalesce((e.config -> 'registration' ->> 'open')::boolean, false),
                            'company', e.config -> 'company' ->> 'name')
  from events e
  where upper(e.config -> 'registration' ->> 'code') = upper(trim(p_code))
  order by e.created_at desc limit 1
$$;

-- Bästa lagutklädnad. En röst per enhet, går att ändra så länge röstningen är öppen.
create or replace function cast_vote(p_event uuid, p_team uuid, p_device text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e events;
begin
  select * into e from events where id = p_event;
  if not found or coalesce((e.config -> 'voting' ->> 'open')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  if not exists (select 1 from teams where id = p_team and event_id = p_event) then
    return jsonb_build_object('ok', false, 'error', 'team');
  end if;
  insert into votes(event_id, device, team_id) values (p_event, p_device, p_team)
  on conflict (event_id, device) do update set team_id = excluded.team_id, created_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Rösträkningen är hemlig tills arrangören avslöjar den på storbilden.
create or replace function vote_results(p_event uuid) returns table(team_id uuid, votes bigint)
language sql stable security definer set search_path = public as $$
  select v.team_id, count(*) from votes v
  join events e on e.id = v.event_id
  where v.event_id = p_event
    and (is_admin() or coalesce((e.config -> 'voting' ->> 'reveal')::boolean, false))
  group by v.team_id
$$;

create or replace function score_challenge(
  p_event uuid, p_pin text, p_challenge uuid, p_player uuid, p_team uuid, p_value numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r challenge_scores;
begin
  if not check_pin(p_event, p_pin) then return jsonb_build_object('ok', false, 'error', 'pin'); end if;
  if not exists (select 1 from challenges where id = p_challenge and event_id = p_event) then
    return jsonb_build_object('ok', false, 'error', 'missing');
  end if;
  insert into challenge_scores(event_id, challenge_id, player_id, team_id, value)
  values (p_event, p_challenge, p_player, p_team, p_value) returning * into r;
  return jsonb_build_object('ok', true, 'row', to_jsonb(r));
end $$;

-- Rensar kontaktuppgifter och specialkost efter eventet.
create or replace function purge_personal_data(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Bara arrangörer' using errcode = '42501'; end if;
  delete from player_private where event_id = p_event;
  update team_private set phone = '', email = '', contact_name = '' where event_id = p_event;
  delete from votes where event_id = p_event;
end $$;

revoke all on function pin_ok(uuid, text) from public, anon, authenticated;
grant execute on function check_pin(uuid, text) to anon, authenticated;
grant execute on function score_match(uuid, text, uuid, int, int, jsonb, text, int) to anon, authenticated;
grant execute on function join_event(text, text, text, text, text) to anon, authenticated;
grant execute on function event_by_code(text) to anon, authenticated;
grant execute on function cast_vote(uuid, uuid, text) to anon, authenticated;
grant execute on function vote_results(uuid) to anon, authenticated;
grant execute on function score_challenge(uuid, text, uuid, uuid, uuid, numeric) to anon, authenticated;
grant execute on function set_scorer_pin(uuid, text) to authenticated;
grant execute on function has_scorer_pin(uuid) to anon, authenticated;
grant execute on function purge_personal_data(uuid) to authenticated;

-- ── Realtid ───────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array['events', 'teams', 'players', 'matches', 'challenges', 'challenge_scores'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- ── Arrangörer ────────────────────────────────────────────────────────
-- Byt till riktiga adresser. De loggar in med en länk som skickas dit.
-- insert into admins(email) values ('hello@brunowegelius.com') on conflict do nothing;
