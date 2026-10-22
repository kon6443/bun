import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { verify, JwtPayload } from 'jsonwebtoken';
import { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';

type AccessTokenPayload = JwtPayload & { sub: number };

/** 이 소켓이 지금 들어가 있는 방 — disconnect 때 어느 방을 갱신할지 찾는 용도뿐(권한 판정은 Redis 방 기록으로 한다) */
export interface TetrisBattleSocketRoom {
  code: string;
  playerId: string;
}

export interface TetrisBattleSocket extends Socket {
  data: {
    /** 가드가 한 번 판정했으면 true — 이후 핸들러는 다시 판정하지 않는다 */
    authResolved?: boolean;
    /** 로그인 유저면 userId, 게스트면 null */
    userId?: number | null;
    room?: TetrisBattleSocketRoom;
  };
}

/**
 * `/tetris-battle` 전용 WS 가드 — **접속을 거부하지 않는다**(비로그인 참가 허용, DECISIONS D-011).
 *
 * - `handshake.auth.token`(또는 Bearer 헤더)이 유효하고 활성 유저면 `data.userId` 설정
 * - 없거나 무효면 게스트(`data.userId = null`). 표시 이름은 플레이어가 입력하므로 여기서 만들지 않는다
 *
 * fishing 가드와 판정 규칙은 같지만 게스트 이름·음수 id를 만들지 않아 별도 클래스로 둔다(fishing 무수정).
 */
@Injectable()
export class TetrisBattleWsGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<TetrisBattleSocket>();
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

    try {
      const payload = verify(token, secret) as AccessTokenPayload;
      if (!payload?.sub) return null;
      const user = await this.userRepository.findOne({ where: { userId: payload.sub, isActivated: 1 } });
      return user ? user.userId : null;
    } catch {
      // 만료·서명 오류 → 게스트로 강등 (fishing 정책과 같다)
      return null;
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
