# WP-P2-UIX-039 browser evidence

Local synthetic SOLVI at `http://127.0.0.1:3000`, checked 2026-11-10.

| Browser engine | Result | Checks | WCAG 2.2 axe scans | Violations |
| --- | --- | --- | --- | --- |
| Google Chrome 157.0.8103.39 | PASS | 11 | 3 | 0 |
| Playwright WebKit 26.5 | PASS | 11 | 3 | 0 |

WebKit is engine coverage, not a claim that the installed Safari or Edge application was exercised.

The checks cover the PC template, automatic internal code, four section anchors and heading focus, live title/description and four question types, stable question keys after reorder/removal, required/length/candidate/checkbox feedback, local Enter/reset behavior, independent forms and unique IDs, desktop 1440px and mobile 375px layout/focus, pending isolation, saved preview isolation, and dirty publication guards. Preview trials sent **zero business writes**. The captured save fields matched editor FormData (with native textarea CRLF normalization), retained all seven question definitions, and excluded preview samples. No service was published and no existing service or request was changed.

The final `summary.json` files contain the assertions and sanitized network counts. The six screenshots per browser show validation feedback, desktop/mobile authoring, and the saved synthetic draft. `new-draft-desktop-viewport.png` uses a 1440×900 viewport with document and preview scroll positions reset to zero. It was recaptured read-only for Chrome after final validation. Failed-harness screenshots were removed; private diagnostic logs remain outside version control in `.local/fix-039/`.

## Synthetic draft reconciliation

- Chrome created exactly one new nonpublic draft: `01a1c59a-3398-7000-b0ed-33f21dea18c7` (`UI039-SYN-1794316574218`). An initial harness parser expected `1_code`; the observed Next wire key was `_1_code`. The initial create had completed and was reconciled through a read-only catalog listing before any retry.
- Diagnostic probes after that reconciliation were blocked **before reaching the save server**. The parser now validates all safe fields before releasing a save request. The same owned nonpublic Chrome draft was updated once to complete wire-payload and pending checks; no second Chrome draft was created. The final dirty/publication inspection resumed read-only after correcting a wait for the final `saved=1` redirect. Chrome's final summary explicitly records this continuation.
- WebKit completed the corrected tool in one run, creating one new nonpublic draft: `01a1c5a1-f483-7000-bd0b-41f148396318`. Both drafts remain nonpublic.

## Running the tool

`SOLVI_SMOKE_PASSWORD` must already be present in the process environment. The tool refuses nonlocal origins, signs in only as the synthetic `org_admin@acme.example.test`, blocks unexpected writes, and creates one nonpublic synthetic draft on a normal complete run.

```sh
rtk proxy node tools/ui_catalog_authoring_check.mjs
rtk proxy env SOLVI_UI_BROWSER=webkit node tools/ui_catalog_authoring_check.mjs
```

`SOLVI_UI_OWN_DRAFT_ID` with `SOLVI_UI_OWN_DRAFT_TITLE` supports reconciliation of an already created UI039 draft. `SOLVI_UI_RESUME_SAVED=1` additionally requires a prior summary proving that same draft's save and payload checks succeeded; it resumes only the read-only dirty/publication inspection and preserves the prior evidence, so an indeterminate action is not blindly resubmitted.
