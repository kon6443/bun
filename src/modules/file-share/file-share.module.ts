import { Module } from '@nestjs/common';
import { FileShareController } from './file-share.controller';
import { FileShareService } from './file-share.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileShare } from '../../entities/FileShare';

@Module({
  imports: [TypeOrmModule.forFeature([FileShare])],
  controllers: [FileShareController],
  providers: [FileShareService],
})
export class FileShareModule {}




