import axios from "axios";
import { config } from "../../config/migration.config.js";
import { logger } from "../utils/logger.js";
import { authenticateXray } from "./xray.client.js";

function graphqlBase() {
  return config.xray.apiBaseUrl.replace(/\/api\/v2\/?$/, "");
}

async function graphqlRequest(query, variables) {
  const token = await authenticateXray();
  const res = await axios.post(
    `${graphqlBase()}/api/v2/graphql`,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 120_000,
    }
  );

  if (res.data.errors?.length) {
    throw new Error(res.data.errors.map((e) => e.message).join("; "));
  }

  return res.data.data;
}

/**
 * @param {string} issueKey
 * @returns {Promise<Array<{ id: string, action: string, data: string, result: string, attachments: Array<{id:string,filename:string}> }>>}
 */
export async function getXrayTestSteps(issueKey) {
  const data = await graphqlRequest(
    `query ($jql: String!) {
      getTests(jql: $jql, limit: 1) {
        results {
          steps {
            id
            action
            data
            result
            attachments { id filename }
          }
        }
      }
    }`,
    { jql: `key = ${issueKey}` }
  );

  return data?.getTests?.results?.[0]?.steps ?? [];
}

/**
 * @param {string} stepId
 * @param {string} resultText  plain text only (Xray does not render HTML in step fields)
 * @param {Array<{ filename: string, mimeType: string, data: string }>} attachmentsToAdd  base64 data
 */
export async function updateTestStepWithAttachments(stepId, resultText, attachmentsToAdd = []) {
  const step = {
    result: (resultText && String(resultText).trim()) || " ",
  };

  if (attachmentsToAdd.length > 0) {
    step.attachments = { add: attachmentsToAdd };
  }

  const data = await graphqlRequest(
    `mutation ($stepId: String!, $step: UpdateStepInput!) {
      updateTestStep(stepId: $stepId, step: $step) {
        warnings
      }
    }`,
    { stepId, step }
  );

  const warnings = data?.updateTestStep?.warnings ?? [];
  for (const w of warnings) {
    logger.recordWarning(`xray.step(${stepId})`, String(w));
  }
}

/** @deprecated use updateTestStepWithAttachments */
export async function updateTestStepResult(stepId, resultHtml) {
  return updateTestStepWithAttachments(stepId, resultHtml, []);
}
