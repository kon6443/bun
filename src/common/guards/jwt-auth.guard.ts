import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import {
  AuthUnauthorizedErrorResponseDto,
  AuthInvalidTokenErrorResponseDto,
} from '../../modules/auth/auth-error.dto';

type RequestWithUser = Request & { user?: User };

type AccessTokenPayload = JwtPayload & {
  sub: number;
  loginType?: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractToken(request);
    if (!token) {
      throw new AuthUnauthorizedErrorResponseDto('인증 토큰이 필요합니다.');
    }

    const payload = this.verifyToken(token);

    const user = await this.userRepository.findOne({
      where: { userId: payload.sub, isActivated: 1 },
    });

    if (!user) {
      throw new AuthUnauthorizedErrorResponseDto('사용자를 찾을 수 없습니다.');
    }

    request.user = user;
    return true;
  }

  /**
   * Cookie(`access_token`) 우선 → Authorization Bearer 헤더 보조
   */
  protected extractToken(request: Request): string | null {
    const cookieToken = (request as any)?.cookies?.access_token;
    if (cookieToken && typeof cookieToken === 'string') {
      return cookieToken;
    }

    const authHeader = request.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }

  protected verifyToken(token: string): AccessTokenPayload {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new AuthInvalidTokenErrorResponseDto('JWT_SECRET이 설정되지 않았습니다.');
    }

    try {
      const payload = verify(token, secret) as AccessTokenPayload;
      if (!payload?.sub) {
        throw new AuthInvalidTokenErrorResponseDto('유효하지 않은 토큰입니다.');
      }
      return payload;
    } catch (error) {
      if (error instanceof AuthInvalidTokenErrorResponseDto) {
        throw error;
      }
      throw new AuthInvalidTokenErrorResponseDto('토큰 검증에 실패했습니다.');
    }
  }
}
