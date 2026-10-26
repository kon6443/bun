import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from '../../entities/User';
import { UserSkinEquip } from '../../entities/UserSkinEquip';
import { UserSkinService } from './user-skin.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserSkinEquip]), ConfigModule],
  controllers: [UsersController],
  providers: [UsersService, UserSkinService],
  exports: [UsersService, UserSkinService],
})
export class UsersModule {}
