import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { AccessTokenPayload, extractHttpAccessToken, verifyAccessToken } from '../utils/access-token.utils';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import {
  AuthUnauthorizedErrorResponseDto,
  AuthInvalidTokenErrorResponseDto,
} from '../../modules/auth/auth-error.dto';

type RequestWithUser = Request & { user?: User };

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
   * Cookie(`access_token`) 우선 → Authorization Bearer 헤더 보조 (규칙은 `extractHttpAccessToken` 한 곳)
   */
  protected extractToken(request: Request): string | null {
    return extractHttpAccessToken(request);
  }

  protected verifyToken(token: string): AccessTokenPayload {
    const result = verifyAccessToken(token, this.configService.get<string>('JWT_SECRET'));
    if (result.ok) return result.payload;
    switch (result.reason) {
      case 'NO_SECRET':
        throw new AuthInvalidTokenErrorResponseDto('JWT_SECRET이 설정되지 않았습니다.');
      case 'NO_SUBJECT':
        throw new AuthInvalidTokenErrorResponseDto('유효하지 않은 토큰입니다.');
      case 'INVALID':
        throw new AuthInvalidTokenErrorResponseDto('토큰 검증에 실패했습니다.');
    }
  }
}
