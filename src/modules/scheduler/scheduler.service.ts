import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';

@Injectable()
export class SchedulerService {
  private readonly env = process.env.ENV?.toUpperCase() ?? '';
  private readonly taskNumber = Number(process.env.TASK_SLOT) || 1;
  private readonly taskSlots = ['QA', 'PROD'];

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    // 환경 변수 확인용 (테스트용)
    // this.env = 'QA';
    // this.taskNumber = 1;
  }

  @Cron('0/30 * * * * *', {
    name: 'doTrash',
  })
  async handleDoTrash() {
    if (!this.taskSlots.includes(this.env) || this.taskNumber !== 1) {
      return;
    }

    try {
      console.log(
        `SCHEDULER START::[doTrash] - [${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}]`,
      );
      const count = await this.userRepository.count();
      console.log('total:', count);
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
    if (!this.taskSlots.includes(this.env) || this.taskNumber !== 1) {
      return;
    }

    try {
      console.log(
        `SCHEDULER START::[runCpuIntensiveLoop] - [${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}]`,
      );
      const iterations = 5_000_000;
      let accumulator = 0;

      for (let i = 0; i < iterations; i++) {
        const value = Math.sqrt((i % 1_000) + 1) * Math.sin(i);
        accumulator += value;
      }

      console.log(
        `[schedulerService][runCpuIntensiveLoop] iterations=${iterations}, result=${accumulator.toFixed(2)}`,
      );
    } catch (err: any) {
      console.error(
        `SCHEDULER ERROR::[runCpuIntensiveLoop] - [${new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })}]\n`,
        err,
      );
    }
  }
}

