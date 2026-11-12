import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { verify, JwtPayload } from 'jsonwebtoken';
import { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { FortressError } from './fortress.errors';

type AccessTokenPayload = JwtPayload & { sub: number };

/** 이 소켓이 지금 들어가 있는 방 — disconnect 때 어느 방을 갱신할지 찾는 용도뿐(권한 판정은 Redis 방 기록으로 한다) */
export interface FortressSocketRoom {
  code: string;
  playerId: string;
}

export interface FortressSocket extends Socket {
  data: {
    /** 가드가 한 번 판정했으면 true — 이후 핸들러는 다시 판정하지 않는다 */
    authResolved?: boolean;
    /** 로그인 유저면 userId, 게스트면 null */
    userId?: number | null;
    room?: FortressSocketRoom;
    /** 마지막으로 처리한 heartbeat 시각(ms) — 소켓 로컬 빈도 제한용 */
    lastHeartbeatAt?: number;
    /** 로비 채팅을 구독했으면 보낸 사람 표시(구독 때 정함) — D-016 */
    lobbyChat?: { isGuest: boolean; name: string | null };
  };
}

/**
 * `/fortress` 전용 WS 가드 — **접속을 거부하지 않는다**(비로그인 참가 허용, 테트리스 대전과 같다).
 *
 * - `handshake.auth.token`(또는 Bearer 헤더)이 유효하고 활성 유저면 `data.userId` 설정
 * - 없거나 무효면 게스트(`data.userId = null`). 표시 이름은 플레이어가 입력하므로 여기서 만들지 않는다
 *
 * 판정 규칙은 TetrisBattleWsGuard와 같다. 에러 타입(FortressError → 포트리스 예외 필터)이 달라 별도 클래스로 둔다(테트리스 무수정, D-014).
 */
@Injectable()
export class FortressWsGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<FortressSocket>();
    if (client.data.authResolved) return true;

    client.data.userId = await this.resolveUserId(client);
    client.data.authResolved = true;
    return true;
  }

  private async resolveUserId(client: Socket): Promise<number | null> {
    const token = this.extractToken(client);
    if (!token) return null;

    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) return null;

    let payload: AccessTokenPayload;
    try {
      payload = verify(token, secret) as AccessTokenPayload;
    } catch {
      // 만료·서명 오류 → 게스트로 강등 (fishing 정책과 같다)
      return null;
    }
    if (!payload?.sub) return null;

    try {
      const user = await this.userRepository.findOne({ where: { userId: payload.sub, isActivated: 1 } });
      return user ? user.userId : null;
    } catch {
      // DB 일시 오류는 게스트로 확정하지 않는다 — 확정하면 이 소켓은 끝까지 게스트라 좌석 넘겨받기·결과 귀속이 깨진다(테트리스 games-polish BT-03과 같은 이유).
      // authResolved를 세우기 전에 던지므로 다음 이벤트에서 다시 조회한다
      throw new FortressError('SERVICE_UNAVAILABLE');
    }
  }

  private extractToken(client: Socket): string | null {
    const authToken: unknown = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken) return authToken;

    const authHeader = client.handshake.headers?.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) return authHeader.slice(7);

    return null;
  }
}
