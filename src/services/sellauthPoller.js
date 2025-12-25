import fs from 'fs/promises'
import path from 'path'
import { hasProcessed, markProcessed } from '../utils/processedInvoices.js'

const DEFAULT_POLL_INTERVAL = parseInt(process.env.SELLAUTH_POLL_INTERVAL || '60') * 1000
const DEFAULT_MULTIPLIER = parseFloat(process.env.SELLAUTH_MULTIPLIER || '1000000')
const DEFAULT_LOG_FILE = process.env.SELLAUTH_LOG_FILE || './logs/sellauth_payments.log'
const DEFAULT_MAX_PAYMENT = process.env.SELLAUTH_MAX_PAYMENT ? Number(process.env.SELLAUTH_MAX_PAYMENT) : null
const DRY_RUN = (process.env.SELLAUTH_DRY_RUN || 'false').toLowerCase() === 'true'
const CUSTOM_FIELD_NAME = process.env.CUSTOM_FIELD_NAME || 'In game name'

let polling = false
let poller = null

async function appendLog(line, file = DEFAULT_LOG_FILE) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(file, line + '\n')
}

function findInGameName(invoice) {
  // custom_fields could be object or array
  if (!invoice) return null
  if (invoice.custom_fields) {
    if (Array.isArray(invoice.custom_fields)) {
      const field = invoice.custom_fields.find(f => f.name === CUSTOM_FIELD_NAME || (f.key && f.key === CUSTOM_FIELD_NAME))
      if (field) return field.value || field.val || null
    } else if (typeof invoice.custom_fields === 'object') {
      const v = invoice.custom_fields[CUSTOM_FIELD_NAME] || invoice.custom_fields['in game name'] || invoice.custom_fields['in_game_name']
      if (v) return v
    }
  }
  // Some APIs place custom_fields inside items array
  if (invoice.items && Array.isArray(invoice.items)) {
    for (const item of invoice.items) {
      if (item.custom_fields && Array.isArray(item.custom_fields)) {
        const field = item.custom_fields.find(f => f.name === CUSTOM_FIELD_NAME)
        if (field) return field.value
      } else if (item.custom_fields && typeof item.custom_fields === 'object') {
        if (item.custom_fields[CUSTOM_FIELD_NAME]) return item.custom_fields[CUSTOM_FIELD_NAME]
      }
    }
  }
  return null
}

function findAmount(invoice) {
  // Try various common properties
  const keys = ['amount_paid','paid_amount','amount','total','total_paid','price']
  for (const k of keys) {
    if (invoice[k] != null) {
      const v = Number(invoice[k])
      if (!isNaN(v)) return v
    }
  }

  // If there are items, try to sum their prices * quantity
  if (Array.isArray(invoice.items)) {
    let total = 0
    for (const item of invoice.items) {
      const price = Number(item.price || item.unit_price || item.amount || item.total_price) || 0
      const qty = Number(item.quantity || 1) || 1
      total += price * qty
    }
    if (total > 0) return total
  }

  // Fallback: try parsing from product/variant names
  const names = [invoice.variant_name, invoice.product_name, invoice.name, invoice.description].filter(Boolean)
  for (const n of names) {
    const m = n.toString().match(/(\d+(?:\.\d+)?)(?:\s*(m|million))\b/i)
    if (m) return parseFloat(m[1]) // in millions (will be converted by multiplier)
    const m2 = n.toString().match(/(\d+(?:\.\d+)?)[\s-]*m\b/i)
    if (m2) return parseFloat(m2[1])
  }

  return null
}

export function startSellAuthPoller(options = {}) {
  if (polling) return
  const SELLAUTH_API_KEY = process.env.SELLAUTH_API_KEY
  const SELLAUTH_SHOP_ID = process.env.SELLAUTH_SHOP_ID
  const intervalMs = parseInt(process.env.SELLAUTH_POLL_INTERVAL || '60') * 1000
  const multiplier = parseFloat(process.env.SELLAUTH_MULTIPLIER || String(DEFAULT_MULTIPLIER))
  const maxPayment = process.env.SELLAUTH_MAX_PAYMENT ? Number(process.env.SELLAUTH_MAX_PAYMENT) : DEFAULT_MAX_PAYMENT
  const dryRun = (process.env.SELLAUTH_DRY_RUN || 'false').toLowerCase() === 'true'
  const logFile = process.env.SELLAUTH_LOG_FILE || DEFAULT_LOG_FILE
  const doPayment = options.doPayment || (async (username, coins) => { throw new Error('No payment handler supplied') })

  if (!SELLAUTH_API_KEY || !SELLAUTH_SHOP_ID) {
    console.warn('⚠️ SellAuth poller disabled: missing SELLAUTH_API_KEY or SELLAUTH_SHOP_ID')
    return
  }

  polling = true
  let backoffAttempt = 0

  async function pollOnce() {
    try {
      // FIXED: Send statuses as array in request body instead of query param
      const url = `https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/invoices`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SELLAUTH_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          statuses: ["completed"],  // Must be an array
          perPage: 100,
          orderColumn: "completed_at",
          orderDirection: "desc"
        })
      })

      if (!res.ok) {
        const text = await res.text()
        console.error(`❌ SellAuth API responded ${res.status}: ${text}`)
        backoffAttempt++
        throw new Error(`SellAuth API error: ${res.status}`)
      }

      const payload = await res.json()
      backoffAttempt = 0

      // Payload might be { items: [...] } or an array
      const invoices = Array.isArray(payload) ? payload : (payload.items || payload.invoices || payload.data || [])

      console.log(`🔎 SellAuth poll: found ${invoices.length} completed invoice(s)`)

      for (const invoice of invoices) {
        try {
          const invoiceId = invoice.id || invoice.invoice_id || invoice._id
          if (!invoiceId) continue

          const already = await hasProcessed(invoiceId)
          if (already) continue

          const inGameName = findInGameName(invoice)
          if (!inGameName || String(inGameName).trim() === '') {
            const msg = `❌ Invoice ${invoiceId}: missing custom field "${CUSTOM_FIELD_NAME}" - skipping`
            console.error(msg)
            await appendLog(`${new Date().toISOString()} | ERROR | ${invoiceId} | missing_in_game_name | - | -`, logFile)
            continue
          }

          let amount = findAmount(invoice)
          if (amount == null) {
            const msg = `❌ Invoice ${invoiceId}: unable to determine amount - skipping`
            console.error(msg)
            await appendLog(`${new Date().toISOString()} | ERROR | ${invoiceId} | missing_amount | ${inGameName} | -`, logFile)
            continue
          }

          // If amount looks like small (like 1 or 2) and invoice keys indicated it's 'millions' via text
          // We'll assume the amount is in base units and multiplier handles conversion
          const coins = Math.floor(Number(amount) * multiplier)

          if (!Number.isFinite(coins) || isNaN(coins)) {
            console.error(`❌ Invoice ${invoiceId}: invalid computed coins: ${coins} - skipping`)
            await appendLog(`${new Date().toISOString()} | ERROR | ${invoiceId} | invalid_coins | ${inGameName} | ${amount}`, logFile)
            continue
          }

          if (maxPayment && coins > maxPayment) {
            const msg = `⚠️ Invoice ${invoiceId}: computed payment ${coins} exceeds maxPayment ${maxPayment} - skipping and alerting`
            console.error(msg)
            await appendLog(`${new Date().toISOString()} | ALERT | ${invoiceId} | exceeds_max | ${inGameName} | ${coins}`, logFile)
            continue
          }

          // Confirmation log
          console.log(`➡️  Invoice ${invoiceId}: paying ${inGameName} -> ${coins} coins (${amount} * ${multiplier})`)
          await appendLog(`${new Date().toISOString()} | PENDING | ${invoiceId} | ${inGameName} | ${coins}`, logFile)

          if (dryRun) {
            console.log(`🧪 Dry-run enabled: NOT executing payment for invoice ${invoiceId}`)
            await appendLog(`${new Date().toISOString()} | DRYRUN | ${invoiceId} | ${inGameName} | ${coins}`, logFile)
            // Do not mark processed when dry-run so it can be tested repeatedly
            continue
          }

          // Execute payment via provided callback. Expect a Promise.
          try {
            await doPayment(inGameName, coins)
            console.log(`✅ Payment executed for invoice ${invoiceId}: ${inGameName} +${coins}`)
            await appendLog(`${new Date().toISOString()} | SUCCESS | ${invoiceId} | ${inGameName} | ${coins}`, logFile)
            // Mark processed to avoid duplication
            await markProcessed(invoiceId)
          } catch (err) {
            console.error(`❌ Payment failed for invoice ${invoiceId}:`, err.message || err)
            await appendLog(`${new Date().toISOString()} | FAILED | ${invoiceId} | ${inGameName} | ${coins} | ${err.message || err}`, logFile)
            // Do not mark processed so we can retry later
          }

        } catch (errInvoice) {
          console.error('❌ Error processing invoice:', errInvoice.message || errInvoice)
        }
      }

    } catch (err) {
      // API error, apply exponential backoff for next run
      const maxDelay = 1000 * 60 * 5 // 5 minutes
      backoffAttempt = Math.min(backoffAttempt + 1, 10)
      const delay = Math.min(1000 * Math.pow(2, backoffAttempt), maxDelay)
      console.error(`⚠️ SellAuth poll error: ${err.message || err}. Backing off for ${Math.round(delay/1000)}s`)
      if (poller) {
        clearInterval(poller)
        poller = setInterval(pollOnce, delay)
      }
      return
    }
  }

  // Start regular polling
  pollOnce().catch(e => console.error('Poll initial run failed:', e.message || e))
  poller = setInterval(pollOnce, intervalMs)
  console.log(`🔁 SellAuth poller started (interval ${intervalMs/1000}s, multiplier=${multiplier}, dryRun=${dryRun})`)
}

export function stopSellAuthPoller() {
  if (poller) clearInterval(poller)
  polling = false
  poller = null
}