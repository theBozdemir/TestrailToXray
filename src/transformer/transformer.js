import { config } from "../../config/migration.config.js";
import { logger } from "../utils/logger.js";
import { collectDefectKeysFromResult } from "../importer/jira.client.js";
import {
  hasStructuredSteps,
  parseDescription,
  getUnstructuredText,
  extractTestRailSteps,
} from "./parser.js";
import {
  formatPreconditionsSection,
  formatReferences,
  replaceTestRailAttachmentRefs,
} from "../utils/jira-content.js";

/** Avoid wiki image syntax in Xray steps (causes broken loaders); post-process sets HTML images. */
function formatStepResultForImport(expected, attachmentMap) {
  const processed = replaceTestRailAttachmentRefs(expected, attachmentMap);
  if (!processed) return "";

  const imageOnly =
    /^!\S[^|!\n]*(?:\|[^!]*)?!$/i.test(processed.trim()) ||
    /^\(image — see Attachments/i.test(processed.trim()) ||
    (/attachments\/get\//i.test(expected) && processed.replace(/!\S+!\s*/g, "").trim().length < 20);

  if (imageOnly) {
    return "";
  }

  return processed
    .replace(/!\S[^|!\n]*(?:\|[^!]*)?!/g, "")
    .replace(/\(image — see Attachments on this issue\)/gi, "")
    .trim();
}

export function transformCase(trCase, folderPath, dryRun = false, options = {}) {
  const { attachmentMap = new Map(), idMap = {} } = options;
  const { priorityMap, typeMap, customFieldMap, parser: parserCfg } = config;

  let steps = [];
  let needsReview = false;
  let reviewReason = null;
  let confidence = 1.0;
  let strategy = "structured";

  if (hasStructuredSteps(trCase)) {
    steps = extractTestRailSteps(trCase, attachmentMap);
  } else if (parserCfg.heuristicParse) {
    const text = getUnstructuredText(trCase, parserCfg.unstructuredTextFields);
    const parseResult = parseDescription(text);
    steps = parseResult.steps;
    confidence = parseResult.confidence;
    strategy = parseResult.strategy;

    if (confidence < parserCfg.minConfidence || steps.length === 0) {
      needsReview = true;
      reviewReason = `Low confidence parse (${(confidence * 100).toFixed(0)}%) via "${strategy}"`;
      if (!dryRun) {
        logger.recordManualReview(trCase.id, trCase.title, reviewReason, confidence);
      }
    }
  }

  const labels = ["migrated-from-testrail", `testrail-case-${trCase.id}`];
  if (needsReview) labels.push("needs-manual-review");
  if (strategy !== "structured") labels.push(`parsed-${strategy}`);

  const descriptionText = buildDescription(trCase, strategy, attachmentMap, idMap);
  const fields = {
    project: { key: config.xray.jiraProjectKey },
    summary: String(trCase.title ?? "Untitled").slice(0, 255),
    issuetype: { name: config.xray.testIssueType },
    labels: labels.map((l) => l.slice(0, 255)),
  };

  if (descriptionText) fields.description = descriptionText;

  if (config.xray.includePriority === true) {
    const priorityName = priorityMap[trCase.priority_id];
    if (priorityName) fields.priority = { name: priorityName };
  }

  for (const [trField, jiraField] of Object.entries(customFieldMap)) {
    if (trCase[trField] !== undefined) {
      fields[jiraField] = trCase[trField];
    }
  }

  let xraySteps = steps
    .map((s) => ({
      action:
        replaceTestRailAttachmentRefs(s.action, attachmentMap).slice(0, 10000) || " ",
      data: replaceTestRailAttachmentRefs(s.data ?? "", attachmentMap).slice(0, 10000),
      result: formatStepResultForImport(s.expected ?? "", attachmentMap).slice(0, 10000),
    }))
    .filter((s) => s.action.trim());

  if (xraySteps.length === 0) {
    xraySteps = [
      {
        action: "See test description for steps (migrated from TestRail).",
        data: "",
        result: "",
      },
    ];
  }

  const importPayload = {
    testtype: typeMap[trCase.type_id] ?? "Manual",
    steps: xraySteps,
    fields,
  };

  return {
    importPayload,
    needsReview,
    reviewReason,
    meta: {
      testRailId: trCase.id,
      title: trCase.title,
      confidence,
      strategy,
      folderPath,
      stepCount: xraySteps.length,
    },
  };
}

export function buildDescription(trCase, strategy, attachmentMap = new Map(), idMap = {}) {
  const parts = [];

  const pre = formatPreconditionsSection(trCase.custom_preconds, attachmentMap);
  if (pre) parts.push(pre);

  if (strategy !== "structured") {
    const original = replaceTestRailAttachmentRefs(
      getUnstructuredText(trCase, config.parser.unstructuredTextFields),
      attachmentMap
    );
    if (original) parts.push(`*Original TestRail text*\n${original}`);
  }

  const refs = formatReferences(trCase.refs, idMap);
  if (refs) parts.push(refs);

  parts.push(`Migrated from TestRail — Case ID: ${trCase.id}`);
  return parts.join("\n\n");
}

/** Map TestRail status_id to Xray Cloud execution status (PASSED, FAILED, TODO, …). */
function toXrayExecutionStatus(statusId) {
  const { executionStatusMap, statusMap } = config;
  const aliases = {
    PASS: "PASSED",
    PASSED: "PASSED",
    FAIL: "FAILED",
    FAILED: "FAILED",
    BLOCKED: "TODO",
    UNTESTED: "TODO",
    RETEST: "TODO",
    SKIPPED: "TODO",
  };

  const name = executionStatusMap?.[statusId] ?? statusMap[statusId] ?? "TODO";
  return aliases[name] ?? name;
}

export function transformResult(trResult, xrayTestKey, evidence = [], defectKeys = []) {
  const { userMap } = config;

  const assigneeAccountId = trResult.tested_by
    ? (userMap[trResult.tested_by] ?? null)
    : null;

  const executedOn = trResult.created_on
    ? new Date(trResult.created_on * 1000).toISOString()
    : new Date().toISOString();

  const status = toXrayExecutionStatus(trResult.status_id);

  const migrateDefects = config.scope.migrateResultDefects !== false;
  const defects =
    migrateDefects && defectKeys.length > 0
      ? defectKeys
      : migrateDefects
        ? collectDefectKeysFromResult(trResult)
        : [];

  const commentParts = [];
  if (trResult.comment?.trim()) commentParts.push(trResult.comment.trim());
  if (defects.length === 0 && trResult.defects?.trim()) {
    commentParts.push(`Defects (not linked — check keys exist in Jira): ${trResult.defects}`);
  }
  commentParts.push(`Imported from TestRail result ${trResult.id}`);

  const payload = {
    testKey: xrayTestKey,
    start: executedOn,
    finish: executedOn,
    status,
    comment: commentParts.join("\n\n"),
    ...(assigneeAccountId ? { executedBy: assigneeAccountId } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(defects.length > 0 ? { defects } : {}),
  };

  if (!assigneeAccountId && trResult.tested_by) {
    logger.recordWarning(
      `result(${trResult.id})`,
      `No Jira account mapping for "${trResult.tested_by}"`
    );
  }

  return payload;
}

export function buildFolderPath(suiteName, sectionPath = []) {
  const parts = [suiteName, ...sectionPath].map(sanitizeFolderName);
  return "/" + parts.join("/");
}

function sanitizeFolderName(name) {
  return String(name).replace(/[/\\|<>:?"*]/g, "_").trim();
}
