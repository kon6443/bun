import { toLinkStatusForRole, toMyTeamItem, toPublicTask } from './team.mapper';
import { createTeamMemberView, createTeamTaskView } from '../../entities/__spec__/entity.factory';

/**
 * 응답 매퍼는 "무엇이 나가는가"의 화이트리스트다.
 * 키 목록을 정확히 고정한다 — 필드가 새거나(알림 채널 정보) 빠지면(프론트가 쓰는 값) 여기서 깨진다.
 */
describe('team.mapper', () => {
  const WEBHOOK = 'https://discord.test/api/webhooks/1/secret';

  describe('toMyTeamItem', () => {
    it('알림 채널 정보를 제외한 공개 필드와 unreadChatCount만 내보내야 함', () => {
      const tm = createTeamMemberView({ telegramChatId: 123456, discordWebhookUrl: WEBHOOK });

      const item = toMyTeamItem(tm, 3);

      expect(Object.keys(item).sort()).toEqual(
        [
          'actStatus',
          'crtdAt',
          'joinedAt',
          'leaderId',
          'role',
          'teamDescription',
          'teamId',
          'teamName',
          'unreadChatCount',
          'userActStatus',
          'userId',
        ].sort(),
      );
      expect(item.unreadChatCount).toBe(3);
      expect(JSON.stringify(item)).not.toContain(WEBHOOK);
    });
  });

  describe('toPublicTask', () => {
    it('팀 정보(알림 채널 포함)를 버리고 태스크 필드만 내보내야 함', () => {
      const task = createTeamTaskView({ telegramChatId: 123456, discordWebhookUrl: WEBHOOK });

      const result = toPublicTask(task);

      expect(Object.keys(result).sort()).toEqual(
        [
          'actStatus',
          'completedAt',
          'crtdAt',
          'crtdBy',
          'endAt',
          'startAt',
          'taskDescription',
          'taskId',
          'taskName',
          'taskStatus',
          'teamId',
          'userName',
        ].sort(),
      );
      expect(JSON.stringify(result)).not.toContain(WEBHOOK);
    });
  });

  describe('toLinkStatusForRole', () => {
    const full = {
      isLinked: false,
      chatId: null,
      pendingLink: { token: 'secret-token', deepLink: 'https://t.me/bot', endAt: new Date(0) },
    };

    it('MEMBER에게는 isLinked만 남겨야 함', () => {
      expect(toLinkStatusForRole(full, 'MEMBER')).toEqual({ isLinked: false });
    });

    it.each(['MASTER', 'MANAGER'])('%s에게는 원본을 그대로 줘야 함', (role) => {
      expect(toLinkStatusForRole(full, role)).toBe(full);
    });

    it('알 수 없는 역할은 MEMBER처럼 축소해야 함 (기본값이 노출이면 안 된다)', () => {
      expect(toLinkStatusForRole({ isLinked: true, webhookUrl: 'x' }, 'UNKNOWN')).toEqual({ isLinked: true });
    });
  });
});
