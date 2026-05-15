#!/usr/bin/env node
/**
 * Quick Xray + Jira auth check — run: npm run test-xray
 */
import axios from "axios";
import { config } from "../config/migration.config.js";
import { resolveXrayRegion } from "./importer/xray.client.js";

const { jiraBaseUrl, jiraEmail, jiraApiToken, jiraProjectKey, clientId, clientSecret } =
  config.xray;

console.log("Testing Xray + Jira connection…\n");

// 1) Xray authenticate
try {
  const base = await resolveXrayRegion();
  console.log("✓ Xray region + authenticate OK");
  console.log(`  API base: ${base}`);
} catch (e) {
  console.error("✗", e.message);
  process.exit(1);
}

// 2) Jira API (for attachments + search)
try {
  const res = await axios.get(`${jiraBaseUrl}/rest/api/3/myself`, {
    auth: { username: jiraEmail, password: jiraApiToken },
    timeout: 15_000,
  });
  console.log(`✓ Jira API OK — logged in as ${res.data.displayName}`);
} catch (e) {
  console.error("✗ Jira API failed:", e.response?.status ?? e.message);
  console.error("  Fix xray.jiraEmail and xray.jiraApiToken (Atlassian API token, not Xray keys)");
  process.exit(1);
}

// 3) Project exists
try {
  const res = await axios.get(`${jiraBaseUrl}/rest/api/3/project/${jiraProjectKey}`, {
    auth: { username: jiraEmail, password: jiraApiToken },
    timeout: 15_000,
  });
  console.log(`✓ Jira project "${jiraProjectKey}" exists — ${res.data.name}`);
} catch (e) {
  console.error(`✗ Project "${jiraProjectKey}" not found or no access`);
  process.exit(1);
}

// 4) Test issue type
try {
  const res = await axios.get(
    `${jiraBaseUrl}/rest/api/3/issue/createmeta?projectKeys=${jiraProjectKey}&expand=projects.issuetypes`,
    { auth: { username: jiraEmail, password: jiraApiToken }, timeout: 15_000 }
  );
  const types = res.data.projects?.[0]?.issuetypes ?? [];
  const testType = types.find(
    (t) => t.name.toLowerCase() === config.xray.testIssueType.toLowerCase()
  );
  if (testType) {
    console.log(`✓ Issue type "${config.xray.testIssueType}" is available`);
  } else {
    console.warn(
      `⚠ Issue type "${config.xray.testIssueType}" not found. Available: ${types.map((t) => t.name).join(", ")}`
    );
    console.warn("  Update xray.testIssueType in config if needed (often \"Test\")");
  }
} catch (e) {
  console.warn("⚠ Could not verify issue types:", e.message);
}

console.log("\nIf all checks pass, run: npm run migrate");
console.log(`\nclientId: ${clientId?.slice(0, 8)}… (${clientId?.length ?? 0} chars)`);
console.log(`clientSecret: ${clientSecret ? "*** set ***" : "MISSING"}`);
