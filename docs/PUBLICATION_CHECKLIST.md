# Publication checklist

This is a review checklist, not authorization to publish.

1. Keep the approved policy: no open-source license is granted. Confirm rights to code, dependencies and visual assets before publication.
2. Preserve the approved README attribution to Kappauno, public contact and decision to provide no public demo.
3. Keep the original operational guide, backups, Auth exports and unreviewed operational screenshots out. Only the reviewed sanitized Italian guide is included; use fictional data for any new screenshots.
4. Install from the lockfile and run the documented unit, browser/mobile and build checks in this independent directory.
5. Inspect all candidate files, the ignore rules and the eventual staged diff. Confirm no environment file, key, database/export, personal signing state or generated artifact is included.
6. Configure the intended Git author identity before the first commit. No original Git history or provider remote belongs here.
7. Create a new empty GitHub repository only after owner approval. Avoid importing the operational repository or attaching deployment integrations.
8. Review the exact initial commit and remote before the first push. Publishing, deployment and database setup require separate decisions.

The package is intentionally marked private to prevent accidental package-registry publication. That flag does not control GitHub visibility or grant a source license.
