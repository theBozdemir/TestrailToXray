# TestRail → Xray (Jira Cloud) Migration - Created By Tarik Bozdemir

Local Node.js tool to migrate test cases (structured steps + free-text descriptions), attachments (photos/files), and optionally historical test results.


## Setup

1. **Clone and install**

```bash
git clone <your-repo-url>
cd testrail-to-xray-migration
npm install
cp config/migration.config.example.js config/migration.config.js
```

2. **Edit `config/migration.config.js`** (local only — not committed to Git):

| Setting | Where to get it |
|---------|-----------------|
| `testRail.baseUrl`, `username`, `apiKey` | TestRail → My Settings → API Key |
| `testRail.projectId` | TestRail project URL or API |
| `testRail.pilotCaseIds` | TestRail case IDs for your first sample run |
| `xray.jiraBaseUrl`, `jiraProjectKey` | Your Atlassian site |
| `xray.clientId`, `clientSecret` | Jira → Apps → Xray → Settings → API Keys |
| `xray.jiraEmail`, `jiraApiToken` | [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) |

3. **Jira priority names** — Update `priorityMap` if your Jira uses different names (`Highest`, `High`, etc.).

## Commands

```bash
# Classify cases (structured vs unstructured) — no API writes to Xray
npm run audit

# Preview what would be created
npm run dry-run

# Migrate pilot cases (uses pilotCaseIds from config)
npm run migrate

# Migrate specific IDs from CLI
node src/index.js --case-ids=101,102,103

# Import TestRail test runs as Xray Test Executions (needs id-map.json first)
npm run results-only

# Preview execution import only
node src/index.js --results-only --dry-run
```

## Recommended pilot workflow

1. Pick 5–10 TestRail cases: some with **Steps** field, some with steps only in **Description**.
2. Add their IDs to `testRail.pilotCaseIds` in config.
3. Run `npm run audit` — check `reports/report-*.html` for unstructured count.
4. Run `npm run dry-run` — verify step parsing in logs.
5. Run `npm run migrate` — creates Xray Tests + uploads attachments.
6. Review issues labeled `needs-manual-review` in Jira.
7. If good, clear `pilotCaseIds` and migrate by suite (`suiteIds`).

## Output files

| Path | Purpose |
|------|---------|
| `reports/id-map.json` | TestRail case ID → Jira issue key (required before importing results) |
| `reports/imported-runs.json` | TestRail run IDs already imported as Test Executions |
| `reports/report-*.html` | Summary + manual review list |
| `logs/migration-*.log` | Full run log |

## Idempotency

Each migrated test gets label `testrail-case-{id}`. Re-running skips cases already in `id-map.json` or found in Jira.

Test runs already imported are recorded in `reports/imported-runs.json` and skipped on the next results import.

---

## How to migrate test results (TestRail runs → Xray Test Executions)

Test results live in TestRail as **test runs**. This tool imports each run as one **Xray Test Execution** in Jira, with pass/fail (and other statuses) on each migrated test.

### Before you start

| Requirement | Details |
|-------------|---------|
| Test cases migrated | `npm run migrate` must have run successfully and created `reports/id-map.json` |
| Test runs in TestRail | At least one **completed** (or in-progress) run in the **same TestRail project** as your cases |
| Xray + Jira access | Same credentials as case migration (`xray.clientId`, `jiraApiToken`, etc.) |

If there are no test runs in TestRail, create and execute a run first (Test Runs → Add Run → include your candidate cases → record results).

---

### Step 1 — Confirm test cases are migrated

Check that `reports/id-map.json` exists and lists your cases, for example:

```json
{
  "165711": "TSTSWEB-48",
  "165712": "TSTSWEB-49"
}
```

If this file is missing, run case migration first:

```bash
npm run migrate
```

---

### Step 2 — Configure result settings (optional but recommended)

Open `config/migration.config.js` and review:

```js
scope: {
  migrateResults: false,        // leave false if you use npm run results-only
  resultsLookbackDays: 365,     // how far back to fetch TestRail runs
},

// TestRail status → Xray execution status
executionStatusMap: {
  1: "PASSED",   // Passed
  2: "TODO",     // Blocked
  3: "TODO",     // Untested
  4: "TODO",     // Retest
  5: "FAILED",   // Failed
},

// Optional: map TestRail user email → Jira account ID (for "Executed by")
userMap: {
  "user@company.com": "712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
},
```

To find a Jira account ID: Jira → Profile → or use the Jira REST API. Without `userMap`, results import without assignee (a warning is logged).

To import **only specific runs**, add TestRail run IDs:

```js
testRail: {
  runIds: [101, 102],   // empty [] = all runs in the lookback window
},
```

---

### Step 3 — Preview the import (dry run)

See which runs would be imported without writing to Jira:

```bash
npm run results-only -- --dry-run
```

Or:

```bash
node src/index.js --results-only --dry-run
```

Expected output examples:

- `Would create Test Execution for run "Sprint 12 Regression" (42) with 8 test result(s)` — ready to import
- `No TestRail test runs found in project 54` — no runs in TestRail (or outside lookback window); create runs or increase `resultsLookbackDays`

---

### Step 4 — Import test executions

```bash
npm run results-only
```

**Alternative:** import cases and results in one command:

1. Set `scope.migrateResults: true` in `config/migration.config.js`
2. Run:

```bash
npm run migrate
```

---

### Step 5 — Verify in Jira / Xray

1. Open your Jira project (e.g. **TSTSWEB**).
2. Go to **Xray → Test Executions** (or search for issues of type Test Execution).
3. You should see executions named like `TestRail: <run name>`.
4. Open an execution → check each **Test** shows status **PASSED**, **FAILED**, or **TODO** matching TestRail.
5. Open a test run in the execution → **Evidence** should list screenshots migrated from TestRail (test proofs).

Only tests that exist in `id-map.json` are included. Results for cases not migrated are skipped.

Result screenshots are imported when `scope.migrateResultAttachments` is `true` (default). They are taken from run attachments linked to each result (`result_id`) and from images embedded in result comments or step results.

Defects from TestRail results (e.g. `FB-14360`, `WSC-84` in the defects field) are linked on each **test run** inside the execution when `scope.migrateResultDefects` is `true` (default). In Xray, open the Test Execution → select a test → see **Defects** for the linked Jira bugs. Set `validateResultDefects: true` to skip keys that do not exist in Jira.

---

### Step 6 — Re-run safely (idempotent)

- Re-running `npm run results-only` **does not duplicate** executions for runs already listed in `reports/imported-runs.json`.
- To re-import a run, remove its entry from `imported-runs.json` and run again.
- New TestRail runs created after your last import are picked up automatically.

---

### Troubleshooting

| Problem | What to do |
|---------|------------|
| `No TestRail test runs found` | Add/complete a run in TestRail, or increase `resultsLookbackDays` |
| `0 test result(s)` for a run | Cases in that run were not migrated — check `id-map.json` |
| Wrong pass/fail in Xray | Adjust `executionStatusMap` to match your TestRail status IDs |
| Missing "Executed by" | Add users to `userMap` in config |
| Execution import API error | Confirm EU Xray URL in config; check `npm run test-xray` |

---

### What is not migrated (yet)

- Per-**step** result status in Xray (only whole-test status; step screenshots are attached as test-level evidence)
- Test plans or milestones (only test **runs**)

## Limitations

- Step-level result history from TestRail is imported at **test case** level, not per-step.
- Very large result attachments may be skipped (`resultEvidenceMaxTotalMb` / `resultEvidenceMaxFiles` in config).
- Heuristic parsing of description text is best-effort; low-confidence cases are flagged.
- Xray bulk import allows one job per user at a time.
- Custom Jira fields: map in `customFieldMap` after you know field keys.
