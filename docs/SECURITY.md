# Security boundaries

This showcase contains no hosted project binding, working credential or operational dataset. Use a separate development project and synthetic records.

## Configuration

- Public/publishable client keys identify the application; they do not replace authorization.
- All `VITE_*` values are embedded in browser code. Never use them for service-role/secret keys, passwords or private tokens.
- Organization membership is derived on the server. Preserve tenant-composite references, RLS, scoped RPC checks and the schema/protocol write gate.
- Do not enable historical anonymous/public-test access or automatic archive retention.
- Never commit session exports, invitation links, database dumps, employee exports or screenshots from a real workspace.

## Review before sharing

`.gitignore` protects common environment, backup, cache, export, signing and build paths during normal use. It does not inspect file contents and cannot prevent a forced add. Review every candidate file before a commit.

The legacy regression fixture is code-only and uses the same synthetic-data policy. Browser tests mock all backend calls; local database tests run in PGlite. A passing test does not certify a separately hosted instance.

Before a real deployment, validate tenant/branch denial, Auth mail/redirect flows, backups/restoration and operational support independently. Demonstration privacy pages must be replaced with suitable deployment-specific information.

Do not post credentials or personal records in public issues. A private reporting contact has not been selected for this showcase.
