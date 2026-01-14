import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { User } from '../entities/User';
import { Team } from '../entities/Team';
import { TeamMember } from '../entities/TeamMember';
import { FileShare } from '../entities/FileShare';
import { TeamTask } from '../entities/TeamTask';
import { TaskComment } from '../entities/TaskComment';
import { TeamInvitation } from '../entities/TeamInvitation';
export default registerAs('database', (): TypeOrmModuleOptions => {
  const config: TypeOrmModuleOptions = {
    type: 'oracle',
    username: process.env.ORACLE_DB_USER,
    password: process.env.ORACLE_DB_PW,
    connectString: process.env.ORACLE_DB_CONNECT_STR,
    synchronize: false,
    logging: process.env.NODE_ENV === 'development',
    entities: [User, Team, TeamMember, FileShare, TeamTask, TaskComment, TeamInvitation],
    extra: {
      poolMin: 1,
      poolMax: 3,
      poolIncrement: 1,
    },
    namingStrategy: undefined,
  };
  return config;
});
