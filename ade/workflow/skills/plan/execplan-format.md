# ExecPlan format

An ExecPlan is one Markdown file that lets a reader who knows nothing about the repository deliver the feature from the plan alone. It is a living document: the implementer keeps its progress and decisions current.

Write prose first. Define every term that is not plain English where it first appears. Name files by their full repository path and functions by their exact name. Show commands and expected output as indented blocks.

Sections, in this order:

1. `# <Short action-oriented title>`
2. `## Purpose / Big Picture`: what a user can do after the change that they could not before, and how to see it working.
3. `## Assumptions`: facts the plan relies on that were not verified.
4. `## Open Questions`: anything unresolved, each tied to the section it affects. Empty when there is none.
5. `## Progress`: a checkbox list, one line per step, with a UTC timestamp when checked. The only checklist in the plan.
6. `## Surprises & Discoveries`: observations made while working, each with its evidence.
7. `## Decision Log`: entries of the form `Decision / Rationale / Date/Author`.
8. `## Outcomes & Retrospective`: written at the end: what was achieved against the purpose, and what is left.
9. `## Context and Orientation`: the current state of the code that matters, as if to a newcomer: key files, modules, terms.
10. `## Plan of Work`: the sequence of edits in prose, file by file, with the functions or modules to add or change. Use milestones when the work is large: each milestone is verifiable on its own and says what exists at its end.
11. `## Concrete Steps`: exact commands, the directory to run them from, and short expected output.
12. `## Validation and Acceptance`: behavior a human can check (a command and its output, a page and what it shows), plus the repository's test, lint and typecheck commands.
13. `## Idempotence and Recovery`: which steps can be re-run, and how to roll back a risky one.
14. `## Artifacts and Notes`: the short transcripts or snippets that prove success.
15. `## Interfaces and Dependencies`: the libraries to use and the exact types and signatures that must exist at the end.

Avoid: undefined jargon, decisions left to the implementer ("choose a library"), "verify it works" without the command, and plans that only describe the happy path.
