import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from '../../entities/User';
import { UserSkinEquip } from '../../entities/UserSkinEquip';
import { UserSkinLevel } from '../../entities/UserSkinLevel';
import { UserPointLedger } from '../../entities/UserPointLedger';
import { UserSkinService } from './user-skin.service';
import { UserPointService } from './user-point.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserSkinEquip, UserSkinLevel, UserPointLedger]), ConfigModule],
  controllers: [UsersController],
  providers: [UsersService, UserSkinService, UserPointService],
  exports: [UsersService, UserSkinService, UserPointService],
})
export class UsersModule {}
