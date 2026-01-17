import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { MainResponseDto, HealthCheckResponseDto } from './dto/response/main-response.dto';

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
    return { message: 'SUCCESS' };
  }

  @Get('health-check')
  @ApiOperation({ summary: '헬스 체크' })
  @ApiResponse({ status: 200, description: '연결 정상', type: HealthCheckResponseDto })
  async healthCheck() {
    try {
      return { message: 'CONNECTION HEALTHY', database: 'connected' };
    } catch (error) {
      console.error('Database connection error:', error);
      return { message: 'CONNECTION HEALTHY', database: 'disconnected' };
    }
  }
}

