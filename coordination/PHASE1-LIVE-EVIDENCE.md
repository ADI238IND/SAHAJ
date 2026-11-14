# Phase 1 live evidence — 2026-11-14

Parent checks against the configured dedicated Supabase project and Vercel deployment. These are foundation checks, not phone/emergency acceptance.

- Root checkpoint465fe55: frozen workspace installs succeeded; all package typechecks,311 tests and production build passed.
- Production deployment dpl_HKja81kKsmHDfuoNHUQTFj1TRoRH READY; protected GET /api/health200. Existing endpoint is liveness/scaffold only; readiness is still an implementation gap.
- Hosted rollback tests core1_security.sql, signed_timeline.sql and checkpoint_media_metadata.sql executed successfully after the latest foundation migration. Fixtures rolled back.
- Metadata checks: every table in public/sahaj_private/sahaj_checkpoints has RLS enabled; all three care buckets private; browser roles lack checkpoint schema usage; dedicated runtime has no database CREATE; synthetic family and three synthetic people present.
- Both anon/authenticated denied execution on BOTH media metadata RPCs. Both roles lack SELECT on call_content, voice_content and private_items.
- Important test distinction: authenticated intentionally has USAGE on sahaj_private for has_role/is_person authorization helpers used by RLS; anon has no usage. Do not revoke that usage or falsely require authenticated USAGE=false. The private schema remains outside PostgREST exposure and content tables have no browser grants/policies.
- GitHub connector rechecked ADI238IND/SAHAJ visibility: public staging repository. No visibility changes made. Only synthetic data/code; secrets remain ignored.

Remaining Phase1 closure: Antigravity bounded readiness implementation and failure/recovery tests; expanded rollback acceptance suite; final integrated SHA local/deployed readiness evidence. Do not mark100% until these pass.
