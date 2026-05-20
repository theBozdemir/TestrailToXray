#!/usr/bin/env node
import fs from "fs";
import path from "path";
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
  getTestsForRun,
  getAttachmentsForRun,
  getAttachmentsForCase,
  getCaseFields,
  getResultFields,
  downloadAttachment,
} from "./extractor/testrail.client.js";
import { buildFieldMapsFromDefs } from "./utils/testrail-custom-fields.js";
import {
  transformCase,
  transformResult,
  buildFolderPath,
  buildDescription,
} from "./transformer/transformer.js";
import { hasStructuredSteps } from "./transformer/parser.js";
import { importTestsBulk, extractKeysFromJob, importExecution } from "./importer/xray.client.js";
import {
  findExistingTestByLabel,
  getIssueAttachments,
  getIssueAttachmentNames,
  uploadAttachment,
  updateIssueDescription,
  clearIssueAssignee,
  linkIssues,
  resolveRefKeys,
  collectDefectKeysFromResult,
  issueExists,
} from "./importer/jira.client.js";
import {
  buildAttachmentIdMap,
  buildExpectedResultPlainText,
  stepExpectedResultLabel,
  resolveStepExpectedAttachments,
  resolvePreconditionAttachments,
  testrailUploadFilename,
} from "./utils/jira-content.js";
import { getXrayTestSteps, updateTestStepWithAttachments } from "./importer/xray-steps.client.js";
import { extractTestRailSteps, getRawStepExpecteds } from "./transformer/parser.js";
import {
  buildResultEvidence,
  groupAttachmentsByResultId,
} from "./utils/result-evidence.js";
import {
  caseMatchesSectionFilterWithTree,
  getSectionFiltersFromConfig,
  hasSectionFilter,
} from "./utils/section-filter.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const auditOnly = args.includes("--audit-only");
const resultsOnly = args.includes("--results-only");
const repairDescriptions = args.includes("--repair-descriptions");
const forceReimport = args.includes("--reimport");
const caseIdsArg = args.find((a) => a.startsWith("--case-ids="));
const cliCaseIds = caseIdsArg
  ? caseIdsArg
      .split("=")[1]
      .split(",")
      .map((s) => Number(s.trim()))
      .filter(Boolean)
  : [];

const sectionsArg = args.find((a) => a.startsWith("--sections="));
const cliSectionNames = sectionsArg
  ? sectionsArg
      .split("=")[1]
      .split(",")
      .map((s) => s.trim())
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

  return { pathFor, byId };
}

function shouldMigrateCase(caseId) {
  const pilot = config.testRail.pilotCaseIds?.length
    ? config.testRail.pilotCaseIds
    : cliCaseIds;
  if (pilot.length === 0) return true;
  return pilot.includes(caseId);
}

function shouldIncludeCase(trCase, sectionPath, suiteName, sectionById) {
  if (cliCaseIds.length > 0) {
    return cliCaseIds.includes(trCase.id);
  }
  if (config.testRail.pilotCaseIds?.length) {
    if (!config.testRail.pilotCaseIds.includes(trCase.id)) return false;
  }

  const sectionFilters = getSectionFiltersFromConfig(config, cliSectionNames);
  if (hasSectionFilter(sectionFilters)) {
    return caseMatchesSectionFilterWithTree(
      trCase,
      sectionPath,
      suiteName,
      sectionFilters,
      sectionById
    );
  }

  return shouldMigrateCase(trCase.id);
}

async function collectCases() {
  const projectId = config.testRail.projectId;
  const sectionFilters = getSectionFiltersFromConfig(config, cliSectionNames);
  if (hasSectionFilter(sectionFilters)) {
    logger.info(
      `Section filter: names=[${sectionFilters.sectionNames.join(", ")}]` +
        (sectionFilters.sectionIds.length
          ? ` ids=[${sectionFilters.sectionIds.join(", ")}]`
          : "")
    );
  }

  let suites = await getSuites(projectId);

  if (config.testRail.suiteIds?.length) {
    suites = suites.filter((s) => config.testRail.suiteIds.includes(s.id));
  }

  const allCases = [];

  // Single-suite or suite-less layouts: migrate all project cases under one folder
  if (suites.length === 0) {
    let cases = await getCasesForProject(projectId);
    const suite = { name: "Test Cases" };
    for (const c of cases) {
      if (!shouldIncludeCase(c, [], suite.name, null)) continue;
      allCases.push({ case: c, suite, folderPath: "/Test Cases" });
    }
    return allCases;
  }

  for (const suite of suites) {
    const sections = await getSections(projectId, suite.id);
    const { pathFor, byId } = buildSectionTree(sections);
    const cases = await getCases(projectId, suite.id);

    for (const c of cases) {
      const sectionPath = pathFor(c.section_id);
      if (!shouldIncludeCase(c, sectionPath, suite.name, byId)) continue;
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

async function recoverFromJira(metaList, idMap) {
  let recovered = 0;
  for (const m of metaList) {
    if (idMap[m.testRailId]) continue;
    const key = await findExistingTestByLabel(m.testRailId);
    if (key) {
      idMap[m.testRailId] = key;
      logger.recordMigrated(m.testRailId, key);
      logger.success(`TR-${m.testRailId} → ${key} (found in Jira)`);
      recovered++;
    }
  }
  return recovered;
}

async function importBatch(imports, metaList, idMap) {
  const trIds = metaList.map((m) => m.testRailId);
  let job;

  try {
    job = await importTestsBulk(imports);
  } catch (e) {
    if (e.message?.includes("timed out")) {
      logger.warn(`Job ${e.jobId ?? "?"} timed out — checking Jira for created tests…`);
      const n = await recoverFromJira(metaList, idMap);
      if (n > 0) {
        logger.info(`Recovered ${n}/${metaList.length} test(s) from Jira after timeout`);
        return;
      }
    }
    throw e;
  }

  const batchMap = extractKeysFromJob(job, trIds);

  for (const m of metaList) {
    const key = batchMap[m.testRailId];
    if (key) {
      idMap[m.testRailId] = key;
      logger.recordMigrated(m.testRailId, key);
      logger.success(`TR-${m.testRailId} → ${key}`);
    } else {
      const fromJira = await findExistingTestByLabel(m.testRailId);
      if (fromJira) {
        idMap[m.testRailId] = fromJira;
        logger.recordMigrated(m.testRailId, fromJira);
        logger.success(`TR-${m.testRailId} → ${fromJira} (found in Jira)`);
      } else {
        logger.recordError(`import(${m.testRailId})`, "No issue key returned from Xray job");
      }
    }
  }
}

async function loadCaseFieldDefs() {
  if (config.scope.includeAllCustomFields === false) return [];
  return getCaseFields();
}

async function loadResultFieldDefs() {
  if (config.scope.includeAllCustomFields === false) return [];
  return getResultFields();
}

async function migrateCases(cases) {
  const idMap = loadExistingIdMap();
  const caseFieldDefs = await loadCaseFieldDefs();
  if (caseFieldDefs.length > 0) {
    logger.info(`Loaded ${caseFieldDefs.length} TestRail case field definition(s) from API`);
  }
  // Import 1 test per Xray job — avoids queue timeouts (only 1 bulk job per user at a time)
  const batchSize = config.xray.importBatchSize ?? 1;

  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);
    const imports = [];
    const metaList = [];

    for (const { case: trCase, folderPath } of batch) {
      if (!forceReimport && idMap[trCase.id]) {
        logger.info(`Skip TR-${trCase.id} — already mapped to ${idMap[trCase.id]}`);
        continue;
      }

      const existing =
        dryRun || forceReimport ? null : await findExistingTestByLabel(trCase.id);
      if (existing) {
        idMap[trCase.id] = existing;
        logger.recordMigrated(trCase.id, existing);
        continue;
      }

      const attachments = await getAttachmentsForCase(trCase.id);
      const attachmentMap = buildAttachmentIdMap(attachments);

      const { importPayload, meta } = transformCase(trCase, folderPath, dryRun, {
        attachmentMap,
        idMap,
        caseFieldDefs,
      });
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
      await importBatch(imports, metaList, idMap);
    } catch (e) {
      if (config.errors.strategy === "stop") throw e;
      logger.warn(`Batch import failed — retrying one-by-one: ${e.message}`);
      for (let j = 0; j < imports.length; j++) {
        try {
          await importBatch([imports[j]], [metaList[j]], idMap);
        } catch (oneErr) {
          logger.recordError(`import(${metaList[j].testRailId})`, oneErr.message);
        }
      }
    }
  }

  if (!dryRun && config.scope.migrateAttachments) {
    logger.info("Uploading attachments to Jira (can take a few minutes if many files)…");
    await migrateAttachments(cases, idMap, caseFieldDefs);
  }

  return idMap;
}

async function migrateAttachments(cases, idMap, caseFieldDefs = []) {
  const limit = pLimit(config.testRail.concurrency ?? 3);

  await Promise.all(
    cases.map(({ case: trCase }) =>
      limit(async () => {
        const issueKey = idMap[trCase.id];
        if (!issueKey || String(issueKey).startsWith("DRY-RUN")) return;

        const attachments = await getAttachmentsForCase(trCase.id);
        const attachmentMap = buildAttachmentIdMap(attachments);

        const existingNames = new Set(await getIssueAttachmentNames(issueKey));

        const precondFiles = resolvePreconditionAttachments(
          trCase.custom_preconds,
          attachments,
          attachmentMap
        );
        const filesToUpload = new Map();
        for (const att of [...attachments, ...precondFiles]) {
          filesToUpload.set(att.id, att);
        }

        for (const att of filesToUpload.values()) {
          try {
            const uploadName = testrailUploadFilename(att);
            if (existingNames.has(uploadName)) {
              logger.info(`Attachment "${uploadName}" already on ${issueKey} — skip upload`);
              continue;
            }
            const { buffer, contentType } = await downloadAttachment(att.id);
            await uploadAttachment(issueKey, uploadName, buffer, contentType);
            existingNames.add(uploadName);
            logger.info(`Attachment "${uploadName}" → ${issueKey}`);
          } catch (e) {
            logger.recordWarning(`attachment(${trCase.id}/${att.id})`, e.message);
          }
        }

        await postProcessIssue(
          trCase,
          issueKey,
          attachmentMap,
          idMap,
          attachments,
          caseFieldDefs
        );
      })
    )
  );
}

async function postProcessIssue(
  trCase,
  issueKey,
  attachmentMap,
  idMap,
  testrailAttachments = [],
  caseFieldDefs = []
) {
  const strategy = hasStructuredSteps(trCase) ? "structured" : "heuristic";

  if (config.xray.forceUnassigned !== false) {
    await clearIssueAssignee(issueKey);
  }

  const description = buildDescription(trCase, strategy, attachmentMap, idMap, caseFieldDefs);

  let jiraAttachments = [];
  try {
    jiraAttachments = await getIssueAttachments(issueKey);
    await updateIssueDescription(issueKey, description, jiraAttachments);
    logger.info(`Updated description on ${issueKey}`);
  } catch (e) {
    const detail = e.response?.data?.errors
      ? JSON.stringify(e.response.data.errors)
      : e.message;
    logger.recordWarning(`description(${issueKey})`, detail);
  }

  await postProcessTestSteps(trCase, issueKey, attachmentMap, testrailAttachments);

  const refKeys = resolveRefKeys(trCase.refs);
  if (refKeys.length > 0) {
    await linkIssues(issueKey, refKeys);
  }
}

async function postProcessTestSteps(trCase, issueKey, attachmentMap, testrailAttachments) {
  try {
    const trSteps = extractTestRailSteps(trCase, attachmentMap);
    const rawByStep = getRawStepExpecteds(trCase);
    const xraySteps = await getXrayTestSteps(issueKey);
    if (xraySteps.length === 0) return;

    for (let i = 0; i < xraySteps.length; i++) {
      const xStep = xraySteps[i];
      const trStep = trSteps[i];
      const rawExpected = rawByStep[i] ?? rawByStep[rawByStep.length - 1] ?? "";
      const expected = trStep?.expected ?? "";

      const needsImage =
        /attachments\/get\//i.test(rawExpected) ||
        /!\S[^|!\n]*(?:\|[^!]*)?!/.test(expected) ||
        /\(image — see Attachments/i.test(xStep.result ?? "") ||
        /<img\s/i.test(xStep.result ?? "");

      const plainText = buildExpectedResultPlainText(expected, rawExpected);
      const filesToAttach = resolveStepExpectedAttachments(
        rawExpected,
        testrailAttachments,
        attachmentMap
      );

      const existingNames = new Set((xStep.attachments ?? []).map((a) => a.filename));
      const willHaveImage =
        filesToAttach.length > 0 || existingNames.size > 0 || needsImage;

      const resultText = stepExpectedResultLabel(plainText, willHaveImage);

      if (!resultText && filesToAttach.length === 0 && !needsImage) continue;

      const attachmentsToAdd = [];

      for (const att of filesToAttach) {
        const filename = testrailUploadFilename(att);
        if (existingNames.has(filename)) continue;

        const { buffer, contentType } = await downloadAttachment(att.id);
        attachmentsToAdd.push({
          filename,
          mimeType: contentType || "application/octet-stream",
          data: buffer.toString("base64"),
        });
      }

      const needsUpdate =
        attachmentsToAdd.length > 0 ||
        (xStep.result ?? "").trim() !== resultText.trim() ||
        /<img\s/i.test(xStep.result ?? "") ||
        /^(|\s+)$/.test(xStep.result ?? "");

      if (!needsUpdate) continue;

      await updateTestStepWithAttachments(xStep.id, resultText, attachmentsToAdd);
      logger.info(
        `Updated step ${i + 1} on ${issueKey}` +
          (attachmentsToAdd.length ? ` (+${attachmentsToAdd.length} image(s))` : "")
      );
    }
  } catch (e) {
    logger.recordWarning(`steps(${issueKey})`, e.message);
  }
}

function loadImportedRuns() {
  const file = config.output.importedRunsFile ?? "./reports/imported-runs.json";
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* ignore */
  }
  return {};
}

function saveImportedRuns(importedRuns) {
  const file = config.output.importedRunsFile ?? "./reports/imported-runs.json";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(importedRuns, null, 2));
}

async function migrateResults(idMap) {
  const resultFieldDefs = await loadResultFieldDefs();
  if (resultFieldDefs.length > 0) {
    logger.info(`Loaded ${resultFieldDefs.length} TestRail result field definition(s) from API`);
  }

  const projectId = config.testRail.projectId;
  const lookback = config.scope.resultsLookbackDays ?? 180;
  let runs = await getRuns(projectId);

  const runIdFilter = config.testRail.runIds ?? [];
  if (runIdFilter.length) {
    runs = runs.filter((r) => runIdFilter.includes(r.id));
  }

  if (runs.length === 0) {
    logger.warn(
      `No TestRail test runs found in project ${projectId} (last ${lookback} days). ` +
        "Create/complete a run in TestRail first, or increase scope.resultsLookbackDays."
    );
    return;
  }

  const importedRuns = loadImportedRuns();
  let importedCount = 0;
  let skippedCount = 0;

  for (const run of runs) {
    if (importedRuns[String(run.id)] && !forceReimport) {
      logger.info(`Skip run ${run.id} "${run.name}" — already imported`);
      skippedCount++;
      continue;
    }

    const results = await getResults(run.id);
    const testsInRun = await getTestsForRun(run.id);
    const testIdToCaseId = Object.fromEntries(
      testsInRun.map((t) => [t.id, t.case_id])
    );

    const migrateEvidence =
      config.scope.migrateResultAttachments !== false && !dryRun;
    const runAttachments = migrateEvidence ? await getAttachmentsForRun(run.id) : [];
    const attachmentsByResultId = groupAttachmentsByResultId(runAttachments);

    const evidenceLimit = pLimit(config.testRail.concurrency ?? 3);
    const maxFiles = config.scope.resultEvidenceMaxFiles ?? 20;
    const maxTotalBytes =
      (config.scope.resultEvidenceMaxTotalMb ?? 25) * 1024 * 1024;

    const tests = [];
    let evidenceFileCount = 0;
    let defectLinkCount = 0;

    const resultJobs = results
      .map((r) => {
        const caseId = r.case_id ?? testIdToCaseId[r.test_id];
        if (!caseId) return null;
        const xrayKey = idMap[caseId];
        if (!xrayKey) return null;
        return { r, xrayKey };
      })
      .filter(Boolean);

    const transformed = await Promise.all(
      resultJobs.map(({ r, xrayKey }) =>
        evidenceLimit(async () => {
          let evidence = [];
          if (migrateEvidence) {
            evidence = await buildResultEvidence(
              r,
              attachmentsByResultId,
              runAttachments,
              { downloadAttachment, maxFiles, maxTotalBytes }
            );
            evidenceFileCount += evidence.length;
          }

          let defectKeys = [];
          if (config.scope.migrateResultDefects !== false) {
            defectKeys = collectDefectKeysFromResult(r);
            if (config.scope.validateResultDefects && defectKeys.length > 0) {
              const validated = [];
              for (const key of defectKeys) {
                if (await issueExists(key)) validated.push(key);
                else {
                  logger.recordWarning(
                    `result-defect(${r.id})`,
                    `Jira issue ${key} not found — skipped`
                  );
                }
              }
              defectKeys = validated;
            }
            defectLinkCount += defectKeys.length;
          }

          return transformResult(r, xrayKey, evidence, defectKeys, resultFieldDefs);
        })
      )
    );
    tests.push(...transformed);

    if (tests.length === 0) {
      logger.info(`Skip run ${run.id} "${run.name}" — no results for migrated tests`);
      continue;
    }

    const startDate = run.created_on
      ? new Date(run.created_on * 1000).toISOString()
      : new Date().toISOString();
    const finishDate = run.completed_on
      ? new Date(run.completed_on * 1000).toISOString()
      : startDate;

    const info = {
      summary: `TestRail: ${run.name}`,
      description:
        `Imported from TestRail test run ${run.id}.\n` +
        (run.url ? `TestRail run: ${run.url}` : ""),
      project: config.xray.jiraProjectKey,
      startDate,
      finishDate,
    };

    if (dryRun) {
      const notes = [];
      if (config.scope.migrateResultAttachments !== false) {
        notes.push("screenshots as Xray evidence");
      }
      if (config.scope.migrateResultDefects !== false) {
        notes.push("defect keys as Xray defects on each test run");
      }
      const extraNote = notes.length ? ` (${notes.join("; ")})` : "";
      logger.dry(
        `Would create Test Execution for run "${run.name}" (${run.id}) with ${tests.length} test result(s)${extraNote}`
      );
      continue;
    }

    try {
      const job = await importExecution(info, tests);
      importedRuns[String(run.id)] = {
        testRailRunId: run.id,
        name: run.name,
        testCount: tests.length,
        importedAt: new Date().toISOString(),
        jobId: job?.jobId ?? job?.id,
      };
      saveImportedRuns(importedRuns);
      importedCount++;
      const extras = [];
      if (evidenceFileCount > 0) extras.push(`${evidenceFileCount} evidence file(s)`);
      if (defectLinkCount > 0) extras.push(`${defectLinkCount} defect link(s)`);
      const extraNote = extras.length ? `, ${extras.join(", ")}` : "";
      logger.success(
        `Imported run "${run.name}" → Test Execution (${tests.length} tests${extraNote})`
      );
    } catch (e) {
      logger.recordError(`results(run-${run.id})`, e.message);
    }
  }

  logger.info(
    `Test executions: ${importedCount} imported, ${skippedCount} skipped (already done)`
  );
}

async function repairDescriptionsForCases(idMap, caseIds) {
  const caseFieldDefs = await loadCaseFieldDefs();
  const limit = pLimit(config.testRail.concurrency ?? 3);
  const targets = caseIds.length
    ? caseIds.filter((id) => idMap[id])
    : Object.keys(idMap).map(Number);

  if (targets.length === 0) {
    logger.warn("No mapped cases to repair — check id-map.json and --case-ids");
    return;
  }

  await Promise.all(
    targets.map((trId) =>
      limit(async () => {
        const issueKey = idMap[trId];
        if (!issueKey || String(issueKey).startsWith("DRY-RUN")) return;

        const trCase = await getCase(trId);
        const attachments = await getAttachmentsForCase(trId);
        const attachmentMap = buildAttachmentIdMap(attachments);
        await postProcessIssue(
          trCase,
          issueKey,
          attachmentMap,
          idMap,
          attachments,
          caseFieldDefs
        );
        logger.success(`Repaired description on ${issueKey} (TR-${trId})`);
      })
    )
  );
}

function validateConfig() {
  const missing = [];
  if (config.testRail.baseUrl.includes("YOUR_COMPANY")) missing.push("testRail.baseUrl");
  if (config.testRail.apiKey.includes("YOUR_")) missing.push("testRail.apiKey");
  if (config.testRail.username.includes("your@")) missing.push("testRail.username");
  if (config.xray.clientId.includes("YOUR_")) missing.push("xray.clientId");
  if (config.xray.jiraApiToken.includes("YOUR_")) missing.push("xray.jiraApiToken");
  if (config.xray.clientSecret?.includes("YOUR_")) missing.push("xray.clientSecret");
  if (missing.length) {
    throw new Error(`Edit config/migration.config.js — missing: ${missing.join(", ")}`);
  }
}

async function main() {
  logger.info("TestRail → Xray migration starting…");
  validateConfig();

  if (!args.includes("--skip-xray-check") && !auditOnly && !dryRun) {
    const { resolveXrayRegion } = await import("./importer/xray.client.js");
    logger.info("Resolving Xray API region…");
    await resolveXrayRegion();
    logger.success("Xray region + authentication OK");
  }

  const idMap = loadExistingIdMap();

  if (repairDescriptions) {
    const ids = cliCaseIds.length ? cliCaseIds : Object.keys(idMap).map(Number);
    logger.info(`Repairing Jira descriptions for ${ids.length} case(s)…`);
    await repairDescriptionsForCases(idMap, ids);
    writeReport(idMap, dryRun);
    return;
  }

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
    logger.warn(
      "No cases found. Set sectionNames, pilotCaseIds, --sections=..., or --case-ids=... " +
        "(run npm run list-sections to see subsection names)."
    );
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
