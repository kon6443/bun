import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, timingSafeEqual } from 'crypto';
import type { Redis } from 'ioredis';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DataSource, EntityManager, In, QueryFailedError, Repository } from 'typeorm';
import { toErrorDetail } from '../../common/utils/error.utils';
import { TetrisBattleMatch } from '../../entities/TetrisBattleMatch';
import { TetrisBattlePlayer, TetrisBattleVerdict } from '../../entities/TetrisBattlePlayer';
import { TetrisBattleReplay } from '../../entities/TetrisBattleReplay';
import { User } from '../../entities/User';
import { BATTLE_ENGINE_VERSION } from './battle-engine';
import { FRAMES_PER_SECOND } from '../games/tetris-engine';
import {
  GARBAGE_TAIL_GRACE_MS,
  SURVIVOR_FRAME_SLACK,
  MATCH_ID_PATTERN,
  MATCH_START_DELAY_MS,
  PENDING_SAVE_RETRY_MS,
  PENDING_SAVE_SWEEP_ENVS,
  PENDING_SAVE_SWEEP_LIMIT,
  REPLAY_SUBMIT_DEADLINE_MS,
  WAKE_MARGIN_MS,
} from './tetris-battle.constants';
import {
  TetrisBattleMatchNotEndedErrorResponseDto,
  TetrisBattleMatchNotFoundErrorResponseDto,
  TetrisBattlePlayerTokenInvalidErrorResponseDto,
  TetrisBattleReplayAlreadySubmittedErrorResponseDto,
  TetrisBattleReplayNotFoundErrorResponseDto,
  TetrisBattleSubmissionClosedErrorResponseDto,
  TetrisBattleUnavailableErrorResponseDto,
} from './tetris-battle-error.dto';
import { MatchPlayerSnapshot, MatchSnapshot, TetrisBattleMatchStore } from './tetris-battle-match.store';
import { TetrisBattleRoomService } from './tetris-battle-room.service';
import { BattleMatchDto, BattleReplayDetailDto, BattleReplayDto } from './tetris-battle-result.dto';
import { VerificationContext, verifyBattleReplay } from './tetris-battle-verify';
import { defaultSkinSet, parseBoardSkins, toBoardSkins } from '../users/skin-catalog';

/** Redis 제출 기록 (DB 저장 전까지) */
interface StoredSubmission {
  verdict: 'VERIFIED' | 'INVALID';
  reason: string | null;
  /** 제출 요청의 로그인 사용자 (없으면 null → 방 입장 때 신원) */
  userId: number | null;
  battleEngineVersion: number;
  /** gzip(JSON {seed, das, arr, frames, inputs, garbage, garbageFrom}) base64 */
  replay: string;
}

/** DB REPLAY 컬럼의 gzip 본문 — battleEngineVersion은 컬럼에 따로 둔다 */
interface StoredReplayBody {
  seed: number;
  das: number;
  arr: number;
  frames: number;
  inputs: number[];
  garbage: number[];
  /**
   * 받은 가비지별 공격자 playerId — `garbage`의 이벤트 순서와 같다(서버 가비지 로그의 from, 모르면 null).
   * 다시보기의 "누가 누구에게" 연출용(games-polish D-006). 도입 전 기록에는 없다
   */
  garbageFrom?: (string | null)[];
}

const PLAYER_ID_PATTERN = /^p\d{1,6}$/;

/** 리플레이 가비지 이벤트([deltaFrame, id, lines, hole, ...]) 순서대로 서버 로그의 공격자를 붙인다 — 로그에 없는 id는 null */
const garbageSenders = (garbage: readonly number[], log: readonly { id: number; from?: string | null }[]): (string | null)[] => {
  const fromById = new Map(log.map((g) => [g.id, g.from ?? null]));
  const senders: (string | null)[] = [];
  for (let i = 0; i + 3 < garbage.length; i += 4) senders.push(fromById.get(garbage[i + 1]) ?? null);
  return senders;
};
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** Oracle FK 위반(ORA-02291) — 메시지 문자열이 아니라 드라이버 에러 번호로 판정한다(tetris-audit BE-13) */
const isForeignKeyViolation = (error: unknown): boolean =>
  error instanceof QueryFailedError && (error.driverError as { errorNum?: number } | undefined)?.errorNum === 2291;


/**
 * 테트리스 대전 경기 후 검증·결과 저장·조회 (docs/tasks/tetris-battle DESIGN §17, D-021)
 *
 * - 제출: playerToken(매치 시작 때 복사한 토큰 해시)으로 참가자 확인 → 리플레이 검증(tetris-battle-verify.ts) →
 *   Redis에 1번만 기록(HSETNX) → 전원 제출이면 DB 저장
 * - 저장: 전원 제출 또는 종료 후 60초 마감 뒤 첫 제출·조회·깨우기(D-009) 때 1번(Redis SET NX 가드 — 멀티 레플리카).
 *   미제출은 MISSING. INVALID가 하나라도 있으면 경기 DISPUTED(표시용). 저장 실패면 가드를 풀어 다음 계기에 다시 시도한다
 * - 조회: 숨김 아님이면 DISPUTED도 공개(tetris-audit D-004 — 검증 실패는 참가자 단위). 재생은 VERIFIED 참가자만
 */
@Injectable()
export class TetrisBattleResultService {
  private readonly logger = new Logger(TetrisBattleResultService.name);
  private readonly matches = new TetrisBattleMatchStore();
  /** 저장 대기 스윕을 이 레플리카에서 돌리는지 — ENV 화이트리스트 + TASK_SLOT 1 (data-access 스케줄러 2단 가드) */
  private readonly runsPendingSaveSweep: boolean;

  constructor(
    private readonly roomService: TetrisBattleRoomService,
    @InjectRepository(TetrisBattleMatch)
    private readonly matchRepository: Repository<TetrisBattleMatch>,
    @InjectRepository(TetrisBattlePlayer)
    private readonly playerRepository: Repository<TetrisBattlePlayer>,
    @InjectRepository(TetrisBattleReplay)
    private readonly replayRepository: Repository<TetrisBattleReplay>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    configService: ConfigService,
  ) {
    const env = configService.get<string>('ENV')?.toUpperCase() ?? '';
    const taskSlot = Number(configService.get<number>('TASK_SLOT')) || 1;
    this.runsPendingSaveSweep = PENDING_SAVE_SWEEP_ENVS.includes(env) && taskSlot === 1;

    // 마감이 지나면 한 번 깨워 저장한다 — 미제출자가 있고 아무도 조회하지 않아도 Redis TTL 전에 DB에 남게(D-009·BE-06).
    // 타이머는 레플리카 메모리라 재시작하면 사라진다 → Redis 저장 대기에도 올려 스윕이 대신 깨운다(games-polish BT-05)
    this.roomService.setMatchFinishedListener((matchId) => {
      const delayMs = REPLAY_SUBMIT_DEADLINE_MS + WAKE_MARGIN_MS;
      this.roomService.scheduleWake(() => this.finalizeIfDue(matchId, Date.now()), delayMs);
      void this.markPendingSave(matchId, Date.now() + delayMs);
    });
  }

  private async markPendingSave(matchId: string, dueAt: number): Promise<void> {
    const redis = this.roomService.readyRedisClient();
    if (!redis) return;
    try {
      await this.matches.markPendingSave(redis, matchId, dueAt);
    } catch (error) {
      this.logger.warn(`저장 대기 등록 실패: match=${matchId}`, toErrorDetail(error));
    }
  }

  /**
   * 저장 대기 스윕 — 마감이 지난 매치를 저장하고, 저장됐거나 매치가 사라졌으면 대기에서 뺀다.
   * 저장 자체는 finalize의 SET NX 가드로 1번이라 다른 계기(제출·조회·깨우기)와 겹쳐도 안전하다
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'tetrisBattlePendingSaves' })
  async sweepPendingSaves(now = Date.now()): Promise<void> {
    if (!this.runsPendingSaveSweep) return;
    const redis = this.roomService.readyRedisClient();
    if (!redis) return;
    try {
      const due = await this.matches.duePendingSaves(redis, now, PENDING_SAVE_SWEEP_LIMIT);
      for (const matchId of due) {
        await this.finalizeIfDue(matchId, now);
        if ((await this.matches.isSaved(redis, matchId)) || !(await this.matches.exists(redis, matchId))) {
          await this.matches.clearPendingSave(redis, matchId);
        } else {
          // 아직 저장 못 함(마감 전·저장 실패) — 뒤로 미뤄 다른 대기 매치가 앞 20개에 막히지 않게 한다
          await this.matches.markPendingSave(redis, matchId, now + PENDING_SAVE_RETRY_MS);
        }
      }
    } catch (error) {
      this.logger.warn('저장 대기 스윕 실패', toErrorDetail(error));
    }
  }

  // ==================== 제출 ====================

  async submitReplay({
    matchId,
    playerToken,
    replay,
    userId,
    now = Date.now(),
  }: {
    matchId: string;
    playerToken: string;
    replay: BattleReplayDto;
    userId: number | null;
    now?: number;
  }): Promise<{ verdict: 'VERIFIED' | 'INVALID' }> {
    if (!MATCH_ID_PATTERN.test(matchId)) throw new TetrisBattleMatchNotFoundErrorResponseDto();
    const redis = this.requireRedis();

    const snap = await this.matches.snapshot(redis, matchId);
    if (!snap) {
      // Redis 기록이 TTL로 사라졌다 — 이미 저장된 경기면 마감, 아니면 없는 경기
      if (await this.matchRepository.findOne({ where: { matchId } })) throw new TetrisBattleSubmissionClosedErrorResponseDto();
      throw new TetrisBattleMatchNotFoundErrorResponseDto();
    }
    if (snap.status !== 'ENDED') throw new TetrisBattleMatchNotEndedErrorResponseDto();

    const player = this.findPlayerByToken(snap, playerToken);
    if (!player) throw new TetrisBattlePlayerTokenInvalidErrorResponseDto();

    if (this.isPastDeadline(snap, now)) {
      // 마감 뒤 첫 제출이 저장 계기가 된다(제출 자체는 받지 않는다)
      await this.finalize(redis, snap);
      throw new TetrisBattleSubmissionClosedErrorResponseDto();
    }
    // 시뮬레이션 전에 싸게 거른다 — 최종 1회 보장은 아래 HSETNX
    // 이미 낸 사람은 닫힌 뒤에도 409(재제출) — 닫힘(410)은 아직 내지 않은 사람에게만
    if ((await this.matches.submissions(redis, matchId))[player.playerId]) {
      throw new TetrisBattleReplayAlreadySubmittedErrorResponseDto();
    }
    if (await this.matches.isClosed(redis, matchId)) throw new TetrisBattleSubmissionClosedErrorResponseDto();
    // 같은 제출을 동시에 여러 개 보내도 시뮬레이션은 하나만(BE-08). 늦은 쪽은 503(잠시 후 재시도) —
    // 409(이미 제출)로 답하면 앞선 요청이 실패했을 때 클라이언트가 완료로 보고 재시도를 멈춰 MISSING이 된다(리뷰 R1)
    if (!(await this.matches.claimVerification(redis, matchId, player.playerId))) {
      throw new TetrisBattleUnavailableErrorResponseDto();
    }
    try {
      return await this.verifyAndRecord(redis, snap, player, replay, userId);
    } finally {
      await this.matches.releaseVerification(redis, matchId, player.playerId).catch(() => undefined);
    }
  }

  private async verifyAndRecord(
    redis: Redis,
    snap: MatchSnapshot,
    player: MatchPlayerSnapshot,
    replay: BattleReplayDto,
    userId: number | null,
  ): Promise<{ verdict: 'VERIFIED' | 'INVALID' }> {
    const { matchId } = snap;
    const context = await this.verificationContext(redis, snap, player);
    const result = verifyBattleReplay(replay, context);
    if (result.verdict === 'INVALID') {
      this.logger.warn(`대전 리플레이 검증 실패: match=${matchId}, player=${player.playerId}, reason=${result.reason}`);
    }

    const body: StoredReplayBody = {
      seed: replay.seed,
      das: replay.das,
      arr: replay.arr,
      frames: replay.frames,
      inputs: replay.inputs,
      garbage: replay.garbage,
      garbageFrom: garbageSenders(replay.garbage, context.garbage),
    };
    const record: StoredSubmission = {
      verdict: result.verdict,
      reason: result.verdict === 'INVALID' ? result.reason : null,
      userId,
      battleEngineVersion: replay.battleEngineVersion,
      replay: gzipSync(JSON.stringify(body)).toString('base64'),
    };
    const claimed = await this.matches.claimSubmission(redis, matchId, player.playerId, JSON.stringify(record));
    // 저장이 목록을 이미 확정했으면(전원 제출·마감) 이 제출은 저장되지 않는다 → 201 대신 410(리뷰 L2)
    if (claimed === 'CLOSED') throw new TetrisBattleSubmissionClosedErrorResponseDto();
    if (claimed === 'DUPLICATE') throw new TetrisBattleReplayAlreadySubmittedErrorResponseDto();

    const submitted = await this.matches.submissions(redis, matchId);
    if (this.expectedSubmitters(snap).every((p) => submitted[p.playerId])) await this.finalize(redis, snap);
    return { verdict: result.verdict };
  }

  // ==================== 조회 ====================

  async getMatch(matchId: string, now = Date.now()): Promise<BattleMatchDto> {
    if (!MATCH_ID_PATTERN.test(matchId)) throw new TetrisBattleMatchNotFoundErrorResponseDto();
    await this.finalizeIfDue(matchId, now);

    // 검증 실패는 참가자 단위(D-004) — DISPUTED 경기도 공개하고, INVALID 참가자는 verdict로 표시·재생 제외
    const match = await this.matchRepository.findOne({ where: { matchId, isHidden: 0 } });
    if (!match) throw new TetrisBattleMatchNotFoundErrorResponseDto();
    const players = await this.playerRepository.find({ where: { matchId }, order: { place: 'ASC' } });
    return {
      matchId: match.matchId,
      roomName: match.roomName,
      playerCount: match.playerCount,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      disputed: match.status === 'DISPUTED',
      players: players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        place: p.place,
        kos: p.kos,
        sent: p.sent,
        received: p.received,
        pieces: p.pieces,
        maxCombo: p.maxCombo,
        frames: p.frames,
        koReason: p.koReason,
        verdict: p.verdict,
        // 그 경기 당시의 보드 스킨(D-006) — 기능 전 경기는 default
        skins: parseBoardSkins(p.boardSkins) ?? toBoardSkins(defaultSkinSet()),
      })),
    };
  }

  async getReplay(matchId: string, playerId: string): Promise<BattleReplayDetailDto> {
    if (!MATCH_ID_PATTERN.test(matchId)) throw new TetrisBattleMatchNotFoundErrorResponseDto();
    if (!PLAYER_ID_PATTERN.test(playerId)) throw new TetrisBattleReplayNotFoundErrorResponseDto();

    const match = await this.matchRepository.findOne({ where: { matchId, isHidden: 0 } });
    if (!match) throw new TetrisBattleMatchNotFoundErrorResponseDto();
    const player = await this.playerRepository.findOne({ where: { matchId, playerId } });
    if (!player || player.verdict !== 'VERIFIED') throw new TetrisBattleReplayNotFoundErrorResponseDto();
    const row = await this.replayRepository.findOne({ where: { matchId, playerId } });
    if (!row) throw new TetrisBattleReplayNotFoundErrorResponseDto();

    const body = JSON.parse(gunzipSync(row.replay).toString('utf8')) as StoredReplayBody;
    return { matchId, playerId, battleEngineVersion: row.battleEngineVersion, ...body };
  }

  // ==================== 내부 ====================

  private requireRedis(): Redis {
    const redis = this.roomService.readyRedisClient();
    if (!redis) throw new TetrisBattleUnavailableErrorResponseDto();
    return redis;
  }

  /** 토큰 해시를 참가자 전원과 상수 시간 비교 */
  private findPlayerByToken(snap: MatchSnapshot, playerToken: string): MatchPlayerSnapshot | null {
    const candidate = Buffer.from(sha256Hex(playerToken), 'hex');
    return (
      snap.players.find((p) => {
        if (!p.tokenHash) return false;
        const stored = Buffer.from(p.tokenHash, 'hex');
        return stored.length === candidate.length && timingSafeEqual(stored, candidate);
      }) ?? null
    );
  }

  /**
   * 예상 제출자 = 로컬 판이 끝까지 있었던 참가자: 생존자 + topout 탈락자(D-022).
   * 끊김·기권 탈락자는 제출하지 않는 것이 보통이라 기다리지 않는다(내면 받는다 — 마감 전이면)
   */
  private expectedSubmitters(snap: MatchSnapshot): MatchPlayerSnapshot[] {
    return snap.players.filter((p) => p.alive || p.koReason === 'topout');
  }

  private isPastDeadline(snap: MatchSnapshot, now: number): boolean {
    return snap.endedAt !== null && now > snap.endedAt + REPLAY_SUBMIT_DEADLINE_MS;
  }

  private async verificationContext(
    redis: Redis,
    snap: MatchSnapshot,
    player: MatchPlayerSnapshot,
  ): Promise<VerificationContext> {
    // 생존자 frames 상한: 서버 시계(Redis TIME) 기준 경과 시간 — 없으면(옛 기록) 앱 시계로 대신한다
    const elapsedMs =
      snap.clockStart !== null && snap.endedClock !== null
        ? snap.endedClock - snap.clockStart
        : (snap.endedAt ?? snap.startedAt) - snap.startedAt - MATCH_START_DELAY_MS;
    const elapsedFrames = Math.floor((elapsedMs * FRAMES_PER_SECOND) / 1000);
    const [garbage, sentLog] = await Promise.all([
      this.matches.garbageLog(redis, snap.matchId, player.playerId),
      this.matches.sentLog(redis, snap.matchId, player.playerId),
    ]);
    // 막판 가비지 누락 허용 경계(D-022): 탈락자는 탈락 시각, 생존자는 종료 시각 − 1초(서버 Redis 시계)
    const boundary = player.alive ? snap.endedClock : player.koClock;
    return {
      seed: snap.seed,
      garbage,
      requiredBefore: boundary === null ? null : boundary - GARBAGE_TAIL_GRACE_MS,
      sentLog,
      lastSeq: player.seq,
      ko: player.alive || !player.koReason ? null : { reason: player.koReason, frame: player.frames ?? player.frame },
      maxFrames: elapsedFrames + SURVIVOR_FRAME_SLACK,
      // 동시 탑아웃(D-006): 생존자의 탈락이 종료 시각 ± 여유 안이면 서버가 정한 순서(상대 먼저 KO)를 따른다
      lateTopOutFrom: player.alive ? elapsedFrames - SURVIVOR_FRAME_SLACK : null,
    };
  }

  /** 조회 계기의 저장 — 마감이 지났으면. Redis를 못 쓰면 건너뛴다(조회는 DB만으로 된다) */
  private async finalizeIfDue(matchId: string, now: number): Promise<void> {
    const redis = this.roomService.readyRedisClient();
    if (!redis) return;
    try {
      // 이미 저장된 경기의 조회가 대부분이다 — 매치 Hash 전체(HGETALL) 대신 저장 표시(HEXISTS)부터 본다(games-polish BT-09)
      if (await this.matches.isSaved(redis, matchId)) return;
      const snap = await this.matches.snapshot(redis, matchId);
      if (snap && snap.status === 'ENDED' && this.isPastDeadline(snap, now)) await this.finalize(redis, snap);
    } catch (error) {
      this.logger.warn(`조회 계기 저장 확인 실패: match=${matchId}`, toErrorDetail(error));
    }
  }

  /**
   * DB 저장 — 정확히 1번. 순서(리뷰 L2·L8):
   *  1. 이미 저장 완료(__saved)면 끝
   *  2. 저장 진행 가드(SET NX, 짧은 TTL) — 동시에 두 저장이 돌지 않게. 저장 중 프로세스가 죽어도 TTL 뒤 다음 계기가 다시 잡는다
   *  3. 제출을 **닫고** 그 순간의 목록을 확정(Lua) — 이후 제출은 410. 그래서 201을 받은 제출은 반드시 이 저장에 포함된다
   *  4. 트랜잭션 저장 → __saved 표시
   * 실패하면 가드를 풀어 다음 제출·조회가 다시 시도한다(닫힘은 유지 — 같은 목록으로 다시 저장).
   * 던지지 않는다: 제출 응답(검증 결과)은 저장 성공과 무관하다.
   */
  private async finalize(redis: Redis, snap: MatchSnapshot): Promise<void> {
    if (await this.matches.isSaved(redis, snap.matchId)) return;
    if (!(await this.matches.claimSave(redis, snap.matchId))) return;
    try {
      const raw = await this.matches.closeSubmissions(redis, snap.matchId, Date.now());
      const subs = new Map(Object.entries(raw).map(([pid, json]) => [pid, JSON.parse(json) as StoredSubmission]));
      try {
        await this.saveRows(snap, subs, new Set());
      } catch (error) {
        // 그 사이 탈퇴한 사용자(FK 위반)면 그 USER_ID만 비우고 1번 더(리뷰 L6) — 탈퇴해도 경기 기록은 이름으로 남긴다
        if (!isForeignKeyViolation(error)) throw error;
        const missing = await this.missingUserIds(snap, subs);
        if (missing.size === 0) throw error;
        this.logger.warn(`대전 결과 저장: 없는 USER_ID ${[...missing].join(',')}를 비우고 재시도 — match=${snap.matchId}`);
        await this.saveRows(snap, subs, missing);
      }
      await this.matches.markSaved(redis, snap.matchId);
    } catch (error) {
      this.logger.error(`대전 결과 저장 실패 — 다음 제출·조회 때 재시도: match=${snap.matchId}`, toErrorDetail(error));
      await this.matches.releaseSave(redis, snap.matchId).catch(() => undefined);
    }
  }

  private userIdOf(p: MatchPlayerSnapshot, subs: Map<string, StoredSubmission>): number | null {
    return subs.get(p.playerId)?.userId ?? p.userId;
  }

  /** 행에 들어갈 USER_ID 중 USERS에 없는 것 */
  private async missingUserIds(snap: MatchSnapshot, subs: Map<string, StoredSubmission>): Promise<Set<number>> {
    const ids = [...new Set(snap.players.map((p) => this.userIdOf(p, subs)).filter((id): id is number => id !== null))];
    if (ids.length === 0) return new Set();
    const existing = await this.userRepository.find({ where: { userId: In(ids) }, select: { userId: true } });
    const found = new Set(existing.map((u) => u.userId));
    return new Set(ids.filter((id) => !found.has(id)));
  }

  private async saveRows(
    snap: MatchSnapshot,
    subs: Map<string, StoredSubmission>,
    nullUserIds: Set<number>,
  ): Promise<void> {
    const verdictOf = (pid: string): TetrisBattleVerdict => subs.get(pid)?.verdict ?? 'MISSING';
    const status = snap.players.some((p) => verdictOf(p.playerId) === 'INVALID') ? 'DISPUTED' : 'VERIFIED';
    await this.dataSource.transaction(async (manager: EntityManager) => {
      // 재저장(앞선 시도가 일부 남은 경우 save는 UPDATE가 된다)이면 기존 CRTD_AT를 지킨다 — 최근 대전 목록의 정렬 키라
      // 바뀌면 커서 페이지가 어긋난다(리뷰 N2). 처음이면 지금
      const existing = await manager.findOne(TetrisBattleMatch, { where: { matchId: snap.matchId }, select: { matchId: true, crtdAt: true } });
      const crtdAt = existing?.crtdAt ?? new Date();
      await manager.save(
        manager.create(TetrisBattleMatch, {
          matchId: snap.matchId,
          roomName: snap.roomName,
          seed: snap.seed,
          playerCount: snap.players.length,
          status,
          startedAt: new Date(snap.startedAt),
          endedAt: new Date(snap.endedAt ?? snap.startedAt),
          isHidden: 0,
          crtdAt,
        }),
      );
      for (const p of snap.players) {
        const userId = this.userIdOf(p, subs);
        await manager.save(
          manager.create(TetrisBattlePlayer, {
            matchId: snap.matchId,
            playerId: p.playerId,
            name: p.name,
            userId: userId !== null && nullUserIds.has(userId) ? null : userId,
            place: p.place ?? snap.players.length,
            kos: p.kos,
            sent: p.sent,
            received: p.received,
            pieces: p.pieces,
            maxCombo: p.maxCombo,
            frames: p.frames ?? p.frame,
            koReason: p.alive ? null : p.koReason,
            verdict: verdictOf(p.playerId),
            // 시작 시점 스킨이 없는 경기(배포 직전에 시작)는 NULL — 조회 때 default
            boardSkins: p.skins ? JSON.stringify(p.skins) : null,
          }),
        );
      }
      for (const [playerId, sub] of subs) {
        if (!snap.players.some((p) => p.playerId === playerId)) continue;
        await manager.save(
          manager.create(TetrisBattleReplay, {
            matchId: snap.matchId,
            playerId,
            // 버전은 서버 상수 — 제출 DTO가 같은 값만 받는다(리뷰 L1)
            battleEngineVersion: BATTLE_ENGINE_VERSION,
            replay: Buffer.from(sub.replay, 'base64'),
            crtdAt,
          }),
        );
      }
    });
  }
}
