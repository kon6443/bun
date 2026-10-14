/**
 * 알림 대상 팀 정보 (순환 참조 방지를 위해 Port에서 자체 정의)
 * Team 엔티티 또는 TeamMemberType 모두 이 인터페이스를 만족함
 */
export interface NotificationTeamInfo {
  teamId: number;
  teamName: string;
  telegramChatId: number | null;
  discordWebhookUrl: string | null;
}

/**
 * 팀 알림 본문 — 채널 중립 구조
 *
 * 문자열 대신 구조로 넘기는 이유: 텔레그램(HTML)과 디스코드(Markdown)는 강조·인용 문법과
 * 이스케이프 규칙이 다르다. 렌더링과 사용자 입력 이스케이프는 각 채널 구현체가 맡는다.
 * 모든 필드는 평문으로 채운다 (마크업 금지).
 */
export interface TeamNotificationContent {
  /** 이벤트 이름 (예: '🆕 새 태스크') — 렌더러가 뒤에 팀명을 붙인다 */
  title: string;
  /** 알림 대상 (태스크명·사용자명) — 강조 표시 */
  subject?: string;
  /** 부가 정보 줄 (상태 전이·기간 등) */
  lines?: string[];
  /** 사용자가 작성한 본문 (댓글 등) — 인용 블록으로 표시, 길면 잘린다 */
  quote?: string;
}

/**
 * 팀 알림 전송 파라미터
 */
export interface TeamNotificationParams {
  team: NotificationTeamInfo;
  content: TeamNotificationContent;
  url?: string;
}

/**
 * 알림 서비스 Port (인터페이스)
 * 구현체(Adapter)를 자유롭게 교체 가능 — 프로덕션/테스트/Slack 전환 등
 */
export interface INotificationPort {
  notifyTeam(params: TeamNotificationParams): void;
}

/**
 * DI 토큰 — NestJS 컨테이너에서 INotificationPort 구현체를 식별하는 고유 키
 */
export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');
