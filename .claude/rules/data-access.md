---
paths:
  - "src/**/*.service.ts"
  - "src/entities/**/*.ts"
  - "src/config/**/*.ts"
---

# 데이터 접근 — 서비스·Entity·설정

## Repository 주입

- Service가 `@InjectRepository(Entity)`로 `Repository<Entity>`를 직접 주입받는다. Repository 클래스는 만들지 않는다.

## 쿼리 스타일

| 상황 | 사용 |
|---|---|
| 단건·단순 목록 | `repository.findOne / find / findAndCount` |
| 조인·집계·동적 조건 | `createQueryBuilder` |
| raw `.query()` | **쓰지 않는다** |

- Entity는 `src/entities/`에 **테이블당 1파일**(PascalCase, 예: `TeamTask.ts`), 컬럼은 `@Column({ name: 'UPPER_SNAKE' })`로 Oracle 실제 컬럼명을 명시한다.
- 서비스가 Entity가 아닌 쿼리 결과 shape를 반환하면, 테스트 factory는 그 반환 타입에서 타입을 끌어와 `create*View`로 Entity factory와 따로 둔다 (예: `entity.factory.ts`의 `TeamTaskView`).
- 스키마 관련 함정(`nullable` 무효, PK IDENTITY, 문자열 컬럼 타입, 민감 컬럼)은 `schema-migrations.md`.

## 트랜잭션 — `dataSource.transaction()` 콜백

```typescript
await this.dataSource.transaction(async (manager: EntityManager) => {
  await manager.save(...);
  await manager.update(...);
});
```

- 여러 테이블에 걸친 쓰기는 이 형태로 감싼다 (예: `team.service.ts`, `telegram.service.ts`).
- `@Transactional`(typeorm-transactional)과 `queryRunner` 수동 열기/닫기는 **쓰지 않는다**. typeorm-transactional 도입은 `docs/tasks/tasks-nestjs-improvements.md`의 해당 절(Oracle 미검증)에서 결정되기 전까지 새로 쓰지 않는다.

## 스케줄러 — 2단 가드 필수

```typescript
// src/modules/scheduler/scheduler.service.ts
private shouldSkipScheduler(): boolean {
  return !this.schedulerEnvs.includes(this.env) || this.TASK_SLOT !== 1;
}
```

- 가드 없는 `@Cron`은 모든 레플리카에서 중복 실행된다.
- `TASK_SLOT`은 `infra/docker-stack.app.yml`의 `{{.Task.Slot}}`으로 주입되고 **1인 레플리카만** 실행한다. env 화이트리스트도 함께 건다.
- Prometheus 게이지처럼 "전역 1회 계산" 지표도 `TASK_SLOT=1`에서만 갱신한다 (중복 timeseries 방지).

## 신규 스케줄러·배치 체크리스트

- [ ] `TASK_SLOT !== 1` + env 화이트리스트 2단 가드
- [ ] 공유 상태는 Redis (인메모리 금지)
