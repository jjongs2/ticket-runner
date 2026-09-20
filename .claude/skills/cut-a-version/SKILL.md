---
name: cut-a-version
description: Cut a Version of agent-pipeline by opening the Version PR that raises the number and carries the notes.
disable-model-invocation: true
---

# Cut a Version

A Version is cut by merging a **Version PR** (ADR-0007): it raises the number in
`package.json` and the lock file, and adds that Version's section to
`CHANGELOG.md`. The push to `main` does the rest — the tag, and a GitHub Release
whose body is the section.

Work in a worktree when a Run may be active, as `CONTRIBUTING.md` asks.

## 1. Read the span

```bash
git fetch --tags origin main
last=$(git tag --list 'v*' --sort=-v:refname | head -1)
git log "$last"..origin/main --format='%s'
```

Every subject in the span is a pull request that landed. Done when each one is
accounted for: it earns a line of the notes, or it belongs in a line another
subject already earned.

## 2. Propose the number

A **Spec** is an issue with sub-issues. Minor when one closed in the span, patch
when none did — a small feature as much as a fix.

```bash
gh issue list --state closed --search "closed:>=$(git log -1 --format=%cs "$last")" \
  --json number,title,closedAt
gh issue view <n> --json subIssuesSummary -q .subIssuesSummary.total
```

Done when every issue closed in the span has been asked that one question, and
the number is written down with the answer that decided it.

## 3. Draft the notes

`docs/templates/version-notes.md` is the shape; the five sections already in
`CHANGELOG.md` are the measure. Terse: one line per change, about a dozen words,
ending in its pull request numbers. The new section goes at the top, under the
heading and the prose, dated today.

`After upgrading` is the line only this repository can write, because the
pipeline rewrites files in every Target it is set up in. Ask it of every change
in the span — does a Target or its human now run `init` again, change the
install command, add a config key? — and write `nothing` when the answer to all
of them is no.

Done when the section is in the file and every line of it names something a
reader of this tool would act on or want to know.

## 4. Raise both numbers together

```bash
npm version <number> --no-git-tag-version
BASE_REF=main npx tsx scripts/version.ts check
```

`npm version` writes `package.json` and `package-lock.json` in one go, and the
check is the one the pull request will run. Done when it prints that the number
may merge.

## 5. Open the Version PR

```bash
git switch -c version/<number>
git commit -a -m "chore: version <number>"
git push -u origin version/<number>
npx tsx scripts/version.ts notes > "${TMPDIR:-/tmp}/version-notes.md"
gh pr create --base main --title "chore: version <number>" \
  --body-file "${TMPDIR:-/tmp}/version-notes.md"
```

The body is the section as the tag workflow will extract it, so the notes are
read in the pull request exactly as they will be published. It is the one pull
request on `main` that carries no Ticket number.

Done when the pull request is open and its link is handed to the maintainer:
their review and their merge are what cut the Version.
