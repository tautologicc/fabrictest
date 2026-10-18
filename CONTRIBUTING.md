---
{
  "scopes": ["treewide", "git", "skills/"]
}
---

# Contributing

## Setup

This repository uses direnv to configure its development environment.
You MUST install direnv and run `direnv allow`
from the repository root.
Until you do, the environment is inactive,
including the git hooks under `.githooks`.

## Commits

This project follows the Scoped Commits convention.
Before composing a commit message,
agents MUST read the `scopedcommits` skill
and follow its convention.

This project uses the scopes in the frontmatter above. The commit-message
checker enforces them. The list covers repository-wide changes
(`treewide`), Git workflow and tooling (`git`), and every skill under
`.pi/skills/` (`skills/`). See the `scopedcommits` skill for the pattern
syntax.

You MUST use one of these scopes,
or add the new scope to the `scopes` array in the frontmatter
in the same commit that introduces it.
