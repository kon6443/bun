import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Equal, FindOptionsWhere, In, LessThan, Repository } from 'typeorm';
import { ApiValidationErrorResponseDto } from '../../common/dto/api-error.dto';
import { TetrisBattleMatch } from '../../entities/TetrisBattleMatch';
import { TetrisBattlePlayer } from '../../entities/TetrisBattlePlayer';
import { MATCH_ID_PATTERN, MATCH_LIST_DEFAULT_LIMIT } from './tetris-battle.constants';
import { TetrisBattleUnavailableErrorResponseDto } from './tetris-battle-error.dto';
import { TetrisBattleRoomService } from './tetris-battle-room.service';
import { BattleLobbyDto, BattleMatchListDto } from './tetris-battle-result.dto';

/** 커서 시각 상한 여유 — 서버 시계 차이를 넉넉히 덮는 1일 */
const CURSOR_FUTURE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** 커서 원문 — 직전 페이지 마지막 경기의 정렬 키 (CRTD_AT ms, MATCH_ID) */
interface MatchCursor {
  t: number;
  id: string;
}

/**
 * 커서는 불투명 문자열(base64url JSON)이다 — 클라이언트는 받은 nextCursor를 그대로 돌려줄 뿐 해석하지 않는다.
 * 형식이 틀리면 null(→ 422)
 */
export const encodeMatchCursor = (c: MatchCursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');
export const decodeMatchCursor = (raw: string): MatchCursor | null => {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<MatchCursor>;
    // 정수·0 이상·미래 1일 이내·유효한 Date만 — 범위 밖 값은 Invalid Date나 Oracle 바인드 오류(500)가 된다(리뷰 N1)
    if (typeof c.t !== 'number' || !Number.isSafeInteger(c.t) || c.t < 0 || c.t > Date.now() + CURSOR_FUTURE_LIMIT_MS) return null;
    if (Number.isNaN(new Date(c.t).getTime())) return null;
    if (typeof c.id !== 'string' || !MATCH_ID_PATTERN.test(c.id)) return null;
    return { t: c.t, id: c.id };
  } catch {
    return null;
  }
};

/**
 * 대전 입구용 조회 (docs/tasks/tetris-battle DESIGN §19, D-025) — 인증 없음, 스키마 변경 없음
 * - 로비 방 수: Redis 로비(방 서비스의 같은 정리 규칙) + 2초 캐시
 * - 최근 대전 목록: 숨김 아님(DISPUTED 포함 — tetris-audit D-004, 응답 disputed로 표시), CRTD_AT DESC·MATCH_ID DESC 키셋 커서. 쿼리 2번(경기 목록 1 + 참가자 IN 1) — N+1 없음
 */
@Injectable()
export class TetrisBattleBrowseService {
  private readonly logger = new Logger(TetrisBattleBrowseService.name);

  constructor(
    private readonly roomService: TetrisBattleRoomService,
    @InjectRepository(TetrisBattleMatch)
    private readonly matchRepository: Repository<TetrisBattleMatch>,
    @InjectRepository(TetrisBattlePlayer)
    private readonly playerRepository: Repository<TetrisBattlePlayer>,
  ) {}

  async getLobby(now = Date.now()): Promise<BattleLobbyDto> {
    const summary = await this.roomService.lobbySummary(now);
    if (!summary) throw new TetrisBattleUnavailableErrorResponseDto();
    return summary;
  }

  async listMatches({ limit = MATCH_LIST_DEFAULT_LIMIT, cursor }: { limit?: number; cursor?: string }): Promise<BattleMatchListDto> {
    const after = cursor === undefined ? null : decodeMatchCursor(cursor);
    if (cursor !== undefined && !after) throw new ApiValidationErrorResponseDto('cursor가 올바르지 않습니다.');

    // 키셋: (CRTD_AT, MATCH_ID) < (커서) — 같은 시각이면 MATCH_ID로 이어 붙인다. IDX_TB_MATCHES_CRTD(CRTD_AT)를 탄다
    // DISPUTED도 목록에 넣는다 — 검증 실패는 참가자 단위(tetris-audit D-004)
    const base: FindOptionsWhere<TetrisBattleMatch> = { isHidden: 0 };
    const where: FindOptionsWhere<TetrisBattleMatch>[] = after
      ? [
          { ...base, crtdAt: LessThan(new Date(after.t)) },
          { ...base, crtdAt: Equal(new Date(after.t)), matchId: LessThan(after.id) },
        ]
      : [base];
    // 하나 더 읽어 다음 페이지가 있는지 판단한다
    const rows = await this.matchRepository.find({
      where,
      order: { crtdAt: 'DESC', matchId: 'DESC' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    if (page.length === 0) return { items: [], nextCursor: null };

    const players = await this.playerRepository.find({
      where: { matchId: In(page.map((m) => m.matchId)) },
      select: { matchId: true, name: true, place: true },
      order: { place: 'ASC' },
    });
    const byMatch = new Map<string, { name: string; place: number }[]>();
    for (const p of players) {
      const list = byMatch.get(p.matchId) ?? [];
      list.push({ name: p.name, place: p.place });
      byMatch.set(p.matchId, list);
    }

    const items: BattleMatchListDto['items'] = [];
    for (const m of page) {
      const ranked = (byMatch.get(m.matchId) ?? []).sort((a, b) => a.place - b.place);
      const winner = ranked.find((p) => p.place === 1);
      // 계약(프론트 합의): winnerName은 항상 문자열 — 1위가 없는 경기(데이터 이상)는 목록에서 빼고 남긴다
      if (!winner) {
        this.logger.warn(`최근 대전 목록: 1위 참가자가 없는 경기 제외 — match=${m.matchId}`);
        continue;
      }
      items.push({
        matchId: m.matchId,
        roomName: m.roomName,
        playerCount: m.playerCount,
        endedAt: m.endedAt,
        disputed: m.status === 'DISPUTED',
        winnerName: winner.name,
        players: ranked,
      });
    }

    // 커서는 조회한 경기 행 기준 — 제외한 경기가 있어도 다음 페이지가 그 뒤부터 이어진다(그래서 한 페이지가 limit보다 적을 수 있다)
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: rows.length > limit ? encodeMatchCursor({ t: last.crtdAt.getTime(), id: last.matchId }) : null,
    };
  }
}
