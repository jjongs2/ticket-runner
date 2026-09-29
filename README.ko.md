# ticket-runner

[English](https://github.com/jjongs2/ticket-runner/blob/main/README.md)

`ticket-runner`는 [`mattpocock-skills`](https://github.com/mattpocock/skills) 체인에서 사람이 지켜보지
않아도 되는 절반을 맡습니다. 계획은 그 skill들로 사람이 세우고, `ticket-runner`는 준비된 Ticket을 아무도
지켜보지 않는 사이 merge된 pull request까지 가져갑니다.

## 하는 일

체인은 둘로 나뉩니다. **Planning**은 사람 몫입니다. `/grilling`, `/to-spec`, `/to-tickets`(또는
`/triage`)로 기능 하나를 작은 GitHub 이슈 여러 개로 나눕니다. 이슈마다 `ready-for-agent` 라벨과
Acceptance Criteria 체크리스트가 달리고, blocker가 연결됩니다. **Execution**은 파이프라인 몫입니다.
그런 이슈 가운데 blocker가 모두 닫힌 것마다 다음을 합니다.

1. 이슈를 맡고, 그 이슈의 branch와 git worktree를 만듭니다.
2. headless `claude -p` 세션을 띄워 `/implement`로 구현합니다.
3. 테스트와 typecheck를 직접 돌립니다.
4. 새 세션을 하나 더 띄워, Acceptance Criteria가 충족되지 *않았음*을 증명해 보게 합니다.
5. rebase하고, pull request를 열고, CI를 기다린 뒤 squash merge합니다.

한 번 실패하면 고치는 세션 한 번과 두 번째 검사를 받습니다. 그래도 끝내지 못한 일은 사람에게 돌아옵니다.
`ready-for-human` 라벨과 draft pull request, 무엇이 실패했는지 적은 코멘트가 함께 남습니다. 구독의
rate limit에 걸려 멈춘 세션은 아무것도 잃지 않습니다. 이슈는 보드로 돌아가고, 다음 Run이 멈춘 곳부터
이어 합니다.

## 나에게 맞을까?

이런 저장소에 맞습니다.

- `mattpocock-skills`로 계획합니다. `/setup-matt-pocock-skills`로 GitHub Issues를 tracker로 한 번
  설정해 두었고, Ticket 하나는 세션 하나로 끝낼 만큼 작습니다.
- pull request에서 도는 CI 워크플로가 있고, 파이프라인이 직접 돌릴 테스트나 typecheck 명령이 있습니다.
- 돌리는 머신에 Node 22 이상, `git`, 인증된 [`gh`](https://cli.github.com/), 그리고
  [`mattpocock-skills`](https://github.com/mattpocock/skills) 플러그인 1.2.3 버전을 설치한 `claude`가
  있습니다.

파이프라인은 묻지 않고 base branch에 merge합니다. 그걸 원하는 저장소에 쓰세요.

## 써 보기

파이프라인이 일할 저장소(**Target**)에서:

```bash
npx ticket-runner init   # Target을 준비하고, 아직 빠진 것을 알려 줍니다
npx ticket-runner run    # 준비된 이슈를 모두 처리합니다
```

`init`은 검토하고 commit할 파일 몇 개를 씁니다. `.gitignore` 줄, conventions 문서, `CLAUDE.md`의 한
섹션, Claude skill 하나입니다. 또 triage 라벨을 만들고, squash merge와 merge 시 branch 삭제를 켭니다.
commit은 하지 않습니다.

계속 쓰려면 전역으로 설치하세요.

```bash
npm install -g ticket-runner
```

| 명령 | 하는 일 |
|---|---|
| `ticket-runner init` | 이 저장소를 준비하고, 사람이 고쳐야 할 것을 알려 줍니다 |
| `ticket-runner run` | 준비된 이슈를 하나씩 모두 처리합니다 |
| `ticket-runner run 12 14` | 같은 일을 하되 #12와 #14만 맡습니다 |
| `ticket-runner run --lanes 2` | 이슈 두 개를 동시에 처리합니다 |
| `ticket-runner stop` | 진행 중인 Run에게 맡은 것만 끝내고 더 맡지 말라고 합니다 |
| `ticket-runner remove` | 이 저장소에서 파이프라인을 걷어 냅니다 |
| `ticket-runner -v` | Version을 출력합니다 |

Claude 앱에서도 Run을 시작할 수 있습니다. Target에서 Claude Code 클라우드 세션을 열고 "run it"이라고
말하면 됩니다.

## 다시 걷어 내기

```bash
ticket-runner remove           # Target에서: init이 쓴 것과 Run이 남긴 것
npm uninstall -g ticket-runner # 전역 설치
```

`remove`는 먼저 묻고(`--yes`를 주면 묻지 않습니다), commit은 하지 않습니다. 열린 pull request나 코멘트를
단 이슈처럼 일부러 남겨 둔 것은 보고에 적어 줍니다. `npx`는 캐시 말고는 아무것도 남기지 않습니다.

## 더 알아보기

[프로젝트 wiki](https://jjongs2.github.io/ticket-runner/ko/)에서 파이프라인을 자세히 설명합니다.

- [설치와 제거](https://jjongs2.github.io/ticket-runner/ko/guide/installation)
- [일 계획하기](https://jjongs2.github.io/ticket-runner/ko/guide/planning)
- [실행하기](https://jjongs2.github.io/ticket-runner/ko/guide/running)
- [설정](https://jjongs2.github.io/ticket-runner/ko/guide/configuration)
- [Ticket 하나가 merge되기까지](https://jjongs2.github.io/ticket-runner/ko/guide/ticket-to-merge)
- [멈추고 이어 하기](https://jjongs2.github.io/ticket-runner/ko/guide/stopping-and-resuming)
- [내부 구조](https://jjongs2.github.io/ticket-runner/ko/guide/internals)

용어는 [`CONTEXT.md`](https://github.com/jjongs2/ticket-runner/blob/main/CONTEXT.md)에, 설계 결정은
[`docs/adr/`](https://github.com/jjongs2/ticket-runner/tree/main/docs/adr)에, 파이프라인 자체를 고칠
때의 규칙은 [`CONTRIBUTING.md`](https://github.com/jjongs2/ticket-runner/blob/main/CONTRIBUTING.md)에
있습니다. 모두 영어입니다.
