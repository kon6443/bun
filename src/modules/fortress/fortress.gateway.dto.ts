import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { MATCH_ID_PATTERN } from './fortress.constants';
import {
  CHAT_TEXT_MAX_LENGTH,
  FORTRESS_EMOTE_IDS,
  FortressEmoteId,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_MAP_IDS,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  ROOM_MODES,
  ROOM_PASSWORD_MAX_LENGTH,
  ROOM_PASSWORD_MIN_LENGTH,
  RoomMapId,
  RoomMode,
} from './fortress.events';

/**
 * 포트리스 게이트웨이 DTO — 계약 페이로드(fortress.events.ts)와 1:1. 방·로비 필드의 검증 규칙은 테트리스 대전 DTO와 같다
 * (이름 정리·방 코드 정규화·토큰·탭 id 형식). 이름의 형식·금칙어 판정은 서비스가 한다(NAME_*·ROOM_NAME_* code를 돌려주려고).
 */
const normalizeName = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const emptyToUndefined = ({ value }: { value: unknown }) => (value === '' || value === null ? undefined : value);

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const NAME_PRECHECK_MAX = 64;
/** 재연결 토큰 형식: base64url 32자(24바이트) */
const PLAYER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
/** 탭 식별자 — 프론트가 탭 메모리에만 두는 값 */
const TAB_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** stateHash 형식 — 엔진 FNV-1a hex8 */
const STATE_HASH_PATTERN = /^[0-9a-f]{8}$/;
/**
 * 턴 입력 형식 방어 상한 — 정수인지·터무니없는 값인지만 본다. 범위·연료·쿨다운 같은 의미 검증은 엔진이 하고
 * 실패는 ACTION_REJECTED(message = 엔진 reason)다 — 프론트 엔진과 같은 판정 하나만 두려고
 */
const TURN_INPUT_ABS_MAX = 100_000;
const WEAPON_ID_MAX = 99;
/** seq 상한 — 엔진 MAX_ACTIONS(480)를 넉넉히 넘는 형식 방어 */
const SEQ_MAX = 100_000;

/** listRooms — 페이로드 없음 */
export class ListRoomsDto {}

export class CreateRoomDto {
  @Transform(normalizeName)
  @IsString()
  @MaxLength(NAME_PRECHECK_MAX)
  name: string;

  @IsIn(ROOM_MODES)
  mode: RoomMode;

  @IsIn(ROOM_MAP_IDS)
  mapId: RoomMapId;

  /** team은 서비스가 4로 고정한다 */
  @IsInt()
  @Min(ROOM_MIN_PLAYERS)
  @Max(ROOM_MAX_PLAYERS)
  maxPlayers: number;

  /** 빈 문자열은 "비밀번호 없음" */
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  @Length(ROOM_PASSWORD_MIN_LENGTH, ROOM_PASSWORD_MAX_LENGTH)
  password?: string;

  @Transform(normalizeName)
  @IsString()
  @MaxLength(NAME_PRECHECK_MAX)
  playerName: string;

  @IsOptional()
  @IsString()
  @Matches(TAB_ID_PATTERN)
  tabId?: string;

  @IsOptional()
  @IsBoolean()
  heartbeat?: boolean;
}

export class JoinRoomDto {
  @Transform(normalizeCode)
  @IsString()
  @Matches(ROOM_CODE_PATTERN)
  code: string;

  @Transform(emptyToUndefined)
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

  @IsOptional()
  @IsString()
  @Matches(TAB_ID_PATTERN)
  tabId?: string;

  @IsOptional()
  @IsBoolean()
  heartbeat?: boolean;
}

export class RoomCodeDto {
  @Transform(normalizeCode)
  @IsString()
  @Matches(ROOM_CODE_PATTERN)
  code: string;
}

export class KickPlayerDto extends RoomCodeDto {
  @IsString()
  @Matches(/^p\d{1,6}$/)
  playerId: string;
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

/** 로비 채팅 (D-016, 테트리스 LobbyChatDto와 같은 규칙) — 글자 규칙은 방 채팅과 같다. name은 게스트만 쓰고 형식·금칙어는 서비스가 본다(NAME_* code) */
export class LobbyChatDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, CHAT_TEXT_MAX_LENGTH)
  text: string;

  @IsOptional()
  @Transform(normalizeName)
  @IsString()
  @MaxLength(NAME_PRECHECK_MAX)
  name?: string;
}

export class EmoteDto extends RoomCodeDto {
  @IsIn(FORTRESS_EMOTE_IDS)
  emoteId: FortressEmoteId;
}

export class StartMatchDto extends RoomCodeDto {}
export class RematchDto extends RoomCodeDto {}

/** 방장 설정 변경 — 빠진 필드는 그대로. team이면 maxPlayers는 서비스가 4로 고정 */
export class UpdateSettingsDto extends RoomCodeDto {
  @IsOptional()
  @IsIn(ROOM_MODES)
  mode?: RoomMode;

  @IsOptional()
  @IsIn(ROOM_MAP_IDS)
  mapId?: RoomMapId;

  @IsOptional()
  @IsInt()
  @Min(ROOM_MIN_PLAYERS)
  @Max(ROOM_MAX_PLAYERS)
  maxPlayers?: number;
}

export class SetTeamDto extends RoomCodeDto {
  @IsIn([0, 1])
  team: 0 | 1;
}

/** 0..2 (엔진 TANKS 인덱스) */
export class SetTankDto extends RoomCodeDto {
  @IsInt()
  @Min(0)
  @Max(2)
  tankId: number;
}

/** 턴 제출 — seq = 받은 TurnInfo.seq. 방 코드는 페이로드에 없어 소켓이 들어간 방을 쓴다(권한은 서비스가 Redis로 다시 확인) */
export class TurnSubmitDto {
  @IsString()
  @Matches(MATCH_ID_PATTERN)
  matchId: string;

  @IsInt()
  @Min(0)
  @Max(SEQ_MAX)
  seq: number;

  @IsInt()
  @Min(-TURN_INPUT_ABS_MAX)
  @Max(TURN_INPUT_ABS_MAX)
  move: number;

  @IsInt()
  @Min(-TURN_INPUT_ABS_MAX)
  @Max(TURN_INPUT_ABS_MAX)
  angle: number;

  @IsInt()
  @Min(-TURN_INPUT_ABS_MAX)
  @Max(TURN_INPUT_ABS_MAX)
  power: number;

  @IsInt()
  @Min(0)
  @Max(WEAPON_ID_MAX)
  weaponId: number;
}

export class ResyncDto {
  @IsString()
  @Matches(MATCH_ID_PATTERN)
  matchId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(SEQ_MAX)
  seq?: number;

  @IsOptional()
  @IsString()
  @Matches(STATE_HASH_PATTERN)
  clientHash?: string;
}
