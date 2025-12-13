import { Module } from '@nestjs/common';
import { MainController } from './main.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [MainController],
})
export class MainModule {}

