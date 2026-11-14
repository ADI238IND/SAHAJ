-- Phase 5 Core2 Schema, Constraints, RPCs, Monotonic State & RLS Acceptance
-- Run as database owner after all migrations; every fixture is rolled back.
begin;

-- 1. Setup synthetic test actors
insert into auth.users(id) values
  ('c2000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000002'),
  ('c2000000-0000-4000-8000-000000000003'),
  ('c2000000-0000-4000-8000-000000000004');

insert into public.families(id, name) values
  ('f2000000-0000-4000-8000-000000000001', 'Core2 Synthetic Family A'),
  ('f2000000-0000-4000-8000-000000000002', 'Core2 Synthetic Family B');

insert into public.people(id, family_id, display_name, role) values
  ('p2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Riya (Child A)', 'child'),
  ('p2000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Meena Maa (Parent A)', 'parent'),
  ('p2000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'Rohit (Circle A)', 'circle'),
  ('p2000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000002', 'Foreign Child B', 'child');

insert into public.family_memberships(family_id, user_id, person_id, role) values
  ('f2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'p2000000-0000-4000-8000-000000000001', 'child'),
  ('f2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'p2000000-0000-4000-8000-000000000002', 'parent'),
  ('f2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000003', 'p2000000-0000-4000-8000-000000000003', 'circle'),
  ('f2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000004', 'p2000000-0000-4000-8000-000000000004', 'child');

-- 2. Test Trusted Contacts constraints and cross-family isolation
insert into public.core2_trusted_contacts(id, family_id, child_person_id, contact_person_id, priority_order, relationship, status)
values (
  'tc000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'p2000000-0000-4000-8000-000000000001',
  'p2000000-0000-4000-8000-000000000003',
  1,
  'Brother',
  'active'
);

do $$
begin
  -- Cross-family contact reference must fail
  begin
    insert into public.core2_trusted_contacts(family_id, child_person_id, contact_person_id, priority_order, relationship)
    values ('f2000000-0000-4000-8000-000000000001', 'p2000000-0000-4000-8000-000000000001', 'p2000000-0000-4000-8000-000000000004', 2, 'Foreign Friend');
    raise exception 'FAIL: cross-family contact accepted';
  exception when foreign_key_violation then null;
  end;

  -- Duplicate contact in same family must fail
  begin
    insert into public.core2_trusted_contacts(family_id, child_person_id, contact_person_id, priority_order, relationship)
    values ('f2000000-0000-4000-8000-000000000001', 'p2000000-0000-4000-8000-000000000001', 'p2000000-0000-4000-8000-000000000003', 2, 'Brother Duplicate');
    raise exception 'FAIL: duplicate contact accepted';
  exception when unique_violation then null;
  end;
end;
$$;

-- 3. Test Late-Home Watch creation and Monotonic State Enforcement
insert into public.core2_late_watches(
  id, family_id, person_id, destination_label, expected_by, escalate_after, status
) values (
  'lw000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'p2000000-0000-4000-8000-000000000001',
  'Home, HSR Layout',
  now() + interval '30 minutes',
  now() + interval '35 minutes',
  'active'
);

-- Active -> Safe is allowed
update public.core2_late_watches
set status = 'safe', safe_at = now()
where id = 'lw000000-0000-4000-8000-000000000001';

-- Safe -> Active MUST fail due to monotonic enforcement trigger
do $$
begin
  begin
    update public.core2_late_watches
    set status = 'active'
    where id = 'lw000000-0000-4000-8000-000000000001';
    raise exception 'FAIL: safe-to-active downgrade was permitted';
  exception when others then
    if sqlerrm not like '%monotonic_watch_transition_violation%' then
      raise exception 'Unexpected error: %', sqlerrm;
    end if;
  end;
end;
$$;

-- 4. Test SOS Trigger, Incident Creation & Reassurance RPC
insert into public.incidents(id, family_id, person_id, severity, state)
values (
  'in000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'p2000000-0000-4000-8000-000000000001',
  'urgent',
  'open'
);

insert into public.core2_sos_triggers(
  id, family_id, person_id, incident_id, idempotency_key, payload_hash, trigger_type, status
) values (
  'st000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'p2000000-0000-4000-8000-000000000001',
  'in000000-0000-4000-8000-000000000001',
  'idem-sos-synthetic-001',
  repeat('a', 64),
  'sos_button',
  'triggered'
);

-- Insert second active watch to test batch safe reassurance
insert into public.core2_late_watches(
  id, family_id, person_id, destination_label, expected_by, escalate_after, status
) values (
  'lw000000-0000-4000-8000-000000000002',
  'f2000000-0000-4000-8000-000000000001',
  'p2000000-0000-4000-8000-000000000001',
  'Home, HSR Layout',
  now() + interval '40 minutes',
  now() + interval '45 minutes',
  'active'
);

-- Run core2_safe_reassurance
do $$
declare
  r record;
begin
  select * into r from public.core2_safe_reassurance(
    'f2000000-0000-4000-8000-000000000001',
    'p2000000-0000-4000-8000-000000000001',
    'Main safe hoon, Maa'
  );

  if r.watches_updated <> 1 then
    raise exception 'FAIL: expected 1 watch updated to safe, got %', r.watches_updated;
  end if;

  if r.incidents_resolved <> 1 then
    raise exception 'FAIL: expected 1 incident resolved, got %', r.incidents_resolved;
  end if;

  if r.current_safety_status <> 'safe' then
    raise exception 'FAIL: expected current status safe, got %', r.current_safety_status;
  end if;
end;
$$;

-- Verify incident is now 'done' and SOS is 'resolved'
do $$
begin
  if (select state from public.incidents where id = 'in000000-0000-4000-8000-000000000001') <> 'done' then
    raise exception 'FAIL: incident state was not marked done';
  end if;
  if (select status from public.core2_sos_triggers where id = 'st000000-0000-4000-8000-000000000001') <> 'resolved' then
    raise exception 'FAIL: sos trigger was not marked resolved';
  end if;
end;
$$;

-- 5. Test Verified Responder Acceptance RPC
-- Create raw event
insert into public.raw_events(
  id, family_id, source, provider_event_id, event_type, payload_hash, payload_ciphertext
) values (
  're000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'whatsapp',
  'wa-msg-synthetic-proof-001',
  'responder_accept',
  repeat('b', 64),
  'encrypted_synthetic_proof'
);

-- Create second incident and offered assignment
insert into public.incidents(id, family_id, person_id, severity, state)
values (
  'in000000-0000-4000-8000-000000000002',
  'f2000000-0000-4000-8000-000000000001',
  'p2000000-0000-4000-8000-000000000001',
  'urgent',
  'offered'
);

insert into public.assignments(id, family_id, incident_id, person_id, status, offered_at, expires_at)
values (
  'as000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'in000000-0000-4000-8000-000000000002',
  'p2000000-0000-4000-8000-000000000003',
  'offered',
  now(),
  now() + interval '10 minutes'
);

-- Try to verify with wrong provider event -> must return false
do $$
begin
  if public.core2_verify_responder_acceptance(
    'f2000000-0000-4000-8000-000000000001',
    'in000000-0000-4000-8000-000000000002',
    'p2000000-0000-4000-8000-000000000003',
    're000000-0000-4000-8000-999999999999' -- non-existent event
  ) = true then
    raise exception 'FAIL: invalid provider event accepted';
  end if;
end;
$$;

-- Verify with real provider proof -> must succeed
do $$
begin
  if public.core2_verify_responder_acceptance(
    'f2000000-0000-4000-8000-000000000001',
    'in000000-0000-4000-8000-000000000002',
    'p2000000-0000-4000-8000-000000000003',
    're000000-0000-4000-8000-000000000001'
  ) <> true then
    raise exception 'FAIL: valid responder acceptance rejected';
  end if;

  if (select state from public.incidents where id = 'in000000-0000-4000-8000-000000000002') <> 'accepted' then
    raise exception 'FAIL: incident was not transitioned to accepted';
  end if;

  if (select status from public.assignments where id = 'as000000-0000-4000-8000-000000000001') <> 'accepted' then
    raise exception 'FAIL: assignment was not marked accepted';
  end if;
end;
$$;

-- 6. Test Row Level Security Isolation
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c2000000-0000-4000-8000-000000000001', true); -- Child A

do $$
begin
  -- Child A can select their family's trusted contacts
  if (select count(*) from public.core2_trusted_contacts where family_id = 'f2000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'FAIL: child cannot see family trusted contacts';
  end if;

  -- Child A can select their family's late watches
  if (select count(*) from public.core2_late_watches where family_id = 'f2000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'FAIL: child cannot see family late watches';
  end if;

  -- Child A cannot see other family's data
  if (select count(*) from public.core2_late_watches where family_id = 'f2000000-0000-4000-8000-000000000002') <> 0 then
    raise exception 'FAIL: cross-family data leaked to child';
  end if;

  -- Direct client inserts must fail
  begin
    insert into public.core2_late_watches(
      family_id, person_id, destination_label, expected_by, escalate_after
    ) values (
      'f2000000-0000-4000-8000-000000000001',
      'p2000000-0000-4000-8000-000000000001',
      'Unauthorized Direct Write',
      now(),
      now()
    );
    raise exception 'FAIL: client direct insert permitted';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- Switch to Parent A
select set_config('request.jwt.claim.sub', 'c2000000-0000-4000-8000-000000000002', true);

do $$
begin
  -- Parent cannot see child SOS triggers directly
  if (select count(*) from public.core2_sos_triggers) <> 0 then
    raise exception 'FAIL: parent directly reads child SOS triggers';
  end if;
end;
$$;

rollback;
