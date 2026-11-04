---
name: cut-a-version
description: Cut a version of ticket-runner by opening the release PR that raises the number and carries the notes.
disable-model-invocation: true
---

# Cut a version

A version is cut by merging a **release PR** (ADR-0007): it raises the number in
`package.json` and the lock file, and adds that version's section to
`CHANGELOG.md`. The push to `main` does the rest — the tag, and a GitHub Release
whose body is the section.

Work in a worktree when a Run may be active, as `CONTRIBUTING.md` asks: one is
when `git show origin/ticket-runner/lock:lock.json` reads `"held": true` for a
`workstation` Host named as this machine is. A cloud Host's Run pulls its own
checkout, not this one.

## 1. Check the checkout

The release PR carries only the files `CONTRIBUTING.md`'s Versions section
lists, and step 7 commits those and nothing else. List every other tracked
file the checkout has changed:

```bash
git status --porcelain --untracked-files=no | cut -c4- |
  grep -vxF -e package.json -e package-lock.json -e CHANGELOG.md \
    -e docs/agents/pipeline-conventions.md
```

When it prints anything, stop and name those files to the maintainer: they
are someone's work, and whether to move it is theirs to decide.

Done when it prints nothing.

## 2. Read the span

```bash
git fetch --tags origin main
last=$(git tag --list 'v*' --sort=-v:refname | head -1)
git log "$last"..origin/main --format='%s'
gh issue list --state closed --limit 1000 \
  --search "closed:>$(git log -1 --format=%cI "$last")" \
  --json number,title,closedAt,stateReason
```

Every subject in the span is a pull request that landed. The issues are those
closed after the last version's commit, to the second: a search by its date
would also count the ones closed earlier that day, and miss some closed after
it, since GitHub reads a date in UTC.

A dependency bump (`chore(deps): …`, `chore(deps-dev): …`, `ci(deps): …`) that
leaves the `dependencies` ranges in `package.json` unchanged earns no line:
that covers lock-file-only bumps, `devDependencies`, `wiki/` and Actions. npm
does not publish the lock file, so these change nothing a user installs. A bump
that changes a `dependencies` range earns a line. Only a commit that touched
`package.json` can have changed one:

```bash
git log "$last"..origin/main --format='%h %s' -- package.json
git show <hash> -- package.json
```

Done when each subject is accounted for: it earns a line of the notes, it
belongs in a line another subject already earned, or it is a dependency bump
that earns none.

## 3. Propose the number

A **Spec** is an issue with sub-issues, its Tickets. Minor when one closed in
the span, patch when none did — a small feature as much as a fix.

The maintainer has decided against that answer before, cutting a minor while
a Spec was still open and a patch over the Spec that then closed. So the
number goes to them beside its evidence: each Spec that closed in the span or
has a Ticket closed in it, when it closed, and how many of its Tickets closed
in the span, before it, and not yet. A Spec closed by hand after its last
Ticket is in the table too, with none in the span.

```bash
last=$(git tag --list 'v*' --sort=-v:refname | head -1)
epoch=$(git log -1 --format=%ct "$last")
echo "Since $last, cut $(git log -1 --format=%cI "$last")"
echo
echo "| Spec | Closed | Tickets in the span | Before it | Not yet |"
echo "|---|---|---|---|---|"
gh issue list --state closed --limit 1000 \
  --search "closed:>$(git log -1 --format=%cI "$last")" \
  --json number,parent,subIssuesSummary \
  --jq '.[] | (select(.subIssuesSummary.total > 0) | .number), (.parent.number // empty)' |
  sort -un | while read -r spec; do
    closed=$(gh issue view "$spec" --json closedAt -q '.closedAt // "open"')
    counts=$(gh api "repos/{owner}/{repo}/issues/$spec/sub_issues?per_page=100" --paginate \
      --jq ".[] | if .closed_at == null then \"open\" elif (.closed_at | fromdateiso8601) > $epoch then \"in\" else \"before\" end" |
      awk '{ n[$0]++ } END { printf "%d | %d | %d", n["in"], n["before"], n["open"] }')
    echo "| #$spec | $closed | $counts |"
  done
```

Done when the number is written down beside the table, and the Spec whose
closing decided it is named, or the table is empty.

## 4. Draft the notes

`docs/templates/version-notes.md` gives the section's shape and the rules for
every line of it; the sections already in `CHANGELOG.md` are the measure. The
new section goes at the top, under the file's heading and prose.

Gather what goes into `After upgrading` beside the `init` step the template
always asks for, from two places:

- What the span's own issues and pull requests ask. Read the body of each
  issue closed as completed in the span and of each pull request that landed
  in it, and carry into `After upgrading` anything they ask of the release
  notes or of a Target after upgrading. A Ticket can name that note as the
  guard for a case its code leaves to the human, and its pull request does not
  always repeat the request.

  ```bash
  gh issue view <n> --json body -q .body
  gh pr view <n> --json body -q .body
  ```

- What each change asks without saying so. Ask it of every change in the span:
  does a Target or its human now change the install command, add a config key,
  or do anything by hand before or after `init`?

Done when the section is in the file, every request found in the span's issues
and pull requests is in its `After upgrading` or was dropped on the
maintainer's word, and every line of it names something a reader of this tool
would act on or want to know.

## 5. Raise both numbers together

```bash
npm version <number> --no-git-tag-version
npx tsx scripts/version.ts mark
BASE_REF=main npx tsx scripts/version.ts check
```

`npm version` writes `package.json` and `package-lock.json` in one go, and the
check is the one the pull request will run. `mark` rewrites this repository's
own copy of the conventions document, which carries the version that wrote it:
this repository is a Target of its own pipeline, and its test suite refuses a
copy the new number would have written differently. Done when the check prints
that the number may merge.

## 6. Confirm with the maintainer

```bash
npx tsx scripts/version.ts notes
git diff --stat
```

Put four things in front of the maintainer: the number, the table from step 3
beside it, the notes as the first command prints them, and the diff stat. Then
stop and wait. A correction sends you back to the step it touches — a new
number to the heading in step 4 and then step 5, a reworded line to step 4
and then step 5's check — and back here with the result.

Done when the maintainer has approved this number and these notes in so many
words. A question, or a correction already applied, is not yet approval.

## 7. Open the release PR

```bash
git switch -c version/<number>
git commit -m "chore: version <number>" -- package.json package-lock.json \
  CHANGELOG.md docs/agents/pipeline-conventions.md
git push -u origin version/<number>
npx tsx scripts/version.ts notes |
  gh pr create --base main --title "chore: version <number>" --body-file -
```

The commit names its files, so nothing else changed in the checkout rides
along. The body is built from the committed changelog as the pull request
opens: the section as the tag workflow will extract it, so the notes are read
in the pull request exactly as they will be published.

Done when the pull request is open and its link is handed to the maintainer:
their review and their merge are what cut the version.
