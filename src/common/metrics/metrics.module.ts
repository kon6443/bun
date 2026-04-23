import { Global, Module } from '@nestjs/common';
import {
  getToken,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';

/**
 * 앱 커스텀 메트릭 (Step 4 B1-1).
 *
 * 전역 Gauge/Counter/Histogram provider 들을 등록해 모든 모듈에서 @InjectMetric 으로 주입 가능.
 * prom-client 의 default register 에 자동 등록되므로 /api/v1/metrics 엔드포인트에 노출됨.
 *
 * 네이밍 컨벤션 (Prometheus 공식 가이드):
 *   <subsystem>_<noun>_<unit>[_total for counter]
 *
 * - ws_*            : WebSocket 관련 (TeamGateway / OnlineUserService)
 * - app_redis_*     : 앱 클라이언트 관점 Redis 상태 (redis_exporter 의 redis_* 와 구분)
 */
const METRIC_NAMES = [
  'ws_connections_active',
  'ws_events_total',
  'ws_event_duration_seconds',
  'ws_team_online_users',
  'app_redis_connection_status',
] as const;

@Global()
@Module({
  providers: [
    makeGaugeProvider({
      name: 'ws_connections_active',
      help: 'WebSocket /teams 네임스페이스 현재 연결 수 (replica 별)',
    }),
    makeCounterProvider({
      name: 'ws_events_total',
      help: 'WebSocket inbound 이벤트 누적 횟수 (C→S @SubscribeMessage)',
      labelNames: ['event'],
    }),
    makeHistogramProvider({
      name: 'ws_event_duration_seconds',
      help: 'WebSocket inbound 이벤트 처리 시간 (prom-client 기본 10 bucket)',
      labelNames: ['event'],
    }),
    makeGaugeProvider({
      name: 'ws_team_online_users',
      help: '팀별 현재 온라인 유저 수 (60s 주기 재계산, TASK_SLOT=1 replica 에서만 갱신)',
      labelNames: ['team_id'],
    }),
    makeGaugeProvider({
      name: 'app_redis_connection_status',
      help: 'NestJS RedisIoAdapter 의 Redis 연결 상태 (1=연결, 0=끊김)',
    }),
  ],
  // getToken 은 @willsoto/nestjs-prometheus 가 내부 prefix 규칙으로 DI 토큰을 생성.
  // 토큰 문자열을 직접 하드코딩하지 않아 향후 라이브러리 prefix 변경에 영향 없음.
  exports: METRIC_NAMES.map(getToken),
})
export class MetricsModule {}
