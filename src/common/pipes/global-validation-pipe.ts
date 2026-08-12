import { ValidationPipe } from '@nestjs/common';
import { ApiValidationErrorResponseDto } from '../dto/api-error.dto';

/**
 * 앱 전역 ValidationPipe 설정.
 *
 * `AppModule`의 `APP_PIPE`와 E2E 테스트가 **같은 인스턴스 설정을 공유**하기 위해 분리했다.
 * 설정이 어긋나면 E2E가 프로덕션과 다른 규칙으로 검증하게 되어, 통과해도 통과가 아니고
 * 실패해도 실패가 아니게 된다 (특히 `forbidNonWhitelisted`·`enableImplicitConversion`).
 *
 * 검증 실패는 도메인 에러 DTO로 변환해 `HttpExceptionFilter`가 다른 에러와 같은
 * `{ code, message, timestamp }` 포맷으로 응답하게 한다.
 */
export const createGlobalValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
    exceptionFactory: (errors) => {
      const messages = errors
        .map((e) => Object.values(e.constraints || {}).join(', '))
        .join('; ');
      return new ApiValidationErrorResponseDto(messages || '요청 값이 올바르지 않습니다.');
    },
  });
