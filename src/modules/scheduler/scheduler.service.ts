import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SchedulerService {
  private readonly env: string;
  private readonly TASK_SLOT: number;
  private readonly schedulerEnvs: string[] = ['QA', 'PROD'];

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
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
      const count = await this.userRepository.count();
    } catch (err: any) {
      console.error(
        `SCHEDULER ERROR::[doTrash] - [${new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })}]\n`,
        err,
      );
    }
  }

  @Cron('0/30 * * * * *', {
    name: 'runCpuIntensiveLoop',
  })
  async handleCpuIntensiveLoop() {
    if (this.shouldSkipScheduler()) return;

    try {
      const iterations = 5_000_000;
      let accumulator = 0;

      for (let i = 0; i < iterations; i++) {
        const value = Math.sqrt((i % 1_000) + 1) * Math.sin(i);
        accumulator += value;
      }

    } catch (err: any) {
      console.error(
        `SCHEDULER ERROR::[runCpuIntensiveLoop] - [${new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })}]\n`,
        err,
      );
    }
  }
}




