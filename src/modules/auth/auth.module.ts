import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, OptionalJwtAuthGuard],
  // AuthModule을 import하는 다른 모듈(예: TeamModule)에서도
  // JwtAuthGuard의 의존성(@InjectRepository(User))을 해결할 수 있도록
  // TypeOrmModule을 re-export 합니다.
  exports: [TypeOrmModule, AuthService, JwtAuthGuard, OptionalJwtAuthGuard],
})
export class AuthModule {}
