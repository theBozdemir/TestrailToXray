#!/usr/bin/env node
/**
 * List TestRail sections (subsections) and case counts for the configured project.
 */
import { config } from "../config/migration.config.js";
import { getSuites, getSections, getCases, getCasesForProject } from "./extractor/testrail.client.js";
import { formatSectionPath } from "./utils/section-filter.js";
import { logger } from "./utils/logger.js";

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

async function main() {
  const projectId = config.testRail.projectId;
  let suites = await getSuites(projectId);

  if (config.testRail.suiteIds?.length) {
    suites = suites.filter((s) => config.testRail.suiteIds.includes(s.id));
  }

  console.log(`\nTestRail project ${projectId} — sections and case counts\n`);
  console.log("Use in config/migration.config.js:\n");
  console.log('  sectionNames: ["Web App Manager"],  // partial match, case-insensitive\n');

  if (suites.length === 0) {
    const cases = await getCasesForProject(projectId);
    console.log(`(no suites — ${cases.length} case(s) at project level)\n`);
    return;
  }

  for (const suite of suites) {
    const sections = await getSections(projectId, suite.id);
    const cases = await getCases(projectId, suite.id);
    const { pathFor } = buildSectionTree(sections);

    const countByPath = new Map();
    for (const c of cases) {
      const p = formatSectionPath(suite.name, pathFor(c.section_id));
      countByPath.set(p, (countByPath.get(p) ?? 0) + 1);
    }

    console.log(`── Suite: ${suite.name} (id ${suite.id}) — ${cases.length} case(s) ──\n`);

    const rows = [...countByPath.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [path, count] of rows) {
      const leaf = path.split(" / ").pop();
      console.log(`  ${String(count).padStart(4)} cases  |  ${path}`);
      console.log(`         filter → sectionNames: ["${leaf}"]`);
    }
    console.log("");
  }

  logger.info("Tip: npm run migrate with sectionNames set, or --sections=\"Web App Manager\"");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
