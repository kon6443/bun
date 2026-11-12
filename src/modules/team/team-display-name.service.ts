import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { getTeamDisplayName } from '../../common/utils/user.utils';

/**
 * 팀 안에서 보일 이름 해석 — 팀 닉네임(USER_TEAMS.TEAM_NICKNAME) → 계정 닉네임 → "사용자{id}"
 * 팀 닉네임은 가입 때 계정 닉네임을 복사해 두므로(D-004) 계정 닉네임 대체는 NULL 행의 안전망이다.
 *
 * 팀 컨텍스트로 나가는 이름(HTTP 응답·소켓 이벤트·알림)은 이 서비스나 `getTeamDisplayName`을 거친다.
 * 이미 USER_TEAMS를 조인한 쿼리는 `getTeamDisplayName`을 직접 쓰고, 그 외는 여기서 한 번에 조회한다.
 * 팀을 떠난(비활성) 멤버도 행이 남아 있으면 팀 닉네임을 쓴다 — 지난 태스크·댓글·채팅의 작성자 이름이다.
 * (docs/tasks/team-nickname D-001)
 */
@Injectable()
export class TeamDisplayNameService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /** userId → 팀 안 표시 이름. 조회되지 않은 userId도 기본 표시명으로 채운다 */
  async getDisplayNames(teamId: number, userIds: readonly number[]): Promise<Map<number, string>> {
    const uniqueIds = [...new Set(userIds)];
    const names = new Map<number, string>();
    if (uniqueIds.length === 0) return names;

    const rows = await this.userRepository
      .createQueryBuilder('u')
      .leftJoin('u.teamMembers', 'tm', 'tm.teamId = :teamId', { teamId })
      .select('u.userId', 'userId')
      .addSelect('u.userName', 'userName')
      .addSelect('tm.teamNickname', 'teamNickname')
      .where('u.userId IN (:...userIds)', { userIds: uniqueIds })
      .getRawMany<{ userId: number; userName: string | null; teamNickname: string | null }>();

    for (const row of rows) {
      const userId = Number(row.userId);
      names.set(userId, getTeamDisplayName(row.teamNickname, row.userName, userId));
    }
    for (const userId of uniqueIds) {
      if (!names.has(userId)) names.set(userId, getTeamDisplayName(null, null, userId));
    }
    return names;
  }

  async getDisplayName(teamId: number, userId: number): Promise<string> {
    const names = await this.getDisplayNames(teamId, [userId]);
    return names.get(userId) ?? getTeamDisplayName(null, null, userId);
  }
}
