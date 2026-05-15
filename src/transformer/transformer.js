import { config } from "../../config/migration.config.js";
import { logger } from "../utils/logger.js";
import { plainTextToAdf } from "../utils/jira-adf.js";
import {
  hasStructuredSteps,
  parseDescription,
  getUnstructuredText,
} from "./parser.js";

export function transformCase(trCase, folderPath, dryRun = false) {
  const { priorityMap, typeMap, customFieldMap, parser: parserCfg } = config;

  let steps = [];
  let needsReview = false;
  let reviewReason = null;
  let confidence = 1.0;
  let strategy = "structured";

  if (hasStructuredSteps(trCase)) {
    steps = extractStructuredSteps(trCase);
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

  const descriptionText = buildDescription(trCase, strategy);
  const fields = {
    project: { key: config.xray.jiraProjectKey },
    summary: String(trCase.title ?? "Untitled").slice(0, 255),
    issuetype: { name: config.xray.testIssueType },
    labels: labels.map((l) => l.slice(0, 255)),
  };

  const descriptionAdf = plainTextToAdf(descriptionText);
  if (descriptionAdf) fields.description = descriptionAdf;

  // Omit priority by default — wrong names cause Jira 400 (enable after mapping)
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
      action: stripHtml(s.action).slice(0, 10000) || " ",
      data: stripHtml(s.data ?? "").slice(0, 10000),
      result: stripHtml(s.expected ?? "").slice(0, 10000),
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
    testType: typeMap[trCase.type_id] ?? "Manual",
    steps: xraySteps,
    jira: { fields },
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

export function transformResult(trResult, xrayTestKey) {
  const { statusMap, userMap } = config;

  const assigneeAccountId = trResult.tested_by
    ? (userMap[trResult.tested_by] ?? null)
    : null;

  const executedOn = trResult.created_on
    ? new Date(trResult.created_on * 1000).toISOString()
    : new Date().toISOString();

  const payload = {
    testIssueKey: xrayTestKey,
    start: executedOn,
    finish: executedOn,
    status: statusMap[trResult.status_id] ?? "TODO",
    comment: trResult.comment ?? "",
    ...(assigneeAccountId ? { executedBy: assigneeAccountId } : {}),
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

function extractStructuredSteps(trCase) {
  let separated = trCase.custom_steps_separated;

  if (typeof separated === "string") {
    try {
      separated = JSON.parse(separated);
    } catch {
      separated = [];
    }
  }

  if (Array.isArray(separated) && separated.length > 0) {
    return separated.map((step) => ({
      action: step.content ?? step.step ?? "",
      expected: step.expected ?? step.result ?? "",
    }));
  }

  if (typeof trCase.custom_steps === "string" && trCase.custom_steps.trim()) {
    return trCase.custom_steps
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((block) => ({ action: block.trim(), expected: "" }));
  }

  return [];
}

function buildDescription(trCase, strategy) {
  const parts = [];

  if (trCase.custom_preconds) {
    parts.push(`Preconditions:\n${trCase.custom_preconds}`);
  }

  if (strategy !== "structured") {
    const original = getUnstructuredText(trCase, config.parser.unstructuredTextFields);
    if (original) parts.push(`Original TestRail text:\n${original}`);
  }

  if (trCase.refs) parts.push(`References: ${trCase.refs}`);

  parts.push(`Migrated from TestRail — Case ID: ${trCase.id}`);
  return parts.join("\n\n");
}

function stripHtml(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function sanitizeFolderName(name) {
  return String(name).replace(/[/\\|<>:?"*]/g, "_").trim();
}
