// Tests for check-commit-messages.mjs, using Node's built-in test runner.

import { after, before, describe, it } from "node:test";
// Local alias for the callback-based execFile; the promisified call is async.
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-commit-messages.mjs");

const run = async (args, { cwd, env = process.env } = {}) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env });
  child.stdin.end();
  const [[status], stdout, stderr] = await Promise.all([
    once(child, "close"),
    text(child.stdout),
    text(child.stderr),
  ]);
  return { status, stdout, stderr };
};

describe("CLI: check-commit-messages.mjs", () => {
  let dir;
  let env;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "scopedcommits-range-"));
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
    };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_NAMESPACE",
      "GIT_CONFIG_PARAMETERS",
    ]) {
      delete env[key];
    }

    await execFile("git", ["init", "-q"], { cwd: dir, env });
    await execFile("git", ["config", "user.email", "test@example.com"], { cwd: dir, env });
    await execFile("git", ["config", "user.name", "Test"], { cwd: dir, env });
    await execFile("git", ["config", "log.showSignature", "true"], { cwd: dir, env });
    await writeFile(join(dir, "CONTRIBUTING.md"), '---\n{"scopes":["git"]}\n---\n');

    const commit = (message) =>
      execFile(
        "git",
        [
          "-c",
          "commit.gpgSign=false",
          "commit",
          "--allow-empty",
          "--no-verify",
          "-q",
          "-m",
          message,
        ],
        { cwd: dir, env },
      );

    await commit("git: valid");
    await commit("auth: fix");
    await commit("fix(auth): nope");
    await commit(`git: ${"x".repeat(80)}`);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("checks a range and applies the project scopes", async (t) => {
    const authHash = (
      await execFile("git", ["rev-list", "--max-count=1", "HEAD~2"], { cwd: dir, env })
    ).stdout.trim();
    const result = await run(["--", "HEAD"], { cwd: dir, env });

    t.assert.equal(result.status, 1);
    t.assert.equal(result.stdout, "");
    t.assert.match(result.stderr, /unknown scope "auth"/);
    t.assert.match(result.stderr, /Conventional Commits type prefix/);
    t.assert.match(result.stderr, new RegExp(authHash));
  });

  it("defaults to the upstream range", async (t) => {
    await execFile("git", ["branch", "base", "HEAD~2"], { cwd: dir, env });
    await execFile("git", ["branch", "--set-upstream-to=base"], { cwd: dir, env });
    try {
      const result = await run([], { cwd: dir, env });
      t.assert.equal(result.status, 1);
      t.assert.match(result.stderr, /Conventional Commits type prefix/);
      t.assert.ok(!/unknown scope "auth"/.test(result.stderr));
    } finally {
      await execFile("git", ["branch", "--unset-upstream"], { cwd: dir, env });
      await execFile("git", ["branch", "-D", "base"], { cwd: dir, env });
    }
  });

  it("defaults to commits not on a remote", async (t) => {
    await execFile("git", ["update-ref", "refs/remotes/origin/main", "HEAD~2"], {
      cwd: dir,
      env,
    });
    try {
      const result = await run([], { cwd: dir, env });
      t.assert.equal(result.status, 1);
      t.assert.match(result.stderr, /Conventional Commits type prefix/);
      t.assert.ok(!/unknown scope "auth"/.test(result.stderr));
    } finally {
      await execFile("git", ["update-ref", "-d", "refs/remotes/origin/main"], {
        cwd: dir,
        env,
      });
    }
  });

  it("prints the outcome when every message is valid", async (t) => {
    const result = await run(["--", "--max-count=1", "HEAD~3"], { cwd: dir, env });
    t.assert.equal(result.status, 0);
    t.assert.match(result.stdout, /1 commit messages validated in /);
    t.assert.equal(result.stderr, "");
  });

  it("does not fail on warnings", async (t) => {
    const result = await run(["--", "--max-count=1", "HEAD"], { cwd: dir, env });
    t.assert.equal(result.status, 0);
    t.assert.match(result.stderr, /warning:/);
  });

  it("prints warnings and the outcome together", async (t) => {
    const result = await run(["--", "--max-count=1", "HEAD"], { cwd: dir, env });
    t.assert.equal(result.status, 0);
    t.assert.match(result.stderr, /warning:/);
    t.assert.match(result.stdout, /1 commit messages validated in /);
  });

  it("accepts an empty range", async (t) => {
    const result = await run(["--", "HEAD..HEAD"], { cwd: dir, env });
    t.assert.equal(result.status, 0);
    t.assert.match(result.stdout, /0 commit messages validated in HEAD\.\.HEAD/);
    t.assert.equal(result.stderr, "");
  });

  it("passes --not --remotes through to rev-list", async (t) => {
    const result = await run(["--", "HEAD~3", "--not", "--remotes"], {
      cwd: dir,
      env,
    });
    t.assert.equal(result.status, 0);
    t.assert.match(result.stdout, /1 commit messages validated in /);
    t.assert.equal(result.stderr, "");
  });

  it("reports an invalid range", async (t) => {
    const result = await run(["--", "nope..HEAD"], { cwd: dir, env });
    t.assert.equal(result.status, 1);
    t.assert.match(result.stderr, /cannot list commits/);
  });

  it("runs with portable rules when CONTRIBUTING.md has no frontmatter", async (t) => {
    const file = join(dir, "CONTRIBUTING.md");
    const saved = await readFile(file, "utf8");
    await writeFile(file, "# Contributing\n");
    try {
      const result = await run(["--", "--max-count=1", "HEAD~3"], { cwd: dir, env });
      t.assert.equal(result.status, 0);
    } finally {
      await writeFile(file, saved);
    }
  });

  it("reports malformed frontmatter", async (t) => {
    const file = join(dir, "CONTRIBUTING.md");
    const saved = await readFile(file, "utf8");
    await writeFile(file, '---\n{"scopes":["git"]\n---\n');
    try {
      const result = await run(["--", "--max-count=1", "HEAD~3"], { cwd: dir, env });
      t.assert.equal(result.status, 1);
      t.assert.match(result.stderr, /invalid JSON frontmatter/);
    } finally {
      await writeFile(file, saved);
    }
  });

  it("rejects -h", async (t) => {
    const result = await run(["-h"], { cwd: dir, env });
    t.assert.equal(result.status, 2);
    t.assert.match(result.stderr, /Unknown option '-h'/);
    t.assert.equal(result.stdout, "");
  });

  it("rejects an unknown option", async (t) => {
    const result = await run(["--bogus"], { cwd: dir, env });
    t.assert.equal(result.status, 2);
    t.assert.match(result.stderr, /Unknown option '--bogus'/);
  });
});
