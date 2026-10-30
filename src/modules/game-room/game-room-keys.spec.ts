import { TETRIS_BATTLE_ROOM_KEYS } from '../tetris-battle/tetris-battle.constants';
import { createGameRoomKeys } from './game-room-keys';

/**
 * 키 문자열 고정 — 배포 중 옛·새 레플리카가 같은 키를 읽어야 한다.
 * 기대값은 공용 부품 추출(F3a) 전 테트리스 방 서비스·토큰 파일에 하드코딩돼 있던 문자열 그대로다
 */
describe('createGameRoomKeys', () => {
  describe('테트리스 접두사 — 추출 전 문자열과 바이트 단위로 같다', () => {
    const keys = TETRIS_BATTLE_ROOM_KEYS;

    it.each([
      ['room', keys.room('ABC234'), 'tetris-battle:room:ABC234'],
      ['lobbyIndex', keys.lobbyIndex, 'tetris-battle:rooms'],
      ['lobbySummary', keys.lobbySummary, 'tetris-battle:lobby-summary'],
      ['rateLimit', keys.rateLimit('setReady', 'ABC234:p1'), 'tetris-battle:rl:setReady:ABC234:p1'],
      ['passwordFail', keys.passwordFail('ABC234', 'sock-1'), 'tetris-battle:pwfail:ABC234:sock-1'],
      ['passwordFailIp', keys.passwordFailIp('ABC234', '203.0.113.50'), 'tetris-battle:pwfail-ip:ABC234:203.0.113.50'],
      ['probe', keys.probe('ABC234'), 'tetris-battle:probe:ABC234'],
      ['heartbeat', keys.heartbeat('ABC234', 'sock-1'), 'tetris-battle:hb:ABC234:sock-1'],
      ['heartbeatProbe', keys.heartbeatProbe('ABC234'), 'tetris-battle:hbprobe:ABC234'],
    ])('%s', (_name, actual, expected) => {
      expect(actual).toBe(expected);
    });

    it('TETRIS_BATTLE_ROOM_KEYS는 접두사 tetris-battle:로 만든 것과 같다', () => {
      const fresh = createGameRoomKeys('tetris-battle:');
      expect(TETRIS_BATTLE_ROOM_KEYS.room('X')).toBe(fresh.room('X'));
      expect(TETRIS_BATTLE_ROOM_KEYS.lobbyIndex).toBe(fresh.lobbyIndex);
    });
  });

  it('다른 게임 접두사는 테트리스 키와 겹치지 않는다', () => {
    const fortress = createGameRoomKeys('fortress:');
    expect(fortress.room('ABC234')).toBe('fortress:room:ABC234');
    expect(fortress.lobbyIndex).toBe('fortress:rooms');
    expect(fortress.heartbeat('ABC234', 's')).toBe('fortress:hb:ABC234:s');
    expect(fortress.room('ABC234')).not.toBe(TETRIS_BATTLE_ROOM_KEYS.room('ABC234'));
  });
});
