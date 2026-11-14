# Sahaj — Core 1 Pulse · Milestone 1 starter

**Scope:** Windows-friendly `pnpm` monorepo baseline for the API. This is a safe **foundation scaffold**, not a deployed or production-ready care service.

## Verified behavior

- `GET /api/health` returns HTTP 200 and describes the current scaffold status.
- `POST /api/sarvam/tool/ping` checks a bearer token securely and returns a safe test response.
- `POST /api/cron/tick` checks `x-cron-secret` and returns a *no-work-performed* scaffold response.
- `GET /api/whatsapp` handles Meta's verification challenge.
- `POST /api/whatsapp` verifies Meta's SHA-256 signature, then responds HTTP 503 until event storage is implemented. **Do not connect a production WhatsApp webhook yet.**
- `POST /api/sarvam/post-call/[secret]` and `POST /api/missed-call/[secret]` validate their URL secret and respond 503 until provider cross-checks and persistence are implemented. **Do not connect real providers yet.**
- `POST /api/twilio/voice/test` returns HTTP 501 until signature/TwiML handling is implemented.
- `infra/supabase/migrations/20261114_0001_foundation.sql` creates starter tables with RLS enabled. No client read/write policies are granted.

## Requirements

Windows PowerShell, Node.js 22.13+ (v24 is fine), Git, pnpm 12, Supabase project, optional Vercel.

## Local quickstart

1. Clone your empty GitHub repository and extract the **contents** of this ZIP into its root (do not replace `.git`).
2. From repository root: `pnpm install`.
3. Copy `apps/api/.env.example` to `apps/api/.env.local`.
4. Use `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` to generate **different** secret values for `SARVAM_TOOL_BEARER`, `SARVAM_HOOK_SECRET`, `MISSEDCALL_HOOK_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `CRON_SECRET`. Store secrets locally only.
5. `pnpm dev`.
6. Visit `http://localhost:3000/api/health`. Run `powershell -ExecutionPolicy Bypass -File scripts/check.ps1` from root.
7. Run `pnpm test` for the secret-comparison unit tests.
8. After reviewing the SQL, use Supabase SQL Editor to execute `infra/supabase/migrations/20261114_0001_foundation.sql`, once, against the **dedicated Sahaj project**.
9. Fill `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` locally or in Vercel server env only; these are not used by initial stub routes. Never publish the service role key.
10. Commit and push using a GitHub account with write permission. Configure Vercel Root Directory: `apps/api`.

## Gate to the NEXT milestone

The foundation is **not complete** yet. Before connecting real phone numbers or WhatsApp recipients, implement and verify:
- signed webhooks/provider IDs with persistence and replay defenses;
- family-scoped auth and test RLS policies;
- LangGraph with PostgresSaver and real cron resume;
- provider-call sandbox tests; server-side signing and Cedar permission policies;
- no false-success on missed calls or emergencies.

## Security

- Never put `.env.local` in Git.
- Repo should be **private** for the team.
- No personal phone numbers, OTPs, recording files, medicine records, or real family information in tests, AI prompts, Git commits or logs.
- Do not deploy this baseline as a functioning emergency-response product.
