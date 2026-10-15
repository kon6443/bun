import { EntityManager, LessThan, QueryFailedError } from 'typeorm';
import { TeamChatReadCursor } from '../../entities/TeamChatReadCursor';
import { createMockQueryBuilder } from '../../common/__spec__/mock-repository';
import {
  advanceReadCursor,
  findLatestMessageId,
  initReadCursorAtLatest,
  isUniqueConstraintError,
} from './chat-read-cursor';

const TEAM_ID = 7;
const USER_ID = 42;

/**
 * 읽음 커서는 "이 ID까지 읽었다"는 숫자 하나로 안 읽은 인원·명단·배지를 모두 계산한다(D-001).
 * 그래서 고정할 계약은 하나다: **커서는 절대 뒤로 가지 않는다**.
 * 뒤로 가면 이미 읽은 메시지가 다시 안읽음으로 뜨고, 다른 화면의 숫자가 늘어난다.
 */
describe('chat-read-cursor', () => {
  let manager: { update: jest.Mock; existsBy: jest.Mock; insert: jest.Mock; createQueryBuilder: jest.Mock };

  const uniqueViolation = () =>
    new QueryFailedError('INSERT ...', [], Object.assign(new Error('ORA-00001: unique constraint violated'), { errorNum: 1 }));

  beforeEach(() => {
    manager = {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      existsBy: jest.fn().mockResolvedValue(false),
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
  });

  const advance = (messageId: number) =>
    advanceReadCursor(manager as unknown as EntityManager, TEAM_ID, USER_ID, messageId);

  describe('advanceReadCursor', () => {
    it('현재 값보다 작은 행만 갱신하는 조건부 UPDATE를 써야 함', async () => {
      manager.update.mockResolvedValue({ affected: 1 });

      await expect(advance(104)).resolves.toBe(true);

      // 조건에 LessThan이 빠지면 늦게 도착한 작은 값이 커서를 뒤로 돌린다
      expect(manager.update).toHaveBeenCalledWith(
        TeamChatReadCursor,
        { teamId: TEAM_ID, userId: USER_ID, lastReadMessageId: LessThan(104) },
        expect.objectContaining({ lastReadMessageId: 104 }),
      );
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('행이 있는데 갱신되지 않았으면(이미 같거나 앞) false이고 INSERT하지 않아야 함', async () => {
      manager.existsBy.mockResolvedValue(true);

      await expect(advance(100)).resolves.toBe(false);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('행이 없으면 INSERT하고 true여야 함', async () => {
      await expect(advance(104)).resolves.toBe(true);

      expect(manager.insert).toHaveBeenCalledWith(
        TeamChatReadCursor,
        expect.objectContaining({ teamId: TEAM_ID, userId: USER_ID, lastReadMessageId: 104 }),
      );
    });

    it('동시 INSERT 경합(ORA-00001)이면 조건부 UPDATE를 한 번 더 시도해야 함', async () => {
      manager.insert.mockRejectedValue(uniqueViolation());
      manager.update.mockResolvedValueOnce({ affected: 0 }).mockResolvedValueOnce({ affected: 1 });

      await expect(advance(104)).resolves.toBe(true);
      expect(manager.update).toHaveBeenCalledTimes(2);
    });

    it('유니크 위반이 아닌 INSERT 오류는 그대로 던져야 함', async () => {
      manager.insert.mockRejectedValue(new Error('ORA-03113'));

      await expect(advance(104)).rejects.toThrow('ORA-03113');
    });

    it.each([0, -1])('messageId가 %s면 DB를 건드리지 않아야 함', async (messageId) => {
      await expect(advance(messageId)).resolves.toBe(false);
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe('isUniqueConstraintError', () => {
    it('Oracle errorNum 1(ORA-00001)만 유니크 위반으로 판정해야 함', () => {
      expect(isUniqueConstraintError(uniqueViolation())).toBe(true);
      expect(
        isUniqueConstraintError(new QueryFailedError('q', [], Object.assign(new Error('x'), { errorNum: 2291 }))),
      ).toBe(false);
      expect(isUniqueConstraintError(new Error('ORA-00001'))).toBe(false);
    });
  });

  describe('findLatestMessageId', () => {
    it.each([
      [{ maxId: 104 }, 104],
      [{ maxId: '104' }, 104],
      [{ maxId: null }, 0],
      [null, 0],
    ])('MAX 결과 %j는 %d로 돌려줘야 함 (메시지가 없으면 0, 항상 number)', async (raw, expected) => {
      manager.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getRawOne: raw }));

      await expect(findLatestMessageId(manager as unknown as EntityManager, TEAM_ID)).resolves.toBe(expected);
    });
  });

  describe('initReadCursorAtLatest', () => {
    it('팀 최신 메시지 ID로 커서를 올려야 함', async () => {
      manager.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getRawOne: { maxId: 104 } }));
      manager.update.mockResolvedValue({ affected: 1 });

      await initReadCursorAtLatest(manager as unknown as EntityManager, TEAM_ID, USER_ID);

      expect(manager.update).toHaveBeenCalledWith(
        TeamChatReadCursor,
        { teamId: TEAM_ID, userId: USER_ID, lastReadMessageId: LessThan(104) },
        expect.objectContaining({ lastReadMessageId: 104 }),
      );
    });

    it('메시지가 없는 팀이면 커서를 만들지 않아야 함 (행 없음 = 0과 같다)', async () => {
      manager.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getRawOne: { maxId: null } }));

      await initReadCursorAtLatest(manager as unknown as EntityManager, TEAM_ID, USER_ID);

      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });
  });
});
