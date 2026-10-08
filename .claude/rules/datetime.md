---
paths:
  - "src/entities/**/*.ts"
  - "src/**/*.service.ts"
  - "src/common/utils/**/*.ts"
  - "src/config/**/*.ts"
  - "migrations/**/*.ts"
  - "migration-datasource.ts"
---

# 날짜/시간 — UTC 저장, 표시 시점 변환 (SSOT)

- Entity의 시각 컬럼은 **전부 `timestamp with time zone`**이다. 새 시각 컬럼도 같은 타입으로 만든다.
- 컨테이너는 `TZ=UTC`(`Dockerfile`)다. UTC로 저장·처리하고 **표시 단계에서만** 로컬로 변환한다.
- 🚫 **`ORA_SDTZ` 설정 금지** — oracledb가 로컬 TZ 기준으로 Date를 저장하므로 세션 TZ는 자동으로 맞아야 한다.
- 🚫 Oracle `FROM_TZ()`에 리전 이름(`'UTC'`) 금지 → 오프셋(`'+00:00'`)을 쓴다 (ORA-01805).
- 텔레그램 등 알림 문자열은 `src/common/utils/date.utils.ts`의 `formatDateTime()`으로 만든다.
- "투과 방식(변환 없음) / timezone-naive" 정책은 폐기됐다 — 그 시절 문서·코드를 근거로 삼지 않는다 (경위: `docs/playbooks/recurring-issues-playbook.md` 클러스터 3).
