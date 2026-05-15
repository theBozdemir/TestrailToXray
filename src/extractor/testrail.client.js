import axios from "axios";
import { config } from "../../config/migration.config.js";
import { logger } from "../utils/logger.js";

const { baseUrl, username, apiKey, retryDelay } = config.testRail;

const client = axios.create({
  baseURL: `${baseUrl}/index.php?/api/v2`,
  auth: { username, password: apiKey },
  headers: { "Content-Type": "application/json" },
  timeout: 30_000,
});

client.interceptors.response.use(null, async (err) => {
  const status = err.response?.status;
  const retries = err.config._retries ?? 0;

  if ((status === 429 || status >= 500) && retries < 4) {
    const delay = retryDelay * (retries + 1);
    logger.warn(`TestRail ${status} — retrying in ${delay}ms (attempt ${retries + 1})`);
    await sleep(delay);
    err.config._retries = retries + 1;
    return client.request(err.config);
  }
  return Promise.reject(err);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function get(endpoint) {
  const res = await client.get(endpoint);
  return res.data;
}

async function getPaginated(endpoint, arrayKey, limit = 250) {
  const results = [];
  let offset = 0;

  while (true) {
    const data = await get(`${endpoint}&limit=${limit}&offset=${offset}`);
    const page = Array.isArray(data) ? data : (data[arrayKey] ?? []);
    results.push(...page);
    if (page.length < limit) break;
    offset += limit;
    await sleep(200);
  }

  return results;
}

export async function getSuites(projectId) {
  logger.info(`Fetching suites for project ${projectId}…`);
  return get(`/get_suites/${projectId}`);
}

export async function getSections(projectId, suiteId) {
  logger.info(`Fetching sections for suite ${suiteId}…`);
  return getPaginated(`/get_sections/${projectId}&suite_id=${suiteId}`, "sections");
}

export async function getCases(projectId, suiteId) {
  logger.info(`Fetching test cases for suite ${suiteId}…`);
  return getPaginated(`/get_cases/${projectId}&suite_id=${suiteId}`, "cases");
}

export async function getRuns(projectId) {
  const lookback = config.scope.resultsLookbackDays ?? 180;
  const cutoff = Math.floor(Date.now() / 1000) - lookback * 86400;
  logger.info(`Fetching test runs (last ${lookback} days)…`);
  return getPaginated(`/get_runs/${projectId}&created_after=${cutoff}`, "runs");
}

export async function getResults(runId) {
  return getPaginated(`/get_results_for_run/${runId}`, "results");
}

export async function getAttachmentsForCase(caseId) {
  try {
    const data = await get(`/get_attachments_for_case/${caseId}`);
    return Array.isArray(data) ? data : (data.attachments ?? []);
  } catch (e) {
    logger.recordWarning(`getAttachments(${caseId})`, e.message);
    return [];
  }
}

export async function downloadAttachment(attachmentId) {
  const res = await client.get(`/get_attachment/${attachmentId}`, {
    responseType: "arraybuffer",
  });
  return {
    buffer: Buffer.from(res.data),
    contentType: res.headers["content-type"] ?? "application/octet-stream",
  };
}

export async function getCase(caseId) {
  return get(`/get_case/${caseId}`);
}
