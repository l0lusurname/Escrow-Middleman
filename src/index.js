// Complete SellAuth + Minecraft Bot Integration
// Handles both order webhooks AND dynamic delivery webhooks

import mineflayer from 'mineflayer'
import express from 'express'
import crypto from 'crypto'
import { verifyHmacDetailed } from './utils/hmac.js'

// ============ CONFIGURATION ============
const MC_HOST = process.env.MC_HOST || 'donutsmp.net'
const MC_PORT = parseInt(process.env.MC_PORT || '25565')
const MC_USERNAME = process.env.MC_USERNAME
const MC_PASSWORD = process.env.MC_PASSWORD
const MC_AUTH = process.env.MC_AUTH || 'microsoft'
const MC_VERSION = process.env.MC_VERSION || false

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3000')
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET // Optional - for order webhooks
const DYNAMIC_DELIVERY_SECRET = process.env.DYNAMIC_DELIVERY_SECRET // For dynamic delivery
const CUSTOM_FIELD_NAME = process.env.CUSTOM_FIELD_NAME || 'In game name'

// SellAuth API Configuration
const SELLAUTH_API_KEY = process.env.SELLAUTH_API_KEY
const SELLAUTH_SHOP_ID = process.env.SELLAUTH_SHOP_ID
const SELLAUTH_PRODUCT_ID = process.env.SELLAUTH_PRODUCT_ID

// Stock update interval (default: 5 minutes)
const STOCK_UPDATE_INTERVAL = parseInt(process.env.STOCK_UPDATE_INTERVAL || '300000')

// Validation
if (!MC_USERNAME) {
  console.error('❌ Missing MC_USERNAME environment variable')
  process.exit(1)
}

if (!DYNAMIC_DELIVERY_SECRET) {
  console.warn('⚠️ Missing DYNAMIC_DELIVERY_SECRET - dynamic delivery verification disabled')
  console.warn('💡 Get it from: Storefront > Configure > Miscellaneous')
}

// ============ GLOBAL STATE ============
let bot = null
let reconnectAttempts = 0
let reconnectTimeout = null
let teamHomeInterval = null
let stockUpdateInterval = null
const pendingPayments = []
let currentBalance = 0

// ============ SELLAUTH API FUNCTIONS ============
async function updateSellAuthStock(stockAmount) {
  if (!SELLAUTH_API_KEY || !SELLAUTH_SHOP_ID || !SELLAUTH_PRODUCT_ID) {
    return false
  }

  try {
    const url = `https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/products/${SELLAUTH_PRODUCT_ID}/stock`

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${SELLAUTH_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ stock: stockAmount })
    })

    if (!response.ok) {
      const error = await response.text()
      console.error(`❌ Failed to update stock: ${response.status}`)
      if (response.status === 405) {
        console.error(`   ⚠️ Make sure product deliverable type is "service" or "dynamic"`)
      }
      return false
    }

    console.log(`✅ SellAuth stock updated: ${stockAmount} units`)
    return true
  } catch (err) {
    console.error('❌ Error updating stock:', err.message)
    return false
  }
}

function calculateStockFromBalance(balanceInMillions) {
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
    
    setTimeout(() => {
      if (bot && bot.entity) {
        console.log('🏠 Executing /team home...')
        bot.chat('/team home')
      }
    }, 2000)

    setTimeout(() => {
      checkBalance()
    }, 5000)

    teamHomeInterval = setInterval(() => {
      if (bot && bot.entity) {
        console.log('🏠 Executing /team home (scheduled)...')
        bot.chat('/team home')
      }
    }, 1000 * 60 * 10)

    if (SELLAUTH_API_KEY && SELLAUTH_SHOP_ID && SELLAUTH_PRODUCT_ID) {
      stockUpdateInterval = setInterval(() => {
        checkBalance()
      }, STOCK_UPDATE_INTERVAL)
      console.log(`📊 Stock auto-update enabled (every ${STOCK_UPDATE_INTERVAL / 1000}s)`)
    }

    processPendingPayments()
  })

  bot.on('message', (message) => {
    const text = message.toString()
    
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
        
        if (text.toLowerCase().includes('m')) {
          balance = parseFloat(balance)
        } else {
          balance = parseFloat(balance) / 1000000
        }

        if (!isNaN(balance)) {
          currentBalance = balance
          const stock = calculateStockFromBalance(balance)
          console.log(`💰 Balance detected: ${balance.toFixed(2)}m (${stock} stock units)`)
          
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

function checkBalance() {
  if (!bot || !bot.entity) {
    console.warn('⚠️ Bot offline, cannot check balance')
    return
  }

  console.log('💳 Checking balance...')
  bot.chat('/balance')
}

// ============ PAYMENT PROCESSING ============
function executePayment(username, amount) {
  if (!bot || !bot.entity) {
    console.warn(`⚠️ Bot offline, queuing payment: ${amount}m to ${username}`)
    pendingPayments.push({ username, amount })
    return false
  }

  const command = `/pay ${username} ${amount}m`
  console.log(`💰 Executing: ${command}`)
  bot.chat(command)

  setTimeout(() => {
    checkBalance()
  }, 3000)

  return true
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

app.use(express.json())
app.use(express.text()) // For dynamic delivery plain text responses

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    minecraft: bot && bot.entity ? 'connected' : 'disconnected',
    pendingPayments: pendingPayments.length,
    currentBalance: `${currentBalance.toFixed(2)}m`,
    currentStock: calculateStockFromBalance(currentBalance),
    stockAutoUpdate: SELLAUTH_API_KEY ? 'enabled' : 'disabled'
  })
})

// Debug endpoint to help inspect expected HMAC signatures (ENABLE ONLY FOR TESTING)
if (process.env.SELLAUTH_DEBUG_SIGNATURES === 'true') {
  app.post('/debug/signature', (req, res) => {
    try {
      const which = req.query.for === 'dynamic' ? 'dynamic' : 'webhook'
      const secret = which === 'dynamic' ? DYNAMIC_DELIVERY_SECRET : WEBHOOK_SECRET
      if (!secret) return res.status(400).json({ error: `Secret not configured for ${which}` })
      const payload = req.rawBody || (req.body ? JSON.stringify(req.body) : '')
      const result = verifyHmacDetailed(payload, 'dummy', secret)
      return res.json({ which, expectedHex: result.expectedHex, expectedBase64: result.expectedBase64 })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  })
}

// Dynamic Delivery Webhook (for products with "dynamic" deliverable type)
app.post('/dynamic-delivery', (req, res) => {
  try {
    console.log('\n🎯 Dynamic delivery webhook received')

    // Verify signature if secret is provided
    if (DYNAMIC_DELIVERY_SECRET) {
      const signature = req.headers['x-sellauth-signature'] || req.headers['x-hmac-signature'] || req.headers['x-signature'] || req.headers['signature'] || req.headers['x-sellauth-signature']
      if (!signature) {
        console.warn('⚠️ No signature header - rejected')
        console.warn('   Available headers:', Object.keys(req.headers).join(', '))
        return res.status(403).send('Missing signature')
      }

      const payload = req.rawBody || (req.body ? JSON.stringify(req.body) : '')
      const result = verifyHmacDetailed(payload, signature, DYNAMIC_DELIVERY_SECRET)
      if (!result.ok) {
        const mask = s => s ? `${s.slice(0,6)}...${s.slice(-6)} (len=${s.length})` : '<none>'
        console.warn(`⚠️ Signature verification failed - rejected. Provided: ${mask(signature)}; Expected(hex): ${mask(result.expectedHex)}; reason: ${result.reason}`)
        if (process.env.SELLAUTH_DEBUG_SIGNATURES === 'true') {
          return res.status(403).json({ error: 'Invalid signature', provided: signature, expectedHex: result.expectedHex, expectedBase64: result.expectedBase64 })
        }
        return res.status(403).send('Invalid signature')
      }
    }

    const data = req.body

    if (data.event === 'INVOICE.ITEM.DELIVER-DYNAMIC') {
      console.log(`📦 Dynamic delivery request for invoice #${data.id}`)

      // Get in-game name from custom fields
      let inGameName = null
      if (data.item && data.item.custom_fields) {
        inGameName = data.item.custom_fields[CUSTOM_FIELD_NAME]
      }

      if (!inGameName) {
        console.error(`❌ Missing custom field "${CUSTOM_FIELD_NAME}"`)
        return res.status(400).send(`Error: Missing ${CUSTOM_FIELD_NAME} field`)
      }

      // Calculate amount
      let amount = data.item.quantity || 1

      // Try to extract amount from product/variant name
      const productName = data.item.product?.name || ''
      const variantName = data.item.variant?.name || ''
      
      const match = (productName + ' ' + variantName).match(/(\d+)m/i)
      if (match) {
        amount = parseInt(match[1]) * (data.item.quantity || 1)
      }

      console.log(`   - Player: ${inGameName}`)
      console.log(`   - Amount: ${amount}m`)
      console.log(`   - Product: ${productName}`)
      console.log(`   - Quantity: ${data.item.quantity}`)

      // Execute payment
      const success = executePayment(inGameName, amount)

      if (success) {
        // Respond with delivery confirmation (plain text)
        // This is what SellAuth will show to the customer
        const deliveryMessage = `Payment of ${amount}m has been sent to ${inGameName}!\nPlease check your in-game balance.`
        return res.status(200).send(deliveryMessage)
      } else {
        // Bot offline - queue the payment
        return res.status(200).send(`Payment queued for ${inGameName}. You will receive ${amount}m once the system is back online.`)
      }
    } else {
      console.log(`ℹ️ Unknown event: ${data.event}`)
      return res.status(200).send('Event received')
    }

  } catch (err) {
    console.error('❌ Dynamic delivery error:', err.message)
    return res.status(500).send('Internal server error')
  }
})

// Regular Order Webhook (optional - for order:completed events)
app.post('/webhook', (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const signature = req.headers['x-hmac-signature'] || req.headers['x-sellauth-signature'] || req.headers['x-signature'] || req.headers['signature'] || req.headers['x-signature']
      if (!signature) {
        console.warn('⚠️ Webhook without signature - rejected')
        console.warn('   Available headers:', Object.keys(req.headers).join(', '))
        return res.status(403).json({ error: 'No signature provided' })
      }

      const payload = req.rawBody || (req.body ? JSON.stringify(req.body) : '')
      const result = verifyHmacDetailed(payload, signature, WEBHOOK_SECRET)
      if (!result.ok) {
        const mask = s => s ? `${s.slice(0,6)}...${s.slice(-6)} (len=${s.length})` : '<none>'
        console.warn(`⚠️ Webhook signature verification failed. Provided: ${mask(signature)}; Expected(hex): ${mask(result.expectedHex)}; reason: ${result.reason}`)
        if (process.env.SELLAUTH_DEBUG_SIGNATURES === 'true') {
          return res.status(403).json({ error: 'Invalid signature', provided: signature, expectedHex: result.expectedHex, expectedBase64: result.expectedBase64 })
        }
        return res.status(403).json({ error: 'Invalid signature' })
      }
    }

    const { event, data } = req.body

    if (event === 'order:completed' || event === 'order.completed') {
      console.log(`\n🎉 Order completed webhook - Invoice #${data.id}`)
      
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
        console.error(`❌ Missing custom field "${CUSTOM_FIELD_NAME}"`)
        return res.json({ success: false, error: 'Missing in-game name' })
      }

      let amount = 1
      
      if (data.variant_name) {
        const match = data.variant_name.match(/(\d+)m/i)
        if (match) {
          amount = parseInt(match[1])
        }
      } else if (data.product_name) {
        const match = data.product_name.match(/(\d+)m/i)
        if (match) {
          amount = parseInt(match[1])
        }
      }

      if (data.quantity && data.quantity > 1) {
        amount *= data.quantity
      }

      console.log(`   - Player: ${inGameName}`)
      console.log(`   - Amount: ${amount}m`)

      executePayment(inGameName, amount)

      res.json({ success: true, message: `Payment sent to ${inGameName}` })
    } else {
      console.log(`ℹ️ Webhook event: ${event} (ignored)`)
      res.json({ success: true, message: 'Event ignored' })
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

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

app.listen(WEBHOOK_PORT, () => {
  console.log(`\n🚀 Webhook server started`)
  console.log(`📍 Listening on: http://localhost:${WEBHOOK_PORT}`)
  console.log(`🔗 Dynamic Delivery URL: http://your-domain.com:${WEBHOOK_PORT}/dynamic-delivery`)
  console.log(`🔗 Order Webhook URL: http://your-domain.com:${WEBHOOK_PORT}/webhook`)
  console.log(`💡 Set Dynamic Delivery URL in: SellAuth > Products > Edit > Dynamic Delivery URL\n`)
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

// ============ START ============
console.log('🎮 Starting SellAuth + Minecraft Integration...')
console.log(`📍 Minecraft: ${MC_HOST}:${MC_PORT}`)
console.log(`👤 Username: ${MC_USERNAME}`)
console.log(`🔐 Auth: ${MC_AUTH}`)
startBot()