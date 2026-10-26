# Design decisions

- **Database-enforced isolation:** organization and branch authorization must hold even if a client is modified.
- **Ownership is separate from operations:** owning an organization does not silently grant every branch's operational permissions.
- **Transactional writes and revisions:** scoped RPCs validate membership, compatibility and concurrency before changing data.
- **Historical shift snapshots:** template edits/deletions preserve the intended relationship between historical names/hours and current configuration.
- **Explicit destructive actions:** archived months are retained by default; exceptional edits and permanent deletion require deliberate administrative actions.
- **Accounts are not employees:** an account can administer a workspace without being schedulable; employee access can link to an employee record.
- **Client-side exports:** printable views and PDF/CSV/JSON packages keep exports close to the authorized workspace snapshot.
- **Responsive web interface:** desktop and small-screen browser layouts share the same scheduling and access rules. Offline reconciliation is not implemented.
- **Fresh showcase history:** source and synthetic regression fixtures are exported without operational Git history, backups or provider bindings.
