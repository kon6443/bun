import { Logger } from '@nestjs/common';
import { Equal, In, LessThan } from 'typeorm';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { TetrisBattleMatch } from '../../entities/TetrisBattleMatch';
import { TetrisBattlePlayer } from '../../entities/TetrisBattlePlayer';
import { decodeMatchCursor, encodeMatchCursor, TetrisBattleBrowseService } from './tetris-battle-browse.service';
import { TetrisBattleRoomService } from './tetris-battle-room.service';

const id = (n: number) => `match${String(n).padStart(11, '0')}`; // 16자
const T = (n: number) => new Date(Date.UTC(2026, 9, 22, 0, 0, n));
const match = (n: number, crtdAt = T(n)): TetrisBattleMatch =>
  ({ matchId: id(n), roomName: `방${n}`, playerCount: 2, endedAt: T(n), crtdAt, status: 'VERIFIED', isHidden: 0 }) as TetrisBattleMatch;
const BASE = { isHidden: 0, status: 'VERIFIED' };

/**
 * 최근 대전 목록(D-025) — 키셋 커서(CRTD_AT DESC, MATCH_ID DESC). 정렬·숨김/DISPUTED 제외는 쿼리 조건으로 걸리고,
 * 여기서는 그 조건이 정확히 만들어지는지(=DB에 맡긴 부분)와 페이지 경계·커서 왕복·참가자 묶기·잘못된 커서를 본다.
 */
describe('TetrisBattleBrowseService', () => {
  let service: TetrisBattleBrowseService;
  let matchRepository: MockRepository<TetrisBattleMatch>;
  let playerRepository: MockRepository<TetrisBattlePlayer>;
  let lobbyCounts: jest.Mock;

  beforeEach(() => {
    matchRepository = createMockRepository<TetrisBattleMatch>();
    playerRepository = createMockRepository<TetrisBattlePlayer>();
    lobbyCounts = jest.fn();
    service = new TetrisBattleBrowseService(
      { lobbyCounts } as unknown as TetrisBattleRoomService,
      matchRepository as never,
      playerRepository as never,
    );
  });

  describe('listMatches', () => {
    it('첫 페이지: VERIFIED·숨김 아님 조건, CRTD_AT DESC·MATCH_ID DESC, limit+1개 조회 · 참가자는 IN 1번(N+1 없음)', async () => {
      matchRepository.find.mockResolvedValueOnce([match(3), match(2)]);
      playerRepository.find.mockResolvedValueOnce([
        { matchId: id(3), name: '가', place: 2 },
        { matchId: id(3), name: '나', place: 1 },
        { matchId: id(2), name: '다', place: 1 },
        { matchId: id(2), name: '라', place: 2 },
      ] as TetrisBattlePlayer[]);

      const data = await service.listMatches({ limit: 5 });

      expect(matchRepository.find).toHaveBeenCalledWith({ where: [BASE], order: { crtdAt: 'DESC', matchId: 'DESC' }, take: 6 });
      expect(playerRepository.find).toHaveBeenCalledTimes(1);
      expect(playerRepository.find).toHaveBeenCalledWith({
        where: { matchId: In([id(3), id(2)]) },
        select: { matchId: true, name: true, place: true },
        order: { place: 'ASC' },
      });
      expect(data).toEqual({
        items: [
          { matchId: id(3), roomName: '방3', playerCount: 2, endedAt: T(3), winnerName: '나', players: [{ name: '나', place: 1 }, { name: '가', place: 2 }] },
          { matchId: id(2), roomName: '방2', playerCount: 2, endedAt: T(2), winnerName: '다', players: [{ name: '다', place: 1 }, { name: '라', place: 2 }] },
        ],
        nextCursor: null, // limit보다 적게 왔다 → 마지막 페이지
      });
    });

    it('limit 기본 10 (11개 조회)', async () => {
      matchRepository.find.mockResolvedValueOnce([]);
      await service.listMatches({});
      expect(matchRepository.find).toHaveBeenCalledWith(expect.objectContaining({ take: 11 }));
    });

    it('limit보다 많으면 limit개만 주고 마지막 경기로 nextCursor — 커서를 돌려주면 그 뒤부터(같은 시각은 MATCH_ID로)', async () => {
      const winners = (...ns: number[]) => ns.map((n) => ({ matchId: id(n), name: `우승${n}`, place: 1 })) as TetrisBattlePlayer[];
      matchRepository.find.mockResolvedValueOnce([match(5), match(4), match(3)]);
      playerRepository.find.mockResolvedValueOnce(winners(5, 4));

      const first = await service.listMatches({ limit: 2 });

      expect(first.items.map((i) => i.matchId)).toEqual([id(5), id(4)]);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(decodeMatchCursor(first.nextCursor as string)).toEqual({ t: T(4).getTime(), id: id(4) });

      matchRepository.find.mockResolvedValueOnce([match(3)]);
      playerRepository.find.mockResolvedValueOnce(winners(3));
      const second = await service.listMatches({ limit: 2, cursor: first.nextCursor as string });

      expect(matchRepository.find).toHaveBeenLastCalledWith({
        where: [
          { ...BASE, crtdAt: LessThan(T(4)) },
          { ...BASE, crtdAt: Equal(T(4)), matchId: LessThan(id(4)) },
        ],
        order: { crtdAt: 'DESC', matchId: 'DESC' },
        take: 3,
      });
      expect(second).toMatchObject({ items: [{ matchId: id(3) }], nextCursor: null });
    });

    it('정확히 limit개면 다음 페이지 없음(nextCursor null)', async () => {
      matchRepository.find.mockResolvedValueOnce([match(2), match(1)]);
      playerRepository.find.mockResolvedValueOnce([]);
      await expect(service.listMatches({ limit: 2 })).resolves.toMatchObject({ nextCursor: null });
    });

    it('빈 목록: items [], nextCursor null, 참가자 조회 없음', async () => {
      matchRepository.find.mockResolvedValueOnce([]);
      await expect(service.listMatches({ limit: 3 })).resolves.toEqual({ items: [], nextCursor: null });
      expect(playerRepository.find).not.toHaveBeenCalled();
    });

    it('1위 참가자가 없는 경기(데이터 이상)는 목록에서 빼고 경고 — winnerName은 항상 문자열, 커서는 조회 행 기준', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      matchRepository.find.mockResolvedValueOnce([match(3), match(2), match(1)]);
      playerRepository.find.mockResolvedValueOnce([
        { matchId: id(3), name: '가', place: 1 },
        { matchId: id(2), name: '나', place: 2 }, // 2번 경기는 1위 없음
      ] as TetrisBattlePlayer[]);

      const data = await service.listMatches({ limit: 2 });

      expect(data.items.map((i) => [i.matchId, i.winnerName])).toEqual([[id(3), '가']]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(id(2)));
      expect(decodeMatchCursor(data.nextCursor as string)).toEqual({ t: T(2).getTime(), id: id(2) });
      warn.mockRestore();
    });

    it.each([
      ['base64가 아닌 문자열', '!!!'],
      ['JSON이 아님', Buffer.from('nope').toString('base64url')],
      ['matchId 형식 위반', encodeMatchCursor({ t: 1, id: 'short' })],
      ['음수 시각', Buffer.from(JSON.stringify({ t: -1, id: id(1) })).toString('base64url')],
      ['시각이 문자열', Buffer.from(JSON.stringify({ t: '1', id: id(1) })).toString('base64url')],
      ['시각 9e15(Invalid Date, 리뷰 N1)', Buffer.from(JSON.stringify({ t: 9e15, id: id(1) })).toString('base64url')],
      ['시각 3e14(먼 미래 — Oracle 범위 밖, 리뷰 N1)', Buffer.from(JSON.stringify({ t: 3e14, id: id(1) })).toString('base64url')],
    ])('잘못된 cursor(%s) → 422 VALIDATION_ERROR, 조회하지 않는다', async (_label, cursor) => {
      await expect(service.listMatches({ cursor })).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
      expect(matchRepository.find).not.toHaveBeenCalled();
    });

    it('커서 인코딩 왕복', () => {
      const c = { t: T(9).getTime(), id: id(9) };
      expect(decodeMatchCursor(encodeMatchCursor(c))).toEqual(c);
    });
  });

  describe('getLobby', () => {
    it('방 서비스의 방 수를 그대로', async () => {
      lobbyCounts.mockResolvedValueOnce({ waitingRooms: 2, playingRooms: 1 });
      await expect(service.getLobby()).resolves.toEqual({ waitingRooms: 2, playingRooms: 1 });
    });

    it('Redis를 못 쓰면 503', async () => {
      lobbyCounts.mockResolvedValueOnce(null);
      await expect(service.getLobby()).rejects.toMatchObject({ status: 503, code: 'TETRIS_BATTLE_UNAVAILABLE' });
    });
  });
});
