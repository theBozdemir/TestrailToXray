# TestRail → Xray (Jira Cloud) Migration

Local Node.js tool to migrate test cases (structured steps + free-text descriptions), attachments (photos/files), and optionally historical test results.

## Your questions answered

| Question | Answer |
|----------|--------|
| **Will we lose previous test run results?** | Not if you migrate them. TestRail history does not appear in Xray automatically. This project can import results into Xray Test Executions (see `results-only`). Without that step, TestRail remains your archive. |
| **Can we migrate test cases with photos/attachments?** | Yes. Attachments are downloaded from TestRail and uploaded to the matching Jira/Xray issue. |
| **Is this doable?** | Yes. Mixed formats (steps field vs description) are handled by a parser + manual-review queue. Expect some cases to need human cleanup. |

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

# Import historical results (needs reports/id-map.json from case migration first)
npm run results-only
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
| `reports/id-map.json` | TestRail case ID → Jira issue key (for results migration) |
| `reports/report-*.html` | Summary + manual review list |
| `logs/migration-*.log` | Full run log |

## Idempotency

Each migrated test gets label `testrail-case-{id}`. Re-running skips cases already in `id-map.json` or found in Jira.

## Limitations

- Step-level result history from TestRail is imported at **test case** level, not per-step.
- Heuristic parsing of description text is best-effort; low-confidence cases are flagged.
- Xray bulk import allows one job per user at a time.
- Custom Jira fields: map in `customFieldMap` after you know field keys.
