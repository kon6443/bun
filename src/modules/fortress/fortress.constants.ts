import { createGameRoomKeys } from '../game-room/game-room-keys';

/**
 * 포트리스 대전 서버 내부 상수 (프론트 계약이 아닌 값 — 계약 상수는 fortress.events.ts)
 *
 * 방·로비·빈도 제한·하트비트 값은 테트리스 대전(`tetris-battle.constants.ts`)과 같게 두고, 턴 매치 값만 따로 둔다.
 * 테트리스 상수를 import하지 않는 이유: 두 게임의 값이 따로 조정될 수 있고 F3c(라이프사이클 공용화) 전까지 테트리스 파일을 건드리지 않는다(D-014).
 */

/** 방 Redis 키 (공용 부품 game-room-keys, 접두사 `fortress:`) — 배포 중 옛·새 레플리카가 같이 읽는다. 바꾸지 않는다 */
export const FORTRESS_ROOM_KEYS = createGameRoomKeys('fortress:');

/**
 * 경기 Redis 키 (모두 TTL 있음 — allkeys-lru라 TTL 없는 키가 쌓이면 다른 키가 밀려난다)
 *
 * | 키 | 타입 | TTL |
 * |---|---|---|
 * | fortress:match:{matchId} | Hash { v: 버전, json: StoredMatch } | MATCH_TTL_SECONDS, 쓰기마다 갱신 |
 * | fortress:deadlines | ZSET matchId → 다음 처리 시각(ms) — 턴 마감·끊김 유예 중 이른 쪽 | MATCH_TTL_SECONDS, 쓰기마다 갱신 |
 * | fortress:pending-saves | ZSET matchId → 결과 저장 처리 시각(ms) — 끝났는데 아직 DB에 없는 경기(F6, DESIGN §12) | MATCH_TTL_SECONDS, 쓰기마다 갱신 |
 * | fortress:match:{matchId}:saving | String — 저장 진행 가드(SET NX) | SAVE_GUARD_TTL_SECONDS |
 * | fortress:match:{matchId}:saved | String — DB 저장 완료 표시 | MATCH_TTL_SECONDS |
 */
export const FORTRESS_MATCH_KEYS = {
  match: (matchId: string): string => `fortress:match:${matchId}`,
  deadlines: 'fortress:deadlines',
  pendingSaves: 'fortress:pending-saves',
  saving: (matchId: string): string => `fortress:match:${matchId}:saving`,
  saved: (matchId: string): string => `fortress:match:${matchId}:saved`,
} as const;

/** 방 키 TTL(초) — 쓰기마다 갱신 */
export const ROOM_TTL_SECONDS = 2 * 60 * 60;
/** 경기 키 TTL(초) — 행동마다 갱신. 4인 30라운드(최대 120턴 × 약 31초 ≈ 1시간)보다 넉넉히 */
export const MATCH_TTL_SECONDS = 2 * 60 * 60;

/** WAITING·RESULT 방에서 끊긴 플레이어를 자리에서 빼기까지의 유예(ms) — 방 코어 그대로(테트리스와 같은 값, DESIGN §3) */
export const DISCONNECT_GRACE_MS = 10_000;
/** 경기 중 끊김 유예(ms) — 넘으면 서버가 resign(cause disconnect)을 넣는다(D-011) */
export const MATCH_DISCONNECT_GRACE_MS = 30_000;
/** 깨우기 여유(ms) — 마감·유예가 끝난 직후 깨울 때 경계를 확실히 넘기려고 더한다 */
export const WAKE_MARGIN_MS = 500;
/** 경기 종료를 방에 반영하지 못했을 때 다시 시도하기까지 · 재시도 상한 (테트리스 BE-05와 같은 방식) */
export const FINISH_RETRY_DELAY_MS = 1_000;
export const FINISH_RETRY_MAX_ATTEMPTS = 3;

/**
 * 결과 저장(F6, DESIGN §12) — 저장 진행 가드 TTL(저장 중 프로세스가 죽어도 이 시간 뒤 다음 계기가 다시 잡는다) ·
 * 저장 대기 크론이 한 번에 집는 수 · 저장 못 한 경기를 뒤로 미루는 시간 · 크론을 돌리는 ENV(LOCAL·DEV 제외 — data-access 2단 가드, 테트리스 대전과 같은 값)
 */
export const SAVE_GUARD_TTL_SECONDS = 120;
export const PENDING_SAVE_SWEEP_LIMIT = 20;
export const PENDING_SAVE_RETRY_MS = 60_000;
export const PENDING_SAVE_SWEEP_ENVS: readonly string[] = ['QA', 'PROD'];
/**
 * 결과 조회 lazy 저장이 busy(다른 레플리카가 저장 가드를 잡고 저장 중)일 때 DB 행을 기다리는 간격·상한(ms, 리뷰 A1) —
 * 저장 트랜잭션은 보통 수십~수백 ms라 상한 안에 끝난다. 넘으면 지금처럼 404(요청을 오래 붙잡지 않게)
 */
export const LAZY_SAVE_POLL_INTERVAL_MS = 100;
export const LAZY_SAVE_WAIT_MAX_MS = 2_000;

/** 결과 조회 REST 스로틀 — 테트리스 대전 결과 조회와 같은 값 */
export const THROTTLE_FORTRESS_RESULT_READ = { short: { ttl: 1000, limit: 3 }, long: { ttl: 60000, limit: 60 } };
/** 최근 경기 목록 개수 */
export const MATCH_LIST_DEFAULT_LIMIT = 10;
export const MATCH_LIST_MAX_LIMIT = 20;

/** matchStarting 후 실제 시작까지(ms) — 첫 턴 마감은 이만큼 뒤에서 센다 */
export const MATCH_START_DELAY_MS = 3_000;

/**
 * 마감 스위퍼 — `TASK_SLOT === '1'` 레플리카만 SWEEP_INTERVAL_MS마다 마감 ZSET에서 지난 경기를 SWEEP_BATCH개씩 처리한다.
 * 처리한 레플리카의 로컬 타이머가 주 경로이고, 스위퍼는 그 레플리카가 죽었을 때의 보완이다(DESIGN §11 타이머)
 */
export const SWEEP_INTERVAL_MS = 1_000;
export const SWEEP_BATCH = 50;

/** 한 번 깨울 때 연달아 넣을 수 있는 서버 행동 상한(끊김 resign 여러 개 + skip) — 무한 반복 방지 */
export const SERVER_ACTION_MAX_PER_WAKE = 8;
/** 같은 경기 동시 변경 충돌(CAS 실패) 시 재시도 횟수 */
export const MATCH_CAS_MAX_ATTEMPTS = 8;

/** 하트비트 — 테트리스 대전과 같은 값(tetris-audit D-010·D-012) */
export const PRESENCE_PING_INTERVAL_MS = 4_000;
export const HEARTBEAT_TTL_MS = 10_000;
export const HEARTBEAT_PROBE_INTERVAL_MS = 5_000;
export const HEARTBEAT_MIN_INTERVAL_MS = 1_000;

/** 생존 확인 — 테트리스 대전과 같은 값 */
export const LIVENESS_PROBE_INTERVAL_MS = 15_000;
export const LIVENESS_PROBE_TIMEOUT_MS = 2_000;
export const LIVENESS_MIN_CONNECTED_MS = 5_000;

/** 같은 방 동시 변경 충돌(CAS 실패) 시 재시도 횟수 · 방 코드 충돌 재시도 */
export const ROOM_CAS_MAX_ATTEMPTS = 8;
export const ROOM_CODE_MAX_ATTEMPTS = 5;

/** 로비 목록 상한 · 인덱스 읽기 후보 수 · 인덱스 끝 정리 · 로비 방송 묶기 */
export const LOBBY_LIST_LIMIT = 50;
export const LOBBY_SCAN_LIMIT = 200;
export const LOBBY_TAIL_SWEEP_BATCH = 20;
export const LOBBY_BROADCAST_DEBOUNCE_MS = 300;

/** 비밀번호 해시·시도 한도 — 테트리스 대전과 같은 값 */
export const PASSWORD_KEY_LENGTH = 64;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_FAILURE_LIMIT = { maxFailures: 5, windowSec: 60 };
export const PASSWORD_FAILURE_LIMIT_IP = { maxFailures: 20, windowSec: 60 };

/** playerToken: 24바이트 난수 base64url. Redis에는 sha256 해시만 둔다 */
export const PLAYER_TOKEN_BYTES = 24;

/** 매치 id 형식 — 서버가 발급한 12바이트 base64url */
export const MATCH_ID_BYTES = 12;
export const MATCH_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

/** 고정 윈도 빈도 제한 (Redis INCR + EXPIRE NX) — 방·로비는 테트리스 대전과 같은 값 */
export const FORTRESS_RATE_LIMITS = {
  createRoomSocket: { limit: 3, windowSec: 60 },
  createRoomIp: { limit: 10, windowSec: 60 },
  joinRoomSocket: { limit: 10, windowSec: 10 },
  joinRoomIp: { limit: 30, windowSec: 10 },
  setReady: { limit: 10, windowSec: 10 },
  /** 방 설정·팀·탱크 변경 — 방·플레이어 단위(변경마다 방 전체 방송이라 연타만 막는다) */
  roomEdit: { limit: 15, windowSec: 10 },
  chat: { limit: 5, windowSec: 5 },
  emote: { limit: 6, windowSec: 5 },
  kick: { limit: 10, windowSec: 10 },
  listRoomsSocket: { limit: 5, windowSec: 5 },
  listRoomsIp: { limit: 30, windowSec: 5 },
  /** 턴 제출 — 방·플레이어 단위. 정상은 내 턴에 1번이라 반복 송신만 막는다(엔진 적용·경기 키 읽기 비용) */
  turnSubmit: { limit: 10, windowSec: 5 },
  /** resync — 방·플레이어 단위. 정상은 해시 불일치·재연결 때만이라 반복 요청만 막는다(행동 재적용 비용) */
  resync: { limit: 10, windowSec: 10 },
  /** 로비 채팅 구독 — 소켓 단위 (최근 대화·참여 수 조회 연타 방지) — 아래 4개는 테트리스 대전 로비 채팅과 같은 값(D-016) */
  lobbyChatJoin: { limit: 5, windowSec: 10 },
  /** 로비 채팅 구독 — IP 단위 (소켓을 새로 열어 우회하는 것을 막는다, NAT 공유를 고려해 넉넉히) */
  lobbyChatJoinIp: { limit: 30, windowSec: 10 },
  /** 로비 채팅 — 보낸 사람 단위(로그인 userId, 게스트 IP) */
  lobbyChat: { limit: 5, windowSec: 10 },
  /** 로비 채팅 — IP 단위 (여러 계정·소켓으로 도배하는 것을 막는다) */
  lobbyChatIp: { limit: 15, windowSec: 10 },
} as const;

export type FortressRateLimitAction = keyof typeof FORTRESS_RATE_LIMITS;

/** socket.io room 이름 */
export const LOBBY_ROOM = 'fortress:lobby';
/** 로비 전체 채팅 구독 채널 (D-016) — 방 목록 구독(LOBBY_ROOM)과 따로 들어가고 나간다. 테트리스 `tetris-battle:lobby-chat`과 다른 채널 */
export const LOBBY_CHAT_ROOM = 'fortress:lobby-chat';
/** 로비 채팅 최근 대화 Redis List — DB에 남기지 않고 최근 N개를 잠깐만 (테트리스와 같은 값, 키만 다르다) */
export const LOBBY_CHAT_HISTORY_KEY = 'fortress:lobby-chat:recent';
export const LOBBY_CHAT_HISTORY_LIMIT = 50;
export const LOBBY_CHAT_HISTORY_TTL_SEC = 30 * 60;
export const roomChannel = (code: string): string => `fortress:room:${code}`;
