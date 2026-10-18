#!/usr/bin/env node
// check-commit-message.mjs -- validate a Git commit message against the
// Scoped Commits convention.
//
// Usage:
//   check-commit-message.mjs [--] [FILE]
//
// FILE is a commit message file; omit it or use "-" for stdin.
// Exit: 0 valid, 1 failure, 2 usage error.
//
// Examples:
//   check-commit-message.mjs .git/COMMIT_EDITMSG
//   printf '%s' 'auth: fix login' | check-commit-message.mjs -
//   check-commit-message.mjs "$1" >/dev/null   # commit-msg hook
//
// If CONTRIBUTING.md at the repository root starts with JSON frontmatter
// containing a "scopes" array, the CLI reads it and enforces those
// patterns. Without one, only the portable Scoped Commits rules apply.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";


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

/**
 * Find the subject and the next non-comment line. Leading blank lines and
 * comment lines are ignored; body and trailer content is not otherwise
 * inspected. Commit messages are small, so splitting the whole message is
 * deliberate.
 */
function findSubjectAndSecond(message) {
  const isComment = (line) => /^#[ \t]/.test(line) || /^#$/.test(line);
  let subject = null;
  let second = "";

  for (const line of message.split(/\r\n?|\n/)) {
    if (subject === null) {
      if (line.trim() !== "" && !isComment(line)) {
        subject = line;
      }
    } else if (!isComment(line)) {
      second = line;
      break;
    }
  }

  return { subject: subject ?? "", second };
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    throw new TypeError("scopes must be an array of strings");
  }
  if (scopes.length === 0) throw new TypeError("scopes is empty");
  if (scopes.some((scope) => scope.trim() === "")) {
    throw new TypeError("scopes must not contain empty patterns");
  }
  if (scopes.some((scope) => /[*?[\]{}]/.test(scope))) {
    throw new TypeError("scopes must not contain glob metacharacters");
  }
  return scopes;
}

/**
 * Extract the scope allowlist from JSON frontmatter at the top of a
 * Markdown document. Returns null when there is no frontmatter or no
 * "scopes" key; throws when the frontmatter or scopes value is invalid.
 *
 * @param {string} markdown
 * @returns {string[] | null}
 */
export function parseScopes(markdown) {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1 || lines[first].trim() !== "---") return null;

  const bodyFirst = lines.slice(first + 1).find((line) => line.trim() !== "")?.trim() ?? "";
  const looksJson = bodyFirst.startsWith("{") || bodyFirst.startsWith("[");

  let close = -1;
  for (let i = first + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    if (looksJson) throw new Error("unterminated JSON frontmatter");
    return null;
  }
  if (!looksJson) return null;

  let data;
  try {
    data = JSON.parse(lines.slice(first + 1, close).join("\n"));
  } catch (error) {
    throw new Error(`invalid JSON frontmatter: ${error.message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("frontmatter must be a JSON object");
  }

  const scopes = data.scopes;
  if (scopes === undefined) return null;
  validateScopes(scopes);
  return [...new Set(scopes)];
}

const SCOPE_SEPARATOR = /\s*[:/]\s*/g;
const TICKET_SCOPE = /^([A-Z][A-Z0-9]*-[0-9]+|#[0-9]+)$/;

function normalizeScopePath(value) {
  return value.replace(SCOPE_SEPARATOR, "/").trim();
}

function matchesScope(scope, pattern) {
  return pattern.endsWith("/") ? scope.startsWith(pattern) : scope === pattern;
}

function scanScopeList(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let topLevelColonSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && char === ":" && text[i + 1] === " ") {
      topLevelColonSpace = true;
    } else if (depth === 0 && char === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return { parts, topLevelColonSpace };
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  while (true) {
    if (await statOrNull(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadProjectScopes() {
  const root = await findRepoRoot();
  if (root === null) return undefined;
  const contributing = join(root, "CONTRIBUTING.md");
  const info = await statOrNull(contributing);
  if (info === null || !info.isFile()) return undefined;
  const markdown = await readFile(contributing, "utf8");
  try {
    return parseScopes(markdown) ?? undefined;
  } catch (error) {
    throw new Error(`${contributing}: ${error.message}`);
  }
}

/**
 * Validate a commit message against the Scoped Commits convention.
 *
 * ```js
 * import checkCommitMessage from "./check-commit-message.mjs";
 *
 * const { ok, issues } = await checkCommitMessage(input, {
 *   scopes: ["treewide", "git", "skills/"],
 * });
 * ```
 *
 * `input` may be a message string, a `file:` URL, a file descriptor, or a
 * `File`/`Blob`. `scopes` is optional; when present, commit scopes must
 * match one of its patterns.
 *
 * The input is read first: a string is the message itself, a `file:` URL or
 * file descriptor is read from disk, and a `File`/`Blob` is read as text.
 * Only the subject and the next non-comment line are parsed: LF, CRLF, and
 * lone CR are treated as line breaks, Git comment lines are skipped, and
 * leading blank lines are ignored. A subject such as "#42: ..." is kept so
 * it can be flagged as a ticket-like scope.
 *
 * @param {string | URL | number | { text(): Promise<string> }} input
 * @param {{ scopes?: string[] }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   special: boolean,
 *   subject: string,
 *   issues: Array<{ severity: "error" | "warning", message: string }>,
 * }>} `ok` is true when there are no error-severity issues; `special` marks
 *   merge/revert/fixup/squash/amend commits, which are accepted as-is;
 *   `issues` preserves discovery order for display.
 */
export default async function checkCommitMessage(input, options = {}) {
  const { scopes } = options ?? {};
  if (scopes !== undefined) validateScopes(scopes);
  const allowlist = scopes?.map(normalizeScopePath);
  const message = await readMessage(input);

  const issues = [];
  const error = (text) => issues.push({ severity: "error", message: text });
  const warn = (text) => issues.push({ severity: "warning", message: text });

  const { subject, second } = findSubjectAndSecond(message);

  if (subject === "") {
    error("empty commit message");
    return { ok: false, special: false, subject, issues };
  }

  if (SPECIAL_SUBJECTS.some((pattern) => pattern.test(subject))) {
    return { ok: true, special: true, subject, issues };
  }

  // Conventional Commits type prefixes.
  const ccPrefix = new RegExp(`^(${CC_TYPES})(\\([^)]*\\))?!?: `).test(subject);
  if (ccPrefix) {
    error(
      `Conventional Commits type prefix in "${subject}" -- write '<scope>: <description>' and let the description carry the type`,
    );
  }

  // The portable Scoped Commits subject shape: <scope>: <description>
  const shapeOk = /^[^:]+: .+/.test(subject);
  if (!shapeOk) {
    error(
      `subject must be '<scope>: <description>' (missing ': ' or an empty scope/description): "${subject}"`,
    );
  }

  // Scope quality checks.
  const rawScopeText = shapeOk ? subject.slice(0, subject.lastIndexOf(": ")) : "";
  const scopeText = rawScopeText.trim();
  if (scopeText !== "" && /(^\s)|(\s$)/.test(rawScopeText)) {
    warn(`scope "${scopeText}" has leading or trailing whitespace`);
  }

  const { parts: scopeList, topLevelColonSpace } = shapeOk
    ? scanScopeList(scopeText)
    : { parts: [], topLevelColonSpace: false };
  const ambiguousScope = topLevelColonSpace && scopeList.length > 1;
  if (ambiguousScope) {
    error(
      `ambiguous scope "${scopeText}" -- a ": " inside the description makes the comma-separated scope boundary ambiguous; rephrase so the scope has no description colon`,
    );
  } else {
    const scopeParts = scopeList.map((part) =>
      part.trim().replace(/\s+\([^)]*\)$/, "").trim(),
    );
    const ticketParts = [
      ...new Set(
        scopeParts
          .flatMap((part) => part.split(/[:/]/).map((segment) => segment.trim()))
          .filter((segment) => TICKET_SCOPE.test(segment)),
      ),
    ];
    const ticketLike = ticketParts.length > 0;
    for (const segment of ticketParts) {
      error(
        `ticket-like scope "${segment}" -- keep the scope and put the ticket in parentheses or a trailer: '<scope> (${segment}): <description>'`,
      );
    }
    if (scopeParts.includes("")) {
      error("empty scope in scope list");
    }

    // The project's scope vocabulary, when the caller supplies one. A
    // pattern without a trailing "/" matches exactly; one ending in "/"
    // matches that prefix and its descendants. ':' and '/' are hierarchy
    // separators, and colons are normalized to slashes before matching.
    if (allowlist && shapeOk && !ccPrefix && !ticketLike) {
      for (const name of scopeParts) {
        if (name === "") continue;
        const normalized = normalizeScopePath(name);
        if (!allowlist.some((pattern) => matchesScope(normalized, pattern))) {
          error(`unknown scope "${name}" -- expected one of: ${scopes.join(", ")}`);
        }
      }
    }
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

async function main() {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
  });

  // Positional "-" and empty arguments mean standard input (fd 0).
  const fileSource = (arg) => (arg === "" || arg === "-" ? 0 : arg);

  const file = positionals.length > 0 ? fileSource(positionals.at(-1)) : 0;
  const source = file === 0 ? 0 : pathToFileURL(file);

  let scopes;
  try {
    scopes = await loadProjectScopes();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await checkCommitMessage(source, { scopes });
  } catch (error) {
    console.error(
      file === 0
        ? `cannot read standard input: ${error.message}`
        : `no such file: ${file}`,
    );
    process.exitCode = 1;
    return;
  }

  for (const issue of result.issues) {
    console.error(`${issue.severity}: ${issue.message}`);
  }

  if (!result.ok) {
    console.error("commit message does not follow Scoped Commits");
    process.exitCode = 1;
    return;
  }
  console.log(`ok${result.special ? " (special commit, skipped)" : ""}: ${result.subject}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error?.code?.startsWith("ERR_PARSE_ARGS_")) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
