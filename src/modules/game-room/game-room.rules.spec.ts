import {
  GameRoomSeat,
  GameRoomShape,
  findMemberBySocket,
  findUserSeat,
  isInPlayingMatch,
  isSeatTakeOverBlocked,
  markSeatDisconnected,
  pruneDisconnectedSeats,
  removeSeat,
} from './game-room.rules';

const GRACE = 10_000;
const NOW = 1_800_000_000_000;
const seat = (playerId: string, over: Partial<GameRoomSeat> = {}): GameRoomSeat => ({
  playerId,
  connected: true,
  socketId: `sock-${playerId}`,
  disconnectedAt: null,
  ...over,
});
const roomOf = (
  players: GameRoomSeat[],
  over: Partial<GameRoomShape<GameRoomSeat>> = {},
): GameRoomShape<GameRoomSeat> => ({
  hostId: 'p1',
  status: 'WAITING',
  players,
  match: null,
  ...over,
});
const gone = (playerId: string, at: number) =>
  seat(playerId, { connected: false, socketId: null, disconnectedAt: at });

describe('game-room.rules', () => {
  it('findMemberBySocket — 대표 소켓으로만 찾는다(끊긴 자리는 socketId null)', () => {
    const room = roomOf([seat('p1'), gone('p2', NOW)]);
    expect(findMemberBySocket(room, 'sock-p1')?.playerId).toBe('p1');
    expect(findMemberBySocket(room, 'sock-p2')).toBeUndefined();
  });

  it('isInPlayingMatch — PLAYING이고 경기 참가자일 때만', () => {
    const match = { playerIds: ['p1'] };
    expect(isInPlayingMatch(roomOf([seat('p1')], { status: 'PLAYING', match }), 'p1')).toBe(true);
    expect(isInPlayingMatch(roomOf([seat('p1')], { status: 'PLAYING', match }), 'p2')).toBe(false);
    expect(isInPlayingMatch(roomOf([seat('p1')], { status: 'RESULT', match }), 'p1')).toBe(false);
    expect(isInPlayingMatch(roomOf([seat('p1')], { status: 'PLAYING', match: undefined }), 'p1')).toBe(false);
  });

  it('markSeatDisconnected — 자리는 두고 소켓만 비운다', () => {
    const p = seat('p1');
    markSeatDisconnected(p, NOW);
    expect(p).toEqual({ playerId: 'p1', connected: false, socketId: null, disconnectedAt: NOW });
  });

  it('removeSeat — 방장이 나가면 연결된 사람 중 먼저 들어온 사람, 아무도 연결 안 됐으면 가장 먼저 들어온 사람', () => {
    const room = roomOf([seat('p1'), gone('p2', NOW), seat('p3')]);
    removeSeat(room, 'p1');
    expect(room.hostId).toBe('p3');

    const allGone = roomOf([seat('p1'), gone('p2', NOW), gone('p3', NOW)]);
    removeSeat(allGone, 'p1');
    expect(allGone.hostId).toBe('p2');

    const notHost = roomOf([seat('p1'), seat('p2')]);
    removeSeat(notHost, 'p2');
    expect(notHost).toMatchObject({ hostId: 'p1', players: [{ playerId: 'p1' }] });
  });

  it('pruneDisconnectedSeats — 유예가 지난 끊긴 자리만 빼고 원본은 그대로, PLAYING은 건드리지 않는다', () => {
    const source = roomOf([gone('p1', NOW - GRACE), gone('p2', NOW - GRACE + 1), seat('p3')]);
    const pruned = pruneDisconnectedSeats(source, NOW, GRACE);
    expect(pruned.players.map(p => p.playerId)).toEqual(['p2', 'p3']);
    expect(pruned.hostId).toBe('p3');
    expect(source.players).toHaveLength(3);
    expect(source.hostId).toBe('p1');

    const playing = roomOf([gone('p1', NOW - GRACE * 10), seat('p2')], { status: 'PLAYING' });
    expect(pruneDisconnectedSeats(playing, NOW, GRACE).players).toHaveLength(2);
  });
});

// 테트리스 대전·포트리스가 같은 규칙을 두 벌 들고 있던 것 (docs/tasks/refactor-perf-b-2026-11 B2)
describe('자리 넘겨받기 규칙', () => {
  type UserSeat = GameRoomSeat & { userId: number | null; tabId?: string | null };
  const userSeat = (playerId: string, userId: number | null, over: Partial<UserSeat> = {}): UserSeat => ({
    ...seat(playerId),
    userId,
    tabId: null,
    ...over,
  });
  const playing = (players: UserSeat[]): GameRoomShape<UserSeat> => ({
    hostId: 'p1',
    status: 'PLAYING',
    players,
    match: { playerIds: players.map(p => p.playerId) },
  });

  it('findUserSeat — 로그인 유저면 그 계정의 자리, 게스트(null)면 없음', () => {
    const room = playing([userSeat('p1', 7), userSeat('p2', null)]);
    expect(findUserSeat(room, 7)?.playerId).toBe('p1');
    expect(findUserSeat(room, null)).toBeUndefined();
    expect(findUserSeat(room, 99)).toBeUndefined();
  });

  it('경기 중 자리를 다른 소켓이 연결해 쓰고 있으면 막는다', () => {
    const p1 = userSeat('p1', 7, { socketId: 'old' });
    expect(isSeatTakeOverBlocked(playing([p1]), p1, 'new', undefined)).toBe(true);
  });

  it.each([
    ['같은 탭의 재연결', userSeat('p1', 7, { socketId: 'old', tabId: 'tab-a' }), 'tab-a', 'PLAYING'],
    ['이전 소켓이 이미 끊김', userSeat('p1', 7, { socketId: null, connected: false }), undefined, 'PLAYING'],
    ['같은 소켓', userSeat('p1', 7, { socketId: 'new' }), undefined, 'PLAYING'],
    ['경기 중이 아님', userSeat('p1', 7, { socketId: 'old' }), undefined, 'WAITING'],
  ] as const)('%s이면 허용한다', (_desc, player, tabId, status) => {
    const room = { ...playing([player]), status } as GameRoomShape<UserSeat>;
    expect(isSeatTakeOverBlocked(room, player, 'new', tabId)).toBe(false);
  });
});
