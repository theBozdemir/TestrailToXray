import axios from "axios";
import FormData from "form-data";
import { config } from "../../config/migration.config.js";
import { logger } from "../utils/logger.js";
import { descriptionToAdf } from "../utils/jira-adf.js";

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

export async function getIssueAttachments(issueKey) {
  const res = await client.get(`/issue/${issueKey}`, {
    params: { fields: "attachment" },
  });
  return (res.data.fields?.attachment ?? []).map((a) => ({
    id: a.id,
    filename: a.filename,
  }));
}

export async function getIssueAttachmentNames(issueKey) {
  const attachments = await getIssueAttachments(issueKey);
  return attachments.map((a) => a.filename);
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

export async function updateIssueDescription(issueKey, description, attachments = []) {
  const filenameToId = Object.fromEntries(
    attachments.map((a) => [a.filename, a.id])
  );
  const adf = descriptionToAdf(description, filenameToId);
  if (!adf) return;

  await client.put(`/issue/${issueKey}`, {
    fields: { description: adf },
  });
}

/**
 * Link this issue to related tests (e.g. TestRail references).
 * @param {string} fromKey
 * @param {string[]} toKeys
 */
export async function linkIssues(fromKey, toKeys) {
  const linkType = config.xray.issueLinkType ?? "Relates";

  for (const toKey of toKeys) {
    if (!toKey || toKey === fromKey) continue;
    try {
      await client.post("/issueLink", {
        type: { name: linkType },
        inwardIssue: { key: fromKey },
        outwardIssue: { key: toKey },
      });
      logger.info(`Linked ${fromKey} ↔ ${toKey}`);
    } catch (e) {
      const msg = e.response?.data?.errorMessages?.join?.(" ") ?? e.message;
      logger.recordWarning(`jira.link(${fromKey}->${toKey})`, msg);
    }
  }
}

/**
 * Extract Jira keys from TestRail refs for Linked work items.
 * Default: PROJECT-123 (letters + hyphen + digits), e.g. FB-1, WSC-99, SAC-100.
 * Skips keys from the migration project (e.g. TSTSWEB-48) unless listed in refLinkAllowProjects.
 * @param {string} refs  TestRail references field
 */
export function resolveRefKeys(refs) {
  if (!refs?.trim()) return [];

  const patternSource = config.xray.refLinkPattern ?? "^[A-Z][A-Z0-9]+-\\d+$";
  const pattern = new RegExp(patternSource, "i");
  const migrateProject = config.xray.jiraProjectKey?.toUpperCase();
  const allowProjects = new Set(
    (config.xray.refLinkAllowProjects ?? []).map((p) => String(p).toUpperCase())
  );
  const keys = new Set();

  const tokens = refs.split(/[,;]+/).flatMap((t) => t.trim().split(/\s+/)).filter(Boolean);

  for (const tok of tokens) {
    const matches = tok.match(/\b([A-Z][A-Z0-9]+-\d+)\b/gi) ?? [];
    for (const match of matches) {
      const key = match.toUpperCase();
      if (!pattern.test(key)) continue;

      const project = key.split("-")[0];
      if (migrateProject && project === migrateProject && !allowProjects.has(project)) {
        continue;
      }

      keys.add(key);
    }
  }

  return [...keys];
}
