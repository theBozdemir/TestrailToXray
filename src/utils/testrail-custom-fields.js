import { jiraBold, replaceTestRailAttachmentRefs, stripHtml } from "./jira-content.js";

/** Handled elsewhere — do not duplicate in the generic custom-fields block. */
export const CASE_FIELDS_HANDLED_ELSEWHERE = new Set([
  "custom_steps",
  "custom_steps_separated",
  "custom_expected",
  "custom_preconds",
  "custom_tc_description",
  "custom_description",
]);

/** Result fields handled by execution import logic. */
export const RESULT_FIELDS_HANDLED_ELSEWHERE = new Set([
  "custom_step_results",
]);

/**
 * Parse TestRail dropdown items string: "1,Yes\n2,No"
 * @returns {Map<string, string>}
 */
export function parseDropdownItems(itemsStr) {
  const map = new Map();
  if (!itemsStr || typeof itemsStr !== "string") return map;

  for (const line of itemsStr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const comma = trimmed.indexOf(",");
    if (comma === -1) continue;
    const id = trimmed.slice(0, comma).trim();
    const label = trimmed.slice(comma + 1).trim();
    if (id) map.set(id, label);
  }
  return map;
}

function getFieldOptions(field) {
  const config = field.configs?.[0]?.options ?? field.configs?.[0] ?? {};
  return config.options ?? config;
}

function resolveDropdownValue(raw, itemsMap) {
  if (raw == null || raw === "") return null;
  const key = String(raw);
  return itemsMap.get(key) ?? key;
}

function resolveMultiselectValue(raw, itemsMap) {
  if (raw == null) return null;
  const ids = Array.isArray(raw) ? raw : [raw];
  const labels = ids
    .map((id) => itemsMap.get(String(id)) ?? String(id))
    .filter(Boolean);
  return labels.length ? labels.join(", ") : null;
}

function formatCheckboxValue(raw) {
  if (raw === true || raw === 1 || raw === "1") return "Yes";
  if (raw === false || raw === 0 || raw === "0") return "No";
  return null;
}

function formatTextValue(raw, attachmentMap) {
  if (raw == null) return null;
  const text = typeof raw === "string" ? raw.trim() : String(raw);
  if (!text) return null;
  return replaceTestRailAttachmentRefs(text, attachmentMap);
}

/**
 * Format a single TestRail custom field value for Jira description text.
 */
export function formatFieldValue(field, rawValue, attachmentMap = new Map()) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return null;
  if (Array.isArray(rawValue) && rawValue.length === 0) return null;

  const opts = getFieldOptions(field);
  const itemsMap = parseDropdownItems(opts.items);
  const typeId = field.type_id;

  switch (typeId) {
    case 5:
      return formatCheckboxValue(rawValue);
    case 6:
      return resolveDropdownValue(rawValue, itemsMap);
    case 12:
      return resolveMultiselectValue(rawValue, itemsMap);
    case 10:
    case 13:
    case 14:
      return formatTextValue(
        typeof rawValue === "object" ? JSON.stringify(rawValue, null, 2) : rawValue,
        attachmentMap
      );
    default:
      return formatTextValue(
        typeof rawValue === "object" ? JSON.stringify(rawValue) : rawValue,
        attachmentMap
      );
  }
}

/**
 * Build description sections for all API-defined case custom fields.
 * @param {object} trCase
 * @param {object[]} fieldDefs from get_case_fields
 * @param {Map} attachmentMap
 */
export function formatCustomFieldsSections(trCase, fieldDefs = [], attachmentMap = new Map()) {
  const sections = [];
  const sorted = [...fieldDefs].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)
  );

  for (const field of sorted) {
    if (field.is_active === false) continue;
    const systemName = field.system_name;
    if (!systemName?.startsWith("custom_")) continue;
    if (CASE_FIELDS_HANDLED_ELSEWHERE.has(systemName)) continue;

    const raw = trCase[systemName];
    const formatted = formatFieldValue(field, raw, attachmentMap);
    if (formatted == null || formatted === "") continue;
    if (field.type_id === 5 && formatted === "No") continue;

    const label = field.label || field.name || systemName;
    const body =
      field.type_id === 3 || String(formatted).includes("<")
        ? replaceTestRailAttachmentRefs(formatted, attachmentMap)
        : formatted;

    sections.push(`${jiraBold(label)}\n\n${stripHtml(body).trim() || body.trim()}`);
  }

  return sections;
}

/**
 * Append result-level custom fields to execution import comment.
 */
export function formatResultCustomFields(trResult, fieldDefs = []) {
  const parts = [];
  for (const field of fieldDefs) {
    if (field.is_active === false) continue;
    const systemName = field.system_name;
    if (!systemName?.startsWith("custom_")) continue;
    if (RESULT_FIELDS_HANDLED_ELSEWHERE.has(systemName)) continue;

    const formatted = formatFieldValue(field, trResult[systemName], new Map());
    if (!formatted) continue;

    const label = field.label || field.name;
    parts.push(`${label}: ${formatted}`);
  }
  return parts.length ? parts.join("\n") : "";
}

/**
 * Generate config snippet for dropdown value maps (documentation / override).
 */
export function buildFieldMapsFromDefs(fieldDefs) {
  const maps = {};
  for (const field of fieldDefs) {
    const opts = getFieldOptions(field);
    if (!opts.items) continue;
    const items = parseDropdownItems(opts.items);
    if (items.size === 0) continue;
    maps[field.system_name] = Object.fromEntries(items);
  }
  return maps;
}
