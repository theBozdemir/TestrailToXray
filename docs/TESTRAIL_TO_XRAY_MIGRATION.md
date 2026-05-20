# TestRail to Xray Migration Tool

**Document purpose:** Confluence-ready overview of the migration solution built for Connexall.  
**Author:** Tarik Bozdemir  
**Repository:** https://github.com/theBozdemir/TestrailToXray  

---

## 1. Summary

We built a custom migration tool that moves test assets from **TestRail** into **Xray on Jira Cloud**. It is not a one-time manual copy: it runs from a script on a developer or QA machine, talks to both systems through their official APIs, and can be run again safely when new test cases are added.

The tool handles:

- Creating **Xray Test** issues in Jira with steps, descriptions, and labels  
- Uploading **attachments** (screenshots, files) from TestRail  
- Linking **references** from TestRail to existing Jira work items (e.g. feature tickets) using the **verifies** link type  
- Optionally importing **test run results** as Xray **Test Executions** (pass/fail, screenshots, defects)  
- Filtering which cases to migrate by **TestRail subsection** (for example only “Web App Manager” under WSC), so we do not need to list hundreds of case IDs by hand  

Test cases that were already migrated are skipped on the next run. A mapping file records which TestRail case became which Jira key.

---

## 2. Why we built this

TestRail holds our historical test design and execution data. Jira with Xray is where we want tests managed going forward. There is no single “export everything” button that preserves steps, images, custom fields, and run history in a way Xray accepts.

This tool fills that gap by:

1. Reading TestRail in a controlled way (project, suite, section, or pilot list)  
2. Transforming each case into the format Xray’s import API expects  
3. Fixing up Jira after import (description formatting, images, links, step attachments)  
4. Keeping a log and HTML report so the team can see what succeeded, what needs manual review, and what failed  

---

## 3. Technology used

| Layer | Technology | Role |
|--------|------------|------|
| Runtime | **Node.js** (JavaScript, ES modules) | Runs the migration on a local machine or CI agent |
| HTTP client | **axios** | Calls TestRail REST API, Jira REST API, and Xray Cloud REST API |
| Concurrency | **p-limit** | Limits parallel attachment downloads/uploads so APIs are not overloaded |
| File upload | **form-data** | Sends attachments to Jira’s attachment endpoint |
| Configuration | **JavaScript config file** (`migration.config.js`) | Credentials and behaviour; not stored in Git (secrets stay local) |
| Version control | **Git / GitHub** | Application code and documentation; example config only in the repo |

### External systems (APIs)

| System | API | What we use it for |
|--------|-----|-------------------|
| **TestRail** | REST API v2 | Cases, sections, suites, attachments, test runs, results, field definitions |
| **Xray Cloud** | REST API v2 (EU region for Connexall) | Bulk import of tests and test executions; async jobs with polling |
| **Jira Cloud** | REST API v3 | Attachments, issue description (ADF), issue links, clearing assignee |
| **Xray** | GraphQL (Cloud) | Updating manual test step expected results and step-level images after import |

No database is required. Output is written to the `reports/` and `logs/` folders on disk.

---

## 4. How a migration run works (high level)

1. **Connect** — Validate TestRail and Xray credentials; detect correct Xray region (EU).  
2. **Discover cases** — Load cases from the configured TestRail project, optionally filtered by suite, section name, or case ID list.  
3. **Classify** — For each case, decide if it uses structured steps or unstructured text (audit mode reports counts).  
4. **Transform** — Build one Xray import payload per case: summary, steps, description, labels.  
5. **Import** — Send cases to Xray one at a time (configurable batch size; default is 1 for reliability).  
6. **Map IDs** — Save TestRail case ID → Jira issue key in `id-map.json`.  
7. **Post-process** — For each new Jira issue: clear assignee if configured, upload attachments, update description with images, fix step expected results and step images, link reference tickets.  
8. **Report** — Write HTML and JSON summary; list cases flagged for manual review.  

Optional second phase: **results import** reads TestRail test runs and creates Xray Test Executions with statuses, evidence (screenshots), and linked defects.

---

## 5. Structured vs unstructured test cases

TestRail projects do not all store steps the same way. The tool treats two styles differently.

### 5.1 Structured test cases

**What this means in TestRail**

- Steps live in the dedicated **Steps** field (`custom_steps` or `custom_steps_separated`).  
- Each step has an action and usually an expected result.  
- This is the preferred format for Xray manual tests.

**What the tool does**

- Reads steps directly from TestRail.  
- Maps them into Xray’s step list (Action, Data, Expected Result).  
- Images embedded in step text are handled in a second pass: files are uploaded to Jira, and screenshots are attached to the matching Xray step (they appear below the step, not inside the Expected Result cell — that is a limitation of how Xray displays rich content).  
- The case is **not** flagged for manual review unless something else fails.

### 5.2 Unstructured test cases

**What this means in TestRail**

- Steps are written only in a long description or mixed text fields, not in the structured Steps control.  
- Common when cases were written quickly or imported from documents.

**What the tool does**

- Runs a **heuristic parser** on the combined text (description, steps field, expected field — configurable).  
- The parser looks for patterns humans often use: numbered lists, markdown tables, “Action:” / “Expected:” lines, lettered lists.  
- If it finds a usable structure, it creates steps from that text.  
- If confidence is low or no steps are found, the case still imports with a placeholder step (“See test description for steps”) and receives the Jira label **`needs-manual-review`**.  
- The HTML migration report lists these cases so QA can clean them up in Jira after import.

### 5.3 Comparison table

| Aspect | Structured | Unstructured |
|--------|------------|--------------|
| Source in TestRail | Steps field / separated steps JSON | Description and other text fields |
| Step quality in Xray | High — mirrors TestRail | Depends on parser; may need manual edit |
| Manual review label | Usually no | Often yes, when parser confidence is low |
| Description in Jira | Preconditions, TC description, custom fields, references | Same, plus “Original TestRail text” block when parser was used |

**Practical recommendation for the team:** Prefer structured steps in TestRail for new work. For legacy cases, run `npm run audit` first and plan time to review `needs-manual-review` issues in Jira.

---

## 6. Filtering by project, suite, and section

We often only want to migrate part of a TestRail project (for example everything under **Web App Manager** in the WSC area), not every case in the project.

### 6.1 TestRail hierarchy (plain terms)

- **Project** — Top level (configured with `projectId`).  
- **Suite** — Optional grouping inside a project (`suiteIds` in config).  
- **Section / subsection** — Folders inside a suite, for example “Web Services Client (WSC)” → “Web App Manager”.  
- **Case** — Individual test case with an ID (e.g. 165788).

### 6.2 How filtering works

| Method | Configuration | When to use |
|--------|---------------|-------------|
| **Whole project** | Leave `sectionNames`, `pilotCaseIds` empty | Migrate all new cases not already in `id-map.json` |
| **Subsection name** | `sectionNames: ["Web App Manager"]` | Migrate only cases in that folder (partial name match, not case-sensitive) |
| **Section ID** | `sectionIds: [12345]` | Exact folder from TestRail (includes child folders) |
| **Path text** | `sectionPaths: ["Master / WSC / Web App Manager"]` | Match full folder path as shown in TestRail |
| **Pilot case IDs** | `pilotCaseIds: [165707, 165708]` | Small trial set |
| **Command line** | `npm run migrate -- --sections="Web App Manager"` | Same as section name without editing config |

### 6.3 Finding the correct section name

Run:

```bash
npm run list-sections
```

This prints each subsection path and how many cases it contains, plus a suggested `sectionNames` value to paste into config.

**Important:** Re-running `npm run migrate` does **not** re-import cases already listed in `id-map.json`. Adding new cases in TestRail and running migrate again only picks up the new ones.

---

## 7. Descriptions, custom fields, and attachments

### 7.1 Description and custom fields

TestRail uses many **custom fields** (for example TC Description, Client, Feature Board Title, Goals). The tool:

- Loads field definitions from TestRail (`get_case_fields`) on each run.  
- Puts **TC Description** (`custom_tc_description`) in the Jira issue description.  
- Adds other non-empty custom fields as labeled sections in the description (dropdown values are shown as readable labels, not internal IDs).  
- Puts **Preconditions** in the description under a Preconditions heading (Xray does not have a separate preconditions field on Tests in our setup).

To refresh descriptions on tests that were migrated before this logic was added:

```bash
npm run repair-descriptions
```

### 7.2 Attachments and screenshots

- All case attachments are downloaded from TestRail and uploaded to the Jira issue.  
- Filenames are made unique (`image-tr{attachmentId}.png`) so multiple screenshots on one issue do not overwrite each other.  
- Images in the description are converted to Jira’s document format (ADF) so they display correctly in Cloud.  

### 7.3 References (linked work items)

If a TestRail case has **References** containing Jira keys (e.g. `FB-15442`, `WSC-84`), the tool creates an issue link from the migrated **Test** to that ticket.

- Link type is configured as **`verifies`** (lowercase — must match Jira).  
- The Test is on the “verifies” side; the reference ticket is “verified by” the test.  
- Plain numbers or non-Jira text in References are not linked automatically.  
- Keys from the migration project itself are skipped unless explicitly allowed (to avoid self-links).

---

## 8. Assignee behaviour

Some Jira projects **auto-assign** new issues. For migrated tests we usually want them **unassigned** so the team can triage.

With `forceUnassigned: true` (default in our setup):

- Import requests no assignee.  
- After creation, the tool clears assignee via Jira API.  

Already-migrated issues are not changed unless you run a full re-import or clear assignee manually in Jira.

---

## 9. Test run results (optional second phase)

Test **cases** are the test definitions. Test **runs** are execution history (passed, failed, comments, screenshots, defects).

After cases exist in Jira and `id-map.json` is populated:

```bash
npm run results-only
```

This will:

- Fetch TestRail test runs within a lookback window (default 365 days).  
- Create one **Test Execution** per run in Xray.  
- Set each test’s status (PASSED, FAILED, TODO, etc.) from TestRail.  
- Attach **evidence** (screenshots) where TestRail stored them on the result.  
- Link **defects** (Jira bug keys from the result’s defects field) on the test run in the execution.  

Runs already imported are recorded in `imported-runs.json` and skipped on the next run.

**Limitation:** Step-level pass/fail in TestRail is not recreated step-by-step in Xray; the overall test result status is imported. Step screenshots from results are attached at test level where possible.

---

## 10. Commands the team should know

| Command | Purpose |
|---------|---------|
| `npm install` | Install dependencies (once per machine) |
| `cp config/migration.config.example.js config/migration.config.js` | Create local config (add secrets locally) |
| `npm run audit` | Count structured vs unstructured cases; no changes in Jira |
| `npm run dry-run` | Preview what would be imported |
| `npm run list-sections` | List subsection names and case counts |
| `npm run migrate` | Migrate new test cases |
| `npm run repair-descriptions` | Update descriptions on already-migrated cases |
| `npm run results-only` | Import test runs as Test Executions |
| `npm run fetch-fields` | Download TestRail field definitions to `reports/` for reference |

---

## 11. Outputs and traceability

| Output | Location | Purpose |
|--------|----------|---------|
| ID map | `reports/id-map.json` | TestRail case ID → Jira key; required before results import |
| Imported runs | `reports/imported-runs.json` | TestRail runs already turned into executions |
| HTML report | `reports/report-*.html` | Summary, errors, manual review list |
| Log file | `logs/migration-*.log` | Full technical log |
| Jira label | `testrail-case-{id}` | Find any migrated test in Jira |

Every migrated test can be traced back to TestRail using the label or the ID map.

---

## 12. What is not migrated

| Item | Notes |
|------|--------|
| TestRail folder tree in Xray | Xray Cloud bulk import does not recreate TestRail’s repository folder structure |
| Test plans and milestones | Not supported |
| Case comments and edit history | Not copied |
| Numeric-only references | Only Jira keys matching the configured pattern are linked |
| Per-step execution status in Xray | Only overall test result on the execution |
| BDD/Gherkin as native Xray scenarios | BDD text may appear in description only unless a separate import path is added later |

---

## 13. Known limitations and manual follow-up

- Cases labeled **`needs-manual-review`** should be checked in Jira for step quality.  
- Very large result attachments may be skipped if they exceed configured size limits.  
- Xray allows only one bulk import job per user at a time; large migrations run sequentially.  
- Jira automations that re-assign on every update may override `forceUnassigned` unless rules are adjusted.  
- Changing link type on **already linked** issues requires manual cleanup in Jira; new migrations use **verifies** from config onward.  

---

## 14. Security and configuration

- **Secrets** (API keys, tokens) live only in `migration.config.js` on the runner’s machine. This file is **not** committed to Git.  
- The repository contains `migration.config.example.js` with placeholders and documentation comments for each setting.  
- EU Xray endpoint is used for Connexall (`https://eu.xray.cloud.getxray.app/api/v2`).  

---

## 15. Suggested Confluence page structure

When pasting into Confluence, you can use this outline:

1. Overview (Section 1–2)  
2. Architecture and technology (Sections 3–4)  
3. Test case types: structured vs unstructured (Section 5)  
4. Scoping migrations by section (Section 6)  
5. Descriptions, attachments, references (Section 7)  
6. Test execution import (Section 9)  
7. How to run (Section 10)  
8. Limitations (Sections 12–13)  
9. Link to GitHub repository  

---

## 16. Contact and maintenance

- **Repository:** https://github.com/theBozdemir/TestrailToXray  
- **Changes** are made in the Node.js project under `src/`; config drives behaviour without code changes for most scenarios.  
- For new TestRail custom fields, the tool generally picks them up automatically after `get_case_fields` runs; optional `customFieldMap` in config maps fields directly to Jira custom fields if needed.  

---

*End of document — suitable for copy into Confluence as a single page or split into child pages per section.*
