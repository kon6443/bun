import { Client, GatewayIntentBits } from "discord.js";
import { userInfo } from "os";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`Discord Bot Logged in as ${client.user?.tag}...`);
});

export const loginToDiscord = async () => {
  try {
    await client.login(DISCORD_BOT_TOKEN);
  } catch (err) {
    console.error("Failed to log in to Discord", err);
    process.exit(1);
  }
};

class DiscordService {
  private baseUrl = "https://discord.com/api";
  constructor() {}

  async sendMessage({
    discordId,
    message,
  }: {
    discordId: string;
    message: string;
  }) {
    if (!discordId || !message) {
      console.warn("[DISCORD] sendMessage(): !discordId || !message");
      return;
    }
    console.log("service discordId:", discordId);
    console.log("service message:", message);
    console.log("baseUrl:", this.baseUrl);
    console.log("DISCORD_BOT_TOKEN:", DISCORD_BOT_TOKEN);
  }
}

const discordServiceInstance = new DiscordService();
export default discordServiceInstance;
