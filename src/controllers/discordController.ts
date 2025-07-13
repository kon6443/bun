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
    } catch (err) {
      utilServiceInstance.handleError(err);
    }
  }
}

const discordControllerInstance = new DiscordController();
export default discordControllerInstance;
