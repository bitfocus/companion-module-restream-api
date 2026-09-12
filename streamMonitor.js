const dns = require('node:dns')
try {
	if (dns && typeof dns.setDefaultResultOrder === 'function') {
		dns.setDefaultResultOrder('ipv4first')
	}
} catch {
	// Fallback
}

const { EventEmitter } = require('events')

/**
 * Real-time Stream Monitor for Restream API.
 * Connects to wss://streaming.api.restream.io/ws and tracks stream status,
 * FPS, bitrate (kbps), resolution, and codecs with automatic reconnection,
 * heartbeat pings, and fallback REST processing.
 */
class StreamMonitor extends EventEmitter {
	/**
	 * @param {object} instance Companion module instance for logging and callbacks
	 * @param {object} [options]
	 */
	constructor(instance, options = {}) {
		super()
		this.instance = instance
		this.wsUrl = options.wsUrl || 'wss://streaming.api.restream.io/ws'
		this.reconnectDelay = 3000
		this.maxReconnectDelay = 30000
		this.reconnectMultiplier = 1.5
		this.currentReconnectDelay = this.reconnectDelay

		this.ws = null
		this.token = null
		this.isConnecting = false
		this.isConnected = false
		this.destroyed = false

		this.reconnectTimer = null
		this.pingTimer = null
		this.pingIntervalMs = 30000

		// Current stream metrics and state
		this.streamData = {
			status: 'OFFLINE',
			isStreaming: false,
			fps: 0,
			bitrate: 0, // kbps
			resolution: 'N/A',
			videoCodec: 'N/A',
			audioCodec: 'N/A',
			eventTitle: '',
			lastUpdated: null,
		}
	}

	/**
	 * Connect to Restream streaming WebSocket.
	 * @param {string} token Access token
	 * @param {string} [customWsUrl] Optional URL override
	 */
	connect(token, customWsUrl) {
		if (this.destroyed) return
		if (customWsUrl) {
			this.wsUrl = customWsUrl
		}
		if (token) {
			this.token = token
		}

		if (!this.token) {
			this.log('warn', 'StreamMonitor: Cannot connect to WebSocket without access token')
			return
		}

		// Close existing connection cleanly if any
		this.closeSocket()

		this.isConnecting = true
		const WSClass = this.getWebSocketClass()

		if (!WSClass) {
			this.log('warn', 'StreamMonitor: WebSocket is not available in runtime environment')
			this.isConnecting = false
			return
		}

		let connectionUrl = this.wsUrl
		try {
			const urlObj = new URL(this.wsUrl)
			urlObj.searchParams.set('accessToken', this.token)
			connectionUrl = urlObj.toString()
		} catch {
			connectionUrl = `${this.wsUrl}${this.wsUrl.includes('?') ? '&' : '?'}accessToken=${encodeURIComponent(this.token)}`
		}

		try {
			this.log('info', `StreamMonitor: Connecting to WebSocket ${this.wsUrl}`)
			const socket = new WSClass(connectionUrl)
			this.ws = socket

			// Attach exactly one set of event listeners with socket instance binding
			if (typeof socket.addEventListener === 'function') {
				socket.addEventListener('open', () => this.handleOpen(socket))
				socket.addEventListener('message', (event) => this.handleMessage(event.data, socket))
				socket.addEventListener('error', (err) => this.handleError(err, socket))
				socket.addEventListener('close', (event) => this.handleClose(event, socket))
			} else if (typeof socket.on === 'function') {
				socket.on('open', () => this.handleOpen(socket))
				socket.on('message', (data) => this.handleMessage(data, socket))
				socket.on('error', (err) => this.handleError(err, socket))
				socket.on('close', (code, reason) => this.handleClose({ code, reason }, socket))
			} else {
				socket.onopen = () => this.handleOpen(socket)
				socket.onmessage = (event) => this.handleMessage(event?.data ?? event, socket)
				socket.onerror = (err) => this.handleError(err, socket)
				socket.onclose = (event) => this.handleClose(event, socket)
			}
		} catch (err) {
			this.log('error', `StreamMonitor: Failed to instantiate WebSocket: ${err.message}`)
			this.isConnecting = false
			this.scheduleReconnect()
		}
	}

	/**
	 * Resolves WebSocket constructor (native global or ws package).
	 */
	getWebSocketClass() {
		if (typeof WebSocket !== 'undefined') {
			return WebSocket
		}
		try {
			return require('ws')
		} catch {
			return null
		}
	}

	/**
	 * Handle WebSocket open event.
	 * @param {object} [socket]
	 */
	handleOpen(socket) {
		if (this.destroyed || (socket && this.ws !== socket)) return
		if (this.isConnected) return
		this.isConnecting = false
		this.isConnected = true
		this.currentReconnectDelay = this.reconnectDelay
		this.log('info', 'StreamMonitor: WebSocket connected')

		// Send subscription message
		this.send({
			action: 'subscribe',
			topic: 'stream',
			token: this.token,
		})

		// Start heartbeat ping interval
		this.startPingInterval()
		this.emit('connected')
	}

	/**
	 * Handle WebSocket incoming message.
	 * @param {string|Buffer|ArrayBuffer|Uint8Array|object} rawMessage
	 * @param {object} [socket]
	 */
	handleMessage(rawMessage, socket) {
		if (this.destroyed || (socket && this.ws !== socket)) return

		let message = rawMessage
		if (typeof rawMessage === 'string') {
			try {
				message = JSON.parse(rawMessage)
			} catch {
				if (rawMessage.trim() === 'pong') return
				this.log('debug', `StreamMonitor: Received non-JSON text message: ${rawMessage}`)
				return
			}
		} else if (Buffer.isBuffer(rawMessage)) {
			try {
				message = JSON.parse(rawMessage.toString('utf8'))
			} catch {
				if (rawMessage.toString('utf8').trim() === 'pong') return
				this.log('debug', `StreamMonitor: Received non-JSON buffer: ${rawMessage}`)
				return
			}
		} else if (rawMessage instanceof ArrayBuffer || ArrayBuffer.isView(rawMessage)) {
			try {
				const text = new TextDecoder('utf-8').decode(rawMessage)
				message = JSON.parse(text)
			} catch {
				return
			}
		}

		if (!message || typeof message !== 'object') return

		// Handle heartbeat responses
		if (message.action === 'pong' || message.type === 'pong' || message.event === 'pong') {
			return
		}

		if (Array.isArray(message)) {
			for (const item of message) {
				if (item && typeof item === 'object') {
					this.processStreamEvent(item)
				}
			}
			return
		}

		this.processStreamEvent(message)
	}

	/**
	 * Normalize and process stream status / metrics events from WebSocket.
	 * @param {object} event
	 */
	processStreamEvent(event) {
		if (!event || typeof event !== 'object') return
		let stateChanged = false
		const prevStatus = this.streamData.status
		const prevStreaming = this.streamData.isStreaming

		const payload = event.data || event.payload || event
		if (!payload || typeof payload !== 'object') return
		const metricsObj = payload.metrics || payload.streamHealth || payload.telemetry || payload

		// 1. Detect Status / State
		let isLive = null
		let newStatus = null

		if (payload.status !== undefined) {
			const s = String(payload.status).toUpperCase()
			if (s === 'LIVE' || s === 'ACTIVE' || s === 'ONLINE' || s === 'BROADCASTING') {
				isLive = true
				newStatus = 'LIVE'
			} else if (s === 'OFFLINE' || s === 'IDLE' || s === 'DISCONNECTED' || s === 'ENDED') {
				isLive = false
				newStatus = 'OFFLINE'
			} else if (s === 'CONNECTING' || s === 'DEGRADED') {
				newStatus = s
				isLive = true
			}
		}

		if (payload.live !== undefined) {
			isLive = Boolean(payload.live)
			newStatus = isLive ? 'LIVE' : 'OFFLINE'
		} else if (payload.active !== undefined && payload.action !== 'metrics') {
			isLive = Boolean(payload.active)
			newStatus = isLive ? 'LIVE' : 'OFFLINE'
		} else if (payload.state !== undefined) {
			const st = String(payload.state).toUpperCase()
			if (st === 'LIVE' || st === 'ONLINE' || st === 'BROADCASTING') {
				isLive = true
				newStatus = 'LIVE'
			} else if (st === 'OFFLINE' || st === 'IDLE' || st === 'DISCONNECTED') {
				isLive = false
				newStatus = 'OFFLINE'
			}
		} else if (event.event === 'stream.live' || event.event === 'stream_started' || payload.event === 'stream.live') {
			isLive = true
			newStatus = 'LIVE'
		} else if (event.event === 'stream.offline' || event.event === 'stream_stopped' || payload.event === 'stream.offline') {
			isLive = false
			newStatus = 'OFFLINE'
		}

		// Apply state changes
		if (newStatus !== null) {
			this.streamData.status = newStatus
			this.streamData.isStreaming = isLive ?? (newStatus === 'LIVE' || newStatus === 'DEGRADED')
		}

		// 2. Extract Stream Metrics
		const rawFps = metricsObj.fps ?? payload.fps ?? payload.video?.fps
		if (rawFps !== undefined) {
			const fpsNum = Number(rawFps)
			this.streamData.fps = isNaN(fpsNum) ? 0 : Math.round(fpsNum * 100) / 100
		}

		const rawBitrate = metricsObj.bitrate_kbps ?? metricsObj.bitrateKbps ?? metricsObj.bitrate ?? payload.bitrate_kbps ?? payload.bitrateKbps ?? payload.bitrate ?? payload.video?.bitrate
		if (rawBitrate !== undefined) {
			const bitNum = Number(rawBitrate)
			if (!isNaN(bitNum)) {
				// If bitrate is in bps (> 100,000), convert to kbps
				this.streamData.bitrate = bitNum > 100000 ? Math.round(bitNum / 1000) : Math.round(bitNum)
			}
		}

		// Resolution
		const rawRes = metricsObj.resolution ?? payload.resolution
		const rawW = metricsObj.width ?? payload.width ?? payload.video?.width
		const rawH = metricsObj.height ?? payload.height ?? payload.video?.height

		if (rawRes !== undefined && typeof rawRes === 'string') {
			this.streamData.resolution = rawRes
		} else if (rawW !== undefined && rawH !== undefined) {
			this.streamData.resolution = `${rawW}x${rawH}`
		}

		// Codecs
		const rawVideoCodec = metricsObj.video_codec ?? metricsObj.videoCodec ?? metricsObj.codec ?? payload.video_codec ?? payload.videoCodec ?? payload.video?.codec ?? payload.codec
		if (rawVideoCodec) {
			this.streamData.videoCodec = String(rawVideoCodec)
		}

		const rawAudioCodec = metricsObj.audio_codec ?? metricsObj.audioCodec ?? payload.audio_codec ?? payload.audioCodec ?? payload.audio?.codec
		if (rawAudioCodec) {
			this.streamData.audioCodec = String(rawAudioCodec)
		}

		// If stream transitioned to OFFLINE, reset dynamic metrics
		if (newStatus === 'OFFLINE') {
			this.streamData.isStreaming = false
			this.streamData.fps = 0
			this.streamData.bitrate = 0
		} else if (this.streamData.fps > 0 || this.streamData.bitrate > 0) {
			// If active metrics received and not explicitly offline, mark as live
			if (this.streamData.status === 'OFFLINE') {
				this.streamData.status = 'LIVE'
				this.streamData.isStreaming = true
			}
		}

		this.streamData.lastUpdated = new Date().toISOString()

		// Detect transitions
		if (prevStatus !== this.streamData.status || prevStreaming !== this.streamData.isStreaming) {
			stateChanged = true
			this.log('info', `StreamMonitor: Stream status transition: ${prevStatus} -> ${this.streamData.status}`)
			this.emit('transition', {
				from: prevStatus,
				to: this.streamData.status,
				isStreaming: this.streamData.isStreaming,
			})
		}

		// Mirror streamData onto module instance
		if (this.instance) {
			this.instance.streamData = { ...this.streamData }
		}

		this.emit('metrics', this.streamData)
		if (stateChanged) {
			this.emit('stateChange', this.streamData)
		}

		this.notifyInstance(stateChanged)
	}

	/**
	 * Process stream status and events from REST fallback endpoint (/user/events/in-progress).
	 * @param {Array|object} events Data from /user/events/in-progress
	 */
	updateFromRest(events) {
		if (this.destroyed) return

		const list = Array.isArray(events)
			? events
			: events?.events || events?.result || events?.data || (events && typeof events === 'object' ? [events] : [])
		const activeEvent = Array.isArray(list)
			? list.find(
					(ev) =>
						ev &&
						typeof ev === 'object' &&
						(ev.inProgress ||
							ev.status === 'in-progress' ||
							ev.status === 'LIVE' ||
							ev.status === 'live' ||
							ev.status === 'active' ||
							ev.active ||
							ev.state === 'live' ||
							ev.live === true)
			  )
			: null

		const prevStatus = this.streamData.status
		let stateChanged = false

		if (activeEvent) {
			this.streamData.status = 'LIVE'
			this.streamData.isStreaming = true
			this.streamData.eventTitle = activeEvent.title || activeEvent.name || this.streamData.eventTitle || ''

			// If event contains stream health / metrics
			const m = activeEvent.streamHealth || activeEvent.metrics || activeEvent.telemetry
			if (m) {
				if (m.fps !== undefined) this.streamData.fps = Number(m.fps)
				const rawB = m.bitrate_kbps ?? m.bitrateKbps ?? m.bitrate
				if (rawB !== undefined) {
					const b = Number(rawB)
					this.streamData.bitrate = b > 100000 ? Math.round(b / 1000) : Math.round(b)
				}
				if (m.resolution) this.streamData.resolution = m.resolution
				if (m.videoCodec || m.video_codec) this.streamData.videoCodec = m.videoCodec || m.video_codec
				if (m.audioCodec || m.audio_codec) this.streamData.audioCodec = m.audioCodec || m.audio_codec
			}
		} else {
			// If WebSocket is actively connected and reported LIVE, do not override unless WS is offline
			if (!this.isConnected) {
				this.streamData.status = 'OFFLINE'
				this.streamData.isStreaming = false
				this.streamData.fps = 0
				this.streamData.bitrate = 0
				this.streamData.eventTitle = ''
			}
		}

		this.streamData.lastUpdated = new Date().toISOString()

		if (this.instance) {
			this.instance.streamData = { ...this.streamData }
		}

		if (prevStatus !== this.streamData.status) {
			stateChanged = true
			this.log('info', `StreamMonitor (REST fallback): Status transition: ${prevStatus} -> ${this.streamData.status}`)
			this.emit('transition', {
				from: prevStatus,
				to: this.streamData.status,
				isStreaming: this.streamData.isStreaming,
			})
			this.emit('stateChange', this.streamData)
		}

		this.notifyInstance(stateChanged)
	}

	/**
	 * Send JSON payload to WebSocket.
	 * @param {object} payload
	 */
	send(payload) {
		if (!this.isConnected || !this.ws) return
		try {
			const str = typeof payload === 'string' ? payload : JSON.stringify(payload)
			if (typeof this.ws.send === 'function') {
				this.ws.send(str)
			}
		} catch (err) {
			this.log('debug', `StreamMonitor: Failed to send WS message: ${err.message}`)
		}
	}

	/**
	 * Start sending periodic ping frames.
	 */
	startPingInterval() {
		this.clearPingInterval()
		this.pingTimer = setInterval(() => {
			if (this.isConnected && this.ws) {
				try {
					if (typeof this.ws.ping === 'function') {
						this.ws.ping()
					} else {
						this.send({ action: 'ping' })
					}
				} catch {
					// Ignore ping error
				}
			}
		}, this.pingIntervalMs)
	}

	clearPingInterval() {
		if (this.pingTimer) {
			clearInterval(this.pingTimer)
			this.pingTimer = null
		}
	}

	/**
	 * Handle WebSocket error.
	 * @param {Error|object} err
	 * @param {object} [socket]
	 */
	handleError(err, socket) {
		if (this.destroyed || (socket && this.ws !== socket)) return
		this.log('warn', `StreamMonitor: WebSocket error: ${err?.message || 'Unknown socket error'}`)
		this.emit('error', err)
	}

	/**
	 * Handle WebSocket close.
	 * @param {object} event
	 * @param {object} [socket]
	 */
	handleClose(event, socket) {
		if (this.destroyed || (socket && this.ws !== socket)) return
		this.isConnecting = false
		this.isConnected = false
		this.clearPingInterval()

		this.log('info', `StreamMonitor: WebSocket closed (code: ${event?.code || 'none'})`)
		this.emit('disconnected', event)

		this.scheduleReconnect()
	}

	/**
	 * Schedule automatic reconnection with exponential backoff.
	 */
	scheduleReconnect() {
		if (this.destroyed || this.reconnectTimer || !this.token) return

		this.log('debug', `StreamMonitor: Scheduling reconnect in ${this.currentReconnectDelay}ms`)
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (!this.destroyed && this.token) {
				this.connect(this.token, this.wsUrl)
			}
		}, this.currentReconnectDelay)

		// Exponential backoff with ceiling
		this.currentReconnectDelay = Math.min(
			this.currentReconnectDelay * this.reconnectMultiplier,
			this.maxReconnectDelay
		)
	}

	clearReconnectTimer() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}

	/**
	 * Force immediate reconnection.
	 */
	reconnect() {
		this.clearReconnectTimer()
		this.currentReconnectDelay = this.reconnectDelay
		if (this.token) {
			this.connect(this.token, this.wsUrl)
		}
	}

	/**
	 * Close socket without destroying monitor.
	 * @param {boolean} [clearReconnect=true]
	 */
	closeSocket(clearReconnect = true) {
		if (clearReconnect) {
			this.clearReconnectTimer()
		}
		this.clearPingInterval()
		const socket = this.ws
		this.ws = null
		this.isConnected = false
		this.isConnecting = false

		if (socket) {
			try {
				if (typeof socket.removeAllListeners === 'function') {
					socket.removeAllListeners()
				}
				socket.onopen = null
				socket.onmessage = null
				socket.onerror = null
				socket.onclose = null
				if (typeof socket.close === 'function') {
					socket.close()
				} else if (typeof socket.terminate === 'function') {
					socket.terminate()
				}
			} catch {
				// Ignore close error
			}
		}
	}

	/**
	 * Clean teardown of all timers and sockets.
	 */
	destroy() {
		this.destroyed = true
		this.clearReconnectTimer()
		this.clearPingInterval()
		this.closeSocket(true)
		this.removeAllListeners()
	}

	/**
	 * Notify companion instance of state/metric changes.
	 * @param {boolean} stateChanged
	 */
	notifyInstance(stateChanged) {
		if (!this.instance) return

		// If active event listeners are handling updates on this instance, skip duplicate direct notification
		if (this.listenerCount('metrics') > 0 || this.listenerCount('stateChange') > 0) {
			return
		}

		try {
			if (typeof this.instance.updateVariables === 'function') {
				this.instance.updateVariables()
			}
			if (typeof this.instance.checkFeedbacks === 'function') {
				this.instance.checkFeedbacks('StreamStatus', 'IsStreaming', 'StreamBitrateWarning', 'StreamFpsWarning', 'WebSocketConnected')
			}
		} catch (err) {
			this.log('error', `StreamMonitor: Error notifying Companion instance: ${err.message}`)
		}
	}

	/**
	 * Safely log via module instance or fallback to console.
	 */
	log(level, msg) {
		if (this.instance && typeof this.instance.log === 'function') {
			this.instance.log(level, msg)
		} else {
			console.log(`[${level.toUpperCase()}] ${msg}`)
		}
	}

	/**
	 * Get current stream metrics data snapshot.
	 */
	getStreamData() {
		return { ...this.streamData }
	}
}

module.exports = StreamMonitor
