import {
  GameRoomSeat,
  GameRoomShape,
  findMemberBySocket,
  isInPlayingMatch,
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
