/**
 * @typedef {{ action: string, expected: string }} Step
 * @typedef {{ steps: Step[], confidence: number, strategy: string }} ParseResult
 */

export function parseDescription(description) {
  if (!description || description.trim().length === 0) {
    return { steps: [], confidence: 0, strategy: "empty" };
  }

  const text = description.trim();

  const tableResult = tryMarkdownTable(text);
  if (tableResult) return tableResult;

  const numberedResult = tryNumberedList(text);
  if (numberedResult) return numberedResult;

  const letteredResult = tryLetteredList(text);
  if (letteredResult) return letteredResult;

  const keywordResult = tryKeywordPairs(text);
  if (keywordResult) return keywordResult;

  return {
    steps: [{ action: text, expected: "" }],
    confidence: 0.2,
    strategy: "raw_dump",
  };
}

function tryMarkdownTable(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const tableLines = lines.filter((l) => l.startsWith("|"));
  if (tableLines.length < 3) return null;

  const headers = tableLines[0]
    .split("|")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const actionIdx = headers.findIndex((h) => /action|step|description/.test(h));
  const expectedIdx = headers.findIndex((h) => /expected|result|outcome/.test(h));
  if (actionIdx === -1) return null;

  const dataRows = tableLines.slice(2);
  const steps = dataRows
    .map((row) => {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      return {
        action: cells[actionIdx] ?? "",
        expected: expectedIdx !== -1 ? (cells[expectedIdx] ?? "") : "",
      };
    })
    .filter((s) => s.action.length > 0);

  if (steps.length === 0) return null;

  return {
    steps,
    confidence: expectedIdx !== -1 ? 0.95 : 0.8,
    strategy: "markdown_table",
  };
}

function tryNumberedList(text) {
  const NUMBERED = /^(?:step\s*)?(\d+)[.):\-]\s+(.+)/i;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const stepLines = lines.filter((l) => NUMBERED.test(l));
  if (stepLines.length < 2) return null;

  const steps = stepLines.map((line) => {
    const match = line.match(NUMBERED);
    const raw = match[2];
    const expMatch = raw.match(/^(.+?)\s*[.\-–—]\s*[Ee]xpected[:\s]+(.+)$/);
    if (expMatch) {
      return { action: expMatch[1].trim(), expected: expMatch[2].trim() };
    }
    return { action: raw.trim(), expected: "" };
  });

  return {
    steps: pairWithExpectedLines(steps, lines, NUMBERED),
    confidence: steps.some((s) => s.expected) ? 0.9 : 0.75,
    strategy: "numbered_list",
  };
}

function tryLetteredList(text) {
  const LETTERED = /^([a-z])[.)]\s+(.+)/i;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const stepLines = lines.filter((l) => LETTERED.test(l));
  if (stepLines.length < 2) return null;

  const steps = stepLines.map((line) => {
    const match = line.match(LETTERED);
    return { action: match[2].trim(), expected: "" };
  });

  return { steps, confidence: 0.65, strategy: "lettered_list" };
}

function tryKeywordPairs(text) {
  const ACTION_KW = /^(?:action|step|do|input)[:\-]\s*/i;
  const EXPECTED_KW = /^(?:expected|result|output|verify|assert)[:\-]\s*/i;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const steps = [];
  let current = null;

  for (const line of lines) {
    if (ACTION_KW.test(line)) {
      if (current) steps.push(current);
      current = { action: line.replace(ACTION_KW, "").trim(), expected: "" };
    } else if (EXPECTED_KW.test(line) && current) {
      current.expected = line.replace(EXPECTED_KW, "").trim();
    }
  }
  if (current) steps.push(current);
  if (steps.length === 0) return null;

  return {
    steps,
    confidence: steps.some((s) => s.expected) ? 0.85 : 0.65,
    strategy: "keyword_pairs",
  };
}

function pairWithExpectedLines(steps, allLines, stepPattern) {
  const EXPECTED_LINE = /^[Ee]xpected[:\s]+(.+)/;
  const enriched = steps.map((s) => ({ ...s }));
  let stepIdx = -1;

  for (const line of allLines) {
    if (stepPattern.test(line)) {
      stepIdx++;
    } else if (EXPECTED_LINE.test(line) && stepIdx >= 0 && stepIdx < enriched.length) {
      if (!enriched[stepIdx].expected) {
        enriched[stepIdx].expected = line.match(EXPECTED_LINE)[1].trim();
      }
    }
  }

  return enriched;
}

/**
 * TestRail often stores actions in custom_steps and expected results in custom_expected.
 */
export function extractTestRailSteps(testCase) {
  let separated = testCase.custom_steps_separated;

  if (typeof separated === "string" && separated.trim()) {
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

  const actionsText = testCase.custom_steps?.trim() ?? "";
  if (!actionsText) return [];

  const steps = parseActionStepsFromText(actionsText);
  const expectedText = normalizeExpectedField(testCase.custom_expected);

  if (expectedText && steps.length > 0) {
    if (steps.length === 1) {
      steps[0].expected = expectedText;
    } else {
      steps[steps.length - 1].expected = expectedText;
    }
  }

  return steps;
}

export function hasStructuredSteps(testCase) {
  const separated = testCase.custom_steps_separated;

  if (Array.isArray(separated) && separated.length > 0) return true;

  if (typeof separated === "string" && separated.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(separated);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      /* fall through */
    }
  }

  return typeof testCase.custom_steps === "string" && testCase.custom_steps.trim().length > 0;
}

function parseActionStepsFromText(text) {
  const clean = stripHtml(text).trim();
  if (!clean) return [];

  const parts = clean
    .split(/(?=(?:^|\n)\d+[\.)]\s)/m)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    return parts.map((part) => {
      const m = part.match(/^\d+[\.)]\s*([\s\S]+)/);
      return { action: (m ? m[1] : part).trim(), expected: "" };
    });
  }

  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numbered = lines.filter((l) => /^\d+[\.)]\s/.test(l));

  if (numbered.length >= 2) {
    return numbered.map((line) => {
      const m = line.match(/^\d+[\.)]\s*(.+)/);
      return { action: m[1].trim(), expected: "" };
    });
  }

  if (lines.length >= 2 && numbered.length === 0) {
    return lines.map((line) => ({ action: line, expected: "" }));
  }

  return [{ action: clean, expected: "" }];
}

function normalizeExpectedField(text) {
  if (!text || !String(text).trim()) return "";

  const raw = String(text).trim();

  if (/attachments\/get\/[a-f0-9-]+/i.test(raw)) {
    const textOnly = stripHtml(raw).replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
    if (!textOnly || textOnly.length < 15) {
      return "Expected result: screenshot/image from TestRail (see attachments on this issue).";
    }
    return textOnly;
  }

  return stripHtml(raw);
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

export function getUnstructuredText(testCase, fieldNames = []) {
  const parts = [];
  for (const field of fieldNames) {
    const val = testCase[field];
    if (typeof val === "string" && val.trim()) {
      parts.push(val.trim());
    }
  }
  return parts.join("\n\n");
}
