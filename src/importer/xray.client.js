/**
 * Xray Cloud REST: auth, regional endpoint, bulk test import, execution import, job polling.
 */
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

const DONE_STATES = new Set([
  "successful",
  "success",
  "finished",
  "complete",
  "completed",
  "done",
]);
const FAIL_STATES = new Set([
  "failed",
  "error",
  "unsuccessful",
  "aborted",
  "cancelled",
  "canceled",
]);

function formatJobFailure(status) {
  const errs = status?.result?.errors ?? status?.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    return errs
      .map((e) => {
        const n = e.elementNumber ?? e.index ?? "?";
        const msgs = e.errors ?? e.messages ?? [e];
        if (msgs && typeof msgs === "object" && !Array.isArray(msgs)) {
          return `item ${n}: ${Object.entries(msgs).map(([k, v]) => `${k}: ${v}`).join("; ")}`;
        }
        const detail = Array.isArray(msgs)
          ? msgs.map((m) => m.xray ?? m.message ?? JSON.stringify(m)).join("; ")
          : String(msgs);
        return `item ${n}: ${detail}`;
      })
      .join(" | ");
  }
  return JSON.stringify(status?.result ?? status);
}

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

function getJobState(status) {
  return String(
    status?.status ??
      status?.jobStatus ??
      status?.result?.status ??
      status?.state ??
      "unknown"
  ).toLowerCase();
}

function getJobProgress(status) {
  if (status?.progressValue != null) return Number(status.progressValue);
  if (Array.isArray(status?.progress) && status.progress.length > 0) {
    const last = status.progress[status.progress.length - 1];
    const m = String(last).match(/(\d+)\s*%/);
    if (m) return Number(m[1]);
  }
  return null;
}

function isJobDone(status) {
  const state = getJobState(status);
  if (DONE_STATES.has(state)) return true;
  const progress = getJobProgress(status);
  if (progress != null && progress >= 100) return true;
  if (status?.result?.issues?.length > 0 && !FAIL_STATES.has(state)) return true;
  return false;
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

/** Detect EU/US/AU/Global Xray API base from authenticate probe. */
export async function resolveXrayRegion() {
  if (config.xray.apiBaseUrl) {
    xrayBase = config.xray.apiBaseUrl;
    cachedToken = null;
    return xrayBase;
  }

  const allBases = [...new Set([xrayBase, ...XRAY_REGION_BASES])];

  for (const base of allBases) {
    try {
      const token = await authenticateAtBase(base);
      const probe = await axios.post(`${base}/import/test/bulk`, [], {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
        validateStatus: () => true,
      });

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
    'Could not determine Xray region. Set xray.apiBaseUrl, e.g. "https://eu.xray.cloud.getxray.app/api/v2"'
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
    throw new Error(
      `Xray authenticate failed${status ? ` (HTTP ${status})` : ""}: ${JSON.stringify(body) ?? e.message}`
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
    const body = e.response?.data;

    if (status === 401 && !isRegionMismatchError(e)) {
      cachedToken = null;
      throw new Error(`Xray 401 — check API keys and license. ${JSON.stringify(body) ?? e.message}`);
    }

    if (status === 400) {
      throw new Error(`Xray 400 on ${path}: ${JSON.stringify(body) ?? e.message}`);
    }

    throw e;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getImportJobStatus(jobId, kind = "test") {
  const statusPath =
    kind === "test"
      ? `/import/test/bulk/${jobId}/status`
      : `/import/execution/${jobId}/status`;
  return xrayRequest("get", statusPath);
}

/** POST /import/test/bulk and poll until job completes; returns job status. */
export async function importTestsBulk(tests) {
  logger.info(`Submitting ${tests.length} test(s) to Xray (async job)…`);
  const res = await xrayRequest("post", "/import/test/bulk", tests);
  const jobId = typeof res === "string" ? res : (res.jobId ?? res.id ?? res);
  const maxAttempts = config.xray.jobPollAttempts ?? 120;
  const intervalMs = config.xray.jobPollIntervalMs ?? 5000;
  const maxMin = Math.round((maxAttempts * intervalMs) / 60000);
  logger.info(`Xray job ${jobId} — waiting up to ~${maxMin} min (poll every ${intervalMs / 1000}s)…`);
  return pollImportJob(jobId, "test", maxAttempts, intervalMs);
}

async function pollImportJob(jobId, kind, maxAttempts, intervalMs) {
  const statusPath =
    kind === "test"
      ? `/import/test/bulk/${jobId}/status`
      : `/import/execution/${jobId}/status`;

  let lastStatus = null;

  for (let i = 0; i < maxAttempts; i++) {
    lastStatus = await xrayRequest("get", statusPath);
    const state = getJobState(lastStatus);
    const progress = getJobProgress(lastStatus);

    if (i === 0 || i % 3 === 0 || DONE_STATES.has(state) || FAIL_STATES.has(state)) {
      const pct = progress != null ? ` ${progress}%` : "";
      logger.info(`  Job ${jobId}: ${state}${pct} — poll ${i + 1}/${maxAttempts}`);
    }

    if (FAIL_STATES.has(state)) {
      throw new Error(`Xray import job ${jobId} failed (${state}): ${formatJobFailure(lastStatus)}`);
    }

    if (isJobDone(lastStatus)) {
      logger.success(`Xray job ${jobId} completed`);
      return lastStatus;
    }

    await sleep(intervalMs);
  }

  const err = new Error(
    `Xray import job ${jobId} timed out after ~${Math.round((maxAttempts * intervalMs) / 60000)} minutes`
  );
  err.jobId = jobId;
  err.lastStatus = lastStatus;
  throw err;
}

/** Map TestRail case ids to Jira keys from completed bulk import job response. */
export function extractKeysFromJob(jobStatus, testRailIds) {
  const map = {};
  const issues =
    jobStatus?.issues ??
    jobStatus?.result?.issues ??
    jobStatus?.result?.createdIssues ??
    [];

  for (let i = 0; i < testRailIds.length; i++) {
    const issue = issues[i];
    if (issue?.key) map[testRailIds[i]] = issue.key;
  }

  if (Object.keys(map).length === 0 && issues.length > 0) {
    for (const issue of issues) {
      const labels = issue?.fields?.labels ?? issue?.labels ?? [];
      for (const label of labels) {
        const m = String(label).match(/^testrail-case-(\d+)$/);
        if (m) map[Number(m[1])] = issue.key;
      }
    }
  }

  return map;
}

/** POST /import/execution for Test Execution + per-test results. */
export async function importExecution(info, tests) {
  const res = await xrayRequest("post", "/import/execution", { info, tests });
  const jobId = typeof res === "string" ? res : (res.jobId ?? res.id ?? res);
  return pollImportJob(
    jobId,
    "execution",
    config.xray.jobPollAttempts ?? 120,
    config.xray.jobPollIntervalMs ?? 5000
  );
}
