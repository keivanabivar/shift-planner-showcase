# Architecture

## Application boundary

The web UI is a React single-page application built by Vite. Supabase supplies authentication, PostgreSQL and the Data API. There is no separate custom backend service in this snapshot.

## Organization and branch scope

Accounts authenticate through Supabase Auth. A server-managed profile connects each active account to an organization. Organization ownership controls structural administration; it does not automatically confer operational access to every branch. Branch memberships, employee assignments and visibility scope determine readable and writable planner data.

Row Level Security and scoped RPCs enforce the boundary. The browser cannot choose another tenant through a payload. Operational writes use transactions and revision checks rather than unrestricted direct table writes.

## Planner and concurrency

The planner combines employees, branch-specific templates, shifts, attendance variations and personal display preferences. Branch revisions prevent stale writes; operations spanning branches validate all affected scope. The client checks schema/protocol compatibility and the write gate before mutating data. Undo uses server-issued provenance rather than blindly overwriting a snapshot.

## Requests and archives

Employee requests have explicit status transitions, approval/reversal effects and scoped visibility. Cross-branch proposals require destination authorization. Completed months stay in the operational tables and become read-only through archive state and database guards. Exceptional editing and permanent deletion are explicit administrative actions.

JSON app backups and archive ZIP/PDF/CSV exports are different formats. Archive packages have no restore importer. Historical retention infrastructure remains in the migration sequence; it must not be activated for a showcase.

## Code map

- `src/main.jsx`: workspace composition and application flows.
- `src/branchPersistence.js`, `src/plannerStore.js`: scoped persistence and synchronization.
- `src/clientCompatibility.js`: schema/protocol/write-gate checks.
- `src/MobilePlanner.jsx`, `src/plannerSheet.js`: mobile planner interaction.
- `src/permissions.js`, `src/AccessView.jsx`, `src/BranchesView.jsx`: access and branch administration.
- `src/requests.js`, `src/requestEffects.js`: requests and resulting planner effects.
- `src/archive.js`, `src/export.js`, `src/plannerExport.js`: archive and reporting/export behavior.
- `supabase/migrations/`: ordered schema evolution.

## Verification boundary

PGlite tests reconstruct the SQL schema in isolation and use synthetic accounts. Browser checks use a mocked backend. A sanitized frozen legacy-client fixture supports compatibility regressions without any Git-history dependency. These checks cannot certify a hosted instance's configuration or real-device behavior.
