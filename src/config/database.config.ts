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
      poolPingInterval: 60,    // 60초 이상 유휴 연결 사용 전 ping 검사
      poolTimeout: 300,        // 5분간 사용 안된 연결 풀에서 제거
      expireTime: 5,           // 5분마다 연결 상태 체크
    },
    namingStrategy: undefined,
  };
  return config;
});
