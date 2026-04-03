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
 * 팀 알림 전송 파라미터
 */
export interface TeamNotificationParams {
  team: NotificationTeamInfo;
  message: string;
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
