import { FortressError } from './fortress.errors';
import { StoredPlayer, StoredRoom, assertCanStart, changeResult, lineupOf, newPlayer, toSummary } from './fortress-room.rules';

const NOW = 1_800_000_000_000;
const room = (over: Partial<StoredRoom> = {}): StoredRoom => ({
  code: 'ABCDEF',
  name: '방',
  mode: 'ffa',
  mapId: 'hills',
  maxPlayers: 4,
  passwordHash: null,
  hostId: 'p1',
  status: 'WAITING',
  createdAt: NOW,
  nextPlayerSeq: 2,
  players: [],
  match: null,
  ...over,
});
const player = (playerId: string, over: Partial<StoredPlayer> = {}): StoredPlayer => ({
  ...newPlayer(room(), playerId, playerId, { socketId: `sock-${playerId}`, userId: null, ip: '10.0.0.1' }, 'hash', {}, NOW),
  ...over,
});
const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof FortressError ? error.code : 'NOT_FORTRESS_ERROR';
  }
  return undefined;
};

describe('fortress-room.rules', () => {
  describe('newPlayer', () => {
    it('ffa는 team null, team 모드는 적은 팀(같으면 0) · 게스트 스킨 default · 탱크 0', () => {
      expect(player('p1')).toMatchObject({ team: null, tankId: 0, skin: { id: 'default', level: 1 }, connected: true, heartbeat: false });
      const teamRoom = room({ mode: 'team', players: [player('p1', { team: 0 })] });
      expect(newPlayer(teamRoom, 'p2', 'b', { socketId: 's2', userId: null, ip: 'x' }, 'h', {}, NOW).team).toBe(1);
      teamRoom.players.push(player('p2', { team: 1 }));
      expect(newPlayer(teamRoom, 'p3', 'c', { socketId: 's3', userId: null, ip: 'x' }, 'h', {}, NOW).team).toBe(0);
    });

    it('로그인은 게이트웨이가 준 계정 스킨, 없으면 default · 게스트는 who.skin이 있어도 default', () => {
      const skin = { id: 'desert', level: 3 } as const;
      expect(newPlayer(room(), 'p1', 'a', { socketId: 's', userId: 7, ip: 'x', skin }, 'h', {}, NOW).skin).toEqual(skin);
      expect(newPlayer(room(), 'p1', 'a', { socketId: 's', userId: 7, ip: 'x' }, 'h', {}, NOW).skin).toEqual({ id: 'default', level: 1 });
      expect(newPlayer(room(), 'p1', 'a', { socketId: 's', userId: null, ip: 'x', skin }, 'h', {}, NOW).skin).toEqual({ id: 'default', level: 1 });
    });
  });

  describe('assertCanStart', () => {
    const ready = (id: string, over: Partial<StoredPlayer> = {}) => player(id, { ready: true, ...over });

    it('통과 — 방장은 ready 불필요, 나머지 전원 ready·연결', () => {
      expect(codeOf(() => assertCanStart(room({ players: [player('p1'), ready('p2')] }), 'sock-p1'))).toBeUndefined();
    });

    it('거부 순서 — 멤버 아님 → 방장 아님 → 시작됨 → 인원 → 팀 불균형 → 준비·연결', () => {
      expect(codeOf(() => assertCanStart(room({ players: [player('p1'), ready('p2')] }), 'sock-x'))).toBe('NOT_IN_ROOM');
      expect(codeOf(() => assertCanStart(room({ players: [player('p1'), ready('p2')] }), 'sock-p2'))).toBe('NOT_HOST');
      expect(codeOf(() => assertCanStart(room({ status: 'RESULT', players: [player('p1'), ready('p2')] }), 'sock-p1'))).toBe('MATCH_ALREADY_STARTED');
      expect(codeOf(() => assertCanStart(room({ players: [player('p1')] }), 'sock-p1'))).toBe('NOT_ENOUGH_PLAYERS');
      const unbalanced = [player('p1', { team: 0 }), ready('p2', { team: 0 }), ready('p3', { team: 0 }), ready('p4', { team: 1 })];
      expect(codeOf(() => assertCanStart(room({ mode: 'team', players: unbalanced }), 'sock-p1'))).toBe('TEAM_UNBALANCED');
      expect(codeOf(() => assertCanStart(room({ players: [player('p1'), player('p2')] }), 'sock-p1'))).toBe('NOT_ALL_READY');
      expect(codeOf(() => assertCanStart(room({ players: [player('p1'), ready('p2', { connected: false })] }), 'sock-p1'))).toBe('NOT_ALL_READY');
    });
  });

  it('lineupOf — 참가자·팀·탱크가 바뀌면 달라지고 ready·연결만 바뀌면 같다', () => {
    const base = room({ players: [player('p1'), player('p2')] });
    const same = room({ players: [player('p1', { ready: true }), player('p2', { connected: false })] });
    const tank = room({ players: [player('p1'), player('p2', { tankId: 2 })] });
    expect(lineupOf(same)).toBe(lineupOf(base));
    expect(lineupOf(tank)).not.toBe(lineupOf(base));
  });

  it('changeResult — 로비 목록에 보이는 값(인원·상태 등)이 바뀔 때만 lobbyChanged', () => {
    const before = room({ players: [player('p1')] });
    const readied = room({ players: [player('p1', { ready: true })] });
    const joined = room({ players: [player('p1'), player('p2')] });
    expect(changeResult(readied, before).lobbyChanged).toBe(false);
    expect(changeResult(joined, before).lobbyChanged).toBe(true);
    expect(toSummary(joined)).toMatchObject({ playerCount: 2, locked: false, status: 'WAITING' });
  });
});
