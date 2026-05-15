import axios from "axios";
import FormData from "form-data";
import { config } from "../../config/migration.config.js";
import { logger } from "../utils/logger.js";

const { jiraBaseUrl, jiraEmail, jiraApiToken } = config.xray;

const client = axios.create({
  baseURL: `${jiraBaseUrl}/rest/api/3`,
  auth: { username: jiraEmail, password: jiraApiToken },
  headers: { Accept: "application/json" },
  timeout: 30_000,
});

export async function findExistingTestByLabel(testRailCaseId) {
  const label = `testrail-case-${testRailCaseId}`;
  const jql = `project = ${config.xray.jiraProjectKey} AND labels = "${label}"`;

  try {
    // POST /search removed on Jira Cloud (410) — use /search/jql
    const res = await client.get("/search/jql", {
      params: {
        jql,
        maxResults: 1,
        fields: "key",
      },
    });

    const issues = res.data.issues ?? res.data.values ?? [];
    return issues[0]?.key ?? null;
  } catch (e) {
    const status = e.response?.status;
    logger.recordWarning(
      `jira.search(${testRailCaseId})`,
      status ? `HTTP ${status}: ${e.response?.data?.errorMessages?.join?.(" ") ?? e.message}` : e.message
    );
    return null;
  }
}

export async function uploadAttachment(issueKey, filename, buffer, contentType) {
  const form = new FormData();
  form.append("file", buffer, { filename, contentType });

  await client.post(`/issue/${issueKey}/attachments`, form, {
    headers: {
      ...form.getHeaders(),
      "X-Atlassian-Token": "no-check",
    },
    maxBodyLength: Infinity,
  });
}
