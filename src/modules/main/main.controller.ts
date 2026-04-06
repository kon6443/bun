import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { MainResponseDto } from './main.dto';

@ApiTags('main')
@SkipThrottle()
@Controller()
export class MainController {
  @Get()
  @ApiOperation({ summary: '기본 엔드포인트' })
  @ApiResponse({ status: 200, description: '성공', type: MainResponseDto })
  getHello() {
    return { code: 'SUCCESS', data: null, message: '' };
  }
}

