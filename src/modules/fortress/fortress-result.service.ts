import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DataSource, EntityManager, Equal, FindOptionsWhere, In, LessThan, QueryFailedError, Repository } from 'typeorm';
import { ApiValidationErrorResponseDto } from '../../common/dto/api-error.dto';
import { toErrorDetail } from '../../common/utils/error.utils';
import { FortressMatch, FortressMatchMode, FortressResultKind } from '../../entities/FortressMatch';
import { FortressPlayer } from '../../entities/FortressPlayer';
import { FortressReplay } from '../../entities/FortressReplay';
import { User } from '../../entities/User';
// 커서 형식(base64url JSON { t, id })·검증은 테트리스 대전 최근 목록과 같다 — 순수 함수만 가져온다(테트리스 파일은 바꾸지 않는다)
import { decodeMatchCursor, encodeMatchCursor } from '../tetris-battle/tetris-battle-browse.service';
import { type Action, type MatchConfig, ENGINE_VERSION } from './engine';
import { FortressMatchService } from './fortress-match.service';
import { type BaseAward, baseAwards, playedTurns, realShotsBySlot } from './fortress-points.rules';
import { FortressMatchPoints, FortressPointsService } from './fortress-points.service';
import { storedTankSkin } from './fortress-skins';
import { FortressMatchStore, StoredMatch } from './fortress-match.store';
import {
  LAZY_SAVE_POLL_INTERVAL_MS,
  LAZY_SAVE_WAIT_MAX_MS,
  MATCH_ID_PATTERN,
  MATCH_LIST_DEFAULT_LIMIT,
  PENDING_SAVE_RETRY_MS,
  PENDING_SAVE_SWEEP_ENVS,
  PENDING_SAVE_SWEEP_LIMIT,
} from './fortress.constants';
import { FortressMatchNotFoundErrorResponseDto, FortressReplayNotFoundErrorResponseDto } from './fortress-error.dto';
import { FortressMatchDto, FortressMatchListDto, FortressReplayDto } from './fortress-result.dto';
import type { FortressTankSkin, MatchSlot } from './fortress.events';

/** 리플레이 slot — 계약 MatchSlot + 경기 시작 때 고정한 탱크 스킨(F7, DESIGN §13). F7 전에 저장된 본문에는 skin이 없다 */
type ReplaySlot = Omit<MatchSlot, 'skin'> & { skin?: FortressTankSkin };

/** DB REPLAY 컬럼의 gzip 본문 — engineVersion은 컬럼에 따로 둔다 */
interface StoredReplayBody {
  config: MatchConfig;
  actions: Action[];
  slots: ReplaySlot[];
  stateHash: string;
}

/** 저장 1회의 결과 — 크론이 저장 대기를 지울지(saved·missing) 미룰지(그 밖) 정한다 */
export type SaveOutcome = 'saved' | 'missing' | 'not-ended' | 'busy' | 'failed';

/** 경기 1건을 DB 행으로 옮긴 값 — 트랜잭션 밖에서 만든다(엔진·집계 계산을 트랜잭션에 두지 않게) */
interface MatchRecord {
  match: Omit<FortressMatch, 'crtdAt'>;
  players: FortressPlayer[];
  replay: Omit<FortressReplay, 'crtdAt'>;
  /** F7 포인트 — 경기 하나만 보고 정한 로그인 참가자별 기본 적립(감쇠·상한은 트랜잭션 안에서) */
  awards: BaseAward[];
}

/** Oracle 드라이버 에러 번호 — 메시지 문자열이 아니라 번호로 판정한다(테트리스 tetris-audit BE-13과 같은 방식) */
const oraErrorNum = (error: unknown): number | undefined =>
  error instanceof QueryFailedError ? (error.driverError as { errorNum?: number } | undefined)?.errorNum : undefined;
/** ORA-00001 유니크(PK) 위반 — 다른 저장이 먼저 넣었다 */
const isUniqueViolation = (error: unknown): boolean => oraErrorNum(error) === 1;
/** ORA-02291 FK 위반 — 그 사이 탈퇴한 USER_ID */
const isForeignKeyViolation = (error: unknown): boolean => oraErrorNum(error) === 2291;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toTeam = (value: number | null | undefined): 0 | 1 | null => (value === 0 || value === 1 ? value : null);

/**
 * 포트리스 경기 결과·리플레이 저장과 조회 (docs/tasks/fortress DESIGN §12, F6)
 *
 * - 저장: 경기를 끝낸 레플리카가 방송 뒤 바로(saveHook) · 저장 대기 크론(QA·PROD + TASK_SLOT 1) · 결과 조회 lazy — 셋 다 같은 멱등 경로
 *   saveIfEnded. 완료 표시(:saved)·진행 가드(:saving SET NX)·트랜잭션 안 "경기 행이 있으면 건너뜀"·PK 위반 = 이미 저장으로 정확히 1번
 * - 원본은 Redis 경기 JSON(config·actions·state·tally) — 서버가 경기 중 확정한 값이라 클라이언트 제출·검증이 없다(테트리스와 다름)
 * - 조회: 인증 없음(게스트 공개), 숨김(IS_HIDDEN) 제외. replay id = matchId
 */
@Injectable()
export class FortressResultService {
  private readonly logger = new Logger(FortressResultService.name);
  private readonly store = new FortressMatchStore();
  /** 저장 대기 크론을 이 레플리카에서 돌리는지 — ENV 화이트리스트 + TASK_SLOT 1 (data-access 스케줄러 2단 가드) */
  private readonly runsPendingSaveSweep: boolean;

  constructor(
    private readonly matchService: FortressMatchService,
    @InjectRepository(FortressMatch)
    private readonly matchRepository: Repository<FortressMatch>,
    @InjectRepository(FortressPlayer)
    private readonly playerRepository: Repository<FortressPlayer>,
    @InjectRepository(FortressReplay)
    private readonly replayRepository: Repository<FortressReplay>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    configService: ConfigService,
    private readonly pointsService: FortressPointsService,
  ) {
    const env = configService.get<string>('ENV')?.toUpperCase() ?? '';
    const taskSlot = Number(configService.get<number>('TASK_SLOT')) || 1;
    this.runsPendingSaveSweep = PENDING_SAVE_SWEEP_ENVS.includes(env) && taskSlot === 1;
    this.matchService.setSaveHook(async (matchId) => {
      await this.saveIfEnded(matchId);
    });
  }

  // ==================== 저장 ====================

  /**
   * 저장 대기 크론 — 처리 시각이 지난 경기를 저장한다. 저장됐거나 경기 키가 사라졌으면 대기에서 빼고(saveIfEnded가 뺀다),
   * 그 밖(진행 중·다른 레플리카가 저장 중·실패)은 뒤로 미뤄 다른 대기 경기가 앞 20개에 막히지 않게 한다
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'fortressPendingSaves' })
  async sweepPendingSaves(now = Date.now()): Promise<void> {
    if (!this.runsPendingSaveSweep) return;
    const redis = this.matchService.readyRedisClient();
    if (!redis) return;
    try {
      const due = await this.store.duePendingSaves(redis, now, PENDING_SAVE_SWEEP_LIMIT);
      for (const matchId of due) {
        const outcome = await this.saveIfEnded(matchId, now);
        if (outcome !== 'saved' && outcome !== 'missing') await this.store.markPendingSave(redis, matchId, now + PENDING_SAVE_RETRY_MS);
      }
    } catch (error) {
      this.logger.warn('포트리스 저장 대기 스윕 실패', toErrorDetail(error));
    }
  }

  /**
   * 끝난 경기를 DB에 정확히 1번 저장한다. 던지지 않는다(방송 뒤·크론·조회 경로).
   *  1. 완료 표시(:saved)면 끝 — 대기에서 뺀다
   *  2. 경기 키가 없으면(TTL) 저장할 원본이 없다 — 대기에서 뺀다(missing)
   *  3. 진행 중이면 건너뛴다(끝내는 CAS에 진 행동이 대기에 넣은 경우 — 실제로 끝날 때 다시 들어온다)
   *  4. 진행 가드(SET NX) → 트랜잭션 저장 → 완료 표시 → 대기에서 뺀다. 실패하면 가드만 풀고 대기는 남긴다(크론·조회가 다시)
   */
  async saveIfEnded(matchId: string, now = Date.now()): Promise<SaveOutcome> {
    const redis = this.matchService.readyRedisClient();
    if (!redis) return 'failed';
    try {
      if (await this.store.isSaved(redis, matchId)) {
        await this.store.clearPendingSave(redis, matchId);
        return 'saved';
      }
      const loaded = await this.store.load(redis, matchId);
      if (!loaded) {
        await this.store.clearPendingSave(redis, matchId);
        return 'missing';
      }
      if (loaded.match.status !== 'ENDED') return 'not-ended';
      if (!(await this.store.claimSave(redis, matchId))) return 'busy';
      try {
        await this.persist(this.toRecord(loaded.match, now));
        await this.store.markSaved(redis, matchId);
        await this.store.clearPendingSave(redis, matchId);
        return 'saved';
      } finally {
        await this.store.releaseSave(redis, matchId).catch(() => undefined);
      }
    } catch (error) {
      this.logger.error(`포트리스 결과 저장 실패 — 저장 대기 크론·조회 때 재시도: match=${matchId}`, toErrorDetail(error));
      return 'failed';
    }
  }

  /** Redis 경기 → DB 행. 집계·순위는 matchEnded 방송과 같은 함수(endedPayload)라 화면과 저장 값이 같다 */
  private toRecord(match: StoredMatch, now: number): MatchRecord {
    const { result } = match.state;
    if (result.kind === 'ongoing') throw new Error(`끝나지 않은 경기 state: match=${match.matchId}`);
    const engineVersion = match.engineVersion ?? ENGINE_VERSION;
    const entries = this.matchService.endedPayload(match).players;
    const body: StoredReplayBody = {
      config: match.config,
      actions: match.actions,
      slots: match.slots.map((s) => ({ slot: s.slot, playerId: s.playerId, name: s.name, skin: storedTankSkin(s.skin) })),
      stateHash: match.stateHash,
    };
    return {
      match: {
        matchId: match.matchId,
        // Oracle은 ''를 NULL로 다룬다 — 모르면 NULL(기능 배포 전에 시작한 경기)
        roomName: match.roomName || null,
        mode: match.config.mode satisfies FortressMatchMode,
        mapId: match.config.mapId,
        seed: match.config.seed,
        engineVersion,
        playerCount: match.slots.length,
        turns: match.state.turn.no,
        resultKind: result.kind satisfies FortressResultKind,
        winnerTeam: match.config.mode === 'team' && result.kind === 'win' ? toTeam(result.team) : null,
        startedAt: new Date(match.startedAt),
        endedAt: new Date(match.endedAt ?? now),
        isHidden: 0,
      },
      players: entries.map((e) => ({
        matchId: match.matchId,
        playerId: e.playerId,
        slot: e.slot,
        name: e.name,
        userId: match.slots.find((s) => s.slot === e.slot)?.userId ?? null,
        team: e.team,
        tankId: match.config.players.find((p) => p.slot === e.slot)?.tankId ?? 0,
        hp: e.hp,
        damage: e.damage,
        kos: e.kos,
        place: e.place,
      })),
      replay: {
        matchId: match.matchId,
        engineVersion,
        replay: gzipSync(JSON.stringify(body)),
      },
      awards: this.awardsOf(match, entries),
    };
  }

  /**
   * F7 기본 적립(DESIGN §13) — 로그인 참가자가 없으면 엔진 재적용을 하지 않는다. 재적용(최대 수십 ms)은 트랜잭션 밖에서 한다.
   * 로그인 = 시작 때 slots[].userId(소급 없음), 기권 = 그 slot의 resign 행동(이탈·끊김 유예 초과)
   */
  private awardsOf(match: StoredMatch, entries: { slot: number; kos: number }[]): BaseAward[] {
    if (!match.slots.some((s) => typeof s.userId === 'number')) return [];
    const shots = realShotsBySlot(match.config, match.actions);
    const resigned = new Set(match.actions.flatMap((a) => (a.kind === 'resign' ? [a.slot] : [])));
    return baseAwards({
      matchId: match.matchId,
      turns: playedTurns(match.state),
      result: match.state.result,
      players: match.slots.map((s) => ({
        playerId: s.playerId,
        slot: s.slot,
        userId: typeof s.userId === 'number' ? s.userId : null,
        kos: entries.find((e) => e.slot === s.slot)?.kos ?? 0,
        realShots: shots[s.slot] ?? 0,
        resigned: resigned.has(s.slot),
      })),
    });
  }

  /**
   * 트랜잭션 저장. 이미 저장된 경기(완료 표시 유실·가드 만료 경합)는 건너뛰고, 동시에 넣다 유니크 위반이면 경기 행이 실제로 있을 때만
   * 이미 저장으로 본다(리뷰 A2 — 참가자·원장 유니크 위반이면 다시 던져 저장 대기에 남긴다).
   * 그 사이 탈퇴한 사용자(FK 위반)면 그 USER_ID만 비우고 1번 더(테트리스 리뷰 L6) — 탈퇴해도 경기 기록은 이름으로 남긴다
   */
  private async persist(record: MatchRecord): Promise<void> {
    try {
      await this.writeInTransaction(record);
    } catch (error) {
      if (isUniqueViolation(error) && (await this.matchRowExists(record.match.matchId))) return;
      if (!isForeignKeyViolation(error)) throw error;
      const missing = await this.missingUserIds(record.players);
      if (missing.size === 0) throw error;
      this.logger.warn(`포트리스 결과 저장: 없는 USER_ID ${[...missing].join(',')}를 비우고 재시도 — match=${record.match.matchId}`);
      const players = record.players.map((p) => (p.userId !== null && missing.has(p.userId) ? { ...p, userId: null } : p));
      try {
        await this.writeInTransaction({ ...record, players });
      } catch (retryError) {
        if (!isUniqueViolation(retryError) || !(await this.matchRowExists(record.match.matchId))) throw retryError;
      }
    }
  }

  /** 유니크 위반을 "이미 저장"으로 볼 근거 — 다른 저장이 경기 행을 커밋했다(리뷰 A2) */
  private async matchRowExists(matchId: string): Promise<boolean> {
    return this.matchRepository.exists({ where: { matchId } });
  }

  private async writeInTransaction(record: MatchRecord): Promise<void> {
    await this.dataSource.transaction(async (manager: EntityManager) => {
      const existing = await manager.findOne(FortressMatch, { where: { matchId: record.match.matchId }, select: { matchId: true } });
      if (existing) return;
      // 행 단위 save — 테트리스 대전 저장과 같은 방식(Oracle 다중 행 INSERT·BLOB 바인딩을 운영에서 검증된 경로로)
      const crtdAt = new Date();
      await manager.save(manager.create(FortressMatch, { ...record.match, crtdAt }));
      for (const player of record.players) await manager.save(manager.create(FortressPlayer, player));
      await manager.save(manager.create(FortressReplay, { ...record.replay, crtdAt }));
      // F7 포인트(DESIGN §13) — 같은 트랜잭션: 경기 저장과 적립이 함께 커밋·롤백, 경기 행이 이미 있으면 위에서 끝나 두 번 적립하지 않는다
      await this.pointsService.awardInTransaction(manager, record.match.matchId, record.awards, crtdAt);
    });
  }

  /** 행에 들어갈 USER_ID 중 USERS에 없는 것 */
  private async missingUserIds(players: FortressPlayer[]): Promise<Set<number>> {
    const ids = [...new Set(players.map((p) => p.userId).filter((id): id is number => id !== null))];
    if (ids.length === 0) return new Set();
    const existing = await this.userRepository.find({ where: { userId: In(ids) }, select: { userId: true } });
    const found = new Set(existing.map((u) => u.userId));
    return new Set(ids.filter((id) => !found.has(id)));
  }

  // ==================== 조회 ====================

  async getMatch(matchId: string, now = Date.now()): Promise<FortressMatchDto> {
    const match = await this.findVisibleMatch(matchId, now);
    const players = await this.playerRepository.find({ where: { matchId }, order: { place: 'ASC', slot: 'ASC' } });
    return {
      matchId: match.matchId,
      roomName: match.roomName,
      mode: match.mode,
      mapId: match.mapId,
      seed: match.seed,
      engineVersion: match.engineVersion,
      playerCount: match.playerCount,
      turns: match.turns,
      result: { kind: match.resultKind, team: toTeam(match.winnerTeam) },
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      players: players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        slot: p.slot,
        team: toTeam(p.team),
        tankId: p.tankId,
        hp: p.hp,
        damage: p.damage,
        kos: p.kos,
        place: p.place,
      })),
    };
  }

  async getReplay(matchId: string, now = Date.now()): Promise<FortressReplayDto> {
    await this.findVisibleMatch(matchId, now);
    const row = await this.replayRepository.findOne({ where: { matchId } });
    if (!row) throw new FortressReplayNotFoundErrorResponseDto();
    const body = JSON.parse(gunzipSync(row.replay).toString('utf8')) as StoredReplayBody;
    // F7 전에 저장된 리플레이는 skin이 없다 — default로 채운다
    const slots = body.slots.map((s) => ({ slot: s.slot, playerId: s.playerId, name: s.name, skin: storedTankSkin(s.skin) }));
    return { matchId, engineVersion: row.engineVersion, ...body, slots };
  }

  /** 이 경기에서 내가 얻은 포인트(로그인 전용, DESIGN §13) — 끝났는데 저장 전이면 그 자리에서 저장한 뒤(적립도 같은 트랜잭션) 읽는다 */
  async getMyPoints(matchId: string, userId: number, now = Date.now()): Promise<FortressMatchPoints> {
    await this.findVisibleMatch(matchId, now);
    return this.pointsService.pointsOf(matchId, userId);
  }

  /**
   * 숨김 아닌 저장된 경기. DB에 없으면 Redis에 끝난 경기가 있는지 보고 그 자리에서 저장한 뒤 다시 읽는다 —
   * matchEnded 직후 결과·공유 화면이 저장보다 먼저 와도 404가 나지 않게(replay id를 방송 때 미리 주므로)
   */
  private async findVisibleMatch(matchId: string, now: number): Promise<FortressMatch> {
    if (!MATCH_ID_PATTERN.test(matchId)) throw new FortressMatchNotFoundErrorResponseDto();
    const found = await this.matchRepository.findOne({ where: { matchId, isHidden: 0 } });
    if (found) return found;
    const outcome = await this.saveIfEnded(matchId, now);
    if (outcome === 'busy') return this.waitForSavedMatch(matchId);
    if (outcome !== 'saved') throw new FortressMatchNotFoundErrorResponseDto();
    const saved = await this.matchRepository.findOne({ where: { matchId, isHidden: 0 } });
    if (!saved) throw new FortressMatchNotFoundErrorResponseDto();
    return saved;
  }

  /** 다른 레플리카가 지금 저장 중(busy) — 상한까지 짧은 간격으로 DB 행을 기다린다(리뷰 A1). 끝내 없으면 404 */
  private async waitForSavedMatch(matchId: string): Promise<FortressMatch> {
    for (let waited = 0; waited < LAZY_SAVE_WAIT_MAX_MS; waited += LAZY_SAVE_POLL_INTERVAL_MS) {
      await sleep(LAZY_SAVE_POLL_INTERVAL_MS);
      const saved = await this.matchRepository.findOne({ where: { matchId, isHidden: 0 } });
      if (saved) return saved;
    }
    throw new FortressMatchNotFoundErrorResponseDto();
  }

  /**
   * 최근 경기 목록 — 숨김 아님, CRTD_AT DESC·MATCH_ID DESC 키셋 커서(IDX_FT_MATCHES_CRTD). 쿼리 2번(경기 1 + 참가자 IN 1) — N+1 없음.
   * 테트리스 대전 최근 목록(tetris-battle-browse.service.ts)과 같은 방식
   */
  async listMatches({ limit = MATCH_LIST_DEFAULT_LIMIT, cursor }: { limit?: number; cursor?: string }): Promise<FortressMatchListDto> {
    const after = cursor === undefined ? null : decodeMatchCursor(cursor);
    if (cursor !== undefined && !after) throw new ApiValidationErrorResponseDto('cursor가 올바르지 않습니다.');

    const base: FindOptionsWhere<FortressMatch> = { isHidden: 0 };
    const where: FindOptionsWhere<FortressMatch>[] = after
      ? [
          { ...base, crtdAt: LessThan(new Date(after.t)) },
          { ...base, crtdAt: Equal(new Date(after.t)), matchId: LessThan(after.id) },
        ]
      : [base];
    // 하나 더 읽어 다음 페이지가 있는지 판단한다
    const rows = await this.matchRepository.find({ where, order: { crtdAt: 'DESC', matchId: 'DESC' }, take: limit + 1 });
    const page = rows.slice(0, limit);
    if (page.length === 0) return { items: [], nextCursor: null };

    const players = await this.playerRepository.find({
      where: { matchId: In(page.map((m) => m.matchId)) },
      select: { matchId: true, name: true, slot: true, team: true, place: true },
      order: { place: 'ASC', slot: 'ASC' },
    });
    const byMatch = new Map<string, FortressMatchListDto['items'][number]['players']>();
    for (const p of players) {
      const list = byMatch.get(p.matchId) ?? [];
      list.push({ name: p.name, slot: p.slot, team: toTeam(p.team), place: p.place });
      byMatch.set(p.matchId, list);
    }

    const last = page[page.length - 1];
    return {
      items: page.map((m) => ({
        matchId: m.matchId,
        roomName: m.roomName,
        mode: m.mode,
        mapId: m.mapId,
        playerCount: m.playerCount,
        turns: m.turns,
        result: { kind: m.resultKind, team: toTeam(m.winnerTeam) },
        endedAt: m.endedAt,
        players: (byMatch.get(m.matchId) ?? []).sort((a, b) => a.place - b.place || a.slot - b.slot),
      })),
      nextCursor: rows.length > limit ? encodeMatchCursor({ t: last.crtdAt.getTime(), id: last.matchId }) : null,
    };
  }
}
