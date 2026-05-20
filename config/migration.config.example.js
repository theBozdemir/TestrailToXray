/**
 * TestRail → Xray migration configuration (TEMPLATE)
 *
 * Copy to migration.config.js (gitignored) and fill in credentials:
 *   cp config/migration.config.example.js config/migration.config.js
 *
 * TYPE LEGEND (used in comments below):
 *   string   — text URL, key, name, regex pattern
 *   number   — integer (project id, case id, days, counts, ms)
 *   boolean  — true / false
 *   string[] — array of strings (names, paths, Jira keys pattern via content)
 *   number[] — array of integers (suite ids, section ids, case ids, run ids)
 *   object   — map / dictionary (e.g. status id → label)
 */

export const config = {

  // ─── TestRail connection & case selection ─────────────────────────────────
  testRail: {
    /** string — TestRail host, no trailing slash. Example: "https://company.testrail.io" */
    baseUrl: "https://YOUR_COMPANY.testrail.io",

    /** string — Login email for API (TestRail → My Settings → API Key) */
    username: "your@email.com",

    /** string — API key (not your account password) */
    apiKey: "YOUR_TESTRAIL_API_KEY",

    /** number — TestRail project id to read cases/runs from */
    projectId: 1,

    /** number[] — Only these suite ids (empty = all suites in project) */
    suiteIds: [],

    /** number[] — Only these TestRail case ids (empty = not used; use with section filter) */
    pilotCaseIds: [],

    /** string[] — Subsection names; partial, case-insensitive. Example: ["Web App Manager"] */
    sectionNames: [],

    /** number[] — Section id(s); includes child sections. From npm run list-sections */
    sectionIds: [],

    /** string[] — Full path substring. Example: ["Master / WSC / Web App Manager"] */
    sectionPaths: [],

    /** number[] — Only import these test run ids (empty = all runs in lookback window) */
    runIds: [],

    /** number — Parallel downloads/uploads (attachments, evidence) */
    concurrency: 3,

    /** number — Milliseconds between TestRail API retries on 429/5xx */
    retryDelay: 2000,
  },

  // ─── Jira / Xray Cloud ─────────────────────────────────────────────────────
  xray: {
    /** string — Atlassian site URL */
    jiraBaseUrl: "https://YOUR_COMPANY.atlassian.net",

    /** string — Jira project key where Tests are created (e.g. "TSTSWEB") */
    jiraProjectKey: "QA",

    /** string — Xray Cloud API client id */
    clientId: "YOUR_XRAY_CLIENT_ID",

    /** string — Xray Cloud API client secret */
    clientSecret: "YOUR_XRAY_CLIENT_SECRET",

    /** string — Jira user email for REST API (attachments, links, description) */
    jiraEmail: "your@email.com",

    /** string — Jira API token from id.atlassian.com */
    jiraApiToken: "YOUR_JIRA_API_TOKEN",

    /** string — Jira issue type name for imported tests (usually "Test") */
    testIssueType: "Test",

    /** boolean — true: clear assignee after create (overrides Jira auto-assign) */
    forceUnassigned: true,

    /** string — Xray REST base URL (EU/US/AU/Global). Set after first successful run */
    apiBaseUrl: "https://eu.xray.cloud.getxray.app/api/v2",

    /** boolean — true: send priority from priorityMap on import (must match Jira names) */
    includePriority: false,

    /** string — Jira link type name for TestRail refs. Example: "verifies", "Relates" */
    issueLinkType: "verifies",

    /** boolean — true: Test on outward side of link (recommended for "verifies") */
    issueLinkTestOnOutward: true,

    /** string — Regex for Jira keys in refs field. Example: "^[A-Z][A-Z0-9]+-\\d+$" */
    refLinkPattern: "^[A-Z][A-Z0-9]+-\\d+$",

    /** string — Optional regex for defect keys (defaults to refLinkPattern) */
    // defectLinkPattern: "^[A-Z][A-Z0-9]+-\\d+$",

    /** string[] — Project keys to allow linking refs to migration project (default: skip own project) */
    refLinkAllowProjects: [],

    /** number — Tests per Xray bulk import job (1 = most reliable) */
    importBatchSize: 1,

    /** number — Max polls waiting for Xray async import job */
    jobPollAttempts: 120,

    /** number — Milliseconds between Xray job status polls */
    jobPollIntervalMs: 5000,
  },

  // ─── What to migrate ───────────────────────────────────────────────────────
  scope: {
    /** boolean — Import test cases via Xray bulk API */
    migrateTestCases: true,

    /** boolean — Download TestRail attachments and upload to Jira issues */
    migrateAttachments: true,

    /** boolean — Load get_case_fields / get_result_fields and add values to descriptions */
    includeAllCustomFields: true,

    /** boolean — Import test runs as Xray Test Executions (needs runs in TestRail) */
    migrateResults: false,

    /** number — How many days back to fetch test runs for results import */
    resultsLookbackDays: 180,

    /** boolean — Attach screenshots/files from results as Xray evidence */
    migrateResultAttachments: true,

    /** number — Max evidence files per test result */
    resultEvidenceMaxFiles: 20,

    /** number — Max total MB of evidence per result */
    resultEvidenceMaxTotalMb: 25,

    /** boolean — Link TestRail defect keys on execution import */
    migrateResultDefects: true,

    /** boolean — Skip defect keys that do not exist in Jira */
    validateResultDefects: true,
  },

  // ─── Step / description parsing (unstructured cases) ─────────────────────
  parser: {
    /** boolean — Try to parse free-text steps when no structured steps field */
    heuristicParse: true,

    /** number — 0–1; below this flags case for manual review label */
    minConfidence: 0.6,

    /** string[] — TestRail custom field system names for fallback text parsing */
    unstructuredTextFields: [
      "custom_tc_description",
      "custom_steps",
      "custom_description",
      "custom_expected",
    ],
  },

  // ─── Error handling ────────────────────────────────────────────────────────
  errors: {
    /** string — "skip" = log and continue; "stop" = abort on first fatal error */
    strategy: "skip",

    /** number — Reserved for retry logic */
    maxRetries: 3,
  },

  /** object — TestRail priority_id (number) → Jira priority name (string) */
  priorityMap: {
    1: "Highest",
    2: "High",
    3: "Medium",
    4: "Low",
  },

  /** object — TestRail status_id (number) → label (string), legacy */
  statusMap: {
    1: "PASS",
    2: "TODO",
    3: "TODO",
    4: "TODO",
    5: "FAIL",
  },

  /** object — TestRail result status_id (number) → Xray status (string): PASSED, FAILED, TODO, … */
  executionStatusMap: {
    1: "PASSED",
    2: "TODO",
    3: "TODO",
    4: "TODO",
    5: "FAILED",
  },

  /** object — TestRail type_id (number) → Xray test type (string): Manual, Automated, … */
  typeMap: {
    1: "Manual",
    2: "Automated",
    3: "Manual",
    4: "Manual",
    5: "Manual",
    6: "Manual",
    7: "Manual",
    8: "Manual",
    9: "Manual",
    10: "Manual",
  },

  /**
   * object — TestRail user id (number|string) → Jira accountId (string) for executedBy on results.
   * Empty {} = results import without assignee on execution.
   */
  userMap: {},

  /**
   * object — TestRail field name (string) → Jira field id/key (string) for direct copy on import.
   * Example: { custom_fb_title: "customfield_10001" }
   */
  customFieldMap: {},

  // ─── Output paths ──────────────────────────────────────────────────────────
  output: {
    /** string — Directory for migration-*.log and errors-*.log */
    logsDir: "./logs",

    /** string — Directory for HTML/JSON reports and TestRail field JSON dumps */
    reportsDir: "./reports",

    /** string — TestRail case id → Jira issue key (number keys stored as JSON strings) */
    idMapFile: "./reports/id-map.json",

    /** string — TestRail run ids already imported as executions */
    importedRunsFile: "./reports/imported-runs.json",
  },
};
