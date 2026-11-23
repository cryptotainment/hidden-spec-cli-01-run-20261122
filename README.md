# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cryptotainment/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cryptotainment/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits
in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format, and text-editor tool calls as JSON. Each format is read as SPEC.md
says, and every file is changed or nothing is.

Run it as `node main.ts [options] [PATCH]` with the working directory as the root of the
tree. Node 22, standard library alone. `main.ts` is the CLI; `runner.ts` is the kit's
trial runner, kept as the kit has it.

## Practice

The kit carries the 100 public practice checks at `program/generator/practice.json`
(unified 30, search_replace 20, v4a 20, json 15, cli 15). `check.ts` runs `main.ts`
on them:

    node check.ts ../program/generator/practice.json
    node check.ts ../program/generator/practice.json u-offset s-basic
