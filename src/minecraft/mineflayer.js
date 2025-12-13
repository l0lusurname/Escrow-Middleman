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

    // Only use one event handler to avoid duplicate processing
    this.bot.on("message", (jsonMsg, position) => {
      if (position !== "system") return; // Only process system messages (payment notifications)
      const message = jsonMsg.toString();
      console.log(`[MC Chat] ${message}`);
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
    console.log(`[MC Chat] ${message}`);

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