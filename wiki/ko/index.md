---
layout: doc
title: ticket-runner
description: 계획은 사람이 GitHub에서 세우고, 각 Ticket을 merge까지 가져가는 일은 아무도 지켜보지 않는 사이 파이프라인이 합니다.
---

# ticket-runner

계획은 사람이, 실행은 파이프라인이.

기능을 계획하는 일에는 판단이 필요하니 사람 몫으로 남겨 둡니다. 사람은 GitHub에 이슈를 쓰고, 이슈마다 체크박스로 된 [Acceptance Criteria](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md)를 달고, 막는 이슈를 연결한 뒤 `ready-for-agent` 라벨을 붙입니다. 그다음부터 merge까지는 되풀이되는 일이라 파이프라인이 무인으로 처리합니다. [Ticket](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md)마다 헤드리스 Claude Code 세션에 구현을 맡기고, 저장소의 테스트를 직접 돌리고, 두 번째 세션에게 기준이 충족되지 않았음을 증명해 보라고 시킨 다음, pull request를 열고 CI를 기다려 squash-merge합니다. 끝내지 못한 일은 draft pull request와 코멘트를 남겨 사람에게 돌려줍니다.

## 왜 만들었나 {#why-it-exists}

계획이 끝나도 Ticket마다 사람이 붙어 있는 세션이 하나씩 필요합니다. 세션을 열고, Ticket을 붙여 넣고, 기다리고, 리뷰하고, commit하고, merge하고, 닫은 다음, 막힘이 풀린 다음 Ticket을 찾아 나서야 합니다. Ticket이 열 개면 세션도 열 개입니다. 게다가 Ticket을 닫아 주는 게 없으니 [Frontier](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md)(더는 아무것도 막지 않는 Ticket들)는 저절로 움직이지 않습니다. 파이프라인이 있으면 사람의 몫은 계획에서 끝납니다. 명령 하나로 Frontier를 비우고, merge된 코드를 남깁니다.

## 잘 맞는 경우와 맞지 않는 경우 {#when-it-fits-and-when-it-does-not}

이럴 때 잘 맞습니다.

- 계획을 거쳐 에이전트 한 번에 맡길 만한 크기의 Ticket이 나와 있고, 체크박스 기준과 네이티브 blocker가 달려 있을 때.
- 저장소에 CI가 있고, 파이프라인이 직접 돌릴 수 있는 테스트나 typecheck 명령이 있을 때.
- 자리를 비운 사이에 merge까지 끝나 있기를 바랄 때. 밤사이에 돌리거나, Claude 앱에서 시작하는 식입니다.

이럴 때는 맞지 않습니다.

- **중간에 사람의 판단이 필요한 일.** Run은 누구에게도 묻지 않습니다. 끝내지 못한 Ticket은 Hand-off가 되어서야 사람에게 갑니다.
- **체크박스로 채점할 수 없는 기준.** verify Stage는 `- [ ]` 줄만 채점하고, 기준이 모두 `unverifiable`인 Verdict는 실패로 칩니다. merge할 근거가 없다는 뜻이니까요.
- **사람의 리뷰 없이는 아무것도 merge되면 안 되는 저장소.** pull request는 CI를 통과하는 즉시 squash-merge되고, 그 전에 승인하는 사람은 없습니다.
- **CI도 테스트도 없는 저장소.** Check가 없으면 Run이 시작을 거절하고, CI check가 없는 pull request는 Hand-off합니다. [`gates`](./guide/configuration.md#gates)를 끄면 그렇게 하지 않는 대신, 검사받지 않은 코드를 merge합니다.

## 빠르게 시작하기 {#quick-start}

Node 22 이상, `git`, 인증된 [`gh`](https://cli.github.com/), 그리고 `mattpocock-skills` 플러그인 1.2.3 버전이 설치된 `claude`가 필요합니다. 전체 목록은 [설치](./guide/installation.md)에 있습니다.

```bash
npm install -g ticket-runner

cd ~/code/acme        # 파이프라인이 일할 저장소
ticket-runner init    # 준비해 두고, 사람이 고칠 것을 알려 줌
ticket-runner run     # 준비된 Ticket을 모두 merge까지
```

설치 없이 먼저 써 보려면, 이 문서에서 `ticket-runner`라고 쓴 자리에 `npx ticket-runner`를 입력하세요. [설치 없이 써 보기](./guide/installation.md#try-it-without-installing)에 자세히 있습니다.

`init`은 알려 준 항목 중 하나라도 아직 사람이 고칠 게 남아 있으면 `1`로 끝납니다. 그래서 `ticket-runner init && ticket-runner run`은 어차피 안 될 Run을 시작하기 전에 멈춥니다. Run은 [계획](./guide/planning.md)이 쓸 수 있게 만들어 둔 이슈만 가져갑니다. `ready-for-agent` 라벨이 있고, `- [ ]` 기준이 있고, GitHub 자체의 `blocked by` 연결로만 막혀 있는 이슈입니다.

## 전체 흐름 {#the-whole-flow}

```mermaid
flowchart LR
  subgraph Planning["계획 · 사람이 GitHub에서"]
    direction TB
    G["grilling, to-spec"] --> S[Spec]
    S --> T["to-tickets, triage"]
    T --> R["ready-for-agent 라벨이 붙은 Ticket"]
  end
  subgraph Execution["실행 · 파이프라인이 무인으로"]
    direction TB
    F[Frontier] --> C[Claim]
    C --> I[implement Stage]
    I --> K[Checks]
    K --> V[verify Stage]
    V --> L["Landing: rebase, pull request, CI"]
    L --> M[squash-merge]
    K -. 실패 .-> X["fix Stage, 한 번"]
    V -. 미충족 .-> X
    L -. CI 실패 .-> X
    X --> K
    X -. 또 실패 .-> H["Hand-off: ready-for-human"]
    I -. rate limit .-> RL["Release: ready-for-agent"]
  end
  R --> F
  M -. 막힘을 풂 .-> F
  H -. 사람이 라벨을 바꿈 .-> F
  RL -. 다음 Run .-> F
```
<!-- Sources: src/run.ts, src/orchestrator.ts, src/frontier.ts, src/guards.ts -->

rate limit은 implement만이 아니라 어느 Stage에서든 걸릴 수 있고, 어디서 걸리든 Release로 끝납니다. 실행 쪽 절반은 [Ticket 하나가 merge되기까지](./guide/ticket-to-merge.md)에서 한 단계씩 따라가 봅니다.

## 가이드 {#the-guide}

| 페이지 | 이런 걸 볼 때 |
|---|---|
| [설치와 제거](./guide/installation.md) | 요구 사항, npm 설치, `init`, Run이 Target에 요구하는 것, `remove`, 삭제 |
| [일 계획하기](./guide/planning.md) | 이슈를 Ticket으로 만드는 것: Spec, Acceptance Criteria, 네이티브 blocker, 라벨, Guard |
| [실행하기](./guide/running.md) | `run`, `--lanes`, 좁힌 Run, `stop`, `-v`, 요약과 종료 코드, 로그, Claude 앱에서 실행하기 |
| [설정](./guide/configuration.md) | `ticket-runner.json`의 모든 필드 |
| [Ticket 하나가 merge되기까지](./guide/ticket-to-merge.md) | Stage, Fix budget, Lane과 Landing, rebase 충돌, 보드에 남기는 것, Note |
| [멈추고 이어 하기](./guide/stopping-and-resuming.md) | Hand-off, Release, Stop과 kill, Stranded Ticket, Ticket 돌려주기, Run lock과 State branch |
| [내부 구조](./guide/internals.md) | 포트와 어댑터, 모듈 지도, Version, ADR 요약, 파이프라인 자체를 고치는 법 |

파이프라인이 쓰는 용어(Ticket, Run, Stage, Lane 등)는 [용어집](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md) 한곳에 정의되어 있습니다.
