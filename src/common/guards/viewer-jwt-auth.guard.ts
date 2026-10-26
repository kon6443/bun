import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthInvalidTokenErrorResponseDto, AuthUnauthorizedErrorResponseDto } from '../../modules/auth/auth-error.dto';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

/**
 * 공개 조회용 선택 인증 — 유효한 토큰이면 사용자를 붙이고, 없거나 만료·무효면 비로그인으로 통과한다.
 *
 * `OptionalJwtAuthGuard`는 토큰이 있는데 무효면 401이다(쓰기 경로에서 "로그인 사용자 기록"을 잘못 익명으로 남기지 않기 위해).
 * 랭킹처럼 누구나 보는 조회에 그 규칙을 쓰면 만료된 쿠키를 가진 사용자가 목록 자체를 못 본다 —
 * 조회는 "내 기록 표시" 같은 부가 정보만 사용자에 따라 달라지므로 인증 실패를 비로그인으로 낮춘다.
 * 인증 외 오류(DB 등)는 그대로 던진다.
 */
@Injectable()
export class ViewerJwtAuthGuard extends OptionalJwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (error) {
      if (error instanceof AuthUnauthorizedErrorResponseDto || error instanceof AuthInvalidTokenErrorResponseDto) {
        return true;
      }
      throw error;
    }
  }
}
