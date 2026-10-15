# scripts

`check-commit-message.mjs` is the Scoped Commits `commit-msg` validator. It is
both an executable — parses argv, reads a file or stdin, exits 0/1/2 — and a
library: its default export is `checkCommitMessage(message)`, returning
`{ ok, special, subject, issues }`.

Requires Node.js 24 or newer: the CLI entry guard uses `import.meta.main`, and
the tests use the `node:test` context assertion API.

`check-commit-message.test.mjs` covers both layers: in-process tests for the
exported function and spawned-process tests for the CLI contract (exit status,
stdout, stderr). There is no test framework dependency.

Run the tests from the skill directory:

```sh
node --test scripts/
```
