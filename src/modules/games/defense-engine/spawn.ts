/**
 * 적 생성·경로 위치·킬 보상 (defense DESIGN §C2·§L4) — 웨이브 스폰·소환·분열·증식이 같은 함수를 쓴다
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import { EVENT, MAX_ENEMY_HP, PERMILLE, RAMP_REWARD_DECAY_PERMILLE, RESIST_CAP_PERMILLE } from './constants';
import { ENEMIES, type EnemyKind } from './data/enemies';
import type { MapPath } from './data/maps';
import type { Stage } from './data/stages';
import { lerpCoord } from './geometry';
import { ENEMY_STATUS, type Enemy, type GameState, enemyPath } from './state';

/** 킬 보상 감쇠 K(n)‰ — 램프 구간(무한·주간 31+)은 300‰ */
function rewardDecay(wave: number, rampFrom: number): number {
  if (rampFrom > 0 && wave > rampFrom) return RAMP_REWARD_DECAY_PERMILLE;
  if (wave <= 10) return 1000;
  if (wave <= 20) return 800;
  return 650;
}

/** 물리·마법 반반 방어 기준 EHP (저항 상한 적용) — 위협 가중치는 S1 생성기에서 확정 */
function effectiveHp(kind: EnemyKind, hp: number): number {
  const resist = Math.min(kind.resistPhy, RESIST_CAP_PERMILLE) + Math.min(kind.resistMag, RESIST_CAP_PERMILLE);
  return Math.floor((hp * 2 * PERMILLE) / (2 * PERMILLE - resist));
}

/** 킬 보상 = max(1, ⌊EHP × G × K(n) / 10⁶⌋) — 효과(현상금 등)는 사망 시 곱한다 */
export function killReward(kind: EnemyKind, hp: number, wave: number, rewardG: number, rampFrom = 0): number {
  return Math.max(1, Math.floor((effectiveHp(kind, hp) * rewardG * rewardDecay(wave, rampFrom)) / 1000000));
}

/** 현재 dist에 맞게 구간·좌표를 옮긴다 — 앞으로만 간다 */
export function placeOnPath(enemy: Enemy, path: MapPath): void {
  const lengths = path.segmentLengths;
  while (enemy.segment < lengths.length - 1 && enemy.dist - enemy.segmentStart >= lengths[enemy.segment]) {
    enemy.segmentStart += lengths[enemy.segment];
    enemy.segment += 1;
  }
  const len = lengths[enemy.segment];
  const d = Math.min(enemy.dist - enemy.segmentStart, len);
  const p = path.points;
  const i = enemy.segment * 2;
  enemy.x = lerpCoord(p[i], p[i + 2], d, len);
  enemy.y = lerpCoord(p[i + 1], p[i + 3], d, len);
}

export type SpawnSpec = {
  kind: number;
  hp: number;
  wave: number;
  path: number;
  /** 경로상 시작 거리 — 소환·분열은 부모 위치 */
  dist: number;
  derived: boolean;
  /** 킬 보상 기준 HP — 난이도 HP 배율 전(규칙 변형 배율은 반영). 없으면 hp */
  rewardHp?: number;
};

/** 적 1마리를 만들어 배열 끝(생성 순번 최대)에 넣는다. 웨이브 집계(total·pending)는 호출자가 맞춘다 */
export function createEnemy(state: GameState, stage: Stage, spec: SpawnSpec, events: number[] | null): Enemy {
  const kind = ENEMIES[spec.kind];
  const hp = Math.min(MAX_ENEMY_HP, Math.max(1, spec.hp));
  const rewardHp = Math.min(MAX_ENEMY_HP, Math.max(1, spec.rewardHp ?? hp));
  const path = enemyPath(stage, kind.air, spec.path);
  const enemy: Enemy = {
    // 매 틱 읽는 필드를 앞에 둔다(이동·상태효과·표적 루프의 메모리 접근 — 순서는 결과와 무관)
    id: state.nextId++,
    kind: spec.kind,
    status: ENEMY_STATUS.ALIVE,
    afflicted: false,
    stunTicks: 0,
    slow: 0,
    air: kind.air,
    path: spec.path,
    pathTotal: path.total,
    dist: Math.min(spec.dist, path.total),
    segment: 0,
    segmentStart: 0,
    x: 0,
    y: 0,
    hp,
    maxHp: hp,
    wave: spec.wave,
    // 난이도 HP 배율은 보상에 넣지 않는다(§L5 "적 HP + 타워 비용 두 축만") — 규칙 변형(R2 등)의 HP 배율은 보상에 그대로 반영
    rewardHp,
    reward: killReward(kind, rewardHp, spec.wave, stage.rewardG, stage.rampFrom),
    resistPhy: kind.resistPhy,
    resistMag: kind.resistMag,
    phase: 0,
    abilityTimer: kind.ability.every,
    derived: spec.derived,
    slowTicks: 0,
    stunWindowStart: 0,
    stunCount: 0,
    burnSources: [],
    burnDps: [],
    burnTicks: [],
    poisonStacks: 0,
    poisonTicks: 0,
    poisonDps: 0,
    plague: false,
    shred: 0,
    shredTicks: 0,
    vulnerable: 0,
    vulnerableTicks: 0,
    curseExplode: 0,
    curseTicks: 0,
    spawnTick: state.tick,
    shatterDamage: 0,
    shatterRadius: 0,
  };
  placeOnPath(enemy, path);
  state.enemies.push(enemy);
  state.aliveEnemies += 1;
  if (events) events.push(EVENT.SPAWN, enemy.id, enemy.kind, 0);
  return enemy;
}

/**
 * 소환·분열·증식으로 웨이브에 적을 더한다 — 살아 있는 적 상한이면 만들지 않는다. 만든 수를 돌려준다
 * 부모가 이미 출구(경로 끝)에 있으면 만들지 않는다 — 출구에 닿은 그 틱의 처치가 같은 틱 누수로 방치보다 목숨을 더 잃게 하지 않도록
 * (출구 직전 처치로 생긴 새끼가 다음 틱에 새는 것은 막지 않는다 — 밸런스 판단 대상)
 */
export function addDerivedEnemies(
  state: GameState,
  stage: Stage,
  spec: SpawnSpec,
  count: number,
  maxAlive: number,
  events: number[] | null,
): number {
  if (spec.dist >= enemyPath(stage, ENEMIES[spec.kind].air, spec.path).total) return 0;
  let made = 0;
  for (let i = 0; i < count && state.aliveEnemies < maxAlive; i++) {
    createEnemy(state, stage, spec, events);
    made++;
  }
  if (made > 0) {
    const wave = state.waves[spec.wave - 1];
    wave.total += made;
    wave.pending += made;
  }
  return made;
}
