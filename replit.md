# Donut SMP Middleman Bot

Discord Middleman Bot for Donut SMP Minecraft server trades. Provides secure, user-friendly escrow trading with in-game payment verification via Mineflayer, 5% fee automation, and dispute resolution workflows.

## Overview

This bot manages escrow trades between Minecraft players with:
- **GUI-first design**: Public "Start Middleman" button creates private trade channels
- **Mineflayer integration**: Bot connects to Minecraft as Bunji_MC to detect payments
- **Payment-based verification**: Both parties pay small amounts to the bot to verify identity
- **Automatic escrow**: Buyer deposits sale amount, bot holds until delivery confirmed
- **5% fee**: Automatically calculated and deducted from seller payout
- **Scam protection**: Dispute system with fund freezing and support escalation

## Project Structure

```
src/
├── index.js              # Main entry point, Discord client + Express server
├── db/
│   ├── index.js          # Database connection (PostgreSQL)
│   └── schema.js         # Drizzle ORM schema definitions
├── commands/
│   ├── link.js           # /mm command definitions
│   └── handlers/
│       ├── createTrade.js    # Trade creation logic
│       ├── tradeStatus.js    # Trade status display
│       ├── markScammed.js    # Scam reporting
│       └── adminCommands.js  # Admin adjudication commands
├── events/
│   ├── buttonHandler.js  # Button interaction handlers
│   └── modalHandler.js   # Modal submission handlers
├── minecraft/
│   ├── mineflayer.js     # Mineflayer bot connection
│   └── paymentHandler.js # Payment detection and trade updates
├── ui/
│   ├── publicEmbed.js    # Public "Start Middleman" embed
│   └── tradeChannel.js   # Trade channel UI components
├── utils/
│   ├── currencyParser.js # Amount parsing (k/m/b suffix support)
│   ├── hmac.js           # HMAC signature verification
│   └── auditLog.js       # Audit logging utility
└── webhook/
    └── paymentWebhook.js # Minecraft server webhook endpoints
```

## Database Tables

- **linked_accounts**: Discord ↔ Minecraft username mappings
- **trades**: Trade records with verification amounts, status, escrow balance
- **verifications**: Payment verification records with raw evidence
- **tickets**: Trade ticket/channel tracking
- **audit_logs**: Complete action audit trail
- **bot_config**: Per-guild configuration (channels, roles, embed message IDs)

## GUI Flow

1. Admin sets up: `/mm set_mm_channel #channel` then `/mm post_embed`
2. User clicks "Start Middleman" button in public channel
3. Private trade channel created, user tags trade partner
4. User clicks "Setup Trade" and fills modal (role, amounts, usernames)
5. Both parties pay verification amounts to Bunji_MC in-game
6. Bot detects payments, updates embed status in real-time
7. Buyer deposits sale amount to escrow
8. Buyer clicks "Confirm Delivery" when satisfied
9. Seller receives payout minus 5% fee

## Commands

| Command | Description |
|---------|-------------|
| `/mm link <minecraft_username>` | Link your Discord to Minecraft |
| `/mm create @user seller_mc buyer_mc amount` | Create new trade (legacy) |
| `/mm status <trade_id>` | Check trade status |
| `/mm deposit <trade_id>` | Mark escrow deposit |
| `/mm mark_scammed <trade_id> <reason>` | Report scam |
| `/mm adjudicate <trade_id> seller\|buyer [reason]` | Admin: resolve dispute |
| `/mm freeze <trade_id>` | Admin: freeze trade funds |
| `/mm unfreeze <trade_id>` | Admin: unfreeze trade |
| `/mm close_ticket <trade_id> [notes]` | Admin: close ticket |
| `/mm setchannel #channel` | Admin: set completion log channel |
| `/mm set_support_role @role` | Admin: set support role |
| `/mm set_mm_channel #channel` | Admin: set public middleman channel |
| `/mm post_embed` | Admin: post/refresh public middleman embed |

## Environment Variables

Required:
- `DISCORD_TOKEN`: Discord bot token
- `DISCORD_CLIENT_ID`: Discord application client ID
- `DATABASE_URL`: PostgreSQL connection string (auto-provisioned)

Optional:
- `ENABLE_MINEFLAYER`: Set to "true" to enable Minecraft bot connection
- `MINECRAFT_HOST`: Minecraft server address (default: donut.smp.net)
- `MINECRAFT_PORT`: Minecraft server port (default: 25565)
- `MINECRAFT_VERSION`: Minecraft version (default: 1.21.1)
- `MINECRAFT_USERNAME`: Bot's Minecraft username (default: Bunji_MC)
- `MINECRAFT_AUTH`: Auth type for Mineflayer (default: offline)
- `VERIFICATION_MIN`: Min verification amount (default: 1.00)
- `VERIFICATION_MAX`: Max verification amount (default: 100.24)
- `FEE_PERCENT`: Fee percentage (default: 5.0)

## Trade Status Flow

```
CREATED → AWAITING_VERIFICATION → VERIFIED → IN_ESCROW → COMPLETED
                                      ↓
                               DISPUTE_OPEN → (adjudicated) → COMPLETED/CANCELLED
```

## Webhook Endpoints

- `POST /webhook/payment` - Receive signed payment confirmations from Minecraft plugin
- `POST /webhook/verify-account` - Receive account verification from plugin
- `GET /health` - Health check endpoint

Headers required for webhooks:
- `X-HMAC-Signature`: HMAC-SHA256 signature of request body
- `X-Guild-ID`: Discord guild ID

## Recent Changes

- Dec 2024: Rebranded from "Cryptocurrency Middleman" to "Donut SMP Middleman" - all references updated
- Dec 2024: New orange/blue color theme (#F5A623, #5865F2) for better visual identity
- Dec 2024: Fixed role confirmation flow - now only appears AFTER user selects a role, not immediately
- Dec 2024: Added emojis to all buttons for better visual clarity
- Dec 2024: Improved embed formatting with clearer instructions and better UX
- Dec 2024: Updated channel naming from "ticket-" to "trade-" prefix
- Dec 2024: Major UX improvements - friendlier language, step-by-step instructions, clearer error messages
- Dec 2024: Added Mineflayer integration for in-game payment detection
- Dec 2024: Added GUI-first flow with public embed and "Start Middleman" button
- Dec 2024: Added private trade channels (not threads) for better visibility
- Dec 2024: Added Copy Pay button with pre-filled /pay commands
- Dec 2024: Initial implementation with slash commands and webhook system
