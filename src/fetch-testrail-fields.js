#!/usr/bin/env node
/**
 * Download TestRail case/result field definitions and write reports for review.
 * Uses credentials from config/migration.config.js
 */
import fs from "fs";
import { config } from "../config/migration.config.js";
import { getCaseFields, getResultFields } from "./extractor/testrail.client.js";
import { buildFieldMapsFromDefs } from "./utils/testrail-custom-fields.js";
import { logger } from "./utils/logger.js";

const reportsDir = config.output.reportsDir ?? "./reports";

async function main() {
  const [caseFields, resultFields] = await Promise.all([getCaseFields(), getResultFields()]);

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    `${reportsDir}/testrail-case-fields.json`,
    JSON.stringify(caseFields, null, 2)
  );
  fs.writeFileSync(
    `${reportsDir}/testrail-result-fields.json`,
    JSON.stringify(resultFields, null, 2)
  );
  fs.writeFileSync(
    `${reportsDir}/testrail-field-maps.json`,
    JSON.stringify(
      {
        case: buildFieldMapsFromDefs(caseFields),
        result: buildFieldMapsFromDefs(resultFields),
      },
      null,
      2
    )
  );

  logger.success(`Wrote ${caseFields.length} case + ${resultFields.length} result field defs to ${reportsDir}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
