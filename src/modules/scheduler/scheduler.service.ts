import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, In, Repository } from 'typeorm';
import { User } from '../../entities/User';
import { TeamTask } from '../../entities/TeamTask';
import { ConfigService } from '@nestjs/config';
import { TaskStatus, ActStatus } from '../../common/enums/task-status.enum';

/** 자동 아카이브 대기 일수 */
const AUTO_ARCHIVE_DAYS = 14;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly env: string;
  private readonly TASK_SLOT: number;
  private readonly schedulerEnvs: string[] = ['QA', 'PROD'];

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(TeamTask)
    private readonly teamTaskRepository: Repository<TeamTask>,
  ) {
    // 환경 변수 확인용 (테스트용)
    // this.env = 'QA';
    this.env = this.configService.get<string>('ENV')?.toUpperCase() ?? '';
    this.TASK_SLOT = Number(this.configService.get<number>('TASK_SLOT')) || 1;
  }

  /**
   * 스케줄러 실행 여부 확인
   * @returns 스케줄러 실행 여부
   */
  private shouldSkipScheduler(): boolean {
    return !this.schedulerEnvs.includes(this.env) || this.TASK_SLOT !== 1;
  }

  @Cron('0/30 * * * * *', {
    name: 'doTrash',
  })
  async handleDoTrash() {
    if (this.shouldSkipScheduler()) return;

    try {
      const _count = await this.userRepository.count();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      this.logger.error(`[doTrash] 스케줄러 오류`, err?.stack ?? err);
    }
  }

  @Cron('0/30 * * * * *', {
    name: 'runCpuIntensiveLoop',
  })
  async handleCpuIntensiveLoop() {
    if (this.shouldSkipScheduler()) return;

    try {
      const iterations = 5_000_000;
      let _accumulator = 0;

      for (let i = 0; i < iterations; i++) {
        const value = Math.sqrt((i % 1_000) + 1) * Math.sin(i);
        _accumulator += value;
      }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      this.logger.error(`[runCpuIntensiveLoop] 스케줄러 오류`, err?.stack ?? err);
    }
  }

  /**
   * 자동 아카이브 스케줄러
   * 매일 UTC 17:00 (KST 02:00) 실행
   * completedAt이 14일 이상 경과한 COMPLETED/CANCELLED 태스크를 INACTIVE로 변경
   */
  @Cron('0 0 17 * * *', {
    name: 'autoArchiveTasks',
  })
  async handleAutoArchiveTasks() {
    if (this.shouldSkipScheduler()) return;

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - AUTO_ARCHIVE_DAYS);

      const result = await this.teamTaskRepository.update(
        {
          actStatus: ActStatus.ACTIVE,
          taskStatus: In([TaskStatus.COMPLETED, TaskStatus.CANCELLED]),
          completedAt: LessThan(cutoffDate),
        },
        { actStatus: ActStatus.INACTIVE },
      );

      if (result.affected && result.affected > 0) {
        this.logger.log(`[autoArchiveTasks] ${result.affected}건 자동 아카이브 완료`);
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      this.logger.error(`[autoArchiveTasks] 스케줄러 오류`, err?.stack ?? err);
    }
  }
}




