import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';

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
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    const payload = this.verifyToken(token);

    const user = await this.userRepository.findOne({
      where: { userId: payload.sub, isActivated: 1 },
    });

    if (!user) {
      throw new UnauthorizedException('UNAUTHORIZED');
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
      throw new UnauthorizedException('JWT_SECRET not configured');
    }

    try {
      const payload = verify(token, secret) as AccessTokenPayload;
      if (!payload?.sub) {
        throw new UnauthorizedException('UNAUTHORIZED');
      }
      return payload;
    } catch (error) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }
  }
}
