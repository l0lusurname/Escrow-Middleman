// Complete SellAuth + Minecraft Bot Integration
// Listens for SellAuth webhooks, executes /pay commands, and auto-updates stock

import mineflayer from 'mineflayer'
import express from 'express'
import { verifyHmac } from './utils/hmac.js'

// ============ CONFIGURATION ============
const MC_HOST = process.env.MC_HOST || 'donutsmp.net'
const MC_PORT = parseInt(process.env.MC_PORT || '25565')
const MC_USERNAME = process.env.MC_USERNAME
const MC_PASSWORD = process.env.MC_PASSWORD
const MC_AUTH = process.env.MC_AUTH || 'microsoft'
const MC_VERSION = process.env.MC_VERSION || false

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3000')
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET // Optional - for webhook verification
const CUSTOM_FIELD_NAME = process.env.CUSTOM_FIELD_NAME || 'In game name'

// SellAuth API Configuration
const SELLAUTH_API_KEY = process.env.SELLAUTH_API_KEY
const SELLAUTH_SHOP_ID = process.env.SELLAUTH_SHOP_ID
const SELLAUTH_PRODUCT_ID = process.env.SELLAUTH_PRODUCT_ID // Product ID for "$1 Milion Donutsmp"
const SELLAUTH_VARIANT_ID = process.env.SELLAUTH_VARIANT_ID // Optional - if using variants

// Stock update interval (default: 5 minutes)
const STOCK_UPDATE_INTERVAL = parseInt(process.env.STOCK_UPDATE_INTERVAL || '300000')

// Validation
if (!MC_USERNAME) {
  console.error('❌ Missing MC_USERNAME environment variable')
  process.exit(1)
}

if (!SELLAUTH_API_KEY) {
  console.warn('⚠️ Missing SELLAUTH_API_KEY - stock auto-update will be disabled')
  console.warn('💡 Get your API key from: Dashboard > Account > API')
}

if (!SELLAUTH_SHOP_ID || !SELLAUTH_PRODUCT_ID) {
  console.warn('⚠️ Missing SELLAUTH_SHOP_ID or SELLAUTH_PRODUCT_ID - stock auto-update will be disabled')
}

// ============ GLOBAL STATE ============
let bot = null
let reconnectAttempts = 0
let reconnectTimeout = null
let teamHomeInterval = null
let stockUpdateInterval = null
const pendingPayments = []
const recentWebhooks = [] // Store recent webhook events for debugging
let currentBalance = 0 // Store current in-game balance

// ============ SELLAUTH API FUNCTIONS ============
async function updateSellAuthStock(stockAmount) {
  if (!SELLAUTH_API_KEY || !SELLAUTH_SHOP_ID || !SELLAUTH_PRODUCT_ID) {
    console.warn('⚠️ SellAuth credentials not configured, skipping stock update')
    return false
  }

  try {
    // For "service" or "dynamic" deliverables_type: PUT /stock/{variantId}
    // For "serials" deliverables_type: Must update deliverables directly
    
    let url, method, body
    
    if (SELLAUTH_VARIANT_ID) {
      // If variant ID is provided, use the stock endpoint (for service/dynamic products)
      url = `https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/products/${SELLAUTH_PRODUCT_ID}/stock/${SELLAUTH_VARIANT_ID}`
      method = 'PUT'
      body = JSON.stringify({ stock: stockAmount })
    } else {
      // If no variant, update stock on the product itself (for service/dynamic)
      url = `https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/products/${SELLAUTH_PRODUCT_ID}/stock`
      method = 'PUT'
      body = JSON.stringify({ stock: stockAmount })
    }

    const response = await fetch(url, {
      method: method,
      headers: {
        'Authorization': `Bearer ${SELLAUTH_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: body
    })

    if (!response.ok) {
      const error = await response.text()
      console.error(`❌ Failed to update SellAuth stock: ${response.status}`)
      console.error(`   URL: ${url}`)
      console.error(`   Response: ${error}`)
      
      // Check if it's a 405 error - means wrong product type
      if (response.status === 405) {
        console.error(`   ⚠️ Stock API only works for "service" or "dynamic" deliverables_type`)
        console.error(`   ⚠️ If your product uses "serials", you cannot use the stock API`)
        console.error(`   ⚠️ For serials, you must manage deliverables directly`)
      }
      
      return false
    }

    console.log(`✅ SellAuth stock updated: ${stockAmount} units`)
    return true
  } catch (err) {
    console.error('❌ Error updating SellAuth stock:', err.message)
    return false
  }
}

function calculateStockFromBalance(balanceInMillions) {
  // Convert balance to stock units
  // 1 stock = 1 million coins
  // Examples: 1.5m = 1 stock, 5m = 5 stock, 10.5m = 10 stock
  return Math.floor(balanceInMillions)
}

// ============ MINECRAFT BOT ============
function clearIntervals() {
  if (teamHomeInterval) {
    clearInterval(teamHomeInterval)
    teamHomeInterval = null
  }
  if (stockUpdateInterval) {
    clearInterval(stockUpdateInterval)
    stockUpdateInterval = null
  }
}

function startBot() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }

  clearIntervals()

  const botOptions = {
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USERNAME,
    auth: MC_AUTH,
    version: MC_VERSION,
    connectTimeout: 60000,
    checkTimeoutInterval: 30000,
    hideErrors: false,
    keepAlive: true,
    validateChannelProtocol: false
  }

  if (MC_PASSWORD) {
    botOptions.password = MC_PASSWORD
  }

  try {
    bot = mineflayer.createBot(botOptions)
  } catch (err) {
    console.error('❌ Failed to create bot:', err.message)
    scheduleReconnect()
    return
  }

  bot.once('login', () => {
    console.log(`✅ Minecraft: Logged in as ${MC_USERNAME}`)
    console.log(`📦 Protocol version: ${bot.version}`)
    reconnectAttempts = 0
  })

  bot.once('spawn', () => {
    console.log('🌍 Minecraft: Spawned and ready!')
    
    // Execute /team home immediately
    setTimeout(() => {
      if (bot && bot.entity) {
        console.log('🏠 Executing /team home...')
        bot.chat('/team home')
      }
    }, 2000)

    // Check balance immediately after spawn
    setTimeout(() => {
      checkBalance()
    }, 5000)

    // Execute /team home every 10 minutes
    teamHomeInterval = setInterval(() => {
      if (bot && bot.entity) {
        console.log('🏠 Executing /team home (scheduled)...')
        bot.chat('/team home')
      }
    }, 1000 * 60 * 10)

    // Update stock every X minutes (default: 5 minutes)
    if (SELLAUTH_API_KEY && SELLAUTH_SHOP_ID && SELLAUTH_PRODUCT_ID) {
      stockUpdateInterval = setInterval(() => {
        checkBalance()
      }, STOCK_UPDATE_INTERVAL)
      console.log(`📊 Stock auto-update enabled (every ${STOCK_UPDATE_INTERVAL / 1000}s)`)
    }

    // Process any pending payments
    processPendingPayments()
  })

  // Listen for chat messages to parse balance
  bot.on('message', (message) => {
    const text = message.toString()
    
    // Parse balance from common formats:
    // "Your balance: $1,500,000" or "Balance: 1.5m" or "You have $2,000,000"
    const patterns = [
      /balance:?\s*\$?([\d,]+\.?\d*)\s*m/i,
      /balance:?\s*\$?([\d,]+)/i,
      /you have:?\s*\$?([\d,]+\.?\d*)\s*m/i,
      /you have:?\s*\$?([\d,]+)/i,
      /\$?([\d,]+\.?\d*)\s*million/i
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match) {
        let balance = match[1].replace(/,/g, '')
        
        // If it ends with 'm', it's already in millions
        if (text.toLowerCase().includes('m')) {
          balance = parseFloat(balance)
        } else {
          // Convert to millions
          balance = parseFloat(balance) / 1000000
        }

        if (!isNaN(balance)) {
          currentBalance = balance
          const stock = calculateStockFromBalance(balance)
          console.log(`💰 Balance detected: ${balance.toFixed(2)}m (${stock} stock units)`)
          
          // Update SellAuth stock
          updateSellAuthStock(stock)
        }
        break
      }
    }
  })

  bot.on('end', (reason) => {
    console.log('⚠️ Minecraft: Disconnected:', reason)
    clearIntervals()
    bot = null
    scheduleReconnect()
  })

  bot.on('kicked', (reason) => {
    console.warn('⚠️ Minecraft: Kicked:', reason)
    clearIntervals()
    bot = null
    scheduleReconnect()
  })

  bot.on('error', (err) => {
    console.error('❌ Minecraft: Bot error:', err.message)
  })

  if (bot._client) {
    bot._client.on('error', (err) => {
      console.error('❌ Minecraft: Client error:', err.message)
    })
  }

  // Keep-alive
  const keepAliveInterval = setInterval(() => {
    if (bot && bot.entity && bot.entity.position) {
      const pos = bot.entity.position
      if (Date.now() % (1000 * 60 * 5) < 30000) {
        console.log(`💓 Still connected at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`)
      }
    }
  }, 30000)

  bot.once('end', () => {
    clearInterval(keepAliveInterval)
  })
}

function scheduleReconnect() {
  reconnectAttempts++
  const delay = Math.min(10000 * reconnectAttempts, 60000)
  
  console.log(`🔁 Minecraft: Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts})`)
  
  reconnectTimeout = setTimeout(() => {
    startBot()
  }, delay)
}

// ============ BALANCE CHECKING ============
function checkBalance() {
  if (!bot || !bot.entity) {
    console.warn('⚠️ Bot offline, cannot check balance')
    return
  }

  // Try common balance commands
  // Adjust these based on your server's economy plugin
  const balanceCommands = [
    '/balance',
    '/bal',
    '/money',
    '/eco balance'
  ]

  // Try the first command (usually /balance or /bal)
  console.log('💳 Checking balance...')
  bot.chat(balanceCommands[0])
}

// ============ PAYMENT PROCESSING ============
function executePayment(username, amount) {
  if (!bot || !bot.entity) {
    console.warn(`⚠️ Bot offline, queuing payment: ${amount}m to ${username}`)
    pendingPayments.push({ username, amount })
    console.log(`📌 Payment queued. Pending payments: ${pendingPayments.length}`)
    return
  }

  const command = `/pay ${username} ${amount}m`
  console.log(`💰 Executing: ${command}`)
  bot.chat(command)

  // Check balance after payment to update stock
  setTimeout(() => {
    checkBalance()
  }, 3000)
}

function processPendingPayments() {
  if (pendingPayments.length === 0) return
  
  console.log(`📋 Processing ${pendingPayments.length} pending payment(s)...`)
  
  while (pendingPayments.length > 0) {
    const payment = pendingPayments.shift()
    executePayment(payment.username, payment.amount)
    setTimeout(() => {}, 1000)
  }
}

// ============ WEBHOOK SERVER ============
const app = express()

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString() : ''
  }
}))

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    minecraft: bot && bot.entity ? 'connected' : 'disconnected',
    pendingPayments: pendingPayments.length,
    currentBalance: `${currentBalance.toFixed(2)}m`,
    currentStock: calculateStockFromBalance(currentBalance),
    stockAutoUpdate: SELLAUTH_API_KEY ? 'enabled' : 'disabled',
    recentWebhooks: recentWebhooks.slice(0,10).map(e => ({ timestamp: e.timestamp, event: e.event, id: e.id }))
  })
})

app.post('/webhooks', (req, res) => {
  try {
    console.log('🔔 Webhook received:', req.body?.event || '<no event>', `id: ${req.body?.data?.id || 'N/A'}`)

    // Record for debugging
    recentWebhooks.unshift({ timestamp: Date.now(), event: req.body?.event, id: req.body?.data?.id, raw: (req.rawBody || JSON.stringify(req.body)).slice(0,200) })
    if (recentWebhooks.length > 20) recentWebhooks.pop()

    // Verify webhook signature if secret is provided
    if (WEBHOOK_SECRET) {
      const signature = req.headers['x-hmac-signature'] || req.headers['x-sellauth-signature'] || req.headers['x-signature'] || req.headers['signature']
      if (!signature) {
        console.warn('⚠️ Webhook received without signature header - rejected')
        console.warn('   Available headers:', Object.keys(req.headers).join(', '))
        return res.status(403).json({ error: 'No signature provided' })
      }

      const raw = req.rawBody || JSON.stringify(req.body)
      if (!verifyHmac(raw, signature, WEBHOOK_SECRET)) {
        console.warn('⚠️ Webhook signature verification failed - rejected')
        return res.status(403).json({ error: 'Invalid signature' })
      }
    }

    const { event, data } = req.body

    if (event === 'order:completed' || event === 'order.completed') {
      console.log(`\n🎉 New order received! Invoice #${data.id}`)
      
      let inGameName = null
      if (data.custom_fields && Array.isArray(data.custom_fields)) {
        const nameField = data.custom_fields.find(
          field => field.name === CUSTOM_FIELD_NAME
        )
        if (nameField) {
          inGameName = nameField.value
        }
      }

      if (!inGameName) {
        console.error(`❌ Order ${data.id}: Missing custom field "${CUSTOM_FIELD_NAME}"`)
        return res.json({ 
          success: false, 
          error: `Please provide your in-game name in the "${CUSTOM_FIELD_NAME}" field` 
        })
      }

      let amount = 1

      const nameToParse = (data.variant_name || data.product_name || '').toString()
      // Match patterns like '1m', '1 M', '1 million', '1.5m'
      const match = nameToParse.match(/(\d+(?:\.\d+)?)(?:\s*(m|million))\b/i)
      if (match) {
        amount = parseFloat(match[1])
      } else {
        // Fallback: try shorthand like '1M' or '5m'
        const match2 = nameToParse.match(/(\d+(?:\.\d+)?)[\s-]*m\b/i)
        if (match2) amount = parseFloat(match2[1])
      }

      if (data.quantity && data.quantity > 1) {
        amount *= data.quantity
      }

      console.log(`📦 Order details:`)
      console.log(`   - Player: ${inGameName}`)
      console.log(`   - Amount: ${amount}m`)
      console.log(`   - Product: ${data.product_name || 'N/A'}`)
      console.log(`   - Email: ${data.email || 'N/A'}`)

      executePayment(inGameName, amount)

      // Auto-process the invoice in SellAuth
      if (SELLAUTH_API_KEY && SELLAUTH_SHOP_ID && data.id) {
        const invoiceId = data.id
        const processUrl = `https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/invoices/${invoiceId}/process`
        
        fetch(processUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${SELLAUTH_API_KEY}`
          }
        })
        .then(res => res.json())
        .then(result => {
          console.log(`✅ SellAuth invoice ${invoiceId} marked as processed`)
        })
        .catch(err => {
          console.error(`❌ Failed to process invoice in SellAuth:`, err.message)
        })
      }

      res.json({ 
        success: true, 
        message: `Payment of ${amount}m will be sent to ${inGameName}` 
      })
      return
    }

    // Dynamic Delivery webhook
    if (event === 'INVOICE.ITEM.DELIVER-DYNAMIC') {
      console.log(`\n🚀 Dynamic Delivery requested for item #${req.body.item?.id}`)
      
      let inGameName = null
      if (req.body.item?.custom_fields) {
        // Try to find the in-game name in custom_fields (object format)
        if (typeof req.body.item.custom_fields === 'object' && !Array.isArray(req.body.item.custom_fields)) {
          inGameName = req.body.item.custom_fields[CUSTOM_FIELD_NAME]
        } else if (Array.isArray(req.body.item.custom_fields)) {
          const nameField = req.body.item.custom_fields.find(f => f.name === CUSTOM_FIELD_NAME)
          if (nameField) inGameName = nameField.value
        }
      }

      if (!inGameName) {
        console.error(`❌ Dynamic delivery for item ${req.body.item?.id}: Missing in-game name`)
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        return res.end('ERROR: Missing in-game name')
      }

      // Parse amount from product/variant name or use quantity
      let amount = req.body.item?.quantity || 1
      const variantName = req.body.item?.variant?.name || ''
      const productName = req.body.item?.product?.name || ''
      const fullName = (variantName || productName).toString()
      
      const match = fullName.match(/(\d+(?:\.\d+)?)(?:\s*(m|million))\b/i)
      if (match) {
        amount = parseFloat(match[1])
      }

      console.log(`📦 Dynamic Delivery details:`)
      console.log(`   - Player: ${inGameName}`)
      console.log(`   - Amount: ${amount}m`)
      console.log(`   - Product: ${productName}`)
      console.log(`   - Email: ${req.body.email || 'N/A'}`)

      executePayment(inGameName, amount)

      // Return 200 OK with confirmation (plain text for SellAuth)
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      return res.end(`SUCCESS: Delivered ${amount}m to ${inGameName}`)
    }

    console.log(`ℹ️ Received webhook event: ${event} (ignored)`)
    res.json({ success: true, message: 'Event ignored' })

  } catch (err) {
    console.error('❌ Webhook error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Manual stock update endpoint
app.post('/update-stock', async (req, res) => {
  try {
    checkBalance()
    
    setTimeout(() => {
      res.json({
        success: true,
        message: 'Balance check triggered',
        currentBalance: `${currentBalance.toFixed(2)}m`,
        currentStock: calculateStockFromBalance(currentBalance)
      })
    }, 5000)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Global error handler for Express
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err.message)
  console.error(err.stack)
  res.status(500).json({ error: 'Internal server error', message: err.message })
})

app.listen(WEBHOOK_PORT, () => {
  console.log(`\n🚀 Webhook server started`)
  console.log(`📍 Listening on: http://localhost:${WEBHOOK_PORT}`)
  console.log(`🔗 Webhook URL: http://your-domain.com:${WEBHOOK_PORT}/webhook`)
  console.log(`💡 Set this URL in SellAuth Dashboard > Settings > Developers\n`)
})

// ============ PROCESS HANDLERS ============
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...')
  clearIntervals()
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  if (bot) bot.quit()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n👋 Received SIGTERM, shutting down...')
  clearIntervals()
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  if (bot) bot.quit()
  process.exit(0)
})

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err.message)
  console.log('🔄 Attempting to recover...')
  clearIntervals()
  scheduleReconnect()
})

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection:', err.message)
  console.log('🔄 Attempting to recover...')
})

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err.message)
  console.error(err.stack)
})

// ============ START ============
console.log('🎮 Starting SellAuth + Minecraft Integration...')
console.log(`📍 Minecraft: ${MC_HOST}:${MC_PORT}`)
console.log(`👤 Username: ${MC_USERNAME}`)
console.log(`🔐 Auth: ${MC_AUTH}`)
startBot()