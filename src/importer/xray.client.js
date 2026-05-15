import axios from "axios";
import { config } from "../../config/migration.config.js";
import { logger } from "../utils/logger.js";

const XRAY_BASE = "https://xray.cloud.getxray.app/api/v2";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await axios.post(
    `${XRAY_BASE}/authenticate`,
    {
      client_id: config.xray.clientId,
      client_secret: config.xray.clientSecret,
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30_000 }
  );

  cachedToken = typeof res.data === "string" ? res.data : res.data.token;
  tokenExpiresAt = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

async function xrayRequest(method, path, body) {
  const token = await getToken();
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

/**
 * Map imported tests back to TestRail IDs using label testrail-case-{id}.
 * @param {object} jobStatus
 * @param {number[]} testRailIds  ordered list matching import batch
 * @returns {Record<number, string>}
 */
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
