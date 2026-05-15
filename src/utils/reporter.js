import fs from "fs";
import path from "path";
import { config } from "../../config/migration.config.js";
import { logger } from "./logger.js";

export function writeReport(idMap, dryRun = false, audit = null) {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(config.output.reportsDir, `report-${runId}.json`);
  const htmlPath = path.join(config.output.reportsDir, `report-${runId}.html`);

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    summary: {
      migrated: logger.migrated.length,
      skipped: logger.skipped.length,
      errors: logger.errors.length,
      warnings: logger.warnings.length,
      manualReview: logger.manualReview.length,
    },
    migrated: logger.migrated,
    skipped: logger.skipped,
    errors: logger.errors,
    warnings: logger.warnings,
    manualReview: logger.manualReview,
    audit,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  if (!dryRun) {
    fs.writeFileSync(config.output.idMapFile, JSON.stringify(idMap, null, 2));
  }
  writeHtmlReport(htmlPath, report);

  logger.success(`\n${"─".repeat(60)}`);
  logger.success(`MIGRATION ${dryRun ? "DRY RUN " : ""}COMPLETE`);
  logger.success(`${"─".repeat(60)}`);
  logger.success(`  Migrated:       ${report.summary.migrated}`);
  logger.success(`  Skipped:        ${report.summary.skipped}`);
  logger.success(`  Errors:         ${report.summary.errors}`);
  logger.success(`  Manual review:  ${report.summary.manualReview}`);
  logger.success(`  Warnings:       ${report.summary.warnings}`);
  logger.success(`${"─".repeat(60)}`);
  logger.success(`  JSON report:    ${reportPath}`);
  logger.success(`  HTML report:    ${htmlPath}`);
  if (!dryRun) logger.success(`  ID map:         ${config.output.idMapFile}`);
  logger.success(`${"─".repeat(60)}\n`);
}

function writeHtmlReport(filePath, report) {
  const { summary, manualReview, errors, skipped, audit } = report;
  const el = "div";

  const manualRows = manualReview
    .map(
      (r) =>
        `<tr><td>${r.testRailId}</td><td>${esc(r.title)}</td><td>${esc(r.reason)}</td><td>${(r.confidence * 100).toFixed(0)}%</td></tr>`
    )
    .join("");

  const errorRows = errors
    .map(
      (r) =>
        `<tr><td>${esc(r.context)}</td><td>${esc(r.message)}</td><td>${r.ts}</td></tr>`
    )
    .join("");

  const skippedRows = skipped
    .map((r) => `<tr><td>${r.id}</td><td>${esc(r.reason)}</td></tr>`)
    .join("");

  const auditBlock = audit
    ? `<p><strong>Audit:</strong> ${audit.total} cases — ${audit.structured} structured, ${audit.unstructured} unstructured</p>`
    : "";

  const card = (n, l) =>
    `<${el} class="card"><${el} class="num">${n}</${el}><${el} class="lbl">${l}</${el}></${el}>`;

  const html = [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head><meta charset=\"UTF-8\"><title>Migration Report</title>",
    "<style>",
    "body{font-family:system-ui,sans-serif;background:#f1f5f9;padding:32px}",
    ".cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:20px 0}",
    ".card{background:#fff;border-radius:8px;padding:16px}",
    ".num{font-size:28px;font-weight:700}",
    ".lbl{font-size:11px;color:#64748b;text-transform:uppercase}",
    "table{width:100%;border-collapse:collapse;background:#fff;margin-top:12px}",
    "th,td{padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px}",
    "th{background:#1b3a5c;color:#fff;text-align:left}",
    "</style></head><body>",
    `<h1>TestRail → Xray ${report.dryRun ? "(DRY RUN)" : ""}</h1>`,
    `<p>Generated: ${report.generatedAt}</p>`,
    auditBlock,
    `<${el} class="cards">`,
    card(summary.migrated, "Migrated"),
    card(summary.manualReview, "Manual review"),
    card(summary.skipped, "Skipped"),
    card(summary.errors, "Errors"),
    card(summary.warnings, "Warnings"),
    `</${el}>`,
    "<h2>Manual review</h2>",
    manualReview.length
      ? `<table><thead><tr><th>TR ID</th><th>Title</th><th>Reason</th><th>%</th></tr></thead><tbody>${manualRows}</tbody></table>`
      : "<p>None</p>",
    "<h2>Errors</h2>",
    errors.length
      ? `<table><thead><tr><th>Context</th><th>Message</th><th>Time</th></tr></thead><tbody>${errorRows}</tbody></table>`
      : "<p>None</p>",
    "<h2>Skipped</h2>",
    skipped.length
      ? `<table><thead><tr><th>ID</th><th>Reason</th></tr></thead><tbody>${skippedRows}</tbody></table>`
      : "<p>None</p>",
    "</body></html>",
  ].join("\n");

  fs.writeFileSync(filePath, html);
}

function esc(str = "") {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
