/**
 * 증강 제시·선택 (defense DESIGN §L10·§C7) — 후보는 증강 스트림 PRNG로 뽑는다(같은 seed·같은 선택 이력 = 같은 후보)
 *   희귀도 가중치 70·25·5 · 같은 카드 중복 제시 없음(보유 카드도 제외) · 전설은 15웨이브 이후 제시부터
 *   희귀 이상이 3회 연속 안 나오면 다음 제시 첫 장을 희귀 이상으로 · 보장 규칙(켠 판만): 보유 타워 관련 카드 1장 이상
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import { AUGMENT_CHOICES, EVENT, FLAG, RNG_PURPOSE, LEGENDARY_FROM_WAVE, RARE_PITY_OFFERS, RARITY, RARITY_WEIGHTS } from './constants';
import { AUGMENT_ID, AUGMENTS, type AugmentCard } from './data/augments';
import type { Stage } from './data/stages';
import { hasFlag } from './effects';
import { fnv1a, nextRandom } from './random';
import { type GameState, towerAllowed } from './state';

function hasLockedSlot(stage: Stage): boolean {
  for (const slot of stage.map.slots) if (slot.locked) return true;
  return false;
}

function draw(state: GameState, n: number): number {
  const [next, value] = nextRandom(state.rngAugment);
  state.rngAugment = next;
  return value % n;
}

/** 이 판에서 제시할 수 있는 카드 — 보유·이미 뽑힌 카드, 판매 불가(R8)의 재활용, 주 관련 타워(towers[0])를 못 짓는 카드 제외 */
function eligible(state: GameState, stage: Stage, card: AugmentCard, legendary: boolean, picked: readonly number[]): boolean {
  if (state.augments.indexOf(card.id) >= 0 || picked.indexOf(card.id) >= 0) return false;
  if (card.rarity === RARITY.LEGENDARY && !legendary) return false;
  if (card.id === AUGMENT_ID.RECYCLE && hasFlag(state.effects, FLAG.NO_SELL)) return false;
  if (card.towers.length > 0 && !towerAllowed(state, stage, card.towers[0])) return false;
  if (card.id === AUGMENT_ID.PIONEER && !hasLockedSlot(stage)) return false; // 잠긴 슬롯이 없는 맵에선 효과가 없다
  return true;
}

/** 조건에 맞는 카드 하나를 희귀도 가중치로 뽑는다 (없으면 −1). minRarity로 희귀 이상만 */
function drawCard(state: GameState, stage: Stage, legendary: boolean, picked: readonly number[], minRarity: number, related: readonly number[] | null): number {
  const counts = [0, 0, 0];
  for (const card of AUGMENTS) {
    if (card.rarity < minRarity || !eligible(state, stage, card, legendary, picked)) continue;
    if (related && !isRelated(card, related)) continue;
    counts[card.rarity] += 1;
  }
  let total = 0;
  for (let r = 0; r < counts.length; r++) if (counts[r] > 0) total += RARITY_WEIGHTS[r];
  if (total === 0) return -1;
  let roll = draw(state, total);
  let rarity = 0;
  for (let r = 0; r < counts.length; r++) {
    if (counts[r] === 0) continue;
    if (roll < RARITY_WEIGHTS[r]) {
      rarity = r;
      break;
    }
    roll -= RARITY_WEIGHTS[r];
  }
  let index = draw(state, counts[rarity]);
  for (const card of AUGMENTS) {
    if (card.rarity !== rarity || !eligible(state, stage, card, legendary, picked)) continue;
    if (related && !isRelated(card, related)) continue;
    if (index === 0) return card.id;
    index--;
  }
  return -1;
}

function isRelated(card: AugmentCard, towerKinds: readonly number[]): boolean {
  for (const t of card.towers) if (towerKinds.indexOf(t) >= 0) return true;
  return false;
}

/** 보유 타워 종류 (지은 순서, 중복 없음) */
function ownedKinds(state: GameState): number[] {
  const kinds: number[] = [];
  for (const tower of state.towers) if (kinds.indexOf(tower.kind) < 0) kinds.push(tower.kind);
  return kinds;
}

/**
 * 증강 주기 웨이브 클리어 직후 후보 3장을 만들어 대기 상태로 들어간다. 뽑을 카드가 없으면 대기하지 않는다
 * 제시 순번(연 제시 수)만으로 정한다 — 웨이브 클리어 순서(조기 호출로 바뀔 수 있다)와 무관하게 같은 seed·같은 선택 이력 = 같은 후보(§L10)
 *   전설: 이 제시가 정상 순서라면 열렸을 웨이브(순번 × 주기)가 15 이상일 때
 */
export function offerAugments(state: GameState, stage: Stage): void {
  const order = state.offersOpened;
  state.offersOpened += 1;
  const legendary = (order + 1) * state.augmentEvery >= LEGENDARY_FROM_WAVE;
  // 제시마다 독립 스트림 — 한 제시 안의 뽑기 수(보장 규칙 등)가 다음 제시들을 밀지 않게
  state.rngAugment = fnv1a([state.seed, RNG_PURPOSE.AUGMENT, order]);
  const choices: number[] = [];
  const pity = state.offersWithoutRare >= RARE_PITY_OFFERS;
  for (let i = 0; i < AUGMENT_CHOICES; i++) {
    let id = pity && i === 0 ? drawCard(state, stage, legendary, choices, RARITY.RARE, null) : -1;
    // 희귀 이상이 남지 않았으면 그 자리는 일반 뽑기 (보장이 제시 전체를 막지 않게)
    if (id < 0) id = drawCard(state, stage, legendary, choices, RARITY.COMMON, null);
    if (id < 0) break;
    choices.push(id);
  }
  if (state.augmentGuarantee && choices.length > 0) {
    const owned = ownedKinds(state);
    let covered = owned.length === 0;
    for (const id of choices) if (isRelated(AUGMENTS[id], owned)) covered = true;
    if (!covered) {
      // 마지막 장을 보유 타워 관련 카드로 바꾼다(희귀 보장 장은 첫 장이라 건드리지 않는다)
      const last = choices.length - 1;
      const id = drawCard(state, stage, legendary, choices, RARITY.COMMON, owned);
      if (id >= 0 && !(pity && last === 0)) choices[last] = id;
    }
  }
  if (choices.length === 0) return;
  let rare = false;
  for (const id of choices) if (AUGMENTS[id].rarity >= RARITY.RARE) rare = true;
  state.offersWithoutRare = rare ? 0 : state.offersWithoutRare + 1;
  state.augmentChoices = choices;
  state.augmentPending = true;
}

/**
 * PICK_AUGMENT — 후보 index를 골라 효과를 활성 목록 끝에 붙인다. 수행할 수 없으면 false
 * 목숨 대가(할인 계약)는 최소 1을 남긴다 — 제시 여부를 목숨에 걸면 같은 seed·같은 선택 이력에서 후보가 달라진다(§L10·주간 공정성)
 */
export function pickAugment(state: GameState, index: number, events: number[] | null): boolean {
  if (!state.augmentPending || index < 0 || index >= state.augmentChoices.length) return false;
  const card = AUGMENTS[state.augmentChoices[index]];
  for (const e of card.effects) state.effects.push(e);
  if (card.livesCost > 0) state.lives = Math.max(1, state.lives - card.livesCost);
  state.augments.push(card.id);
  state.augmentChoices = [];
  state.augmentPending = false;
  if (events) events.push(EVENT.AUGMENT, card.id, state.augments.length - 1, 0);
  return true;
}
