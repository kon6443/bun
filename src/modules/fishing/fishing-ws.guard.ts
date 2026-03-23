import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { verify, JwtPayload } from 'jsonwebtoken';
import { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';

type AccessTokenPayload = JwtPayload & {
  sub: number;
  loginType?: string;
};

/**
 * Socket에 저장되는 데이터 타입 (게스트 지원)
 */
export interface FishingSocket extends Socket {
  data: {
    user?: User;
    /** 게스트 유저용 정보 */
    guestId?: number;
    guestName?: string;
    /** 인증 여부 */
    isAuthenticated: boolean;
  };
}

/**
 * Fishing 전용 WebSocket Guard (게스트 허용)
 *
 * - JWT 토큰이 있으면 → 인증 유저 (client.data.user 설정)
 * - 토큰이 없거나 유효하지 않으면 → 게스트 유저 (client.data.guestId/guestName 설정)
 * - 항상 true 반환 (접속 거부 없음)
 */
@Injectable()
export class FishingWsGuard implements CanActivate {
  private readonly logger = new Logger(FishingWsGuard.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<FishingSocket>();

    // 이미 인증 처리된 소켓이면 스킵
    if (client.data.isAuthenticated !== undefined) {
      return true;
    }

    const token = this.extractToken(client);

    if (token) {
      try {
        const payload = this.verifyToken(token);
        const user = await this.userRepository.findOne({
          where: { userId: payload.sub, isActivated: 1 },
        });

        if (user) {
          client.data.user = user;
          client.data.isAuthenticated = true;
          return true;
        }
      } catch {
        // 토큰 검증 실패 → 게스트로 처리
      }
    }

    // 게스트 처리: 소켓 ID 기반 임시 ID + 랜덤 이름 생성
    const guestId = this.generateGuestId(client.id);
    const guestName = this.generateGuestName();

    client.data.guestId = guestId;
    client.data.guestName = guestName;
    client.data.isAuthenticated = false;

    this.logger.debug(`게스트 접속: guestId=${guestId}, name=${guestName}, socketId=${client.id}`);

    return true;
  }

  private extractToken(client: Socket): string | null {
    const authToken = client.handshake.auth?.token;
    if (authToken && typeof authToken === 'string') {
      return authToken;
    }

    const authHeader = client.handshake.headers?.authorization;
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }

  private verifyToken(token: string): AccessTokenPayload {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET이 설정되지 않았습니다.');
    }

    const payload = verify(token, secret) as AccessTokenPayload;
    if (!payload?.sub) {
      throw new Error('유효하지 않은 토큰입니다.');
    }
    return payload;
  }

  /**
   * 소켓 ID로 게스트 ID 생성 (음수로 일반 userId와 충돌 방지)
   */
  private generateGuestId(socketId: string): number {
    let hash = 0;
    for (let i = 0; i < socketId.length; i++) {
      hash = (hash << 5) - hash + socketId.charCodeAt(i);
      hash |= 0;
    }
    return -Math.abs(hash);
  }

  /**
   * 랜덤 게스트 이름 생성
   */
  private generateGuestName(): string {
    const adjectives = ['용감한', '재빠른', '졸린', '배고픈', '행복한', '호기심많은', '느긋한', '신비한'];
    const animals = ['고양이', '강아지', '토끼', '여우', '곰', '판다', '햄스터', '수달'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    const num = Math.floor(Math.random() * 100);
    return `${adj}${animal}${num}`;
  }
}
