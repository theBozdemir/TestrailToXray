#!/usr/bin/env node
/**
 * Quick TestRail auth check — run: npm run test-testrail
 */
import axios from "axios";
import { config } from "../config/migration.config.js";

const { baseUrl, username, apiKey } = config.testRail;

console.log("Testing TestRail connection…");
console.log("  baseUrl:", baseUrl);
console.log("  username:", username);
console.log("  apiKey:", apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)} (${apiKey.length} chars)` : "(empty)");

try {
  const res = await axios.get(`${baseUrl}/index.php?/api/v2/get_projects`, {
    auth: { username, password: apiKey },
    headers: { "Content-Type": "application/json" },
    timeout: 15_000,
  });

  const projects = Array.isArray(res.data) ? res.data : (res.data.projects ?? []);
  console.log("\n✓ Authentication OK");
  console.log(`  Found ${projects.length} project(s):`);
  for (const p of projects.slice(0, 10)) {
    console.log(`    - id=${p.id}  name="${p.name}"`);
  }
  const match = projects.find((p) => p.id === config.testRail.projectId);
  if (match) {
    console.log(`\n✓ projectId ${config.testRail.projectId} exists: "${match.name}"`);
  } else {
    console.log(`\n⚠ projectId ${config.testRail.projectId} not in list — pick id from above`);
  }
} catch (e) {
  const status = e.response?.status;
  const body = e.response?.data;
  console.error("\n✗ Connection failed");
  console.error("  HTTP status:", status ?? "no response");
  console.error("  Message:", body?.error ?? e.message);

  if (status === 401) {
    console.error(`
Common fixes for 401 on TestRail Cloud:
  1. My Settings → API Key → Generate → click SAVE SETTINGS (required!)
  2. Use apiKey as password, not your login password
  3. username must be exactly: ${username}
  4. Regenerate key if you copied it before saving
  5. Ask admin: Administration → Site Settings → API is enabled
`);
  }
  process.exit(1);
}
