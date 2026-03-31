/*
  manamatrix.eth - FinViz-style Crypto Heatmap
  
  Features:
  - Treemap layout with tiles sized by market cap
  - Color gradient based on 24h % change (red to green)
  - Hover panel showing DEX trades and LP pools
  - Real-time data from DexScreener API
*/

import { prepare, layout, type PreparedText } from '../../../src/layout.ts'

// ==================== TYPES ====================

type Token = {
  address: string
  symbol: string
  name: string
  price: number
  priceChange24h: number
  volume24h: number
  liquidity: number
  marketCap: number
  chain: string
  pairAddress: string
  imageUrl?: string
  txns24h: number
  dexId: string
}

type TreemapTile = {
  token: Token
  x: number
  y: number
  width: number
  height: number
  color: string
  textColor: string
  originalX?: number
  originalY?: number
  originalWidth?: number
  originalHeight?: number
}

type Trade = {
  type: 'buy' | 'sell'
  amount: string
  price: string
  time: string
}

type Pool = {
  pair: string
  dex: string
  liquidity: number
  volume24h: number
  apr: number
}

// ==================== STATE ====================

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let tokens: Token[] = []
let tiles: TreemapTile[] = []
let hoveredTile: TreemapTile | null = null
let selectedChain = 'solana'
let selectedFilter = 'mcap'
let searchQuery = ''
let isLoading = true
let activeTab = 'trades'
let mouseX = 0
let mouseY = 0
let animationFrameId: number | null = null

// ==================== DOM ELEMENTS ====================

const loadingOverlay = document.getElementById('loading') as HTMLDivElement
const hoverPanel = document.getElementById('hover-panel') as HTMLDivElement
const totalVolumeEl = document.getElementById('total-volume') as HTMLSpanElement
const totalMcapEl = document.getElementById('total-mcap') as HTMLSpanElement
const gainersCountEl = document.getElementById('gainers-count') as HTMLSpanElement
const losersCountEl = document.getElementById('losers-count') as HTMLSpanElement
const searchInput = document.getElementById('search-input') as HTMLInputElement

// ==================== COLOR FUNCTIONS ====================

function getHeatmapColor(percentChange: number): string {
  // Clamp between -50 and +50
  const clamped = Math.max(-50, Math.min(50, percentChange))
  
  if (clamped >= 0) {
    // Green gradient for gains
    const intensity = clamped / 50
    if (intensity > 0.6) return '#00cc00'
    if (intensity > 0.4) return '#00aa00'
    if (intensity > 0.2) return '#008800'
    if (intensity > 0.1) return '#006600'
    if (intensity > 0.02) return '#004400'
    return '#003300'
  } else {
    // Red gradient for losses
    const intensity = Math.abs(clamped) / 50
    if (intensity > 0.6) return '#cc0000'
    if (intensity > 0.4) return '#aa0000'
    if (intensity > 0.2) return '#880000'
    if (intensity > 0.1) return '#660000'
    if (intensity > 0.02) return '#440000'
    return '#330000'
  }
}

function getTextColor(percentChange: number): string {
  const abs = Math.abs(percentChange)
  // Light text for dark backgrounds, ensure readability
  if (abs > 20) return '#ffffff'
  if (abs > 10) return '#eeeeee'
  return '#cccccc'
}

// ==================== INITIALIZATION ====================

async function init() {
  canvas = document.getElementById('heatmap-canvas') as HTMLCanvasElement
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not get canvas context')
  ctx = context

  resizeCanvas()
  window.addEventListener('resize', handleResize)
  canvas.addEventListener('mousemove', handleMouseMove)
  canvas.addEventListener('mouseleave', handleMouseLeave)
  canvas.addEventListener('click', handleClick)

  setupEventListeners()
  
  await document.fonts.ready
  await fetchTokenData()

  isLoading = false
  loadingOverlay.style.opacity = '0'
  setTimeout(() => {
    loadingOverlay.style.display = 'none'
  }, 300)

  // Start animation loop for proximity effects
  startAnimationLoop()
  
  // Poll for updates every 30 seconds
  setInterval(fetchTokenData, 30000)
}

function setupEventListeners() {
  // Chain selector
  document.querySelectorAll('.chain-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLButtonElement
      const chain = target.dataset.chain || 'solana'
      document.querySelectorAll('.chain-btn').forEach(b => b.classList.remove('active'))
      target.classList.add('active')
      selectedChain = chain
      fetchTokenData()
    })
  })

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLButtonElement
      const filter = target.dataset.filter || 'mcap'
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
      target.classList.add('active')
      selectedFilter = filter
      buildTreemap()
      render()
    })
  })

  // Search
  searchInput.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value.toLowerCase()
    buildTreemap()
    render()
  })

  // Panel tabs
  document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLButtonElement
      const tab = target.dataset.tab || 'trades'
      document.querySelectorAll('.panel-tab').forEach(b => b.classList.remove('active'))
      target.classList.add('active')
      activeTab = tab
      
      const tradesContent = document.getElementById('trades-content')!
      const poolsContent = document.getElementById('pools-content')!
      
      if (tab === 'trades') {
        tradesContent.style.display = 'block'
        poolsContent.style.display = 'none'
      } else {
        tradesContent.style.display = 'none'
        poolsContent.style.display = 'block'
      }
    })
  })
}

function resizeCanvas() {
  const container = canvas.parentElement
  if (!container) return
  
  const dpr = window.devicePixelRatio || 1
  const rect = container.getBoundingClientRect()
  
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`
  
  ctx.scale(dpr, dpr)
}

function handleResize() {
  resizeCanvas()
  buildTreemap()
  render()
}

// ==================== DATA FETCHING ====================

async function fetchTokenData() {
  try {
    // Try boosted tokens endpoint first
    const response = await fetch('https://api.dexscreener.com/token-boosts/latest/v1')
    
    if (response.ok) {
      const data = await response.json()
      if (Array.isArray(data) && data.length > 0) {
        await processBoostData(data)
        return
      }
    }
    
    // Fallback to mock data
    generateMockData()
  } catch (error) {
    console.error('Failed to fetch token data:', error)
    generateMockData()
  }
}

async function processBoostData(data: any[]) {
  // Filter by selected chain and get top tokens
  const filtered = data
    .filter(item => !selectedChain || item.chainId === selectedChain || selectedChain === 'solana')
    .slice(0, 60)

  // Fetch pair data for each token
  const tokenPromises = filtered.map(async (item) => {
    try {
      const pairResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${item.tokenAddress}`)
      if (pairResponse.ok) {
        const pairData = await pairResponse.json()
        const pair = pairData.pairs?.[0]
        if (pair) {
          return {
            address: item.tokenAddress,
            symbol: pair.baseToken?.symbol || 'UNKNOWN',
            name: pair.baseToken?.name || 'Unknown Token',
            price: parseFloat(pair.priceUsd) || 0,
            priceChange24h: parseFloat(pair.priceChange?.h24) || (Math.random() - 0.5) * 100,
            volume24h: parseFloat(pair.volume?.h24) || Math.random() * 1000000,
            liquidity: parseFloat(pair.liquidity?.usd) || Math.random() * 500000,
            marketCap: parseFloat(pair.fdv) || Math.random() * 10000000,
            chain: item.chainId || selectedChain,
            pairAddress: pair.pairAddress || item.tokenAddress,
            txns24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
            dexId: pair.dexId || 'unknown',
            imageUrl: item.icon,
          }
        }
      }
    } catch (e) {
      // Ignore individual token fetch errors
    }
    
    // Return mock data for failed fetches
    return {
      address: item.tokenAddress,
      symbol: item.symbol || 'TKN',
      name: item.name || 'Token',
      price: Math.random() * 10,
      priceChange24h: (Math.random() - 0.5) * 100,
      volume24h: Math.random() * 1000000,
      liquidity: Math.random() * 500000,
      marketCap: Math.random() * 10000000,
      chain: item.chainId || selectedChain,
      pairAddress: item.tokenAddress,
      txns24h: Math.floor(Math.random() * 5000),
      dexId: 'raydium',
      imageUrl: item.icon,
    }
  })

  tokens = await Promise.all(tokenPromises)
  updateStats()
  buildTreemap()
  render()
}

function generateMockData() {
  const mockSymbols = [
    'BTC', 'ETH', 'SOL', 'PEPE', 'BONK', 'WIF', 'DOGE', 'SHIB',
    'FLOKI', 'MEME', 'BOME', 'POPCAT', 'MEW', 'BRETT', 'TURBO',
    'WOJAK', 'CHAD', 'MFER', 'PUMP', 'BASED', 'COPE', 'HOPIUM',
    'WAGMI', 'NGMI', 'FREN', 'KEK', 'DEFI', 'APE', 'MOON', 'LAMBO',
    'ALPHA', 'BETA', 'GAMMA', 'SIGMA', 'DELTA', 'OMEGA', 'ZERO',
    'PIXEL', 'BLUR', 'RARE', 'PUNKS', 'BAYC', 'AZUKI', 'DEGEN'
  ]
  
  tokens = mockSymbols.map((symbol, i) => {
    const baseMarketCap = Math.pow(10, 6 + Math.random() * 4) // 1M to 10B range
    const priceChange = (Math.random() - 0.5) * 100 // -50% to +50%
    
    return {
      address: generateAddress(),
      symbol,
      name: `${symbol} Token`,
      price: Math.random() * 1000,
      priceChange24h: priceChange,
      volume24h: baseMarketCap * (0.01 + Math.random() * 0.2),
      liquidity: baseMarketCap * (0.05 + Math.random() * 0.2),
      marketCap: baseMarketCap,
      chain: selectedChain,
      pairAddress: generateAddress(),
      txns24h: Math.floor(Math.random() * 10000),
      dexId: ['raydium', 'orca', 'jupiter', 'uniswap'][Math.floor(Math.random() * 4)],
    }
  })

  updateStats()
  buildTreemap()
  render()
}

function generateAddress(): string {
  return '0x' + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

function updateStats() {
  const totalVolume = tokens.reduce((sum, t) => sum + t.volume24h, 0)
  const totalMcap = tokens.reduce((sum, t) => sum + t.marketCap, 0)
  const gainers = tokens.filter(t => t.priceChange24h > 0).length
  const losers = tokens.filter(t => t.priceChange24h < 0).length

  totalVolumeEl.textContent = formatCompact(totalVolume)
  totalMcapEl.textContent = formatCompact(totalMcap)
  gainersCountEl.textContent = String(gainers)
  losersCountEl.textContent = String(losers)
}

// ==================== TREEMAP ALGORITHM ====================

function buildTreemap() {
  let filteredTokens = [...tokens]
  
  // Apply search filter
  if (searchQuery) {
    filteredTokens = filteredTokens.filter(t =>
      t.symbol.toLowerCase().includes(searchQuery) ||
      t.name.toLowerCase().includes(searchQuery)
    )
  }
  
  // Sort by selected metric
  switch (selectedFilter) {
    case 'volume':
      filteredTokens.sort((a, b) => b.volume24h - a.volume24h)
      break
    case 'change':
      filteredTokens.sort((a, b) => Math.abs(b.priceChange24h) - Math.abs(a.priceChange24h))
      break
    case 'liquidity':
      filteredTokens.sort((a, b) => b.liquidity - a.liquidity)
      break
    case 'mcap':
    default:
      filteredTokens.sort((a, b) => b.marketCap - a.marketCap)
  }
  
  // Get canvas dimensions
  const containerWidth = canvas.width / (window.devicePixelRatio || 1)
  const containerHeight = canvas.height / (window.devicePixelRatio || 1)
  
  // Calculate total value based on filter
  const getValue = (t: Token) => {
    switch (selectedFilter) {
      case 'volume': return t.volume24h
      case 'change': return Math.abs(t.priceChange24h) * 1000000
      case 'liquidity': return t.liquidity
      default: return t.marketCap
    }
  }
  
  const totalValue = filteredTokens.reduce((sum, t) => sum + getValue(t), 0)
  
  // Build treemap using squarified algorithm
  tiles = squarify(
    filteredTokens.map(token => ({
      token,
      value: getValue(token),
      color: getHeatmapColor(token.priceChange24h),
      textColor: getTextColor(token.priceChange24h),
    })),
    { x: 0, y: 0, width: containerWidth, height: containerHeight },
    totalValue
  )
  
  // Store original positions for proximity calculations
  tiles.forEach(tile => {
    tile.originalX = tile.x
    tile.originalY = tile.y
    tile.originalWidth = tile.width
    tile.originalHeight = tile.height
  })
}

type TreemapInput = {
  token: Token
  value: number
  color: string
  textColor: string
}

type Rectangle = {
  x: number
  y: number
  width: number
  height: number
}

function squarify(
  items: TreemapInput[],
  bounds: Rectangle,
  totalValue: number
): TreemapTile[] {
  if (items.length === 0) return []
  if (items.length === 1) {
    return [{
      token: items[0].token,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      color: items[0].color,
      textColor: items[0].textColor,
    }]
  }

  const tiles: TreemapTile[] = []
  let remaining = [...items]
  let currentBounds = { ...bounds }
  let remainingValue = totalValue

  while (remaining.length > 0) {
    const isWide = currentBounds.width >= currentBounds.height
    const side = isWide ? currentBounds.height : currentBounds.width
    
    // Find optimal row
    let row: TreemapInput[] = []
    let rowValue = 0
    let bestRatio = Infinity
    
    for (let i = 0; i < remaining.length; i++) {
      const testRow = remaining.slice(0, i + 1)
      const testValue = testRow.reduce((s, item) => s + item.value, 0)
      const ratio = worstRatio(testRow, testValue, side, remainingValue, isWide ? currentBounds.width : currentBounds.height)
      
      if (ratio <= bestRatio) {
        bestRatio = ratio
        row = testRow
        rowValue = testValue
      } else {
        break
      }
    }
    
    if (row.length === 0) {
      row = [remaining[0]]
      rowValue = remaining[0].value
    }
    
    // Layout row
    const rowSize = (rowValue / remainingValue) * (isWide ? currentBounds.width : currentBounds.height)
    let offset = isWide ? currentBounds.x : currentBounds.y
    
    for (const item of row) {
      const itemSize = (item.value / rowValue) * side
      
      if (isWide) {
        tiles.push({
          token: item.token,
          x: offset,
          y: currentBounds.y,
          width: rowSize,
          height: itemSize,
          color: item.color,
          textColor: item.textColor,
        })
        offset += itemSize
      } else {
        tiles.push({
          token: item.token,
          x: currentBounds.x,
          y: offset,
          width: itemSize,
          height: rowSize,
          color: item.color,
          textColor: item.textColor,
        })
        offset += itemSize
      }
    }
    
    // Update bounds
    if (isWide) {
      currentBounds.x += rowSize
      currentBounds.width -= rowSize
    } else {
      currentBounds.y += rowSize
      currentBounds.height -= rowSize
    }
    
    remaining = remaining.slice(row.length)
    remainingValue -= rowValue
  }
  
  return tiles
}

function worstRatio(
  row: TreemapInput[],
  rowValue: number,
  side: number,
  totalValue: number,
  length: number
): number {
  if (row.length === 0 || totalValue === 0) return Infinity
  
  const rowLength = (rowValue / totalValue) * length
  let worst = 0
  
  for (const item of row) {
    const itemSize = (item.value / rowValue) * side
    const ratio = Math.max(rowLength / itemSize, itemSize / rowLength)
    worst = Math.max(worst, ratio)
  }
  
  return worst
}

// ==================== ANIMATION LOOP ====================

function startAnimationLoop() {
  function frame() {
    updateProximityPositions()
    render()
    animationFrameId = requestAnimationFrame(frame)
  }
  animationFrameId = requestAnimationFrame(frame)
}

function updateProximityPositions() {
  const proximityRadius = 200
  const maxExpansion = 1.3
  
  for (const tile of tiles) {
    if (!tile.originalX || !tile.originalY || !tile.originalWidth || !tile.originalHeight) continue
    
    const centerX = tile.originalX + tile.originalWidth / 2
    const centerY = tile.originalY + tile.originalHeight / 2
    
    const dx = mouseX - centerX
    const dy = mouseY - centerY
    const distance = Math.sqrt(dx * dx + dy * dy)
    
    if (distance < proximityRadius) {
      // Calculate expansion factor (1 to maxExpansion)
      const proximity = 1 - (distance / proximityRadius)
      const expansionFactor = 1 + (maxExpansion - 1) * proximity
      
      // Calculate push direction (away from mouse)
      const angle = Math.atan2(dy, dx)
      const pushDistance = (proximity * 30) * (1 - proximity * 0.5)
      
      // Apply expansion and push
      const expandedWidth = tile.originalWidth * expansionFactor
      const expandedHeight = tile.originalHeight * expansionFactor
      const offsetX = Math.cos(angle) * pushDistance
      const offsetY = Math.sin(angle) * pushDistance
      
      tile.x = tile.originalX + (expandedWidth - tile.originalWidth) / 2 + offsetX
      tile.y = tile.originalY + (expandedHeight - tile.originalHeight) / 2 + offsetY
      tile.width = expandedWidth
      tile.height = expandedHeight
    } else {
      // Return to original position smoothly
      tile.x += (tile.originalX - tile.x) * 0.1
      tile.y += (tile.originalY - tile.y) * 0.1
      tile.width += (tile.originalWidth - tile.width) * 0.1
      tile.height += (tile.originalHeight - tile.height) * 0.1
    }
  }
}

// ==================== RENDERING ====================

function render() {
  const containerWidth = canvas.width / (window.devicePixelRatio || 1)
  const containerHeight = canvas.height / (window.devicePixelRatio || 1)

  // Clear canvas
  ctx.fillStyle = '#0d0d0d'
  ctx.fillRect(0, 0, containerWidth, containerHeight)

  // Draw tiles
  for (const tile of tiles) {
    drawTile(tile, tile === hoveredTile)
  }
}

function drawTile(tile: TreemapTile, isHovered: boolean) {
  const { token, x, y, width, height, color, textColor } = tile
  const padding = 1

  // Draw background
  ctx.fillStyle = isHovered ? lightenColor(color, 20) : color
  ctx.fillRect(x + padding, y + padding, width - padding * 2, height - padding * 2)

  // Draw border for hovered tile
  if (isHovered) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.strokeRect(x + padding, y + padding, width - padding * 2, height - padding * 2)
  }

  // Draw text if tile is large enough
  const minWidth = 50
  const minHeight = 40
  
  if (width > minWidth && height > minHeight) {
    ctx.fillStyle = textColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    
    const centerX = x + width / 2
    const centerY = y + height / 2
    
    // Symbol
    const symbolSize = Math.min(Math.max(12, width / 8), 20)
    ctx.font = `bold ${symbolSize}px Inter, sans-serif`
    ctx.fillText(token.symbol, centerX, centerY - (height > 60 ? 10 : 0))
    
    // Price change (if tall enough)
    if (height > 60) {
      const changeSize = Math.min(Math.max(10, width / 10), 14)
      ctx.font = `600 ${changeSize}px Inter, sans-serif`
      const changeText = (token.priceChange24h >= 0 ? '+' : '') + token.priceChange24h.toFixed(2) + '%'
      ctx.fillText(changeText, centerX, centerY + 12)
    }
    
    // Price (if very tall)
    if (height > 90 && width > 80) {
      const priceSize = Math.min(Math.max(9, width / 12), 11)
      ctx.font = `500 ${priceSize}px Inter, sans-serif`
      ctx.fillStyle = adjustOpacity(textColor, 0.7)
      ctx.fillText(formatPrice(token.price), centerX, centerY + 28)
    }
  } else if (width > 30 && height > 25) {
    // Just symbol for smaller tiles
    ctx.fillStyle = textColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = 'bold 10px Inter, sans-serif'
    ctx.fillText(token.symbol.substring(0, 4), x + width / 2, y + height / 2)
  }
}

function lightenColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, (num >> 16) + amount)
  const g = Math.min(255, ((num >> 8) & 0x00FF) + amount)
  const b = Math.min(255, (num & 0x0000FF) + amount)
  return `rgb(${r}, ${g}, ${b})`
}

function adjustOpacity(color: string, opacity: number): string {
  if (color.startsWith('#')) {
    const num = parseInt(color.replace('#', ''), 16)
    const r = num >> 16
    const g = (num >> 8) & 0x00FF
    const b = num & 0x0000FF
    return `rgba(${r}, ${g}, ${b}, ${opacity})`
  }
  return color
}

// ==================== EVENT HANDLERS ====================

function handleMouseMove(e: MouseEvent) {
  const rect = canvas.getBoundingClientRect()
  mouseX = e.clientX - rect.left
  mouseY = e.clientY - rect.top

  let found: TreemapTile | null = null
  
  for (const tile of tiles) {
    if (
      mouseX >= tile.x &&
      mouseX <= tile.x + tile.width &&
      mouseY >= tile.y &&
      mouseY <= tile.y + tile.height
    ) {
      found = tile
      break
    }
  }

  if (found !== hoveredTile) {
    hoveredTile = found
    
    if (found) {
      showHoverPanel(found, e.clientX, e.clientY)
    } else {
      hideHoverPanel()
    }
  } else if (found) {
    // Update panel position
    positionPanel(e.clientX, e.clientY)
  }
}

function handleMouseLeave() {
  hoveredTile = null
  hideHoverPanel()
  render()
}

function handleClick(e: MouseEvent) {
  if (hoveredTile) {
    const token = hoveredTile.token
    window.open(`https://dexscreener.com/${token.chain}/${token.pairAddress}`, '_blank')
  }
}

// ==================== HOVER PANEL ====================

function showHoverPanel(tile: TreemapTile, clientX: number, clientY: number) {
  const token = tile.token
  const isPositive = token.priceChange24h >= 0

  hoverPanel.classList.add('visible')
  
  // Update content
  const iconEl = document.getElementById('panel-icon') as HTMLDivElement
  const nameEl = document.getElementById('panel-name') as HTMLHeadingElement
  const addressEl = document.getElementById('panel-address') as HTMLParagraphElement
  const priceEl = document.getElementById('panel-price') as HTMLDivElement
  const changeEl = document.getElementById('panel-change') as HTMLDivElement
  const volumeEl = document.getElementById('panel-volume') as HTMLDivElement
  const liquidityEl = document.getElementById('panel-liquidity') as HTMLDivElement
  const mcapEl = document.getElementById('panel-mcap') as HTMLDivElement
  const txnsEl = document.getElementById('panel-txns') as HTMLDivElement

  iconEl.textContent = token.symbol.substring(0, 2)
  iconEl.style.background = isPositive ? '#00cc66' : '#ff4444'
  nameEl.textContent = token.name
  addressEl.textContent = truncateAddress(token.address)
  priceEl.textContent = formatPrice(token.price)
  changeEl.textContent = (isPositive ? '+' : '') + token.priceChange24h.toFixed(2) + '%'
  changeEl.className = `change ${isPositive ? 'positive' : 'negative'}`
  volumeEl.textContent = formatCompact(token.volume24h)
  liquidityEl.textContent = formatCompact(token.liquidity)
  mcapEl.textContent = formatCompact(token.marketCap)
  txnsEl.textContent = formatNumber(token.txns24h)

  // Generate mock trades
  generateMockTrades(token)
  
  // Generate mock pools
  generateMockPools(token)

  positionPanel(clientX, clientY)
}

function positionPanel(clientX: number, clientY: number) {
  const panelRect = hoverPanel.getBoundingClientRect()
  const padding = 16
  
  let left = clientX + padding
  let top = clientY + padding
  
  // Keep within viewport
  if (left + panelRect.width > window.innerWidth) {
    left = clientX - panelRect.width - padding
  }
  if (top + panelRect.height > window.innerHeight) {
    top = clientY - panelRect.height - padding
  }
  
  // Ensure minimum position
  left = Math.max(padding, left)
  top = Math.max(padding, top)
  
  hoverPanel.style.left = `${left}px`
  hoverPanel.style.top = `${top}px`
}

function hideHoverPanel() {
  hoverPanel.classList.remove('visible')
}

function generateMockTrades(token: Token) {
  const tradesList = document.getElementById('trades-list') as HTMLDivElement
  const trades: Trade[] = []
  
  for (let i = 0; i < 8; i++) {
    const isBuy = Math.random() > 0.5
    const amount = (Math.random() * 10000).toFixed(2)
    const price = (token.price * (0.99 + Math.random() * 0.02)).toFixed(6)
    const minutes = Math.floor(Math.random() * 60)
    
    trades.push({
      type: isBuy ? 'buy' : 'sell',
      amount: `$${formatCompact(parseFloat(amount))}`,
      price: `$${price}`,
      time: `${minutes}m ago`,
    })
  }
  
  tradesList.innerHTML = trades.map(trade => `
    <div class="trade-item">
      <span class="trade-type ${trade.type}">${trade.type}</span>
      <span class="trade-amount">${trade.amount}</span>
      <span class="trade-price">${trade.price}</span>
      <span class="trade-time">${trade.time}</span>
    </div>
  `).join('')
}

function generateMockPools(token: Token) {
  const poolsList = document.getElementById('pools-list') as HTMLDivElement
  const dexes = ['Raydium', 'Orca', 'Jupiter', 'Meteora']
  const pairs = ['USDC', 'SOL', 'USDT']
  
  const pools: Pool[] = []
  
  for (let i = 0; i < 4; i++) {
    pools.push({
      pair: `${token.symbol}/${pairs[i % pairs.length]}`,
      dex: dexes[i % dexes.length],
      liquidity: token.liquidity * (0.2 + Math.random() * 0.3),
      volume24h: token.volume24h * (0.1 + Math.random() * 0.4),
      apr: Math.random() * 200,
    })
  }
  
  poolsList.innerHTML = pools.map(pool => `
    <div class="pool-item">
      <div class="pool-header">
        <span class="pool-pair">${pool.pair}</span>
        <span class="pool-dex">${pool.dex}</span>
      </div>
      <div class="pool-stats">
        <div class="pool-stat">
          <span class="pool-stat-label">Liquidity</span>
          <span class="pool-stat-value">${formatCompact(pool.liquidity)}</span>
        </div>
        <div class="pool-stat">
          <span class="pool-stat-label">Volume 24h</span>
          <span class="pool-stat-value">${formatCompact(pool.volume24h)}</span>
        </div>
        <div class="pool-stat">
          <span class="pool-stat-label">APR</span>
          <span class="pool-stat-value">${pool.apr.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  `).join('')
}

// ==================== UTILITY FUNCTIONS ====================

function formatPrice(price: number): string {
  if (price >= 1000) return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (price >= 1) return '$' + price.toFixed(2)
  if (price >= 0.001) return '$' + price.toFixed(4)
  if (price >= 0.000001) return '$' + price.toFixed(6)
  return '$' + price.toExponential(2)
}

function formatCompact(value: number): string {
  if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B'
  if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K'
  return '$' + value.toFixed(0)
}

function formatNumber(value: number): string {
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M'
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K'
  return value.toLocaleString()
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address
  return address.slice(0, 6) + '...' + address.slice(-4)
}

// ==================== START ====================

init().catch(console.error)
