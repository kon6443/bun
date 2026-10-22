/**
 * 디펜스 틱 진행·명령·경제 — 실시간 플레이·리플레이 검증·시뮬레이터가 같은 step·applyCommand를 쓴다(§E4)
 * 상태 정의·생성은 state.ts, 전투는 combat.ts. 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  EVENT,
  FLAG,
  MAX_ALIVE_ENEMIES,
  MAX_TICKS,
  OP,
  PERMILLE,
  SELL_REFUND_PERMILLE,
  STAT,
  TARGET,
  TARGET_MODE_COUNT,
  WAVE_COUNTDOWN_TICKS,
} from './constants';
import { offerAugments, pickAugment } from './augment';
import { processDeaths, runAbilities, runProjectiles, runTowers, ultimatePeriod, updateAndMoveEnemies } from './combat';
import { ENEMIES } from './data/enemies';
import type { Stage } from './data/stages';
import { TOWER_ID, TOWERS, towerStage } from './data/towers';
import { hasFlag, statValue } from './effects';
import { fnv1a, toHex32 } from './random';
import { createEnemy } from './spawn';
import {
  ENEMY_STATUS,
  type Enemy,
  type GameState,
  type Spawner,
  economyStat,
  enemySubject,
  maxLevel,
  slotAvailable,
  stageOf,
  towerAllowed,
  towerAtSlot,
  towerSubject,
  groupSpawnCount,
} from './state';

export {
  ENEMY_STATUS,
  PROJECTILE_STATUS,
  ZONE_KIND,
  createGame,
  type Enemy,
  type GameState,
  type Projectile,
  type Spawner,
  type Tower,
  type WaveProgress,
  type Zone,
} from './state';

// ==================== 경제 (§L4) ====================

/** 웨이브 n 클리어 보너스 기본값 = 2 × (10 + n) — 효과(전리품·보상 없음)는 지급 시 */
export function waveClearBonus(wave: number): number {
  return 2 * (10 + wave);
}

/**
 * 카운트다운 중 다음 웨이브를 지금 부르면 받는 보너스 (UI 표시용으로도 쓴다)
 * ⌊남은 틱 × 그 웨이브 기본 클리어 보너스 / 이번 카운트다운 길이⌋ × 조기 호출 효과(서두름 R11·시간 압박)
 */
export function earlyCallBonus(state: GameState): number {
  if (state.countdown <= 0 || state.countdownTotal <= 0) return 0;
  const base = Math.floor((state.countdown * waveClearBonus(state.wavesStarted + 1)) / state.countdownTotal);
  return economyStat(state, STAT.EARLY_CALL_BONUS, base);
}

/** 준비 단계 = 1웨이브 전, 또는 웨이브 사이 카운트다운 중이고 남은 적이 없을 때 (§L4 — 싸우는 중 지은 타워는 아니다) */
function inPrepPhase(state: GameState): boolean {
  return state.wavesStarted === 0 || (state.countdown > 0 && state.aliveEnemies === 0);
}

/**
 * 지금 팔면 돌려받는 골드 — 준비 단계에 지었고 그 뒤 다음 웨이브가 시작되지 않았으면 100%, 아니면 판매 환급 효과(기본 700‰, 재활용 1000‰) 내림
 * 타워가 없거나 판매 불가(R8)면 0
 */
export function sellRefund(state: GameState, slot: number): number {
  const tower = towerAtSlot(state, slot);
  if (!tower || hasFlag(state.effects, FLAG.NO_SELL)) return 0;
  if (tower.builtInPrep && tower.builtInWave === state.wavesStarted) return tower.invested;
  const refund = economyStat(state, STAT.SELL_REFUND, SELL_REFUND_PERMILLE);
  return Math.floor((tower.invested * Math.min(PERMILLE, refund)) / PERMILLE);
}

/** 타워 단계 비용 (효과: 할인 계약) */
function stageCost(state: GameState, kind: number, level: number, branch: number): number {
  const stage = towerStage(TOWERS[kind], level, branch);
  return statValue(state.effects, towerSubject(kind, stage.element), STAT.COST, stage.cost);
}

export function buildCost(state: GameState, kind: number): number {
  return TOWERS[kind] ? stageCost(state, kind, 1, 0) : 0;
}

/** 다음 레벨 업그레이드 비용 — Lv1→2→3·Lv4→5. 불가(상한·분기 필요)면 0 */
export function upgradeCost(state: GameState, slot: number): number {
  const tower = towerAtSlot(state, slot);
  if (!tower || tower.level === 3 || tower.level >= 5 || tower.level >= maxLevel(state, stageOf(state))) return 0;
  return stageCost(state, tower.kind, tower.level + 1, tower.branch);
}

/** Lv3 → Lv4 분기(0·1) 비용 — 불가면 0 */
export function branchCost(state: GameState, slot: number, branch: number): number {
  const tower = towerAtSlot(state, slot);
  if (!tower || tower.level !== 3 || branch < 0 || branch > 1 || maxLevel(state, stageOf(state)) < 4) return 0;
  return stageCost(state, tower.kind, 4, branch + 1);
}

// ==================== 명령 (§E3) ====================

function startWave(state: GameState, stage: Stage, events: number[] | null): void {
  const wave = state.wavesStarted + 1;
  const groups = stage.waves[wave - 1].groups;
  // 웨이브 총수에 시작 시점 효과로 정한 스폰 수를 더한다 — 판 도중 붙은 그룹 수 효과도 스폰 수와 총수가 같다(웨이브마다 1회)
  let total = 0;
  for (let g = 0; g < groups.length; g++) {
    const remaining = groupSpawnCount(state, groups[g].count);
    total += remaining * ENEMIES[groups[g].enemyId].swarm;
    state.spawners.push({ wave, group: g, remaining, next: groups[g].delayTicks });
  }
  const progress = state.waves[wave - 1];
  progress.total += total;
  progress.pending += total;
  state.wavesStarted = wave;
  state.countdown = 0;
  state.countdownTotal = 0;
  if (events) events.push(EVENT.WAVE_START, wave, 0, 0);
}

/**
 * 레벨이 오른 뒤 — 주기가 길어졌으면 그 차이만큼 쿨다운을 늘린다(건설 직후 업그레이드로 건설 지연을 줄이지 못하게),
 * Lv5 궁극 타이머, 저격수 → 헤드샷은 최강 우선
 */
function onLevelUp(tower: GameState['towers'][number], previousPeriod: number): void {
  const period = towerStage(TOWERS[tower.kind], tower.level, tower.branch).periodTicks;
  if (period > previousPeriod) tower.cooldown += period - previousPeriod;
  tower.ultTimer = ultimatePeriod(tower.kind, tower.level, tower.branch);
  if (tower.kind === TOWER_ID.ARCHER && tower.level === 5 && tower.branch === 1) tower.targetMode = TARGET.STRONGEST;
}

/** 대기 중인 증강 제시를 차례로 연다 (뽑을 카드가 없으면 건너뛴다) */
function openQueuedOffer(state: GameState, stage: Stage): void {
  while (state.augmentQueue > 0 && !state.augmentPending) {
    state.augmentQueue -= 1;
    offerAugments(state, stage);
  }
}

/**
 * 틱 경계에서 명령 하나를 적용한다 — 수락하면 true(호출자는 이때만 기록한다), 수행할 수 없으면 false
 * 일시정지 중에도 부를 수 있다. 증강 대기 중에는 PICK_AUGMENT만 받는다
 */
export function applyCommand(state: GameState, op: number, a = 0, b = 0, events: number[] | null = null): boolean {
  if (state.over) return false;
  const stage = stageOf(state);
  if (state.augmentPending) {
    if (op !== OP.PICK_AUGMENT || !pickAugment(state, a, events)) return false;
    openQueuedOffer(state, stage);
    return true;
  }

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
      if (towerAtSlot(state, a) || !slotAvailable(state, stage, a) || !towerAllowed(state, stage, b)) return false;
      const cost = buildCost(state, b);
      if (state.gold < cost) return false;
      const slot = stage.map.slots[a];
      state.gold -= cost;
      state.towers.push({
        id: state.nextId++,
        slot: a,
        kind: b,
        level: 1,
        branch: 0,
        targetMode: TARGET.FIRST,
        cooldown: TOWERS[b].levels[0].periodTicks, // 건설 지연 — 첫 공격까지 1주기(판매→다른 슬롯 재건설로 쿨다운을 지우지 못하게)
        targetId: 0,
        builtInWave: state.wavesStarted,
        builtInPrep: inPrepPhase(state),
        invested: cost,
        x: slot.x,
        y: slot.y,
        attacks: 0,
        beamTargetId: 0,
        beamTicks: 0,
        ultTimer: 0,
      });
      return true;
    }
    case OP.UPGRADE: {
      const tower = towerAtSlot(state, a);
      const cost = upgradeCost(state, a);
      if (!tower || cost === 0 || state.gold < cost) return false;
      const previousPeriod = towerStage(TOWERS[tower.kind], tower.level, tower.branch).periodTicks;
      state.gold -= cost;
      tower.invested += cost;
      tower.level += 1;
      onLevelUp(tower, previousPeriod);
      return true;
    }
    case OP.BRANCH: {
      const tower = towerAtSlot(state, a);
      const cost = branchCost(state, a, b);
      if (!tower || cost === 0 || state.gold < cost) return false;
      const previousPeriod = towerStage(TOWERS[tower.kind], tower.level, tower.branch).periodTicks;
      state.gold -= cost;
      tower.invested += cost;
      tower.level = 4;
      tower.branch = b + 1;
      onLevelUp(tower, previousPeriod);
      return true;
    }
    case OP.SELL: {
      const tower = towerAtSlot(state, a);
      if (!tower || hasFlag(state.effects, FLAG.NO_SELL)) return false;
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
    default:
      return false; // PICK_AUGMENT는 증강 대기 중에만
  }
}

// ==================== 틱 진행 (§E2 — 순서를 바꾸면 버전 상승) ====================

/** 사망 처리 순서(피해 적용 순서) — step 안에서만 쓰는 작업 목록 */
const deathOrder: Enemy[] = [];

function spawnFromGroup(state: GameState, stage: Stage, spawner: Spawner, events: number[] | null): void {
  const group = stage.waves[spawner.wave - 1].groups[spawner.group];
  const kind = ENEMIES[group.enemyId];
  // 규칙 변형(R2 등) HP 효과 → 난이도 HP 배율(보상 기준에서는 뺀다)
  const ruleHp = statValue(state.effects, enemySubject(group.enemyId), STAT.ENEMY_HP, group.hp);
  const hp = Math.max(1, Math.floor((ruleHp * stage.difficultyHp) / PERMILLE));
  const spec = { kind: group.enemyId, hp, wave: spawner.wave, path: group.path, dist: 0, derived: false, rewardHp: ruleHp };
  for (let i = 0; i < kind.swarm; i++) createEnemy(state, stage, spec, events);
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
 * 1틱 진행 (§E2 2~10단계). events를 넘기면 렌더용 이벤트를 [종류, a, b, c]로 덧붙인다(호출자가 비우고 재사용)
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
    const swarm = ENEMIES[stage.waves[spawner.wave - 1].groups[spawner.group].enemyId].swarm;
    if (spawner.next === 0 && spawner.remaining > 0 && state.aliveEnemies + swarm <= MAX_ALIVE_ENEMIES) {
      spawnFromGroup(state, stage, spawner, events);
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
    state.countdownTotal = Math.max(1, economyStat(state, STAT.COUNTDOWN, WAVE_COUNTDOWN_TICKS));
    state.countdown = state.countdownTotal;
  }

  // 3. 상태효과 (지속 피해·지속 감소) + 장판 → 4. 적 이동 — 적마다 이어서(결과는 단계별 순서와 같다, combat.ts)
  const reachedEnd = updateAndMoveEnemies(state, stage, deathOrder, events);

  // 5. 적 능력
  runAbilities(state, stage, events);

  // 6. 타워: 쿨다운 → 표적 → 공격 → 궁극
  const fired = runTowers(state, deathOrder, events);

  // 7. 투사체 이동·명중 — 이번 틱에 쏜 투사체는 다음 틱부터 난다(비행 N틱이면 발사 N틱 뒤 명중)
  const finishedProjectiles = runProjectiles(state, fired, deathOrder, events);

  // 8. 사망 처리 (피해 적용 순서): 보상 → 사망 효과
  const removedByDeath = deathOrder.length > 0;
  processDeaths(state, stage, deathOrder, events);

  // 9. 누수: 경로 끝에 닿은 적 — 목숨 감소 (이번 틱에 끝에 닿은 적이 없으면 건너뛴다)
  let leaked = false;
  for (let i = 0; reachedEnd && i < state.enemies.length; i++) {
    const enemy = state.enemies[i];
    if (enemy.status !== ENEMY_STATUS.ALIVE || enemy.dist < enemy.pathTotal) continue;
    const lost = ENEMIES[enemy.kind].leakLives;
    enemy.status = ENEMY_STATUS.LEAKED;
    state.lives = Math.max(0, state.lives - lost);
    state.aliveEnemies -= 1;
    state.waves[enemy.wave - 1].pending -= 1;
    leaked = true;
    if (events) events.push(EVENT.LEAK, enemy.id, lost, 0);
  }

  // 10. 웨이브 종료 → 클리어 보너스 → 증강 제시 → 게임 오버
  for (let i = 0; i < state.wavesStarted; i++) {
    const wave = state.waves[i];
    if (wave.cleared || wave.pending > 0) continue;
    wave.cleared = true;
    state.wavesCleared += 1;
    const bonus = economyStat(state, STAT.CLEAR_BONUS, waveClearBonus(i + 1));
    state.gold += bonus;
    state.goldEarned += bonus;
    if (state.augmentEvery > 0 && (i + 1) % state.augmentEvery === 0) state.augmentQueue += 1;
    if (events) events.push(EVENT.WAVE_CLEAR, i + 1, bonus, 0);
  }

  state.tick += 1;
  if (removedByDeath || leaked) compactByStatus(state.enemies);
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
  else openQueuedOffer(state, stage); // 끝나는 판에는 제시하지 않는다
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

const flag = (value: boolean) => (value ? 1 : 0);

/** 문자열 → 글자 코드 목록(길이 먼저) — 보드 식별(스테이지·난이도·무한·주간 키, 맵)을 해시에 넣는다 */
function pushText(values: number[], text: string): void {
  values.push(text.length);
  for (let i = 0; i < text.length; i++) values.push(text.charCodeAt(i));
}

/** 최종 상태 FNV-1a 32비트 hex — 골든 비교용 (저장하지 않는다). 결과에 영향을 주는 모든 필드(캐시인 afflicted·targetHint 제외), 목록은 개수를 앞에(음수 없음 — 없음 −1은 +1로) */
export function getStateHash(state: GameState): string {
  const values: number[] = [];
  pushText(values, state.stageId);
  pushText(values, state.board.map.id);
  values.push(
    state.board.waves.length,
    state.board.rampFrom,
    state.seed,
    state.tick,
    state.gold,
    state.lives,
    state.goldEarned,
    state.kills,
    state.wavesStarted,
    state.wavesCleared,
    state.countdown,
    state.countdownTotal,
    state.nextId,
    state.rngWave,
    state.rngAugment,
    state.rngCombat,
    state.aliveEnemies,
    state.bannedTower + 1,
    state.augmentEvery,
    flag(state.augmentGuarantee),
    flag(state.augmentPending),
    state.offersWithoutRare,
    flag(state.over),
    flag(state.victory),
    state.endTick,
  );
  values.push(state.rules.length, ...state.rules);
  values.push(state.augments.length, ...state.augments);
  values.push(state.augmentChoices.length, ...state.augmentChoices);
  values.push(state.augmentQueue, state.offersOpened);
  values.push(state.effects.length);
  for (const e of state.effects) values.push(e.scope, e.target, e.stat, e.op, e.value);
  values.push(state.enemies.length);
  for (const e of state.enemies) {
    values.push(
      e.id, e.kind, e.hp, e.maxHp, e.rewardHp, flag(e.air), e.path, e.pathTotal, e.dist, e.segment, e.segmentStart, e.x, e.y, e.wave, e.reward, e.status,
      e.resistPhy, e.resistMag, e.phase, e.abilityTimer, flag(e.derived),
      e.slow, e.slowTicks, e.stunTicks, e.stunWindowStart, e.stunCount,
      e.burnSources.length, ...e.burnSources, ...e.burnDps, ...e.burnTicks,
      e.poisonStacks, e.poisonTicks, e.poisonDps, flag(e.plague), e.shred, e.shredTicks, e.vulnerable, e.vulnerableTicks,
      e.curseExplode, e.curseTicks, e.spawnTick, e.shatterDamage, e.shatterRadius,
    );
  }
  values.push(state.towers.length);
  for (const t of state.towers) {
    values.push(
      t.id, t.slot, t.kind, t.level, t.branch, t.targetMode, t.cooldown, t.targetId, t.builtInWave, flag(t.builtInPrep), t.invested,
      t.x, t.y, t.attacks, t.beamTargetId, t.beamTicks, t.ultTimer,
    );
  }
  values.push(state.projectiles.length);
  for (const p of state.projectiles) {
    values.push(
      p.id, p.towerId, p.slot, p.towerKind, p.level, p.branch, p.targetId, p.damage, p.damageType, p.element, p.splash, flag(p.nthStatus), p.pierce,
      flag(p.aftershock), p.originX, p.originY, p.aimX, p.aimY, p.ticksLeft, p.totalTicks, p.status,
    );
  }
  values.push(state.zones.length);
  for (const z of state.zones) values.push(z.id, z.kind, z.x, z.y, z.radius, z.ticksLeft, z.value, z.statusTicks, z.sourceKey);
  values.push(state.spawners.length);
  for (const s of state.spawners) values.push(s.wave, s.group, s.remaining, s.next);
  values.push(state.waves.length);
  for (const w of state.waves) values.push(w.total, w.pending, w.kills, flag(w.cleared));
  return toHex32(fnv1a(values));
}
