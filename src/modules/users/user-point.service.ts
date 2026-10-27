import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThan, MoreThan, Repository } from 'typeorm';
import { UserPointLedger } from '../../entities/UserPointLedger';
import { TETRIS_SKIN_SLOTS, TETRIS_SKIN_SLOT_KEYS, type TetrisSkinSlot } from './skin-catalog';

/** 원장 사유 — DB `USER_POINT_LEDGER.REASON`. 출석·업적 보상은 그 기능과 함께 추가 */
export const USER_POINT_REASONS = {
  /** 로그인 테트리스 기록 적립 — REF_KEY = SCORE_ID */
  TETRIS_SCORE: 'TETRIS_SCORE',
  /** 스킨 강화 소비 — REF_KEY = 슬롯 키:아이템:목표 레벨 */
  SKIN_UPGRADE: 'SKIN_UPGRADE',
} as const;

export interface UserPoints {
  /** 적립 합계 */
  earned: number;
  /** 소비 합계(양수) */
  spent: number;
  /** 쓸 수 있는 포인트 — 적립 − 소비, 0 미만이면 0 */
  balance: number;
}

/** 내역 한 줄의 구조화한 대상 — 사유별. 화면 문구는 프론트가 만들고 memo는 폴백 */
export type PointHistoryMeta =
  | { scoreId: number }
  | { slot: TetrisSkinSlot; skinId: string; level: number }
  | null;

/** 내역 한 줄 */
export interface PointHistoryItem {
  id: number;
  amount: number;
  reason: string;
  refKey: string;
  meta: PointHistoryMeta;
  memo: string | null;
  createdAt: Date;
}

export const POINT_HISTORY_TYPES = ['earn', 'spend'] as const;
export type PointHistoryType = (typeof POINT_HISTORY_TYPES)[number];

const SLOT_BY_DB_KEY = new Map(TETRIS_SKIN_SLOTS.map((slot) => [TETRIS_SKIN_SLOT_KEYS[slot], slot]));

/** REF_KEY → meta. 형식이 다르면(이후 사유·수동 데이터) null */
function metaOf(reason: string, refKey: string): PointHistoryMeta {
  if (reason === USER_POINT_REASONS.TETRIS_SCORE && /^\d+$/.test(refKey)) return { scoreId: Number(refKey) };
  if (reason === USER_POINT_REASONS.SKIN_UPGRADE) {
    const [slotKey, skinId, level] = refKey.split(':');
    const slot = SLOT_BY_DB_KEY.get(slotKey);
    if (slot && skinId && /^\d+$/.test(level ?? '')) return { slot, skinId, level: Number(level) };
  }
  return null;
}

export interface PointHistory {
  points: UserPoints;
  /** 최신순 */
  items: PointHistoryItem[];
  /** 다음 페이지 beforeId — 끝이면 null */
  nextCursor: number | null;
}

export const POINT_HISTORY_DEFAULT_LIMIT = 20;
export const POINT_HISTORY_MAX_LIMIT = 50;

export interface PointEntry {
  userId: number;
  /** 적립은 양수, 소비는 음수 — 0은 원장이 받지 않는다 */
  amount: number;
  reason: string;
  refKey: string;
  memo: string;
  crtdAt?: Date;
}

/** 로그인 테트리스 기록 1건의 적립 줄 — 소급 마이그레이션(*-BackfillTetrisScorePoints.ts)과 같은 형식 */
export function tetrisScorePointEntry(userId: number, scoreId: number, boardKey: string, score: number, crtdAt: Date): PointEntry {
  return {
    userId,
    amount: score,
    reason: USER_POINT_REASONS.TETRIS_SCORE,
    refKey: String(scoreId),
    memo: `테트리스 기록 #${scoreId} · ${boardKey} 보드 · ${score.toLocaleString('en-US')}점`,
    crtdAt,
  };
}

/**
 * 포인트 (docs/tasks/skin-levels D-004) — 원장(USER_POINT_LEDGER)이 SSOT. 적립·소비·보상이 모두 한 줄씩 남고
 * 잔액은 원장 합계다. 줄마다 REASON·REF_KEY(기계가 찾는 출처)와 MEMO(사람이 읽는 설명)가 있다
 */
@Injectable()
export class UserPointService {
  constructor(
    @InjectRepository(UserPointLedger)
    private readonly ledgerRepository: Repository<UserPointLedger>,
  ) {}

  /** manager를 넘기면 그 트랜잭션 안에서 읽는다(강화의 잔액 확인 — 사용자 행을 잠근 뒤) */
  async pointsOf(userId: number, manager?: EntityManager): Promise<UserPoints> {
    const ledger = manager?.getRepository(UserPointLedger) ?? this.ledgerRepository;
    const earned = (await ledger.sum('amount', { userId, amount: MoreThan(0) })) ?? 0;
    // 소비가 없으면 null — 0으로 두고 부호만 뒤집는다(-0이 응답에 섞이지 않게 뺄셈으로)
    const spent = 0 - ((await ledger.sum('amount', { userId, amount: LessThan(0) })) ?? 0);
    return { earned, spent, balance: Math.max(0, earned - spent) };
  }

  /**
   * 내역 (keyset, 최신순) — 정렬은 시각(CRTD_AT) 내림차순, 같은 시각은 id 내림차순.
   * 소급한 줄은 id 순서가 기록 시각과 어긋날 수 있어 시각으로 정렬한다. beforeId는 미포함이고 그 줄의 시각·id 다음부터 읽는다.
   * 없거나 다른 사용자의 id를 beforeId로 주면 빈 페이지(남의 시각을 쓰지 않고, 처음부터 다시 읽어 무한 반복하지 않게).
   * 시각은 모두 앱이 ms 단위로 넣는다(적립·소비 record, 소급은 GAME_SCORES.CRTD_AT) — 같은 시각 비교가 성립한다
   */
  async history(
    userId: number,
    { beforeId, limit = POINT_HISTORY_DEFAULT_LIMIT, type }: { beforeId?: number; limit?: number; type?: PointHistoryType },
  ): Promise<PointHistory> {
    const qb = this.ledgerRepository
      .createQueryBuilder('l')
      .select(['l.ledgerId', 'l.amount', 'l.reason', 'l.refKey', 'l.memo', 'l.crtdAt'])
      .where('l.userId = :userId', { userId });
    // 적립·소비 칩 — 커서 페이지라 서버가 거른다
    if (type === 'earn') qb.andWhere('l.amount > 0');
    if (type === 'spend') qb.andWhere('l.amount < 0');
    const anchor = beforeId === undefined ? null : await this.ledgerRepository.findOne({ select: { ledgerId: true, crtdAt: true }, where: { ledgerId: beforeId, userId } });
    if (beforeId !== undefined && !anchor) return { points: await this.pointsOf(userId), items: [], nextCursor: null };
    if (anchor) {
      qb.andWhere('(l.crtdAt < :at OR (l.crtdAt = :at AND l.ledgerId < :id))', { at: anchor.crtdAt, id: anchor.ledgerId });
    }
    // limit + 1개를 읽어 하나가 더 있으면 hasMore
    const rows = await qb.orderBy('l.crtdAt', 'DESC').addOrderBy('l.ledgerId', 'DESC').take(limit + 1).getMany();
    const page = rows.slice(0, limit);
    return {
      points: await this.pointsOf(userId),
      items: page.map((row) => ({
        id: row.ledgerId,
        amount: row.amount,
        reason: row.reason,
        refKey: row.refKey,
        meta: metaOf(row.reason, row.refKey),
        memo: row.memo,
        createdAt: row.crtdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].ledgerId : null,
    };
  }

  /** 원장 1줄 — 호출 쪽 트랜잭션 안에서. (사용자, 사유, 대상)이 이미 있으면 유니크 제약이 막는다 */
  async record(manager: EntityManager, { crtdAt = new Date(), ...entry }: PointEntry): Promise<void> {
    await manager.getRepository(UserPointLedger).insert({ ...entry, crtdAt });
  }
}
