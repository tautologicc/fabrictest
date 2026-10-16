#!/usr/bin/env node
// check-commit-message.mjs -- validate a Git commit message against the
// Scoped Commits convention.
//
// As a library:
//   import checkCommitMessage from "./check-commit-message.mjs";
//   const { ok, issues } = await checkCommitMessage(input);
//
// `input` may be a message string, a `file:` URL, a file descriptor, or a
// `File`/`Blob`.
//
// As a commit-msg hook:
//   node check-commit-message.mjs "$1"

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * Read the message text from any accepted input.
 *
 * @param {string | URL | number | { text(): Promise<string> }} input
 * @returns {Promise<string>}
 */
async function readMessage(input) {
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "number") {
    return text(createReadStream(null, { fd: input, autoClose: false }));
  }
  if (input instanceof URL) {
    return readFile(input, "utf8");
  }
  if (input !== null && typeof input.text === "function") {
    return input.text();
  }
  throw new TypeError(
    "checkCommitMessage expects a message string, a file URL, a file descriptor, or a File",
  );
}

/** A Git template comment line starts with "# " or is a bare "#". */
const isComment = (line) => /^#[ \t]/.test(line) || /^#$/.test(line);

/** Yield lines split on LF, CRLF, or lone CR without copying the message. */
function* lines(message) {
  const terminator = /\r\n?|\n/g;
  let start = 0;
  for (let match; (match = terminator.exec(message)) !== null; start = terminator.lastIndex) {
    yield message.slice(start, match.index);
  }
  yield message.slice(start);
}

/**
 * Find the subject and the next non-comment line, stopping as soon as both
 * are known. Leading blank lines and comment lines are ignored; body and
 * trailer content is never read.
 */
function findSubjectAndSecond(message) {
  let subject = null;
  let second = "";

  for (const line of lines(message)) {
    if (subject === null) {
      if (!/^\s*$/.test(line) && !isComment(line)) {
        subject = line;
      }
    } else if (!isComment(line)) {
      second = line;
      break;
    }
  }

  return { subject: subject ?? "", second };
}

/**
 * Validate a commit message against the Scoped Commits convention.
 *
 * The input is read first: a string is the message itself, a `file:` URL or
 * file descriptor is read from disk, and a `File`/`Blob` is read as text.
 * Only the subject and the next non-comment line are parsed: LF, CRLF, and
 * lone CR are treated as line breaks, Git comment lines are skipped, and
 * leading blank lines are ignored. A subject such as "#42: ..." is kept so
 * it can be flagged as a ticket-like scope.
 *
 * @param {string | URL | number | { text(): Promise<string> }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   special: boolean,
 *   subject: string,
 *   issues: Array<{ severity: "error" | "warning", message: string }>,
 * }>} `ok` is true when there are no error-severity issues; `special` marks
 *   merge/revert/fixup/squash/amend commits, which are accepted as-is;
 *   `issues` preserves discovery order for display.
 */
export default async function checkCommitMessage(input) {
  const message = await readMessage(input);

  const issues = [];
  const error = (text) => issues.push({ severity: "error", message: text });
  const warn = (text) => issues.push({ severity: "warning", message: text });

  const { subject, second } = findSubjectAndSecond(message);
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

async function main() {
  const self = fileURLToPath(import.meta.url);
  const progName = basename(self);
  const skillDir = resolve(dirname(self), "..");

  const usage = `${progName} -- validate a Git commit message against the Scoped Commits convention.

Usage:
  ${progName} [options] [FILE]

FILE is a commit message file (as passed to Git's commit-msg hook).
When FILE is omitted or is "-", the message is read from standard input.

Options:
  -v, --verbose  print the success message
  -h, --help     show this help

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

  let verbose = false;
  let file = 0;

  // Exit through one helper so every terminating path writes to the right
  // stream and exits with the right status.
  //   prefix:  emit "PROGNAME: " before the message (default true)
  //   verbose: show the success message (default: the --verbose flag)
  const die = (exitStatus, message = "", { prefix = true, verbose: allowVerbose = verbose } = {}) => {
    if (exitStatus === 0 && !allowVerbose) {
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
    if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg === "-h" || arg === "--help") {
      die(0, usage, { prefix: false, verbose: true });
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

  const source = file === 0 ? 0 : pathToFileURL(file);

  let result;
  try {
    result = await checkCommitMessage(source);
  } catch (error) {
    const message = file === 0
      ? `error: cannot read standard input: ${error.message}`
      : `error: no such file: ${file}`;
    die(2, message);
  }

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
  await main();
}
