/**
 * Filter TestRail cases by suite section name or id.
 */

function normalize(s) {
  return String(s).trim().toLowerCase();
}

/**
 * @param {string[]} sectionPath  e.g. ["Web Services Client (WSC)", "Web App Manager"]
 * @param {string} suiteName
 */
export function formatSectionPath(suiteName, sectionPath = []) {
  return [suiteName, ...sectionPath].filter(Boolean).join(" / ");
}

/**
 * @param {object} caseRow  TestRail case with section_id
 * @param {string[]} sectionPath from buildSectionTree.pathFor
 * @param {string} suiteName
 * @param {{ sectionNames?: string[], sectionIds?: number[], sectionPaths?: string[] }} filters
 */
export function caseMatchesSectionFilter(caseRow, sectionPath, suiteName, filters) {
  const names = (filters.sectionNames ?? []).map(normalize).filter(Boolean);
  const ids = new Set((filters.sectionIds ?? []).map(Number).filter(Boolean));
  const paths = (filters.sectionPaths ?? []).map(normalize).filter(Boolean);

  if (names.length === 0 && ids.size === 0 && paths.length === 0) {
    return true;
  }

  const fullPath = normalize(formatSectionPath(suiteName, sectionPath));

  if (paths.length > 0) {
    const matched = paths.some((p) => fullPath.includes(p) || fullPath.endsWith(p));
    if (matched) return true;
  }

  if (names.length > 0) {
    const segments = [suiteName, ...sectionPath].map(normalize);
    const matched = names.some((needle) =>
      segments.some((seg) => seg.includes(needle) || needle.includes(seg))
    );
    if (matched) return true;
  }

  if (ids.size > 0 && caseRow.section_id != null) {
    if (ids.has(Number(caseRow.section_id))) return true;
  }

  return false;
}

/**
 * Whether case is in filterSectionId or any of its descendant sections.
 * @param {Map<number, object>} sectionById
 */
export function caseInSectionSubtree(caseSectionId, filterSectionId, sectionById) {
  if (!caseSectionId || !filterSectionId) return false;
  let cur = sectionById.get(caseSectionId);
  while (cur) {
    if (cur.id === filterSectionId) return true;
    cur = cur.parent_id ? sectionById.get(cur.parent_id) : null;
  }
  return false;
}

export function caseMatchesSectionFilterWithTree(
  caseRow,
  sectionPath,
  suiteName,
  filters,
  sectionById
) {
  const ids = filters.sectionIds ?? [];
  if (ids.length > 0 && sectionById) {
    for (const filterId of ids) {
      if (caseInSectionSubtree(caseRow.section_id, filterId, sectionById)) {
        return true;
      }
    }
  }

  const withoutIds = {
    ...filters,
    sectionIds: ids.length > 0 ? [] : filters.sectionIds,
  };
  if (ids.length > 0) {
    return caseMatchesSectionFilter(caseRow, sectionPath, suiteName, withoutIds);
  }

  return caseMatchesSectionFilter(caseRow, sectionPath, suiteName, filters);
}

export function getSectionFiltersFromConfig(config, cliSectionNames = []) {
  const fromConfig = config.testRail.sectionNames ?? [];
  const names = [...new Set([...fromConfig, ...cliSectionNames].map((s) => String(s).trim()).filter(Boolean))];
  return {
    sectionNames: names,
    sectionIds: config.testRail.sectionIds ?? [],
    sectionPaths: config.testRail.sectionPaths ?? [],
  };
}

export function hasSectionFilter(filters) {
  return (
    (filters.sectionNames?.length ?? 0) > 0 ||
    (filters.sectionIds?.length ?? 0) > 0 ||
    (filters.sectionPaths?.length ?? 0) > 0
  );
}
