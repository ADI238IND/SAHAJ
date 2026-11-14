-- ============================================================================
-- SAHAJ Phase 5 Core 2 Schema Rollback Script
-- Target Migration: 20261114230000_phase5_core2.sql
-- ============================================================================

begin;

-- 1. Drop RPCs and functions
drop function if exists public.core2_verify_responder_acceptance(uuid, uuid, uuid, text, text);
drop function if exists public.core2_claim_overdue_watches(text, integer, integer);
drop function if exists public.core2_safe_reassurance(uuid, uuid, text);
drop function if exists public.core2_check_watch_monotonic() cascade;

-- 2. Drop triggers
drop trigger if exists trg_core2_watch_monotonic on public.core2_late_watches;

-- 3. Drop tables (in reverse foreign-key dependency order)
drop table if exists public.core2_command_idempotency cascade;
drop table if exists public.core2_truth_line_queries cascade;
drop table if exists public.core2_sos_triggers cascade;
drop table if exists public.core2_late_watches cascade;
drop table if exists public.core2_trusted_contacts cascade;

commit;
