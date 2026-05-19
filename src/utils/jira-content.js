import { config } from "../../config/migration.config.js";

/** Jira wiki markup (works in plain-text description on many Cloud projects). */
export function jiraBold(text) {
  return `*${text}*`;
}

export function stripHtml(text) {
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

/**
 * Replace TestRail inline images (HTML or markdown) with Jira wiki embeds by filename.
 * @param {string} text
 * @param {Map<string, string>} attachmentIdToFilename
 */
export function replaceTestRailAttachmentRefs(text, attachmentIdToFilename = new Map()) {
  if (!text) return "";

  let out = String(text);

  // HTML <img src=".../attachments/get/ID">
  out = out.replace(
    /<img[^>]*\ssrc="[^"]*attachments\/get\/([^"']+)"[^>]*>/gi,
    (_, id) => `\n${embedForAttachmentId(id, attachmentIdToFilename)}\n`
  );

  // Markdown ![](.../attachments/get/ID)
  out = out.replace(
    /!\[[^\]]*\]\([^)]*attachments\/get\/(\d+|[a-f0-9-]+)\)/gi,
    (_, id) => `\n${embedForAttachmentId(id, attachmentIdToFilename)}\n`
  );

  // Bare attachment URLs in text
  out = out.replace(/attachments\/get\/(\d+|[a-f0-9-]+)/gi, (_, id) =>
    embedForAttachmentId(id, attachmentIdToFilename)
  );

  return htmlToPlainText(out);
}

/** Convert TestRail HTML (lists, paragraphs) to plain text before ADF. */
function htmlToPlainText(html) {
  let out = String(html);
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/p>/gi, "\n");
  out = out.replace(/<p[^>]*>/gi, "");
  out = out.replace(/<\/li>/gi, "\n");
  out = out.replace(/<li[^>]*>/gi, "• ");
  out = out.replace(/<\/?ul[^>]*>/gi, "\n");
  out = out.replace(/<\/?ol[^>]*>/gi, "\n");
  out = stripHtml(out);
  return out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

function embedForAttachmentId(id, map) {
  const name =
    map.get(id) ??
    map.get(id.toLowerCase()) ??
    map.get(String(id).replace(/-/g, ""));
  if (name) {
    const safe = name.replace(/\|/g, "-");
    return `!${safe}|thumbnail!`;
  }
  return "(image — see Attachments on this issue)";
}

/**
 * Build attachment lookup: TestRail attachment id / UUID → upload filename.
 * TestRail embeds use cassandra_file_id in URLs; API list uses numeric id.
 * @param {Array<{ id: string|number, name?: string, filename?: string, cassandra_file_id?: string, data_id?: number }>} attachments
 */
export function buildAttachmentIdMap(attachments = []) {
  const map = new Map();
  for (const att of attachments) {
    const uploadName = testrailUploadFilename(att);
    const keys = [
      att.id,
      att.data_id,
      att.cassandra_file_id,
    ].filter((k) => k != null && String(k).trim() !== "");

    for (const key of keys) {
      map.set(String(key), uploadName);
      map.set(String(key).toLowerCase(), uploadName);
    }
  }
  return map;
}

/**
 * Plain-text expected result for Xray steps (strips wiki/HTML image syntax).
 */
export function buildExpectedResultPlainText(expectedText, rawExpected = "") {
  return String(expectedText || "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/!\S[^|!\n]*(?:\|[^!]*)?!/g, "")
    .replace(/\(image — see Attachments on this issue\)/gi, "")
    .replace(/attachments\/get\/\S+/gi, "")
    .replace(/<p>\s*<img[^>]*>\s*<\/p>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Text for Expected Result when the screenshot is a Xray step attachment (not inline in the cell).
 * Xray shows step images below the row — not inside the Expected Result column like TestRail.
 */
export function stepExpectedResultLabel(hasText, hasImage) {
  if (hasText) return hasText;
  if (hasImage) {
    return "Expected result: see screenshot in step attachments below.";
  }
  return "";
}

/**
 * Resolve TestRail case attachments referenced in a step's expected field.
 * @returns {Array<object>} TestRail attachment records to upload on the Xray step
 */
export function resolveStepExpectedAttachments(
  rawExpected,
  testrailAttachments = [],
  attachmentIdToFilename = new Map()
) {
  const embeddedIds = [
    ...String(rawExpected || "").matchAll(/attachments\/get\/([^"')\s]+)/gi),
  ].map((m) => m[1]);

  const matched = [];
  const seen = new Set();

  for (const id of embeddedIds) {
    const trAtt = testrailAttachments.find(
      (a) =>
        String(a.id) === String(id) ||
        String(a.data_id) === String(id) ||
        a.cassandra_file_id === id
    );
    if (trAtt && !seen.has(trAtt.id)) {
      seen.add(trAtt.id);
      matched.push(trAtt);
      continue;
    }

    const uploadName =
      attachmentIdToFilename.get(id) ??
      attachmentIdToFilename.get(String(id).toLowerCase());
    if (uploadName) {
      const byName = testrailAttachments.find(
        (a) => testrailUploadFilename(a) === uploadName
      );
      if (byName && !seen.has(byName.id)) {
        seen.add(byName.id);
        matched.push(byName);
      }
    }
  }

  if (
    matched.length === 0 &&
    testrailAttachments.length === 1 &&
    /attachments\/get\//i.test(rawExpected)
  ) {
    return [testrailAttachments[0]];
  }

  return matched;
}

/** Unique filename per TestRail attachment (avoids duplicate image.png on one Jira issue). */
export function testrailUploadFilename(att) {
  const name = att.name || att.filename || `attachment-${att.id}`;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `tr-${att.id}-${name}`;
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  return `${stem}-tr${att.id}${ext}`;
}

/**
 * Format TestRail refs as Jira wiki links where possible.
 * @param {string} refs
 * @param {Record<number, string>} idMap  TestRail case id → Jira key
 */
export function formatReferences(refs, idMap = {}) {
  if (!refs?.trim()) return null;

  const base = config.xray.jiraBaseUrl.replace(/\/$/, "");
  const projectKey = config.xray.jiraProjectKey;
  const tokens = refs.split(/[,;]+/).flatMap((t) => t.trim().split(/\s+/)).filter(Boolean);

  const links = tokens.map((tok) => {
    const issueKeyMatch = tok.match(/^([A-Z][A-Z0-9_]+-\d+)$/i);
    if (issueKeyMatch) {
      const key = issueKeyMatch[1].toUpperCase();
      return `[${key}|${base}/browse/${key}]`;
    }

    const caseNum = parseInt(tok.replace(/[^0-9]/g, ""), 10);
    if (!Number.isNaN(caseNum) && idMap[caseNum]) {
      const key = idMap[caseNum];
      return `[${key}|${base}/browse/${key}] (TestRail C${caseNum})`;
    }

    if (!Number.isNaN(caseNum) && /^\d+$/.test(tok.trim())) {
      return `TestRail case C${caseNum} (not in migration map)`;
    }

    return tok;
  });

  return `${jiraBold("References")}\n${links.join("\n")}`;
}

/** TestRail template fields that hold the case-level description (not steps/expected). */
export const CASE_DESCRIPTION_FIELDS = [
  "custom_tc_description",
  "custom_description",
];

/**
 * Case-level description for Jira (TestRail "Description" / TC Description field).
 */
export function formatCaseDescriptionSection(trCase, attachmentIdToFilename = new Map()) {
  const parts = [];
  for (const field of CASE_DESCRIPTION_FIELDS) {
    const val = trCase[field];
    if (typeof val === "string" && val.trim()) {
      parts.push(val.trim());
    }
  }
  if (parts.length === 0) return null;

  const body = replaceTestRailAttachmentRefs(parts.join("\n\n"), attachmentIdToFilename);
  if (!body) return null;

  const withImageLines = body.replace(
    /([^\n])\s*(!\S[^|!\n]*(?:\|[^!]*)?!)/g,
    "$1\n\n$2"
  );

  return `${jiraBold("Description")}\n\n${withImageLines.trim()}`;
}

/**
 * Preconditions block for issue description (Xray has no preconditions field on Tests).
 */
export function formatPreconditionsSection(text, attachmentIdToFilename) {
  if (!text?.trim()) return null;
  const body = replaceTestRailAttachmentRefs(text, attachmentIdToFilename);
  if (!body) return null;

  // Put each wiki image embed on its own line so ADF conversion can render it
  const withImageLines = body.replace(
    /([^\n])\s*(!\S[^|!\n]*(?:\|[^!]*)?!)/g,
    "$1\n\n$2"
  );

  return `${jiraBold("Preconditions")}\n\n${withImageLines.trim()}`;
}

/** TestRail attachments referenced only in custom_preconds (for upload if missing). */
export function resolvePreconditionAttachments(
  precondsText,
  testrailAttachments = [],
  attachmentIdToFilename = new Map()
) {
  return resolveStepExpectedAttachments(
    precondsText,
    testrailAttachments,
    attachmentIdToFilename
  );
}
