import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { AccessTokenPayload, extractSocketAccessToken, verifyAccessToken } from '../utils/access-token.utils';

/**
 * Socket에 저장되는 인증 정보 타입
 */
export interface AuthenticatedSocket extends Socket {
  data: {
    user?: User;
    /** joinTeam 시 캐싱되는 팀 ID (채팅 등 후속 이벤트의 room 식별용) */
    teamId?: number;
  };
}

/**
 * WebSocket 전용 JWT 인증 Guard
 *
 * NestJS 정석 패턴:
 * - HTTP JwtAuthGuard와 동일한 검증 로직
 * - handshake.auth.token 또는 Authorization 헤더에서 토큰 추출
 * - 검증된 user 정보를 client.data.user에 저장
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<AuthenticatedSocket>();
    const token = this.extractToken(client);

    if (!token) {
      this.logger.warn(`인증 토큰 없음: ${client.id}`);
      throw new WsException({ code: 'AUTH_UNAUTHORIZED', message: '인증 토큰이 필요합니다.' });
    }

    const payload = this.verifyToken(token);

    const user = await this.userRepository.findOne({
      where: { userId: payload.sub, isActivated: 1 },
    });

    if (!user) {
      this.logger.warn(`사용자 없음: userId=${payload.sub}`);
      throw new WsException({ code: 'AUTH_UNAUTHORIZED', message: '사용자를 찾을 수 없습니다.' });
    }

    // client.data에 user 정보 저장 (이후 Gateway에서 사용)
    client.data.user = user;

    return true;
  }

  /**
   * Socket handshake에서 토큰 추출 — auth.token > Authorization Bearer (규칙은 extractSocketAccessToken 한 곳)
   */
  private extractToken(client: Socket): string | null {
    return extractSocketAccessToken(client);
  }

  /**
   * JWT 토큰 검증 (판정은 verifyAccessToken 한 곳, 에러 모양만 여기서)
   */
  private verifyToken(token: string): AccessTokenPayload {
    const result = verifyAccessToken(token, this.configService.get<string>('JWT_SECRET'));
    if (result.ok) return result.payload;
    switch (result.reason) {
      case 'NO_SECRET':
        throw new WsException({ code: 'AUTH_INVALID_TOKEN', message: '서버 설정 오류: JWT_SECRET이 없습니다.' });
      case 'NO_SUBJECT':
        throw new WsException({ code: 'AUTH_INVALID_TOKEN', message: '유효하지 않은 토큰입니다.' });
      case 'INVALID':
        throw new WsException({ code: 'AUTH_INVALID_TOKEN', message: '토큰 검증에 실패했습니다.' });
    }
  }
}
