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

    // Set after first successful run (or if auto-detect finds EU):
    apiBaseUrl: "https://eu.xray.cloud.getxray.app/api/v2",

    // Set true only if priority names in priorityMap match your Jira scheme
    includePriority: false,

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
    migrateResults: false,
    resultsLookbackDays: 180,
  },

  parser: {
    heuristicParse: true,
    minConfidence: 0.6,
    unstructuredTextFields: [
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
  },
};
