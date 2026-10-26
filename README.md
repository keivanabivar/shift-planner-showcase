# Shift Planner

A multi-branch workforce planner with an Italian interface, built with React and Supabase. It brings shift scheduling, staff requests, attendance changes and reporting into a shared workspace for small organizations.

This is a sanitized portfolio snapshot. It contains no production accounts, credentials, backups or user exports.

## What it does

- Plan shifts by day, week or month, with range edits, drag/copy, reusable templates and Undo.
- Manage multiple **Sedi** (branches), employee assignments and branch-specific shift templates.
- Separate organization ownership from branch administration and operational access. Viewer/employee access is limited by assigned scope.
- Review employee requests and cross-branch proposals, including approval, rejection and reversal.
- Track attendance variations and compare planned and actual hours.
- Keep completed months in a read-only archive, with explicit administrative edit/delete flows.
- Export print layouts, PDF, CSV, JSON and archive packages.
- Use a responsive planner in desktop and mobile web browsers.

## Stack and architecture

React 19 · Vite 7 · Supabase Auth/PostgreSQL · Row Level Security · jsPDF · Node test runner · PGlite · Playwright.

```text
React web application
                |
       Supabase Auth + scoped RPCs
                |
 PostgreSQL: tenant/branch authorization,
 revisions, transactions and archive guards
```

The browser uses a public client key. Tenant identity and write permissions are checked on the server. There is no custom application server in this snapshot.

## Run locally

Use Node.js 22.12+ and pnpm. Install dependencies and create your own local configuration:

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Configure a **separate development** Supabase project with synthetic data:

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_SUPPORT_EMAIL=support@example.invalid
```

Blank backend values show the configuration screen; they do not provide a working planner or an offline demo. Never put a secret/service-role key in a `VITE_*` variable. See [setup](docs/SETUP.md) for the backend requirements.

```sh
pnpm test
pnpm build
pnpm test:auth-ui
pnpm test:mobile
```

Unit/database tests use synthetic fixtures and isolated PGlite. Browser tests mock the backend and block external application requests. They require Chrome or a compatible installed Playwright browser.

## Status and limitations

This is a development showcase, not a turnkey hosted service. The database migrations and protocol checks are included; no production configuration is supplied.

- The planner requires an independently configured backend; offline planning/synchronization is not implemented.
- Archive ZIP exports are **not** restorable through the app. Automatic retention deletion must remain disabled.
- Email delivery, redirect settings, recovery and production authorization require testing in each independent deployment.
- Self-service account deletion and multi-organization account switching are not implemented.
- Informational/privacy pages are demonstration placeholders, not deployment-ready legal documents.

## Screenshots

The Italian user guide includes reviewed illustrative screenshots with identifying fields neutralized.

## Italian user guide

[Guida rapida in italiano (PDF)](docs/SHIFT_PLANNER_Guida_Rapida_IT.pdf)

Italian-language user guide with sanitized illustrative screenshots. The original 14-page layout is preserved; identifying fields are neutralized and no production URL or active support contact is included. Examples describe the October 2026 interface.

## Demo

No public demo is currently provided.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Setup and backend boundaries](docs/SETUP.md)
- [Design decisions](docs/DESIGN_DECISIONS.md)
- [Security boundaries](docs/SECURITY.md)
- [Sample-data policy](docs/SAMPLE_DATA.md)
- [Publication checklist](docs/PUBLICATION_CHECKLIST.md)
- [Verification snapshot](docs/VERIFICATION.md)

## Built by

Created and maintained by **Kappauno**.

Contact: [leobarbotoy@gmail.com](mailto:leobarbotoy@gmail.com)

## Licensing

No open-source license has been granted for this project. Dependencies retain their respective licenses.
