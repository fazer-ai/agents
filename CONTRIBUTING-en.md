# Contributing

[Português (Brasil)](CONTRIBUTING.md) · **English**


Thank you for your interest in contributing to **fazer.ai agents**! Bug reports, fixes, tests and documentation are all welcome.

## How this repository works

This repository is generated from an internal master monorepo, the source of the Free edition (open-source, Apache 2.0), the Pro edition (commercial) and every other distribution artifact. The mirroring shows up in the history as `Sync free (agents@<sha>)` commits by `fazer-ai-bot`.

This changes little for contributors, but it explains two things:

- **Your PR is accepted here, in the public repository.** After the merge, the change is reintegrated into the master with **your authorship preserved**, and the next mirror sync regenerates the tree with it already in place. Your commit stays in this repository's history.
- **Not every master file exists here.** Pro edition features are removed during derivation (or become stubs that return 403, behind a `ProGate` in the UI). PRs rebuilding Pro functionality are not accepted; beyond that, the entire Free surface is real code, open to contribution.

## Issues

- Search existing issues (open and closed) before filing a new one.
- For bugs, include: reproduction steps, expected behavior, observed behavior and relevant logs. Issues like [#2](https://github.com/fazer-ai/agents/issues/2) are a good model.
- **One issue, one thing.** Scope an issue so that a single pull request can close it. Work that splits into several pull requests is several issues: an issue nobody can close is an issue nobody can finish, and it stops being able to say what is left. This is about how to write one, not a requirement that every pull request have an issue.
- **Security vulnerabilities do not go in public issues:** write to [support@fazer.ai](mailto:support@fazer.ai).

## Pull requests

1. For large changes, open an issue first to align on the approach and avoid rework. You do not need permission to contribute, nor do you need to wait for an answer to start: if you would rather get a head start, send the PR along with the issue, or just the PR. The issue is there to settle the "how", and writing code before that alignment means accepting that some of it may be discarded, which is normal.
2. Prefer small, focused PRs: one logical change per PR.
3. **Tests accompany fixes and features.** Ideally tests that fail without the change and pass with it, proving they pin the behavior.
4. Run `bun check` before submitting (lint, type-check, i18n and tests, the same things CI runs).
5. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix(scope): ...`, `feat(scope): ...`).
6. UI copy goes through i18n (`bun i18n:extract`, keys in pt-BR and en); see [`docs/i18n.md`](docs/i18n.md).

## Development setup

The step-by-step lives in the [README](README-en.md#local-development). In short:

```bash
bun install
cp .env.example .env      # DATABASE_URL, MIGRATION_DATABASE_URL, ENCRYPTION_KEY
docker compose up -d      # PostgreSQL (pgvector)
bun db:bootstrap          # runtime role + grants
bun prisma:migrate
bun dev                   # http://localhost:3000
```

Per-subsystem guides live in [`docs/`](docs/); read the one for the subsystem you are touching.

## Code style

- Biome formats and lints (`bun lint`, `bun format`): 2 spaces, LF.
- Strict TypeScript; the `@/` alias points to `src/`.
- Comments only when strictly necessary, never redundant ones.

## CLA (Contributor License Agreement)

The project is distributed in two editions generated from the same master: Free (Apache 2.0) and Pro (commercial). So that your contribution can be reintegrated into the master and shipped in both, we ask for your agreement to the [CLA](https://github.com/fazer-ai/agents/blob/main/CLA.md), a license grant that authorizes that use **without transferring ownership**: the code remains yours.

**By submitting a pull request you state that you have read and agree to the [CLA](https://github.com/fazer-ai/agents/blob/main/CLA.md)** for that contribution and future ones.
