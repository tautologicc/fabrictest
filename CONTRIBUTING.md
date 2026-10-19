---
{
  "scopes": ["treewide", "git", "skills/"]
}
---

# Contributing

## Setup

direnv is the fastest way to stand up this repository's development
environment: install it, then run `direnv allow` once from the
repository root to load `.envrc`. Tools, configuration, and the git
hooks under `.githooks` all come online only while that environment is
active. Confirm it once at the start of a session with `direnv status`
— if it reports the loaded `.envrc`, you're set for the rest of the
session.

The git hooks are one piece of that environment. They carry out
routine housekeeping and compliance on their own — validating commit
messages, guarding pushes, and so on — so leave those checks to the
hooks instead of repeating them by hand. For example, you MUST NOT run
the commit-message checker yourself when the hooks already validate
every commit.

## Commits

This project follows the Scoped Commits convention.
Before composing a commit message,
agents MUST read the `scopedcommits` skill
and follow its convention.

This project uses the scopes in the frontmatter above. The commit-message
checker enforces them:

- `treewide` — repository-wide changes
- `git` — Git workflow and tooling
- `skills/` — every skill under `.pi/skills/`

See the `scopedcommits` skill for the pattern syntax.

You MUST use one of these scopes,
or add the new scope to the `scopes` array in the frontmatter
in the same commit that introduces it.
