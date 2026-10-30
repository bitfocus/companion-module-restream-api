const dns = require('node:dns')
try {
	if (dns && typeof dns.setDefaultResultOrder === 'function') {
		dns.setDefaultResultOrder('ipv4first')
	}
} catch {
	// Fallback for older runtimes
}

const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const UpdateActions = require('./actions')
const UpdateFeedbacks = require('./feedbacks')
const UpdateVariables = require('./variables')
const UpdatePresets = require('./presets')
const StreamMonitor = require('./streamMonitor')
const HttpReceiver = require('./httpListener')

let axios
try {
	axios = require('axios')
} catch {
	axios = null
}

let openBrowser
try {
	openBrowser = require('open')
} catch {
	openBrowser = null
}

class ModuleInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.channels = []
		this.platforms = []
		this.streamData = {
			status: 'OFFLINE',
			isStreaming: false,
			fps: 0,
			bitrate: 0,
			resolution: 'N/A',
			videoCodec: 'N/A',
			audioCodec: 'N/A',
			eventTitle: '',
			lastUpdated: null,
		}
		this.poll_interval = null
		this.pollInProgress = false
		this.pollQueued = false
		this.destroyed = false
		this._refreshPromise = null
		this._authPromise = null
		this.streamMonitor = null
		this.callbackServer = null
		this.api = null
	}

	async init(config) {
		this.config = config || {}

		// Initialize API client
		this.initApiClient()

		// Initialize Real-time Stream Monitor
		this.streamMonitor = new StreamMonitor(this, {
			wsUrl: this.config.wsUrl || 'wss://streaming.api.restream.io/ws',
		})

		// Wire up StreamMonitor events
		this.streamMonitor.on('stateChange', () => {
			this.updateVariables()
			this.checkFeedbacks('StreamStatus', 'IsStreaming')
		})

		this.streamMonitor.on('metrics', () => {
			this.updateVariables()
			this.checkFeedbacks('StreamBitrateWarning', 'StreamFpsWarning')
		})

		this.streamMonitor.on('connected', () => {
			this.updateVariables()
			this.checkFeedbacks('WebSocketConnected')
		})

		this.streamMonitor.on('disconnected', () => {
			this.updateVariables()
			this.checkFeedbacks('WebSocketConnected')
		})

		// Setup definitions early with safe empty arrays
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariables()
		this.updatePresets()

		if (this.config.accessToken && this.config.accessToken.trim() !== '') {
			this.updateStatus(InstanceStatus.Connecting, 'Connecting to Restream...')
		} else if (this.config.clientID && this.config.clientSecret) {
			this.updateStatus(InstanceStatus.Connecting, 'Authenticating with OAuth...')
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'Please enter your Restream Access Token')
		}

		this.setupPollInterval()

		// Run authentication and initial poll in background (non-blocking for Companion IPC)
		setImmediate(() => {
			this.startUp().catch((err) => {
				this.log('debug', `Startup background error: ${err.message}`)
			})
		})
	}

	/**
	 * Asynchronous background startup for authentication and polling.
	 */
	async startUp() {
		if (this.destroyed) return

		// If user provided an authorization code, exchange it for tokens first
		if (this.config.authCode && this.config.authCode.trim() !== '') {
			await this.exchangeAuthCode(this.config.authCode)
		}

		if (this.checkConfiguration()) {
			const isAuthed = await this.checkAuthenticationStatus()
			if (isAuthed) {
				this.log('info', 'Successfully authenticated with Restream API')
				this.updateStatus(InstanceStatus.Ok)

				// Start WebSocket streaming monitor if enabled and token present
				if (this.config.enableWs !== false && this.config.accessToken) {
					this.streamMonitor.connect(this.config.accessToken, this.config.wsUrl)
				}
			}
		}

		if (!this.destroyed && this.config.accessToken) {
			await this.poll()
		}
	}

	/**
	 * Setup or restart polling interval timer.
	 */
	setupPollInterval() {
		if (this.poll_interval) {
			clearInterval(this.poll_interval)
			this.poll_interval = null
		}

		const intervalSec = this.config.pollTime !== undefined && this.config.pollTime !== ''
			? Number(this.config.pollTime)
			: 30

		if (intervalSec > 0) {
			this.poll_interval = setInterval(() => {
				this.poll().catch((err) => {
					this.log('debug', `Poll error: ${err.message}`)
				})
			}, intervalSec * 1000)
		}
	}

	/**
	 * Clean module teardown. Clear all timers, sockets, and listeners.
	 */
	async destroy() {
		this.log('debug', 'Destroying Restream module instance')
		this.destroyed = true
		this.pollQueued = false

		// 1. Clear polling timer
		if (this.poll_interval) {
			clearInterval(this.poll_interval)
			this.poll_interval = null
		}

		// 2. Destroy stream monitor (closes WS, clears ping & reconnect timers)
		if (this.streamMonitor) {
			this.streamMonitor.destroy()
			this.streamMonitor = null
		}

		// 3. Close OAuth HTTP receiver if active
		if (this.callbackServer) {
			this.callbackServer.abort()
			this.callbackServer = null
		}
		this._authPromise = null
		this._refreshPromise = null
	}

	/**
	 * Handle configuration changes from Companion UI.
	 */
	async configUpdated(config) {
		const oldToken = this.config?.accessToken
		const oldWsUrl = this.config?.wsUrl
		const oldEnableWs = this.config?.enableWs

		this.config = config || {}

		this.initApiClient()
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariables()
		this.updatePresets()

		if (!this.checkConfiguration()) {
			return
		}

		this.updateStatus(InstanceStatus.Connecting, 'Updating configuration...')
		this.setupPollInterval()

		// Run authentication check & reconnection in background without blocking Companion IPC
		setImmediate(async () => {
			if (this.destroyed) return
			try {
				if (this.config.authCode && this.config.authCode.trim() !== '') {
					await this.exchangeAuthCode(this.config.authCode)
				}

				const isAuthed = await this.checkAuthenticationStatus()
				if (!isAuthed) {
					if (this.config.clientID && this.config.clientSecret && !this.config.accessToken && !this.config.refreshToken) {
						this.log('info', 'Client credentials present without tokens. Starting OAuth login flow...')
						await this.RunAuthFlow()
					}
					if (!(await this.checkAuthenticationStatus())) {
						this.log('warn', 'Restream authentication incomplete or failed')
						return
					}
				}

				this.log('info', 'Restream module configuration updated successfully')
				this.updateStatus(InstanceStatus.Ok)

				if (this.streamMonitor) {
					if (this.config.enableWs === false) {
						this.streamMonitor.closeSocket()
					} else if (
						this.config.accessToken &&
						(this.config.accessToken !== oldToken || this.config.wsUrl !== oldWsUrl || oldEnableWs === false)
					) {
						this.streamMonitor.connect(this.config.accessToken, this.config.wsUrl)
					}
				}

				await this.poll()
				this.updateActions()
				this.updateFeedbacks()
				this.updateVariables()
				this.updatePresets()
			} catch (err) {
				this.log('error', `Config update background error: ${err.message}`)
			}
		})
	}

	/**
	 * Configuration fields displayed in Companion module settings.
	 */
	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Authentication Mode',
				value: 'You can authenticate either by providing a manual <b>Personal Access / Bearer Token</b> OR using <b>OAuth2 Client Credentials</b>.',
			},
			{
				type: 'textinput',
				id: 'accessToken',
				label: 'Access Token / Bearer Token (Manual or OAuth)',
				width: 12,
			},
			{
				type: 'textinput',
				id: 'authCode',
				label: 'OAuth Authorization Code (Paste "code=..." or full redirect URL to exchange automatically)',
				width: 12,
			},
			{
				type: 'textinput',
				id: 'refreshToken',
				label: 'Refresh Token (OAuth2 only)',
				width: 12,
			},
			{
				type: 'textinput',
				id: 'clientID',
				label: 'Client ID (OAuth2)',
				width: 6,
			},
			{
				type: 'textinput',
				id: 'clientSecret',
				label: 'Client Secret (OAuth2)',
				width: 6,
			},
			{
				type: 'textinput',
				id: 'redirectURL',
				label: 'OAuth Redirect URL',
				width: 6,
				default: 'http://localhost:8081',
			},
			{
				type: 'textinput',
				id: 'authURL',
				label: 'Generated Authorization URL',
				width: 6,
			},
			{
				type: 'static-text',
				id: 'monitoring_info',
				width: 12,
				label: 'Stream Monitoring & Polling',
				value: 'Configure real-time WebSocket stream telemetry and REST polling interval.',
			},
			{
				type: 'checkbox',
				id: 'enableWs',
				label: 'Enable Real-time WebSocket Monitoring',
				width: 6,
				default: true,
			},
			{
				type: 'textinput',
				id: 'wsUrl',
				label: 'WebSocket Telemetry URL',
				width: 6,
				default: 'wss://streaming.api.restream.io/ws',
			},
			{
				type: 'number',
				id: 'pollTime',
				label: 'REST Poll Interval (seconds)',
				width: 6,
				default: 30,
				min: 5,
				max: 3600,
			},
		]
	}

	/**
	 * Initialize Axios or Axios-compatible HTTP client with interceptors.
	 */
	initApiClient() {
		if (axios) {
			this.api = axios.create({
				baseURL: 'https://api.restream.io/v2',
				timeout: 15000,
			})
		} else {
			this.api = this.createFetchApiClient('https://api.restream.io/v2')
		}

		// Request Interceptor: Attach current Bearer token
		this.api.interceptors.request.use(
			(config) => {
				if (this.config.accessToken) {
					if (!config.headers) config.headers = {}
					config.headers['Authorization'] = `Bearer ${this.config.accessToken}`
				}
				return config
			},
			(error) => Promise.reject(error)
		)

		// Response Interceptor: Handle 429 Rate Limiting with backoff & 401 Unauthorized with token auto-refresh
		this.api.interceptors.response.use(
			(response) => response,
			async (error) => {
				const originalConfig = error.config

				// 1. Handle HTTP 429 Rate Limiting with backoff & single retry
				if (error.response && error.response.status === 429 && originalConfig && !originalConfig._retry429) {
					originalConfig._retry429 = true

					// Read Retry-After header if present
					let delayMs = 2000
					const headers = error.response.headers || {}
					const retryAfter =
						headers['retry-after'] ||
						(typeof headers.get === 'function' ? headers.get('retry-after') : null)

					if (retryAfter) {
						const parsed = Number(retryAfter)
						if (!isNaN(parsed) && parsed > 0) {
							delayMs = Math.min(parsed * 1000, 10000)
						}
					}

					this.log('warn', `Restream API rate limit (429) reached. Retrying request in ${delayMs}ms...`)
					await new Promise((resolve) => setTimeout(resolve, delayMs))

					if (this.destroyed) {
						return Promise.reject(new Error('Instance destroyed during rate limit backoff'))
					}

					return this.api.request(originalConfig)
				}

				// 2. Handle HTTP 401 Unauthorized with token auto-refresh
				if (error.response && error.response.status === 401 && originalConfig && !originalConfig._retry) {
					originalConfig._retry = true

					// Only attempt refresh if refreshToken and OAuth credentials are present
					if (this.config.refreshToken && this.config.clientID && this.config.clientSecret) {
						this.log('warn', 'Received 401 Unauthorized. Attempting token auto-refresh...')
						const refreshed = await this.RunRefreshFlow()
						if (refreshed) {
							if (!originalConfig.headers) originalConfig.headers = {}
							originalConfig.headers['Authorization'] = `Bearer ${this.config.accessToken}`
							return this.api.request(originalConfig)
						}
					} else {
						this.log('error', 'Received 401 Unauthorized: Access token invalid or expired.')
						this.updateStatus(InstanceStatus.AuthenticationFailure, 'Access token invalid or expired')
					}
				}
				return Promise.reject(error)
			}
		)
	}

	/**
	 * Creates a lightweight Axios-compatible API client backed by native fetch.
	 */
	createFetchApiClient(baseURL) {
		const reqInterceptors = []
		const resInterceptors = []

		const client = {
			defaults: { headers: { common: {} } },
			interceptors: {
				request: {
					use: (fulfilled, rejected) => {
						reqInterceptors.push({ fulfilled, rejected })
					},
				},
				response: {
					use: (fulfilled, rejected) => {
						resInterceptors.push({ fulfilled, rejected })
					},
				},
			},
			async request(config) {
				let cfg = { ...config }
				for (const interceptor of reqInterceptors) {
					if (interceptor.fulfilled) {
						try {
							cfg = await interceptor.fulfilled(cfg)
						} catch (err) {
							if (interceptor.rejected) return interceptor.rejected(err)
							throw err
						}
					}
				}

				let fullUrl = cfg.url.startsWith('http')
					? cfg.url
					: `${baseURL.replace(/\/+$/, '')}/${cfg.url.replace(/^\/+/, '')}`

				if (cfg.params && typeof cfg.params === 'object') {
					const urlObj = new URL(fullUrl)
					for (const [k, v] of Object.entries(cfg.params)) {
						if (v !== undefined && v !== null) {
							urlObj.searchParams.append(k, String(v))
						}
					}
					fullUrl = urlObj.toString()
				}

				const headers = { ...cfg.headers }
				let body = cfg.data
				if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
					headers['Content-Type'] = 'application/json'
					body = JSON.stringify(body)
				}

				let res
				let responseObj
				try {
					res = await fetch(fullUrl, {
						method: (cfg.method || 'GET').toUpperCase(),
						headers,
						body,
					})

					let headerEntries = {}
					if (res.headers) {
						if (typeof res.headers.entries === 'function') {
							try {
								headerEntries = Object.fromEntries(res.headers.entries())
							} catch {
								headerEntries = {}
							}
						} else if (typeof res.headers === 'object') {
							headerEntries = { ...res.headers }
						}
					}

					let data
					try {
						const contentType =
							(typeof res.headers?.get === 'function'
								? res.headers.get('content-type')
								: res.headers?.['content-type']) || ''
						if (typeof res.json === 'function' && (!contentType || contentType.includes('application/json'))) {
							data = await res.json()
						} else if (typeof res.text === 'function') {
							const text = await res.text()
							try {
								data = text && text.trim() ? JSON.parse(text) : {}
							} catch {
								data = text
							}
						} else {
							data = res.body || {}
						}
					} catch {
						data = {}
					}

					responseObj = {
						status: res.status,
						statusText: res.statusText,
						headers: headerEntries,
						data,
						config: cfg,
					}
				} catch (networkErr) {
					const error = new Error(networkErr.message)
					error.request = true
					error.config = cfg
					for (const interceptor of resInterceptors) {
						if (interceptor.rejected) {
							return interceptor.rejected(error)
						}
					}
					throw error
				}

				if (!res.ok) {
					const error = new Error(`Request failed with status code ${res.status}`)
					error.response = responseObj
					error.config = cfg
					for (const interceptor of resInterceptors) {
						if (interceptor.rejected) {
							return interceptor.rejected(error)
						}
					}
					throw error
				}

				let finalRes = responseObj
				for (const interceptor of resInterceptors) {
					if (interceptor.fulfilled) {
						finalRes = await interceptor.fulfilled(finalRes)
					}
				}
				return finalRes
			},
			get(url, config) {
				return this.request({ ...config, method: 'GET', url })
			},
			post(url, data, config) {
				return this.request({ ...config, method: 'POST', url, data })
			},
			patch(url, data, config) {
				return this.request({ ...config, method: 'PATCH', url, data })
			},
		}

		return client
	}

	/**
	 * Check configuration validity.
	 */
	checkConfiguration() {
		// Valid if manual accessToken is provided
		if (this.config.accessToken && this.config.accessToken.trim() !== '') {
			return true
		}

		// Valid if OAuth2 client credentials are provided
		if (this.config.clientID && this.config.clientSecret) {
			return true
		}

		this.log('warn', 'Missing configuration: Provide an Access Token or OAuth2 Client ID & Secret')
		this.updateStatus(InstanceStatus.BadConfig, 'Missing Access Token or Client Credentials')
		return false
	}

	/**
	 * Verify authentication status with Restream API.
	 */
	async checkAuthenticationStatus() {
		// If no access token but refresh token exists with credentials, run refresh
		if (!this.config.accessToken && this.config.refreshToken && this.config.clientID && this.config.clientSecret) {
			this.log('info', 'No access token found. Running refresh flow with refresh token...')
			const refreshed = await this.RunRefreshFlow()
			if (!refreshed) {
				this.updateStatus(InstanceStatus.AuthenticationFailure, 'OAuth refresh failed')
				return false
			}
		}

		if (!this.config.accessToken) {
			this.updateStatus(InstanceStatus.BadConfig, 'No Access Token available')
			return false
		}

		try {
			await this.api.request({
				method: 'get',
				url: '/user/profile',
			})
			return true
		} catch (error) {
			if (error.response && (error.response.status === 401 || error.response.status === 403)) {
				this.updateStatus(InstanceStatus.AuthenticationFailure, 'Unauthorized: Check token or credentials')
			} else if (error.response && error.response.status === 429) {
				this.updateStatus(InstanceStatus.UnknownError, 'API Rate Limit (429): Polling will resume shortly')
			} else if (error.request) {
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Cannot connect to Restream API')
			} else {
				this.updateStatus(InstanceStatus.UnknownError, error.message || 'API Error')
			}
			return false
		}
	}

	/**
	 * Update companion definitions.
	 */
	updateActions() {
		UpdateActions(this)
	}

	updateFeedbacks() {
		UpdateFeedbacks(this)
	}

	updateVariables() {
		UpdateVariables(this)
	}

	updatePresets() {
		UpdatePresets(this)
	}

	/**
	 * Poll Restream REST APIs (platforms, channels, channel-meta, and in-progress events).
	 */
	async poll() {
		if (this.pollInProgress) {
			this.pollQueued = true
			return
		}
		if (this.status === InstanceStatus.BadConfig || !this.config.accessToken) return

		this.pollInProgress = true

		try {
			do {
				this.pollQueued = false

				// Fetch platforms and channels
				const [platforms, channels, inProgressEvents] = await Promise.all([
					this.getPlatforms().catch((err) => {
						this.log('debug', `Error fetching platforms: ${err.message}`)
						return this.platforms || []
					}),
					this.getChannels().catch((err) => {
						this.log('debug', `Error fetching channels: ${err.message}`)
						return this.channels || []
					}),
					this.getInProgressEvents().catch((err) => {
						this.log('debug', `Error fetching in-progress events: ${err.message}`)
						return []
					}),
				])

				this.platforms = Array.isArray(platforms) ? platforms : []
				this.channels = Array.isArray(channels) ? channels : []

				// Fetch meta for each channel in parallel
				if (this.channels.length > 0) {
					await Promise.all(
						this.channels.map(async (channel) => {
							if (!channel || !channel.id) return
							channel.meta = (await this.getChannelMeta(channel.id).catch(() => ({}))) || {}
						})
					)
				}

				// Update stream telemetry from REST fallback events
				if (this.streamMonitor) {
					this.streamMonitor.updateFromRest(inProgressEvents)
				}

				if (this.destroyed) return

				// Update all Companion state
				this.updateFeedbacks()
				this.checkFeedbacks()
				this.updateActions()
				this.updateVariables()
				this.updatePresets()
			} while (this.pollQueued && !this.destroyed && this.config.accessToken)
		} catch (err) {
			this.log('error', `Error during API poll: ${err.message}`)
		} finally {
			this.pollInProgress = false
		}
	}

	/**
	 * Get list of streaming platforms.
	 */
	async getPlatforms() {
		const reqConfig = {
			method: 'get',
			url: '/platform/all',
		}
		const data = await this.apiWrapper(reqConfig)
		return Array.isArray(data) ? data : []
	}

	/**
	 * Get list of user's channels.
	 */
	async getChannels() {
		const reqConfig = {
			method: 'get',
			url: '/user/channel/all',
		}
		const data = await this.apiWrapper(reqConfig)
		return Array.isArray(data) ? data : []
	}

	/**
	 * Get in-progress streaming events (REST fallback for stream state).
	 */
	async getInProgressEvents() {
		const reqConfig = {
			method: 'get',
			url: '/user/events/in-progress',
		}
		try {
			const data = await this.apiWrapper(reqConfig)
			if (Array.isArray(data)) return data
			if (data && Array.isArray(data.events)) return data.events
			if (data && Array.isArray(data.result)) return data.result
			if (data && Array.isArray(data.data)) return data.data
			return data ? [data] : []
		} catch {
			return []
		}
	}

	/**
	 * Enable or disable a streaming channel.
	 * @param {object} options { channel: string, enabled: string|boolean }
	 */
	async setChannel(options) {
		if (!options || !options.channel) return
		const channelID = options.channel
		const isEnabled = options.enabled === 'true' || options.enabled === true

		this.log('info', `Setting channel ${channelID} state to ${isEnabled}`)

		const reqConfig = {
			method: 'patch',
			url: `/user/channel/${channelID}`,
			data: {
				active: isEnabled,
			},
		}

		await this.apiWrapper(reqConfig)

		// Update local channel cache immediately for snappy feedback
		const target = this.channels.find((ch) => ch && String(ch.id) === String(channelID))
		if (target) {
			target.active = isEnabled
			target.enabled = isEnabled
			this.updateFeedbacks()
			this.checkFeedbacks('ChannelState')
			this.updateVariables()
		}

		// Trigger background poll to sync fully
		this.poll().catch(() => {})
	}

	/**
	 * Fetch channel metadata (title, description, etc.).
	 */
	async getChannelMeta(channelID) {
		if (!channelID) return {}
		const reqConfig = {
			method: 'get',
			url: `/user/channel-meta/${channelID}`,
		}
		try {
			const meta = await this.apiWrapper(reqConfig)
			return meta && typeof meta === 'object' ? meta : {}
		} catch {
			return {}
		}
	}

	/**
	 * Update channel title and description.
	 */
	async setChannelMeta(channelID, title, description) {
		if (!channelID) return
		const reqConfig = {
			method: 'patch',
			url: `/user/channel-meta/${channelID}`,
			data: {
				title: title || '',
				...(description !== undefined ? { description } : {}),
			},
		}
		await this.apiWrapper(reqConfig)

		// Update local channel cache immediately for snappy UI responsiveness
		const target = this.channels.find((ch) => ch && String(ch.id) === String(channelID))
		if (target) {
			if (!target.meta || typeof target.meta !== 'object') {
				target.meta = {}
			}
			target.meta.title = title || ''
			if (description !== undefined) {
				target.meta.description = description
			}
			this.updateVariables()
		}

		this.poll().catch(() => {})
	}

	RunAuthFlow() {
		// Return existing auth flow if in progress
		if (this._authPromise) {
			return this._authPromise
		}

		if (!this.config.clientID || !this.config.clientSecret) {
			this.log('error', 'Cannot start OAuth flow: Missing Client ID or Client Secret')
			this.updateStatus(InstanceStatus.BadConfig, 'Missing Client ID or Client Secret')
			return Promise.resolve(false)
		}

		if (this.callbackServer) {
			this.callbackServer.abort()
			this.callbackServer = null
		}

		this._authPromise = (async () => {
			const redirectUri = this.config.redirectURL || 'http://localhost:8081'
			let port = 8081
			let host = 'localhost'
			try {
				const u = new URL(redirectUri)
				port = Number(u.port) || 8081
				host = u.hostname || 'localhost'
			} catch {
				// Fallback defaults
			}

			const authorizationUri = `https://api.restream.io/login?response_type=code&client_id=${encodeURIComponent(
				this.config.clientID || ''
			)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=companion_restream`

			this.config.authURL = authorizationUri
			this.saveConfig(this.config)

			this.callbackServer = new HttpReceiver(host, port, 120000)

			try {
				this.log('info', `Waiting for OAuth callback on ${redirectUri}...`)
				const code = await this.callbackServer.getCode(() => {
					if (openBrowser) {
						openBrowser(authorizationUri, { wait: false })
							.then((cp) => cp && typeof cp.unref === 'function' && cp.unref())
							.catch(() => {})
					}
				})

				if (!code) {
					throw new Error('No authorization code received')
				}

				// Exchange authorization code for tokens
				const params = new URLSearchParams()
				params.append('grant_type', 'authorization_code')
				params.append('redirect_uri', redirectUri)
				params.append('code', code)
				params.append('client_id', this.config.clientID)
				params.append('client_secret', this.config.clientSecret)

				const authHeader = 'Basic ' + Buffer.from(`${this.config.clientID}:${this.config.clientSecret}`).toString('base64')

				let tokenData
				if (axios) {
					const response = await axios.post('https://api.restream.io/oauth/token', params.toString(), {
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
							Authorization: authHeader,
						},
						timeout: 10000,
					})
					tokenData = response.data
				} else {
					const res = await fetch('https://api.restream.io/oauth/token', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
							Authorization: authHeader,
						},
						body: params.toString(),
					})
					if (!res.ok) throw new Error(`OAuth token exchange failed: HTTP ${res.status}`)
					tokenData = await res.json()
				}

				if (tokenData && (tokenData.accessToken || tokenData.access_token)) {
					this.log('info', 'OAuth authorization successful. Tokens stored.')
					this.config.accessToken = tokenData.accessToken || tokenData.access_token
					this.config.refreshToken = tokenData.refreshToken || tokenData.refresh_token || this.config.refreshToken
					this.saveConfig(this.config)
					this.updateStatus(InstanceStatus.Ok)

					if (this.streamMonitor && this.config.enableWs !== false) {
						this.streamMonitor.connect(this.config.accessToken, this.config.wsUrl)
					}
					return true
				}
				return false
			} catch (err) {
				this.log('error', `OAuth Flow Error: ${err.message}`)
				this.updateStatus(InstanceStatus.AuthenticationFailure, `OAuth error: ${err.message}`)
				return false
			} finally {
				if (this.callbackServer) {
					this.callbackServer.abort()
					this.callbackServer = null
				}
				this._authPromise = null
			}
		})()

		return this._authPromise
	}

	/**
	 * Exchanges an OAuth authorization code manually pasted by the user.
	 * @param {string} code Authorization code or full redirect URL
	 */
	async exchangeAuthCode(code) {
		if (!code || typeof code !== 'string' || code.trim() === '') return false

		let cleanCode = code.trim()
		if (cleanCode.includes('code=')) {
			cleanCode = cleanCode.split('code=')[1].split('&')[0]
		}

		if (!this.config.clientID || !this.config.clientSecret) {
			this.log('warn', 'Cannot exchange authorization code: Missing Client ID or Client Secret')
			return false
		}

		try {
			this.log('info', 'Exchanging OAuth authorization code for Access Token...')
			const params = new URLSearchParams()
			params.append('grant_type', 'authorization_code')
			params.append('redirect_uri', this.config.redirectURL || 'http://192.168.1.160:8000/')
			params.append('code', cleanCode)

			const authHeader = 'Basic ' + Buffer.from(`${this.config.clientID}:${this.config.clientSecret}`).toString('base64')
			let tokenData

			if (axios) {
				const response = await axios.post('https://api.restream.io/oauth/token', params, {
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						Authorization: authHeader,
					},
					timeout: 10000,
				})
				tokenData = response.data
			} else {
				const res = await fetch('https://api.restream.io/oauth/token', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						Authorization: authHeader,
					},
					body: params.toString(),
				})
				tokenData = await res.json()
			}

			if (tokenData && (tokenData.accessToken || tokenData.access_token)) {
				this.config.accessToken = tokenData.accessToken || tokenData.access_token
				this.config.refreshToken = tokenData.refreshToken || tokenData.refresh_token || this.config.refreshToken
				this.config.authCode = '' // Consumed
				this.saveConfig(this.config)
				this.log('info', 'Successfully exchanged authorization code for Access Token and saved!')
				this.updateStatus(InstanceStatus.Ok)

				if (this.streamMonitor && this.config.enableWs !== false) {
					this.streamMonitor.connect(this.config.accessToken, this.config.wsUrl)
				}
				await this.poll()
				return true
			} else {
				this.log('error', `Token exchange failed: ${JSON.stringify(tokenData)}`)
				return false
			}
		} catch (err) {
			const errMsg = err.response?.data?.message || err.message
			this.log('error', `Failed to exchange authorization code: ${errMsg}`)
			return false
		}
	}

	RunRefreshFlow() {
		// Mutex: Return existing promise if refresh is already in progress
		if (this._refreshPromise) {
			return this._refreshPromise
		}

		if (!this.config.refreshToken) {
			this.log('error', 'Cannot refresh token: Missing Refresh Token')
			return Promise.resolve(false)
		}
		if (!this.config.clientID || !this.config.clientSecret) {
			this.log('error', 'Cannot refresh token: Missing Client ID or Client Secret')
			return Promise.resolve(false)
		}

		this.log('info', 'Refreshing OAuth Access Token...')

		this._refreshPromise = (async () => {
			try {
				const params = new URLSearchParams()
				params.append('grant_type', 'refresh_token')
				params.append('refresh_token', this.config.refreshToken)
				params.append('client_id', this.config.clientID)
				params.append('client_secret', this.config.clientSecret)

				const authHeader = 'Basic ' + Buffer.from(`${this.config.clientID}:${this.config.clientSecret}`).toString('base64')

				let tokenData
				if (axios) {
					const response = await axios.post('https://api.restream.io/oauth/token', params.toString(), {
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
							Authorization: authHeader,
						},
						timeout: 10000,
					})
					tokenData = response.data
				} else {
					const res = await fetch('https://api.restream.io/oauth/token', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
							Authorization: authHeader,
						},
						body: params.toString(),
					})
					if (!res.ok) {
						const errObj = new Error(`HTTP ${res.status}`)
						errObj.response = { status: res.status }
						throw errObj
					}
					tokenData = await res.json()
				}

				if (tokenData && (tokenData.accessToken || tokenData.access_token)) {
					this.log('info', 'Token refresh successful. New tokens saved.')
					this.config.accessToken = tokenData.accessToken || tokenData.access_token
					if (tokenData.refreshToken || tokenData.refresh_token) {
						this.config.refreshToken = tokenData.refreshToken || tokenData.refresh_token
					}
					this.saveConfig(this.config)
					this.updateStatus(InstanceStatus.Ok)

					// Reconnect WebSocket with new token
					if (this.streamMonitor && this.config.enableWs !== false) {
						this.streamMonitor.connect(this.config.accessToken, this.config.wsUrl)
					}
					return true
				}
				return false
			} catch (err) {
				this.log('error', `Token refresh failed: ${err.message}`)
				if (err.response && err.response.status === 400) {
					this.log('error', 'Refresh Token Expired. Please re-authenticate via OAuth.')
					this.updateStatus(InstanceStatus.BadConfig, 'Refresh Token Expired')
				} else if (err.response && (err.response.status === 401 || err.response.status === 403)) {
					this.log('error', 'OAuth Client Credentials Invalid (401/403).')
					this.updateStatus(InstanceStatus.AuthenticationFailure, 'OAuth Client Credentials Invalid')
				} else if (err.response && err.response.status === 429) {
					this.log('warn', 'Token refresh rate limited (429).')
					this.updateStatus(InstanceStatus.ConnectionFailure, 'Token Refresh Rate Limited (429)')
				} else {
					this.updateStatus(InstanceStatus.ConnectionFailure, 'Failed to refresh access token')
				}
				return false
			} finally {
				this._refreshPromise = null
			}
		})()

		return this._refreshPromise
	}

	/**
	 * Generic API request wrapper with standardized logging.
	 */
	async apiWrapper(reqConfig) {
		try {
			const res = await this.api.request(reqConfig)
			return res.data
		} catch (err) {
			if (err.response) {
				this.log('error', `Restream API error (${err.response.status}): ${JSON.stringify(err.response.data || '')}`)
			} else if (err.request) {
				this.log('error', 'Network error connecting to Restream API')
			} else {
				this.log('error', `API Request error: ${err.message}`)
			}
			throw err
		}
	}

	updateStatus(status, message) {
		this.status = status
		super.updateStatus(status, message)
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)

module.exports = ModuleInstance
