import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_ATTACK, MAX_BATTLE_FRAMES } from './battle-engine';
import { MATCH_ID_PATTERN } from './tetris-battle.constants';
import {
  BOARD_BASE64_LENGTH,
  CHAT_TEXT_MAX_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  ROOM_PASSWORD_MAX_LENGTH,
  ROOM_PASSWORD_MIN_LENGTH,
  TETRIS_BATTLE_EMOTE_IDS,
  TetrisBattleEmoteId,
} from './tetris-battle.events';

/**
 * 이름 정리: 앞뒤 공백 제거 + 연속 공백 1개 (게임 랭킹 이름 DTO와 같은 규칙).
 * 이름의 형식·금칙어 판정은 서비스가 한다 — 이름 전용 code(플레이어 NAME_*, 방 ROOM_NAME_*)를 돌려주기 위해서다.
 * 여기 MaxLength는 비정상적으로 긴 값을 판정 전에 자르는 1차 방어뿐이다.
 */
const normalizeName = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/** 방 코드: 대문자로 받아 정규화 (초대 링크를 소문자로 친 경우 대비) */
const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const NAME_PRECHECK_MAX = 64;
/** 재연결 토큰 형식: base64url 32자(24바이트) — 형식이 다르면 조회하지 않고 거부 */
const PLAYER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** listRooms — 페이로드 없음 */
export class ListRoomsDto {}

export class CreateRoomDto {
  @Transform(normalizeName)
  @IsString()
  @MaxLength(NAME_PRECHECK_MAX)
  name: string;

  @IsInt()
  @Min(ROOM_MIN_PLAYERS)
  @Max(ROOM_MAX_PLAYERS)
  maxPlayers: number;

  /** 빈 문자열은 "비밀번호 없음"으로 본다 */
  @Transform(({ value }: { value: unknown }) => (value === '' || value === null ? undefined : value))
  @IsOptional()
  @IsString()
  @Length(ROOM_PASSWORD_MIN_LENGTH, ROOM_PASSWORD_MAX_LENGTH)
  password?: string;

  @Transform(normalizeName)
  @IsString()
  @MaxLength(NAME_PRECHECK_MAX)
  playerName: string;
}

export class JoinRoomDto {
  @Transform(normalizeCode)
  @IsString()
  @Matches(ROOM_CODE_PATTERN)
  code: string;

  @Transform(({ value }: { value: unknown }) => (value === '' || value === null ? undefined : value))
  @IsOptional()
  @IsString()
  @MaxLength(ROOM_PASSWORD_MAX_LENGTH)
  password?: string;

  @Transform(normalizeName)
  @IsString()
  @MaxLength(NAME_PRECHECK_MAX)
  playerName: string;

  @IsOptional()
  @IsString()
  @Matches(PLAYER_TOKEN_PATTERN)
  playerToken?: string;

  /** 경기 중 재연결: 마지막으로 받은 가비지 id(없으면 0) — 이보다 큰 가비지를 rejoin.missedGarbage로 돌려준다 */
  @IsOptional()
  @IsInt()
  @Min(0)
  lastGarbageId?: number;
}

export class RoomCodeDto {
  @Transform(normalizeCode)
  @IsString()
  @Matches(ROOM_CODE_PATTERN)
  code: string;
}

export class SetReadyDto extends RoomCodeDto {
  @IsBoolean()
  ready: boolean;
}

export class ChatDto extends RoomCodeDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, CHAT_TEXT_MAX_LENGTH)
  text: string;
}

export class EmoteDto extends RoomCodeDto {
  @IsIn(TETRIS_BATTLE_EMOTE_IDS)
  emoteId: TetrisBattleEmoteId;
}

// ==================== 매치 (P2) ====================

/** 한 경기 블록 수 상한 — 60분 × 초당 고정 수를 넉넉히 넘는 값(형식 방어용) */
const MAX_PIECES = 100_000;
/** 대기열 줄 수 상한 — 형식 방어용(받을 수 있는 이벤트 수 × 최대 줄) */
const MAX_PENDING_LINES = 100_000;
const T_SPIN_KINDS = ['none', 'mini', 'full'] as const;

export class StartMatchDto extends RoomCodeDto {}
export class RematchDto extends RoomCodeDto {}

/**
 * 블록 고정 보고 (DESIGN §16). 서버가 쓰는 값: seq·frame(단조 검증)·sent(라우팅)·combo·b2b·board·pending(중계·통계).
 * tSpin·lines·pc는 경기 후 검증(P5)·연출 대조용으로 형식만 검사한다.
 */
export class LockDto {
  @IsString()
  @Matches(MATCH_ID_PATTERN)
  matchId: string;

  /** = 고정 직후 game.pieces (1부터) */
  @IsInt()
  @Min(1)
  @Max(MAX_PIECES)
  seq: number;

  @IsInt()
  @Min(0)
  @Max(MAX_BATTLE_FRAMES)
  frame: number;

  /** 상쇄 후 보낼 줄 — 0이면 공격 없음, 1 ~ MAX_ATTACK(22). 넘으면 거부 */
  @IsInt()
  @Min(0)
  @Max(MAX_ATTACK)
  sent: number;

  /** -1 = 콤보 없음 (엔진 LockEvent.combo) */
  @IsInt()
  @Min(-1)
  @Max(MAX_PIECES)
  combo: number;

  @IsBoolean()
  b2b: boolean;

  @IsIn(T_SPIN_KINDS)
  tSpin: (typeof T_SPIN_KINDS)[number];

  @IsInt()
  @Min(0)
  @Max(4)
  lines: number;

  @IsBoolean()
  pc: boolean;

  /** 판 인코딩 base64 (events.ts BOARD_* — 길이·칸 값은 서비스가 다시 검사) */
  @IsString()
  @Length(BOARD_BASE64_LENGTH, BOARD_BASE64_LENGTH)
  board: string;

  @IsInt()
  @Min(0)
  @Max(MAX_PENDING_LINES)
  pending: number;
}

export class TopOutDto {
  @IsString()
  @Matches(MATCH_ID_PATTERN)
  matchId: string;

  @IsInt()
  @Min(0)
  @Max(MAX_BATTLE_FRAMES)
  frame: number;
}
