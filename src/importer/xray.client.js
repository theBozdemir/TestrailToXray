import axios from "axios";
import { config } from "../../config/migration.config.js";
import { logger } from "../utils/logger.js";

/** Xray Cloud regional endpoints (Data Residency). */
export const XRAY_REGION_BASES = [
  "https://xray.cloud.getxray.app/api/v2",
  "https://eu.xray.cloud.getxray.app/api/v2",
  "https://us.xray.cloud.getxray.app/api/v2",
  "https://au.xray.cloud.getxray.app/api/v2",
];

let xrayBase = config.xray.apiBaseUrl ?? XRAY_REGION_BASES[0];
let cachedToken = null;
let tokenExpiresAt = 0;

function isRegionMismatchError(err) {
  const text = JSON.stringify(err?.response?.data ?? err?.message ?? "").toLowerCase();
  return text.includes("another region");
}

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

async function authenticateAtBase(base) {
  const res = await axios.post(
    `${base}/authenticate`,
    {
      client_id: config.xray.clientId,
      client_secret: config.xray.clientSecret,
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30_000 }
  );
  return normalizeToken(res.data);
}

/** Find the regional Xray API that matches your Jira data residency. */
export async function resolveXrayRegion() {
  if (config.xray.apiBaseUrl) {
    xrayBase = config.xray.apiBaseUrl;
    cachedToken = null;
    return xrayBase;
  }

  const basesToTry = XRAY_REGION_BASES.filter((b) => b !== xrayBase);
  const allBases = [xrayBase, ...basesToTry];

  for (const base of allBases) {
    try {
      const token = await authenticateAtBase(base);
      const probe = await axios.post(
        `${base}/import/test/bulk`,
        { tests: [] },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: 30_000,
          validateStatus: () => true,
        }
      );

      if (probe.status === 401 && isRegionMismatchError({ response: probe })) {
        continue;
      }

      xrayBase = base;
      cachedToken = token;
      tokenExpiresAt = Date.now() + 50 * 60 * 1000;
      logger.success(`Xray region resolved: ${base}`);
      logger.info(`Tip: add to config → apiBaseUrl: "${base}"`);
      return base;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Could not determine Xray region. Set xray.apiBaseUrl in config, e.g. " +
      '"https://eu.xray.cloud.getxray.app/api/v2"'
  );
}

export async function authenticateXray() {
  try {
    const token = await authenticateAtBase(xrayBase);
    cachedToken = token;
    tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    return token;
  } catch (e) {
    const status = e.response?.status;
    const body = e.response?.data;
    const hint =
      "Check xray.clientId and xray.clientSecret. Keys must be from the same Jira site as jiraBaseUrl.";
    throw new Error(
      `Xray authenticate failed${status ? ` (HTTP ${status})` : ""}: ${JSON.stringify(body) ?? e.message}. ${hint}`
    );
  }
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  return authenticateXray();
}

async function xrayRequest(method, path, body, retried = false) {
  const token = await getToken();

  try {
    const res = await axios({
      method,
      url: `${xrayBase}${path}`,
      data: body,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 120_000,
    });
    return res.data;
  } catch (e) {
    if (!retried && isRegionMismatchError(e) && !config.xray.apiBaseUrl) {
      logger.warn("Xray data is in another region — detecting correct endpoint…");
      cachedToken = null;
      await resolveXrayRegion();
      return xrayRequest(method, path, body, true);
    }

    const status = e.response?.status;
    if (status === 401 && !isRegionMismatchError(e)) {
      cachedToken = null;
      throw new Error(
        `Xray 401 — check API keys and license. ${JSON.stringify(e.response?.data) ?? e.message}`
      );
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
