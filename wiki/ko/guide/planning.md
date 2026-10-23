---
title: 일 계획하기
description: GitHub 이슈가 파이프라인이 가져가는 Ticket이 되는 조건. Spec과 Ticket, Acceptance Criteria, 네이티브 blocker, 라벨, 그리고 Planning이 쓸 수 없게 남긴 것을 거르는 Guard
---

# 일 계획하기

파이프라인은 계획하지 않습니다. Planning은 사람 몫으로 두고, 파이프라인은 Planning이 넘겨준 것만 받아 갑니다([ADR-0001](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0001-humans-plan-the-pipeline-executes.md)). 넘겨받은 것을 믿고 일하는 만큼, 이슈에서 읽는 것은 몇 가지뿐이고 그것도 엄격하게 읽습니다. 그중 하나라도 어긋난 이슈는 짐작하지 않고 거절합니다.

| Ticket에 필요한 것 | 이유 |
|---|---|
| `ready-for-agent` 라벨 | Run이 Ticket을 찾는 방법 |
| 담당자 없음 | 누군가 지정되어 있으면 이미 claim한 것 |
| Acceptance Criteria: 본문이나 코멘트의 `- [ ]` 줄 | verify Stage가 판정하는 유일한 대상 |
| 네이티브 `blocked by` 연결로 적은 blocker, 모두 닫힘 | 어떤 Ticket을 어떤 순서로 돌릴지 정함 |
| 네이티브 sub-issue 없음 | sub-issue가 있는 이슈는 Ticket이 아니라 Spec |

같은 목록을 계획을 맡는 에이전트용으로 적어 둔 것이 conventions 문서 [`docs/agents/pipeline-conventions.md`](https://github.com/jjongs2/ticket-runner/blob/main/docs/agents/pipeline-conventions.md)입니다. `init`이 모든 Target에 넣어 둡니다.

## Spec과 Ticket {#specs-and-tickets}

Planning은 `mattpocock-skills` 플러그인의 스킬을 차례로 쓰는 일이고, 내 세션에서 직접 돌립니다.

| 스킬 | 만드는 것 |
|---|---|
| `grilling` | 에이전트가 아니라 내가 질문에 답한 계획 |
| `to-spec` | **Spec**: 기능 하나를 통째로 설명하는 부모 이슈 |
| `to-tickets` | **Ticket**: Spec의 네이티브 sub-issue. 하나가 에이전트 세션 하나 분량이고, `ready-for-agent` 라벨이 붙음 |
| `triage` | 다른 경로로 들어온 이슈를 Ticket으로. 브리프(와 그 기준)는 코멘트로 올라감 |

[Spec](https://github.com/jjongs2/ticket-runner/blob/main/GLOSSARY.md)은 언제나 하위 Ticket을 통해서만 구현됩니다. [Ticket](https://github.com/jjongs2/ticket-runner/blob/main/GLOSSARY.md)은 implement Stage 한 번에 끝날 만큼 작아야 합니다. implement Stage는 기본으로 300턴, 60분입니다([설정](./configuration.md#stages)).

`to-tickets`를 돌린 뒤에는, 그대로 두면 Guard가 거절할 것들을 확인하세요.

- Ticket마다 `- [ ]` 기준과 `ready-for-agent` 라벨이 있는지
- 본문이 `Blocked by` 아래 적은 이슈마다 네이티브 연결도 있는지([blocker](#blockers))
- Spec에 `ready-for-agent`가 없는지. `to-spec`이 이 라벨을 붙이는데, Ticket이 생기기 전까지 Run은 Spec을 `no-criteria`로 건너뛰고, Ticket이 생기면 `spec` Guard가 라벨을 뗍니다.

부모와 blocker까지 달아서 직접 만들려면:

```bash
gh issue create --title "Drain the Frontier" --parent 12 --blocked-by 14,15 --label ready-for-agent
```

## Acceptance Criteria {#acceptance-criteria}

기준 하나는 줄 맨 앞에 있는, 체크되지 않은 task list 항목입니다. 들여쓰기(있어도 되고 없어도 됨), `-`, `*`, `+` 중 하나의 불릿, 공백 하나, 그리고 `[ ]`. 아무리 약속처럼 읽혀도 그 밖의 것은 기준이 아닙니다.

```markdown
- [ ] `run 3 7` takes only #3 and #7            ← 기준
  * [ ] a nested item counts too                ← 기준
- [x] already ticked                            ← 아님: 더 판정할 게 없음
The command must refuse bad input.              ← 아님: 산문
1. [ ] a numbered item                          ← 아님: 불릿이 없음
```

verify Stage는 기준마다 `met`, `unmet`, `unverifiable` 중 하나로 판정합니다([Ticket 하나가 merge되기까지](./ticket-to-merge.md#the-verify-stage-and-its-verdict)).

기준은 세션이 코드를 돌려 보거나 읽어서 확인할 수 있게 쓰세요. 사람의 눈이 필요한 기준(스크린샷, 느낌)은 `unverifiable`로 돌아옵니다.

## blocker {#blockers}

GitHub의 네이티브 `blocked by` 연결만 셉니다([ADR-0003](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0003-github-native-relations-only.md)). 그래서 Run이 가져가는 것은 GitHub 화면에서 막힘이 풀렸다고 보이는 것과 같습니다.

```bash
gh issue edit 23 --add-blocked-by 14,15      # 기존 이슈에 연결 추가
gh issue edit 23 --remove-blocked-by 15      # 하나 떼기
```

blocker 중 하나라도 열려 있으면 Ticket은 기다립니다. 같은 Run의 다른 Lane이 아직 작업 중인 blocker도 열려 있는 것이고, 두 Ticket이 서로 방해하지 않게 하는 장치는 이것뿐입니다. 어떤 Ticket끼리 나란히 돌려도 되는지를 따로 판단하는 것은 없습니다. blocker가 merge되는 순간, 그 blocker에 막혀 있던 Ticket을 같은 Run 안에서 가져갈 수 있게 됩니다. 그러니 같은 코드를 바꾸는 Ticket 사이에는 blocker를 연결하세요. 그러면 두 번째 Ticket이 첫 번째 위에서 만들어집니다. 연결이 없으면 둘이 나란히 돌고, 나중 것의 rebase는 [Conflict Stage](./ticket-to-merge.md#the-conflict-stage)로 갑니다.

본문의 `Blocked by` 섹션은 사람이 읽을 사본으로 두어도 괜찮습니다. 다만 거기 적힌 이슈마다 네이티브 연결도 있어야 합니다. 연결이 없는 이슈를 적어 두면 `body-only-blockers` Guard가 Ticket을 거절합니다. Guard는 그 섹션만 읽으니, 본문의 다른 곳에 있는 이슈 참조는 그냥 산문입니다.

| 쓰는 방식 | 섹션이 끝나는 곳 |
|---|---|
| 한 줄에 `Blocked by: #14, #15` | 그 줄 끝 |
| `## Blocked by` 제목 다음의 목록 | 제목 아래 첫 목록의 끝 |

다른 저장소를 가리키는 참조(`other/repo#12`)는 blocker로 읽지 않습니다.

## 라벨 {#labels}

라벨은 triage 상태 기계입니다. 이슈 하나에는 한 번에 상태 라벨 하나만 붙습니다. `init`이 여섯 개를 모두 만들고, [`labels`](./configuration.md#labels)로 이름을 바꿀 수 있습니다.

| 라벨 | 붙이는 쪽 | 파이프라인이 하는 일 |
|---|---|---|
| `needs-triage` | 사람. 파이프라인은 상설 Notes 이슈에 | 그 라벨로 Notes 이슈를 여는 것 말고는 없음 |
| `needs-info` | 사람 | 없음 |
| `ready-for-agent` | Planning, Release, Ticket을 돌려주는 사람 | Candidate로 가져감. Claim할 때 뗌 |
| `in-progress` | Run만, Claim할 때 | Run이 맡고 있는 Ticket 표시. merge, Hand-off, Release 때 뗌 |
| `ready-for-human` | Hand-off | 사람이 라벨을 바꿀 때까지 건드리지 않음 |
| `wontfix` | 사람 | 없음 |

파이프라인이 어떤 Ticket을 건드리지 않게 하려면 `ready-for-agent`를 떼거나 누군가를 담당자로 지정하세요. 담당자가 있는 Candidate는 이미 claim된 것으로 보고 조용히 넘어갑니다. 내 세션에서 Spec에 플러그인의 `/implement-spec`을 돌리기 전에도 이렇게 해 두세요. `/implement-spec`은 작업하는 Ticket에 아무 표시도 남기지 않으니, Run도 그 Ticket을 가져가 다른 branch에서 같은 일을 또 하게 됩니다.

## Guard {#guards}

Planning은 몇 가지 알려진 방식으로 어긋납니다. [Guard](https://github.com/jjongs2/ticket-runner/blob/main/GLOSSARY.md)는 이런 Candidate를 claim하기 전에 건너뛰고, 그 이유를 한 번 알려 줍니다. Planning 결과를 고친 뒤 다시 돌리면 됩니다.

```mermaid
flowchart TD
  A["ready-for-agent 라벨이 붙은 열린 이슈"] --> B{"담당자가 있나?"}
  B -- 예 --> Z["조용히 넘어감"]
  B -- 아니오 --> C{"열린 네이티브 blocker가 있나?"}
  C -- 예 --> W["기다림, blocked로 보고"]
  C -- 아니오 --> F["Frontier에 오름, 낮은 번호부터"]
  F --> G1{"sub-issue가 있나?"}
  G1 -- 예 --> S["spec: 경고, ready-for-agent 뗌"]
  G1 -- 아니오 --> G2{"- [ ] 기준이 있나?"}
  G2 -- 아니오 --> N["no-criteria: 경고, 라벨 유지"]
  G2 -- 예 --> G3{"네이티브 연결이 없는<br>blocker를 본문이 적었나?"}
  G3 -- 예 --> O["body-only-blockers: 경고, 라벨 유지"]
  G3 -- 아니오 --> CL["Claim"]
```
<!-- Sources: src/frontier.ts, src/guards.ts, src/orchestrator.ts -->

| 이유 | Candidate의 상태 | 파이프라인이 하는 일 |
|---|---|---|
| `spec` | 네이티브 sub-issue가 있으니 Spec | 건너뛰고 `ready-for-agent`를 뗌. 하위 Ticket은 하나씩 가져감 |
| `no-criteria` | 본문과 코멘트에 `- [ ]` 줄이 없어 verify가 판정할 게 없음 | 건너뛰고 라벨은 둠. 코멘트로 기준을 더할 수 있으니까 |
| `body-only-blockers` | `Blocked by` 섹션이 네이티브 연결 없는 이슈를 적음 | 건너뛰고 라벨은 둠. 본문의 줄은 blocker로 읽지 않음 |

건너뛸 때는 무엇을 고치면 되는지 적은 경고 코멘트를 남기되, 같은 이유로는 한 번만 답니다. Run 요약에는 `skipped  #<n> <reason>`으로 남습니다. 이슈를 고치면 다음 Run이 가져갑니다.

## 관련 페이지 {#related-pages}

- [실행하기](./running.md): Run이 비우는 Frontier, 그리고 지정한 Ticket으로 좁힌 Run
- [Ticket 하나가 merge되기까지](./ticket-to-merge.md): Ticket을 claim한 다음 일어나는 일과 verify가 기준을 판정하는 방식
- [설정](./configuration.md): 라벨 이름 바꾸기
- [설치와 제거](./installation.md): `init`이 라벨과 conventions 문서를 만듦

## 참고 자료 {#references}

- [`src/guards.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/guards.ts), [`src/frontier.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/frontier.ts), [`src/acceptance-criteria.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/acceptance-criteria.ts), [`src/criteria.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/criteria.ts)
- [`src/orchestrator.ts` · `passOver`](https://github.com/jjongs2/ticket-runner/blob/main/src/orchestrator.ts), [`src/labels.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/labels.ts), [`src/adapters/gh-tracker.ts`](https://github.com/jjongs2/ticket-runner/blob/main/src/adapters/gh-tracker.ts)
- [`docs/agents/pipeline-conventions.md`](https://github.com/jjongs2/ticket-runner/blob/main/docs/agents/pipeline-conventions.md), [`docs/agents/triage-labels.md`](https://github.com/jjongs2/ticket-runner/blob/main/docs/agents/triage-labels.md), [`docs/templates/guard-comment.md`](https://github.com/jjongs2/ticket-runner/blob/main/docs/templates/guard-comment.md), [`CONTRIBUTING.md`](https://github.com/jjongs2/ticket-runner/blob/main/CONTRIBUTING.md)
- [ADR-0001](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0001-humans-plan-the-pipeline-executes.md), [ADR-0003](https://github.com/jjongs2/ticket-runner/blob/main/docs/adr/0003-github-native-relations-only.md)
