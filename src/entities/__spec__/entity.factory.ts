import { User } from '../User';
import { Team } from '../Team';
import { TeamMember } from '../TeamMember';
import { TeamTask } from '../TeamTask';
import { TaskComment } from '../TaskComment';
import { TeamInvitation } from '../TeamInvitation';
import { TelegramLink } from '../TelegramLink';
import { FileShare } from '../FileShare';
import { ActStatus, TaskStatus } from '../../common/enums/task-status.enum';
import type { RoleKey } from '../../common/constants/role.constants';
import type { TeamMemberType } from '../../modules/team/team.service';

/**
 * 테스트용 Entity Factory.
 *
 * 왜 필요한가: Entity에 컬럼을 하나 추가하면 인라인으로 mock 객체를 만든 모든
 * 테스트 파일을 고쳐야 한다. 생성 지점을 여기 하나로 모으고, 테스트는 그 케이스에서
 * 실제로 의미 있는 필드만 override한다.
 *
 * 규칙 4가지:
 *  1. **고정값만 사용한다** — 랜덤 데이터는 "어제는 통과, 오늘은 실패"를 만든다.
 *     날짜도 FIXED_DATE로 고정해 스냅샷·직렬화 비교가 흔들리지 않게 한다.
 *  2. **관계 프로퍼티는 UNSET으로 둔다** — Team ↔ TeamMember처럼 서로를 참조해
 *     순환이 생기고, 단위 테스트는 대부분 관계를 쓰지 않는다.
 *     필요하면 `createTeamMember({ team: createTeam() })`처럼 명시 주입한다.
 *  3. **객체 전체에 `as Entity` 캐스팅을 걸지 않는다** — 그렇게 하면 Entity에
 *     스칼라 컬럼이 추가돼도 컴파일이 통과해 Factory가 조용히 낡는다.
 *     관계 필드에만 UNSET을 쓰고 나머지는 타입 검사를 그대로 받게 한다.
 *  4. **DB 기본값이 아니라 "가장 흔한 정상 케이스"를 기본값으로 둔다** —
 *     테스트가 관심 없는 필드까지 매번 채우지 않아도 되게 하는 것이 목적이다.
 *
 * 사용 예:
 *   const user = createUser();                       // 기본값
 *   const user = createUser({ userName: null });     // 필요한 것만 덮어쓰기
 */

/** 모든 factory가 공유하는 고정 시각 — 재현 가능한 테스트를 위해 절대 Date.now()를 쓰지 않는다. */
export const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

/**
 * 관계 프로퍼티의 기본값. 런타임에는 undefined이며, 접근하면 터진다 —
 * 그것이 의도다. 관계가 필요한 테스트는 반드시 override로 명시 주입해야 한다.
 */
const UNSET = undefined as never;

export const createUser = (overrides: Partial<User> = {}): User => ({
  userId: 1,
  userName: '홍길동',
  birth: null,
  kakaoId: '123456789',
  kakaoEmail: 'test@kakao.com',
  createdDate: FIXED_DATE,
  isActivated: 1,
  teams: [],
  teamMembers: [],
  ...overrides,
});

export const createTeam = (overrides: Partial<Team> = {}): Team => ({
  teamId: 1,
  teamName: '테스트팀',
  teamDescription: null,
  leaderId: 1,
  crtdAt: FIXED_DATE,
  actStatus: ActStatus.ACTIVE,
  telegramChatId: null,
  discordWebhookUrl: null,
  leader: UNSET,
  teamMembers: [],
  ...overrides,
});

export const createTeamMember = (overrides: Partial<TeamMember> = {}): TeamMember => ({
  teamId: 1,
  userId: 1,
  joinedAt: FIXED_DATE,
  role: 'MEMBER' satisfies RoleKey,
  actStatus: ActStatus.ACTIVE,
  team: UNSET,
  user: UNSET,
  ...overrides,
});

export const createTeamTask = (overrides: Partial<TeamTask> = {}): TeamTask => ({
  taskId: 1,
  teamId: 1,
  taskName: '테스트 태스크',
  taskDescription: null,
  taskStatus: TaskStatus.CREATED,
  actStatus: ActStatus.ACTIVE,
  startAt: null,
  endAt: null,
  completedAt: null,
  crtdAt: FIXED_DATE,
  crtdBy: 1,
  team: UNSET,
  user: UNSET,
  ...overrides,
});

export const createTaskComment = (overrides: Partial<TaskComment> = {}): TaskComment => ({
  commentId: 1,
  teamId: 1,
  taskId: 1,
  userId: 1,
  commentContent: '테스트 댓글',
  status: ActStatus.ACTIVE,
  mdfdAt: null,
  crtdAt: FIXED_DATE,
  team: UNSET,
  task: UNSET,
  user: UNSET,
  ...overrides,
});

export const createTeamInvitation = (
  overrides: Partial<TeamInvitation> = {},
): TeamInvitation => ({
  invId: 1,
  teamId: 1,
  userId: 1,
  token: 'test-invite-token',
  usageCurCnt: 0,
  usageMaxCnt: 1,
  actStatus: ActStatus.ACTIVE,
  // 만료는 고정 시각 + 1일 — 테스트가 "아직 유효한 초대"를 기본으로 기대하게 한다
  endAt: new Date(FIXED_DATE.getTime() + 24 * 60 * 60 * 1000),
  crtdAt: FIXED_DATE,
  team: UNSET,
  user: UNSET,
  ...overrides,
});

export const createTelegramLink = (overrides: Partial<TelegramLink> = {}): TelegramLink => ({
  linkId: 1,
  teamId: 1,
  token: 'test-telegram-token',
  actStatus: ActStatus.ACTIVE,
  endAt: new Date(FIXED_DATE.getTime() + 60 * 60 * 1000),
  usedAt: null,
  crtdAt: FIXED_DATE,
  team: UNSET,
  ...overrides,
});

export const createFileShare = (overrides: Partial<FileShare> = {}): FileShare => ({
  shareId: 'test-share-id',
  apiKey: 'test-api-key',
  ...overrides,
});

/**
 * `TeamService.getTeamMembersBy()`의 반환 형태(`TeamMemberType`).
 *
 * Entity가 아니라 **팀+멤버를 flatten한 쿼리 결과 타입**이므로 `createTeamMember`(Entity)와
 * 혼용하면 안 된다. 특히 필드명이 겹치면서 의미가 다르다:
 *  - `actStatus`     → **팀**의 활성 상태
 *  - `userActStatus` → **멤버**의 활성 상태
 *
 * 이 타입을 쓰는 서비스 메서드를 테스트할 때는 반드시 이 factory를 사용한다
 * (Entity factory를 캐스팅해 넣으면 shape 불일치가 조용히 숨는다).
 */
export const createTeamMemberView = (
  overrides: Partial<TeamMemberType> = {},
): TeamMemberType => ({
  // 팀 정보
  teamId: 1,
  teamName: '테스트팀',
  teamDescription: null,
  crtdAt: FIXED_DATE,
  actStatus: ActStatus.ACTIVE,
  leaderId: 1,
  telegramChatId: null,
  discordWebhookUrl: null,
  // 멤버 정보
  userId: 1,
  joinedAt: FIXED_DATE,
  role: 'MEMBER' satisfies RoleKey,
  userActStatus: ActStatus.ACTIVE,
  ...overrides,
});
