import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { Feedback } from '../../entities/Feedback';
import { User } from '../../entities/User';

// NOTIFICATION_PORT는 @Global NotificationModule이 제공한다
@Module({
  // User: 라우트의 JwtAuthGuard가 사용자 조회에 쓴다 (users·auth 모듈과 같은 방식)
  imports: [TypeOrmModule.forFeature([Feedback, User])],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
