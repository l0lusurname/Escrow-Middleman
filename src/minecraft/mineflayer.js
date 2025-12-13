import mineflayer from "mineflayer";
import { EventEmitter } from "events";
import { parseAmount } from "../utils/currencyParser.js";

const MINECRAFT_HOST = process.env.MINECRAFT_HOST || "donutsmp.net";
const MINECRAFT_PORT = parseInt(process.env.MINECRAFT_PORT) || 25565;
const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION || "1.21.1";
const MINECRAFT_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";
const MINECRAFT_AUTH = process.env.MINECRAFT_AUTH || "microsoft";

class MinecraftBot extends EventEmitter {
  constructor() {
    super();
    this.bot = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
  }

  connect() {
    console.log(`Connecting to Minecraft server ${MINECRAFT_HOST}:${MINECRAFT_PORT} as ${MINECRAFT_USERNAME}...`);

    try {
      const botOptions = {
        host: MINECRAFT_HOST,
        port: MINECRAFT_PORT,
        username: MINECRAFT_USERNAME,
        version: MINECRAFT_VERSION,
        auth: MINECRAFT_AUTH,
        hideErrors: false,
      };

      // Add auth callback for Microsoft authentication
      if (MINECRAFT_AUTH === "microsoft") {
        botOptions.onMsaCode = (data) => {
          console.log("\n========== MICROSOFT AUTHENTICATION ==========");
          console.log(`Open this URL in your browser: ${data.verification_uri}`);
          console.log(`Enter this code: ${data.user_code}`);
          console.log(`Code expires in: ${Math.floor(data.expires_in / 60)} minutes`);
          console.log("==============================================\n");

          this.emit("authCode", {
            url: data.verification_uri,
            code: data.user_code,
            expiresIn: data.expires_in
          });
        };
      }

      this.bot = mineflayer.createBot(botOptions);
      this.setupEventListeners();
    } catch (error) {
      console.error("Failed to create Minecraft bot:", error);
      this.scheduleReconnect();
    }
  }

  setupEventListeners() {
    this.bot.on("login", () => {
      console.log(`Minecraft bot logged in as ${this.bot.username}`);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.emit("connected");
    });

    this.bot.on("spawn", () => {
      console.log("Minecraft bot spawned in world");
      this.emit("spawned");
    });

    this.bot.on("message", (jsonMsg) => {
      const message = jsonMsg.toString();
      this.handleChatMessage(message);
    });

    this.bot.on("kicked", (reason) => {
      console.error("Minecraft bot was kicked:", reason);
      this.connected = false;
      this.emit("kicked", reason);
      this.scheduleReconnect();
    });

    this.bot.on("end", () => {
      console.log("Minecraft bot disconnected");
      this.connected = false;
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.bot.on("error", (err) => {
      console.error("Minecraft bot error:", err);
      this.emit("error", err);
    });
  }

  handleChatMessage(message) {
    console.log(`[MC Chat] ${message}`);

    const paymentPatterns = [
      /^(\w+) paid you \$?([\d,\.]+[kKmMbB]?)$/i,
      /^(\w+) has paid you \$?([\d,\.]+[kKmMbB]?)$/i,
      /^\[Economy\] (\w+) paid you \$?([\d,\.]+[kKmMbB]?)$/i,
      /^You received \$?([\d,\.]+[kKmMbB]?) from (\w+)$/i,
    ];

    for (const pattern of paymentPatterns) {
      const match = message.match(pattern);
      if (match) {
        let payerMc, amountStr;

        if (pattern.toString().includes("received")) {
          amountStr = match[1];
          payerMc = match[2];
        } else {
          payerMc = match[1];
          amountStr = match[2];
        }

        const amount = parseAmount(amountStr);

        if (amount !== null) {
          console.log(`Payment detected: ${payerMc} paid ${amount} to ${MINECRAFT_USERNAME}`);

          this.emit("payment", {
            payerMc: payerMc,
            recipientMc: MINECRAFT_USERNAME,
            amount: amount,
            rawLine: message,
            timestamp: new Date(),
          });
        }
        break;
      }
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnect attempts reached. Stopping Minecraft bot.");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    console.log(`Attempting to reconnect in ${delay / 1000} seconds (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect() {
    if (this.bot) {
      this.bot.quit();
      this.bot = null;
      this.connected = false;
    }
  }

  isConnected() {
    return this.connected;
  }

  getUsername() {
    return MINECRAFT_USERNAME;
  }

  sendChat(message) {
    if (this.bot && this.connected) {
      this.bot.chat(message);
    }
  }
}

export const minecraftBot = new MinecraftBot();