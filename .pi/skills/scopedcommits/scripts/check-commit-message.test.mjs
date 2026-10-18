// Tests for check-commit-message.mjs, using Node's built-in test runner.
// Run from the skill directory: node --test scripts/
//
// Two suites cover the two interfaces:
//   - library: in-process calls to the default export, checkCommitMessage()
//   - CLI: spawned-process tests for argv, stdin/file input, output, exit codes

import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";

import checkCommitMessage, { parseScopes } from "./check-commit-message.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-commit-message.mjs");

// Run the CLI in a directory without a CONTRIBUTING.md by default so the
// host repository's scope allowlist does not affect the portable tests.
let portableCwd;
before(async () => {
  portableCwd = await mkdtemp(join(tmpdir(), "scopedcommits-cwd-"));
  await mkdir(join(portableCwd, ".git"));
});
after(async () => {
  await rm(portableCwd, { recursive: true, force: true });
});

/** Run the CLI as a process and capture exactly what a git hook sees. */
const run = async (args, input = "", { cwd = portableCwd } = {}) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd });
  child.stdin.end(input);
  const [[status], stdout, stderr] = await Promise.all([
    once(child, "close"),
    text(child.stdout),
    text(child.stderr),
  ]);
  return { status, stdout, stderr };
};

const hasAncestorGit = async (start) => {
  let dir = start;
  while (true) {
    try {
      await access(join(dir, ".git"));
      return true;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
};

describe("library: checkCommitMessage()", () => {
  describe("accepted subjects", () => {
    const cases = [
      ["a simple scope", "auth: prevent token refresh from racing expiry"],
      ["a ticket after the scope", "auth (PROJ-123): fix login bug"],
      ["a hierarchical scope", "i2c: virtio: mark device ready"],
      ["a package path scope", "net/http/cookiejar: add godoc links"],
      ["comma-separated scopes", "api, worker: stop retrying failed jobs"],
      ["the treewide scope", "treewide: drop Python 2 support"],
      ["a scoped revert subject", "auth: revert token refresh race fix"],
    ];

    it("returns ok with no issues", async (t) => {
      for (const [name, subject] of cases) {
        await t.test(name, async (subtest) => {
          const result = await checkCommitMessage(subject);
          subtest.assert.equal(result.ok, true);
          subtest.assert.equal(result.special, false);
          subtest.assert.equal(result.subject, subject);
          subtest.assert.deepEqual(result.issues, []);
        });
      }
    });
  });

  describe("issue reporting", () => {
    it("reports a Conventional Commits prefix as an error", async (t) => {
      const result = await checkCommitMessage("fix(auth): prevent the token race");
      t.assert.equal(result.ok, false);
      t.assert.equal(result.special, false);
      t.assert.deepEqual(
        result.issues.map((issue) => issue.severity),
        ["error"],
      );
      t.assert.match(result.issues[0].message, /Conventional Commits type prefix/);
    });

    it("reports whitespace around the scope as a non-fatal warning", async (t) => {
      const result = await checkCommitMessage("auth : fix login");
      t.assert.equal(result.ok, true);
      t.assert.deepEqual(
        result.issues.map((issue) => issue.severity),
        ["warning"],
      );
      t.assert.match(result.issues[0].message, /leading or trailing whitespace/);
    });

    it("reports a long subject as a non-fatal warning", async (t) => {
      const result = await checkCommitMessage(`auth: ${"x".repeat(80)}`);
      t.assert.equal(result.ok, true);
      t.assert.match(result.issues[0].message, /longer than 72/);
    });

    it("keeps issues in discovery order", async (t) => {
      const result = await checkCommitMessage("auth : fix login\nno blank line");
      t.assert.equal(result.ok, false);
      t.assert.deepEqual(
        result.issues.map((issue) => issue.severity),
        ["warning", "error"],
      );
    });
  });

  describe("Conventional Commits", () => {
    const types = [
      "build",
      "chore",
      "ci",
      "docs",
      "feat",
      "fix",
      "perf",
      "refactor",
      "revert",
      "style",
      "test",
    ];

    it("rejects every type prefix", async (t) => {
      for (const type of types) {
        await t.test(type, async (subtest) => {
          const result = await checkCommitMessage(`${type}: do the thing`);
          subtest.assert.equal(result.ok, false);
          subtest.assert.match(result.issues[0].message, /Conventional Commits type prefix/);
        });
      }
    });

    it("rejects a scoped type", async (t) => {
      const result = await checkCommitMessage("fix(auth): prevent the token race");
      t.assert.equal(result.ok, false);
    });

    it("rejects a breaking-change marker", async (t) => {
      const result = await checkCommitMessage("feat(core)!: drop the legacy API");
      t.assert.equal(result.ok, false);
    });

    it("rejects lowercase revert: as a type prefix", async (t) => {
      // Stock git reverts use `Revert "..."` and remain exempt (see
      // "special commits"); `revert:` is a Conventional Commits type prefix.
      const result = await checkCommitMessage("revert: undo the thing");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /Conventional Commits type prefix/);
    });
  });

  describe("scope quality", () => {
    it("rejects ticket-like scopes", async (t) => {
      for (const scope of ["PROJ-123", "#42"]) {
        await t.test(scope, async (subtest) => {
          const result = await checkCommitMessage(`${scope}: fix login bug`);
          subtest.assert.equal(result.ok, false);
          subtest.assert.match(result.issues[0].message, /ticket-like scope/);
        });
      }
    });
  });

  describe("subject structure", () => {
    it("rejects a missing separator", async (t) => {
      const result = await checkCommitMessage("auth fix login");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /missing ': ' or an empty scope\/description/);
    });

    it("rejects an empty scope", async (t) => {
      const result = await checkCommitMessage(": fix login");
      t.assert.equal(result.ok, false);
    });

    it("rejects an empty message", async (t) => {
      const result = await checkCommitMessage("");
      t.assert.equal(result.ok, false);
      t.assert.equal(result.subject, "");
      t.assert.deepEqual(result.issues, [
        { severity: "error", message: "empty commit message" },
      ]);
    });

    it("reports a comments-only message as empty", async (t) => {
      const result = await checkCommitMessage("# just a comment\n");
      t.assert.equal(result.ok, false);
      t.assert.equal(result.subject, "");
      t.assert.deepEqual(result.issues, [
        { severity: "error", message: "empty commit message" },
      ]);
    });
  });

  describe("normalization", () => {
    it("accepts a blank line before the body", async (t) => {
      const result = await checkCommitMessage("auth: fix login\n\nWhy it was broken.\n");
      t.assert.equal(result.ok, true);
    });

    it("accepts a trailer paragraph", async (t) => {
      const result = await checkCommitMessage("auth: fix login\n\nJira-Ticket: PROJ-123\n");
      t.assert.equal(result.ok, true);
    });

    it("rejects a body on line two", async (t) => {
      const result = await checkCommitMessage("auth: fix login\nWhy it was broken.");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /blank line/);
    });

    it("accepts CRLF input", async (t) => {
      const result = await checkCommitMessage("auth: fix login\r\n\r\nBody.\r\n");
      t.assert.equal(result.ok, true);
    });

    it("accepts lone CR line endings", async (t) => {
      const result = await checkCommitMessage("auth: fix login\r\rBody.\r");
      t.assert.equal(result.ok, true);
      t.assert.equal(result.subject, "auth: fix login");
    });

    it("skips comments between the subject and the body", async (t) => {
      const result = await checkCommitMessage("auth: fix login\n# a comment\nBody.");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /blank line/);
    });

    it("ignores git template comments", async (t) => {
      const result = await checkCommitMessage(
        "# Please enter the commit message\n#\nauth: fix login\n# On branch main\n",
      );
      t.assert.equal(result.ok, true);
      t.assert.equal(result.subject, "auth: fix login");
    });
  });

  describe("input types", () => {
    let dir;

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "scopedcommits-input-"));
    });

    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads a file: URL", async (t) => {
      const path = join(dir, "URL_MSG");
      await writeFile(path, "auth: from a URL\n");
      const result = await checkCommitMessage(pathToFileURL(path));
      t.assert.equal(result.ok, true);
      t.assert.equal(result.subject, "auth: from a URL");
    });

    it("reads a File object", async (t) => {
      const file = new File(["auth: from a File\n"], "COMMIT_EDITMSG");
      const result = await checkCommitMessage(file);
      t.assert.equal(result.ok, true);
      t.assert.equal(result.subject, "auth: from a File");
    });

    it("reads a file descriptor", async (t) => {
      const path = join(dir, "FD_MSG");
      await writeFile(path, "auth: from a descriptor\n");
      const handle = await open(path, "r");
      try {
        const result = await checkCommitMessage(handle.fd);
        t.assert.equal(result.ok, true);
      } finally {
        await handle.close();
      }
    });

    it("rejects unsupported input", async (t) => {
      await t.assert.rejects(() => checkCommitMessage(null), TypeError);
    });

    it("propagates read errors", async (t) => {
      await t.assert.rejects(
        () => checkCommitMessage(pathToFileURL(join(dir, "MISSING"))),
        /ENOENT/,
      );
    });
  });

  describe("special commits", () => {
    const specials = [
      "Merge branch 'main'",
      'Revert "auth: fix login"',
      "fixup! auth: fix login",
      "squash! auth: fix login",
      "amend! auth: fix login",
      "Auto-merged main",
    ];

    it("returns special commits without issues", async (t) => {
      for (const subject of specials) {
        await t.test(subject, async (subtest) => {
          const result = await checkCommitMessage(subject);
          subtest.assert.equal(result.ok, true);
          subtest.assert.equal(result.special, true);
          subtest.assert.equal(result.subject, subject);
          subtest.assert.deepEqual(result.issues, []);
        });
      }
    });
  });

  describe("release commits", () => {
    const versionChanges = [
      "release: 2.3.0 -> 2.4.0",
      "my/pkg: 1.4.2 -> 1.4.3",
      "treewide: 24.1.11 -> 24.1.12",
    ];

    it("accepts the preferred version-change form", async (t) => {
      for (const subject of versionChanges) {
        await t.test(subject, async (subtest) => {
          const result = await checkCommitMessage(subject);
          subtest.assert.equal(result.ok, true);
        });
      }
    });

    it("accepts the scheme's zero version for a first release", async (t) => {
      const result = await checkCommitMessage("release: 0.0.0 -> 1.0.0");
      t.assert.equal(result.ok, true);
    });

    it("accepts a plain version, since the arrow is preferred but not enforced", async (t) => {
      const result = await checkCommitMessage("release: 2.4.0");
      t.assert.equal(result.ok, true);
    });

    it("rejects a Conventional Commits release subject", async (t) => {
      const result = await checkCommitMessage("chore: release 2.4.0");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /Conventional Commits type prefix/);
    });

    it("rejects event-style subjects unless a project hook allows them", async (t) => {
      for (const subject of ["Release 2.4.0", "v2.4.0"]) {
        await t.test(subject, async (subtest) => {
          const result = await checkCommitMessage(subject);
          subtest.assert.equal(result.ok, false);
          subtest.assert.match(result.issues[0].message, /<scope>: <description>/);
        });
      }
    });
  });
});

describe("scope allowlist", () => {
  it("accepts an exact scope", async (t) => {
    const result = await checkCommitMessage("git: fix the thing", { scopes: ["git"] });
    t.assert.equal(result.ok, true);
    t.assert.deepEqual(result.issues, []);
  });

  it("rejects an unknown scope", async (t) => {
    const result = await checkCommitMessage("auth: fix login", { scopes: ["git"] });
    t.assert.equal(result.ok, false);
    t.assert.match(result.issues[0].message, /unknown scope "auth"/);
  });

  it("matches exact scopes and trailing-slash prefixes", async (t) => {
    const exact = await checkCommitMessage("git: fix", { scopes: ["git"] });
    t.assert.equal(exact.ok, true);

    const noChild = await checkCommitMessage("git/checks: update", { scopes: ["git"] });
    t.assert.equal(noChild.ok, false);

    const prefix = await checkCommitMessage("git/checks: update", { scopes: ["git/"] });
    t.assert.equal(prefix.ok, true);

    const deep = await checkCommitMessage("git/checks/deep: update", { scopes: ["git/"] });
    t.assert.equal(deep.ok, true);

    const exactChild = await checkCommitMessage("git/checks: update", {
      scopes: ["git/checks"],
    });
    t.assert.equal(exactChild.ok, true);

    const childPrefix = await checkCommitMessage("git/checks: update", {
      scopes: ["git/checks/"],
    });
    t.assert.equal(childPrefix.ok, false);
  });

  it("normalizes colons to slashes", async (t) => {
    for (const subject of ["i2c: virtio: mark device ready", "i2c/virtio: mark device ready"]) {
      const prefixed = await checkCommitMessage(subject, { scopes: ["i2c/"] });
      t.assert.equal(prefixed.ok, true);

      const exact = await checkCommitMessage(subject, { scopes: ["i2c"] });
      t.assert.equal(exact.ok, false);
    }
  });

  it("lets a trailing slash cover colon children", async (t) => {
    for (const subject of ["git/checks: update", "git: checks: update"]) {
      const prefixed = await checkCommitMessage(subject, { scopes: ["git/"] });
      t.assert.equal(prefixed.ok, true);

      const exact = await checkCommitMessage(subject, { scopes: ["git"] });
      t.assert.equal(exact.ok, false);
    }
  });

  it("does not let a bare scope cover children", async (t) => {
    for (const subject of ["git: checks: update", "git/checks: update"]) {
      const direct = await checkCommitMessage(subject, { scopes: ["git"] });
      t.assert.equal(direct.ok, false);

      const child = await checkCommitMessage(subject, { scopes: ["git/"] });
      t.assert.equal(child.ok, true);
    }
  });

  it("matches every skill through the skills/ prefix", async (t) => {
    for (const subject of [
      "skills/scopedcommits: x",
      "skills: scopedcommits: x",
      "skills/a/b: x",
      "skills: a: b: x",
    ]) {
      const result = await checkCommitMessage(subject, { scopes: ["skills/"] });
      t.assert.equal(result.ok, true);
    }

    const missingChild = await checkCommitMessage("skills: x", { scopes: ["skills/"] });
    t.assert.equal(missingChild.ok, false);

    const exact = await checkCommitMessage("skills: x", { scopes: ["skills"] });
    t.assert.equal(exact.ok, true);
  });

  it("validates each comma-separated scope", async (t) => {
    const both = await checkCommitMessage("api, worker: stop retries", {
      scopes: ["api", "worker"],
    });
    t.assert.equal(both.ok, true);

    const result = await checkCommitMessage("api, worker: stop retries", { scopes: ["api"] });
    t.assert.equal(result.ok, false);
    t.assert.match(result.issues[0].message, /unknown scope "worker"/);
  });

  it("ignores the ticket parenthetical", async (t) => {
    const result = await checkCommitMessage("auth (PROJ-123): fix login", { scopes: ["auth"] });
    t.assert.equal(result.ok, true);
    t.assert.deepEqual(result.issues, []);
  });

  it("trims before stripping the ticket parenthetical", async (t) => {
    for (const subject of ["api (PROJ-1) , worker: fix", "api (PROJ-1) : fix"]) {
      const result = await checkCommitMessage(subject, { scopes: ["api", "worker"] });
      t.assert.equal(result.ok, true);
    }
  });

  it("keeps commas inside a ticket parenthetical", async (t) => {
    const result = await checkCommitMessage("api (PROJ-1, PROJ-2): fix", { scopes: ["api"] });
    t.assert.equal(result.ok, true);
    t.assert.deepEqual(result.issues, []);
  });

  it("treats a description colon as scope hierarchy", async (t) => {
    const bare = await checkCommitMessage("auth: fix: handle timeout", { scopes: ["auth"] });
    t.assert.equal(bare.ok, false);
    t.assert.match(bare.issues[0].message, /unknown scope "auth: fix"/);

    const prefix = await checkCommitMessage("auth: fix: handle timeout", { scopes: ["auth/"] });
    t.assert.equal(prefix.ok, true);
  });

  it("reports an ambiguous description comma", async (t) => {
    const result = await checkCommitMessage("git: fix parsing, quoting: drop legacy", {
      scopes: ["git"],
    });
    t.assert.equal(result.ok, false);
    t.assert.equal(result.issues.length, 1);
    t.assert.match(result.issues[0].message, /ambiguous scope/);
  });

  it("ignores a colon inside a parenthetical", async (t) => {
    const result = await checkCommitMessage("api (see: notes), worker: fix", {
      scopes: ["api", "worker"],
    });
    t.assert.equal(result.ok, true);
    t.assert.deepEqual(result.issues, []);
  });

  it("rejects empty scope parts", async (t) => {
    for (const subject of [",: fix", " : fix", "api,,worker: fix", "api, worker,: fix"]) {
      const result = await checkCommitMessage(subject, { scopes: ["api", "worker"] });
      t.assert.equal(result.ok, false);
      t.assert.ok(result.issues.some((issue) => /empty scope in scope list/.test(issue.message)));
    }
  });

  it("flags comma-separated ticket-like scopes without an allowlist", async (t) => {
    for (const subject of [
      "api, PROJ-123: fix",
      "PROJ-123, api: fix",
      "api, #42: fix",
      "PROJ-123: fix: detail",
      "#42: fix: detail",
    ]) {
      const result = await checkCommitMessage(subject);
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /ticket-like scope/);
    }
  });

  it("flags ticket segments inside a hierarchy", async (t) => {
    for (const subject of [
      "api/PROJ-123: fix",
      "api: PROJ-123: fix",
      "skills/PROJ-1: x",
    ]) {
      const result = await checkCommitMessage(subject, {
        scopes: ["api/", "skills/"],
      });
      t.assert.equal(result.ok, false);
      t.assert.equal(result.issues.length, 1);
      t.assert.match(result.issues[0].message, /ticket-like scope/);
    }
  });

  it("is case-sensitive", async (t) => {
    const result = await checkCommitMessage("Git: fix", { scopes: ["git"] });
    t.assert.equal(result.ok, false);
  });

  it("skips special commits", async (t) => {
    const result = await checkCommitMessage('Merge branch "main"', { scopes: ["git"] });
    t.assert.equal(result.ok, true);
    t.assert.equal(result.special, true);
    t.assert.deepEqual(result.issues, []);
  });

  it("does not duplicate Conventional Commits or ticket errors", async (t) => {
    const cc = await checkCommitMessage("fix(auth): nope", { scopes: ["git"] });
    t.assert.equal(cc.ok, false);
    t.assert.equal(cc.issues.length, 1);
    t.assert.match(cc.issues[0].message, /Conventional Commits type prefix/);

    const ticket = await checkCommitMessage("PROJ-123: fix", { scopes: ["git"] });
    t.assert.equal(ticket.ok, false);
    t.assert.equal(ticket.issues.length, 1);
    t.assert.match(ticket.issues[0].message, /ticket-like scope/);
  });

  it("rejects empty or glob patterns", async (t) => {
    await t.assert.rejects(() => checkCommitMessage("git: fix", { scopes: [] }), TypeError);
    await t.assert.rejects(() => checkCommitMessage("git: fix", { scopes: [""] }), TypeError);
    await t.assert.rejects(
      () => checkCommitMessage("git: fix", { scopes: ["skills/*"] }),
      TypeError,
    );
  });

  it("rejects a non-array scopes option", async (t) => {
    await t.assert.rejects(() => checkCommitMessage("git: x", { scopes: "git" }), TypeError);
  });

  it("accepts a null options object", async (t) => {
    const result = await checkCommitMessage("git: x", null);
    t.assert.equal(result.ok, true);
  });
});

describe("parseScopes()", () => {
  const frontmatter = (value) => `---\n${value}\n---\n\n# Contributing\n`;

  it("extracts the scopes array", (t) => {
    t.assert.deepEqual(parseScopes(frontmatter('{"scopes":["treewide","git","skills/"]}')), [
      "treewide",
      "git",
      "skills/",
    ]);
  });

  it("accepts other frontmatter keys", (t) => {
    const markdown = frontmatter('{"title":"Contributing","scopes":["git"]}');
    t.assert.deepEqual(parseScopes(markdown), ["git"]);
  });

  it("handles CRLF and a BOM", (t) => {
    const markdown = `\uFEFF---\r\n{"scopes":["git"]}\r\n---\r\n`;
    t.assert.deepEqual(parseScopes(markdown), ["git"]);
  });

  it("accepts trailing whitespace on the closing delimiter", (t) => {
    t.assert.deepEqual(parseScopes('---\n{"scopes":["git"]}\n--- \n'), ["git"]);
  });

  it("accepts a blank line before the frontmatter", (t) => {
    t.assert.deepEqual(parseScopes('\n---\n{"scopes":["git"]}\n---\n'), ["git"]);
  });

  it("returns null for an empty frontmatter body", (t) => {
    t.assert.equal(parseScopes("---\n---\n"), null);
  });

  it("ignores YAML frontmatter", (t) => {
    t.assert.equal(parseScopes("---\ntitle: Contributing\n---\n"), null);
  });

  it("ignores a leading thematic break", (t) => {
    t.assert.equal(parseScopes("---\n\n# Contributing\n"), null);
  });

  it("rejects non-object frontmatter", (t) => {
    t.assert.throws(() => parseScopes(frontmatter('["git"]')), /JSON object/);
  });

  it("rejects unterminated frontmatter", (t) => {
    t.assert.throws(() => parseScopes('---\n{"scopes":["git"]}\n'), /unterminated/);
  });

  it("rejects glob metacharacters", (t) => {
    t.assert.throws(
      () => parseScopes(frontmatter('{"scopes":["skills/*"]}')),
      /glob metacharacters/,
    );
  });

  it("returns null without frontmatter", (t) => {
    t.assert.equal(parseScopes("# Contributing\n"), null);
  });

  it("returns null when the frontmatter has no scopes", (t) => {
    t.assert.equal(parseScopes(frontmatter('{"title":"Contributing"}')), null);
  });

  it("rejects invalid JSON", (t) => {
    t.assert.throws(() => parseScopes(frontmatter('{"scopes":["git"]')), /invalid JSON/);
  });

  it("rejects a non-array scopes value", (t) => {
    t.assert.throws(() => parseScopes(frontmatter('{"scopes":"git"}')), /array of strings/);
  });

  it("rejects non-string scopes", (t) => {
    t.assert.throws(
      () => parseScopes(frontmatter('{"scopes":["git",42]}')),
      /array of strings/,
    );
  });

  it("rejects an empty scopes array", (t) => {
    t.assert.throws(() => parseScopes(frontmatter('{"scopes":[]}')), /empty/);
  });

  it("rejects an empty pattern", (t) => {
    t.assert.throws(() => parseScopes(frontmatter('{"scopes":[""]}')), /empty patterns/);
  });
});

describe("CLI: check-commit-message.mjs", () => {
  describe("default output", () => {
    it("prints the outcome on success", async (t) => {
      const result = await run(["-"], "auth: fix login");
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /^ok: auth: fix login$/m);
      t.assert.equal(result.stderr, "");
    });

    it("prints the outcome for special commits", async (t) => {
      const result = await run(["-"], 'Revert "auth: fix login"');
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /ok \(special commit, skipped\): Revert/);
      t.assert.equal(result.stderr, "");
    });

    it("prints warnings and the outcome", async (t) => {
      const result = await run(["-"], "auth : fix login");
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /ok: auth : fix login/);
      t.assert.match(result.stderr, /warning: scope "auth" has leading or trailing whitespace/);
    });

    it("prints errors and the failure outcome to stderr", async (t) => {
      const result = await run(["-"], "fix(auth): nope");
      t.assert.equal(result.status, 1);
      t.assert.equal(result.stdout, "");
      t.assert.match(result.stderr, /error: Conventional Commits type prefix/);
      t.assert.match(result.stderr, /commit message does not follow Scoped Commits/);
    });
  });

  describe("arguments", () => {
    it("rejects -h", async (t) => {
      const result = await run(["-h"]);
      t.assert.equal(result.status, 2);
      t.assert.match(result.stderr, /Unknown option '-h'/);
      t.assert.equal(result.stdout, "");
    });

    it("fails on an unknown option", async (t) => {
      const result = await run(["--bogus"]);
      t.assert.equal(result.status, 2);
      t.assert.match(result.stderr, /Unknown option '--bogus'/);
    });

    it("fails on a missing file", async (t) => {
      const result = await run([join(tmpdir(), `scopedcommits-missing-${process.pid}`)]);
      t.assert.equal(result.status, 1);
      t.assert.match(result.stderr, /no such file/);
    });

    it("fails when the argument is a directory", async (t) => {
      const result = await run([tmpdir()]);
      t.assert.equal(result.status, 1);
      t.assert.match(result.stderr, /no such file/);
    });

    it("is executable so hooks can call it directly", async (t) => {
      await t.assert.doesNotReject(() => access(SCRIPT, constants.X_OK));
    });
  });

  describe("input sources", () => {
    let dir;

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "scopedcommits-cli-"));
    });

    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads the message from stdin when FILE is omitted", async (t) => {
      const result = await run([], "auth: from stdin");
      t.assert.equal(result.status, 0);
    });

    it("reads the message from stdin for '-'", async (t) => {
      const result = await run(["-"], "auth: from stdin");
      t.assert.equal(result.status, 0);
    });

    it("reads a message file passed as FILE", async (t) => {
      const file = join(dir, "COMMIT_EDITMSG");
      await writeFile(file, "auth: from a file\n");
      const result = await run([file]);
      t.assert.equal(result.status, 0);
    });

    it("reads a message file after --", async (t) => {
      const file = join(dir, "AFTER_DASH_DASH");
      await writeFile(file, "auth: after --\n");
      const result = await run(["--", file]);
      t.assert.equal(result.status, 0);
    });

    it("treats stdin and file input identically", async (t) => {
      const message = "auth: same either way\n\nWith a body.\n";
      const file = join(dir, "SAME");
      await writeFile(file, message);
      const fromStdin = await run(["-"], message);
      const fromFile = await run([file]);
      t.assert.deepEqual(
        { status: fromFile.status, stdout: fromFile.stdout, stderr: fromFile.stderr },
        { status: fromStdin.status, stdout: fromStdin.stdout, stderr: fromStdin.stderr },
      );
    });
  });
});

describe("CLI: scope allowlist discovery", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "scopedcommits-discovery-"));
    await mkdir(join(dir, ".git"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("skips when there is no CONTRIBUTING.md", async (t) => {
    const result = await run(["-"], "auth: fix", { cwd: dir });
    t.assert.equal(result.status, 0);
  });

  it("skips when CONTRIBUTING.md has no scopes frontmatter", async (t) => {
    const repo = join(dir, "no-block");
    await mkdir(repo);
    await mkdir(join(repo, ".git"));
    await writeFile(join(repo, "CONTRIBUTING.md"), "# Contributing\n");
    const result = await run(["-"], "auth: fix", { cwd: repo });
    t.assert.equal(result.status, 0);
  });

  it("ignores CONTRIBUTING.md outside a repository", async (t) => {
    const outside = await mkdtemp(join(tmpdir(), "scopedcommits-outside-"));
    try {
      if (await hasAncestorGit(outside)) {
        t.skip("TMPDIR is inside a Git repository");
        return;
      }
      await writeFile(join(outside, "CONTRIBUTING.md"), '---\n{"scopes":["git"]}\n---\n');
      const result = await run(["-"], "auth: fix", { cwd: outside });
      t.assert.equal(result.status, 0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not inherit a parent repository's frontmatter", async (t) => {
    const parent = join(dir, "parent");
    const child = join(parent, "child");
    await mkdir(join(parent, ".git"), { recursive: true });
    await mkdir(join(child, ".git"), { recursive: true });
    await writeFile(join(parent, "CONTRIBUTING.md"), '---\n{"scopes":["git"]}\n---\n');
    const result = await run(["-"], "auth: fix", { cwd: child });
    t.assert.equal(result.status, 0);
  });

  it("treats a .git file as a repository root", async (t) => {
    const repo = join(dir, "worktree");
    await mkdir(repo);
    await writeFile(join(repo, ".git"), "gitdir: /tmp/elsewhere\n");
    await writeFile(join(repo, "CONTRIBUTING.md"), '---\n{"scopes":["git"]}\n---\n');
    const result = await run(["-"], "auth: fix", { cwd: repo });
    t.assert.equal(result.status, 1);
    t.assert.match(result.stderr, /unknown scope "auth"/);
  });

  it("enforces frontmatter scopes", async (t) => {
    const repo = join(dir, "with-block");
    await mkdir(repo);
    await mkdir(join(repo, ".git"));
    await writeFile(join(repo, "CONTRIBUTING.md"), '---\n{"scopes":["git"]}\n---\n');

    const ok = await run(["-"], "git: fix", { cwd: repo });
    t.assert.equal(ok.status, 0);

    const bad = await run(["-"], "auth: fix", { cwd: repo });
    t.assert.equal(bad.status, 1);
    t.assert.match(bad.stderr, /unknown scope "auth"/);
  });

  it("finds the frontmatter at the repository root from a subdirectory", async (t) => {
    const repo = join(dir, "repo");
    const sub = join(repo, "sub");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(sub, { recursive: true });
    await writeFile(join(repo, "CONTRIBUTING.md"), '---\n{"scopes":["git"]}\n---\n');
    const result = await run(["-"], "bogus: fix", { cwd: sub });
    t.assert.equal(result.status, 1);
    t.assert.match(result.stderr, /unknown scope "bogus"/);
  });

  it("reports malformed frontmatter as a usage error", async (t) => {
    const repo = join(dir, "malformed");
    await mkdir(repo);
    await mkdir(join(repo, ".git"));
    await writeFile(join(repo, "CONTRIBUTING.md"), '---\n{"scopes":["auth"]\n---\n');
    const result = await run(["-"], "auth: fix", { cwd: repo });
    t.assert.equal(result.status, 1);
    t.assert.match(result.stderr, /invalid JSON frontmatter/);
  });
});
