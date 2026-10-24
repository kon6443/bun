# 모바일 테트리스 게임패드식 터치 컨트롤 설계 가이드 (P9, 2026-10-24)

> 메인 서브에이전트 웹 조사 요약. [추론]·[불확실] 표기는 출처로 확정하지 못한 값 — 실기기 플레이테스트로 조정한다.

## 근거 사실 (출처)
- 가이드라인 패드 매핑: ↑ 하드 드롭 · ↓ 소프트 드롭 · ←→ 이동 · 왼쪽 버튼 반시계 · 오른쪽 버튼 시계 — https://tetris.wiki/Tetris_Guideline
- 홀드·일시정지 위치는 가이드라인 규정 없음(관례상 어깨 버튼·Start)
- 패드 ↑ 하드 드롭 오조작은 알려진 문제(TETR.IO "Prevent Accidental Hard Drops") — https://github.com/tetrio/issues/issues/305
- Jedris 웹 패드: D-pad 한 영역 + 슬라이드로 방향 전환, **↑는 새로 눌렀을 때만 하드 드롭(슬라이드 진입은 무시)**, 터치를 키보드와 같은 down/up 입력으로 바꿔 DAS/ARR 재사용 — https://github.com/jedidiah5K/Jedris/pull/6
- 공식 모바일 앱은 제스처식으로 수렴했으나 속도로 소프트/하드를 가르는 오인식 불만이 가장 많음("accidentally hard drop", "misdrops and overotations", "add buttons") — https://tetris.wiki/Tetris_(N3TWORK) · https://appsupports.co/1491074310/tetris/negative-reviews
- Apple HIG Game controls: 자주 쓰는 컨트롤 최소 44×44pt, 이동은 왼쪽, 보조 컨트롤은 상단, safe area 준수, 눌림 피드백은 손가락에 가려져도 보이게(glow), 컨트롤러 이름보다 동작 아트 — https://developer.apple.com/design/human-interface-guidelines/game-controls
- Android 터치 타깃 최소 48×48dp — https://developer.android.com/guide/topics/ui/accessibility/apps
- SNES A·B 볼록/X·Y 오목은 촉감 구분 의도, GBA L/R은 잡기만 해도 눌리는 오조작 지적 — 형태로 역할 구분·주 엄지 경로 밖에 드문 입력
- 사람은 모서리보다 화면 중앙을 더 정확히 누른다(Hoober) — https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php

## 권장안 — "게임보이형"
```
│ [HOLD]  SCORE  [NEXT]          │
│        ┌─────────┐             │
│        │  보드   │             │ 화면 55~62%
│        └─────────┘             │
│              (⏸)        (HOLD) │ ← ⏸ 가운데 위 작은 알약 / HOLD 알약(A 위, 16px 이상 간격)
│     ┌───┐                (Ⓐ⟳) │ ← A = 시계(큰 원, 오른쪽 위)
│  ┌──┼ ⤓ ┼──┐                   │
│  │ ←│   │→ │         (Ⓑ⟲)      │ ← B = 반시계(왼쪽 아래, A-B 20~30° 기울기)
│  └──┼ ↓ ┼──┘                   │
│     └───┘                      │ ← 하단 16px + safe-area-inset-bottom
```
- 왼쪽 D-pad 한 영역·각도 판정(4방향, 대각 없음): ←→ 이동(DAS) · ↓ 소프트 드롭 · ↑ 하드 드롭(**새로 누를 때만**, 슬라이드 진입·이동 직후 80~120ms 무시)
- 오른쪽 A 시계 · B 반시계(가이드라인 패드 방향과 일치), HOLD는 모양이 다른 알약형, 일시정지는 엄지 경로 밖 가운데 위
- 대안("다이아몬드형"): ↑ 섹터를 끄고 오른쪽에 하드 드롭 전용 버튼 — 설정 "↑ 하드 드롭 끄기" 시 전환. 가로 화면은 보드 가운데·패드 좌우 여백

## 수치 (CSS px)
| 항목 | 권장 |
|---|---|
| 터치 타깃 최소 | 48×48 (보조 버튼은 시각 32~36, 히트 44 이상) |
| D-pad 전체 | 140~168 정사각, 팔 폭 ≥ 48·길이 ≥ 64, 데드존 반경 15~25% |
| D-pad 섹터 | ←→ ±55° 넓게, ↑ ±30° 좁게, 전환 히스테리시스 10~15° [추론] |
| A/B 지름 | 64~76 (최소 56), 중심 거리 지름의 1.2~1.35배, 기울기 20~30° [추론] |
| 간격 | 서로 다른 기능 ≥ 8 (가능하면 12~16), HOLD↔A ≥ 16 |
| 여백 | 하단 `calc(16px + env(safe-area-inset-bottom))`, 좌우 `max(16px, env(safe-area-inset-*))` |
| viewport | `width=device-width, initial-scale=1, viewport-fit=cover` (`user-scalable=no`는 iOS가 무시) |

## 입력 씹힘 방지 체크리스트
| # | 증상 | 대응 |
|---|---|---|
| 1 | 손가락이 버튼 밖으로 나가면 멈춤 | `pointerdown`에서 `setPointerCapture` |
| 2 | 눌린 채 고착 | `pointerup`·`pointercancel`·`lostpointercapture` 모두에서 해제 |
| 3 | 이동+회전 동시에 하나 씹힘 | `Map<pointerId, control>`로 포인터별 추적 |
| 4 | 손가락 여러 개면 전부 끊김 | 전체 cancel 처리 후 정상 재개 |
| 5 | 끌면 스크롤·바운스 후 멈춤 | 컨트롤에 `touch-action: none`, html/body `overscroll-behavior: none` |
| 6 | 연타 두 번째 씹힘·더블탭 확대 | `click` 대신 `pointerdown`, 페이지 `touch-action: manipulation` |
| 7 | 핀치 확대 | `touch-action: none` (+ iOS `gesturestart` 차단은 실기기 확인) |
| 8 | 길게 누르면 콜아웃·선택 | `-webkit-touch-callout: none`·`user-select: none`·`contextmenu` preventDefault·tap highlight 투명 |
| 9 | preventDefault 무시(passive) | CSS 우선, 필요 시 컨트롤에 `{ passive: false }` 네이티브 리스너 |
| 10 | 연타 누락·한 프레임 지연 | 입력은 ref 큐에 push, 루프가 매 틱 소비(React state 경유 금지) |
| 11 | 같은 프레임 press+release 소실 | 상태 폴링 대신 엣지 이벤트 큐(또는 래치) |
| 12 | 탭 전환 후 한쪽으로 계속 이동 | `visibilitychange`·`pagehide`·`blur`에서 전체 해제 + 일시정지 |
| 13 | 회전 후 고착·좌표 어긋남 | `resize`·`orientationchange`에서 전체 해제·좌표 재계산 |
| 14 | iPhone 진동 없음 | iOS Safari는 Vibration API 미지원 — 시각 피드백이 기본 |
| 15 | 하단 시스템 제스처 충돌 | safe area 위로 |
| 16 | 버튼 사이 틈 탭 무시 | 히트 영역 확장 또는 최근접 버튼 히트 테스트 |
| 17 | D-pad 경계에서 방향 깜빡임 | 데드존 + 히스테리시스 |
| 18 | 이동 중 하드 드롭 | ↑ 새로 누를 때만·이동 직후 무시 창·끄기 설정 |

QA 시나리오: ← 누른 채 A 10회 연타(회전 10·이동 유지) · ←→ 슬라이드 반전 시 하드 드롭 0회 · 누른 채 홈 갔다 복귀·화면 회전 시 고착 없음 · 다섯 손가락 후 정상 · 2초 길게 눌러도 콜아웃 없음 · 50ms 미만 탭도 회전

## 피해야 할 것
속도 판정 스와이프만 제공 · ↑ 슬라이드 진입 하드 드롭 · `click` 처리 · touch/mouse 혼용 · pointerup만 듣기 · React state로 매 입력 처리 · 모서리·하단 가장자리 배치 · 모든 버튼 같은 모양·크기 · HOLD/일시정지를 회전 버튼 바로 옆 · 시각 틈 = 입력 불가 · 진동을 유일한 피드백 · 8방향 판정 · 슬라이드로 다른 회전 버튼 발동
