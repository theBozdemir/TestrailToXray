/**
 * Build Xray execution evidence[] from TestRail result attachments and embedded images.
 */
import { logger } from "./logger.js";
import {
  buildAttachmentIdMap,
  resolveStepExpectedAttachments,
  testrailUploadFilename,
} from "./jira-content.js";

/** Group run-level attachments by TestRail result_id. */
export function groupAttachmentsByResultId(runAttachments = []) {
  const byResultId = {};
  for (const att of runAttachments) {
    const rid = att.result_id ?? att.resultId;
    if (rid == null) continue;
    const key = String(rid);
    if (!byResultId[key]) byResultId[key] = [];
    byResultId[key].push(att);
  }
  return byResultId;
}

function collectResultText(trResult) {
  const parts = [trResult.comment, trResult.defects];
  if (Array.isArray(trResult.custom_step_results)) {
    for (const step of trResult.custom_step_results) {
      parts.push(step.actual, step.expected, step.comment);
    }
  }
  return parts.filter(Boolean).join("\n");
}

function embeddedAttachmentIds(text) {
  return [
    ...String(text || "").matchAll(/attachments\/get\/([^"')\s]+)/gi),
  ].map((m) => m[1]);
}

/**
 * Download screenshots/files for a TestRail result and build Xray execution evidence items.
 * @param {object} trResult — TestRail result from get_results_for_run
 * @param {Record<string, object[]>} runAttachmentsByResultId
 * @param {object[]} runAttachments — all attachments for the run
 * @param {{ downloadAttachment: (id: string|number) => Promise<{ buffer: Buffer, contentType: string }>, maxFiles?: number, maxTotalBytes?: number }} opts
 * @returns {Promise<Array<{ data: string, filename: string, contentType: string }>>}
 */
export async function buildResultEvidence(
  trResult,
  runAttachmentsByResultId,
  runAttachments,
  { downloadAttachment, maxFiles = 20, maxTotalBytes = 25 * 1024 * 1024 }
) {
  const attachmentMap = buildAttachmentIdMap(runAttachments);
  const seen = new Set();
  const candidates = [];

  const linked = runAttachmentsByResultId[String(trResult.id)] ?? [];
  for (const att of linked) {
    const key = String(att.id);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(att);
    }
  }

  const text = collectResultText(trResult);
  for (const att of resolveStepExpectedAttachments(text, runAttachments, attachmentMap)) {
    const key = String(att.id);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(att);
    }
  }

  for (const id of embeddedAttachmentIds(text)) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const fromList = runAttachments.find(
      (a) =>
        String(a.id) === key ||
        String(a.data_id) === key ||
        a.cassandra_file_id === id
    );
    candidates.push(fromList ?? { id, name: `proof-${id}` });
  }

  const evidence = [];
  let totalBytes = 0;

  for (const att of candidates) {
    if (evidence.length >= maxFiles) break;

    const attId = att.id ?? att;
    try {
      const { buffer, contentType } = await downloadAttachment(attId);
      if (maxTotalBytes > 0 && totalBytes + buffer.length > maxTotalBytes) {
        logger.recordWarning(
          `result-evidence(${trResult.id})`,
          `Skipped remaining files — total evidence would exceed ${Math.round(maxTotalBytes / 1024 / 1024)} MB`
        );
        break;
      }
      totalBytes += buffer.length;
      evidence.push({
        data: buffer.toString("base64"),
        filename: testrailUploadFilename(att),
        contentType: contentType || "application/octet-stream",
      });
    } catch (e) {
      logger.recordWarning(`result-evidence(${trResult.id}/${attId})`, e.message);
    }
  }

  return evidence;
}
