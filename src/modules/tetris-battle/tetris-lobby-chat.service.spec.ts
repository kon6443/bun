import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { User } from '../../entities/User';
import { TetrisBattleRoomService } from './tetris-battle-room.service';
import type { LobbyChatMessage } from './tetris-battle.events';
import { TetrisLobbyChatService } from './tetris-lobby-chat.service';

const NOW = Date.parse('2026-10-27T05:00:00.000Z');
const KEY = 'tetris-battle:lobby-chat:recent';

/** 최근 대화 List만 흉내 내는 Redis 대역 — lpush·ltrim·expire를 MULTI로 쌓아 exec에서 적용 */
const createListRedis = () => {
  const lists = new Map<string, string[]>();
  const ttl = new Map<string, number>();
  const redis = {
    status: 'ready',
    lrange: jest.fn(async (key: string, start: number, stop: number) => (lists.get(key) ?? []).slice(start, stop + 1)),
    multi: jest.fn(() => {
      const ops: (() => void)[] = [];
      const chain = {
        lpush: (key: string, value: string) => (ops.push(() => lists.set(key, [value, ...(lists.get(key) ?? [])])), chain),
        ltrim: (key: string, start: number, stop: number) => (ops.push(() => lists.set(key, (lists.get(key) ?? []).slice(start, stop + 1))), chain),
        expire: (key: string, seconds: number) => (ops.push(() => ttl.set(key, seconds)), chain),
        exec: async () => ops.map((op) => (op(), [null, 1])),
      };
      return chain;
    }),
  };
  return { redis, lists, ttl };
};

const message = (id: string, at: string): LobbyChatMessage => ({ id, senderKey: 'k', name: '가', isGuest: true, text: 't', at });

describe('TetrisLobbyChatService (tetris-chat D-001)', () => {
  let service: TetrisLobbyChatService;
  let users: MockRepository<User>;
  let rateLimit: jest.Mock;
  let store: ReturnType<typeof createListRedis>;

  const guest = { isGuest: true, name: null };
  const member = { isGuest: false, name: '개발자' };

  beforeEach(() => {
    users = createMockRepository<User>();
    rateLimit = jest.fn().mockResolvedValue(true);
    store = createListRedis();
    service = new TetrisLobbyChatService(
      { consumeRateLimit: rateLimit } as unknown as TetrisBattleRoomService,
      users as never,
      { get: () => 'secret' } as never,
    );
    service.setRedisClient(store.redis as never);
  });

  describe('보낸 사람 표시', () => {
    it('게스트는 이름 없음 — DB를 읽지 않는다', async () => {
      await expect(service.senderOf(null)).resolves.toEqual({ isGuest: true, name: null });
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('로그인은 계정 이름(공백 정리), 정책을 통과 못 하거나 비면 "회원"', async () => {
      users.findOne.mockResolvedValueOnce({ userId: 1, userName: '  개발  자 ' } as User);
      await expect(service.senderOf(1)).resolves.toEqual({ isGuest: false, name: '개발 자' });
      users.findOne.mockResolvedValueOnce({ userId: 1, userName: '운영자' } as User);
      await expect(service.senderOf(1)).resolves.toEqual({ isGuest: false, name: '회원' });
      users.findOne.mockResolvedValueOnce(null);
      await expect(service.senderOf(1)).resolves.toEqual({ isGuest: false, name: '회원' });
    });
  });

  describe('보내기', () => {
    it('게스트 — 보낸 이름으로, IP 기준 빈도 두 단위, 최근 대화 맨 앞에 넣고 50개·30분 TTL', async () => {
      const sent = await service.publish({ sender: guest, userId: null, ip: '10.0.0.1', name: '손님', text: '안녕' }, NOW);

      expect(sent).toEqual({ id: expect.any(String), senderKey: expect.stringMatching(/^[0-9a-f]{16}$/), name: '손님', isGuest: true, text: '안녕', at: new Date(NOW).toISOString() });
      expect(rateLimit).toHaveBeenCalledWith('lobbyChat', 'ip:10.0.0.1');
      expect(rateLimit).toHaveBeenCalledWith('lobbyChatIp', '10.0.0.1');
      expect(JSON.parse(store.lists.get(KEY)![0])).toEqual(sent);
      expect(store.ttl.get(KEY)).toBe(1800);
    });

    it('로그인 — 계정 이름으로(보낸 name 무시), 빈도는 userId 단위', async () => {
      const sent = await service.publish({ sender: member, userId: 7, ip: '10.0.0.1', name: '사칭', text: 'hi' }, NOW);
      expect(sent).toMatchObject({ name: '개발자', isGuest: false });
      expect(rateLimit).toHaveBeenCalledWith('lobbyChat', 'u:7');
    });

    it('차단 키 — 같은 사람이면 같은 값, 다른 사람·게스트와 로그인은 다른 값', async () => {
      const a1 = await service.publish({ sender: member, userId: 7, ip: '1.1.1.1', text: 'a' }, NOW);
      const a2 = await service.publish({ sender: member, userId: 7, ip: '2.2.2.2', text: 'b' }, NOW);
      const b = await service.publish({ sender: member, userId: 8, ip: '1.1.1.1', text: 'c' }, NOW);
      const g = await service.publish({ sender: guest, userId: null, ip: '1.1.1.1', name: '손님', text: 'd' }, NOW);
      expect(a1.senderKey).toBe(a2.senderKey);
      expect(new Set([a1.senderKey, b.senderKey, g.senderKey]).size).toBe(3);
    });

    it('내 차단 키(senderKeyOf)는 내가 보낸 글의 senderKey와 같다 — 로그인·게스트 모두', async () => {
      const m = await service.publish({ sender: member, userId: 7, ip: '1.1.1.1', text: 'a' }, NOW);
      const g = await service.publish({ sender: guest, userId: null, ip: '2.2.2.2', name: '손님', text: 'b' }, NOW);
      expect(service.senderKeyOf(7, '9.9.9.9')).toBe(m.senderKey);
      expect(service.senderKeyOf(null, '2.2.2.2')).toBe(g.senderKey);
    });

    it('최근 대화는 50개까지만 남긴다', async () => {
      for (let i = 0; i < 52; i++) await service.publish({ sender: member, userId: 7, ip: '1.1.1.1', text: `m${i}` }, NOW);
      expect(store.lists.get(KEY)).toHaveLength(50);
    });

    it.each([
      ['줄바꿈', '안녕\n하세요'],
      ['방향 오버라이드', 'abc‮def'],
      ['금칙어', '시발'],
    ])('%s → CHAT_FORBIDDEN, 저장·빈도 소비 없음', async (_label, text) => {
      await expect(service.publish({ sender: member, userId: 7, ip: '1.1.1.1', text }, NOW)).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' });
      expect(rateLimit).not.toHaveBeenCalled();
      expect(store.lists.get(KEY)).toBeUndefined();
    });

    it.each([
      ['이름 없음', undefined, 'NAME_INVALID'],
      ['너무 긴 이름', '가'.repeat(13), 'NAME_INVALID'],
      ['사칭 이름', '운영자', 'NAME_FORBIDDEN'],
    ])('게스트 %s → %s', async (_label, name, code) => {
      await expect(service.publish({ sender: guest, userId: null, ip: '1.1.1.1', name, text: 'hi' }, NOW)).rejects.toMatchObject({ code });
      expect(rateLimit).not.toHaveBeenCalled();
    });

    it('빈도 초과 → RATE_LIMITED, 저장 없음', async () => {
      rateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(service.publish({ sender: member, userId: 7, ip: '1.1.1.1', text: 'hi' }, NOW)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(store.lists.get(KEY)).toBeUndefined();
    });

    it('Redis 준비 전 → SERVICE_UNAVAILABLE', async () => {
      store.redis.status = 'reconnecting';
      await expect(service.publish({ sender: member, userId: 7, ip: '1.1.1.1', text: 'hi' }, NOW)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    });
  });

  describe('최근 대화', () => {
    it('오래된 것부터, 30분 넘은 것·깨진 항목은 뺀다', async () => {
      store.lists.set(KEY, [
        JSON.stringify(message('c', '2026-10-27T04:59:00.000Z')),
        '{broken',
        JSON.stringify(message('b', '2026-10-27T04:31:00.000Z')),
        JSON.stringify(message('a', '2026-10-27T04:29:59.000Z')),
      ]);
      expect((await service.recent(NOW)).map((m) => m.id)).toEqual(['b', 'c']);
      expect(store.redis.lrange).toHaveBeenCalledWith(KEY, 0, 49);
    });
  });
});
