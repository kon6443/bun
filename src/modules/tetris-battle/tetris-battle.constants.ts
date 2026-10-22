/**
 * 대전 서버 내부 상수 (프론트 계약이 아닌 값 — 계약 상수는 tetris-battle.events.ts)
 *
 * 빈도 제한을 공용 `throttle.constants.ts`가 아니라 여기 두는 이유: HTTP 스로틀러가 아니라
 * 이 모듈의 Redis 카운터가 쓰는 값이고, 공용 파일은 다른 브랜치와 충돌 위험이 크다(DECISIONS D-003).
 */

/** 방 키 TTL(초) — 쓰기마다 갱신. 2시간 동안 아무 변경이 없는 방은 Redis가 지운다 */
export const ROOM_TTL_SECONDS = 2 * 60 * 60;

/** WAITING·RESULT 방에서 끊긴 플레이어를 자리에서 빼기까지의 유예(ms) — DESIGN §8 재연결 유예와 같은 값 */
export const DISCONNECT_GRACE_MS = 10_000;

/** 같은 방 동시 변경 충돌(CAS 실패) 시 재시도 횟수 */
export const ROOM_CAS_MAX_ATTEMPTS = 8;

/** 방 코드 충돌 시 새 코드로 재시도 횟수 (31^6 ≈ 8.9억 — 사실상 1회에 끝난다) */
export const ROOM_CODE_MAX_ATTEMPTS = 5;

/** 로비 목록에 내보내는 방 수 상한, 로비 인덱스에서 읽어 보는 후보 수 */
export const LOBBY_LIST_LIMIT = 50;
export const LOBBY_SCAN_LIMIT = 200;

/** 비밀번호 해시: scrypt(N=16384 기본값) 64바이트 키 + 16바이트 salt */
export const PASSWORD_KEY_LENGTH = 64;
export const PASSWORD_SALT_BYTES = 16;

/**
 * 비밀번호 시도 한도 — 같은 방에서 windowSec 안에 maxFailures번까지만 검증하고, 그 다음 시도부터 창이 끝날 때까지 잠금.
 * 시도를 검증 **전에** 세고(동시 시도 우회 차단), 정답이면 되돌린다 — 결과적으로 오답만 쌓인다.
 * 소켓 단위(기본 방어) + IP 단위(소켓을 새로 열어 소켓 카운터를 초기화하는 우회 차단). IP는 NAT 공유를 고려해 넉넉히
 */
export const PASSWORD_FAILURE_LIMIT = { maxFailures: 5, windowSec: 60 };
export const PASSWORD_FAILURE_LIMIT_IP = { maxFailures: 20, windowSec: 60 };

/** 고정 윈도 빈도 제한 (Redis INCR + EXPIRE NX) */
export const TETRIS_BATTLE_RATE_LIMITS = {
  /** 방 생성 — 소켓 단위 */
  createRoomSocket: { limit: 3, windowSec: 60 },
  /** 방 생성 — IP 단위 (소켓을 새로 열어 소켓 제한을 우회하는 것을 막는다) */
  createRoomIp: { limit: 10, windowSec: 60 },
  /** 방 입장 — 소켓 단위 (비밀번호 대입·재연결 폭주 방지) */
  joinRoomSocket: { limit: 10, windowSec: 10 },
  /** 방 입장 — IP 단위 (NAT 공유를 고려해 넉넉히) */
  joinRoomIp: { limit: 30, windowSec: 10 },
  /** 준비 토글 — 방·플레이어 단위 */
  setReady: { limit: 10, windowSec: 10 },
  /** 채팅 — 방·플레이어 단위 (재연결로 소켓을 바꿔도 이어서 센다) */
  chat: { limit: 5, windowSec: 5 },
  /** 이모트 — 방·플레이어 단위 */
  emote: { limit: 6, windowSec: 5 },
} as const;

export type TetrisBattleRateLimitAction = keyof typeof TETRIS_BATTLE_RATE_LIMITS;

/**
 * 방 단위 생존 확인 (DESIGN D-015 예정) — 끊김 이벤트를 놓친 유령(레플리카 비정상 종료·Redis 오류)을 정리한다.
 * 변경·목록 조회 때 방당 INTERVAL에 1번만 전 레플리카의 방 채널 소켓을 조회하고(TIMEOUT),
 * connected=true인데 채널에 없고 연결 후 MIN_CONNECTED 이상 지난 플레이어를 끊김으로 표시한다 → 기존 유예 정리가 이어서 처리.
 * MIN_CONNECTED: 서비스 커밋과 소켓의 채널 입장 사이의 짧은 틈을 유령으로 오판하지 않기 위한 여유.
 */
export const LIVENESS_PROBE_INTERVAL_MS = 15_000;
export const LIVENESS_PROBE_TIMEOUT_MS = 2_000;
export const LIVENESS_MIN_CONNECTED_MS = 5_000;

/** 매치 키 TTL(초) — lock·KO마다 갱신. 경기가 끝난 뒤에도 이 시간 동안 가비지 로그·통계가 남는다(P5 검증) */
export const MATCH_TTL_SECONDS = 2 * 60 * 60;

/** matchStarting 후 실제 시작까지(ms) — 클라이언트가 수신 시각 + 이 값으로 카운트다운 (DESIGN §3) */
export const MATCH_START_DELAY_MS = 3_000;

/**
 * lock 남발 상한 — 빈도 카운터 대신 **게임 시간 근거**(Lua 안에서 판정, 위반은 INVALID_PAYLOAD)
 *  ① frame ≤ (Redis 현재 − 매치 시계 시작) × 60 / 1000 + LOCK_FRAME_SLACK
 *     매치 시계 시작 = 매치 생성 시각(Redis TIME) + MATCH_START_DELAY_MS. 클라이언트는 matchStarting **수신 후** startInMs를 세므로
 *     정상 클라이언트의 0프레임은 항상 서버 기준 시작보다 늦다(전송 지연만큼) → 프레임이 서버 상한보다 작아지는 방향이라 안전.
 *     여유 120프레임(2초)은 클라이언트 시계가 빠르게 도는 경우·백그라운드 복귀 따라잡기의 반올림 오차를 흡수한다.
 *     서버 시각은 Redis TIME 하나만 쓴다 — 레플리카 간 시계 차이가 판정에 끼지 않게.
 *  ② seq 증가분 ≤ floor(frame 증가분 / SPAWN_DELAY_FRAMES) + 1
 *     블록이 고정되면 다음 블록은 최소 SPAWN_DELAY_FRAMES(6프레임) 뒤에 나온다(줄 삭제면 더 길다) → k개 고정에는 최소 6(k−1)프레임.
 *     +1은 직전 보고 이후 첫 고정(간격 0 허용)이라 정상 플레이는 항상 통과한다(골든 리플레이 전체로 6380 스펙에서 확인).
 */
export const LOCK_FRAME_SLACK = 120;

/** 리플레이 제출 마감 — 경기 종료 후 이 시간이 지나면 410, 미제출자는 MISSING으로 저장 (DESIGN §17-1) */
export const REPLAY_SUBMIT_DEADLINE_MS = 60_000;

/**
 * 경기 후 검증의 가비지 누락 허용 폭(D-022·리뷰 L4) — 탈락·종료 시각 이 시간 전부터 보낸 가비지만 리플레이에서 빠져도 된다.
 * 근거: 서버 시각은 "탈락 보고·종료 판정이 서버에 도착한 때"라 실제 클라이언트 판이 끝난 때보다 **왕복 지연만큼 늦다**.
 *   모바일 왕복(수백 ms ~ 2초대)을 넉넉히 덮도록 3초. 탈락자(topOut 도착)·생존자(종료는 마지막 상대의 보고 도착 → matchEnded 전송)
 *   모두 같은 왕복 지연 구조라 한 상수로 통일한다
 */
export const GARBAGE_TAIL_GRACE_MS = 3_000;

/**
 * 생존자 리플레이 frames 상한 여유(리뷰 L5) — frames ≤ 경과 시간 × 60 + 이 값.
 * 생존자는 matchEnded를 받을 때까지 판을 진행하므로 종료 판정 뒤 전송 지연만큼 더 진행된다(5초 = 300프레임)
 */
export const SURVIVOR_FRAME_SLACK = 300;

/** 경기 후 검증 REST 스로틀 — 공용 throttle.constants.ts 대신 여기(D-003 충돌 회피, 위 머리 주석) */
export const THROTTLE_BATTLE_REPLAY_SUBMIT = { short: { ttl: 1000, limit: 2 }, long: { ttl: 60000, limit: 20 } };
export const THROTTLE_BATTLE_RESULT_READ = { short: { ttl: 1000, limit: 3 }, long: { ttl: 60000, limit: 60 } };

/** 매치 id 형식 — 서버가 발급한 12바이트 base64url */
export const MATCH_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

/** playerToken: 24바이트 난수 base64url. Redis에는 sha256 해시만 둔다 */
export const PLAYER_TOKEN_BYTES = 24;

/** socket.io room 이름 */
export const LOBBY_ROOM = 'tetris-battle:lobby';
export const roomChannel = (code: string): string => `tetris-battle:room:${code}`;
/**
 * 플레이어 채널 — garbage는 소켓 id가 아니라 이 채널로 보낸다(리뷰 H2).
 * 재연결한 새 소켓이 이 채널에 먼저 들어간 뒤 놓친 가비지를 조회하므로, 그 사이 생긴 가비지는 둘 중 하나로 반드시 받는다
 */
export const playerChannel = (code: string, playerId: string): string => `tetris-battle:player:${code}:${playerId}`;
