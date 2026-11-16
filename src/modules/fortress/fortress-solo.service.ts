import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { FortressMatch } from '../../entities/FortressMatch';
import { FortressPlayer } from '../../entities/FortressPlayer';
import { FortressReplay } from '../../entities/FortressReplay';
import { type Action, ENGINE_VERSION, type MatchConfig, type MatchState, applyAction, createMatch, stateHash } from './engine';
import { FortressSoloEngineMismatchErrorResponseDto, FortressSoloReplayInvalidErrorResponseDto } from './fortress-error.dto';
import { computePlaces, createTally, tallyAction, type MatchTally } from './fortress-match.rules';
import type { StoredReplayBody } from './fortress-result.service';
import { FortressSkinService } from './fortress-skin.service';
import { defaultTankSkin } from './fortress-skins';
import { MATCH_ID_BYTES } from './fortress.constants';
import type { FortressTankSkin } from './fortress.events';
import { SoloAiLevel, UploadSoloMatchDto } from './fortress-solo.dto';

/** AI 난이도 표시 — 프론트 AI전 이름("P2 (AI 중)")과 같은 표기 */
const AI_LEVEL_LABEL: Record<SoloAiLevel, string> = { 0: '하', 1: '중', 2: '상' };

/** 검증 실패 사유 — FortressSoloReplayInvalid의 details.reason */
type InvalidReason = 'CONFIG' | 'ACTION' | 'NOT_ENDED' | 'HASH';

const invalid = (reason: InvalidReason, at?: number): Error =>
  new FortressSoloReplayInvalidErrorResponseDto({ details: at === undefined ? { reason } : { reason, at } });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * 클라이언트 행동을 엔진 Action 모양으로만 옮긴다 — 모르는 필드는 버리고(저장 본문에 남지 않게), 값 판정은 엔진이 한다.
 * kind를 모르면 null
 */
function toAction(raw: unknown): Action | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case 'fire':
      return { kind: 'fire', move: raw.move as number, angle: raw.angle as number, power: raw.power as number, weaponId: raw.weaponId as number };
    case 'skip':
      return { kind: 'skip' };
    case 'resign':
      return { kind: 'resign', slot: raw.slot as number };
    default:
      return null;
  }
}

/** 처음부터 다시 돌린 결과 — 마지막 상태와 slot별 집계 */
interface Replayed {
  final: MatchState;
  tally: MatchTally;
}

/**
 * AI전·같은 기기 대전 기록 업로드 (docs/tasks/fortress DECISIONS D-027).
 *
 * 온라인 경기는 서버가 턴마다 판정하지만, AI전은 클라이언트에서만 돈다. 그래서 올린 기록을 서버 엔진 사본으로 처음부터 다시 돌려
 * "규칙에 맞게 끝난 경기"인지만 확인하고 저장한다(설정·행동 검증 → 끝났는지 → 마지막 stateHash 대조).
 * 사람이 AI 쪽 수를 직접 짜 넣은 기록도 규칙에 맞으면 통과한다 — 그래서 포인트·랭킹·최근 목록과 분리하고 공유 링크로만 쓴다.
 *
 * - 이름·스킨은 서버가 정한다(자유 텍스트를 받지 않는다): 사람 P{n} · AI P{n} (AI 하·중·상). 스킨은 로그인이면 첫 사람 자리만 계정 장착, 나머지 기본
 * - 계정과 연결하지 않는다(USER_ID 모두 NULL) — 포인트 계산·내 경기 집계에 섞이지 않게
 * - 같은 기록을 다시 올리면 새 matchId로 또 저장된다(중복 판별 없음) — 빈도 제한이 상한
 */
@Injectable()
export class FortressSoloService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly skinService: FortressSkinService,
  ) {}

  async upload(input: UploadSoloMatchDto, userId: number | null, now = Date.now()): Promise<{ matchId: string }> {
    if (input.engineVersion !== ENGINE_VERSION) throw new FortressSoloEngineMismatchErrorResponseDto();

    const config: MatchConfig = {
      seed: input.config.seed,
      mapId: input.config.mapId,
      mode: input.config.mode,
      players: input.config.players.map((p) => ({ slot: p.slot, team: p.team, tankId: p.tankId })),
    };
    const configSlots = config.players.map((p) => p.slot).sort((a, b) => a - b);
    // slot은 0..n−1이 한 번씩 — 온라인 경기와 같은 모양(엔진은 중복·범위만 본다, 리뷰 S2). 화면·playerId(p{slot+1})가 이 모양을 가정한다
    const contiguous = configSlots.every((slot, i) => slot === i);
    const slotKinds = [...input.slots].sort((a, b) => a.slot - b.slot);
    const sameSlots = slotKinds.length === configSlots.length && slotKinds.every((s, i) => s.slot === configSlots[i]);
    const kindsValid = slotKinds.every((s) => (s.kind === 'ai') === (s.aiLevel !== undefined));
    if (!contiguous || !sameSlots || !kindsValid) throw invalid('CONFIG');

    const actions = input.actions.map(toAction);
    const badIndex = actions.indexOf(null);
    if (badIndex >= 0) throw invalid('ACTION', badIndex);
    const checked = actions as Action[];

    const { final, tally } = this.replay(config, checked);
    if (final.result.kind === 'ongoing') throw invalid('NOT_ENDED');
    if (stateHash(final) !== input.stateHash) throw invalid('HASH');

    const humanSkin = userId === null ? defaultTankSkin() : await this.skinService.tankSkinOf(userId);
    const firstHuman = slotKinds.find((s) => s.kind === 'human')?.slot;
    const slots = slotKinds.map((s) => ({
      slot: s.slot,
      playerId: `p${s.slot + 1}`,
      name: s.kind === 'ai' && s.aiLevel !== undefined ? `P${s.slot + 1} (AI ${AI_LEVEL_LABEL[s.aiLevel]})` : `P${s.slot + 1}`,
      skin: s.slot === firstHuman ? humanSkin : defaultTankSkin(),
    }));

    const matchId = randomBytes(MATCH_ID_BYTES).toString('base64url');
    await this.save(matchId, config, checked, final, tally, slots, now);
    return { matchId };
  }

  /** 엔진으로 처음부터 다시 돌린다 — 설정 오류 CONFIG, 규칙 위반 ACTION(행동 인덱스). 온라인 경기 집계와 같은 tallyAction */
  private replay(config: MatchConfig, actions: readonly Action[]): Replayed {
    const created = createMatch(config);
    if (!created.ok) throw invalid('CONFIG');
    let state = created.state;
    let tally = createTally(state);
    for (let i = 0; i < actions.length; i++) {
      const applied = applyAction(state, actions[i]);
      if (!applied.ok) throw invalid('ACTION', i);
      tally = tallyAction(tally, state, actions[i], applied.events, i);
      state = applied.state;
    }
    return { final: state, tally };
  }

  /** 경기·참가자·리플레이 한 트랜잭션 — 온라인 저장(fortress-result.service writeInTransaction)과 같은 행 모양, 포인트 없음 */
  private async save(
    matchId: string,
    config: MatchConfig,
    actions: Action[],
    final: MatchState,
    tally: MatchTally,
    slots: { slot: number; playerId: string; name: string; skin: FortressTankSkin }[],
    now: number,
  ): Promise<void> {
    const { result } = final;
    const places = computePlaces(final, tally);
    const at = new Date(now);
    const body: StoredReplayBody = { config, actions, slots, stateHash: stateHash(final) };
    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.save(
        manager.create(FortressMatch, {
          matchId,
          roomName: null,
          mode: config.mode,
          mapId: config.mapId,
          seed: config.seed,
          engineVersion: ENGINE_VERSION,
          playerCount: slots.length,
          turns: final.turn.no,
          resultKind: result.kind === 'win' ? 'win' : 'draw',
          winnerTeam: config.mode === 'team' && result.kind === 'win' && (result.team === 0 || result.team === 1) ? result.team : null,
          // 클라이언트 시각은 믿지 않는다 — 시작 시각을 모르므로 올린 시각으로 둔다(소요 시간은 표시하지 않는다)
          startedAt: at,
          endedAt: at,
          source: 'solo',
          isHidden: 0,
          crtdAt: at,
        }),
      );
      for (const s of slots) {
        const tank = final.tanks[s.slot];
        const team = config.mode === 'team' && (tank?.team === 0 || tank?.team === 1) ? tank.team : null;
        await manager.save(
          manager.create(FortressPlayer, {
            matchId,
            playerId: s.playerId,
            slot: s.slot,
            name: s.name,
            userId: null,
            team,
            tankId: config.players.find((p) => p.slot === s.slot)?.tankId ?? 0,
            hp: tank?.hp ?? 0,
            damage: tally[s.slot]?.damage ?? 0,
            kos: tally[s.slot]?.kos ?? 0,
            place: places[s.slot] ?? slots.length,
          }),
        );
      }
      await manager.save(manager.create(FortressReplay, { matchId, engineVersion: ENGINE_VERSION, replay: gzipSync(JSON.stringify(body)), crtdAt: at }));
    });
  }
}
