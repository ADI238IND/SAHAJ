-- Phase 1 Foundation Security & Isolation Acceptance Assertions
-- Authoritative verification suite for:
-- 1. Application table existence and Row-Level Security (RLS) enablement
-- 2. Anonymous role default deny and privilege boundary
-- 3. Authenticated tenant boundary isolation (cross-family and intra-tenant role fencing)
-- 4. Revoked membership isolation
-- 5. Private schema and storage bucket isolation
-- 6. Service-only RPC existence and execution enforcement
-- 7. LangGraph Checkpoint role least privilege
--
-- Rollback-only: Zero persistent changes; all fixtures and mutations roll back.
-- Run by parent/Codex against the connected Supabase PostgreSQL instance.

begin;

-- ============================================================================
-- Section 1: Application Table Existence & Row-Level Security (RLS) Assertions
-- ============================================================================
do $$
declare
  expected_tables text[] := array[
    -- Public foundation & Core 1 security & workflow tables
    'public.families', 'public.people', 'public.raw_events', 'public.idempotency_keys', 'public.timeline_events',
    'public.family_memberships', 'public.circle', 'public.calls', 'public.consents', 'public.schedules', 'public.requests',
    'public.incidents', 'public.assignments', 'public.voice_posts', 'public.medicines', 'public.vendors', 'public.permissions',
    'public.action_requests', 'public.action_answers', 'public.errands', 'public.nudges', 'public.child_alerts',
    'public.provider_identities', 'public.workflow_jobs', 'public.outbox',
    -- Signed timeline head tracking table
    'public.timeline_stream_heads',
    -- Private schema content tables
    'sahaj_private.call_content', 'sahaj_private.private_items', 'sahaj_private.voice_content',
    -- LangGraph checkpoint tables
    'sahaj_checkpoints.checkpoint_migrations', 'sahaj_checkpoints.checkpoints',
    'sahaj_checkpoints.checkpoint_blobs', 'sahaj_checkpoints.checkpoint_writes'
  ];
  missing_tables text[];
  missing_rls text[];
begin
  -- Assert that required tables actually exist before checking RLS; absent objects must not vacuously pass
  select array_agg(req_tbl) into missing_tables
  from unnest(expected_tables) as req_tbl
  where not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = split_part(req_tbl, '.', 1)
      and c.relname = split_part(req_tbl, '.', 2)
      and c.relkind = 'r'
  );

  if missing_tables is not null and array_length(missing_tables, 1) > 0 then
    raise exception 'FAIL Required tables missing: %', array_to_string(missing_tables, ', ');
  end if;

  -- Assert RLS is enabled on every required table
  select array_agg(n.nspname || '.' || c.relname) into missing_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where (n.nspname || '.' || c.relname) = any(expected_tables)
    and not c.relrowsecurity;

  if missing_rls is not null and array_length(missing_rls, 1) > 0 then
    raise exception 'FAIL RLS disabled on required tables: %', array_to_string(missing_rls, ', ');
  end if;
end $$;

-- ============================================================================
-- Section 2: Private Schema & Media Storage Bucket Isolation Assertions
-- ============================================================================
do $$
declare
  r text;
  t text;
  priv text;
  missing_buckets text[];
begin
  -- 2A. sahaj_private schema privilege assertions:
  -- anon must have NO USAGE
  if has_schema_privilege('anon', 'sahaj_private', 'USAGE') then
    raise exception 'FAIL sahaj_private schema USAGE granted to anon';
  end if;

  -- PUBLIC (ACL pseudo-role, grantee=0) must have NO USAGE or CREATE on sahaj_private
  if exists (
    select 1
    from pg_namespace n,
         aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
    where n.nspname = 'sahaj_private'
      and a.grantee = 0
      and a.privilege_type in ('USAGE', 'CREATE')
  ) then
    raise exception 'FAIL sahaj_private schema USAGE or CREATE granted to PUBLIC';
  end if;

  -- Authenticated role intentionally preserves USAGE on sahaj_private for has_role/is_person RLS helpers.
  -- Verify browser roles (anon, authenticated) lack direct table privileges on private content tables.
  for r in select unnest(array['anon', 'authenticated']) loop
    for t in select unnest(array['call_content', 'voice_content', 'private_items']) loop
      for priv in select unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) loop
        if has_table_privilege(r, 'sahaj_private.' || t, priv) then
          raise exception 'FAIL browser role % has % privilege on sahaj_private.%', r, priv, t;
        end if;
      end loop;
    end loop;
  end loop;

  -- 2B. sahaj_checkpoints schema privilege assertions:
  -- Untrusted browser roles must have NO USAGE on sahaj_checkpoints
  if has_schema_privilege('anon', 'sahaj_checkpoints', 'USAGE')
     or has_schema_privilege('authenticated', 'sahaj_checkpoints', 'USAGE') then
    raise exception 'FAIL sahaj_checkpoints schema USAGE granted to browser roles';
  end if;

  -- PUBLIC (grantee=0) must have NO USAGE or CREATE on sahaj_checkpoints
  if exists (
    select 1
    from pg_namespace n,
         aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
    where n.nspname = 'sahaj_checkpoints'
      and a.grantee = 0
      and a.privilege_type in ('USAGE', 'CREATE')
  ) then
    raise exception 'FAIL sahaj_checkpoints schema USAGE or CREATE granted to PUBLIC';
  end if;

  -- 2C. Media storage buckets: all 3 named care buckets must exist AND be private
  select array_agg(req_b) into missing_buckets
  from unnest(array['sahaj-voice', 'sahaj-recordings', 'sahaj-lines']) as req_b
  where not exists (
    select 1 from storage.buckets where id = req_b
  );

  if missing_buckets is not null and array_length(missing_buckets, 1) > 0 then
    raise exception 'FAIL Required storage buckets missing: %', array_to_string(missing_buckets, ', ');
  end if;

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
-- Section 4: Service-Only RPC Existence & Execution Assertions
-- ============================================================================
do $$
declare
  expected_rpcs text[] := array[
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
  ];
  missing_rpcs text[];
  fn record;
  forbidden_exec text[];
begin
  -- 1. Assert all required service-only RPCs actually exist
  select array_agg(req_rpc) into missing_rpcs
  from unnest(expected_rpcs) as req_rpc
  where not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = req_rpc
  );

  if missing_rpcs is not null and array_length(missing_rpcs, 1) > 0 then
    raise exception 'FAIL Required service-only RPCs missing: %', array_to_string(missing_rpcs, ', ');
  end if;

  -- 2. Verify execution privileges across anon, authenticated, PUBLIC, and service_role
  for fn in
    select p.proname, oidvectortypes(p.proargtypes) as args, p.proacl, p.proowner
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(expected_rpcs)
  loop
    if has_function_privilege('anon', 'public.' || fn.proname || '(' || fn.args || ')', 'EXECUTE') then
      forbidden_exec := array_append(forbidden_exec, 'anon can execute ' || fn.proname);
    end if;

    if has_function_privilege('authenticated', 'public.' || fn.proname || '(' || fn.args || ')', 'EXECUTE') then
      forbidden_exec := array_append(forbidden_exec, 'authenticated can execute ' || fn.proname);
    end if;

    -- Inspect PUBLIC (ACL pseudo-role, grantee=0) through aclexplode
    if exists (
      select 1
      from aclexplode(coalesce(fn.proacl, acldefault('f'::"char", fn.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) then
      forbidden_exec := array_append(forbidden_exec, 'PUBLIC can execute ' || fn.proname);
    end if;

    if not has_function_privilege('service_role', 'public.' || fn.proname || '(' || fn.args || ')', 'EXECUTE') then
      raise exception 'FAIL service_role cannot execute %', fn.proname;
    end if;
  end loop;

  if forbidden_exec is not null and array_length(forbidden_exec, 1) > 0 then
    raise exception 'FAIL Service-only RPCs exposed to untrusted roles: %', array_to_string(forbidden_exec, '; ');
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

  begin
    perform * from sahaj_private.call_content;
    raise exception 'FAIL anon can select sahaj_private.call_content';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.voice_content;
    raise exception 'FAIL anon can select sahaj_private.voice_content';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.private_items;
    raise exception 'FAIL anon can select sahaj_private.private_items';
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

  -- Client denied access to private content tables
  begin
    perform transcript_ciphertext from sahaj_private.call_content;
    raise exception 'FAIL Client selected sahaj_private.call_content';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.voice_content;
    raise exception 'FAIL Client selected sahaj_private.voice_content';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.private_items;
    raise exception 'FAIL Client selected sahaj_private.private_items';
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
