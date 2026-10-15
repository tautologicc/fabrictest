// Tests for check-commit-message.mjs, using Node's built-in test runner.
// Run from the skill directory: node --test scripts/
//
// Two suites cover the two interfaces:
//   - library: in-process calls to the default export, checkCommitMessage()
//   - CLI: spawned-process tests for argv, stdin/file input, output, exit codes

import { after, before, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import checkCommitMessage from "./check-commit-message.mjs";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "check-commit-message.mjs");

/** Run the CLI as a process and capture exactly what a git hook sees. */
const run = (args, input = "") =>
  spawnSync(process.execPath, [CHECKER, ...args], { input, encoding: "utf8" });

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
        await t.test(name, (subtest) => {
          const result = checkCommitMessage(subject);
          subtest.assert.equal(result.ok, true);
          subtest.assert.equal(result.special, false);
          subtest.assert.equal(result.subject, subject);
          subtest.assert.deepEqual(result.issues, []);
        });
      }
    });
  });

  describe("issue reporting", () => {
    it("reports a Conventional Commits prefix as an error", (t) => {
      const result = checkCommitMessage("fix(auth): prevent the token race");
      t.assert.equal(result.ok, false);
      t.assert.equal(result.special, false);
      t.assert.deepEqual(
        result.issues.map((issue) => issue.severity),
        ["error"],
      );
      t.assert.match(result.issues[0].message, /Conventional Commits type prefix/);
    });

    it("reports whitespace around the scope as a non-fatal warning", (t) => {
      const result = checkCommitMessage("auth : fix login");
      t.assert.equal(result.ok, true);
      t.assert.deepEqual(
        result.issues.map((issue) => issue.severity),
        ["warning"],
      );
      t.assert.match(result.issues[0].message, /leading or trailing whitespace/);
    });

    it("reports a long subject as a non-fatal warning", (t) => {
      const result = checkCommitMessage(`auth: ${"x".repeat(80)}`);
      t.assert.equal(result.ok, true);
      t.assert.match(result.issues[0].message, /longer than 72/);
    });

    it("keeps issues in discovery order", (t) => {
      const result = checkCommitMessage("auth : fix login\nno blank line");
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
        await t.test(type, (subtest) => {
          const result = checkCommitMessage(`${type}: do the thing`);
          subtest.assert.equal(result.ok, false);
          subtest.assert.match(result.issues[0].message, /Conventional Commits type prefix/);
        });
      }
    });

    it("rejects a scoped type", (t) => {
      const result = checkCommitMessage("fix(auth): prevent the token race");
      t.assert.equal(result.ok, false);
    });

    it("rejects a breaking-change marker", (t) => {
      const result = checkCommitMessage("feat(core)!: drop the legacy API");
      t.assert.equal(result.ok, false);
    });

    it("rejects lowercase revert: as a type prefix", (t) => {
      // Stock git reverts use `Revert "..."` and remain exempt (see
      // "special commits"); `revert:` is a Conventional Commits type prefix.
      const result = checkCommitMessage("revert: undo the thing");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /Conventional Commits type prefix/);
    });
  });

  describe("scope quality", () => {
    it("rejects ticket-like scopes", async (t) => {
      for (const scope of ["PROJ-123", "#42"]) {
        await t.test(scope, (subtest) => {
          const result = checkCommitMessage(`${scope}: fix login bug`);
          subtest.assert.equal(result.ok, false);
          subtest.assert.match(result.issues[0].message, /ticket-like scope/);
        });
      }
    });
  });

  describe("subject structure", () => {
    it("rejects a missing separator", (t) => {
      const result = checkCommitMessage("auth fix login");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /missing ': ' or an empty scope\/description/);
    });

    it("rejects an empty scope", (t) => {
      const result = checkCommitMessage(": fix login");
      t.assert.equal(result.ok, false);
    });

    it("rejects an empty message", (t) => {
      const result = checkCommitMessage("");
      t.assert.equal(result.ok, false);
      t.assert.equal(result.subject, "");
      t.assert.deepEqual(result.issues, [
        { severity: "error", message: "empty commit message" },
      ]);
    });

    it("reports a comments-only message as empty", (t) => {
      const result = checkCommitMessage("# just a comment\n");
      t.assert.equal(result.ok, false);
      t.assert.equal(result.subject, "");
      t.assert.deepEqual(result.issues, [
        { severity: "error", message: "empty commit message" },
      ]);
    });
  });

  describe("normalization", () => {
    it("accepts a blank line before the body", (t) => {
      const result = checkCommitMessage("auth: fix login\n\nWhy it was broken.\n");
      t.assert.equal(result.ok, true);
    });

    it("accepts a trailer paragraph", (t) => {
      const result = checkCommitMessage("auth: fix login\n\nJira-Ticket: PROJ-123\n");
      t.assert.equal(result.ok, true);
    });

    it("rejects a body on line two", (t) => {
      const result = checkCommitMessage("auth: fix login\nWhy it was broken.");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /blank line/);
    });

    it("accepts CRLF input", (t) => {
      const result = checkCommitMessage("auth: fix login\r\n\r\nBody.\r\n");
      t.assert.equal(result.ok, true);
    });

    it("ignores git template comments", (t) => {
      const result = checkCommitMessage(
        "# Please enter the commit message\n#\nauth: fix login\n# On branch main\n",
      );
      t.assert.equal(result.ok, true);
      t.assert.equal(result.subject, "auth: fix login");
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
        await t.test(subject, (subtest) => {
          const result = checkCommitMessage(subject);
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
        await t.test(subject, (subtest) => {
          const result = checkCommitMessage(subject);
          subtest.assert.equal(result.ok, true);
        });
      }
    });

    it("accepts the scheme's zero version for a first release", (t) => {
      const result = checkCommitMessage("release: 0.0.0 -> 1.0.0");
      t.assert.equal(result.ok, true);
    });

    it("accepts a plain version, since the arrow is preferred but not enforced", (t) => {
      const result = checkCommitMessage("release: 2.4.0");
      t.assert.equal(result.ok, true);
    });

    it("rejects a Conventional Commits release subject", (t) => {
      const result = checkCommitMessage("chore: release 2.4.0");
      t.assert.equal(result.ok, false);
      t.assert.match(result.issues[0].message, /Conventional Commits type prefix/);
    });

    it("rejects event-style subjects unless a project hook allows them", async (t) => {
      for (const subject of ["Release 2.4.0", "v2.4.0"]) {
        await t.test(subject, (subtest) => {
          const result = checkCommitMessage(subject);
          subtest.assert.equal(result.ok, false);
          subtest.assert.match(result.issues[0].message, /<scope>: <description>/);
        });
      }
    });
  });
});

describe("CLI: check-commit-message.mjs", () => {
  describe("success output", () => {
    it("prints the subject and exits 0", (t) => {
      const result = run(["-"], "auth: fix the thing\n");
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /^check-commit-message\.mjs: ok: auth: fix the thing$/m);
      t.assert.equal(result.stderr, "");
    });

    it("announces a skipped special commit", (t) => {
      const result = run(["-"], 'Revert "auth: fix login"\n');
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /ok \(special commit, skipped\)/);
    });
  });

  describe("failure output", () => {
    it("prints errors and exits 1", (t) => {
      const result = run(["-"], "fix(auth): nope");
      t.assert.equal(result.status, 1);
      t.assert.equal(result.stdout, "");
      t.assert.match(result.stderr, /error: Conventional Commits type prefix/);
      t.assert.match(result.stderr, /commit message does not follow Scoped Commits/);
    });

    it("prints warnings without failing", (t) => {
      const result = run(["-"], "auth : fix login");
      t.assert.equal(result.status, 0);
      t.assert.match(result.stderr, /warning: scope "auth " has leading or trailing whitespace/);
      t.assert.match(result.stdout, /ok: auth : fix login/);
    });
  });

  describe("--quiet", () => {
    it("suppresses success output", (t) => {
      const result = run(["-q", "-"], "auth: fix login");
      t.assert.equal(result.status, 0);
      t.assert.equal(result.stdout, "");
      t.assert.equal(result.stderr, "");
    });

    it("suppresses special-commit output", (t) => {
      const result = run(["-q", "-"], 'Revert "auth: fix login"');
      t.assert.equal(result.status, 0);
      t.assert.equal(result.stdout, "");
    });

    it("does not suppress errors", (t) => {
      const result = run(["-q", "-"], "fix(auth): nope");
      t.assert.equal(result.status, 1);
      t.assert.equal(result.stdout, "");
      t.assert.match(result.stderr, /error: Conventional Commits type prefix/);
    });

    it("does not suppress warnings", (t) => {
      const result = run(["-q", "-"], "auth : fix login");
      t.assert.equal(result.status, 0);
      t.assert.match(result.stderr, /warning: scope/);
    });
  });

  describe("arguments", () => {
    it("prints usage with --help", (t) => {
      const result = run(["--help"]);
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /Usage:/);
      t.assert.match(result.stdout, /Scoped Commits convention/);
      t.assert.equal(result.stderr, "");
    });

    it("fails on an unknown option", (t) => {
      const result = run(["--bogus"]);
      t.assert.equal(result.status, 2);
      t.assert.match(result.stderr, /unknown option: --bogus/);
      t.assert.match(result.stderr, /Usage:/);
    });

    it("fails on a missing file", (t) => {
      const result = run([join(tmpdir(), `scopedcommits-missing-${process.pid}`)]);
      t.assert.equal(result.status, 2);
      t.assert.match(result.stderr, /no such file/);
    });

    it("fails when the argument is a directory", (t) => {
      const result = run([tmpdir()]);
      t.assert.equal(result.status, 2);
      t.assert.match(result.stderr, /no such file/);
    });

    it("is executable so hooks can call it directly", (t) => {
      t.assert.doesNotThrow(() => accessSync(CHECKER, constants.X_OK));
    });
  });

  describe("input sources", () => {
    let dir;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "scopedcommits-test-"));
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("reads the message from stdin when FILE is omitted", (t) => {
      t.assert.equal(run(["-q"], "auth: from stdin").status, 0);
    });

    it("reads the message from stdin for '-'", (t) => {
      t.assert.equal(run(["-q", "-"], "auth: from stdin").status, 0);
    });

    it("reads a message file passed as FILE", (t) => {
      const file = join(dir, "COMMIT_EDITMSG");
      writeFileSync(file, "auth: from a file\n");
      t.assert.equal(run(["-q", file]).status, 0);
    });

    it("reads a message file after --", (t) => {
      const file = join(dir, "AFTER_DASH_DASH");
      writeFileSync(file, "auth: after --\n");
      t.assert.equal(run(["-q", "--", file]).status, 0);
    });

    it("treats stdin and file input identically", (t) => {
      const message = "auth: same either way\n\nWith a body.\n";
      const file = join(dir, "SAME");
      writeFileSync(file, message);
      const fromStdin = run(["-q", "-"], message);
      const fromFile = run(["-q", file]);
      t.assert.deepEqual(
        { status: fromFile.status, stdout: fromFile.stdout, stderr: fromFile.stderr },
        { status: fromStdin.status, stdout: fromStdin.stdout, stderr: fromStdin.stderr },
      );
    });
  });
});
