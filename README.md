# Diff Speed — a faster drop-in for makefun-diff 1.0.0

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/bagusin03/diff-speed-20261126/rank.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/bagusin03/diff-speed-20261126/reward.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)

An entry for the [make.fun](https://make.fun) bounty
[Diff two texts faster, 27 November 2026](https://make.fun/competitions/diff-speed-01-run-20261126):
`solve.js` returns, for every `{ old, new }`, exactly the patch that
makefun-diff 1.0.0 returns — same common prefix/suffix, same Myers greedy
search with the deletion tie-break, same hunks — only faster.

How it gets faster, without changing a single answer:

- Lines are interned to integer ids once per case, so the search compares
  integers, never strings.
- The search keeps the furthest x per diagonal per depth in one flat
  `Int32Array` instead of one linked-list path object per step, and recovers
  the script by walking that table backwards.
- The search is banded: a cheap greedy common subsequence (anchored on
  lines unique in both texts) gives a valid upper bound on the edit
  distance, and only diagonals that can carry a shortest script are
  visited. If the bound ever failed, the search falls back to the full
  triangle, so the answer is never affected.

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each one alone with `run()` from `solve.js`,
and writes `/output/answers.json`. Dependency-free, offline, deterministic.

Locally (practice set, same machine): ~540 ms CPU for all 4 cases vs
~1,810 ms for the house baseline — about 3.3x faster — with all 4 answers
byte-identical to makefun-diff 1.0.0.
