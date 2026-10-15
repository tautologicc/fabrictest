#!/usr/bin/env node
// check-commit-message.mjs -- validate a Git commit message against the
// Scoped Commits convention.
//
// As a library:
//   import checkCommitMessage from "./check-commit-message.mjs";
//   const { ok, issues } = checkCommitMessage(message);
//
// As a commit-msg hook:
//   node check-commit-message.mjs "$1"

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CC_TYPES = "build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test";

// Merges, reverts, fixups, squashes, and amends may use Git's default forms.
const SPECIAL_SUBJECTS = [
  /^Merge /,
  /^Revert /,
  /^fixup!/,
  /^squash!/,
  /^amend!/,
  /^Auto-merged /,
];

/**
 * Validate a commit message against the Scoped Commits convention.
 *
 * The message is normalized first: CRLF becomes LF, Git comment lines are
 * dropped, leading/trailing blank lines are trimmed. A subject such as
 * "#42: ..." is kept so it can be flagged as a ticket-like scope.
 *
 * @param {string} message Raw commit message.
 * @returns {{
 *   ok: boolean,
 *   special: boolean,
 *   subject: string,
 *   issues: Array<{ severity: "error" | "warning", message: string }>,
 * }} `ok` is true when there are no error-severity issues; `special` marks
 *   merge/revert/fixup/squash/amend commits, which are accepted as-is;
 *   `issues` preserves discovery order for display.
 */
export default function checkCommitMessage(message) {
  const issues = [];
  const error = (text) => issues.push({ severity: "error", message: text });
  const warn = (text) => issues.push({ severity: "warning", message: text });

  // Normalize CRLF and drop Git comment lines and leading blank lines.
  // Git template comments start with "# " (or are a bare "#");
  // a subject such as "#42: ..." is kept so it can be flagged.
  const cleaned = [];
  let begun = false;
  for (const line of message.replace(/\r\n?/g, "\n").split("\n")) {
    if (!begun && /^\s*$/.test(line)) {
      continue;
    }
    if (/^#[ \t]/.test(line) || /^#$/.test(line)) {
      continue;
    }
    begun = true;
    cleaned.push(line);
  }
  while (cleaned.length > 0 && /^\s*$/.test(cleaned[cleaned.length - 1])) {
    cleaned.pop();
  }

  const subject = cleaned[0] ?? "";
  const second = cleaned[1] ?? "";
  const scope = subject.split(":")[0];

  if (subject === "") {
    error("empty commit message");
    return { ok: false, special: false, subject, issues };
  }

  if (SPECIAL_SUBJECTS.some((pattern) => pattern.test(subject))) {
    return { ok: true, special: true, subject, issues };
  }

  // Conventional Commits type prefixes.
  if (new RegExp(`^(${CC_TYPES})(\\([^)]*\\))?!?: `).test(subject)) {
    error(
      `Conventional Commits type prefix in "${subject}" -- write '<scope>: <description>' and let the description carry the type`,
    );
  }

  // The portable Scoped Commits subject shape: <scope>: <description>
  if (!/^[^:]+: .+/.test(subject)) {
    error(
      `subject must be '<scope>: <description>' (missing ': ' or an empty scope/description): "${subject}"`,
    );
  }

  // Scope quality checks.
  if (scope !== "" && /(^\s)|(\s$)/.test(scope)) {
    warn(`scope "${scope}" has leading or trailing whitespace`);
  }

  if (/^([A-Z][A-Z0-9]*-[0-9]+|#[0-9]+)$/.test(scope)) {
    error(
      `ticket-like scope "${scope}" -- keep the scope and put the ticket in parentheses or a trailer: '<scope> (${scope}): <description>'`,
    );
  }

  // Body and trailers must be separated from the subject by a blank line.
  if (second !== "") {
    error("body or trailers must be separated from the subject by a blank line");
  }

  // Subject length.
  const subjectLength = [...subject].length;
  if (subjectLength > 72) {
    warn(`subject is ${subjectLength} characters (longer than 72); move detail into the body`);
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    special: false,
    subject,
    issues,
  };
}

// --- command line ----------------------------------------------------------

function main() {
  const self = fileURLToPath(import.meta.url);
  const progName = basename(self);
  const skillDir = resolve(dirname(self), "..");

  const usage = `${progName} -- validate a Git commit message against the Scoped Commits convention.

Usage:
  ${progName} [options] [FILE]

FILE is a commit message file (as passed to Git's commit-msg hook).
When FILE is omitted or is "-", the message is read from standard input.

Options:
  -q, --quiet   suppress the success message
  -h, --help    show this help

Exit status:
  0  no errors (warnings may still have been printed)
  1  the message violates the Scoped Commits format
  2  usage error

Call this script from a commit-msg hook (Git passes the message file path
as the hook argument):

  "${skillDir}/scripts/check-commit-message.mjs" "$1"

The checker enforces only portable Scoped Commits rules. Project-specific
rules (valid scope vocabulary, description casing) belong in project tooling.
`;

  let quiet = false;
  let file = 0;

  // Exit through one helper so every terminating path writes to the right
  // stream and exits with the right status.
  //   prefix: emit "PROGNAME: " before the message (default true)
  //   quiet:  allow --quiet to suppress the message (default true)
  const die = (exitStatus, message = "", { prefix = true, quiet: allowQuiet = true } = {}) => {
    if (exitStatus === 0 && allowQuiet && quiet) {
      message = "";
    }
    if (message !== "") {
      if (prefix) {
        message = progName + ": " + message;
      }
      if (!message.endsWith("\n")) {
        message += "\n";
      }
      const stream = exitStatus === 0 ? process.stdout : process.stderr;
      stream.write(message);
    }
    process.exit(exitStatus);
  };

  // Positional "-" and empty arguments mean standard input (fd 0).
  const fileSource = (arg) => (arg === "" || arg === "-" ? 0 : arg);

  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === "-q" || arg === "--quiet") {
      quiet = true;
    } else if (arg === "-h" || arg === "--help") {
      die(0, usage, { prefix: false, quiet: false });
    } else if (arg === "--") {
      if (i + 1 < process.argv.length) {
        file = fileSource(process.argv[i + 1]);
      }
      break;
    } else if (arg.startsWith("-") && arg !== "-") {
      die(2, `unknown option: ${arg}\n${usage}`);
    } else {
      file = fileSource(arg);
    }
  }

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const message = file === 0
      ? `error: cannot read standard input: ${error.message}`
      : `error: no such file: ${file}`;
    die(2, message);
  }

  const result = checkCommitMessage(raw);

  for (const issue of result.issues) {
    process.stderr.write(`${progName}: ${issue.severity}: ${issue.message}\n`);
  }

  if (!result.ok) {
    die(1, "commit message does not follow Scoped Commits");
  }
  if (result.special) {
    die(0, `ok (special commit, skipped): ${result.subject}`);
  }
  die(0, `ok: ${result.subject}`);
}

if (import.meta.main) {
  main();
}
