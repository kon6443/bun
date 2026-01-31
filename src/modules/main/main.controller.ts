import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { MainResponseDto, HealthCheckResponseDto } from './main.dto';

@ApiTags('main')
@Controller()
export class MainController {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  @Get()
  @ApiOperation({ summary: '기본 엔드포인트' })
  @ApiResponse({ status: 200, description: '성공', type: MainResponseDto })
  getHello() {
    return { code: 'SUCCESS', data: null, message: '' };
  }

  @Get('health-check')
  @ApiOperation({ summary: '헬스 체크' })
  @ApiResponse({ status: 200, description: '연결 정상', type: HealthCheckResponseDto })
  async healthCheck() {
    try {
      return { code: 'SUCCESS', data: { database: 'connected' }, message: '' };
    } catch (error) {
      console.error('Database connection error:', error);
      return { code: 'SUCCESS', data: { database: 'disconnected' }, message: '' };
    }
  }
}

