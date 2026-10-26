# Local setup

## Requirements

Use Node.js 22.12+ and pnpm. The committed lockfile specifies dependencies. Browser checks require Chrome by default; `PLAYWRIGHT_CHANNEL` can select another available channel.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Only `.env.example` belongs in Git. Its backend fields are intentionally blank. A development server can render the missing-configuration screen without a backend; a usable planner requires an independent Supabase project.

## Independent backend

Create a new disposable development project with **synthetic data only**. Do not connect this showcase to an operational database or reuse any original deployment settings.

The isolated database tests construct migrations 001–030 in numeric order; see `supabase/tests/schema.mjs`. The SQL files are source history for database evolution, not a production backup or a provider configuration export. Tests stub the Auth environment and do not configure a hosted Auth service.

Before applying the sequence to your own disposable hosted project, review the SQL, verify its extensions/Auth assumptions, and confirm the target is empty. This showcase supplies no automatic migration/deployment command. Never rerun an applied migration merely to check whether it exists. Do not enable the historical automatic-retention job.

Migration 030 deliberately starts with the write gate closed. Isolated tests enable it only inside their disposable database. A separately hosted instance needs its own compatibility checks and a deliberate gate-opening decision; installing the frontend does not enable writes.

Configure a public publishable key and project URL in your own ignored `.env.local`:

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_SUPPORT_EMAIL=support@example.invalid
```

All `VITE_*` values become browser-visible. Secret/service-role keys, database passwords, SMTP credentials and access tokens must never be placed there.

For a working hosted development instance, independently configure email confirmation, site/redirect allowlists, recovery and invitation flows. Use development-only accounts. This source snapshot does not establish those settings for you.

## Checks

```sh
pnpm test
pnpm build
pnpm test:auth-ui
pnpm test:mobile
```

The database tests use in-memory PGlite. Browser tests pass an explicit fake configuration, intercept Auth/data calls and block other application network requests. They never load `.env.local`. Browser scripts may create ignored screenshots/exports under `work/`.

## No automatic deployment

No production URL, provider project binding, remote, CI deployment workflow or Git history accompanies this snapshot. Add deployment configuration only after reviewing the licensing and privacy decisions.
