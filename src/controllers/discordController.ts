import utilServiceInstance from "../services/utils";
import discordServiceInstance from "../services/discordService";

class DiscordController {
  constructor() {}

  async postDiscordMessageCont({
    discordId,
    message,
  }: {
    discordId: string;
    message: string;
  }) {
    try {
      await discordServiceInstance.sendMessage({ discordId, message });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'message' in err && 'status' in err) {
        utilServiceInstance.handleError(err as { message: string; status: number; hideServerLog?: number });
      } else {
        utilServiceInstance.handleError({
          message: err instanceof Error ? err.message : 'Unknown error',
          status: 500,
        });
      }
    }
  }
}

const discordControllerInstance = new DiscordController();
export default discordControllerInstance;
