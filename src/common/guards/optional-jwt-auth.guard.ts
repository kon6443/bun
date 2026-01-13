import { ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { User } from '../../entities/User';
import { JwtAuthGuard } from './jwt-auth.guard';

type RequestWithUser = Request & { user?: User };

@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractToken(request);

    // 토큰이 아예 없으면 익명으로 통과
    if (!token) {
      return true;
    }

    // 토큰이 있으면 부모 가드 로직으로 검증 및 user 주입
    return super.canActivate(context);
  }
}
