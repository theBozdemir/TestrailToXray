// Copy to migration.config.js and fill in your credentials:
//   cp config/migration.config.example.js config/migration.config.js

export const config = {

  testRail: {
    baseUrl: "https://YOUR_COMPANY.testrail.io",
    username: "your@email.com",
    apiKey: "YOUR_TESTRAIL_API_KEY",
    projectId: 1,
    suiteIds: [],
    pilotCaseIds: [],
    // Filter by TestRail subsection name (partial match, case-insensitive). Example: ["Web App Manager"]
    sectionNames: [],
    // Or filter by section id(s) — includes all cases in that section and child sections
    sectionIds: [],
    // Or full path substring: ["WSC / Web App Manager"]
    sectionPaths: [],
    // Optional: only import these TestRail run IDs (empty = all runs in lookback)
    runIds: [],
    concurrency: 3,
    retryDelay: 2000,
  },

  xray: {
    jiraBaseUrl: "https://YOUR_COMPANY.atlassian.net",
    jiraProjectKey: "QA",
    clientId: "YOUR_XRAY_CLIENT_ID",
    clientSecret: "YOUR_XRAY_CLIENT_SECRET",
    jiraEmail: "your@email.com",
    jiraApiToken: "YOUR_JIRA_API_TOKEN",
    testIssueType: "Test",

    // Keep migrated tests unassigned (clears Jira auto-assign after create)
    forceUnassigned: true,

    // Set after first successful run (or if auto-detect finds EU):
    apiBaseUrl: "https://eu.xray.cloud.getxray.app/api/v2",

    // Set true only if priority names in priorityMap match your Jira scheme
    includePriority: false,

    // Jira issue link type for TestRail refs (must exist in your Jira project)
    issueLinkType: "verifies",
    // true = migrated Test on "verifies" side (outward), ref on inward — default for Verifies
    issueLinkTestOnOutward: true,

    // Only matching refs become Linked work items (PROJECT-123, e.g. FB-1, WSC-99, SAC-100)
    refLinkPattern: "^[A-Z][A-Z0-9]+-\\d+$",
    // Optional: pattern for defect keys (defaults to refLinkPattern)
    // defectLinkPattern: "^[A-Z][A-Z0-9]+-\\d+$",
    // Optional: also link refs to your migration project (default: TSTSWEB keys are skipped)
    refLinkAllowProjects: [],

    // Tests per Xray bulk job (1 = most reliable for pilot)
    importBatchSize: 1,
    jobPollAttempts: 120,
    jobPollIntervalMs: 5000,

    // If you get "Xray data is in another region", set your regional API base:
    // Global: https://xray.cloud.getxray.app/api/v2
    // EU:     https://eu.xray.cloud.getxray.app/api/v2
    // US:     https://us.xray.cloud.getxray.app/api/v2
    // AU:     https://au.xray.cloud.getxray.app/api/v2
    // apiBaseUrl: "https://eu.xray.cloud.getxray.app/api/v2",
  },

  scope: {
    migrateTestCases: true,
    migrateAttachments: true,
    // Fetch get_case_fields / get_result_fields on each run and include values in descriptions
    includeAllCustomFields: true,
    // Import TestRail test runs as Xray Test Executions (requires runs in TestRail)
    migrateResults: false,
    resultsLookbackDays: 180,
    // Screenshots / proof attachments on results → Xray execution evidence
    migrateResultAttachments: true,
    resultEvidenceMaxFiles: 20,
    resultEvidenceMaxTotalMb: 25,
    // TestRail result defects (e.g. FB-123, WSC-99) → Xray defects on each test run
    migrateResultDefects: true,
    // Skip defect keys that do not exist in Jira (avoids import failures)
    validateResultDefects: true,
  },

  parser: {
    heuristicParse: true,
    minConfidence: 0.6,
    unstructuredTextFields: [
      "custom_tc_description",
      "custom_steps",
      "custom_description",
      "custom_expected",
    ],
  },

  errors: {
    strategy: "skip",
    maxRetries: 3,
  },

  priorityMap: {
    1: "Highest",
    2: "High",
    3: "Medium",
    4: "Low",
  },

  statusMap: {
    1: "PASS",
    2: "TODO",
    3: "TODO",
    4: "TODO",
    5: "FAIL",
  },

  // TestRail status_id → Xray execution status (PASSED, FAILED, TODO, EXECUTING, …)
  executionStatusMap: {
    1: "PASSED",
    2: "TODO",
    3: "TODO",
    4: "TODO",
    5: "FAILED",
  },

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

  userMap: {},
  customFieldMap: {},

  output: {
    logsDir: "./logs",
    reportsDir: "./reports",
    idMapFile: "./reports/id-map.json",
    importedRunsFile: "./reports/imported-runs.json",
  },
};
