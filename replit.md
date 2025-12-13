# Donut SMP Escrow Bot

Discord Escrow/Middleman Bot for Minecraft server trades. Provides secure, ticket-based escrow trading with in-game payment verification, 5% fee automation, and scam dispute workflows.

## Overview

This bot manages escrow trades between Minecraft players with:
- Account linking (Discord ↔ Minecraft usernames)
- Private trade threads with verification amounts
- HMAC-authenticated webhooks for in-game payment detection
- Automatic 5% fee calculation and deduction
- Scam reporting with support role tagging

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
├── utils/
│   ├── currencyParser.js # Amount parsing (k/m/b suffix support)
│   ├── hmac.js           # HMAC signature verification
│   └── auditLog.js       # Audit logging utility
└── webhook/
    └── paymentWebhook.js # Minecraft server webhook endpoints
```

## Database Tables

- **linked_accounts**: Discord ↔ Minecraft username mappings
- **trades**: Trade records with verification amounts and status
- **verifications**: Payment verification records
- **tickets**: Trade ticket/thread tracking
- **audit_logs**: Complete action audit trail
- **bot_config**: Per-guild configuration (channels, roles, secrets)

## Commands

| Command | Description |
|---------|-------------|
| `/mm link <minecraft_username>` | Link your Discord to Minecraft |
| `/mm create @user seller_mc buyer_mc amount` | Create new trade |
| `/mm status <trade_id>` | Check trade status |
| `/mm deposit <trade_id>` | Mark escrow deposit |
| `/mm mark_scammed <trade_id> <reason>` | Report scam |
| `/mm adjudicate <trade_id> seller\|buyer [reason]` | Admin: resolve dispute |
| `/mm freeze <trade_id>` | Admin: freeze trade funds |
| `/mm unfreeze <trade_id>` | Admin: unfreeze trade |
| `/mm close_ticket <trade_id> [notes]` | Admin: close ticket |
| `/mm setchannel #channel` | Admin: set announcements channel |
| `/mm set_support_role @role` | Admin: set support role |

## Webhook Endpoints

- `POST /webhook/payment` - Receive signed payment confirmations from Minecraft plugin
- `POST /webhook/verify-account` - Receive account verification from plugin

Headers required:
- `X-HMAC-Signature`: HMAC-SHA256 signature of request body
- `X-Guild-ID`: Discord guild ID

## Environment Variables

Required:
- `DISCORD_TOKEN`: Discord bot token
- `DISCORD_CLIENT_ID`: Discord application client ID
- `DATABASE_URL`: PostgreSQL connection string (auto-provisioned)

Optional per-guild (set via commands or database):
- `WEBHOOK_SECRET`: HMAC secret for Minecraft plugin authentication

## Trade Status Flow

```
CREATED → VERIFIED → IN_ESCROW → COMPLETED
                  ↓
            DISPUTE_OPEN → (adjudicated) → COMPLETED/CANCELLED
```

## Recent Changes

- Initial implementation (Dec 2024)
- Full slash command system with /mm namespace
- Private thread-based trade tickets
- HMAC webhook authentication
- Currency parser with k/m/b suffix support
- 5% automatic fee calculation
- Scam reporting with support role tagging
