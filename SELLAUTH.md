# SellAuth Poller

This project contains an optional SellAuth poller that will automatically fetch completed invoices from SellAuth and issue in-game payments via the Minecraft bot.

## Configuration (env vars)

- SELLAUTH_API_KEY - Your SellAuth API key (required)
- SELLAUTH_SHOP_ID - Shop ID (required)
- SELLAUTH_POLL_INTERVAL - Poll interval in seconds (default: 60)
- SELLAUTH_MULTIPLIER - Multiplier to convert invoice amount to in-game coins (default: 1000000)
- SELLAUTH_DRY_RUN - If `true`, the poller will not execute payments (default: `false`)
- SELLAUTH_MAX_PAYMENT - Optional maximum allowed coins per payment (prevents accidental large payouts)
- SELLAUTH_LOG_FILE - Path to write payment logs (default: `./logs/sellauth_payments.log`)
- SELLAUTH_INVOICE_STORE_FILE - Path to store processed invoice IDs (default: `./data/processed_invoices.json`)
- CUSTOM_FIELD_NAME - Name of the custom field containing the Minecraft name (default: `In game name`)

## Safety & Notes

- Dry-run will log actions but not mark invoices as processed so you can test repeatedly.
- In non-dry-run mode invoices are marked processed only after a successful payment execution.
- If the bot is offline, the payment will be queued and the poller will retry later.

## Manual verification

1. Set `SEL﻿LAUTH_DRY_RUN=true` to test without executing payments.
2. Set `SEL﻿LAUTH_API_KEY` and `SEL﻿LAUTH_SHOP_ID` and `CUSTOM_FIELD_NAME` if you use a custom field name.
3. Start the bot: `npm start` (ensure MC credentials set and bot connects).
4. Verify the poller logs: `tail -f ./logs/sellauth_payments.log` (or the log path you provided).
5. Create a completed invoice in SellAuth (or use an existing completed invoice) with the custom field set to your Minecraft username and an amount value. The poller should detect it on the next interval and (in dry-run) log a pending action.
6. Disable dry-run and test again in a safe environment (use `SEL﻿LAUTH_MAX_PAYMENT` to limit accidental large payouts).

## Files added

- `src/services/sellauthPoller.js` - Poller implementation
- `src/utils/processedInvoices.js` - Simple file-backed store for processed invoice IDs

