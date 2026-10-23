import { TetrisBattleErrorCode } from './tetris-battle.events';

/** 코드별 기본 메시지 — 프론트는 code로 분기하고 message는 그대로 보여 줘도 되는 문구 */
const DEFAULT_MESSAGES: Record<TetrisBattleErrorCode, string> = {
  ROOM_NOT_FOUND: '방을 찾을 수 없습니다.',
  ROOM_FULL: '방이 가득 찼습니다.',
  ROOM_WRONG_PASSWORD: '비밀번호가 맞지 않습니다.',
  ROOM_PASSWORD_LOCKED: '비밀번호를 여러 번 틀렸습니다. 잠시 후 다시 시도해 주세요.',
  NOT_HOST: '방장만 할 수 있습니다.',
  NOT_IN_ROOM: '이 방의 참가자가 아닙니다.',
  MATCH_ALREADY_STARTED: '이미 경기가 진행 중입니다.',
  MATCH_NOT_FOUND: '경기를 찾을 수 없습니다.',
  NOT_ENOUGH_PLAYERS: '참가자가 부족합니다.',
  NOT_ALL_READY: '모든 참가자가 준비하지 않았습니다.',
  NAME_INVALID: '이름 형식이 올바르지 않습니다.',
  NAME_FORBIDDEN: '사용할 수 없는 이름입니다.',
  RATE_LIMITED: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
  INVALID_PLAYER_TOKEN: '재입장 정보가 유효하지 않습니다. 다시 입장해 주세요.',
  INVALID_PAYLOAD: '요청 형식이 올바르지 않습니다.',
  ROOM_NAME_INVALID: '방 이름 형식이 올바르지 않습니다.',
  ROOM_NAME_FORBIDDEN: '사용할 수 없는 방 이름입니다.',
  CHAT_FORBIDDEN: '사용할 수 없는 표현이 포함되어 있습니다.',
  ROOM_BUSY: '방 상태가 바쁩니다. 잠시 후 다시 시도해 주세요.',
  SERVICE_UNAVAILABLE: '대전 서버를 일시적으로 사용할 수 없습니다.',
  INTERNAL_ERROR: '서버 내부 오류가 발생했습니다.',
  PLAYER_NOT_ALIVE: '이미 탈락했습니다.',
  SEAT_IN_USE: '다른 탭이나 기기에서 경기 중입니다. 경기가 끝나면 들어올 수 있습니다.',
  PLAYER_NOT_FOUND: '내보낼 참가자를 찾을 수 없습니다.',
};

/**
 * 대전 도메인 에러. 서비스·게이트웨이가 던지고 `TetrisBattleWsExceptionFilter`가
 * ack `{ ok: false, code, message }`로 바꾼다.
 */
export class TetrisBattleError extends Error {
  constructor(
    public readonly code: TetrisBattleErrorCode,
    message: string = DEFAULT_MESSAGES[code],
  ) {
    super(message);
    this.name = 'TetrisBattleError';
  }
}
