-- Core2 Adult-Child Safety, SOS Incidents, Late-Home Watch, Trusted Contacts, Reassurance & Truth-Line
-- Migration: 20261114230000_phase5_core2.sql

create table if not exists public.core2_trusted_contacts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  child_person_id uuid not null,
  contact_person_id uuid not null,
  priority_order integer not null check(priority_order > 0),
  relationship text not null check(length(relationship) between 1 and 64),
  capabilities jsonb not null default '["emergency_alert","voice_reassurance"]'::jsonb,
  status text not null default 'pending' check(status in ('pending','verified','active','revoked')),
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(family_id, child_person_id) references public.people(family_id, id),
  foreign key(family_id, contact_person_id) references public.people(family_id, id),
  unique(family_id, child_person_id, contact_person_id),
  unique(family_id, id)
);

create table if not exists public.core2_late_watches (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  person_id uuid not null,
  status text not null default 'active' check(status in ('active','safe','escalated','cancelled')),
  destination_label text not null check(length(destination_label) between 1 and 128),
  origin_label text check(origin_label is null or length(origin_label) <= 128),
  transport_note text check(transport_note is null or length(transport_note) <= 128),
  expected_by timestamptz not null,
  grace_period_seconds integer not null default 300 check(grace_period_seconds between 0 and 7200),
  escalate_after timestamptz not null,
  safe_at timestamptz,
  cancelled_at timestamptz,
  escalated_at timestamptz,
  incident_id uuid,
  lease_token uuid,
  lease_until timestamptz,
  worker_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(family_id, person_id) references public.people(family_id, id),
  foreign key(family_id, incident_id) references public.incidents(family_id, id),
  unique(family_id, id)
);

create table if not exists public.core2_sos_triggers (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  person_id uuid not null,
  incident_id uuid not null,
  raw_event_id uuid references public.raw_events(id),
  idempotency_key text not null check(length(idempotency_key) between 1 and 256),
  payload_hash text not null check(length(payload_hash) = 64),
  trigger_type text not null check(trigger_type in ('sos_button','late_watch_timeout','panic_phrase')),
  status text not null default 'triggered' check(status in ('triggered','escalating','acknowledged','resolved','cancelled')),
  cancellation_reason text check(cancellation_reason is null or length(cancellation_reason) <= 256),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key(family_id, person_id) references public.people(family_id, id),
  foreign key(family_id, incident_id) references public.incidents(family_id, id),
  unique(family_id, idempotency_key),
  unique(family_id, id)
);

create table if not exists public.core2_truth_line_queries (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  queried_by_person_id uuid not null,
  target_person_id uuid not null,
  query_type text not null check(query_type in ('safety_status','whereabouts_reassurance','incident_status')),
  status_reported text not null check(status_reported in ('safe','monitoring','urgent_action_underway','unknown')),
  reassurance_phrase_hi text not null check(length(reassurance_phrase_hi) <= 500),
  reassurance_phrase_en text not null check(length(reassurance_phrase_en) <= 500),
  created_at timestamptz not null default now(),
  foreign key(family_id, queried_by_person_id) references public.people(family_id, id),
  foreign key(family_id, target_person_id) references public.people(family_id, id),
  unique(family_id, id)
);

create table if not exists public.core2_command_idempotency (
  family_id uuid not null references public.families(id) on delete cascade,
  scope text not null check(length(scope) between 1 and 64),
  idempotency_key text not null check(length(idempotency_key) between 1 and 256),
  payload_hash text not null check(length(payload_hash) = 64),
  response_status integer not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  primary key(family_id, scope, idempotency_key)
);

-- Monotonic transition enforcement function and trigger
create or replace function public.core2_check_watch_monotonic()
returns trigger language plpgsql as $$
begin
  if old.status in ('safe', 'cancelled') and new.status <> old.status then
    raise exception 'monotonic_watch_transition_violation';
  end if;
  if old.status = 'escalated' and new.status not in ('escalated', 'safe', 'cancelled') then
    raise exception 'monotonic_watch_transition_violation';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_core2_watch_monotonic on public.core2_late_watches;
create trigger trg_core2_watch_monotonic
before update on public.core2_late_watches
for each row execute function public.core2_check_watch_monotonic();

-- Atomic reassurance function: marks active late-watch safe and open incidents resolved
create or replace function public.core2_safe_reassurance(
  p_family_id uuid,
  p_person_id uuid,
  p_reassurance_note text default 'Main safe hoon'
)
returns table(
  watches_updated integer,
  incidents_resolved integer,
  current_safety_status text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_w_count integer := 0;
  v_i_count integer := 0;
begin
  -- 1. Mark active or escalated watches as safe
  with updated_watches as (
    update public.core2_late_watches
    set status = 'safe', safe_at = coalesce(safe_at, now()), updated_at = now()
    where family_id = p_family_id and person_id = p_person_id
      and status in ('active', 'escalated')
    returning id
  )
  select count(*) into v_w_count from updated_watches;

  -- 2. Mark any related SOS triggers and incidents as resolved
  with updated_sos as (
    update public.core2_sos_triggers
    set status = 'resolved', resolved_at = coalesce(resolved_at, now()),
        cancellation_reason = coalesce(cancellation_reason, p_reassurance_note)
    where family_id = p_family_id and person_id = p_person_id
      and status in ('triggered', 'escalating', 'acknowledged')
    returning incident_id
  ),
  updated_incidents as (
    update public.incidents
    set state = 'done'
    where family_id = p_family_id and person_id = p_person_id
      and state in ('open', 'offered', 'escalated')
      and id in (select incident_id from updated_sos)
    returning id
  )
  select count(*) into v_i_count from updated_incidents;

  return query select v_w_count, v_i_count, 'safe'::text;
end;
$$;

-- Atomic lease-claim for overdue watches during cron ticks
create or replace function public.core2_claim_overdue_watches(
  p_worker_id text,
  p_lease_seconds integer default 60,
  p_limit integer default 20
)
returns setof public.core2_late_watches
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with candidate_watches as (
    select id from public.core2_late_watches
    where status = 'active'
      and escalate_after <= now()
      and (lease_until is null or lease_until < now())
    order by escalate_after asc
    limit p_limit
    for update skip locked
  )
  update public.core2_late_watches w
  set lease_token = gen_random_uuid(),
      lease_until = now() + (p_lease_seconds || ' seconds')::interval,
      worker_id = p_worker_id,
      updated_at = now()
  from candidate_watches c
  where w.id = c.id
  returning w.*;
end;
$$;

-- Atomic verification of responder acceptance binding exact responder + incident + raw event proof
create or replace function public.core2_verify_responder_acceptance(
  p_family_id uuid,
  p_incident_id uuid,
  p_responder_person_id uuid,
  p_raw_event_id uuid
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_assignment_id uuid;
  v_raw_exists boolean := false;
begin
  -- 1. Check raw event exists in the same family
  select exists(
    select 1 from public.raw_events
    where id = p_raw_event_id and family_id = p_family_id
  ) into v_raw_exists;

  if not v_raw_exists then
    return false;
  end if;

  -- 2. Find offered assignment for exact responder and incident
  select id into v_assignment_id
  from public.assignments
  where family_id = p_family_id
    and incident_id = p_incident_id
    and person_id = p_responder_person_id
    and status = 'offered'
    and expires_at > now()
  limit 1
  for update;

  if v_assignment_id is null then
    return false;
  end if;

  -- 3. Update assignment with provider proof
  update public.assignments
  set status = 'accepted',
      accepted_at = now(),
      verified_by_provider_event = p_raw_event_id
  where id = v_assignment_id;

  -- 4. Update incident state
  update public.incidents
  set state = 'accepted',
      owner_person_id = p_responder_person_id
  where id = p_incident_id and family_id = p_family_id;

  return true;
end;
$$;

-- Row Level Security
alter table public.core2_trusted_contacts enable row level security;
alter table public.core2_late_watches enable row level security;
alter table public.core2_sos_triggers enable row level security;
alter table public.core2_truth_line_queries enable row level security;
alter table public.core2_command_idempotency enable row level security;

revoke all on public.core2_trusted_contacts from anon, authenticated;
revoke all on public.core2_late_watches from anon, authenticated;
revoke all on public.core2_sos_triggers from anon, authenticated;
revoke all on public.core2_truth_line_queries from anon, authenticated;
revoke all on public.core2_command_idempotency from anon, authenticated;

grant all on public.core2_trusted_contacts to service_role;
grant all on public.core2_late_watches to service_role;
grant all on public.core2_sos_triggers to service_role;
grant all on public.core2_truth_line_queries to service_role;
grant all on public.core2_command_idempotency to service_role;

-- Select policies for authenticated users
grant select on public.core2_trusted_contacts to authenticated;
create policy core2_contacts_select on public.core2_trusted_contacts for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, contact_person_id)
  );

grant select on public.core2_late_watches to authenticated;
create policy core2_watches_select on public.core2_late_watches for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, person_id)
  );

grant select on public.core2_sos_triggers to authenticated;
create policy core2_sos_select on public.core2_sos_triggers for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
  );

grant select on public.core2_truth_line_queries to authenticated;
create policy core2_truth_line_select on public.core2_truth_line_queries for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child', 'parent'])
  );
