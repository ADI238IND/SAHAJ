-- Phase 1 Foundation Security & Isolation Acceptance Assertions
-- Authoritative verification suite for:
-- 1. Application table RLS enablement across public, sahaj_private, and sahaj_checkpoints
-- 2. Anonymous role default deny and privilege boundary
-- 3. Authenticated tenant boundary isolation (cross-family and intra-tenant role fencing)
-- 4. Revoked membership isolation
-- 5. Private schema and storage bucket isolation
-- 6. Service-only RPC execution enforcement
-- 7. LangGraph Checkpoint role least privilege
--
-- Rollback-only: Zero persistent changes; all fixtures and mutations roll back.
-- Run by Codex against the connected Supabase PostgreSQL instance.

begin;

-- ============================================================================
-- Section 1: Application Table Row-Level Security (RLS) Assertions
-- ============================================================================
do $$
declare
  missing_rls text[];
begin
  select array_agg(c.relname) into missing_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'sahaj_private', 'sahaj_checkpoints')
    and c.relkind = 'r'
    and not c.relrowsecurity
    and c.relname in (
      -- Foundation schema tables
      'families', 'people', 'raw_events', 'idempotency_keys', 'timeline_events',
      -- Core 1 security & workflow tables
      'family_memberships', 'circle', 'calls', 'consents', 'schedules', 'requests',
      'incidents', 'assignments', 'voice_posts', 'medicines', 'vendors', 'permissions',
      'action_requests', 'action_answers', 'errands', 'nudges', 'child_alerts',
      'provider_identities', 'workflow_jobs', 'outbox',
      -- Signed timeline head tracking table
      'timeline_stream_heads',
      -- Private schema content tables
      'call_content', 'private_items', 'voice_content',
      -- LangGraph checkpoint tables
      'checkpoint_migrations', 'checkpoints', 'checkpoint_blobs', 'checkpoint_writes'
    );

  if missing_rls is not null and array_length(missing_rls, 1) > 0 then
    raise exception 'FAIL RLS disabled on required tables: %', array_to_string(missing_rls, ', ');
  end if;
end $$;

-- ============================================================================
-- Section 2: Private Schema & Media Storage Bucket Isolation Assertions
-- ============================================================================
do $$
begin
  -- sahaj_private schema must have NO USAGE granted to untrusted roles
  if has_schema_privilege('anon', 'sahaj_private', 'USAGE')
     or has_schema_privilege('authenticated', 'sahaj_private', 'USAGE')
     or has_schema_privilege('public', 'sahaj_private', 'USAGE') then
    raise exception 'FAIL sahaj_private schema USAGE granted to untrusted roles';
  end if;

  -- sahaj_checkpoints schema must have NO USAGE granted to untrusted roles
  if has_schema_privilege('anon', 'sahaj_checkpoints', 'USAGE')
     or has_schema_privilege('authenticated', 'sahaj_checkpoints', 'USAGE')
     or has_schema_privilege('public', 'sahaj_checkpoints', 'USAGE') then
    raise exception 'FAIL sahaj_checkpoints schema USAGE granted to untrusted roles';
  end if;

  -- Storage buckets must be private (public = false)
  if exists (
    select 1 from storage.buckets
    where id in ('sahaj-voice', 'sahaj-recordings', 'sahaj-lines') and public
  ) then
    raise exception 'FAIL private media bucket marked public';
  end if;
end $$;

-- ============================================================================
-- Section 3: Checkpoint Role Least Privilege Assertions
-- ============================================================================
do $$
begin
  -- sahaj_atlas_runtime must not possess database-wide CREATE privilege
  if has_database_privilege('sahaj_atlas_runtime', current_database(), 'CREATE') then
    raise exception 'FAIL sahaj_atlas_runtime has database CREATE privilege';
  end if;

  -- sahaj_atlas_runtime must have USAGE on sahaj_checkpoints
  if not has_schema_privilege('sahaj_atlas_runtime', 'sahaj_checkpoints', 'USAGE') then
    raise exception 'FAIL sahaj_atlas_runtime lacks USAGE on sahaj_checkpoints';
  end if;

  -- sahaj_atlas_runtime must NOT have USAGE on sahaj_private
  if has_schema_privilege('sahaj_atlas_runtime', 'sahaj_private', 'USAGE') then
    raise exception 'FAIL sahaj_atlas_runtime has USAGE on sahaj_private';
  end if;

  -- sahaj_atlas_runtime must not possess SELECT privilege on application care tables
  if has_table_privilege('sahaj_atlas_runtime', 'public.families', 'SELECT')
     or has_table_privilege('sahaj_atlas_runtime', 'public.people', 'SELECT')
     or has_table_privilege('sahaj_atlas_runtime', 'sahaj_private.call_content', 'SELECT')
     or has_table_privilege('sahaj_atlas_runtime', 'public.incidents', 'SELECT') then
    raise exception 'FAIL sahaj_atlas_runtime has excessive privileges on application care tables';
  end if;

  -- sahaj_checkpoints must contain exactly 4 tables
  if (select count(*) from pg_tables where schemaname = 'sahaj_checkpoints') <> 4 then
    raise exception 'FAIL sahaj_checkpoints table count mismatch';
  end if;
end $$;

-- ============================================================================
-- Section 4: Service-Only RPC Execution Assertions
-- ============================================================================
do $$
declare
  fn record;
  forbidden_exec text[];
begin
  for fn in
    select p.proname, oidvectortypes(p.proargtypes) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_voice_media_metadata',
      'get_call_media_metadata',
      'ingest_raw_event',
      'claim_raw_events',
      'finish_raw_event',
      'dispatch_raw_event',
      'claim_outbox',
      'finish_outbox',
      'reconcile_outbox',
      'claim_workflow_jobs',
      'finish_workflow_job',
      'resume_workflow_job',
      'append_timeline_event'
    )
  loop
    if has_function_privilege('anon', 'public.' || fn.proname || '(' || fn.args || ')', 'EXECUTE') then
      forbidden_exec := array_append(forbidden_exec, 'anon can execute ' || fn.proname);
    end if;
    if has_function_privilege('authenticated', 'public.' || fn.proname || '(' || fn.args || ')', 'EXECUTE') then
      forbidden_exec := array_append(forbidden_exec, 'authenticated can execute ' || fn.proname);
    end if;
    if not has_function_privilege('service_role', 'public.' || fn.proname || '(' || fn.args || ')', 'EXECUTE') then
      raise exception 'FAIL service_role cannot execute %', fn.proname;
    end if;
  end loop;

  if forbidden_exec is not null and array_length(forbidden_exec, 1) > 0 then
    raise exception 'FAIL Service-only RPCs exposed to client roles: %', array_to_string(forbidden_exec, '; ');
  end if;
end $$;

-- ============================================================================
-- Section 5: Tenant Boundary & Role-Based Isolation (Synthetic Fixtures)
-- ============================================================================

-- Synthetic Auth Users
insert into auth.users (id) values
  ('a1000000-0000-4000-8000-000000000001'), -- Child in Family A
  ('a1000000-0000-4000-8000-000000000002'), -- Parent in Family A
  ('a1000000-0000-4000-8000-000000000003'), -- Circle in Family A
  ('a1000000-0000-4000-8000-000000000004'); -- Child in Family B

-- Synthetic Families
insert into public.families (id, name, language, demo) values
  ('b1000000-0000-4000-8000-000000000001', 'Synthetic Phase 1 Family A', 'hi', true),
  ('b1000000-0000-4000-8000-000000000002', 'Synthetic Phase 1 Family B', 'hi', true);

-- Synthetic People
insert into public.people (id, family_id, display_name, role) values
  ('c1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Synthetic Child A', 'child'),
  ('c1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'Synthetic Parent A', 'parent'),
  ('c1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', 'Synthetic Circle A', 'circle'),
  ('c1000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000002', 'Synthetic Child B', 'child');

-- Memberships
insert into public.family_memberships (family_id, user_id, person_id, role) values
  ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'child'),
  ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'parent'),
  ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003', 'circle'),
  ('b1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000004', 'child');

-- Operational Records in Family A & B
insert into public.calls (id, family_id, person_id, provider) values
  ('d1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'synthetic'),
  ('d1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', 'synthetic');

insert into public.incidents (id, family_id, person_id, severity) values
  ('e1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'routine'),
  ('e1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', 'routine');

insert into public.assignments (family_id, incident_id, person_id, expires_at) values
  ('b1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', now() + interval '1 hour');

insert into public.consents (id, family_id, person_id, purpose, question, answer, version) values
  ('f1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'phase1_acceptance', 'Synthetic acceptance consent?', true, 'phase1-v1');

insert into public.voice_posts (family_id, sender_id, recipient_id, consent_id) values
  ('b1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001');

-- 5A. Anonymous role verification: Default deny
set local role anon;
do $$
begin
  begin
    perform * from public.families;
    raise exception 'FAIL anon can select families';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.people;
    raise exception 'FAIL anon can select people';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.calls;
    raise exception 'FAIL anon can select calls';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.incidents;
    raise exception 'FAIL anon can select incidents';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.family_memberships;
    raise exception 'FAIL anon can select memberships';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.raw_events;
    raise exception 'FAIL anon can select raw_events';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.outbox;
    raise exception 'FAIL anon can select outbox';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.workflow_jobs;
    raise exception 'FAIL anon can select workflow_jobs';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.timeline_events;
    raise exception 'FAIL anon can select timeline_events';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 5B. Authenticated role tenant isolation: Child A (Family A)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
do $$
begin
  -- Scope restricted to Family A only
  if (select count(*) from public.families where id in ('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002')) <> 1 then
    raise exception 'FAIL Child A saw wrong family count';
  end if;

  if exists (select 1 from public.families where id = 'b1000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL Child A saw Family B';
  end if;

  if exists (select 1 from public.incidents where id = 'e1000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL Child A saw Family B incidents';
  end if;

  -- Client mutation denial
  begin
    update public.family_memberships set role = 'child';
    raise exception 'FAIL Client updated membership';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.raw_events;
    raise exception 'FAIL Client selected raw_events';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.outbox;
    raise exception 'FAIL Client selected outbox';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.workflow_jobs;
    raise exception 'FAIL Client selected workflow_jobs';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.timeline_stream_heads;
    raise exception 'FAIL Client selected timeline_stream_heads';
  exception when insufficient_privilege then null; end;

  begin
    perform transcript_ciphertext from sahaj_private.call_content;
    raise exception 'FAIL Client selected sahaj_private.call_content';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 5C. Authenticated role tenant isolation: Parent A (Family A)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
do $$
begin
  -- Parent sees their own call only
  if (select count(*) from public.calls where id in ('d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002')) <> 1 then
    raise exception 'FAIL Parent A saw invalid call count';
  end if;

  if exists (select 1 from public.calls where id = 'd1000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL Parent A saw Family B call';
  end if;

  -- Parent does not see coordinator/triage incidents
  if exists (select 1 from public.incidents) then
    raise exception 'FAIL Parent saw incidents';
  end if;

  -- Parent can read their own voice post metadata
  if not exists (select 1 from public.voice_posts where family_id = 'b1000000-0000-4000-8000-000000000001') then
    raise exception 'FAIL Parent own voice post missing';
  end if;
end $$;
reset role;

-- 5D. Authenticated role tenant isolation: Circle A (Family A)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000003', true);
do $$
begin
  -- Circle sees only their assigned task metadata
  if (select count(*) from public.assignments where family_id = 'b1000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'FAIL Circle A missing assigned task';
  end if;

  if exists (select 1 from public.calls) then
    raise exception 'FAIL Circle A saw calls';
  end if;

  if exists (select 1 from public.incidents) then
    raise exception 'FAIL Circle A saw unassigned incidents';
  end if;

  if exists (select 1 from public.voice_posts) then
    raise exception 'FAIL Circle A saw voice posts';
  end if;
end $$;
reset role;

-- 5E. Revoked membership isolation
update public.family_memberships set revoked_at = now()
where user_id = 'a1000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
do $$
begin
  if exists (select 1 from public.families) then
    raise exception 'FAIL Revoked member still reads families';
  end if;
  if exists (select 1 from public.family_memberships) then
    raise exception 'FAIL Revoked member still reads memberships';
  end if;
  if exists (select 1 from public.calls) then
    raise exception 'FAIL Revoked member still reads calls';
  end if;
  if exists (select 1 from public.incidents) then
    raise exception 'FAIL Revoked member still reads incidents';
  end if;
end $$;
reset role;

-- ============================================================================
-- Section 6: Rollback All Fixtures
-- ============================================================================
rollback;
