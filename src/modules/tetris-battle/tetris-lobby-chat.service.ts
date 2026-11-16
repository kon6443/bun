import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { GameLobbyChat } from '../game-room/game-lobby-chat';
import { TetrisBattleError } from './tetris-battle.errors';
import { LOBBY_CHAT_HISTORY_LIMIT, LOBBY_CHAT_HISTORY_TTL_SEC } from './tetris-battle.constants';
import type { LobbyChatMessage } from './tetris-battle.events';
import { TetrisBattleRoomService } from './tetris-battle-room.service';

export type { LobbyChatSender } from '../game-room/game-lobby-chat';

/** 최근 대화 — Redis List(최신이 앞), 최대 LOBBY_CHAT_HISTORY_LIMIT개, 마지막 메시지 뒤 LOBBY_CHAT_HISTORY_TTL_SEC 동안만 */
const HISTORY_KEY = 'tetris-battle:lobby-chat:recent';

/**
 * 테트리스 로비 전체 채팅 (docs/tasks/tetris-chat D-001) — 규칙은 게임 공용 GameLobbyChat(포트리스와 같다). DB에 남기지 않는다.
 * 최근 대화는 들어온 사람이 빈 방을 보지 않게 하는 용도라 최근 50개를 30분만 Redis에 둔다
 */
@Injectable()
export class TetrisLobbyChatService extends GameLobbyChat<LobbyChatMessage> {
  constructor(
    roomService: TetrisBattleRoomService,
    @InjectRepository(User) userRepository: Repository<User>,
    configService: ConfigService,
  ) {
    super(
      {
        historyKey: HISTORY_KEY,
        historyLimit: LOBBY_CHAT_HISTORY_LIMIT,
        historyTtlSec: LOBBY_CHAT_HISTORY_TTL_SEC,
        reject: code => new TetrisBattleError(code),
        consumeRateLimit: (action, subject) => roomService.consumeRateLimit(action, subject),
      },
      userRepository,
      configService.get<string>('GAME_IP_HASH_SECRET'),
    );
  }
}
