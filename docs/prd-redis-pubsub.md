# PRD: Redis Pub/Sub for Multi-Replica Socket.IO

## 배경

현재 백엔드(NestJS)가 **단일 레플리카**로 운영 중.
원인: Socket.IO의 온라인 유저 상태가 프로세스 메모리(Map)에 저장되어 있어,
레플리카가 2개 이상이면 각 인스턴스가 서로 다른 유저 목록을 가지게 되고,
한 레플리카에서 emit한 이벤트가 다른 레플리카의 클라이언트에게 도달하지 않음.

## 목표

Redis를 도입하여 백엔드를 **2+ 레플리카로 수평 확장** 가능하게 함.

## Redis가 해결하는 두 가지 문제

1. **이벤트 브로드캐스트**: `@socket.io/redis-adapter`가 Redis Pub/Sub을 통해 모든 레플리카에 이벤트를 전달
2. **공유 상태**: 온라인 유저 정보를 Redis에 저장하여 모든 레플리카가 동일한 데이터를 참조

## 범위

- **백엔드만 변경** - 프론트엔드 변경 없음 (Socket.IO 이벤트/페이로드 동일 유지)
- Redis Swarm 서비스 추가 (기존 `sys_default` 네트워크)
- 기존 모든 Socket.IO 기능 동작 보장

## 아키텍처

```
[Frontend :3000] ←Socket.IO→ [NestJS Replica 1 :3500] ←Redis Pub/Sub→ [NestJS Replica 2 :3500]
                                       ↕                                        ↕
                                  [Redis :6379 (Swarm 내부)]
                                       ↕
                              [Oracle DB (기존 유지)]
```

## 기술 선택

| 기술 | 이유 |
|------|------|
| `ioredis` | 자동 재연결, 파이프라인 지원, TypeScript 지원 |
| `@socket.io/redis-adapter` | Socket.IO 공식 어댑터, `server.to(room).emit()` 자동 중계 |
| `redis:7-alpine` | ~30MB 경량 이미지, Swarm 헬스체크 지원 |

## Redis 키 설계

| 용도 | 키 패턴 | Redis 타입 | TTL |
|------|---------|-----------|-----|
| 소켓→유저 역방향 매핑 | `socket:{socketId}` | Hash (`teamId`, `userId`, `userName`) | 1시간 |
| 유저별 소켓 목록 | `team:{teamId}:user:{userId}:sockets` | Set (socketId 목록) | 1시간 |
| 팀 온라인 유저 | `team:{teamId}:online` | Hash (`userId` → `userName`) | 없음 |

**TTL 1시간**: 서버 비정상 종료 시 남는 고아 키를 자동 정리하는 안전장치.
정상적으로는 disconnect 시 즉시 삭제.

## 변경 파일 요약

| 파일 | 액션 | 설명 |
|------|------|------|
| `package.json` | 수정 | ioredis, @socket.io/redis-adapter 설치 |
| `src/common/adapters/redis-io.adapter.ts` | **생성** | Redis 기반 Socket.IO 어댑터 |
| `src/modules/team/online-user.service.ts` | **생성** | Redis 기반 온라인 유저 관리 서비스 |
| `src/modules/team/team.module.ts` | 수정 | OnlineUserService 등록 |
| `src/main.ts` | 수정 | RedisIoAdapter 적용 + Redis 클라이언트 주입 |
| `src/modules/team/team.gateway.ts` | 수정 | in-memory Map 제거 → OnlineUserService 위임 |
| `infra/setup-redis.sh` | **생성** | Redis Swarm 서비스 생성/업데이트 스크립트 |
| `.env` | 수정 | REDIS_HOST, REDIS_PORT 추가 |

## 에러 처리 전략

- **Redis 연결 실패**: 앱은 시작됨 (HTTP 정상 작동), 멀티 레플리카만 비활성
- **OnlineUserService**: 모든 메서드 try-catch, Redis 장애 시 기본값 반환 (프레즌스 기능만 일시 중단)
- **재연결**: ioredis `retryStrategy`로 최대 3초 간격 자동 재시도

## 성공 기준

1. `pnpm run build` 통과
2. 로컬에서 Redis 연결 후 팀 입장/퇴장/이벤트 정상 동작
3. Docker Swarm에서 2 레플리카 배포 후 크로스-레플리카 이벤트 전달 확인
4. Redis 다운 시 앱 크래시 없이 HTTP API 정상 작동
