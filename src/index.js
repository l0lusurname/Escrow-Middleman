// Bulletproof 24/7 AFK bot for DonutSMP (or any Minecraft server)
// ⚠️ Use only your own account and follow server rules.
const mineflayer = require('mineflayer')

const HOST = process.env.MC_HOST || 'donutsmp.net'
const PORT = parseInt(process.env.MC_PORT || '25565')
const USERNAME = process.env.MC_USERNAME
const PASSWORD = process.env.MC_PASSWORD
const AUTH = process.env.MC_AUTH || 'microsoft'
const VERSION = process.env.MC_VERSION || false

if (!USERNAME) {
  console.error('❌ Missing MC_USERNAME environment variable')
  process.exit(1)
}

let reconnectAttempts = 0
let reconnectTimeout = null
let teamHomeInterval = null
let bot = null

function clearIntervals() {
  if (teamHomeInterval) {
    clearInterval(teamHomeInterval)
    teamHomeInterval = null
  }
}

function startBot() {
  // Clear any existing reconnect timeout
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }

  // Clear any existing intervals
  clearIntervals()

  const botOptions = {
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: AUTH,
    version: VERSION,
    connectTimeout: 60000, // Increased to 60s
    checkTimeoutInterval: 30000,
    hideErrors: false,
    // Anti-disconnect settings
    keepAlive: true,
    // Handle connection issues better
    validateChannelProtocol: false
  }

  if (PASSWORD) {
    botOptions.password = PASSWORD
  }

  try {
    bot = mineflayer.createBot(botOptions)
  } catch (err) {
    console.error('❌ Failed to create bot:', err.message)
    scheduleReconnect()
    return
  }

  bot.once('login', () => {
    console.log(`✅ Logged in as ${USERNAME}`)
    console.log(`📦 Protocol version: ${bot.version}`)
    reconnectAttempts = 0 // Reset on successful login
  })

  bot.once('spawn', () => {
    console.log('🌍 Spawned and ready!')
    
    // Execute /team home immediately on spawn
    setTimeout(() => {
      if (bot && bot.entity) {
        console.log('🏠 Executing /team home...')
        bot.chat('/team home')
      }
    }, 2000) // Wait 2s for server to be fully ready

    // Execute /team home every 10 minutes
    teamHomeInterval = setInterval(() => {
      if (bot && bot.entity) {
        console.log('🏠 Executing /team home (scheduled)...')
        bot.chat('/team home')
      }
    }, 1000 * 60 * 10) // Every 10 minutes
  })

  bot.on('end', (reason) => {
    console.log('⚠️ Disconnected:', reason)
    clearIntervals()
    scheduleReconnect()
  })

  bot.on('kicked', (reason) => {
    console.warn('⚠️ Kicked:', reason)
    clearIntervals()
    scheduleReconnect()
  })

  bot.on('error', (err) => {
    console.error('❌ Bot error:', err.message)
    
    if (err.message.includes('PartialReadError')) {
      console.log('💡 Hint: Try setting MC_VERSION env variable (e.g., "1.20.1")')
    }
    
    if (err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEDOUT')) {
      console.log('🔌 Connection issue detected, will retry...')
    }

    // Don't disconnect, let other handlers deal with it
  })

  // Handle client errors without crashing
  if (bot._client) {
    bot._client.on('error', (err) => {
      console.error('❌ Client error:', err.message)
      // These errors usually lead to disconnect anyway
    })
  }

  // Keep-alive mechanism - send position packet periodically
  const keepAliveInterval = setInterval(() => {
    if (bot && bot.entity && bot.entity.position) {
      // Just accessing position keeps connection alive
      const pos = bot.entity.position
      // Optionally log to show bot is still running
      if (Date.now() % (1000 * 60 * 5) < 30000) { // Log every ~5 minutes
        console.log(`💓 Still connected at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`)
      }
    }
  }, 30000) // Every 30 seconds

  // Clean up interval on bot end
  bot.once('end', () => {
    clearInterval(keepAliveInterval)
  })
}

function scheduleReconnect() {
  reconnectAttempts++
  
  // Exponential backoff: 10s, 20s, 30s, max 60s
  const delay = Math.min(10000 * reconnectAttempts, 60000)
  
  console.log(`🔁 Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts})`)
  
  reconnectTimeout = setTimeout(() => {
    startBot()
  }, delay)
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...')
  clearIntervals()
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  if (bot) bot.quit()
  setTimeout(() => process.exit(0), 1000)
})

process.on('SIGTERM', () => {
  console.log('\n👋 Received SIGTERM, shutting down...')
  clearIntervals()
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  if (bot) bot.quit()
  setTimeout(() => process.exit(0), 1000)
})

// Handle uncaught errors
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

// Start the bot
console.log('🚀 Starting AFK bot...')
console.log(`📍 Server: ${HOST}:${PORT}`)
console.log(`👤 Username: ${USERNAME}`)
console.log(`🔐 Auth: ${AUTH}`)
startBot()
