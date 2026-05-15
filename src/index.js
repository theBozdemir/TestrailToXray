#!/usr/bin/env node
import fs from "fs";
import pLimit from "p-limit";
import { config } from "../config/migration.config.js";
import { logger } from "./utils/logger.js";
import { writeReport } from "./utils/reporter.js";
import {
  getSuites,
  getSections,
  getCases,
  getCasesForProject,
  getCase,
  getRuns,
  getResults,
  getAttachmentsForCase,
  downloadAttachment,
} from "./extractor/testrail.client.js";
import { transformCase, transformResult, buildFolderPath } from "./transformer/transformer.js";
import { hasStructuredSteps } from "./transformer/parser.js";
import { importTestsBulk, extractKeysFromJob, importExecution } from "./importer/xray.client.js";
import { findExistingTestByLabel, uploadAttachment } from "./importer/jira.client.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const auditOnly = args.includes("--audit-only");
const resultsOnly = args.includes("--results-only");
const caseIdsArg = args.find((a) => a.startsWith("--case-ids="));
const cliCaseIds = caseIdsArg
  ? caseIdsArg
      .split("=")[1]
      .split(",")
      .map((s) => Number(s.trim()))
      .filter(Boolean)
  : [];

function loadExistingIdMap() {
  try {
    if (fs.existsSync(config.output.idMapFile)) {
      return JSON.parse(fs.readFileSync(config.output.idMapFile, "utf8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}

function buildSectionTree(sections) {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const pathCache = new Map();

  function pathFor(sectionId) {
    if (!sectionId) return [];
    if (pathCache.has(sectionId)) return pathCache.get(sectionId);
    const sec = byId.get(sectionId);
    if (!sec) return [];
    const parentPath = sec.parent_id ? pathFor(sec.parent_id) : [];
    const full = [...parentPath, sec.name];
    pathCache.set(sectionId, full);
    return full;
  }

  return { pathFor };
}

function shouldMigrateCase(caseId) {
  const pilot = config.testRail.pilotCaseIds?.length
    ? config.testRail.pilotCaseIds
    : cliCaseIds;
  if (pilot.length === 0) return true;
  return pilot.includes(caseId);
}

async function collectCases() {
  const projectId = config.testRail.projectId;
  let suites = await getSuites(projectId);

  if (config.testRail.suiteIds?.length) {
    suites = suites.filter((s) => config.testRail.suiteIds.includes(s.id));
  }

  const allCases = [];

  // Single-suite or suite-less layouts: migrate all project cases under one folder
  if (suites.length === 0) {
    let cases = await getCasesForProject(projectId);
    if (cliCaseIds.length) {
      cases = cases.filter((c) => cliCaseIds.includes(c.id));
    } else {
      cases = cases.filter((c) => shouldMigrateCase(c.id));
    }
    const suite = { name: "Test Cases" };
    for (const c of cases) {
      allCases.push({ case: c, suite, folderPath: "/Test Cases" });
    }
    return allCases;
  }

  for (const suite of suites) {
    const sections = await getSections(projectId, suite.id);
    const { pathFor } = buildSectionTree(sections);
    let cases = await getCases(projectId, suite.id);

    if (cliCaseIds.length) {
      cases = cases.filter((c) => cliCaseIds.includes(c.id));
    } else {
      cases = cases.filter((c) => shouldMigrateCase(c.id));
    }

    for (const c of cases) {
      const sectionPath = pathFor(c.section_id);
      const folderPath = buildFolderPath(suite.name, sectionPath);
      allCases.push({ case: c, suite, folderPath });
    }
  }

  // Pilot IDs without suite scan: fetch directly
  const pilotOnly = config.testRail.pilotCaseIds?.length
    ? config.testRail.pilotCaseIds
    : cliCaseIds;

  if (pilotOnly.length && allCases.length === 0) {
    for (const id of pilotOnly) {
      const c = await getCase(id);
      allCases.push({ case: c, suite: { name: "Direct" }, folderPath: "/Migrated" });
    }
  }

  return allCases;
}

async function runAudit(cases) {
  let structured = 0;
  let unstructured = 0;
  const details = [];

  for (const { case: trCase, folderPath } of cases) {
    const isStructured = hasStructuredSteps(trCase);
    if (isStructured) structured++;
    else unstructured++;
    details.push({
      id: trCase.id,
      title: trCase.title,
      type: isStructured ? "structured" : "unstructured",
      folderPath,
    });
  }

  const audit = { total: cases.length, structured, unstructured, details };
  logger.info(`Audit: ${cases.length} cases — ${structured} structured, ${unstructured} unstructured`);
  return audit;
}

async function migrateCases(cases) {
  const idMap = loadExistingIdMap();
  const batchSize = 25;

  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);
    const imports = [];
    const metaList = [];

    for (const { case: trCase, folderPath } of batch) {
      if (idMap[trCase.id]) {
        logger.info(`Skip TR-${trCase.id} — already mapped to ${idMap[trCase.id]}`);
        continue;
      }

      const existing = dryRun ? null : await findExistingTestByLabel(trCase.id);
      if (existing) {
        idMap[trCase.id] = existing;
        logger.recordMigrated(trCase.id, existing);
        continue;
      }

      const { importPayload, meta } = transformCase(trCase, folderPath, dryRun);
      imports.push(importPayload);
      metaList.push(meta);
    }

    if (imports.length === 0) continue;

    if (dryRun) {
      for (const m of metaList) {
        logger.dry(`Would import TR-${m.testRailId}: "${m.title}" (${m.stepCount} steps, ${m.strategy})`);
        logger.recordMigrated(m.testRailId, `DRY-RUN-${m.testRailId}`);
      }
      continue;
    }

    try {
      const job = await importTestsBulk(imports);
      const trIds = metaList.map((m) => m.testRailId);
      const batchMap = extractKeysFromJob(job, trIds);

      for (const m of metaList) {
        const key = batchMap[m.testRailId];
        if (key) {
          idMap[m.testRailId] = key;
          logger.recordMigrated(m.testRailId, key);
          logger.success(`TR-${m.testRailId} → ${key}`);
        } else {
          logger.recordError(`import(${m.testRailId})`, "No issue key returned from Xray job");
        }
      }
    } catch (e) {
      if (config.errors.strategy === "stop") throw e;
      for (const m of metaList) {
        logger.recordError(`batch-import`, `TR-${m.testRailId}: ${e.message}`);
      }
    }
  }

  if (!dryRun && config.scope.migrateAttachments) {
    await migrateAttachments(cases, idMap);
  }

  return idMap;
}

async function migrateAttachments(cases, idMap) {
  const limit = pLimit(config.testRail.concurrency ?? 3);

  await Promise.all(
    cases.map(({ case: trCase }) =>
      limit(async () => {
        const issueKey = idMap[trCase.id];
        if (!issueKey) return;

        const attachments = await getAttachmentsForCase(trCase.id);
        for (const att of attachments) {
          try {
            const { buffer, contentType } = await downloadAttachment(att.id);
            await uploadAttachment(issueKey, att.name, buffer, contentType);
            logger.info(`Attachment "${att.name}" → ${issueKey}`);
          } catch (e) {
            logger.recordWarning(`attachment(${trCase.id}/${att.id})`, e.message);
          }
        }
      })
    )
  );
}

async function migrateResults(idMap) {
  const projectId = config.testRail.projectId;
  const runs = await getRuns(projectId);

  for (const run of runs) {
    const results = await getResults(run.id);
    const tests = [];

    for (const r of results) {
      const caseId = r.case_id ?? r.test_id;
      const xrayKey = idMap[caseId];
      if (!xrayKey) continue;
      tests.push(transformResult(r, xrayKey));
    }

    if (tests.length === 0) continue;

    const info = {
      summary: `TestRail run: ${run.name} (ID ${run.id})`,
      description: `Imported from TestRail run ${run.id}`,
      project: config.xray.jiraProjectKey,
      startDate: run.created_on
        ? new Date(run.created_on * 1000).toISOString()
        : new Date().toISOString(),
      finishDate: new Date().toISOString(),
    };

    if (dryRun) {
      logger.dry(`Would import ${tests.length} results for run "${run.name}"`);
      continue;
    }

    try {
      await importExecution(info, tests);
      logger.success(`Imported ${tests.length} results for run "${run.name}"`);
    } catch (e) {
      logger.recordError(`results(run-${run.id})`, e.message);
    }
  }
}

function validateConfig() {
  const missing = [];
  if (config.testRail.baseUrl.includes("YOUR_COMPANY")) missing.push("testRail.baseUrl");
  if (config.testRail.apiKey.includes("YOUR_")) missing.push("testRail.apiKey");
  if (config.testRail.username.includes("your@")) missing.push("testRail.username");
  if (config.xray.clientId.includes("YOUR_")) missing.push("xray.clientId");
  if (config.xray.jiraApiToken.includes("YOUR_")) missing.push("xray.jiraApiToken");
  if (missing.length) {
    throw new Error(`Edit config/migration.config.js — missing: ${missing.join(", ")}`);
  }
}

async function main() {
  logger.info("TestRail → Xray migration starting…");
  validateConfig();

  const idMap = loadExistingIdMap();

  if (resultsOnly) {
    if (!config.scope.migrateResults) {
      logger.warn("scope.migrateResults is false — enabling for this run");
    }
    await migrateResults(idMap);
    writeReport(idMap, dryRun);
    return;
  }

  const cases = await collectCases();
  if (cases.length === 0) {
    logger.warn("No cases found. Set pilotCaseIds or --case-ids=1,2,3 in config/CLI.");
    return;
  }

  logger.info(`Found ${cases.length} case(s) to process`);

  const audit = await runAudit(cases);

  if (auditOnly) {
    writeReport(idMap, dryRun, audit);
    return;
  }

  if (config.scope.migrateTestCases) {
    const updatedMap = await migrateCases(cases);
    Object.assign(idMap, updatedMap);
  }

  if (config.scope.migrateResults && !dryRun) {
    await migrateResults(idMap);
  }

  writeReport(idMap, dryRun, audit);
}

main().catch((e) => {
  logger.recordError("fatal", e);
  process.exit(1);
});
