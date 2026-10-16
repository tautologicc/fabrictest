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
import { access, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";

import checkCommitMessage from "./check-commit-message.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-commit-message.mjs");

/** Run the CLI as a process and capture exactly what a git hook sees. */
const run = async (args, input = "") => {
  const child = spawn(process.execPath, [SCRIPT, ...args]);
  child.stdin.end(input);
  const [[status], stdout, stderr] = await Promise.all([
    once(child, "close"),
    text(child.stdout),
    text(child.stderr),
  ]);
  return { status, stdout, stderr };
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

describe("CLI: check-commit-message.mjs", () => {
  describe("default output", () => {
    it("is silent on success", async (t) => {
      const result = await run(["-"], "auth: fix login");
      t.assert.equal(result.status, 0);
      t.assert.equal(result.stdout, "");
      t.assert.equal(result.stderr, "");
    });

    it("is silent for special commits", async (t) => {
      const result = await run(["-"], 'Revert "auth: fix login"');
      t.assert.equal(result.status, 0);
      t.assert.equal(result.stdout, "");
    });

    it("still prints warnings", async (t) => {
      const result = await run(["-"], "auth : fix login");
      t.assert.equal(result.status, 0);
      t.assert.equal(result.stdout, "");
      t.assert.match(result.stderr, /warning: scope "auth " has leading or trailing whitespace/);
    });

    it("still prints errors", async (t) => {
      const result = await run(["-"], "fix(auth): nope");
      t.assert.equal(result.status, 1);
      t.assert.equal(result.stdout, "");
      t.assert.match(result.stderr, /error: Conventional Commits type prefix/);
      t.assert.match(result.stderr, /commit message does not follow Scoped Commits/);
    });
  });

  describe("--verbose", () => {
    it("prints the success message", async (t) => {
      const result = await run(["-v", "-"], "auth: fix the thing\n");
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /^check-commit-message\.mjs: ok: auth: fix the thing$/m);
      t.assert.equal(result.stderr, "");
    });

    it("announces a skipped special commit", async (t) => {
      const result = await run(["--verbose", "-"], 'Revert "auth: fix login"\n');
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /ok \(special commit, skipped\)/);
    });

    it("does not hide warnings or errors", async (t) => {
      const warned = await run(["-v", "-"], "auth : fix login");
      t.assert.equal(warned.status, 0);
      t.assert.match(warned.stderr, /warning: scope/);

      const failed = await run(["-v", "-"], "fix(auth): nope");
      t.assert.equal(failed.status, 1);
      t.assert.match(failed.stderr, /error: Conventional Commits type prefix/);
    });
  });

  describe("arguments", () => {
    it("prints usage with --help", async (t) => {
      const result = await run(["--help"]);
      t.assert.equal(result.status, 0);
      t.assert.match(result.stdout, /Usage:/);
      t.assert.match(result.stdout, /Scoped Commits convention/);
      t.assert.equal(result.stderr, "");
    });

    it("fails on an unknown option", async (t) => {
      const result = await run(["--bogus"]);
      t.assert.equal(result.status, 2);
      t.assert.match(result.stderr, /unknown option: --bogus/);
      t.assert.match(result.stderr, /Usage:/);
    });

    it("fails on a missing file", async (t) => {
      const result = await run([join(tmpdir(), `scopedcommits-missing-${process.pid}`)]);
      t.assert.equal(result.status, 2);
      t.assert.match(result.stderr, /no such file/);
    });

    it("fails when the argument is a directory", async (t) => {
      const result = await run([tmpdir()]);
      t.assert.equal(result.status, 2);
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
      t.assert.equal((await run([], "auth: from stdin")).status, 0);
    });

    it("reads the message from stdin for '-'", async (t) => {
      t.assert.equal((await run(["-"], "auth: from stdin")).status, 0);
    });

    it("reads a message file passed as FILE", async (t) => {
      const file = join(dir, "COMMIT_EDITMSG");
      await writeFile(file, "auth: from a file\n");
      t.assert.equal((await run([file])).status, 0);
    });

    it("reads a message file after --", async (t) => {
      const file = join(dir, "AFTER_DASH_DASH");
      await writeFile(file, "auth: after --\n");
      t.assert.equal((await run(["--", file])).status, 0);
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
