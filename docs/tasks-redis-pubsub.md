# Task Tracker: Redis Pub/Sub for Multi-Replica Socket.IO

> 이 문서는 **레포 안에 포함**되어 다른 머신/세션에서도 작업 진행 상황을 추적할 수 있음.
> 새 Claude Code 세션에서 이 파일을 참조하여 남은 작업을 이어서 진행.

## 구현 (Implementation) - DONE

- [x] **패키지 설치** — `ioredis@5.9.3`, `@socket.io/redis-adapter@8.3.0`
- [x] **RedisIoAdapter 생성** — `src/common/adapters/redis-io.adapter.ts`
  - IoAdapter 상속, pub/sub 2개 연결, ConfigService에서 호스트/포트 읽기
  - `connectToRedis()`, `getPubClient()` 제공
- [x] **OnlineUserService 생성** — `src/modules/team/online-user.service.ts`
  - Redis Hash/Set 기반, 모든 메서드 try-catch, TTL 1시간
  - `addUserToOnline`, `removeSocket`, `getUserOnlineInfo`, `getOnlineUsersForTeam`, `getOnlineUsersCount`, `isSocketRegistered`, `getSocketUserMapping`
- [x] **team.module.ts 수정** — OnlineUserService providers/exports 등록
- [x] **main.ts 수정** — IoAdapter → RedisIoAdapter, Redis 연결 + 클라이언트 주입
- [x] **team.gateway.ts 수정** — in-memory Map 2개 제거, OnlineUserService 위임, async 전환
- [x] **infra/setup-redis.sh 생성** — Redis Swarm 서비스 멱등 스크립트
- [x] **.env 수정** — REDIS_HOST=localhost, REDIS_PORT=6379 추가
- [x] **빌드 검증** — `pnpm run build` 통과

## 테스트 (Testing) - TODO

### 로컬 단일 레플리카 테스트
- [ ] **Redis 로컬 실행**: `docker run -d -p 6379:6379 --name redis-test redis:7-alpine`
- [ ] **앱 시작 확인**: `pnpm dev` → 로그에 아래 메시지 확인
  - `Redis pub 클라이언트 연결`
  - `Redis sub 클라이언트 연결`
  - `Redis 연결 확인 완료 (PING → PONG)`
  - `Redis adapter 적용 완료`
  - `WebSocket RedisIoAdapter 설정 완료`
- [ ] **팀 입장 테스트**: 프론트에서 팀 입장 → `userJoined`, `onlineUsers` 이벤트 정상 수신
- [ ] **Redis 키 확인**: `docker exec redis-test redis-cli KEYS '*'` → `socket:*`, `team:*:online`, `team:*:user:*:sockets` 키 생성 확인
- [ ] **팀 퇴장 테스트**: 팀 퇴장 또는 브라우저 탭 닫기 → Redis 키 삭제 확인
- [ ] **다중 탭 테스트**: 같은 유저로 2개 탭 입장 → 1개 탭 닫아도 `userLeft` 안 보내짐, 2개 다 닫으면 `userLeft` 발생
- [ ] **Redis 없이 시작**: Redis 중지 후 `pnpm dev` → 앱 시작은 되고 warn 로그만 출력 확인

### 이벤트 기능 테스트
- [ ] **태스크 CRUD**: 태스크 생성/수정/상태변경/삭제 → 실시간 이벤트 수신 확인
- [ ] **댓글 CRUD**: 댓글 생성/수정/삭제 → 실시간 이벤트 수신 확인
- [ ] **멤버 역할/상태**: 멤버 역할 변경, 상태 변경 → 이벤트 수신 확인

## 배포 (Deploy) - TODO

### 서버 사전 작업
- [ ] **Redis Swarm 서비스 생성**: `infra/setup-redis.sh`를 배포 서버에 복사 후 실행
  ```bash
  scp infra/setup-redis.sh ubuntu@server:/tmp/
  ssh ubuntu@server 'bash /tmp/setup-redis.sh'
  ```
- [ ] **Redis 서비스 상태 확인**: `docker service ps sys_redis` → Running 확인
- [ ] **배포 서버 .env 수정**: `/home/ubuntu/desktop/deploy/sys/config/env/.env`에 추가
  ```
  REDIS_HOST=sys_redis
  REDIS_PORT=6379
  ```

### 코드 배포
- [ ] **git push** → GitHub Actions CI/CD가 `sys_express` 이미지 빌드 & 배포
- [ ] **배포 후 로그 확인**: `docker service logs sys_express` → Redis 연결 로그 확인
- [ ] **기능 테스트**: 프론트에서 팀 입장/태스크 조작 → 정상 동작 확인

### 스케일 업 (Redis + 코드 배포 완료 후)
- [ ] **레플리카 2로 확장**: `docker service scale sys_express=2`
- [ ] **멀티 레플리카 테스트**:
  - 브라우저 2개 탭에서 같은 팀 입장
  - 한 탭에서 태스크 생성 → 다른 탭에서 실시간 수신 확인
  - 한 탭 닫기 → 다른 탭에서 `userLeft` 수신 확인
- [ ] **Redis 장애 테스트**: `docker service scale sys_redis=0` → 앱 크래시 없이 HTTP 정상 작동 확인 → `docker service scale sys_redis=1`로 복구

## 참고

- **PRD**: [docs/prd-redis-pubsub.md](./prd-redis-pubsub.md)
- **Redis 키 설계**: OnlineUserService 파일 상단 주석 참조
- **프론트엔드 변경 없음**: Socket.IO 이벤트/페이로드가 동일하게 유지됨
