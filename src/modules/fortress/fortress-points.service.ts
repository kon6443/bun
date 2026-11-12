import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, MoreThanOrEqual, Repository } from 'typeorm';
import { FortressMatch } from '../../entities/FortressMatch';
import { FortressPlayer } from '../../entities/FortressPlayer';
import { User } from '../../entities/User';
import { UserPointLedger } from '../../entities/UserPointLedger';
// KST 오늘 00:00(UTC Date) — 순수 함수만 가져온다(games 모듈 파일은 바꾸지 않는다)
import { rankingPeriodStart } from '../games/ranking-period';
import { USER_POINT_REASONS, UserPointService } from '../users/user-point.service';
import { type BaseAward, finalAward, fortressPointRefKey } from './fortress-points.rules';

/** 결과 화면용 — 이 경기에서 내가 얻은 포인트 */
export interface FortressMatchPoints {
  matchId: string;
  /** 내가 로그인 상태로 참가했는지(시작 때 기준) — false면 earned 0 */
  participant: boolean;
  /** 원장 금액 — 적립이 없으면(무효 경기·기권·상한 소진) 0 */
  earned: number;
  /** 원장 메모(참가·승리·KO·감쇠·상한 내역) — 적립이 없으면 null */
  memo: string | null;
}

/**
 * 포트리스 경기 포인트 적립 (docs/tasks/fortress DESIGN §13, D-006) — 결과 저장 트랜잭션(FortressResultService.writeInTransaction) 안에서 부른다.
 * 경기 행·참가자 행을 넣은 뒤, 로그인 참가자 USERS 행을 userId 오름차순으로 잠그고(레플리카가 달라도 같은 사용자의 적립·강화가 줄 선다,
 * 같은 순서라 교착 없음) 오늘(KST) 합계·같은 조합 경기 수를 읽어 감쇠·상한을 정한 뒤 원장에 1줄씩 넣는다
 */
@Injectable()
export class FortressPointsService {
  constructor(
    private readonly userPointService: UserPointService,
    @InjectRepository(FortressPlayer)
    private readonly playerRepository: Repository<FortressPlayer>,
    @InjectRepository(UserPointLedger)
    private readonly ledgerRepository: Repository<UserPointLedger>,
  ) {}

  /** 트랜잭션 안 — `crtdAt`은 이 저장의 경기 행 CRTD_AT(원장 CRTD_AT도 같은 값, KST 하루 판정 기준) */
  async awardInTransaction(manager: EntityManager, matchId: string, awards: readonly BaseAward[], crtdAt: Date): Promise<void> {
    if (awards.length === 0) return;
    const userIds = [...new Set(awards.map((a) => a.userId))].sort((a, b) => a - b);
    const present = await this.lockUsers(manager, userIds);
    const dayStart = rankingPeriodStart('daily', crtdAt) as Date;
    const sameCombo = await this.sameComboCounts(manager, matchId, awards, dayStart);
    const ledger = manager.getRepository(UserPointLedger);

    for (const award of [...awards].sort((a, b) => a.userId - b.userId)) {
      // 그 사이 탈퇴(USERS 행 없음) — 원장 FK가 막으므로 건너뛴다(경기 기록은 USER_ID 없이 남는다, §12)
      if (!present.has(award.userId)) continue;
      const earnedToday =
        (await ledger.sum('amount', { userId: award.userId, reason: USER_POINT_REASONS.FORTRESS_MATCH, crtdAt: MoreThanOrEqual(dayStart) })) ?? 0;
      const nth = (sameCombo.get(award.userId) ?? 0) + 1;
      const { amount, memo } = finalAward(matchId, award, nth, earnedToday);
      if (amount <= 0) continue;
      await this.userPointService.record(manager, {
        userId: award.userId,
        amount,
        reason: USER_POINT_REASONS.FORTRESS_MATCH,
        refKey: fortressPointRefKey(matchId, award.playerId),
        memo,
        crtdAt,
      });
    }
  }

  /** 이 경기에서 내가 얻은 포인트 — 경기 저장 뒤에 부른다 */
  async pointsOf(matchId: string, userId: number): Promise<FortressMatchPoints> {
    const seat = await this.playerRepository.findOne({ where: { matchId, userId }, select: { playerId: true } });
    if (!seat) return { matchId, participant: false, earned: 0, memo: null };
    const row = await this.ledgerRepository.findOne({
      where: { userId, reason: USER_POINT_REASONS.FORTRESS_MATCH, refKey: fortressPointRefKey(matchId, seat.playerId) },
      select: { amount: true, memo: true },
    });
    return { matchId, participant: true, earned: row?.amount ?? 0, memo: row?.memo ?? null };
  }

  /**
   * USERS 행 잠금 — 1명씩 오름차순(같은 순서라 두 경기 저장이 서로 기다리며 교착하지 않는다). 있는 userId 집합을 돌려준다.
   * findOne/take를 쓰지 않는다 — Oracle은 row-limit 절과 FOR UPDATE를 함께 쓸 수 없다(ORA-02014, 스킨 강화와 같은 방식)
   */
  private async lockUsers(manager: EntityManager, sortedUserIds: readonly number[]): Promise<Set<number>> {
    const present = new Set<number>();
    for (const userId of sortedUserIds) {
      const locked = await manager
        .createQueryBuilder(User, 'user')
        .select('user.userId')
        .setLock('pessimistic_write')
        .where('user.userId = :userId', { userId })
        .getMany();
      if (locked.length > 0) present.add(userId);
    }
    return present;
  }

  /**
   * 사용자별 "오늘(KST, 경기 행 CRTD_AT 기준) 이미 저장된 같은 조합 경기 수" — 조합 = 나 외 로그인 참가자 집합.
   * 쿼리 1번: 오늘 경기(IDX_FT_MATCHES_CRTD) × 내 자리 × 같은 경기의 다른 로그인 자리. 이 경기는 뺀다(이미 같은 트랜잭션에 넣었다).
   * 무효였던 경기도 센다(보수적 — DESIGN §13). 조합이 빈 사용자(로그인 상대 없음)는 감쇠 대상이 아니라 세지 않는다
   */
  private async sameComboCounts(manager: EntityManager, matchId: string, awards: readonly BaseAward[], dayStart: Date): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    const targets = awards.filter((a) => a.others.length > 0);
    if (targets.length === 0) return counts;
    const rows = await manager
      .createQueryBuilder(FortressPlayer, 'me')
      .select('me.matchId', 'matchId')
      .addSelect('me.userId', 'userId')
      .addSelect('o.userId', 'otherId')
      .innerJoin(FortressMatch, 'm', 'm.matchId = me.matchId')
      .innerJoin(FortressPlayer, 'o', 'o.matchId = me.matchId AND o.playerId <> me.playerId AND o.userId IS NOT NULL')
      .where('me.userId IN (:...userIds)', { userIds: targets.map((a) => a.userId) })
      .andWhere('m.crtdAt >= :dayStart', { dayStart })
      .andWhere('me.matchId <> :matchId', { matchId })
      .getRawMany<{ matchId: string; userId: number | string; otherId: number | string }>();

    // (사용자, 경기) → 그 경기의 나 외 로그인 참가자
    const othersByUserMatch = new Map<string, { userId: number; others: Set<number> }>();
    for (const row of rows) {
      const userId = Number(row.userId);
      const key = `${userId}:${row.matchId}`;
      const entry = othersByUserMatch.get(key) ?? { userId, others: new Set<number>() };
      entry.others.add(Number(row.otherId));
      othersByUserMatch.set(key, entry);
    }
    const comboKey = (ids: Iterable<number>) => [...ids].sort((a, b) => a - b).join(',');
    const wanted = new Map(targets.map((a) => [a.userId, comboKey(a.others)]));
    for (const { userId, others } of othersByUserMatch.values()) {
      if (wanted.get(userId) === comboKey(others)) counts.set(userId, (counts.get(userId) ?? 0) + 1);
    }
    return counts;
  }
}
