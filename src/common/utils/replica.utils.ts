/**
 * 단일 실행 작업(크론·스위퍼·전역 지표)을 이 레플리카에서 돌리는가 — `TASK_SLOT`이 정확히 1일 때만.
 *
 * 앱은 여러 레플리카로 뜨고 `TASK_SLOT`은 스택 YAML이 `{{.Task.Slot}}`으로 주입한다(core.md 멀티 레플리카).
 * 미설정·빈 값·숫자 아님은 false — 주입이 빠지면 아무도 안 돌 뿐 모든 레플리카 중복 실행은 없다
 * (docs/tasks/refactor-perf-b-2026-11 D-002). 판정 규칙을 한 곳에 둔다: 예전엔 `|| 1`(미설정=리더)과
 * `!== '1'`(미설정=아님)이 섞여 있었다.
 */
export function isLeaderReplica(taskSlot: unknown = process.env.TASK_SLOT): boolean {
  if (taskSlot === undefined || taskSlot === null) return false;
  return String(taskSlot).trim() === '1';
}
