import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChatMessageDto, ChatReadDto } from './team.gateway.dto';
import { CHAT_MESSAGE_MAX_LENGTH } from '../../common/constants/chat.constants';

/**
 * 소켓 DTO 검증 경계 — 저장 컬럼 한도와 맞물려 있다 (docs/tasks/team-chat-persistence D-013).
 * 글자 수만 보면 다바이트 문자가 DB 단계(ORA-12899)에서야 터지므로 바이트 경계를 고정한다.
 */
describe('team.gateway.dto', () => {
  const errorsOf = async <T extends object>(cls: new () => T, plain: object) =>
    (await validate(plainToInstance(cls, plain))).map((e) => e.property);

  describe('ChatMessageDto', () => {
    const valid = { message: '안녕하세요', clientMsgId: '3f1c2b9e-0a4d-4f7e-9a1b-2c3d4e5f6a7b' };

    it('UUID clientMsgId와 일반 메시지는 통과해야 함', async () => {
      await expect(errorsOf(ChatMessageDto, valid)).resolves.toEqual([]);
    });

    it('clientMsgId는 글자 수가 아니라 바이트로 64까지만 허용해야 함 (컬럼 VARCHAR2(64 BYTE))', async () => {
      // 한글 22자 = 66바이트 — 글자 수 기준(64자)이면 통과해 저장 단계에서 실패한다
      await expect(errorsOf(ChatMessageDto, { ...valid, clientMsgId: '가'.repeat(22) })).resolves.toEqual([
        'clientMsgId',
      ]);
      await expect(errorsOf(ChatMessageDto, { ...valid, clientMsgId: 'a'.repeat(64) })).resolves.toEqual([]);
      await expect(errorsOf(ChatMessageDto, { ...valid, clientMsgId: 'a'.repeat(65) })).resolves.toEqual([
        'clientMsgId',
      ]);
    });

    it(`message는 ${CHAT_MESSAGE_MAX_LENGTH}자까지 허용하고 넘으면 거부해야 함`, async () => {
      await expect(
        errorsOf(ChatMessageDto, { ...valid, message: '가'.repeat(CHAT_MESSAGE_MAX_LENGTH) }),
      ).resolves.toEqual([]);
      await expect(
        errorsOf(ChatMessageDto, { ...valid, message: '가'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1) }),
      ).resolves.toEqual(['message']);
    });

    it('공백뿐인 message는 trim 후 비어 있으므로 거부해야 함', async () => {
      await expect(errorsOf(ChatMessageDto, { ...valid, message: '   ' })).resolves.toEqual(['message']);
    });
  });

  describe('ChatReadDto', () => {
    it.each([[0], [-1], [1.5], ['104']])('lastReadMessageId %p는 거부해야 함', async (value) => {
      await expect(errorsOf(ChatReadDto, { lastReadMessageId: value })).resolves.toEqual(['lastReadMessageId']);
    });

    it('양의 정수는 통과해야 함', async () => {
      await expect(errorsOf(ChatReadDto, { lastReadMessageId: 104 })).resolves.toEqual([]);
    });
  });
});
