#!/usr/bin/env node
// check-commit-messages.mjs -- check Scoped Commits messages in a Git range.
//
// Usage:
//   check-commit-messages.mjs [--] [REV-LIST-ARG...]
//
// REV-LIST-ARG is passed to git rev-list; default: HEAD.
// Exit: 0 valid, 1 failure, 2 usage error.
//
// Examples:
//   check-commit-messages.mjs -- main..HEAD
//   check-commit-messages.mjs -- HEAD --not --remotes

import { execFile as execFileCallback } from "node:child_process";
import { parseArgs, promisify } from "node:util";

import checkCommitMessage, { loadProjectScopes } from "./check-commit-message.mjs";

const execFile = promisify(execFileCallback);

const git = async (args) => {
  try {
    const { stdout } = await execFile("git", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (error.stderr === undefined) throw error;
    const message = error.stderr.toString().trim() || error.message;
    throw new Error(message, { cause: error });
  }
};

async function main() {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
  });

  const revs = positionals.length > 0 ? positionals : ["HEAD"];

  let scopes;
  try {
    scopes = await loadProjectScopes();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let commits;
  try {
    commits = (await git(["rev-list", ...revs]))
      .split(/\r\n?|\n/)
      .filter(Boolean);
  } catch (error) {
    console.error(`cannot list commits: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let failed = false;
  for (const hash of commits) {
    let message;
    try {
      message = await git([
        "show",
        "-s",
        "--format=%B",
        "--no-show-signature",
        "--end-of-options",
        `${hash}^{commit}`,
      ]);
    } catch (error) {
      console.error(`cannot read commit ${hash}: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    const result = await checkCommitMessage(message, { scopes });
    for (const issue of result.issues) {
      console.error(`${hash}: ${issue.severity}: ${issue.message}`);
    }
    failed ||= !result.ok;
  }

  if (failed) {
    console.error("one or more commit messages do not follow Scoped Commits");
    process.exitCode = 1;
  } else {
    console.log(`ok: ${commits.length} commit message(s)`);
  }
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
