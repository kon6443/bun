/**
 * 디펜스 게임 상태·틱 진행·명령 — 실시간 플레이·리플레이 검증·시뮬레이터가 같은 step·applyCommand를 쓴다(§E4)
 * 상태는 순수 데이터(일반 객체·배열)라 복제(스냅샷)할 수 있다. 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  DAMAGE,
  EVENT,
  MAX_ALIVE_ENEMIES,
  MAX_PROJECTILES,
  MAX_TICKS,
  OP,
  PERMILLE,
  RESIST_CAP_PERMILLE,
  RNG_PURPOSE,
  SELL_REFUND_PERMILLE,
  TARGET,
  TARGET_MODE_COUNT,
  WAVE_COUNTDOWN_TICKS,
} from './constants';
import { ENEMIES, type EnemyKind } from './data/enemies';
import type { MapPath } from './data/maps';
import { type Stage, findStage } from './data/stages';
import { TOWERS } from './data/towers';
import { clamp, distanceSquared, isqrt, lerpCoord } from './geometry';
import { fnv1a, streamSeed, toHex32 } from './random';

// ==================== 상태 ====================

export const ENEMY_STATUS = { ALIVE: 0, KILLED: 1, LEAKED: 2 } as const;
export const PROJECTILE_STATUS = { FLYING: 0, DONE: 1 } as const;

export type Enemy = {
  /** 생성 순번 (1부터, 모든 엔티티가 같은 카운터) */
  id: number;
  kind: number;
  hp: number;
  maxHp: number;
  /** 지상 경로 인덱스 */
  path: number;
  /** 경로를 따라 간 거리 (밀리타일) */
  dist: number;
  /** 현재 구간과 그 구간 시작 거리 — 앞으로만 간다 */
  segment: number;
  segmentStart: number;
  x: number;
  y: number;
  /** 웨이브 번호 (1부터) */
  wave: number;
  reward: number;
  status: number;
};

export type Tower = {
  id: number;
  slot: number;
  kind: number;
  /** 1부터 */
  level: number;
  /** 0 = 분기 전, 1·2 = Lv4 분기 */
  branch: number;
  targetMode: number;
  /** 다음 발사까지 남은 틱 (0 = 준비됨) */
  cooldown: number;
  /** 마지막으로 겨눈 적 id (0 = 없음) — 렌더러 포신 방향 */
  targetId: number;
  /** 지은 시점까지 시작한 웨이브 수 — 판매 100% 판정 (§L4) */
  builtInWave: number;
  /** 준비 단계(1웨이브 전·적이 없는 카운트다운 중)에 지었는지 — 적과 싸우는 중 지은 타워는 100% 환급 대상이 아니다 */
  builtInPrep: boolean;
  /** 건설·업그레이드에 쓴 골드 합 */
  invested: number;
  x: number;
  y: number;
};

export type Projectile = {
  id: number;
  towerId: number;
  targetId: number;
  damage: number;
  damageType: number;
  element: number;
  originX: number;
  originY: number;
  /** 표적의 마지막 위치 — 표적이 죽으면 여기서 사라진다 */
  aimX: number;
  aimY: number;
  ticksLeft: number;
  totalTicks: number;
  /** PROJECTILE_STATUS */
  status: number;
  /** 표적의 적 배열 인덱스 추정값 — 조회 캐시일 뿐 결과·해시에 쓰지 않는다 */
  targetHint: number;
};

export type Spawner = {
  /** 웨이브 번호 (1부터) */
  wave: number;
  group: number;
  remaining: number;
  /** 다음 스폰까지 남은 틱 */
  next: number;
};

export type WaveProgress = {
  total: number;
  /** 아직 스폰 안 됐거나 살아 있는 수 — 0이 되면 클리어 */
  pending: number;
  kills: number;
  cleared: boolean;
};

export type GameState = {
  stageId: string;
  seed: number;
  /** 처리한 틱 수 */
  tick: number;
  gold: number;
  lives: number;
  /** 킬 보상·클리어 보너스·조기 호출 보너스 합 (시작 골드·판매 환급 제외) */
  goldEarned: number;
  kills: number;
  wavesStarted: number;
  wavesCleared: number;
  /** 다음 웨이브 자동 시작까지 남은 틱 (0 = 카운트다운 아님) */
  countdown: number;
  nextId: number;
  rngWave: number;
  rngAugment: number;
  rngCombat: number;
  aliveEnemies: number;
  enemies: Enemy[];
  towers: Tower[];
  projectiles: Projectile[];
  spawners: Spawner[];
  /** 인덱스 = 웨이브 번호 − 1 */
  waves: WaveProgress[];
  /** 증강 선택 대기 — 이 동안 틱이 진행되지 않고 PICK_AUGMENT만 받는다 (E1 데이터에선 항상 false) */
  augmentPending: boolean;
  over: boolean;
  victory: boolean;
  endTick: number;
};

export function createGame(stage: Stage, seed: number): GameState {
  return {
    stageId: stage.id,
    seed,
    tick: 0,
    gold: stage.startGold,
    lives: stage.lives,
    goldEarned: 0,
    kills: 0,
    wavesStarted: 0,
    wavesCleared: 0,
    countdown: 0,
    nextId: 1,
    rngWave: streamSeed(seed, RNG_PURPOSE.WAVE),
    rngAugment: streamSeed(seed, RNG_PURPOSE.AUGMENT),
    rngCombat: streamSeed(seed, RNG_PURPOSE.COMBAT),
    aliveEnemies: 0,
    enemies: [],
    towers: [],
    projectiles: [],
    spawners: [],
    waves: stage.waves.map((wave) => {
      let total = 0;
      for (const group of wave.groups) total += group.count;
      return { total, pending: total, kills: 0, cleared: false };
    }),
    augmentPending: false,
    over: false,
    victory: false,
    endTick: 0,
  };
}

function stageOf(state: GameState): Stage {
  const stage = findStage(state.stageId);
  if (!stage) throw new Error(`알 수 없는 스테이지: ${state.stageId}`);
  return stage;
}

// ==================== 경제 (§L4) ====================

/** 웨이브 n 클리어 보너스 = 2 × (10 + n) */
export function waveClearBonus(wave: number): number {
  return 2 * (10 + wave);
}

/** 킬 보상 감쇠 K(n)‰ */
function rewardDecay(wave: number): number {
  if (wave <= 10) return 1000;
  if (wave <= 20) return 800;
  return 650;
}

/** 물리·마법 반반 방어 기준 EHP (저항 상한 적용) — 위협 가중치는 S1 생성기에서 확정 */
function effectiveHp(kind: EnemyKind, hp: number): number {
  const resist = Math.min(kind.resistPhy, RESIST_CAP_PERMILLE) + Math.min(kind.resistMag, RESIST_CAP_PERMILLE);
  return Math.floor((hp * 2 * PERMILLE) / (2 * PERMILLE - resist));
}

/** 킬 보상 = max(1, ⌊EHP × G × K(n) / 10⁶⌋) */
function killReward(kind: EnemyKind, hp: number, wave: number, rewardG: number): number {
  return Math.max(1, Math.floor((effectiveHp(kind, hp) * rewardG * rewardDecay(wave)) / 1000000));
}

/** 카운트다운 중 다음 웨이브를 지금 부르면 받는 보너스 — ⌊남은 틱 × 그 웨이브 클리어 보너스 / 카운트다운 틱⌋ (UI 표시용으로도 쓴다) */
export function earlyCallBonus(state: GameState): number {
  if (state.countdown <= 0) return 0;
  return Math.floor((state.countdown * waveClearBonus(state.wavesStarted + 1)) / WAVE_COUNTDOWN_TICKS);
}

function towerAtSlot(state: GameState, slot: number): Tower | null {
  for (const tower of state.towers) if (tower.slot === slot) return tower;
  return null;
}

/** 준비 단계 = 1웨이브 전, 또는 웨이브 사이 카운트다운 중이고 남은 적이 없을 때 (§L4 — 싸우는 중 지은 타워는 아니다) */
function inPrepPhase(state: GameState): boolean {
  return state.wavesStarted === 0 || (state.countdown > 0 && state.aliveEnemies === 0);
}

/**
 * 지금 팔면 돌려받는 골드 — 준비 단계에 지었고 그 뒤 다음 웨이브가 시작되지 않았으면 100%, 아니면 70% 내림. 타워가 없으면 0
 * (웨이브 전투 중에 지은 타워는 그 웨이브가 끝나 카운트다운이 돼도 70%)
 */
export function sellRefund(state: GameState, slot: number): number {
  const tower = towerAtSlot(state, slot);
  if (!tower) return 0;
  if (tower.builtInPrep && tower.builtInWave === state.wavesStarted) return tower.invested;
  return Math.floor((tower.invested * SELL_REFUND_PERMILLE) / PERMILLE);
}

/** 다음 레벨 업그레이드 비용 — 불가(상한·분기 필요)면 0 */
export function upgradeCost(state: GameState, slot: number): number {
  const tower = towerAtSlot(state, slot);
  if (!tower) return 0;
  const stage = stageOf(state);
  const levels = TOWERS[tower.kind].levels;
  if (tower.level >= stage.maxLevel || tower.level >= levels.length || tower.level === 3) return 0;
  return levels[tower.level].cost;
}

// ==================== 명령 (§E3) ====================

function startWave(state: GameState, stage: Stage, events: number[] | null): void {
  const wave = state.wavesStarted + 1;
  const groups = stage.waves[wave - 1].groups;
  for (let g = 0; g < groups.length; g++) {
    state.spawners.push({ wave, group: g, remaining: groups[g].count, next: groups[g].delayTicks });
  }
  state.wavesStarted = wave;
  state.countdown = 0;
  if (events) events.push(EVENT.WAVE_START, wave, 0, 0);
}

/**
 * 틱 경계에서 명령 하나를 적용한다 — 수락하면 true(호출자는 이때만 기록한다), 수행할 수 없으면 false
 * 일시정지 중에도 부를 수 있다. 증강 대기 중에는 PICK_AUGMENT만 받는다
 */
export function applyCommand(state: GameState, op: number, a = 0, b = 0, events: number[] | null = null): boolean {
  if (state.over) return false;
  if (state.augmentPending) return false; // E1: 증강 데이터 없음 — PICK_AUGMENT도 여기서 거부된다
  const stage = stageOf(state);

  switch (op) {
    case OP.CALL_WAVE: {
      // 1웨이브 시작 또는 카운트다운 중 조기 호출
      if (state.wavesStarted >= stage.waves.length) return false;
      if (state.wavesStarted > 0 && state.countdown <= 0) return false;
      const bonus = earlyCallBonus(state);
      state.gold += bonus;
      state.goldEarned += bonus;
      startWave(state, stage, events);
      return true;
    }
    case OP.BUILD: {
      const slot = stage.map.slots[a];
      if (!slot || towerAtSlot(state, a) || stage.towers.indexOf(b) < 0 || !TOWERS[b]) return false;
      const cost = TOWERS[b].levels[0].cost;
      if (state.gold < cost) return false;
      state.gold -= cost;
      state.towers.push({
        id: state.nextId++,
        slot: a,
        kind: b,
        level: 1,
        branch: 0,
        targetMode: TARGET.FIRST,
        cooldown: 0,
        targetId: 0,
        builtInWave: state.wavesStarted,
        builtInPrep: inPrepPhase(state),
        invested: cost,
        x: slot.x,
        y: slot.y,
      });
      return true;
    }
    case OP.UPGRADE: {
      const tower = towerAtSlot(state, a);
      const cost = upgradeCost(state, a);
      if (!tower || cost === 0 || state.gold < cost) return false;
      state.gold -= cost;
      tower.invested += cost;
      tower.level += 1;
      return true;
    }
    case OP.BRANCH:
      return false; // E1: 분기 데이터 없음 (E2)
    case OP.SELL: {
      const tower = towerAtSlot(state, a);
      if (!tower) return false;
      state.gold += sellRefund(state, a);
      state.towers.splice(state.towers.indexOf(tower), 1);
      return true;
    }
    case OP.SET_TARGET: {
      const tower = towerAtSlot(state, a);
      if (!tower || b < 0 || b >= TARGET_MODE_COUNT) return false;
      tower.targetMode = b;
      return true;
    }
    case OP.PICK_AUGMENT:
      return false; // 증강 대기 중이 아니다
    default:
      return false;
  }
}

// ==================== 틱 진행 (§E2 — 순서를 바꾸면 버전 상승) ====================

/** 사망 처리 순서(피해 적용 순서) — step 안에서만 쓰는 작업 목록 */
const deathOrder: Enemy[] = [];

function placeOnPath(enemy: Enemy, path: MapPath): void {
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

function spawnEnemy(state: GameState, stage: Stage, spawner: Spawner, events: number[] | null): void {
  const group = stage.waves[spawner.wave - 1].groups[spawner.group];
  const kind = ENEMIES[group.enemyId];
  const enemy: Enemy = {
    id: state.nextId++,
    kind: group.enemyId,
    hp: group.hp,
    maxHp: group.hp,
    path: group.path,
    dist: 0,
    segment: 0,
    segmentStart: 0,
    x: 0,
    y: 0,
    wave: spawner.wave,
    reward: killReward(kind, group.hp, spawner.wave, stage.rewardG),
    status: ENEMY_STATUS.ALIVE,
  };
  placeOnPath(enemy, stage.map.groundPaths[group.path]);
  state.enemies.push(enemy);
  state.aliveEnemies += 1;
  if (events) events.push(EVENT.SPAWN, enemy.id, enemy.kind, 0);
}

/** §C1 피해식 — 상성 행렬은 1차 항등(1000‰), 파쇄·취약은 E2 상태효과에서 */
function computeDamage(base: number, damageType: number, kind: EnemyKind): number {
  const resist = damageType === DAMAGE.PURE ? 0 : damageType === DAMAGE.PHY ? kind.resistPhy : kind.resistMag;
  const r = clamp(resist, 0, RESIST_CAP_PERMILLE);
  const reduced = Math.floor((base * (PERMILLE - r)) / PERMILLE);
  return Math.max(1, reduced);
}

/** 적 배열은 id 오름차순 — 힌트 인덱스가 맞으면 바로, 아니면 전체 이분 탐색 후 힌트를 고친다(힌트는 결과에 영향 없음) */
function findTarget(state: GameState, projectile: Projectile): Enemy | null {
  const list = state.enemies;
  const id = projectile.targetId;
  const hinted = list[projectile.targetHint];
  if (hinted && hinted.id === id) return hinted;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const value = list[mid].id;
    if (value === id) {
      projectile.targetHint = mid;
      return list[mid];
    }
    if (value < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/** 사거리 안 표적의 적 배열 인덱스(없으면 −1) — §C2 동률: 경로 진행 거리 큰 순 → 생성 순번 작은 순 */
function selectTarget(state: GameState, tower: Tower, range: number, hitsGround: boolean, hitsAir: boolean): number {
  const rangeSq = range * range;
  const enemies = state.enemies;
  let best: Enemy | null = null;
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (enemy.status !== ENEMY_STATUS.ALIVE) continue;
    const air = ENEMIES[enemy.kind].air;
    if (air ? !hitsAir : !hitsGround) continue;
    const d2 = distanceSquared(tower.x, tower.y, enemy.x, enemy.y);
    if (d2 > rangeSq) continue;
    // 점수가 클수록 좋다 — 후미·최근접은 부호를 뒤집는다(음수 비교만, 나눗셈 없음)
    let score: number;
    if (tower.targetMode === TARGET.LAST) score = -enemy.dist;
    else if (tower.targetMode === TARGET.STRONGEST) score = enemy.hp;
    else if (tower.targetMode === TARGET.NEAREST) score = -d2;
    else score = enemy.dist;
    if (!best || score > bestScore || (score === bestScore && enemy.dist > best.dist)) {
      best = enemy;
      bestIndex = i;
      bestScore = score;
    }
  }
  return bestIndex;
}

function damageEnemy(enemy: Enemy, damage: number): void {
  enemy.hp -= damage;
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    enemy.status = ENEMY_STATUS.KILLED;
    deathOrder.push(enemy);
  }
}

/** 틱 끝 정리 — status 0(ENEMY_STATUS.ALIVE·PROJECTILE_STATUS.FLYING)만 순서대로 남긴다(배열 재할당 없이) */
function compactByStatus(list: { status: number }[]): void {
  let write = 0;
  for (let read = 0; read < list.length; read++) {
    const item = list[read];
    if (item.status === 0) list[write++] = item;
  }
  list.length = write;
}

/**
 * 1틱 진행 (§E2 1~10단계). events를 넘기면 렌더용 이벤트를 [종류, a, b, c]로 덧붙인다(호출자가 비우고 재사용)
 * 1단계(명령 적용)는 호출자가 step 전에 applyCommand로 한다
 */
export function step(state: GameState, events: number[] | null = null): void {
  if (state.over || state.augmentPending) return;
  const stage = stageOf(state);
  deathOrder.length = 0;

  // 2. 웨이브 카운트다운·스폰 (그룹 정의 순 → 그룹 내 순번)
  if (state.countdown > 0) {
    state.countdown -= 1;
    if (state.countdown === 0) startWave(state, stage, events);
  }
  // 지연 d틱이면 웨이브 시작 d틱 뒤, 이후 간격 n틱마다 — 상한에 걸리면 next 0을 유지해 다음 틱에 다시
  for (const spawner of state.spawners) {
    if (spawner.next === 0 && spawner.remaining > 0 && state.aliveEnemies < MAX_ALIVE_ENEMIES) {
      spawnEnemy(state, stage, spawner, events);
      spawner.remaining -= 1;
      spawner.next = stage.waves[spawner.wave - 1].groups[spawner.group].intervalTicks;
    }
    if (spawner.next > 0) spawner.next -= 1;
  }
  if (state.spawners.length > 0) {
    let write = 0;
    for (const spawner of state.spawners) if (spawner.remaining > 0) state.spawners[write++] = spawner;
    state.spawners.length = write;
  }
  if (state.countdown === 0 && state.wavesStarted > 0 && state.wavesStarted < stage.waves.length && state.spawners.length === 0) {
    state.countdown = WAVE_COUNTDOWN_TICKS;
  }

  // 3. 상태효과 — E2

  // 4. 적 이동 (생성 순번 오름차순)
  let reachedEnd = false;
  const groundPaths = stage.map.groundPaths;
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (enemy.status !== ENEMY_STATUS.ALIVE) continue;
    const path = groundPaths[enemy.path];
    const dist = Math.min(enemy.dist + ENEMIES[enemy.kind].speed, path.total);
    enemy.dist = dist;
    placeOnPath(enemy, path);
    if (dist >= path.total) reachedEnd = true;
  }

  // 5. 적 능력 — E2

  // 6. 타워: 쿨다운 → 표적 → 발사 (생성 순번 오름차순)
  // 틱 끝 정리 뒤라 배열에는 날아가는 투사체만 있다(명령은 투사체를 만들지 않는다)
  let projectileCount = state.projectiles.length;
  let firedThisTick = 0;
  for (const tower of state.towers) {
    if (tower.cooldown > 0) tower.cooldown -= 1;
    if (tower.cooldown > 0) continue;
    // 발사 보류 — 쏠 수 없으니 표적도 다시 고르지 않는다(포신은 직전 표적 그대로), 다음 틱에 다시
    if (projectileCount >= MAX_PROJECTILES) continue;
    const kind = TOWERS[tower.kind];
    const level = kind.levels[tower.level - 1];
    const targetIndex = selectTarget(state, tower, level.range, kind.hitsGround, kind.hitsAir);
    if (targetIndex < 0) {
      tower.targetId = 0;
      continue;
    }
    const target = state.enemies[targetIndex];
    tower.targetId = target.id;
    const distance = isqrt(distanceSquared(tower.x, tower.y, target.x, target.y));
    const flight = Math.max(1, Math.floor((distance + kind.projectileSpeed - 1) / kind.projectileSpeed));
    const projectile: Projectile = {
      id: state.nextId++,
      towerId: tower.id,
      targetId: target.id,
      damage: level.damage,
      damageType: kind.damageType,
      element: kind.element,
      originX: tower.x,
      originY: tower.y,
      aimX: target.x,
      aimY: target.y,
      ticksLeft: flight,
      totalTicks: flight,
      status: PROJECTILE_STATUS.FLYING,
      targetHint: targetIndex,
    };
    state.projectiles.push(projectile);
    projectileCount += 1;
    firedThisTick += 1;
    tower.cooldown = level.periodTicks;
    if (events) events.push(EVENT.FIRE, tower.id, projectile.id, target.id);
  }

  // 7. 투사체 이동·명중 (생성 순번 오름차순) — 유도형: 비행 시간만 있다. 표적이 먼저 죽으면 단일 공격은 사라진다
  // 이번 틱 6단계에서 쏜 투사체는 다음 틱부터 난다 — 비행 N틱이면 발사 N틱 뒤 명중
  let finishedProjectiles = false;
  const flying = state.projectiles.length - firedThisTick;
  for (let i = 0; i < flying; i++) {
    const projectile = state.projectiles[i];
    if (projectile.status !== PROJECTILE_STATUS.FLYING) continue;
    const target = findTarget(state, projectile);
    const targetAlive = target !== null && target.status === ENEMY_STATUS.ALIVE;
    if (target && targetAlive) {
      projectile.aimX = target.x;
      projectile.aimY = target.y;
    }
    projectile.ticksLeft -= 1;
    if (projectile.ticksLeft > 0 && targetAlive) continue;
    projectile.status = PROJECTILE_STATUS.DONE;
    finishedProjectiles = true;
    if (target && targetAlive) {
      const damage = computeDamage(projectile.damage, projectile.damageType, ENEMIES[target.kind]);
      damageEnemy(target, damage);
      if (events) events.push(EVENT.HIT, target.id, damage, projectile.id);
    }
  }

  // 8. 사망 처리 (피해 적용 순서): 보상 → 사망 효과(E2)
  let removedEnemies = deathOrder.length > 0;
  for (const enemy of deathOrder) {
    state.gold += enemy.reward;
    state.goldEarned += enemy.reward;
    state.kills += 1;
    state.aliveEnemies -= 1;
    const wave = state.waves[enemy.wave - 1];
    wave.kills += 1;
    wave.pending -= 1;
    if (events) events.push(EVENT.DEATH, enemy.id, enemy.x, enemy.y);
  }
  deathOrder.length = 0;

  // 9. 누수: 경로 끝에 닿은 적 — 목숨 감소 (이번 틱에 끝에 닿은 적이 없으면 건너뛴다)
  for (let i = 0; reachedEnd && i < state.enemies.length; i++) {
    const enemy = state.enemies[i];
    if (enemy.status !== ENEMY_STATUS.ALIVE) continue;
    if (enemy.dist < stage.map.groundPaths[enemy.path].total) continue;
    const lost = ENEMIES[enemy.kind].leakLives;
    enemy.status = ENEMY_STATUS.LEAKED;
    state.lives = Math.max(0, state.lives - lost);
    state.aliveEnemies -= 1;
    state.waves[enemy.wave - 1].pending -= 1;
    removedEnemies = true;
    if (events) events.push(EVENT.LEAK, enemy.id, lost, 0);
  }

  // 10. 웨이브 종료 → 클리어 보너스 → 증강 제시(E2) → 게임 오버
  for (let i = 0; i < state.wavesStarted; i++) {
    const wave = state.waves[i];
    if (wave.cleared || wave.pending > 0) continue;
    wave.cleared = true;
    state.wavesCleared += 1;
    const bonus = waveClearBonus(i + 1);
    state.gold += bonus;
    state.goldEarned += bonus;
    if (events) events.push(EVENT.WAVE_CLEAR, i + 1, bonus, 0);
  }

  state.tick += 1;
  if (removedEnemies) compactByStatus(state.enemies);
  if (finishedProjectiles) compactByStatus(state.projectiles);

  if (state.lives <= 0) {
    state.over = true;
  } else if (state.wavesCleared === stage.waves.length) {
    state.over = true;
    state.victory = true;
  } else if (state.tick >= MAX_TICKS) {
    state.over = true; // 판 상한 — 그 시점 점수로 끝
  }
  if (state.over) state.endTick = state.tick;
}

// ==================== 결과 ====================

/** 점수 = 클리어 웨이브 × 10⁶ + 다음(첫 미클리어) 웨이브 처치 진척‰ × 10³ (§L6) */
export function scoreOf(state: GameState): { score: number; wave: number; progress: number } {
  let progress = 0;
  for (let i = 0; i < state.wavesStarted; i++) {
    const wave = state.waves[i];
    if (wave.cleared || wave.total === 0) continue;
    progress = Math.floor((wave.kills * PERMILLE) / wave.total);
    break;
  }
  return { score: state.wavesCleared * 1000000 + progress * 1000, wave: state.wavesCleared, progress };
}

/** 최종 상태 FNV-1a 32비트 hex — 골든 비교용 (저장하지 않는다) */
export function getStateHash(state: GameState): string {
  const values: number[] = [
    state.seed,
    state.tick,
    state.gold,
    state.lives,
    state.goldEarned,
    state.kills,
    state.wavesStarted,
    state.wavesCleared,
    state.countdown,
    state.nextId,
    state.rngWave,
    state.rngAugment,
    state.rngCombat,
    state.aliveEnemies,
    state.augmentPending ? 1 : 0,
    state.over ? 1 : 0,
    state.victory ? 1 : 0,
    state.endTick,
  ];
  for (const e of state.enemies) values.push(e.id, e.kind, e.hp, e.maxHp, e.path, e.dist, e.wave, e.reward, e.status);
  for (const t of state.towers) {
    values.push(t.id, t.slot, t.kind, t.level, t.branch, t.targetMode, t.cooldown, t.targetId, t.builtInWave, t.builtInPrep ? 1 : 0, t.invested);
  }
  for (const p of state.projectiles) {
    values.push(p.id, p.towerId, p.targetId, p.damage, p.damageType, p.element, p.ticksLeft, p.totalTicks, p.aimX, p.aimY);
  }
  for (const s of state.spawners) values.push(s.wave, s.group, s.remaining, s.next);
  for (const w of state.waves) values.push(w.total, w.pending, w.kills, w.cleared ? 1 : 0);
  return toHex32(fnv1a(values));
}
