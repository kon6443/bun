/**
 * 온라인 프레즌스(팀 `online-user.service.ts` · 낚시 `fishing-online.service.ts`) 공용 Lua — 등록·제거를 각각 원자적으로.
 *
 * 키 모양은 두 서비스가 같다: 소켓 매핑 Hash · 유저 소켓 Set · 범위(팀·맵)별 Hash들(필드 = userId).
 * 등록과 제거를 여러 명령으로 나누면 사이에 다른 탭의 등록·제거가 끼어 "온라인인데 목록에서 빠짐",
 * "userLeft 중복·누락", "userJoined 누락"이 생긴다. 스크립트 하나는 Redis에서 끼어들 수 없이 실행된다.
 * (단일 Redis — 클러스터가 아니라 키 슬롯 제약이 없다)
 */

/**
 * 등록 — 반환값은 등록 **전** 이 유저의 소켓 수(> 0이면 이미 온라인 = 입장 알림 생략).
 * KEYS[1]=소켓 매핑 · KEYS[2]=유저 소켓 Set · KEYS[3]=범위 online Hash
 * ARGV[1]=socketId · ARGV[2]=userId · ARGV[3]=userName · ARGV[4]=매핑·Set TTL(초) · ARGV[5]=online TTL(초)
 * ARGV[6]=범위 필드명('teamId'·'mapId') · ARGV[7]=범위 값
 */
export const ADD_SOCKET_SCRIPT = `
local before = redis.call('SCARD', KEYS[2])
redis.call('HSET', KEYS[1], ARGV[6], ARGV[7], 'userId', ARGV[2], 'userName', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('HSET', KEYS[3], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[3], ARGV[5])
return before
`;

/**
 * 제거 — 1이면 이 소켓이 마지막이었다(완전히 오프라인 → 퇴장 알림).
 * 매핑이 이미 지워졌으면(같은 소켓을 leave와 disconnect가 동시에 정리) 0 — 퇴장 알림이 두 번 나가지 않게.
 * KEYS[1]=소켓 매핑 · KEYS[2]=유저 소켓 Set · KEYS[3..]=범위 Hash들(online, 낚시는 positions·states도)
 * ARGV[1]=socketId · ARGV[2]=userId
 */
export const REMOVE_SOCKET_SCRIPT = `
if redis.call('DEL', KEYS[1]) == 0 then
  return 0
end
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('SCARD', KEYS[2]) > 0 then
  return 0
end
redis.call('DEL', KEYS[2])
for i = 3, #KEYS do
  redis.call('HDEL', KEYS[i], ARGV[2])
end
return 1
`;
