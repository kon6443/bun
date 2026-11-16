import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { GameLobbyChat } from '../game-room/game-lobby-chat';
import { FortressError } from './fortress.errors';
import {
  LOBBY_CHAT_HISTORY_KEY,
  LOBBY_CHAT_HISTORY_LIMIT,
  LOBBY_CHAT_HISTORY_TTL_SEC,
} from './fortress.constants';
import type { LobbyChatMessage } from './fortress.events';
import { FortressRoomService } from './fortress-room.service';

export type { LobbyChatSender } from '../game-room/game-lobby-chat';

/**
 * 포트리스 로비 전체 채팅 (docs/tasks/fortress D-016) — 규칙은 게임 공용 GameLobbyChat(테트리스 대전과 같다).
 * 포트리스 차이: 최근 대화 키(테트리스와 따로)·에러 클래스·빈도 제한 리미터(포트리스 방 서비스)
 */
@Injectable()
export class FortressLobbyChatService extends GameLobbyChat<LobbyChatMessage> {
  constructor(
    roomService: FortressRoomService,
    @InjectRepository(User) userRepository: Repository<User>,
    configService: ConfigService,
  ) {
    super(
      {
        historyKey: LOBBY_CHAT_HISTORY_KEY,
        historyLimit: LOBBY_CHAT_HISTORY_LIMIT,
        historyTtlSec: LOBBY_CHAT_HISTORY_TTL_SEC,
        reject: code => new FortressError(code),
        consumeRateLimit: (action, subject) => roomService.consumeRateLimit(action, subject),
      },
      userRepository,
      configService.get<string>('GAME_IP_HASH_SECRET'),
    );
  }
}
