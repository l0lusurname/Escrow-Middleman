import mineflayer from "mineflayer";
import { EventEmitter } from "events";
import { parseAmount } from "../utils/currencyParser.js";

const MINECRAFT_HOST = process.env.MINECRAFT_HOST || "donutsmp.net";
const MINECRAFT_PORT = parseInt(process.env.MINECRAFT_PORT) || 25565;
const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION || false;
const MINECRAFT_USERNAME = process.env.MINECRAFT_USERNAME || "Bunji_MC";
const MINECRAFT_AUTH = process.env.MINECRAFT_AUTH || "microsoft";

class MinecraftBot extends EventEmitter {
  constructor() {
    super();
    this.bot = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.teamHomeInterval = null;
    this.keepAliveInterval = null;
  }

  clearIntervals() {
    if (this.teamHomeInterval) {
      clearInterval(this.teamHomeInterval);
      this.teamHomeInterval = null;
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  connect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.clearIntervals();

    console.log(`Connecting to Minecraft server ${MINECRAFT_HOST}:${MINECRAFT_PORT} as ${MINECRAFT_USERNAME}...`);

    try {
      const botOptions = {
        host: MINECRAFT_HOST,
        port: MINECRAFT_PORT,
        username: MINECRAFT_USERNAME,
        auth: MINECRAFT_AUTH,
        version: MINECRAFT_VERSION,
        connectTimeout: 60000,
        checkTimeoutInterval: 30000,
        hideErrors: false,
        keepAlive: true,
        validateChannelProtocol: false,
      };

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
      console.error("Failed to create Minecraft bot:", error.message);
      this.scheduleReconnect();
    }
  }

  setupEventListeners() {
    this.bot.on("login", () => {
      console.log(`Minecraft bot logged in as ${this.bot.username}`);
      console.log(`Protocol version: ${this.bot.version}`);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.emit("connected");
    });

    this.bot.on("spawn", () => {
      console.log("Minecraft bot spawned in world");
      this.emit("spawned");

      setTimeout(() => {
        if (this.bot && this.bot.entity) {
          console.log("Executing /team home...");
          this.bot.chat("/team home");
        }
      }, 2000);

      this.teamHomeInterval = setInterval(() => {
        if (this.bot && this.bot.entity) {
          console.log("Executing /team home (scheduled)...");
          this.bot.chat("/team home");
        }
      }, 1000 * 60 * 10);

      this.keepAliveInterval = setInterval(() => {
        if (this.bot && this.bot.entity && this.bot.entity.position) {
          const pos = this.bot.entity.position;
          console.log(`Still connected at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`);
        }
      }, 1000 * 60 * 5);
    });

    this.bot.on("message", (jsonMsg, position) => {
      if (position !== "system") return;
      const message = jsonMsg.toString();
      console.log(`[MC Chat] ${message}`);
      this.handleChatMessage(message);
    });

    this.bot.on("kicked", (reason) => {
      console.warn("Minecraft bot was kicked:", reason);
      this.connected = false;
      this.clearIntervals();
      this.emit("kicked", reason);
      this.scheduleReconnect();
    });

    this.bot.on("end", (reason) => {
      console.log("Minecraft bot disconnected:", reason);
      this.connected = false;
      this.clearIntervals();
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.bot.on("error", (err) => {
      console.error("Minecraft bot error:", err.message);
      this.emit("error", err);

      if (err.message.includes("PartialReadError")) {
        console.log("Hint: Try setting MINECRAFT_VERSION env variable (e.g., '1.20.1')");
      }

      if (err.message.includes("ECONNREFUSED") || err.message.includes("ETIMEDOUT")) {
        console.log("Connection issue detected, will retry...");
      }
    });

    if (this.bot._client) {
      this.bot._client.on("error", (err) => {
        console.error("Client error:", err.message);
      });
    }
  }

  extractText(component) {
    if (typeof component === 'string') return component;
    let text = component.text || '';
    if (component.extra) {
      for (const extra of component.extra) {
        text += this.extractText(extra);
      }
    }
    if (component.with) {
      for (const w of component.with) {
        text += this.extractText(w);
      }
    }
    return text;
  }

  normalizeMessage(message) {
    let clean = message
      .replace(/§x(§[0-9a-fA-F]){6}/g, '')
      .replace(/§[0-9a-fklmnorx]/gi, '')
      .replace(/&x(&[0-9a-fA-F]){6}/g, '')
      .replace(/&[0-9a-fklmnorx]/gi, '')
      .replace(/\[[^\]]*\]\s*/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return clean;
  }

  handleChatMessage(message) {
    const cleanMessage = this.normalizeMessage(message);
    console.log(`[MC Chat Clean] ${cleanMessage}`);

    const paymentPatterns = [
      { regex: /(\w{3,16})\s+(?:has\s+)?paid\s+you\s+\$?([\d,\.]+[kKmMbB]?)[.!]?$/i, payerIdx: 1, amountIdx: 2 },
      { regex: /(\w{3,16})\s+(?:has\s+)?sent\s+you\s+\$?([\d,\.]+[kKmMbB]?)[.!]?$/i, payerIdx: 1, amountIdx: 2 },
      { regex: /(\w{3,16})\s+just\s+paid\s+you\s+\$?([\d,\.]+[kKmMbB]?)[.!]?$/i, payerIdx: 1, amountIdx: 2 },
      { regex: /You\s+(?:have\s+)?received\s+\$?([\d,\.]+[kKmMbB]?)\s+from\s+(\w{3,16})[.!]?$/i, payerIdx: 2, amountIdx: 1 },
      { regex: /(\w{3,16})\s+transferred\s+\$?([\d,\.]+[kKmMbB]?)\s+to\s+you[.!]?$/i, payerIdx: 1, amountIdx: 2 },
    ];

    for (const { regex, payerIdx, amountIdx } of paymentPatterns) {
      const match = cleanMessage.match(regex);
      if (match) {
        const payerMc = match[payerIdx];
        const amountStr = match[amountIdx];
        const amount = parseAmount(amountStr);

        if (amount !== null && payerMc.toLowerCase() !== MINECRAFT_USERNAME.toLowerCase()) {
          console.log(`Payment detected: ${payerMc} paid ${amount} to ${MINECRAFT_USERNAME}`);

          this.emit("payment", {
            payerMc: payerMc,
            recipientMc: MINECRAFT_USERNAME,
            amount: amount,
            rawLine: message,
            timestamp: new Date(),
          });
          return;
        }
      }
    }
  }

  scheduleReconnect() {
    this.reconnectAttempts++;
    
    const delay = Math.min(10000 * this.reconnectAttempts, 60000);
    
    console.log(`Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect() {
    console.log("Shutting down Minecraft bot gracefully...");
    this.clearIntervals();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
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

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down...');
  minecraftBot.disconnect();
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down...');
  minecraftBot.disconnect();
  setTimeout(() => process.exit(0), 1000);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  console.log('Attempting to recover...');
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message || err);
  console.log('Attempting to recover...');
});

export const minecraftBot = new MinecraftBot();
