---
title: 설정
description: ticket-runner.json의 모든 필드, 기본값, 그리고 각 필드가 Run에서 바꾸는 것.
---

# 설정

Target은 설정 없이도 돌아가야 하므로 모든 필드는 선택이고, `init`은 파일을 `{}`로 만듭니다. 이 파일은 Target만 아는 것을 적는 곳입니다. 어떤 명령이 코드가 제대로 돈다는 걸 증명하는지, CI가 얼마나 걸리는지, Check가 한 머신을 함께 써도 되는지, 라벨을 뭐라고 부르는지 같은 것들이죠. 머신 하나가 Ticket을 몇 개까지 동시에 감당할지는 그 머신이 정할 일이라, 사실상 Host에 관한 유일한 설정은 [`--lanes`](./running.md#lanes)가 덮어씁니다.

파일은 Target 루트의 `ticket-runner.json`입니다. `JSON.parse`로 읽는 평범한 JSON이라 주석을 넣을 수 없습니다.

| 필드 | 기본값 | 바꾸는 것 |
|---|---|---|
| [`baseBranch`](#basebranch) | GitHub의 기본 branch | Ticket을 따 오고, rebase하고, merge하는 branch |
| [`lanes`](#lanes) | `1` | Run이 동시에 쥐는 Ticket 수 |
| [`checks`](#checks) | `package.json`에서 추론 | 파이프라인이 Ticket을 거르려고 직접 돌리는 명령 |
| [`checkTimeoutMinutes`](#checks) | `15` | Check 명령 하나당 wall-clock 한도 |
| [`gates.checks`](#gates) | `true` | Check가 하나도 없어도 Run을 시작할지 |
| [`gates.ci`](#gates) | `true` | CI check가 없는 pull request를 merge할지 |
| [`stages`](#stages) | 아래 참고 | Stage별 모델, effort, 한도, 추가 지시 |
| [`permissionMode`](#permissionmode) | `"auto"` | 모든 Stage 세션이 묻지 않고 할 수 있는 일 |
| [`ciTimeoutMinutes`](#ci) | `30` | pull request의 CI를 기다리는 시간 |
| [`ciGraceMinutes`](#ci) | `5` | "아직 등록된 check 없음"을 대기 중으로 봐 주는 시간 |
| [`labels`](#labels) | 기본 이름 여섯 개 | 파이프라인이 읽고 쓰는 라벨 이름 |

여러 필드를 설정한 예:

```json
{
  "baseBranch": "develop",
  "lanes": 2,
  "checks": ["npm test", "npm run typecheck", "npm run lint"],
  "checkTimeoutMinutes": 20,
  "stages": {
    "implement": { "maxTurns": 400, "extraPrompt": "Run `npm run lint -- --fix` before committing." },
    "verify": { "effort": "max" }
  },
  "ciTimeoutMinutes": 45,
  "labels": { "readyForAgent": "agent-ready" }
}
```

## 읽히지 않는 파일 {#a-file-that-will-not-load}

스키마는 엄격합니다. 모르는 키, 잘못된 타입, 범위를 벗어난 값은 이름을 짚어 거절하고, JSON이 아닌 파일도 마찬가지입니다. 파일을 읽는 명령(`init`, `run`, `remove`)은 모두 종료 코드 `2`로 끝납니다. `stop`은 파일을 아예 읽지 않습니다.

```text
Invalid ticket-runner.json: stages: Unrecognized key: "implment". Refused by ticket-runner 0.5.2, so the key may be newer than this install.
```

두 번째 문장은 모르는 키일 때만 붙습니다. 설치가 오래된 머신에서는 새 Version이 추가한 키와 오타가 똑같아 보이니, 거절한 Version을 밝혀 두는 것입니다. 파일 자체에는 Version을 적지 않습니다([ADR-0007](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0007-a-version-is-cut-by-a-human-and-installs-follow-tags.md)).

## `baseBranch` {#basebranch}

- `baseBranch`: 문자열

[Base branch](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md)는 Run이 Ticket마다 branch를 따 오고, rebase하고, pull request가 향하고, merge 뒤에 메인 체크아웃을 pull하는 branch입니다. 이 필드가 없으면 GitHub가 저장소의 기본 branch라고 부르는 것을 쓰니, `master`를 쓰는 Target도 따로 설정할 필요가 없습니다. Run이 시작할 때 한 번 정합니다.

## `lanes` {#lanes}

- `lanes`: 1 이상의 정수

Run이 동시에 쥐는 Ticket 수입니다. [Lane](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md) 하나에 Ticket 하나. `run --lanes <n>`이 한 Run에 한해 덮어씁니다. Lane들은 각자의 worktree에서 동시에 Check를 돌리니, Check가 포트나 데이터베이스처럼 함께 써야 하는 것을 필요로 하는 Target은 `1`로 두세요. Landing(rebase부터 merge까지)에는 한 번에 Lane 하나만 들어가므로, Lane을 늘리면 implement와 verify가 빨라질 뿐 merge가 빨라지지는 않습니다([ADR-0005](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0005-landing-is-a-serialized-section.md)).

## `checks` {#checks}

- `checks`: 문자열 배열
- `checkTimeoutMinutes`: 0보다 큰 수

[Check](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md)는 파이프라인이 직접 돌리는 결정적인 명령이지, 에이전트의 의견이 아닙니다. 각 명령은 Ticket의 worktree에서 셸을 통해 돌고, implement Stage 뒤, fix Stage 뒤, rebase 충돌을 해결한 뒤에 실행됩니다. 0이 아닌 코드로 끝나면 게이트를 통과하지 못하고, Ticket은 [Fix budget](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md)을 씁니다.

이 필드가 없으면 `package.json`에 `test`, `typecheck` 스크립트 중 정의된 것을 보고 `npm test`와 `npm run typecheck`를 추론합니다.

`checkTimeoutMinutes`는 모든 명령에 하나로 적용되는 한도이고, 명령마다 이 시간을 통째로 받습니다. 한도에서 kill된 명령은 실패한 Check이고 다른 실패처럼 Fix budget을 씁니다. 멈춰 버리는 테스트 스위트는 branch 자기 코드의 결함이기 때문입니다. fix Stage에는 Check가 실패한 게 아니라 멈췄다는 사실이 전달됩니다.

## `gates` {#gates}

- `gates.checks`: 불리언
- `gates.ci`: 불리언

| 설정 | 켜져 있을 때(기본) | `false`일 때 |
|---|---|---|
| `gates.checks` | 설정하거나 추론한 Check 명령이 하나도 없으면 Run이 시작을 거절 | 경고와 함께 그대로 시작. 존재하는 Check 명령은 여전히 돎 |
| `gates.ci` | CI check가 하나도 없는 pull request는 Hand-off | 시작할 때 경고하고, merge하면서 Ticket에 `⚠️ no checks` 줄을 남김 |

`gates.ci`를 꺼도 봐주는 것은 check가 *하나도 없는* pull request뿐입니다. CI 실패, CI 시간 초과, Base branch와 충돌하는 pull request는 게이트 설정과 상관없이 Ticket을 끝냅니다.

`gates.checks`가 막아 주는 거절은 이렇게 나옵니다.

```text
No Check commands are configured and none could be inferred from package.json. Add them to `checks` in ticket-runner.json, add `test` and `typecheck` scripts to package.json, or set `gates.checks` to false in ticket-runner.json to run without a net.
```

## `stages` {#stages}

- `stages`: 객체

Stage 하나는 `claude -p` 세션 하나입니다. `stages`는 Stage마다 객체를 받고, 안의 키는 모두 선택입니다.

| Stage | 하는 일 | `maxTurns` | `maxMinutes` |
|---|---|---|---|
| `implement` | Ticket에 `/mattpocock-skills:implement`를 돌림 | `300` | `60` |
| `verify` | Acceptance Criteria가 충족되지 않았음을 증명하려 하고, Verdict를 돌려줌 | `80` | `20` |
| `fix` | Fix budget을 쓰게 만든 실패 하나를 고침 | `150` | `40` |
| `conflict` | rebase가 멈춘 자리에서 충돌을 해결함 | `120` | `30` |

| 키 | 타입 | 기본값 | 넘기는 방식 |
|---|---|---|---|
| `model` | 문자열 | `"claude-opus-5-5"` | `--model` |
| `effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | `"high"` | `--effort` |
| `maxTurns` | 1 이상의 정수 | 위의 Stage별 값 | `--max-turns` |
| `maxMinutes` | 0보다 큰 수 | 위의 Stage별 값 | 세션을 kill하는 wall-clock 한도 |
| `extraPrompt` | 문자열 | `""` | Stage 프롬프트의 마지막 섹션으로 덧붙임 |

모델과 effort는 머신 기본값에 맡기지 않고 언제나 넘깁니다. 그래서 저장된 Stage 명령줄만 보면 무엇으로 돌렸는지 정확히 알 수 있고, 다시 돌려도 똑같이 돕니다. 턴이나 시간을 다 쓴 Stage가 Ticket에 무엇을 치르게 하는지는 [Ticket 하나가 merge되기까지](./ticket-to-merge.md)에 있습니다.

## `permissionMode` {#permissionmode}

- `permissionMode`: `"auto"`, `"acceptEdits"`, `"bypassPermissions"`

모든 Stage에 `--permission-mode`로 넘깁니다. 모든 Stage는 `--permission-prompts none`으로도 돕니다. 지켜보는 사람이 없으니, 물어봐야 할 일은 묻는 대신 거부됩니다. 고를 수 있는 모드는 무인으로 일할 수 있는 것들뿐입니다. `plan`이나 물어보는 모드로는 아무 일도 하지 않는 Stage가 될 게 뻔하니까요.

## CI {#ci}

- `ciTimeoutMinutes`: 0보다 큰 수
- `ciGraceMinutes`: 0보다 큰 수

Landing이 pull request를 연 뒤, Run은 최대 `ciTimeoutMinutes` 동안 check를 기다립니다. 시간 안에 끝나지 않는 CI는 Fix budget을 쓰지 않는 Hand-off입니다. 남의 인프라 문제이지, fix Stage가 고칠 수 있는 결함이 아니기 때문입니다.

`ciGraceMinutes`는 GitHub가 check run을 등록하기 전의 틈을 메웁니다. 이 틈이 3분을 넘긴 적도 있습니다. 이 시간이 지나기 전까지는 check가 아직 없는 pull request를 "없음"이 아니라 대기 중으로 봅니다. `ciTimeoutMinutes`보다 길어지지는 않습니다. Actions 대기열이 느린 Target이라면 늘리세요. CI 워크플로가 없는 Target은 merge할 때마다 이 시간을 한 번씩 기다리고, Landing에는 한 번에 Lane 하나만 들어가니 그동안 다른 Lane의 merge도 함께 기다립니다.

## `labels` {#labels}

- `labels`: 문자열 객체

Target이 이미 다른 라벨 이름을 쓰고 있다면 triage 어휘의 이름을 바꾸세요. 준 키만 바뀝니다.

| 키 | 기본값 |
|---|---|
| `needsTriage` | `needs-triage` |
| `needsInfo` | `needs-info` |
| `readyForAgent` | `ready-for-agent` |
| `readyForHuman` | `ready-for-human` |
| `wontfix` | `wontfix` |
| `inProgress` | `in-progress` |

`init`은 이 이름으로 라벨을 만들고, 하나라도 없는 Target은 Run이 거절합니다. 각 라벨이 파이프라인에 어떤 뜻인지는 [일 계획하기](./planning.md#labels)에 있습니다.

## 관련 페이지 {#related-pages}

- [실행하기](./running.md): `--lanes`, 그리고 이 파일을 읽는 Run.
- [Ticket 하나가 merge되기까지](./ticket-to-merge.md): 각 Stage, Check, 게이트가 Ticket의 일생 어디에 있는지.
- [일 계획하기](./planning.md): 라벨과 그 뜻.
- [설치와 제거](./installation.md): `init`이 빈 파일을 만들고, `remove`가 맨 마지막에 지움.

## 참고 자료 {#references}

- [`src/config.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/config.ts), [`src/ports/agent-runner.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/ports/agent-runner.ts), [`src/startup.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/startup.ts), [`src/base-branch.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/base-branch.ts)
- [`src/orchestrator.ts` · `runChecks`, `requireGreenCi`](https://github.com/jjongs2/ticket-runner/blob/main/src/orchestrator.ts), [`src/prompts.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/prompts.ts), [`src/adapters/claude-agent-runner.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/claude-agent-runner.ts), [`src/adapters/gh-tracker.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/gh-tracker.ts), [`src/adapters/git-workspace.ts` · `runCheck`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/git-workspace.ts)
- [ADR-0002](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0002-claude-p-child-process-per-stage.md), [ADR-0005](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0005-landing-is-a-serialized-section.md), [ADR-0007](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0007-a-version-is-cut-by-a-human-and-installs-follow-tags.md)
