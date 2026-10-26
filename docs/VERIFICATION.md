# Verification snapshot

Checked locally on 2026-10-26 after the web-only showcase cleanup. These results do not certify a hosted service.

| Check | Result |
| --- | --- |
| Independent dependency install | Passed with the frozen lockfile. |
| Unit and isolated database suite | 298 passed, 0 failed. PGlite, synthetic fixtures only. |
| Web production build | Passed. One JavaScript bundle remains above Vite's 500 kB advisory threshold. |
| Auth/access, planner, compatibility and mobile browser checks | Passed in one combined mocked-backend run. Desktop plus compact and wide mobile-browser portrait and landscape viewports. |
| Publication-tree safety scan | No real credential, production identifier, private address, user export or backup artifact detected after review. Deliberately fake test keys/URLs are documented in the sample-data policy. |
| Initial snapshot boundary | Independent local repository on `main`; no copied private history, tags or remotes. First local commit authorized; push and deployment are not authorized. |

The current web-only snapshot passed a fresh frozen-lockfile install, all 298 unit/database tests, the combined browser suite and the production build. The browser fixture path helper also supports project directories containing spaces.

The source package excludes dependencies, generated web assets, build output and browser screenshots. Recreate them with the documented installation/build commands. Ignore rules are safeguards for normal use, not a substitute for reviewing contents before a commit.

The ordered SQL migration sequence is retained. Its compatibility warning uses web-only wording; protocol, authorization and write-gate behavior are unchanged. Application scheduling/persistence behavior is preserved; public information pages, contact defaults, sample labels and the test-history dependency were adapted for the showcase.

Approved public identity: Kappauno, with the public contact listed in the README. No open-source license is granted and no public demo is provided. The sanitized Italian guide has been reviewed. No publication or deployment has occurred.
