import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { FortressMatch } from '../../entities/FortressMatch';
import { FortressPlayer } from '../../entities/FortressPlayer';
import { FortressReplay } from '../../entities/FortressReplay';
import { User } from '../../entities/User';
import { UserPointLedger } from '../../entities/UserPointLedger';
import { UserSkinEquip } from '../../entities/UserSkinEquip';
import { UserSkinLevel } from '../../entities/UserSkinLevel';
import { createMockRepository } from '../../common/__spec__/mock-repository';
import { FortressModule } from './fortress.module';
import { FortressGateway } from './fortress.gateway';
import { FortressLobbyChatService } from './fortress-lobby-chat.service';
import { FortressMatchService } from './fortress-match.service';
import { FortressResultController } from './fortress-result.controller';
import { FortressResultService } from './fortress-result.service';
import { FortressRoomService } from './fortress-room.service';
import { FortressSkinController } from './fortress-skin.controller';
import { FortressSkinService } from './fortress-skin.service';
import { FortressPointsService } from './fortress-points.service';

/**
 * FortressModule의 DI 배선 — 실제 모듈을 그대로 조립한다(Repository·DataSource만 mock, DB 연결 없음, lessons 2026-10-21).
 * 게이트웨이·가드·서비스·결과 컨트롤러가 모듈 안에서 해석되는지, 방 서비스(종료 훅)·결과 서비스(저장 훅)가 경기 서비스의 같은 인스턴스에 훅을 거는지 본다.
 * forFeature에서 User·Fortress* Entity를 빼면 의존 해석 실패로 깨진다.
 */
/** 앱에서는 TypeOrmModule.forRoot가 주는 DataSource(전역) — 여기서는 연결 없는 대역 */
@Global()
@Module({ providers: [{ provide: getDataSourceToken(), useValue: { transaction: jest.fn() } }], exports: [getDataSourceToken()] })
class FakeDataSourceModule {}

describe('FortressModule', () => {
  it('게이트웨이·방·경기 서비스를 모두 해석하고, 방 서비스가 같은 경기 서비스를 쓴다', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), FakeDataSourceModule, FortressModule],
    })
      .overrideProvider(getRepositoryToken(User))
      .useValue(createMockRepository<User>())
      .overrideProvider(getRepositoryToken(FortressMatch))
      .useValue(createMockRepository<FortressMatch>())
      .overrideProvider(getRepositoryToken(FortressPlayer))
      .useValue(createMockRepository<FortressPlayer>())
      .overrideProvider(getRepositoryToken(FortressReplay))
      .useValue(createMockRepository<FortressReplay>())
      // F7: 공용 포인트 원장·스킨 장착/레벨(UsersModule)
      .overrideProvider(getRepositoryToken(UserPointLedger))
      .useValue(createMockRepository<UserPointLedger>())
      .overrideProvider(getRepositoryToken(UserSkinEquip))
      .useValue(createMockRepository<UserSkinEquip>())
      .overrideProvider(getRepositoryToken(UserSkinLevel))
      .useValue(createMockRepository<UserSkinLevel>())
      .compile();

    expect(moduleRef.get(FortressGateway)).toBeInstanceOf(FortressGateway);
    // 로비 채팅(D-016) — User Repository·ConfigService 의존까지 해석
    expect(moduleRef.get(FortressLobbyChatService)).toBeInstanceOf(FortressLobbyChatService);
    const matches = moduleRef.get(FortressMatchService);
    const rooms = moduleRef.get(FortressRoomService);
    expect(rooms).toBeInstanceOf(FortressRoomService);
    const finish = jest.spyOn(rooms, 'finishMatch').mockResolvedValue(undefined);
    await (matches as unknown as { endedHook: (code: string, matchId: string) => Promise<void> }).endedHook('ABCDEF', 'm');
    expect(finish).toHaveBeenCalledWith('ABCDEF', 'm');

    // F6: 결과 컨트롤러·서비스 해석, 결과 서비스가 같은 경기 서비스에 저장 훅을 건다
    expect(moduleRef.get(FortressResultController)).toBeInstanceOf(FortressResultController);
    const results = moduleRef.get(FortressResultService);
    const save = jest.spyOn(results, 'saveIfEnded').mockResolvedValue('saved');
    await (matches as unknown as { saveHook: (matchId: string) => Promise<void> }).saveHook('m');
    expect(save).toHaveBeenCalledWith('m');

    // F7: 탱크 스킨 컨트롤러·서비스(UsersModule의 UserSkinService) · 포인트 서비스 해석
    expect(moduleRef.get(FortressSkinController)).toBeInstanceOf(FortressSkinController);
    expect(moduleRef.get(FortressSkinService)).toBeInstanceOf(FortressSkinService);
    expect(moduleRef.get(FortressPointsService)).toBeInstanceOf(FortressPointsService);
    await moduleRef.close();
  });
});
