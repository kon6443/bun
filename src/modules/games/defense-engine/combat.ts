/**
 * 전투 (defense DESIGN §C2·§C4·§C5, §E2 3~8단계) — 상태효과·장판 · 적 능력 · 타워 공격·궁극 · 투사체 명중 · 사망 효과
 * 피해로 죽은 적은 deaths(피해 적용 순서)에 쌓이고 8단계 processDeaths가 순서대로 처리한다
 * 정본에 수치가 없는 값은 아래 이름 붙은 상수 — S1 시뮬레이터에서 다시 맞춘다
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  ABILITY,
  ATTACK,
  DAMAGE,
  ELEMENT,
  EVENT,
  FLAG,
  MAX_ALIVE_ENEMIES,
  MAX_PROJECTILES,
  PERMILLE,
  RANK,
  SLOW_FLOOR_PERMILLE,
  SPECIAL,
  STAT,
  STATUS,
  TARGET,
  TICKS_PER_SECOND,
} from './constants';
import { ENEMIES, ENEMY_ID } from './data/enemies';
import type { Stage } from './data/stages';
import { type StatusApply, TOWER_ID, TOWERS, type TowerSpecial, type TowerStage, towerStage } from './data/towers';
import { dealDamage } from './damage';
import { type EffectSubject, flagValue, hasFlag, statValue } from './effects';
import { distanceSquared, isqrt } from './geometry';
import { nextRandom } from './random';
import { addDerivedEnemies, placeOnPath } from './spawn';
import {
  ENEMY_STATUS,
  type Enemy,
  type GameState,
  PROJECTILE_STATUS,
  type Projectile,
  type Tower,
  ZONE_KIND,
  economyStat,
  enemySubject,
  towerSubject,
} from './state';
import { type StatusSource, applyStatus, tickStatuses } from './status';

// ---- 정본에 수치가 없는 값 (S1 시뮬레이터에서 재조정) ----
/** 공명(증강) — 첫 대상 근처 두 번째 대상까지 거리 · 피해 비율 */
const RESONANCE_RADIUS = 1500;
const RESONANCE_PERMILLE = 500;
/** 관통 — 표적 근처 추가 대상까지 거리 (데이터에 반경이 없을 때 — 세 번째 화살). 정본 "관통 N" = 표적 포함 N마리 = 데이터 count N−1 */
const PIERCE_RADIUS = 1000;
/** 세 번째 화살(증강) — 3발째마다 관통 2(표적 포함 2마리 → 추가 1) */
const PIERCE_THIRD_EVERY = 3;
const PIERCE_THIRD_COUNT = 1;
/** 여진(증강) — 착탄 지점 장판 지속·감속 ‰ */
const AFTERSHOCK_TICKS = 30;
const AFTERSHOCK_SLOW = 300;
/** 대지 겨냥(증강) — 대공 석궁이 지상을 맞힐 때 피해 비율 */
const CROSSBOW_GROUND_PERMILLE = 500;
/** 증식(R5) — 새 졸개 HP = 부모 최대 HP ‰ */
const MULTIPLY_HP_PERMILLE = 250;
/** 증식(R5) 확률 분모 — 효과 value가 ‰ */
const MULTIPLY_ROLL = 1000;

/** 파생 적(소환·분열·증식)의 킬 보상 기준 HP — 부모의 기준 HP(난이도 배율 전) × 비율 ‰ */
function derivedRewardHp(parent: Enemy, permille: number): number {
  return Math.max(1, Math.floor((parent.rewardHp * permille) / PERMILLE));
}

export function findSpecial(stage: TowerStage, kind: number): TowerSpecial | null {
  for (const s of stage.specials) if (s.kind === kind) return s;
  return null;
}

function periodicSpecial(stage: TowerStage): TowerSpecial | null {
  for (const s of stage.specials) if (s.kind === SPECIAL.PERIODIC_PULSE || s.kind === SPECIAL.PERIODIC_CHAIN) return s;
  return null;
}

/** Lv5 궁극의 주기 (궁극이 없으면 0) — 업그레이드 시 타이머 초기화에 쓴다 */
export function ultimatePeriod(kind: number, level: number, branch: number): number {
  if (level < 5) return 0;
  const ult = periodicSpecial(towerStage(TOWERS[kind], level, branch));
  return ult ? (ult.every ?? 0) : 0;
}

// ==================== 공격 주체 (타워·투사체 공통) ====================

/** 이번 공격에 쓰는 수치 — 단계 데이터 + 활성 효과 */
type Strike = {
  towerId: number;
  towerKind: number;
  stage: TowerStage;
  subject: EffectSubject;
  damageType: number;
  element: number;
  hitsGround: boolean;
  hitsAir: boolean;
  /** 대지 겨냥 — 지상 대상 피해 50% */
  groundPenalty: boolean;
  /** 이번 공격이 "n번째마다" 상태효과를 거는지 */
  nthStatus: StatusApply | null;
  statusSource: StatusSource;
  shatterDamage: number;
  shatterRadius: number;
  rankBonus: TowerSpecial | null;
};

/** 대지 겨냥(증강) — 대공 석궁이 지상도 노린다 */
function groundShot(state: GameState, kindId: number, stage: TowerStage): boolean {
  return kindId === TOWER_ID.CROSSBOW && !stage.hitsGround && hasFlag(state.effects, FLAG.CROSSBOW_GROUND);
}

function makeStrike(state: GameState, towerId: number, slot: number, kindId: number, level: number, branch: number, nth: boolean): Strike {
  const kind = TOWERS[kindId];
  const stage = towerStage(kind, level, branch);
  const subject = towerSubject(kindId, stage.element);
  const ground = groundShot(state, kindId, stage);
  const nthSpecial = findSpecial(stage, SPECIAL.EVERY_NTH_STATUS);
  const curse = findSpecial(stage, SPECIAL.CURSE_EXPLODE);
  const shatter = findSpecial(stage, SPECIAL.SHATTER);
  return {
    towerId,
    towerKind: kindId,
    stage,
    subject,
    damageType: kind.damageType,
    element: stage.element,
    hitsGround: stage.hitsGround || ground,
    hitsAir: stage.hitsAir,
    groundPenalty: ground,
    nthStatus: nth && nthSpecial && nthSpecial.status ? nthSpecial.status : null,
    statusSource: {
      subject,
      sourceKey: slot + 1,
      plague: findSpecial(stage, SPECIAL.PLAGUE) !== null,
      curseExplode: curse ? (curse.value ?? 0) : 0,
    },
    shatterDamage: shatter ? (shatter.value ?? 0) : 0,
    shatterRadius: shatter ? (shatter.radius ?? 0) : 0,
    rankBonus: findSpecial(stage, SPECIAL.RANK_BONUS),
  };
}

function canHit(enemy: Enemy, hitsGround: boolean, hitsAir: boolean): boolean {
  return enemy.status === ENEMY_STATUS.ALIVE && (enemy.air ? hitsAir : hitsGround);
}

/** 한 대상에 피해 → 상태효과(단계 데이터 순 → n번째 상태효과) */
function strikeEnemy(state: GameState, strike: Strike, enemy: Enemy, base: number, sourceId: number, deaths: Enemy[], events: number[] | null): void {
  let damage = base;
  const bonus = strike.rankBonus;
  if (bonus && ENEMIES[enemy.kind].rank !== RANK.NORMAL && (!bonus.airOnly || enemy.air)) {
    damage = Math.floor((damage * (PERMILLE + (bonus.value ?? 0))) / PERMILLE);
  }
  if (strike.groundPenalty && !enemy.air) damage = Math.floor((damage * CROSSBOW_GROUND_PERMILLE) / PERMILLE);
  dealDamage(state, enemy, damage, strike.damageType, strike.element, sourceId, deaths, events, strike.shatterDamage, strike.shatterRadius);
  for (const s of strike.stage.status) applyStatus(state, enemy, s, strike.statusSource, events);
  if (strike.nthStatus) applyStatus(state, enemy, strike.nthStatus, strike.statusSource, events);
}

// ==================== 표적 (§C2) ====================

/**
 * 반경 안 표적의 적 배열 인덱스(없으면 −1)
 * 선두 = 출구까지 남은 거리가 가장 짧은 적(다중 경로, D-025) · 후미 = 가장 긴 적 · 최강 = 현재 HP · 최근접 = 거리
 * 동률: 경로 진행 거리 큰 순 → 생성 순번 작은 순(배열이 생성 순이라 먼저 본 쪽을 유지)
 */
export function selectTarget(
  state: GameState,
  x: number,
  y: number,
  range: number,
  hitsGround: boolean,
  hitsAir: boolean,
  mode: number,
): number {
  const rangeSq = range * range;
  const enemies = state.enemies;
  let bestIndex = -1;
  let bestScore = 0;
  let bestDist = 0;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (!canHit(enemy, hitsGround, hitsAir)) continue;
    const d2 = distanceSquared(x, y, enemy.x, enemy.y);
    if (d2 > rangeSq) continue;
    // 점수가 클수록 좋다 — 부호만 뒤집는다(나눗셈 없음)
    const remaining = enemy.pathTotal - enemy.dist;
    let score: number;
    if (mode === TARGET.LAST) score = remaining;
    else if (mode === TARGET.STRONGEST) score = enemy.hp;
    else if (mode === TARGET.NEAREST) score = -d2;
    else score = -remaining;
    if (bestIndex < 0 || score > bestScore || (score === bestScore && enemy.dist > bestDist)) {
      bestIndex = i;
      bestScore = score;
      bestDist = enemy.dist;
    }
  }
  return bestIndex;
}

/** (x, y)에서 가장 가까운 대상 — 제외 목록(id)에 없는 것. 동률: 남은 거리 짧은 순 → 생성 순번 작은 순 */
function nearestOther(state: GameState, x: number, y: number, radius: number, hitsGround: boolean, hitsAir: boolean, exclude: readonly number[]): Enemy | null {
  const radiusSq = radius * radius;
  let best: Enemy | null = null;
  let bestD2 = 0;
  for (const enemy of state.enemies) {
    if (!canHit(enemy, hitsGround, hitsAir)) continue;
    const d2 = distanceSquared(x, y, enemy.x, enemy.y);
    // 제외 목록 탐색은 반경 안일 때만(조건 순서만 바꿈 — 결과는 같다)
    if (d2 > radiusSq || exclude.indexOf(enemy.id) >= 0) continue;
    if (!best || d2 < bestD2 || (d2 === bestD2 && enemy.pathTotal - enemy.dist < best.pathTotal - best.dist)) {
      best = enemy;
      bestD2 = d2;
    }
  }
  return best;
}

/** 연쇄·관통에서 이미 맞힌 적 id — step 안에서만 쓰는 작업 목록 */
const struck: number[] = [];

/** 연쇄 — 첫 대상부터 count마리, 튈 때마다 피해 × (1000 − falloff)‰ */
function chainFrom(state: GameState, strike: Strike, first: Enemy, damage: number, count: number, falloff: number, range: number, deaths: Enemy[], events: number[] | null): void {
  struck.length = 0;
  let current = first;
  let d = damage;
  for (let n = 0; n < count; n++) {
    struck.push(current.id);
    strikeEnemy(state, strike, current, d, 0, deaths, events);
    if (n === count - 1) break;
    const next = nearestOther(state, current.x, current.y, range, strike.hitsGround, strike.hitsAir, struck);
    if (!next) break;
    if (events) events.push(EVENT.CHAIN, current.id, next.id, strike.towerId);
    d = Math.max(1, Math.floor((d * (PERMILLE - Math.min(PERMILLE, falloff))) / PERMILLE));
    current = next;
  }
}

/** 표적 근처 count마리를 더 맞힌다 (관통) */
function pierceAround(state: GameState, strike: Strike, center: Enemy, damage: number, count: number, sourceId: number, deaths: Enemy[], events: number[] | null): void {
  const special = findSpecial(strike.stage, SPECIAL.PIERCE);
  const radius = special && special.radius ? special.radius : PIERCE_RADIUS;
  struck.length = 0;
  struck.push(center.id);
  for (let n = 0; n < count; n++) {
    const next = nearestOther(state, center.x, center.y, radius, strike.hitsGround, strike.hitsAir, struck);
    if (!next) return;
    struck.push(next.id);
    strikeEnemy(state, strike, next, damage, sourceId, deaths, events);
  }
}

/** (x, y) 반경 안 대상 전부 (생성 순) */
function strikeArea(state: GameState, strike: Strike, x: number, y: number, radius: number, damage: number, sourceId: number, deaths: Enemy[], events: number[] | null): void {
  const radiusSq = radius * radius;
  const enemies = state.enemies;
  const count = enemies.length; // 이 안에서 새 적이 생기지 않는다(생성은 5·8단계)
  for (let i = 0; i < count; i++) {
    const enemy = enemies[i];
    if (canHit(enemy, strike.hitsGround, strike.hitsAir) && distanceSquared(x, y, enemy.x, enemy.y) <= radiusSq) {
      strikeEnemy(state, strike, enemy, damage, sourceId, deaths, events);
    }
  }
}

function anyInRange(state: GameState, x: number, y: number, radius: number, hitsGround: boolean, hitsAir: boolean): boolean {
  const radiusSq = radius * radius;
  for (const enemy of state.enemies) {
    if (canHit(enemy, hitsGround, hitsAir) && distanceSquared(x, y, enemy.x, enemy.y) <= radiusSq) return true;
  }
  return false;
}

// ==================== 3·4단계: 상태효과·장판 → 이동 ====================

/** 종류별 이동 속도 (효과: 질풍 R1) */
export function enemySpeed(state: GameState, kind: number): number {
  const base = ENEMIES[kind].speed;
  return state.effects.length > 0 ? statValue(state.effects, enemySubject(kind), STAT.ENEMY_SPEED, base) : base;
}

/** 이번 틱 이동 거리 — 기절이면 0, 감속은 하한 300‰ */
export function enemyStep(enemy: Enemy, speed: number): number {
  if (enemy.stunTicks > 0) return 0;
  if (enemy.slow <= 0) return speed;
  return Math.floor((speed * Math.max(SLOW_FLOOR_PERMILLE, PERMILLE - enemy.slow)) / PERMILLE);
}

/** 능력이 있는 종류 — 4단계에서 살아 있는지 보고, 5단계는 능력 없는 적을 표를 읽지 않고 넘긴다(분열은 사망 때 처리라 5단계 일은 없지만 넉넉히 포함) */
const HAS_ABILITY: readonly boolean[] = ENEMIES.map((e) => e.ability.kind !== ABILITY.NONE);

/** 종류별 속도 표 — 효과는 틱 안에서 바뀌지 않으니 틱마다 종류 수만큼만 계산한다 (step 안에서만 쓰는 작업 표) */
const speedByKind: number[] = [];

/**
 * 장판이 거는 상태효과·출처 — applyStatus는 값만 읽고 담아 두지 않는다(status.ts) → 적·장판마다 새로 만들지 않고 고쳐 쓴다(step 안 작업 객체)
 * 출처 대상은 늘 대포·불(장판은 대포 분기만 만든다)
 */
const zoneSpec: StatusApply = { status: STATUS.BURN, value: 0, ticks: 0 };
const zoneSource: StatusSource = { subject: towerSubject(TOWER_ID.CANNON, ELEMENT.FIRE), sourceKey: 0, plague: false, curseExplode: 0 };

/** 장판 상태효과 — 장판 생성 순, 지상 적만 */
function applyZones(state: GameState, enemy: Enemy): void {
  const zones = state.zones;
  for (let z = 0; z < zones.length; z++) {
    const zone = zones[z];
    if (distanceSquared(zone.x, zone.y, enemy.x, enemy.y) > zone.radius * zone.radius) continue;
    zoneSpec.status = zone.kind === ZONE_KIND.FIRE ? STATUS.BURN : STATUS.SLOW;
    zoneSpec.value = zone.value;
    zoneSpec.ticks = zone.statusTicks;
    zoneSource.sourceKey = zone.sourceKey;
    applyStatus(state, enemy, zoneSpec, zoneSource, null);
  }
}

/** updateAndMoveEnemies 결과 — 틱마다 고쳐 쓰는 작업 객체(step 안에서 바로 읽는다) */
export type MoveResult = {
  /** 경로 끝에 닿은 적이 있다 → 9단계 누수 검사 */
  reachedEnd: boolean;
  /** 능력이 있는 종류가 살아 있다 — 없으면 5단계를 건너뛴다 */
  abilityAlive: boolean;
};
const moveResult: MoveResult = { reachedEnd: false, abilityAlive: false };

/**
 * 3단계(상태효과 갱신 → 장판) + 4단계(이동)를 적마다(생성 순) 이어서 한다 — 결과는 MoveResult(재사용 객체)
 * 한 적의 상태효과·장판·이동은 다른 적에 영향을 주지 않아 "전원 3단계 → 전원 4단계"와 결과가 같다(루프 1회 — §E5 성능)
 * 불변 조건: 3단계에 다른 적을 건드리는 효과(지속 피해 사망 즉시 범위 효과·오라 등)를 넣으면 두 루프로 다시 나눈다
 * 장판 상태효과는 갱신 뒤에 걸어 같은 틱 이동에 반영되고, 장판 지속은 루프 뒤에 줄인다
 */
export function updateAndMoveEnemies(state: GameState, stage: Stage, deaths: Enemy[], events: number[] | null): MoveResult {
  for (let k = 0; k < ENEMIES.length; k++) speedByKind[k] = enemySpeed(state, k);
  const zones = state.zones;
  let reachedEnd = false;
  let abilityAlive = false;
  const enemies = state.enemies;
  const { groundPaths, airPaths } = stage.map;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (enemy.status !== ENEMY_STATUS.ALIVE) continue;
    // 지속 피해로 이번에 죽는 적도 센다 — 5단계는 살아 있는 적만 보니 넉넉하게 잡아도 결과가 같다
    if (HAS_ABILITY[enemy.kind]) abilityAlive = true;
    if (enemy.afflicted) {
      tickStatuses(state, enemy, deaths, events);
      if (enemy.status !== ENEMY_STATUS.ALIVE) continue;
    }
    if (zones.length > 0 && !enemy.air) applyZones(state, enemy);
    const move = enemyStep(enemy, speedByKind[enemy.kind]);
    if (move === 0) continue;
    enemy.dist = Math.min(enemy.dist + move, enemy.pathTotal);
    // enemyPath와 같은 선택 — 적마다 맵 구조를 다시 풀지 않는다
    placeOnPath(enemy, enemy.air && airPaths.length > 0 ? airPaths[Math.min(enemy.path, airPaths.length - 1)] : groundPaths[Math.min(enemy.path, groundPaths.length - 1)]);
    if (enemy.dist >= enemy.pathTotal) reachedEnd = true;
  }
  if (zones.length > 0) {
    let write = 0;
    for (const zone of zones) if (--zone.ticksLeft > 0) zones[write++] = zone;
    zones.length = write;
  }
  moveResult.reachedEnd = reachedEnd;
  moveResult.abilityAlive = abilityAlive;
  return moveResult;
}

// ==================== 5단계: 적 능력 ====================

/** 치유·소환·페이즈 전환 (생성 순) — 기절 중엔 치유·소환이 멈춘다. 페이즈 전환은 HP 조건이라 기절과 무관 */
export function runAbilities(state: GameState, stage: Stage, events: number[] | null): void {
  const enemies = state.enemies;
  const count = enemies.length; // 이번 틱 소환된 적은 다음 틱부터
  for (let i = 0; i < count; i++) {
    const enemy = enemies[i];
    if (!HAS_ABILITY[enemy.kind] || enemy.status !== ENEMY_STATUS.ALIVE) continue;
    const ability = ENEMIES[enemy.kind].ability;
    switch (ability.kind) {
      case ABILITY.SUMMON: {
        if (enemy.stunTicks > 0 || --enemy.abilityTimer > 0) break;
        enemy.abilityTimer = ability.every;
        const hp = Math.max(1, Math.floor((enemy.maxHp * ability.value) / PERMILLE));
        const spec = { kind: ability.spawnKind, hp, wave: enemy.wave, path: enemy.path, dist: enemy.dist, derived: true, rewardHp: derivedRewardHp(enemy, ability.value) };
        const made = addDerivedEnemies(state, stage, spec, ability.count, MAX_ALIVE_ENEMIES, events);
        if (events && made > 0) events.push(EVENT.ABILITY, enemy.id, ability.kind, 0);
        break;
      }
      case ABILITY.HEAL: {
        if (enemy.stunTicks > 0 || --enemy.abilityTimer > 0) break;
        enemy.abilityTimer = ability.every;
        const radiusSq = ability.radius * ability.radius;
        for (let j = 0; j < count; j++) {
          const other = enemies[j];
          if (j === i || other.status !== ENEMY_STATUS.ALIVE) continue;
          if (distanceSquared(enemy.x, enemy.y, other.x, other.y) > radiusSq) continue;
          other.hp = Math.min(other.maxHp, other.hp + Math.max(1, Math.floor((other.maxHp * ability.value) / PERMILLE)));
        }
        if (events) events.push(EVENT.ABILITY, enemy.id, ability.kind, 0);
        break;
      }
      case ABILITY.PHASE_SWAP: {
        if (enemy.phase !== 0 || enemy.hp * 2 > enemy.maxHp) break;
        enemy.phase = 1;
        const phy = enemy.resistPhy;
        enemy.resistPhy = enemy.resistMag;
        enemy.resistMag = phy;
        const spawn = ENEMIES[ability.spawnKind];
        const hp = Math.max(1, Math.floor((enemy.maxHp * ability.value) / PERMILLE));
        const spec = { kind: ability.spawnKind, hp, wave: enemy.wave, path: enemy.path, dist: enemy.dist, derived: true, rewardHp: derivedRewardHp(enemy, ability.value) };
        addDerivedEnemies(state, stage, spec, ability.count * spawn.swarm, MAX_ALIVE_ENEMIES, events);
        if (events) events.push(EVENT.ABILITY, enemy.id, ability.kind, 1);
        break;
      }
      default:
        break;
    }
  }
}

// ==================== 6단계: 타워 ====================

/**
 * 타워(생성 순): 쿨다운 감소 → 표적 → 공격 → 궁극. 이번 틱에 만든 투사체 수를 돌려준다(7단계는 그 앞까지만 난다)
 * 투사체 상한이면 투사체 공격만 보류(표적도 다시 고르지 않는다). 즉발·펄스·연쇄·광선은 상한과 무관
 */
export function runTowers(state: GameState, deaths: Enemy[], events: number[] | null): number {
  let projectileCount = state.projectiles.length;
  let fired = 0;
  for (const tower of state.towers) {
    if (tower.cooldown > 0) tower.cooldown -= 1;
    if (tower.cooldown === 0) {
      const made = attack(state, tower, projectileCount >= MAX_PROJECTILES, deaths, events);
      projectileCount += made;
      fired += made;
    }
    runUltimate(state, tower, deaths, events);
  }
  return fired;
}

/** 공격 1회 — 만든 투사체 수(0·1) */
function attack(state: GameState, tower: Tower, projectilesFull: boolean, deaths: Enemy[], events: number[] | null): number {
  const kind = TOWERS[tower.kind];
  const stage = towerStage(kind, tower.level, tower.branch);
  if (stage.attack === ATTACK.PROJECTILE && projectilesFull) return 0;
  const effects = state.effects;
  const subject = towerSubject(tower.kind, stage.element);
  const range = statValue(effects, subject, STAT.RANGE, stage.range);
  const hitsGround = stage.hitsGround || groundShot(state, tower.kind, stage);

  if (stage.attack === ATTACK.PULSE) {
    if (!anyInRange(state, tower.x, tower.y, range, hitsGround, stage.hitsAir)) {
      tower.targetId = 0;
      return 0;
    }
  }
  let target: Enemy | null = null;
  let targetIndex = 0;
  if (stage.attack !== ATTACK.PULSE) {
    const index = selectTarget(state, tower.x, tower.y, range, hitsGround, stage.hitsAir, tower.targetMode);
    if (index < 0) {
      tower.targetId = 0;
      tower.beamTargetId = 0;
      tower.beamTicks = 0;
      return 0;
    }
    target = state.enemies[index];
    targetIndex = index;
    tower.targetId = target.id;
  }

  tower.attacks += 1;
  tower.cooldown = stage.periodTicks;
  const nthStatus = findSpecial(stage, SPECIAL.EVERY_NTH_STATUS);
  const nth = nthStatus !== null && tower.attacks % (nthStatus.every ?? 1) === 0;
  const strike = makeStrike(state, tower.id, tower.slot, tower.kind, tower.level, tower.branch, nth);
  let damage = statValue(effects, subject, STAT.DAMAGE, stage.damage);
  const headshot = findSpecial(stage, SPECIAL.EVERY_NTH_DAMAGE);
  if (headshot && tower.attacks % (headshot.every ?? 1) === 0) damage = Math.floor((damage * (headshot.mult ?? PERMILLE)) / PERMILLE);

  switch (stage.attack) {
    case ATTACK.PULSE:
      if (events) events.push(EVENT.PULSE, tower.id, range, 0);
      strikeArea(state, strike, tower.x, tower.y, range, damage, 0, deaths, events);
      return 0;
    case ATTACK.CHAIN: {
      if (!target) return 0;
      if (events) events.push(EVENT.FIRE, tower.id, 0, target.id);
      const count = statValue(effects, subject, STAT.CHAIN_COUNT, stage.chainCount);
      const falloff = statValue(effects, subject, STAT.CHAIN_FALLOFF, stage.chainFalloff);
      chainFrom(state, strike, target, damage, count, falloff, stage.chainRange, deaths, events);
      return 0;
    }
    case ATTACK.BEAM: {
      if (!target) return 0;
      const ramp = findSpecial(stage, SPECIAL.BEAM_RAMP);
      if (tower.beamTargetId === target.id) tower.beamTicks += stage.periodTicks;
      else {
        tower.beamTargetId = target.id;
        tower.beamTicks = 0;
      }
      if (ramp) {
        const mult = Math.min(ramp.max ?? PERMILLE, PERMILLE + Math.floor(((ramp.value ?? 0) * tower.beamTicks) / TICKS_PER_SECOND));
        damage = Math.floor((damage * mult) / PERMILLE);
      }
      if (events) events.push(EVENT.FIRE, tower.id, 0, target.id);
      strikeEnemy(state, strike, target, damage, 0, deaths, events);
      resonate(state, tower, strike, target, damage, deaths, events);
      return 0;
    }
    case ATTACK.INSTANT: {
      if (!target) return 0;
      if (events) events.push(EVENT.FIRE, tower.id, 0, target.id);
      strikeEnemy(state, strike, target, damage, 0, deaths, events);
      resonate(state, tower, strike, target, damage, deaths, events);
      return 0;
    }
    default: {
      if (!target) return 0;
      const pierceSpecial = findSpecial(stage, SPECIAL.PIERCE);
      let pierce = pierceSpecial ? (pierceSpecial.count ?? 0) : 0;
      if (tower.kind === TOWER_ID.ARCHER && hasFlag(effects, FLAG.ARCHER_PIERCE_THIRD) && tower.attacks % PIERCE_THIRD_EVERY === 0) {
        pierce += PIERCE_THIRD_COUNT;
      }
      const distance = isqrt(distanceSquared(tower.x, tower.y, target.x, target.y));
      const flight = Math.max(1, Math.floor((distance + kind.projectileSpeed - 1) / kind.projectileSpeed));
      const projectile: Projectile = {
        id: state.nextId++,
        towerId: tower.id,
        slot: tower.slot,
        towerKind: tower.kind,
        level: tower.level,
        branch: tower.branch,
        targetId: target.id,
        damage,
        damageType: kind.damageType,
        element: stage.element,
        splash: statValue(effects, subject, STAT.SPLASH, stage.splash),
        nthStatus: nth,
        pierce,
        aftershock: tower.kind === TOWER_ID.CANNON && hasFlag(effects, FLAG.CANNON_AFTERSHOCK),
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
      if (events) events.push(EVENT.FIRE, tower.id, projectile.id, target.id);
      return 1;
    }
  }
}

/** 공명(증강) — 마법탑(볼트·광선) 첫 대상 근처 두 번째 대상에 50% */
function resonate(state: GameState, tower: Tower, strike: Strike, target: Enemy, damage: number, deaths: Enemy[], events: number[] | null): void {
  if (tower.kind !== TOWER_ID.MAGE || !hasFlag(state.effects, FLAG.MAGE_RESONANCE)) return;
  struck.length = 0;
  struck.push(target.id);
  const second = nearestOther(state, target.x, target.y, RESONANCE_RADIUS, strike.hitsGround, strike.hitsAir, struck);
  if (!second) return;
  if (events) events.push(EVENT.CHAIN, target.id, second.id, tower.id);
  strikeEnemy(state, strike, second, Math.max(1, Math.floor((damage * RESONANCE_PERMILLE) / PERMILLE)), 0, deaths, events);
}

/** 궁극(주기형) — 타이머가 0이 되면 발동, 맞힐 대상이 없으면 준비 상태로 기다린다 */
function runUltimate(state: GameState, tower: Tower, deaths: Enemy[], events: number[] | null): void {
  if (tower.level < 5) return;
  const stage = towerStage(TOWERS[tower.kind], tower.level, tower.branch);
  const ult = periodicSpecial(stage);
  if (!ult) return;
  if (tower.ultTimer > 0) tower.ultTimer -= 1;
  if (tower.ultTimer > 0) return;
  const strike = makeStrike(state, tower.id, tower.slot, tower.kind, tower.level, tower.branch, false);
  if (ult.kind === SPECIAL.PERIODIC_PULSE) {
    const radius = ult.radius ?? 0;
    if (!ult.status || !anyInRange(state, tower.x, tower.y, radius, strike.hitsGround, strike.hitsAir)) return;
    const radiusSq = radius * radius;
    for (const enemy of state.enemies) {
      if (canHit(enemy, strike.hitsGround, strike.hitsAir) && distanceSquared(tower.x, tower.y, enemy.x, enemy.y) <= radiusSq) {
        applyStatus(state, enemy, ult.status, strike.statusSource, events);
      }
    }
    if (events) events.push(EVENT.PULSE, tower.id, radius, 1);
  } else {
    const subject = towerSubject(tower.kind, stage.element);
    const range = statValue(state.effects, subject, STAT.RANGE, stage.range);
    const index = selectTarget(state, tower.x, tower.y, range, strike.hitsGround, strike.hitsAir, tower.targetMode);
    if (index < 0) return;
    const damage = statValue(state.effects, subject, STAT.DAMAGE, stage.damage);
    const falloff = statValue(state.effects, subject, STAT.CHAIN_FALLOFF, stage.chainFalloff);
    if (events) events.push(EVENT.PULSE, tower.id, 0, 1);
    const count = statValue(state.effects, subject, STAT.CHAIN_COUNT, ult.count ?? 0); // 고전압(연쇄 +1)은 궁극 연쇄에도
    chainFrom(state, strike, state.enemies[index], damage, count, falloff, stage.chainRange, deaths, events);
  }
  tower.ultTimer = ult.every ?? 0;
}

// ==================== 7단계: 투사체 ====================

/** 적 배열은 id 오름차순 — 힌트 인덱스가 맞으면 바로, 아니면 이분 탐색 후 힌트를 고친다(힌트는 결과에 영향 없음) */
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

/**
 * 투사체 이동·명중 (생성 순, 이번 틱에 쏜 것 제외) — 유도형: 비행 시간만 있다
 * 표적이 먼저 죽으면 단일 공격은 사라지고 범위 공격은 마지막 위치에서 터진다. 끝난 투사체가 있으면 true
 */
export function runProjectiles(state: GameState, firedThisTick: number, deaths: Enemy[], events: number[] | null): boolean {
  let finished = false;
  const projectiles = state.projectiles;
  const enemies = state.enemies;
  const flying = projectiles.length - firedThisTick;
  for (let i = 0; i < flying; i++) {
    const projectile = projectiles[i];
    if (projectile.status !== PROJECTILE_STATUS.FLYING) continue;
    // 힌트가 맞으면 바로(대부분) — 아니면 findTarget(힌트 재확인 후 이분 탐색)
    const hinted = enemies[projectile.targetHint];
    const target = hinted !== undefined && hinted.id === projectile.targetId ? hinted : findTarget(state, projectile);
    const targetAlive = target !== null && target.status === ENEMY_STATUS.ALIVE;
    if (target) {
      // 같은 틱에 먼저 죽은 표적도 틱 끝 정리 전까지 이번 틱 위치를 갖고 있다 — 범위탄은 거기서 터진다
      projectile.aimX = target.x;
      projectile.aimY = target.y;
    }
    projectile.ticksLeft -= 1;
    if (projectile.ticksLeft > 0 && targetAlive) continue;
    projectile.status = PROJECTILE_STATUS.DONE;
    finished = true;
    if (projectile.splash <= 0 && !targetAlive) continue;
    impact(state, projectile, targetAlive ? target : null, deaths, events);
  }
  return finished;
}

function impact(state: GameState, projectile: Projectile, target: Enemy | null, deaths: Enemy[], events: number[] | null): void {
  const strike = makeStrike(state, projectile.towerId, projectile.slot, projectile.towerKind, projectile.level, projectile.branch, projectile.nthStatus);
  const x = projectile.aimX;
  const y = projectile.aimY;
  if (projectile.splash > 0) strikeArea(state, strike, x, y, projectile.splash, projectile.damage, projectile.id, deaths, events);
  else if (target) strikeEnemy(state, strike, target, projectile.damage, projectile.id, deaths, events);
  if (target && projectile.pierce > 0) pierceAround(state, strike, target, projectile.damage, projectile.pierce, projectile.id, deaths, events);

  const fire = findSpecial(strike.stage, SPECIAL.FIRE_ZONE);
  if (fire && fire.status) addZone(state, ZONE_KIND.FIRE, x, y, fire.radius ?? 0, fire.ticks ?? 0, fire.status.value, fire.status.ticks, projectile.slot + 1, events);
  if (projectile.aftershock) addZone(state, ZONE_KIND.SLOW, x, y, projectile.splash, AFTERSHOCK_TICKS, AFTERSHOCK_SLOW, 1, projectile.slot + 1, events);
}

function addZone(state: GameState, kind: number, x: number, y: number, radius: number, ticks: number, value: number, statusTicks: number, sourceKey: number, events: number[] | null): void {
  if (radius <= 0 || ticks <= 0) return;
  const id = state.nextId++;
  state.zones.push({ id, kind, x, y, radius, ticksLeft: ticks, value, statusTicks, sourceKey });
  if (events) events.push(EVENT.ZONE, id, x, y);
}

// ==================== 8단계: 사망 처리 ====================

const PLAGUE_SPECIAL = findSpecial(towerStage(TOWERS[TOWER_ID.ARCHER], 5, 2), SPECIAL.PLAGUE);
const CURSE_SPECIAL = findSpecial(towerStage(TOWERS[TOWER_ID.MAGE], 5, 2), SPECIAL.CURSE_EXPLODE);
const PLAGUE_SOURCE: StatusSource = { subject: towerSubject(TOWER_ID.ARCHER, ELEMENT.POISON), sourceKey: 0, plague: true, curseExplode: 0 };

function damageArea(state: GameState, x: number, y: number, radius: number, damage: number, element: number, deaths: Enemy[], events: number[] | null): void {
  const radiusSq = radius * radius;
  for (const enemy of state.enemies) {
    if (enemy.status === ENEMY_STATUS.ALIVE && distanceSquared(x, y, enemy.x, enemy.y) <= radiusSq) {
      dealDamage(state, enemy, damage, DAMAGE.MAG, element, 0, deaths, events);
    }
  }
}

/**
 * 피해 적용 순서대로: 보상 → 사망 효과(분열 → 증식 R5 → 역병 전염 → 저주 폭발 → 파편)
 * 사망 효과로 죽은 적은 목록 끝에 붙어 같은 루프에서 처리된다
 */
export function processDeaths(state: GameState, stage: Stage, deaths: Enemy[], events: number[] | null): void {
  const splitChance = flagValue(state.effects, FLAG.SPLIT_ON_DEATH);
  for (let i = 0; i < deaths.length; i++) {
    const enemy = deaths[i];
    const reward = economyStat(state, STAT.KILL_GOLD, enemy.reward);
    state.gold += reward;
    state.goldEarned += reward;
    state.kills += 1;
    state.aliveEnemies -= 1;
    const wave = state.waves[enemy.wave - 1];
    wave.kills += 1;
    wave.pending -= 1;
    if (events) events.push(EVENT.DEATH, enemy.id, enemy.x, enemy.y);

    const ability = ENEMIES[enemy.kind].ability;
    if (ability.kind === ABILITY.SPLIT) {
      const hp = Math.max(1, Math.floor((enemy.maxHp * ability.value) / PERMILLE));
      const spec = { kind: ability.spawnKind, hp, wave: enemy.wave, path: enemy.path, dist: enemy.dist, derived: true, rewardHp: derivedRewardHp(enemy, ability.value) };
      addDerivedEnemies(state, stage, spec, ability.count, MAX_ALIVE_ENEMIES, events);
    }
    if (splitChance >= 0 && !enemy.derived && !enemy.air) {
      const [next, roll] = nextRandom(state.rngCombat);
      state.rngCombat = next;
      if (roll % MULTIPLY_ROLL < splitChance) {
        const hp = Math.max(1, Math.floor((enemy.maxHp * MULTIPLY_HP_PERMILLE) / PERMILLE));
        const spec = { kind: ENEMY_ID.GRUNT, hp, wave: enemy.wave, path: enemy.path, dist: enemy.dist, derived: true, rewardHp: derivedRewardHp(enemy, MULTIPLY_HP_PERMILLE) };
        addDerivedEnemies(state, stage, spec, 1, MAX_ALIVE_ENEMIES, events);
      }
    }
    if (enemy.plague && PLAGUE_SPECIAL && PLAGUE_SPECIAL.status) {
      const radius = PLAGUE_SPECIAL.radius ?? 0;
      const radiusSq = radius * radius;
      for (const other of state.enemies) {
        if (other.status === ENEMY_STATUS.ALIVE && distanceSquared(enemy.x, enemy.y, other.x, other.y) <= radiusSq) {
          applyStatus(state, other, PLAGUE_SPECIAL.status, PLAGUE_SOURCE, events);
        }
      }
    }
    if (enemy.curseExplode > 0 && CURSE_SPECIAL) {
      const damage = Math.max(1, Math.floor((enemy.maxHp * enemy.curseExplode) / PERMILLE));
      if (events) events.push(EVENT.PULSE, 0, CURSE_SPECIAL.radius ?? 0, enemy.id);
      damageArea(state, enemy.x, enemy.y, CURSE_SPECIAL.radius ?? 0, damage, ELEMENT.NONE, deaths, events);
    }
    if (enemy.shatterDamage > 0) {
      if (events) events.push(EVENT.PULSE, 0, enemy.shatterRadius, enemy.id);
      damageArea(state, enemy.x, enemy.y, enemy.shatterRadius, enemy.shatterDamage, ELEMENT.ICE, deaths, events);
    }
  }
  deaths.length = 0;
}
