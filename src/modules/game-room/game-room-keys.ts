/**
 * 대전 방 Redis 키 (게임 공용, fortress DESIGN §4 F3a) — 게임마다 접두사만 다르다(테트리스 `tetris-battle:`, 포트리스 `fortress:`).
 *
 * 키 문자열을 바꾸면 배포 중 옛·새 레플리카가 서로 다른 키를 읽는다 — 모양은 game-room-keys.spec.ts가 고정한다.
 * 모두 TTL 있음(allkeys-lru라 TTL 없는 키가 쌓이면 다른 키가 밀려난다). TTL은 쓰는 쪽이 정한다.
 *
 * | 키 | 타입 |
 * |---|---|
 * | {prefix}room:{code} | Hash { v: 버전, json: 방 JSON } |
 * | {prefix}rooms | ZSET code → 생성 시각(ms) — 로비 인덱스 |
 * | {prefix}lobby-summary | String JSON — 로비 요약 REST 캐시 |
 * | {prefix}rl:{action}:{subject} | String 카운터 — 빈도 제한 |
 * | {prefix}pwfail:{code}:{socketId} | String 카운터 — 비밀번호 시도(소켓) |
 * | {prefix}pwfail-ip:{code}:{ip} | String 카운터 — 비밀번호 시도(IP) |
 * | {prefix}probe:{code} | String — 생존 확인 간격 게이트 |
 * | {prefix}hb:{code}:{socketId} | String — 마지막 하트비트 |
 * | {prefix}hbprobe:{code} | String — 하트비트 판정 간격 게이트 |
 */
export interface GameRoomKeys {
  room(code: string): string;
  readonly lobbyIndex: string;
  readonly lobbySummary: string;
  rateLimit(action: string, subject: string): string;
  passwordFail(code: string, socketId: string): string;
  passwordFailIp(code: string, ip: string): string;
  probe(code: string): string;
  /** 소켓 단위 — 자리를 넘겨준 옛 탭이 계속 답해도 넘겨받은 소켓의 생존으로 세지 않게 */
  heartbeat(code: string, socketId: string): string;
  heartbeatProbe(code: string): string;
}

/** `prefix`는 구분자 `:`까지 포함한다(예: `'tetris-battle:'`) */
export function createGameRoomKeys(prefix: string): GameRoomKeys {
  return {
    room: (code) => `${prefix}room:${code}`,
    lobbyIndex: `${prefix}rooms`,
    lobbySummary: `${prefix}lobby-summary`,
    rateLimit: (action, subject) => `${prefix}rl:${action}:${subject}`,
    passwordFail: (code, socketId) => `${prefix}pwfail:${code}:${socketId}`,
    passwordFailIp: (code, ip) => `${prefix}pwfail-ip:${code}:${ip}`,
    probe: (code) => `${prefix}probe:${code}`,
    heartbeat: (code, socketId) => `${prefix}hb:${code}:${socketId}`,
    heartbeatProbe: (code) => `${prefix}hbprobe:${code}`,
  };
}
