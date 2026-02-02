import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { WsException } from '@nestjs/websockets';
import { verify, JwtPayload } from 'jsonwebtoken';
import { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';

/**
 * WebSocket용 JWT payload 타입
 */
type AccessTokenPayload = JwtPayload & {
  sub: number;
  loginType?: string;
};

/**
 * Socket에 저장되는 인증 정보 타입
 */
export interface AuthenticatedSocket extends Socket {
  data: {
    user?: User;
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
      throw new WsException('인증 토큰이 필요합니다.');
    }

    const payload = this.verifyToken(token);

    const user = await this.userRepository.findOne({
      where: { userId: payload.sub, isActivated: 1 },
    });

    if (!user) {
      this.logger.warn(`사용자 없음: userId=${payload.sub}`);
      throw new WsException('사용자를 찾을 수 없습니다.');
    }

    // client.data에 user 정보 저장 (이후 Gateway에서 사용)
    client.data.user = user;

    return true;
  }

  /**
   * Socket handshake에서 토큰 추출
   * 우선순위: auth.token > Authorization Bearer 헤더
   */
  private extractToken(client: Socket): string | null {
    // 1. Socket.io auth 객체에서 추출 (권장 방식)
    const authToken = client.handshake.auth?.token;
    if (authToken && typeof authToken === 'string') {
      return authToken;
    }

    // 2. Authorization 헤더에서 추출 (폴백)
    const authHeader = client.handshake.headers?.authorization;
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }

  /**
   * JWT 토큰 검증
   */
  private verifyToken(token: string): AccessTokenPayload {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new WsException('서버 설정 오류: JWT_SECRET이 없습니다.');
    }

    try {
      const payload = verify(token, secret) as AccessTokenPayload;
      if (!payload?.sub) {
        throw new WsException('유효하지 않은 토큰입니다.');
      }
      return payload;
    } catch (error) {
      if (error instanceof WsException) {
        throw error;
      }
      throw new WsException('토큰 검증에 실패했습니다.');
    }
  }
}
