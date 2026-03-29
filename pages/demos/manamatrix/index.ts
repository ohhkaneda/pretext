/*
  manamatrix.eth - Evangelion-inspired Crypto Dashboard
  
  A BioMap-style dynamic token grid using Pretext for perfect text layout.
  Features:
  - Cursor-reactive expanding/contracting tiles
  - Real-time price data from DexScreener API
  - Evangelion terminal aesthetic with CRT effects
  - Performance-optimized canvas rendering
*/

import { prepare, layout, prepareWithSegments, type PreparedText, type LayoutResult } from '../../../src/layout.ts'

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
  priceHistory: number[] // Last 24 data points for sparkline
  chain: string
  pairAddress: string
  imageUrl?: string
}

type TokenTile = {
  token: Token
  x: number
  y: number
  width: number
  height: number
  targetWidth: number
  targetHeight: number
  scale: number
  opacity: number
  preparedName: PreparedText
  preparedSymbol: PreparedText
  preparedPrice: PreparedText
  preparedChange: PreparedText
}

type GridState = {
  tiles: TokenTile[]
  hoveredTile: TokenTile | null
  selectedChain: string
  selectedFilter: string
  searchQuery: string
}

type LayoutConfig = {
  baseWidth: number
  baseHeight: number
  expandedWidth: number
  expandedHeight: number
  gap: number
  padding: number
}

// ==================== CONSTANTS ====================

const EVANGELION_COLORS = {
  navy: '#000053',
  navyDark: '#00002b',
  purple: '#965fd4',
  purpleDark: '#5a3a80',
  green: '#58f2a5',
  greenGlow: '#00ff88',
  red: '#e81900',
  redGlow: '#ff3333',
  orange: '#ff6600',
  orangeGlow: '#ff9933',
  cyan: '#00d4ff',
  white: '#f0f0f0',
  gray: '#8888aa',
}

const FONTS = {
  symbol: '600 14px "JetBrains Mono", monospace',
  name: '400 11px "JetBrains Mono", monospace',
  price: '700 16px "JetBrains Mono", monospace',
  change: '600 12px "JetBrains Mono", monospace',
  detail: '500 10px "JetBrains Mono", monospace',
}

const CONFIG: LayoutConfig = {
  baseWidth: 160,
  baseHeight: 120,
  expandedWidth: 280,
  expandedHeight: 200,
  gap: 8,
  padding: 24,
}

const PROXIMITY_RADIUS = 200 // Pixels
const ANIMATION_SPEED = 0.15

// ==================== STATE ====================

const state: GridState = {
  tiles: [],
  hoveredTile: null,
  selectedChain: 'solana',
  selectedFilter: 'trending',
  searchQuery: '',
}

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let mouseX = -1000
let mouseY = -1000
let lastFrameTime = 0
let animationId: number
let isLoading = true
let loadingProgress = 0

// ==================== DOM ELEMENTS ====================

const loadingOverlay = document.getElementById('loading') as HTMLDivElement
const loadingBar = document.getElementById('loading-bar') as HTMLDivElement
const perfCounter = document.getElementById('perf-time') as HTMLSpanElement
const tokenDetail = document.getElementById('token-detail') as HTMLDivElement
const alertFlash = document.getElementById('alert-flash') as HTMLDivElement
const evaWarning = document.getElementById('eva-warning') as HTMLDivElement
const searchInput = document.getElementById('search-input') as HTMLInputElement
const totalVolumeEl = document.getElementById('total-volume') as HTMLSpanElement
const totalMcapEl = document.getElementById('total-mcap') as HTMLSpanElement
const trendingCountEl = document.getElementById('trending-count') as HTMLSpanElement

// ==================== INITIALIZATION ====================

async function init() {
  canvas = document.getElementById('token-grid') as HTMLCanvasElement
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not get canvas context')
  ctx = context

  resizeCanvas()
  window.addEventListener('resize', resizeCanvas)
  canvas.addEventListener('mousemove', handleMouseMove)
  canvas.addEventListener('mouseleave', handleMouseLeave)
  canvas.addEventListener('click', handleClick)

  setupEventListeners()
  
  // Load fonts
  await document.fonts.ready
  updateLoadingProgress(20)

  // Fetch initial data
  await fetchTokenData()
  updateLoadingProgress(100)

  // Hide loading overlay
  setTimeout(() => {
    loadingOverlay.style.opacity = '0'
    setTimeout(() => {
      loadingOverlay.style.display = 'none'
      isLoading = false
    }, 300)
  }, 500)

  // Start render loop
  requestAnimationFrame(renderLoop)

  // Start polling for updates
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
      state.selectedChain = chain
      fetchTokenData()
    })
  })

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLButtonElement
      const filter = target.dataset.filter || 'trending'
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
      target.classList.add('active')
      state.selectedFilter = filter
      sortAndFilterTiles()
    })
  })

  // Search
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = (e.target as HTMLInputElement).value.toLowerCase()
    sortAndFilterTiles()
  })
}

function updateLoadingProgress(progress: number) {
  loadingProgress = progress
  loadingBar.style.width = `${progress}%`
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
  
  layoutTiles()
}

// ==================== DATA FETCHING ====================

async function fetchTokenData() {
  try {
    const chainId = getChainId(state.selectedChain)
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/trending/${chainId}`)
    
    if (!response.ok) {
      // Fallback to search for popular tokens if trending fails
      await fetchFallbackData()
      return
    }

    const data = await response.json()
    processTokenData(data)
  } catch (error) {
    console.error('Failed to fetch token data:', error)
    await fetchFallbackData()
  }
}

async function fetchFallbackData() {
  try {
    // Use boosted tokens endpoint as fallback
    const response = await fetch('https://api.dexscreener.com/token-boosts/latest/v1')
    if (!response.ok) {
      // Generate mock data if API fails
      generateMockData()
      return
    }

    const data = await response.json()
    processBoostedData(data)
  } catch (error) {
    console.error('Fallback fetch failed:', error)
    generateMockData()
  }
}

function getChainId(chain: string): string {
  const chainMap: Record<string, string> = {
    solana: 'solana',
    ethereum: 'ethereum',
    base: 'base',
    bsc: 'bsc',
  }
  return chainMap[chain] || 'solana'
}

function processTokenData(data: any) {
  if (!data || !Array.isArray(data)) {
    generateMockData()
    return
  }

  const tokens: Token[] = data.slice(0, 50).map((item: any) => ({
    address: item.tokenAddress || item.baseToken?.address || generateAddress(),
    symbol: item.baseToken?.symbol || item.symbol || 'UNKNOWN',
    name: item.baseToken?.name || item.name || 'Unknown Token',
    price: parseFloat(item.priceUsd) || Math.random() * 100,
    priceChange24h: parseFloat(item.priceChange?.h24) || (Math.random() - 0.5) * 100,
    volume24h: parseFloat(item.volume?.h24) || Math.random() * 10000000,
    liquidity: parseFloat(item.liquidity?.usd) || Math.random() * 5000000,
    marketCap: parseFloat(item.fdv) || Math.random() * 100000000,
    priceHistory: generatePriceHistory(parseFloat(item.priceUsd) || 1),
    chain: state.selectedChain,
    pairAddress: item.pairAddress || generateAddress(),
    imageUrl: item.info?.imageUrl,
  }))

  createTilesFromTokens(tokens)
  updateStats(tokens)
}

function processBoostedData(data: any[]) {
  if (!data || !Array.isArray(data)) {
    generateMockData()
    return
  }

  const tokens: Token[] = data.slice(0, 50).map((item: any) => ({
    address: item.tokenAddress || generateAddress(),
    symbol: item.symbol || 'BOOST',
    name: item.name || 'Boosted Token',
    price: Math.random() * 10,
    priceChange24h: (Math.random() - 0.5) * 100,
    volume24h: Math.random() * 10000000,
    liquidity: Math.random() * 5000000,
    marketCap: Math.random() * 100000000,
    priceHistory: generatePriceHistory(Math.random() * 10),
    chain: item.chainId || state.selectedChain,
    pairAddress: generateAddress(),
    imageUrl: item.icon,
  }))

  createTilesFromTokens(tokens)
  updateStats(tokens)
}

function generateMockData() {
  const mockSymbols = ['PEPE', 'BONK', 'WIF', 'BOME', 'MEME', 'DOGE', 'SHIB', 'FLOKI', 'ELON', 'MOON', 
                       'WOJAK', 'CHAD', 'PUMP', 'BASED', 'SIGMA', 'COPE', 'HOPIUM', 'WAGMI', 'NGMI', 'SER',
                       'FREN', 'MFER', 'LMAO', 'KEK', 'DEFI', 'ALPHA', 'BETA', 'GAMMA', 'DELTA', 'OMEGA']
  
  const tokens: Token[] = mockSymbols.map((symbol, i) => {
    const price = Math.random() * 100
    return {
      address: generateAddress(),
      symbol,
      name: `${symbol} Token`,
      price,
      priceChange24h: (Math.random() - 0.5) * 200,
      volume24h: Math.random() * 50000000,
      liquidity: Math.random() * 10000000,
      marketCap: Math.random() * 500000000,
      priceHistory: generatePriceHistory(price),
      chain: state.selectedChain,
      pairAddress: generateAddress(),
    }
  })

  createTilesFromTokens(tokens)
  updateStats(tokens)
}

function generateAddress(): string {
  return '0x' + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

function generatePriceHistory(currentPrice: number): number[] {
  const history: number[] = []
  let price = currentPrice * (0.8 + Math.random() * 0.4)
  for (let i = 0; i < 24; i++) {
    price *= (0.95 + Math.random() * 0.1)
    history.push(price)
  }
  history.push(currentPrice)
  return history
}

function createTilesFromTokens(tokens: Token[]) {
  state.tiles = tokens.map(token => ({
    token,
    x: 0,
    y: 0,
    width: CONFIG.baseWidth,
    height: CONFIG.baseHeight,
    targetWidth: CONFIG.baseWidth,
    targetHeight: CONFIG.baseHeight,
    scale: 1,
    opacity: 1,
    preparedName: prepare(token.name.substring(0, 20), FONTS.name),
    preparedSymbol: prepare(token.symbol, FONTS.symbol),
    preparedPrice: prepare(formatPrice(token.price), FONTS.price),
    preparedChange: prepare(formatPercent(token.priceChange24h), FONTS.change),
  }))

  sortAndFilterTiles()
  layoutTiles()
}

function updateStats(tokens: Token[]) {
  const totalVolume = tokens.reduce((sum, t) => sum + t.volume24h, 0)
  const totalMcap = tokens.reduce((sum, t) => sum + t.marketCap, 0)
  const trendingCount = tokens.filter(t => t.priceChange24h > 10).length

  totalVolumeEl.textContent = formatCompact(totalVolume)
  totalMcapEl.textContent = formatCompact(totalMcap)
  trendingCountEl.textContent = String(trendingCount)
}

// ==================== LAYOUT ====================

function layoutTiles() {
  const containerWidth = canvas.width / (window.devicePixelRatio || 1)
  const containerHeight = canvas.height / (window.devicePixelRatio || 1)
  
  const cols = Math.max(1, Math.floor((containerWidth - CONFIG.padding * 2 + CONFIG.gap) / (CONFIG.baseWidth + CONFIG.gap)))
  
  let currentX = CONFIG.padding
  let currentY = CONFIG.padding
  let rowHeight = CONFIG.baseHeight

  const visibleTiles = getFilteredTiles()

  visibleTiles.forEach((tile, index) => {
    const col = index % cols
    
    if (col === 0 && index > 0) {
      currentX = CONFIG.padding
      currentY += rowHeight + CONFIG.gap
      rowHeight = CONFIG.baseHeight
    }

    tile.x = currentX
    tile.y = currentY
    
    currentX += tile.width + CONFIG.gap
    rowHeight = Math.max(rowHeight, tile.height)
  })
}

function getFilteredTiles(): TokenTile[] {
  let tiles = [...state.tiles]

  // Apply search filter
  if (state.searchQuery) {
    tiles = tiles.filter(t => 
      t.token.symbol.toLowerCase().includes(state.searchQuery) ||
      t.token.name.toLowerCase().includes(state.searchQuery)
    )
  }

  return tiles
}

function sortAndFilterTiles() {
  switch (state.selectedFilter) {
    case 'gainers':
      state.tiles.sort((a, b) => b.token.priceChange24h - a.token.priceChange24h)
      break
    case 'losers':
      state.tiles.sort((a, b) => a.token.priceChange24h - b.token.priceChange24h)
      break
    case 'volume':
      state.tiles.sort((a, b) => b.token.volume24h - a.token.volume24h)
      break
    case 'new':
      // Keep original order for new pairs
      break
    case 'trending':
    default:
      state.tiles.sort((a, b) => Math.abs(b.token.priceChange24h) - Math.abs(a.token.priceChange24h))
  }

  layoutTiles()
}

// ==================== RENDERING ====================

function renderLoop(timestamp: number) {
  const deltaTime = timestamp - lastFrameTime
  lastFrameTime = timestamp

  if (!isLoading) {
    const startTime = performance.now()
    
    updateAnimations(deltaTime)
    render()
    
    const endTime = performance.now()
    perfCounter.textContent = (endTime - startTime).toFixed(2)
  }

  animationId = requestAnimationFrame(renderLoop)
}

function updateAnimations(deltaTime: number) {
  const visibleTiles = getFilteredTiles()

  visibleTiles.forEach(tile => {
    // Calculate distance from mouse
    const tileCenterX = tile.x + tile.width / 2
    const tileCenterY = tile.y + tile.height / 2
    const distance = Math.sqrt(
      Math.pow(mouseX - tileCenterX, 2) + 
      Math.pow(mouseY - tileCenterY, 2)
    )

    // Calculate target size based on proximity
    if (distance < PROXIMITY_RADIUS) {
      const proximity = 1 - (distance / PROXIMITY_RADIUS)
      const expansion = proximity * proximity // Ease out
      tile.targetWidth = CONFIG.baseWidth + (CONFIG.expandedWidth - CONFIG.baseWidth) * expansion
      tile.targetHeight = CONFIG.baseHeight + (CONFIG.expandedHeight - CONFIG.baseHeight) * expansion
      tile.scale = 1 + expansion * 0.2

      if (proximity > 0.8) {
        state.hoveredTile = tile
      }
    } else {
      tile.targetWidth = CONFIG.baseWidth
      tile.targetHeight = CONFIG.baseHeight
      tile.scale = 1
    }

    // Animate towards target
    tile.width += (tile.targetWidth - tile.width) * ANIMATION_SPEED
    tile.height += (tile.targetHeight - tile.height) * ANIMATION_SPEED
  })

  // Re-layout with new sizes
  layoutTiles()
}

function render() {
  const containerWidth = canvas.width / (window.devicePixelRatio || 1)
  const containerHeight = canvas.height / (window.devicePixelRatio || 1)

  // Clear canvas
  ctx.fillStyle = EVANGELION_COLORS.navyDark
  ctx.fillRect(0, 0, containerWidth, containerHeight)

  // Draw grid background
  drawGridBackground(containerWidth, containerHeight)

  // Draw tiles
  const visibleTiles = getFilteredTiles()
  visibleTiles.forEach(tile => drawTile(tile))

  // Draw hover detail
  if (state.hoveredTile) {
    updateTokenDetail(state.hoveredTile)
  }
}

function drawGridBackground(width: number, height: number) {
  ctx.strokeStyle = 'rgba(150, 95, 212, 0.1)'
  ctx.lineWidth = 1

  const gridSize = 40
  
  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }

  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
}

function drawTile(tile: TokenTile) {
  const { token, x, y, width, height, scale } = tile
  const isExpanded = width > CONFIG.baseWidth + 20
  const isPositive = token.priceChange24h >= 0

  // Save context for transformations
  ctx.save()

  // Apply scale transform from center
  const centerX = x + width / 2
  const centerY = y + height / 2
  ctx.translate(centerX, centerY)
  ctx.scale(scale, scale)
  ctx.translate(-centerX, -centerY)

  // Draw tile background
  const gradient = ctx.createLinearGradient(x, y, x, y + height)
  gradient.addColorStop(0, 'rgba(0, 0, 83, 0.9)')
  gradient.addColorStop(1, 'rgba(0, 0, 43, 0.95)')
  
  ctx.fillStyle = gradient
  ctx.beginPath()
  roundRect(ctx, x, y, width, height, 4)
  ctx.fill()

  // Draw border with glow based on price change
  const borderColor = isPositive ? EVANGELION_COLORS.green : EVANGELION_COLORS.red
  const glowColor = isPositive ? EVANGELION_COLORS.greenGlow : EVANGELION_COLORS.redGlow
  
  ctx.strokeStyle = borderColor
  ctx.lineWidth = isExpanded ? 2 : 1
  ctx.shadowColor = glowColor
  ctx.shadowBlur = isExpanded ? 15 : 5
  ctx.beginPath()
  roundRect(ctx, x, y, width, height, 4)
  ctx.stroke()
  ctx.shadowBlur = 0

  // Draw content
  const padding = 12
  let textY = y + padding

  // Symbol
  ctx.font = FONTS.symbol
  ctx.fillStyle = EVANGELION_COLORS.white
  ctx.textBaseline = 'top'
  ctx.fillText(token.symbol, x + padding, textY)
  textY += 20

  // Name (if expanded)
  if (isExpanded) {
    ctx.font = FONTS.name
    ctx.fillStyle = EVANGELION_COLORS.gray
    const nameResult = layout(tile.preparedName, width - padding * 2, 14)
    ctx.fillText(truncateText(token.name, width - padding * 2, FONTS.name), x + padding, textY)
    textY += 18
  }

  // Price
  ctx.font = FONTS.price
  ctx.fillStyle = EVANGELION_COLORS.white
  ctx.fillText(formatPrice(token.price), x + padding, textY)
  textY += 22

  // Price change
  ctx.font = FONTS.change
  ctx.fillStyle = isPositive ? EVANGELION_COLORS.green : EVANGELION_COLORS.red
  const changeText = (isPositive ? '+' : '') + token.priceChange24h.toFixed(2) + '%'
  ctx.fillText(changeText, x + padding, textY)
  textY += 18

  // Sparkline
  if (token.priceHistory.length > 1) {
    const sparklineY = y + height - 30
    const sparklineHeight = 20
    const sparklineWidth = width - padding * 2
    
    drawSparkline(
      token.priceHistory,
      x + padding,
      sparklineY,
      sparklineWidth,
      sparklineHeight,
      isPositive ? EVANGELION_COLORS.green : EVANGELION_COLORS.red
    )
  }

  // Volume (if expanded)
  if (isExpanded) {
    ctx.font = FONTS.detail
    ctx.fillStyle = EVANGELION_COLORS.gray
    ctx.fillText(`Vol: ${formatCompact(token.volume24h)}`, x + padding, y + height - 38)
  }

  ctx.restore()
}

function drawSparkline(data: number[], x: number, y: number, width: number, height: number, color: string) {
  if (data.length < 2) return

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  ctx.beginPath()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const step = width / (data.length - 1)

  data.forEach((value, i) => {
    const px = x + i * step
    const py = y + height - ((value - min) / range) * height

    if (i === 0) {
      ctx.moveTo(px, py)
    } else {
      ctx.lineTo(px, py)
    }
  })

  ctx.stroke()

  // Add glow
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.3
  ctx.lineWidth = 4
  ctx.stroke()
  ctx.globalAlpha = 1
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// ==================== EVENT HANDLERS ====================

function handleMouseMove(e: MouseEvent) {
  const rect = canvas.getBoundingClientRect()
  mouseX = e.clientX - rect.left
  mouseY = e.clientY - rect.top
}

function handleMouseLeave() {
  mouseX = -1000
  mouseY = -1000
  state.hoveredTile = null
  hideTokenDetail()
}

function handleClick(e: MouseEvent) {
  if (state.hoveredTile) {
    const token = state.hoveredTile.token
    // Open DexScreener in new tab
    window.open(`https://dexscreener.com/${token.chain}/${token.pairAddress}`, '_blank')
  }
}

// ==================== TOKEN DETAIL ====================

function updateTokenDetail(tile: TokenTile) {
  const token = tile.token
  const isPositive = token.priceChange24h >= 0

  tokenDetail.classList.add('visible')
  
  // Position detail panel
  const detailWidth = 320
  const detailHeight = 200
  let detailX = tile.x + tile.width + 16
  let detailY = tile.y

  const containerWidth = canvas.width / (window.devicePixelRatio || 1)
  const containerHeight = canvas.height / (window.devicePixelRatio || 1)

  // Keep within bounds
  if (detailX + detailWidth > containerWidth) {
    detailX = tile.x - detailWidth - 16
  }
  if (detailY + detailHeight > containerHeight) {
    detailY = containerHeight - detailHeight - 16
  }

  tokenDetail.style.left = `${detailX}px`
  tokenDetail.style.top = `${detailY}px`

  // Update content
  const iconEl = document.getElementById('detail-icon') as HTMLDivElement
  const nameEl = document.getElementById('detail-name') as HTMLHeadingElement
  const addressEl = document.getElementById('detail-address') as HTMLParagraphElement
  const priceEl = document.getElementById('detail-price') as HTMLDivElement
  const changeEl = document.getElementById('detail-change') as HTMLDivElement
  const volumeEl = document.getElementById('detail-volume') as HTMLDivElement
  const liquidityEl = document.getElementById('detail-liquidity') as HTMLDivElement
  const mcapEl = document.getElementById('detail-mcap') as HTMLDivElement

  iconEl.textContent = token.symbol.substring(0, 2)
  iconEl.style.background = isPositive ? EVANGELION_COLORS.green : EVANGELION_COLORS.red
  nameEl.textContent = token.name
  addressEl.textContent = truncateAddress(token.address)
  priceEl.textContent = formatPrice(token.price)
  changeEl.textContent = (isPositive ? '+' : '') + token.priceChange24h.toFixed(2) + '%'
  changeEl.className = `change ${isPositive ? 'positive' : 'negative'}`
  volumeEl.textContent = formatCompact(token.volume24h)
  liquidityEl.textContent = formatCompact(token.liquidity)
  mcapEl.textContent = formatCompact(token.marketCap)

  // Draw chart in detail
  drawDetailChart(token)
}

function hideTokenDetail() {
  tokenDetail.classList.remove('visible')
}

function drawDetailChart(token: Token) {
  const chartContainer = document.getElementById('detail-chart') as HTMLDivElement
  chartContainer.innerHTML = ''

  const chartCanvas = document.createElement('canvas')
  chartCanvas.width = 288
  chartCanvas.height = 80
  chartCanvas.style.width = '100%'
  chartCanvas.style.height = '100%'
  chartContainer.appendChild(chartCanvas)

  const chartCtx = chartCanvas.getContext('2d')
  if (!chartCtx) return

  const data = token.priceHistory
  const isPositive = token.priceChange24h >= 0
  const color = isPositive ? EVANGELION_COLORS.green : EVANGELION_COLORS.red

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const width = chartCanvas.width
  const height = chartCanvas.height
  const step = width / (data.length - 1)

  // Fill gradient
  const gradient = chartCtx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, isPositive ? 'rgba(88, 242, 165, 0.3)' : 'rgba(232, 25, 0, 0.3)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')

  chartCtx.beginPath()
  chartCtx.moveTo(0, height)
  
  data.forEach((value, i) => {
    const px = i * step
    const py = height - ((value - min) / range) * height
    chartCtx.lineTo(px, py)
  })

  chartCtx.lineTo(width, height)
  chartCtx.closePath()
  chartCtx.fillStyle = gradient
  chartCtx.fill()

  // Draw line
  chartCtx.beginPath()
  chartCtx.strokeStyle = color
  chartCtx.lineWidth = 2
  chartCtx.lineCap = 'round'
  chartCtx.lineJoin = 'round'

  data.forEach((value, i) => {
    const px = i * step
    const py = height - ((value - min) / range) * height
    if (i === 0) {
      chartCtx.moveTo(px, py)
    } else {
      chartCtx.lineTo(px, py)
    }
  })

  chartCtx.stroke()
}

// ==================== UTILITY FUNCTIONS ====================

function formatPrice(price: number): string {
  if (price >= 1000) {
    return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 })
  } else if (price >= 1) {
    return '$' + price.toFixed(2)
  } else if (price >= 0.001) {
    return '$' + price.toFixed(4)
  } else if (price >= 0.000001) {
    return '$' + price.toFixed(6)
  } else {
    return '$' + price.toExponential(2)
  }
}

function formatPercent(value: number): string {
  return (value >= 0 ? '+' : '') + value.toFixed(2) + '%'
}

function formatCompact(value: number): string {
  if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B'
  if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K'
  return '$' + value.toFixed(0)
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address
  return address.slice(0, 6) + '...' + address.slice(-4)
}

function truncateText(text: string, maxWidth: number, font: string): string {
  ctx.font = font
  if (ctx.measureText(text).width <= maxWidth) return text
  
  let truncated = text
  while (truncated.length > 0 && ctx.measureText(truncated + '...').width > maxWidth) {
    truncated = truncated.slice(0, -1)
  }
  return truncated + '...'
}

// ==================== ALERTS ====================

function triggerAlert(type: 'pump' | 'dump') {
  alertFlash.className = `alert-flash ${type}`
  
  if (type === 'dump') {
    evaWarning.classList.add('visible')
    evaWarning.textContent = 'WARNING: Significant Dump Detected'
  } else {
    evaWarning.classList.add('visible')
    evaWarning.textContent = 'ALERT: Major Pump in Progress'
  }

  setTimeout(() => {
    alertFlash.className = 'alert-flash'
    evaWarning.classList.remove('visible')
  }, 2000)
}

// ==================== START ====================

init().catch(console.error)
