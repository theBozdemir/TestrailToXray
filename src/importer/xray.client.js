import axios from "axios";
import { config } from "../../config/migration.config.js";

const XRAY_BASE = "https://xray.cloud.getxray.app/api/v2";

let cachedToken = null;
let tokenExpiresAt = 0;

function normalizeToken(data) {
  let token = data;
  if (typeof token === "string") {
    token = token.replace(/^"|"$/g, "").trim();
  } else if (token && typeof token === "object") {
    token = token.token ?? token.access_token ?? "";
  }
  if (!token) {
    throw new Error("Xray authenticate returned an empty token");
  }
  return token;
}

export async function authenticateXray() {
  try {
    const res = await axios.post(
      `${XRAY_BASE}/authenticate`,
      {
        client_id: config.xray.clientId,
        client_secret: config.xray.clientSecret,
      },
      { headers: { "Content-Type": "application/json" }, timeout: 30_000 }
    );
    return normalizeToken(res.data);
  } catch (e) {
    const status = e.response?.status;
    const body = e.response?.data;
    const hint =
      "Check xray.clientId and xray.clientSecret in config/migration.config.js. " +
      "Create keys in Jira → Apps → Xray → Settings → API Keys (same site as jiraBaseUrl).";
    throw new Error(
      `Xray authenticate failed${status ? ` (HTTP ${status})` : ""}: ${JSON.stringify(body) ?? e.message}. ${hint}`
    );
  }
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  cachedToken = await authenticateXray();
  tokenExpiresAt = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

async function xrayRequest(method, path, body) {
  const token = await getToken();

  try {
    const res = await axios({
      method,
      url: `${XRAY_BASE}${path}`,
      data: body,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 120_000,
    });
    return res.data;
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) {
      cachedToken = null;
      const hint =
        "Xray 401 — regenerate API keys in Xray settings, confirm Xray license is active, " +
        "and ensure keys belong to connexall.atlassian.net (not another Jira site).";
      throw new Error(`${hint} URL: ${path} — ${JSON.stringify(e.response?.data) ?? e.message}`);
    }
    throw e;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function importTestsBulk(tests) {
  const res = await xrayRequest("post", "/import/test/bulk", { tests });
  const jobId = typeof res === "string" ? res : (res.jobId ?? res.id ?? res);
  return pollImportJob(jobId, "test");
}

async function pollImportJob(jobId, kind) {
  const statusPath =
    kind === "test"
      ? `/import/test/bulk/${jobId}/status`
      : `/import/execution/${jobId}/status`;

  for (let i = 0; i < 60; i++) {
    const status = await xrayRequest("get", statusPath);
    const state = status.status ?? status.jobStatus;

    if (state === "successful" || state === "finished") {
      return status;
    }
    if (state === "failed" || state === "error") {
      throw new Error(`Xray import job ${jobId} failed: ${JSON.stringify(status)}`);
    }

    await sleep(3000);
  }

  throw new Error(`Xray import job ${jobId} timed out`);
}

export function extractKeysFromJob(jobStatus, testRailIds) {
  const map = {};
  const issues = jobStatus.issues ?? jobStatus.result?.issues ?? [];

  for (let i = 0; i < testRailIds.length; i++) {
    const issue = issues[i];
    if (issue?.key) map[testRailIds[i]] = issue.key;
  }

  return map;
}

export async function importExecution(info, tests) {
  const res = await xrayRequest("post", "/import/execution", { info, tests });
  const jobId = typeof res === "string" ? res : (res.jobId ?? res.id ?? res);
  return pollImportJob(jobId, "execution");
}
