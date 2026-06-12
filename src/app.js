const PROXY_BASE = 'http://127.0.0.1:12999/proxy?url='

const tauriInvoke = window.__TAURI__?.core?.invoke
if (!window.iptvAPI && tauriInvoke) {
  window.iptvAPI = {
    getChannels: () => tauriInvoke('get_channels'),
    refreshChannels: () => tauriInvoke('refresh_channels'),
    getPlaylistSources: () => tauriInvoke('get_playlist_sources'),
    getFavorites: () => tauriInvoke('get_favorites'),
    toggleFavorite: (channelId) => tauriInvoke('toggle_favorite', { channelId }),
    setChannelHeaders: (headers) => tauriInvoke('set_channel_headers', { headers }),
    getLastChannel: () => tauriInvoke('get_last_channel'),
    saveLastChannel: (url) => tauriInvoke('save_last_channel', { url }),
    recordPlay: (url) => tauriInvoke('record_play', { url }),
    updateChannelHealth: (url, status, error) => tauriInvoke('update_channel_health', { url, status, error }),
    getSettings: () => tauriInvoke('get_settings'),
    saveSettings: (settings) => tauriInvoke('save_settings', { settings }),
    writeDebugLog: (entry) => tauriInvoke('write_debug_log', { entry }),
    saveFile: (options, data) => tauriInvoke('save_file', { options, data }),
  }
}

const DEFAULT_SETTINGS = {
  theme: 'dark',
  language: 'zh',
  maxBufferLength: 90,
  maxMaxBufferLength: 300,
  maxBufferSize: 200,
  backBufferLength: 30,
  enableWorker: true,
  startLevel: -1,
  capLevelToPlayerSize: true,
  startFragPrefetch: true,
  fragLoadingMaxRetry: 6,
  fragLoadingTimeOut: 20000,
  levelLoadingTimeOut: 20000,
  manifestLoadingTimeOut: 20000,
  debugLog: false,
}

let channels = []
let filteredChannels = []
let favorites = []
let settings = {}
let currentChannel = null
let showFavoritesOnly = false
let selectedGroup = ''
let hls = null
const VIRTUAL_ROW_HEIGHT = 40
const VIRTUAL_OVERSCAN = 10
let searchDebounceTimer = null
let virtualRenderFrame = null
let playSessionSeq = 0
let playMetrics = null
const MANIFEST_WAIT_LOG_MS = 20000

const I18N = {
  zh: {
    searchPlaceholder: '筛选频道...',
    sortName: '名称',
    favorites: '收藏',
    allGroups: '全部分组',
    aboutTitle: '关于 My IPTV',
    settingsTitle: '设置',
    refreshTitle: '更新频道',
    selectChannel: '选择频道开始观看',
    screenshot: '截图',
    screenshotTitle: '截图保存 PNG',
    record: '录制',
    stop: '停止',
    recordTitle: '录制视频',
    noChannel: '未选择频道',
    settingsHeader: '设置',
    themeLabel: '主题',
    themeDark: '深色',
    themeLight: '浅色',
    languageLabel: '语言',
    languageZh: '中文',
    languageEn: 'English',
    maxBufferLength: '最大缓冲时长 (秒)',
    maxBufferSize: '最大缓冲大小 (MB)',
    startLevel: '初始码率层级',
    fragRetry: '分片加载重试',
    fragTimeout: '分片超时 (毫秒)',
    levelTimeout: '码率层超时 (毫秒)',
    manifestTimeout: '播放列表超时 (毫秒)',
    enableWorker: '启用 Web Worker',
    capPlayerSize: '限制到播放器尺寸',
    preloadNext: '预加载下一分片',
    debugLog: '开启播放 Debug 日志',
    resetDefaults: '恢复默认',
    applyClose: '应用并关闭',
    aboutHeader: '关于 My IPTV',
    version: '版本',
    application: '应用名称',
    author: '作者',
    project: '项目',
    noChannelsFound: '没有找到频道',
    loadingChannels: '正在加载频道...',
    updatingDb: '正在更新频道数据库...',
    updateFailed: '频道更新失败',
    loadFailed: '频道加载失败，请检查网络。',
    refreshFailed: '刷新失败',
    channels: '个频道',
    clickToPlay: '点击播放：',
    stream: '直播流：',
    streamOffline: ' - 频道可能不可用',
    unsupportedStream: '不支持的流：',
    error: '错误：',
    retry: '重试',
    screenshotFile: 'screenshot.png',
    recordingFile: 'recording.webm',
    netOk: '网络正常',
    netOkHttp: '网络正常 (HTTP)',
    netFail: '网络失败：',
  },
  en: {
    searchPlaceholder: 'Filter channels...',
    sortName: 'Name',
    favorites: 'Favorites',
    allGroups: 'All Groups',
    aboutTitle: 'About My IPTV',
    settingsTitle: 'Settings',
    refreshTitle: 'Refresh channels',
    selectChannel: 'Select a channel to start watching',
    screenshot: 'Screenshot',
    screenshotTitle: 'Screenshot (save PNG)',
    record: 'Record',
    stop: 'Stop',
    recordTitle: 'Record video',
    noChannel: 'No channel selected',
    settingsHeader: 'Settings',
    themeLabel: 'Theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    languageLabel: 'Language',
    languageZh: '中文',
    languageEn: 'English',
    maxBufferLength: 'Max Buffer Length (s)',
    maxBufferSize: 'Max Buffer Size (MB)',
    startLevel: 'Start Level (bitrate)',
    fragRetry: 'Fragment Loading Retry',
    fragTimeout: 'Fragment Timeout (ms)',
    levelTimeout: 'Level Timeout (ms)',
    manifestTimeout: 'Manifest Timeout (ms)',
    enableWorker: 'Enable Web Worker',
    capPlayerSize: 'Cap to Player Size',
    preloadNext: 'Preload Next Fragment',
    debugLog: 'Enable playback debug log',
    resetDefaults: 'Reset Defaults',
    applyClose: 'Apply & Close',
    aboutHeader: 'About My IPTV',
    version: 'Version',
    application: 'Application',
    author: 'Author',
    project: 'Project',
    noChannelsFound: 'No channels found',
    loadingChannels: 'Loading channels...',
    updatingDb: 'Updating channel database...',
    updateFailed: 'Failed to update channels',
    loadFailed: 'Failed to load channels. Check connection.',
    refreshFailed: 'refresh failed',
    channels: 'channels',
    clickToPlay: 'Click to play: ',
    stream: 'Stream: ',
    streamOffline: ' - stream may be offline',
    unsupportedStream: 'Unsupported stream: ',
    error: 'Error: ',
    retry: 'Retry',
    screenshotFile: 'screenshot.png',
    recordingFile: 'recording.webm',
    netOk: 'net OK',
    netOkHttp: 'net OK (http)',
    netFail: 'net FAIL: ',
  },
}

const video = document.getElementById('video-player')
const channelList = document.getElementById('channel-list')
const searchInput = document.getElementById('search')
const channelNameDisplay = document.getElementById('channel-name')
const channelCount = document.getElementById('channel-count')
const videoContainer = document.getElementById('video-container')

function lang() {
  return settings.language === 'en' ? 'en' : 'zh'
}

function t(key) {
  return I18N[lang()][key] || I18N.zh[key] || key
}

function formatChannelCount(count) {
  return lang() === 'zh' ? `${count} ${t('channels')}` : `${count} ${t('channels')}`
}

function applyTheme() {
  document.body.classList.toggle('light-theme', settings.theme === 'light')
}

function applyLanguage() {
  document.documentElement.lang = lang() === 'zh' ? 'zh-CN' : 'en'
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n)
  })
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle)
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder)
  })
  const recordBtn = document.getElementById('btn-record')
  if (recordBtn) recordBtn.textContent = recordBtn.classList.contains('recording') ? t('stop') : t('record')
  if (!currentChannel) channelNameDisplay.textContent = t('noChannel')
}

function applyAppearance() {
  applyTheme()
  applyLanguage()
}

function shouldWriteDebugLog() {
  return Boolean(settings.debugLog)
}

function channelDebugInfo(ch) {
  return {
    channelName: ch?.name || '',
    channelUrl: ch?.url || '',
    source: ch?.sourceName || '',
    sourceUrl: ch?.sourceUrl || '',
    group: ch?.group || '',
  }
}

function writePlaybackDebug(event, data = {}) {
  if (!shouldWriteDebugLog()) return
  const info = playMetrics?.channelInfo || channelDebugInfo(currentChannel)
  window.iptvAPI.writeDebugLog({
    event,
    sessionId: playMetrics?.sessionId || null,
    elapsedMs: playMetrics ? Math.round(performance.now() - playMetrics.startedAt) : null,
    waitingCount: playMetrics?.waitingCount || 0,
    stalledCount: playMetrics?.stalledCount || 0,
    ...info,
    ...data,
  }).catch(() => {})
}

function startPlaybackMetrics(ch, isHLS) {
  finishPlaybackMetrics('play_abandoned')
  playMetrics = {
    sessionId: ++playSessionSeq,
    startedAt: performance.now(),
    channelInfo: channelDebugInfo(ch),
    manifestLoadedAt: null,
    firstFrameAt: null,
    ended: false,
    manifestTimer: null,
    waitingCount: 0,
    stalledCount: 0,
    levelLoadedCount: 0,
    fragLoadingCount: 0,
    fragLoadedCount: 0,
    bufferAppendedCount: 0,
    fragLoadStarts: new Map(),
    abrRestored: false,
    isHLS,
  }
  writePlaybackDebug('play_start', { isHLS })
  if (isHLS) {
    playMetrics.manifestTimer = setTimeout(() => {
      if (!playMetrics || playMetrics.ended || playMetrics.manifestLoadedAt) return
      writePlaybackDebug('manifest_timeout_waiting', { waitMs: MANIFEST_WAIT_LOG_MS })
    }, MANIFEST_WAIT_LOG_MS)
  }
  return playMetrics.sessionId
}

function isCurrentPlaybackSession(sessionId) {
  return playMetrics && playMetrics.sessionId === sessionId
}

function markPlaybackEvent(sessionId, event, data = {}) {
  if (!isCurrentPlaybackSession(sessionId)) return
  writePlaybackDebug(event, data)
}

function finishPlaybackMetrics(reason) {
  if (!playMetrics || playMetrics.ended) return
  if (playMetrics.manifestTimer) {
    clearTimeout(playMetrics.manifestTimer)
    playMetrics.manifestTimer = null
  }
  if (!playMetrics.firstFrameAt && reason) {
    writePlaybackDebug(reason)
  }
  playMetrics.ended = true
}

function readBufferedRanges() {
  const ranges = []
  for (let i = 0; i < video.buffered.length; i++) {
    ranges.push({
      start: Number(video.buffered.start(i).toFixed(3)),
      end: Number(video.buffered.end(i).toFixed(3)),
    })
  }
  return ranges
}

async function loadChannels() {
  return window.iptvAPI.getChannels()
}

async function refreshChannels() {
  const result = await window.iptvAPI.refreshChannels()
  return result.channels || []
}

function createChannelItem(ch) {
  const item = document.createElement('div')
  item.className = 'channel-item'
  item.dataset.url = ch.url
  if (currentChannel && ch.url === currentChannel.url) item.classList.add('active')

  const logo = document.createElement('img')
  logo.className = 'ch-logo'
  logo.src = ch.logo || ''
  logo.alt = ''
  logo.loading = 'lazy'
  logo.onerror = () => { logo.style.display = 'none' }

  const name = document.createElement('span')
  name.className = 'ch-name'
  name.textContent = ch.name

  const isFav = favorites.includes(ch.url)
  const fav = document.createElement('button')
  fav.className = `fav-btn${isFav ? ' favorited' : ''}`
  fav.dataset.url = ch.url
  fav.textContent = isFav ? '★' : '☆'

  item.appendChild(logo)
  item.appendChild(name)
  item.appendChild(fav)
  return item
}

function createVirtualSpacer(height) {
  const spacer = document.createElement('div')
  spacer.className = 'virtual-spacer'
  spacer.style.height = `${height}px`
  return spacer
}

function renderChannels(list, resetScroll = false) {
  if (resetScroll) channelList.scrollTop = 0
  const scrollTop = channelList.scrollTop
  const viewportHeight = channelList.clientHeight || 600
  channelList.innerHTML = ''
  if (list.length === 0) {
    channelList.innerHTML = `<div class="empty-msg">${t('noChannelsFound')}</div>`
    return
  }
  const start = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2
  const end = Math.min(list.length, start + visibleCount)
  const frag = document.createDocumentFragment()
  frag.appendChild(createVirtualSpacer(start * VIRTUAL_ROW_HEIGHT))
  for (let i = start; i < end; i++) {
    frag.appendChild(createChannelItem(list[i]))
  }
  frag.appendChild(createVirtualSpacer((list.length - end) * VIRTUAL_ROW_HEIGHT))
  channelList.appendChild(frag)
}

function applyFilterAndSort(resetScroll = true) {
  const q = searchInput.value.toLowerCase().trim()
  let r = channels
  if (q) r = r.filter((c) => c.name.toLowerCase().includes(q))
  if (selectedGroup) {
    r = r.filter((c) => {
      if (!c.group) return false
      const groups = c.group.split(';').map((g) => g.trim())
      return groups.includes(selectedGroup)
    })
  }
  if (showFavoritesOnly) {
    const s = new Set(favorites)
    r = r.filter((c) => s.has(c.url))
  }
  r.sort((a, b) => a.name.localeCompare(b.name))
  filteredChannels = r
  renderChannels(filteredChannels, resetScroll)
  channelCount.textContent = formatChannelCount(filteredChannels.length)
}

function scheduleFilterAndSort() {
  clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(applyFilterAndSort, 180)
}

function scheduleVirtualRender() {
  if (virtualRenderFrame) return
  virtualRenderFrame = requestAnimationFrame(() => {
    virtualRenderFrame = null
    renderChannels(filteredChannels)
  })
}

function updateActiveChannel() {
  const items = channelList.querySelectorAll('.channel-item')
  for (const item of items) {
    item.classList.toggle('active', item.dataset.url === currentChannel?.url)
  }
}

function showError(msg, isRetryable) {
  let el = videoContainer.querySelector('.player-error')
  if (!el) {
    el = document.createElement('div')
    el.className = 'player-error'
    videoContainer.appendChild(el)
  }
  el.innerHTML = '<button class="error-close">×</button>' + msg
  el.style.display = 'block'
  el.querySelector('.error-close').onclick = (e) => { e.stopPropagation(); clearError() }
  if (isRetryable && currentChannel) {
    const btn = document.createElement('button')
    btn.className = 'retry-btn'
    btn.textContent = t('retry')
    btn.onclick = () => { clearError(); playChannel(currentChannel) }
    el.appendChild(btn)
  }
}

function clearError() {
  const el = videoContainer.querySelector('.player-error')
  if (el) el.style.display = 'none'
}

function playChannel(ch) {
  if (!ch || !ch.url) return
  try {
    if (hls) { hls.destroy(); hls = null }
    video.pause()
    video.removeAttribute('src')
    video.classList.remove('visible')
    video.muted = false

    currentChannel = ch
    channelNameDisplay.textContent = ch.name
    const infoEl = document.getElementById('channel-info')
    const parts = []
    if (ch.group) parts.push(ch.group)
    if (ch.url) parts.push(ch.url)
    if (ch.userAgent) parts.push('UA: ' + ch.userAgent)
    infoEl.textContent = parts.join(' · ')
    clearError()
    window.iptvAPI.saveLastChannel(ch.url)
    window.iptvAPI.recordPlay(ch.url)

    window.iptvAPI.setChannelHeaders({
      url: ch.url,
      userAgent: ch.userAgent || null,
      referrer: ch.referrer || null,
    })

    const isHLS = ch.url.includes('.m3u8')
    const sessionId = startPlaybackMetrics(ch, isHLS)
    video.onwaiting = () => {
      if (!isCurrentPlaybackSession(sessionId)) return
      playMetrics.waitingCount += 1
      markPlaybackEvent(sessionId, 'video_waiting')
    }
    video.onstalled = () => {
      if (!isCurrentPlaybackSession(sessionId)) return
      playMetrics.stalledCount += 1
      markPlaybackEvent(sessionId, 'video_stalled')
    }
    video.onplaying = () => {
      if (!isCurrentPlaybackSession(sessionId) || playMetrics.firstFrameAt) return
      playMetrics.firstFrameAt = performance.now()
      markPlaybackEvent(sessionId, 'first_frame', {
        firstFrameMs: Math.round(playMetrics.firstFrameAt - playMetrics.startedAt),
        manifestMs: playMetrics.manifestLoadedAt
          ? Math.round(playMetrics.manifestLoadedAt - playMetrics.startedAt)
          : null,
      })
      if (playMetrics.isHLS && hls && !playMetrics.abrRestored) {
        hls.currentLevel = -1
        hls.nextLevel = -1
        playMetrics.abrRestored = true
        markPlaybackEvent(sessionId, 'abr_restored')
      }
    }

    if (isHLS && typeof Hls !== 'undefined' && Hls.isSupported()) {
      const configuredStartLevel = Number(settings.startLevel)
      const startupLevel = configuredStartLevel >= 0 ? configuredStartLevel : 0
      hls = new Hls({
        maxBufferLength: settings.maxBufferLength || DEFAULT_SETTINGS.maxBufferLength,
        maxMaxBufferLength: settings.maxMaxBufferLength || DEFAULT_SETTINGS.maxMaxBufferLength,
        maxBufferSize: (settings.maxBufferSize || DEFAULT_SETTINGS.maxBufferSize) * 1000 * 1000,
        backBufferLength: settings.backBufferLength ?? DEFAULT_SETTINGS.backBufferLength,
        enableWorker: settings.enableWorker ?? DEFAULT_SETTINGS.enableWorker,
        startLevel: startupLevel,
        capLevelToPlayerSize: settings.capLevelToPlayerSize ?? DEFAULT_SETTINGS.capLevelToPlayerSize,
        startFragPrefetch: settings.startFragPrefetch ?? DEFAULT_SETTINGS.startFragPrefetch,
        fragLoadingMaxRetry: settings.fragLoadingMaxRetry ?? DEFAULT_SETTINGS.fragLoadingMaxRetry,
        fragLoadingTimeOut: settings.fragLoadingTimeOut || DEFAULT_SETTINGS.fragLoadingTimeOut,
        levelLoadingTimeOut: settings.levelLoadingTimeOut || DEFAULT_SETTINGS.levelLoadingTimeOut,
        manifestLoadingTimeOut: settings.manifestLoadingTimeOut || DEFAULT_SETTINGS.manifestLoadingTimeOut,
      })
      hls.loadSource(PROXY_BASE + encodeURIComponent(ch.url))
      hls.attachMedia(video)
      hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
        if (!isCurrentPlaybackSession(sessionId) || playMetrics.levelLoadedCount >= 2) return
        playMetrics.levelLoadedCount += 1
        const details = data.details || {}
        markPlaybackEvent(sessionId, 'level_loaded', {
          level: data.level ?? null,
          live: Boolean(details.live),
          targetduration: details.targetduration ?? null,
          fragmentCount: details.fragments?.length ?? 0,
          totalduration: details.totalduration ?? null,
        })
      })
      hls.on(Hls.Events.FRAG_LOADING, (_e, data) => {
        if (!isCurrentPlaybackSession(sessionId) || playMetrics.fragLoadingCount >= 3) return
        playMetrics.fragLoadingCount += 1
        const frag = data.frag || {}
        const key = `${frag.type || 'main'}:${frag.level ?? ''}:${frag.sn ?? playMetrics.fragLoadingCount}`
        playMetrics.fragLoadStarts.set(key, performance.now())
        markPlaybackEvent(sessionId, 'frag_loading', {
          fragKey: key,
          fragUrl: frag.url || '',
          sn: frag.sn ?? null,
          level: frag.level ?? null,
          duration: frag.duration ?? null,
        })
      })
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        if (!isCurrentPlaybackSession(sessionId) || playMetrics.fragLoadedCount >= 3) return
        playMetrics.fragLoadedCount += 1
        const frag = data.frag || {}
        const key = `${frag.type || 'main'}:${frag.level ?? ''}:${frag.sn ?? playMetrics.fragLoadedCount}`
        const startedAt = playMetrics.fragLoadStarts.get(key)
        const stats = data.stats || {}
        markPlaybackEvent(sessionId, 'frag_loaded', {
          fragKey: key,
          sn: frag.sn ?? null,
          level: frag.level ?? null,
          loadMs: startedAt ? Math.round(performance.now() - startedAt) : null,
          sizeBytes: stats.loaded ?? stats.total ?? null,
        })
      })
      hls.on(Hls.Events.BUFFER_APPENDED, (_e, data) => {
        if (!isCurrentPlaybackSession(sessionId) || playMetrics.bufferAppendedCount >= 3) return
        playMetrics.bufferAppendedCount += 1
        markPlaybackEvent(sessionId, 'buffer_appended', {
          type: data.type || '',
          pending: data.pending ?? null,
          timeRanges: readBufferedRanges(),
        })
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!isCurrentPlaybackSession(sessionId)) return
        if (playMetrics.manifestTimer) {
          clearTimeout(playMetrics.manifestTimer)
          playMetrics.manifestTimer = null
        }
        playMetrics.manifestLoadedAt = performance.now()
        markPlaybackEvent(sessionId, 'manifest_loaded', {
          manifestMs: Math.round(playMetrics.manifestLoadedAt - playMetrics.startedAt),
          startupLevel,
        })
        window.iptvAPI.updateChannelHealth(ch.url, 'ok')
        video.classList.add('visible')
        video.muted = true
        video.play().then(() => {
          setTimeout(() => { video.muted = false }, 500)
        }).catch((e) => {
          if (ch.url !== currentChannel?.url) return
          if (e.message.includes('interrupted by a new load request')) {
            setTimeout(() => {
              if (ch.url === currentChannel?.url) video.play().catch(() => {})
            }, 500)
            return
          }
          markPlaybackEvent(sessionId, 'play_rejected', { error: e.message })
          showError(t('clickToPlay') + e.message, true)
          video.muted = false
          video.classList.add('visible')
        })
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        console.error('[HLS]', data.type, data.details, data.fatal ? 'FATAL' : '')
        markPlaybackEvent(sessionId, 'hls_error', {
          fatal: Boolean(data.fatal),
          type: data.type || '',
          details: data.details || '',
          responseCode: data.response?.code || null,
        })
        if (data.fatal) {
          const code = data.response ? data.response.code : ''
          const detail = data.details || data.type || 'unknown'
          const prefix = code ? 'HTTP ' + code + ' (' + detail + ')' : detail
          const hint = data.details && data.details.includes('LoadError') ? t('streamOffline') : ''
          window.iptvAPI.updateChannelHealth(ch.url, 'error', prefix)
          showError(t('stream') + prefix + hint, true)
        }
      })
    } else {
      playDirect(ch)
    }

    updateActiveChannel()
  } catch (err) {
    console.error('[playChannel ERROR]', err.message, err.stack?.slice(0, 200))
    showError(t('error') + err.message)
  }
}

function playDirect(ch) {
  video.classList.add('visible')
  video.muted = true
  video.src = ch.url
  video.play().then(() => {
    window.iptvAPI.updateChannelHealth(ch.url, 'ok')
    setTimeout(() => { video.muted = false }, 500)
  }).catch((e) => {
    if (ch.url !== currentChannel?.url) return
    writePlaybackDebug('play_rejected', { error: e.message })
    window.iptvAPI.updateChannelHealth(ch.url, 'error', e.message)
    showError(t('unsupportedStream') + e.message)
  })
}

async function toggleFavorite(channelUrl) {
  try {
    favorites = await window.iptvAPI.toggleFavorite(channelUrl)
    applyFilterAndSort(false)
  } catch {}
}

async function takeScreenshot() {
  if (!video.classList.contains('visible') || !video.videoWidth) return
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d').drawImage(video, 0, 0)
  canvas.toBlob(async (blob) => {
    if (!blob) return
    const reader = new FileReader()
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1]
      await window.iptvAPI.saveFile(
        { defaultName: t('screenshotFile'), filters: [{ name: 'PNG', extensions: ['png'] }] },
        base64
      )
    }
    reader.readAsDataURL(blob)
  }, 'image/png')
}

let mediaRecorder = null
let recordedChunks = []

function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop()
  } else {
    startRecording()
  }
}

function startRecording() {
  if (!video.classList.contains('visible') || !video.videoWidth) return
  const stream = video.captureStream()
  if (!stream) return
  recordedChunks = []
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm'
  mediaRecorder = new MediaRecorder(stream, { mimeType: mime })
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data)
  }
  mediaRecorder.onstop = async () => {
    document.getElementById('btn-record').classList.remove('recording')
    document.getElementById('btn-record').textContent = t('record')
    const blob = new Blob(recordedChunks, { type: 'video/webm' })
    if (blob.size === 0) return
    const reader = new FileReader()
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1]
      await window.iptvAPI.saveFile(
        { defaultName: t('recordingFile'), filters: [{ name: 'WebM', extensions: ['webm'] }] },
        base64
      )
    }
    reader.readAsDataURL(blob)
  }
  mediaRecorder.start()
  document.getElementById('btn-record').textContent = t('stop')
  document.getElementById('btn-record').classList.add('recording')
}

document.getElementById('btn-screenshot').addEventListener('click', takeScreenshot)
document.getElementById('btn-record').addEventListener('click', toggleRecording)

channelList.addEventListener('click', (e) => {
  const item = e.target.closest('.channel-item')
  if (!item) return
  const favBtn = e.target.closest('.fav-btn')
  if (favBtn) { toggleFavorite(favBtn.dataset.url); return }
  const url = item.dataset.url
  if (!url) return
  const ch = filteredChannels.find((c) => c.url === url)
  if (ch) playChannel(ch)
})

searchInput.addEventListener('input', scheduleFilterAndSort)
channelList.addEventListener('scroll', scheduleVirtualRender)
window.addEventListener('resize', scheduleVirtualRender)

function isTypingTarget(target) {
  if (!target) return false
  const tag = target.tagName
  return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function hasOpenOverlay() {
  return !document.getElementById('settings-overlay').classList.contains('hidden') ||
    !document.getElementById('about-overlay').classList.contains('hidden')
}

function currentChannelIndex() {
  if (!filteredChannels.length) return -1
  if (!currentChannel) return -1
  return filteredChannels.findIndex((c) => c.url === currentChannel.url)
}

function playChannelByOffset(offset) {
  if (!filteredChannels.length) return
  const currentIndex = currentChannelIndex()
  const baseIndex = currentIndex === -1 ? 0 : currentIndex
  const nextIndex = Math.min(Math.max(baseIndex + offset, 0), filteredChannels.length - 1)
  playChannel(filteredChannels[nextIndex])
  channelList.scrollTop = nextIndex * VIRTUAL_ROW_HEIGHT
  renderChannels(filteredChannels)
}

function toggleVideoPlayback() {
  if (!video.classList.contains('visible')) return
  if (video.paused) {
    video.play().catch(() => {})
  } else {
    video.pause()
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {})
  } else {
    videoContainer.requestFullscreen().catch(() => {})
  }
}

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target) || hasOpenOverlay()) return
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    playChannelByOffset(-1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    playChannelByOffset(1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (currentChannel) playChannel(currentChannel)
    else if (filteredChannels.length > 0) playChannel(filteredChannels[0])
  } else if (e.key === ' ') {
    e.preventDefault()
    toggleVideoPlayback()
  } else if (e.key.toLowerCase() === 'f') {
    e.preventDefault()
    toggleFullscreen()
  }
})

function populateGroupFilter() {
  const groups = new Set()
  for (const c of channels) {
    if (c.group) {
      for (const g of c.group.split(';')) {
        const t = g.trim()
        if (t) groups.add(t)
      }
    }
  }
  const sel = document.getElementById('group-filter')
  const current = sel.value
  sel.innerHTML = `<option value="">${t('allGroups')}</option>`
  for (const g of [...groups].sort()) {
    const opt = document.createElement('option')
    opt.value = g
    opt.textContent = g
    sel.appendChild(opt)
  }
  sel.value = groups.has(current) ? current : ''
}

document.getElementById('toggle-fav').addEventListener('click', () => {
  showFavoritesOnly = !showFavoritesOnly
  document.getElementById('toggle-fav').classList.toggle('active', showFavoritesOnly)
  applyFilterAndSort()
})

document.getElementById('group-filter').addEventListener('change', () => {
  selectedGroup = document.getElementById('group-filter').value
  applyFilterAndSort()
})

function populateSettingsPanel() {
  const s = { ...DEFAULT_SETTINGS, ...settings }
  document.getElementById('s-theme').value = s.theme
  document.getElementById('s-language').value = s.language
  document.getElementById('s-maxBufferLength').value = s.maxBufferLength
  document.getElementById('s-maxBufferSize').value = s.maxBufferSize
  document.getElementById('s-startLevel').value = s.startLevel
  document.getElementById('s-fragLoadingMaxRetry').value = s.fragLoadingMaxRetry
  document.getElementById('s-fragLoadingTimeOut').value = s.fragLoadingTimeOut
  document.getElementById('s-levelLoadingTimeOut').value = s.levelLoadingTimeOut
  document.getElementById('s-manifestLoadingTimeOut').value = s.manifestLoadingTimeOut
  document.getElementById('s-enableWorker').checked = s.enableWorker
  document.getElementById('s-capLevelToPlayerSize').checked = s.capLevelToPlayerSize
  document.getElementById('s-startFragPrefetch').checked = s.startFragPrefetch
  document.getElementById('s-debugLog').checked = s.debugLog
}

function readSettingsPanel() {
  return {
    theme: document.getElementById('s-theme').value || DEFAULT_SETTINGS.theme,
    language: document.getElementById('s-language').value || DEFAULT_SETTINGS.language,
    maxBufferLength: parseInt(document.getElementById('s-maxBufferLength').value) || DEFAULT_SETTINGS.maxBufferLength,
    maxBufferSize: parseInt(document.getElementById('s-maxBufferSize').value) || DEFAULT_SETTINGS.maxBufferSize,
    startLevel: parseInt(document.getElementById('s-startLevel').value) || DEFAULT_SETTINGS.startLevel,
    fragLoadingMaxRetry: parseInt(document.getElementById('s-fragLoadingMaxRetry').value) || DEFAULT_SETTINGS.fragLoadingMaxRetry,
    fragLoadingTimeOut: parseInt(document.getElementById('s-fragLoadingTimeOut').value) || DEFAULT_SETTINGS.fragLoadingTimeOut,
    levelLoadingTimeOut: parseInt(document.getElementById('s-levelLoadingTimeOut').value) || DEFAULT_SETTINGS.levelLoadingTimeOut,
    manifestLoadingTimeOut: parseInt(document.getElementById('s-manifestLoadingTimeOut').value) || DEFAULT_SETTINGS.manifestLoadingTimeOut,
    enableWorker: document.getElementById('s-enableWorker').checked,
    capLevelToPlayerSize: document.getElementById('s-capLevelToPlayerSize').checked,
    startFragPrefetch: document.getElementById('s-startFragPrefetch').checked,
    debugLog: document.getElementById('s-debugLog').checked,
  }
}

document.getElementById('settings-btn').addEventListener('click', () => {
  populateSettingsPanel()
  document.getElementById('settings-overlay').classList.remove('hidden')
})

document.getElementById('settings-close').addEventListener('click', () => {
  document.getElementById('settings-overlay').classList.add('hidden')
})

document.getElementById('settings-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('settings-overlay'))
    document.getElementById('settings-overlay').classList.add('hidden')
})

document.getElementById('settings-reset').addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS }
  applyAppearance()
  populateSettingsPanel()
})

document.getElementById('settings-apply').addEventListener('click', async () => {
  settings = readSettingsPanel()
  applyAppearance()
  populateGroupFilter()
  applyFilterAndSort()
  await window.iptvAPI.saveSettings(settings)
  document.getElementById('settings-overlay').classList.add('hidden')
  if (hls) { hls.destroy(); hls = null }
  if (currentChannel) playChannel(currentChannel)
})

document.getElementById('about-btn').addEventListener('click', () => {
  document.getElementById('about-overlay').classList.remove('hidden')
})

document.getElementById('about-close').addEventListener('click', () => {
  document.getElementById('about-overlay').classList.add('hidden')
})

document.getElementById('about-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('about-overlay'))
    document.getElementById('about-overlay').classList.add('hidden')
})

document.getElementById('refresh-btn').addEventListener('click', async () => {
  channelList.innerHTML = `<div class="empty-msg">${t('updatingDb')}</div>`
  try {
    channels = await refreshChannels()
    populateGroupFilter()
    applyFilterAndSort()
  } catch (e) {
    if (channels.length > 0) {
      applyFilterAndSort()
      channelCount.textContent = `${formatChannelCount(filteredChannels.length)} | ${t('refreshFailed')}`
      return
    }
    channelList.innerHTML = `<div class="empty-msg" style="color:#e94560;">${t('updateFailed')}</div>`
  }
})

async function testNetwork() {
  try {
    const res = await fetch('https://clients3.google.com/generate_204', { mode: 'no-cors' })
    return t('netOk')
  } catch {
    try {
      const res = await fetch('http://example.com', { mode: 'no-cors' })
      return t('netOkHttp')
    } catch (e) {
      return t('netFail') + e.message
    }
  }
}

async function init() {
  try { favorites = await window.iptvAPI.getFavorites() } catch {}
  try {
    const saved = await window.iptvAPI.getSettings()
    settings = { ...DEFAULT_SETTINGS, ...(saved || {}) }
  } catch {}
  applyAppearance()
  channelList.innerHTML = `<div class="empty-msg">${t('loadingChannels')}</div>`
  try {
    channels = await loadChannels()
    if (channels.length === 0) {
      channelList.innerHTML = `<div class="empty-msg">${t('updatingDb')}</div>`
      channels = await refreshChannels()
    }
    populateGroupFilter()
  } catch {
    channelList.innerHTML = `<div class="empty-msg" style="color:#e94560;">${t('loadFailed')}</div>`
    return
  }
  applyFilterAndSort()
  const net = await testNetwork()
  channelCount.textContent = `${formatChannelCount(filteredChannels.length)} | ${net}`
  if (channels.length > 0) {
    let restored = false
    try {
      const saved = await window.iptvAPI.getLastChannel()
      if (saved && saved.url) {
        const found = channels.find((c) => c.url === saved.url)
        if (found) { playChannel(found); restored = true }
      }
    } catch {}
    if (!restored) playChannel(channels[0])
  }
}

init()
