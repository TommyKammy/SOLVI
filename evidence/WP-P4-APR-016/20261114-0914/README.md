# WP-P4-APR-016 段階B Evidence (2026-11-14 09:14–09:31 JST)

## Environment

- Web: `http://127.0.0.1:3000` / API: `http://127.0.0.1:3001` (loopback only)
- Database: development `solvi` (Migration 0039). Only screen-driven writes; reads via SELECT.
- Base commit: `b3b4f4e020e719a938d1c00a11ec3fae70310086` (stage A). Stage B changes are uncommitted.
- Browsers: Chromium 157.0.8103.51 / WebKit 26.5 (Playwright headless).

## Commands

```sh
SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=chromium \
  SOLVI_UI_OUT=evidence/WP-P4-APR-016/20261114-0914/browser/chromium \
  node tools/ui_approval_routing_check.mjs

SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=webkit \
  SOLVI_UI_OUT=evidence/WP-P4-APR-016/20261114-0914/browser/webkit \
  node tools/ui_approval_routing_check.mjs

# after the first WebKit run failed on a 375px preview overflow, the layout was
# fixed and the run was repeated in a new output directory
SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=webkit \
  SOLVI_UI_OUT=evidence/WP-P4-APR-016/20261114-0914/browser/webkit-retry \
  node tools/ui_approval_routing_check.mjs
```

`*_PASSWORD` was read from the environment; the value is not stored in this directory, the
summaries or the report.

## Results

| Run | Result | Checks | axe scans | Screenshots | Cleanup |
|---|---|---|---|---|---|
| Chromium (full + resume + verify) | PASS | 28 | 40 | 41 | complete |
| WebKit (first run) | FAIL (375px preview overflow) | 3 | 5 | 5 | complete |
| WebKit (retry + verify) | PASS | 27 | 39 | 41 | complete |

The Chromium and WebKit retry summaries contain the per-screen dimensions and axe violations
(both empty), the synthetic IDs, the write counts, and the cleanup steps. The first WebKit run's
failure is recorded in `browser/webkit/summary.json` and `failure.png`; its synthetic rule was
deactivated by the automatic cleanup.

## Known gap

The browser check for the unresolved request form (brief step 8) was not completed in either
engine. The first Chromium run and the WebKit retry reached the step after the full approval
walkthrough, but the form did not render the blocked state because `approvalRoute` omitted the
rule on a failed resolution. The API and the display decision were fixed after the runs. A
re-run would need another active approval rule, and the per-engine cap (2 rules) had already
been reached, so no third rule was created. The fixed behaviour is covered by:

- `tests/unit/requests-ui.test.ts` (real `RequestForm` rendering: reason, "組織の管理者へ設定を
  依頼してください", `aria-describedby="request-route-blocked"`, disabled submit, no
  `approverId`).
- `tests/security/approval-routing.test.ts` (the read API returns `resolved:false` with the
  rule reference and the user-facing reason; inactive rules return `rule_unavailable`).

The beta-org cross-org 404 was also not reached; the same-org unrelated-user 404 was verified in
both engines (the fixed approver before step 2 exists).

## Final development-DB state

`app_user` 15, `role_binding` 21, `org_member_profile` 15 (unchanged). Increments: ticket +2,
local_catalog_item +2, local_service_request +2, local_request_revision +2,
local_request_approval +4, department +2, department_head +2, approval_rule +4,
approval_rule_revision +7, audit_event +123, session +33, local_simulation_receipt +2.
After cleanup: 0 organisations with rule routing enabled, 0 active synthetic rules, 0 active
synthetic departments, 0 open synthetic department heads, 0 profiles with a manager or primary
department. Both synthetic requests are completed.
