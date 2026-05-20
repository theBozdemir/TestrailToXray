/**
 * Console + file logging; tracks migrated, errors, warnings, manual review queue.
 */
import fs from "fs";
import path from "path";
import { config } from "../../config/migration.config.js";

const timestamp = () => new Date().toISOString();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class Logger {
  constructor() {
    ensureDir(config.output.logsDir);
    ensureDir(config.output.reportsDir);

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = path.join(config.output.logsDir, `migration-${runId}.log`);
    this.errorFile = path.join(config.output.logsDir, `errors-${runId}.log`);

    this.errors = [];
    this.warnings = [];
    this.skipped = [];
    this.migrated = [];
    this.manualReview = [];
  }

  _write(file, line) {
    fs.appendFileSync(file, line + "\n");
  }

  _console(level, ...args) {
    const line = `[${timestamp()}] [${level}] ${args.join(" ")}`;
    this._write(this.logFile, line);
    const codes = {
      INFO: "\x1b[36m",
      WARN: "\x1b[33m",
      ERROR: "\x1b[31m",
      SUCCESS: "\x1b[32m",
      DRY: "\x1b[35m",
    };
    const reset = "\x1b[0m";
    console.log(`${codes[level] ?? ""}${line}${reset}`);
  }

  info(...args) { this._console("INFO", ...args); }
  warn(...args) { this._console("WARN", ...args); }
  error(...args) { this._console("ERROR", ...args); }
  success(...args) { this._console("SUCCESS", ...args); }
  dry(...args) { this._console("DRY", ...args); }

  recordError(context, err) {
    const entry = { context, message: err?.message ?? String(err), ts: timestamp() };
    this.errors.push(entry);
    this._write(this.errorFile, JSON.stringify(entry));
    this.error(`[${context}] ${entry.message}`);
  }

  recordSkip(id, reason) {
    this.skipped.push({ id, reason });
    this.warn(`SKIP id=${id} reason="${reason}"`);
  }

  recordMigrated(testRailId, xrayKey) {
    this.migrated.push({ testRailId, xrayKey });
  }

  recordManualReview(testRailId, title, reason, confidence) {
    this.manualReview.push({ testRailId, title, reason, confidence });
    this.warn(
      `MANUAL_REVIEW id=${testRailId} title="${title}" reason="${reason}" confidence=${confidence}`
    );
  }

  recordWarning(context, msg) {
    this.warnings.push({ context, msg });
    this.warn(`[${context}] ${msg}`);
  }
}

export const logger = new Logger();
