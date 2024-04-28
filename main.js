const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const UpdateActions = require('./actions')
const UpdateFeedbacks = require('./feedbacks')
const UpdateVariables = require('./variables')
const async = require('async')
const axios = require('axios')
const opn = require('open')

class ModuleInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	async init(config) {
		this.config = config
		this.stat
		this.isAlreadyRefreshingToken = false

		//Base Api client
		this.api = axios.create({
			baseURL: 'https://api.restream.io/v2',
		})

		//Add Authorization header
		this.api.interceptors.request.use(
			(config) => {
				config.headers.Authorization = `Bearer ${this.config.accessToken}`
				return config
			},
			function (error) {
				return Promise.reject(error)
			}
		)

		//Handle Refresh Token
		this.api.interceptors.response.use(
			(res) => {
				return res
			},
			async (error) => {
				const originalConfig = error.config
				if (error.response) {
					if (error.response.status === 401 && !originalConfig._retry) {
						originalConfig._retry = true

						await this.RunRefreshFlow()
						return this.api.request(originalConfig)
					}
				}
				return Promise.reject(error)
			}
		)

		if (this.checkConfiguration()) {
			//Check Authentication
			if (await this.checkAuthenticationStatus()) {
				this.log('info', 'Successfully connected to Restream')
				this.updateStatus(InstanceStatus.Ok)
			}
		}

		this.pollTime = this.config.pollTime ? this.config.pollTime * 1000 : 30000
		this.timedPoll = this.poll.bind(this)
		if (this.pollTime > 0) {
			this.poll_interval = setInterval(this.timedPoll, this.pollTime) //ms for poll
		}

		//Wait for a poll to complete
		await this.poll()
	}

	// When module gets deleted
	async destroy() {
		this.log('debug', 'destroy')
	}

	async configUpdated(config) {
		this.config = config
		if (!this.checkConfiguration()) {
			//Missing configuration values
			return
		}
		//Check authentication status
		if (!(await this.checkAuthenticationStatus())) {
			//Current Authentication status bad, attempt to rerun auth flow
			console.log('Authentication failed - Running auth flow')
			config.authURL = `https://api.restream.io/login?response_type=code&client_id=${config.clientID}&redirect_uri=${config.redirectURL}&state=state`
			this.saveConfig(config)

			this.RunAuthFlow()

			return
		}

		//Authentication status good
		this.log('info', 'Successfully connected to Restream')
		this.updateStatus(InstanceStatus.Ok)

		//Reset poll interval incase value changed
		clearInterval(this.poll_interval)
		this.pollTime = this.config.pollTime ? this.config.pollTime * 1000 : 30000
		if (this.pollTime > 0) {
			this.poll_interval = setInterval(this.timedPoll, this.pollTime) //ms for poll
		}

		//Manually Retrigger Poll
		await this.poll()

		//Update Actions/Feedbacks
		this.updateActions()
		this.updateFeedbacks()

		//Save Configuration
		this.saveConfig(config)
	}

	// Return config fields for web config
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'pollTime',
				label: 'Poll Interval (seconds)',
				width: 3,
				default: 30,
				regex: Regex.NUMBER,
			},
			{
				type: 'textinput',
				id: 'clientID',
				label: 'Client ID',
				width: 12,
				regex: Regex.SOMETHING,
			},
			{
				type: 'textinput',
				id: 'clientSecret',
				label: 'Client Secret',
				width: 12,
				regex: Regex.SOMETHING,
			},
			{
				type: 'textinput',
				id: 'redirectURL',
				label: 'Redirect URL',
				width: 8,
				default: 'https://bitfocus.github.io/companion-oauth/callback',
				regex: Regex.SOMETHING,
			},
			{
				type: 'textinput',
				id: 'authURL',
				label: 'Authorization URL (set automatically)',
				width: 12,
			},
			{
				type: 'textinput',
				id: 'accessToken',
				label: 'Access Token',
				width: 12,
			},
			{
				type: 'textinput',
				id: 'refreshToken',
				label: 'Refresh Token',
				width: 12,
			},
		]
	}

	async handleHttpRequest(request) {
		if (request.path === '/oauth/callback') {
			const authCode = request.query['code']
			if (!authCode) {
				return {
					status: 400,
					body: 'Missing auth code!',
				}
			}

			if (!this.config.clientID || !this.config.clientSecret || !this.config.redirectURL) {
				return {
					status: 400,
					body: 'Missing required config fields!',
				}
			}

			try {
				//Exchange code for token
				const params = new URLSearchParams()
				params.append('grant_type', 'authorization_code')
				params.append('redirect_uri', this.config.redirectURL)
				params.append('code', authCode)

				const response = await axios.post('https://api.restream.io/oauth/token', params, {
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					auth: {
						username: this.config.clientID,
						password: this.config.clientSecret,
					},
				})
				if (response.status == 200) {
					//Save new values to Configuration
					this.log('info', 'Authentication Success, saving tokens')
					this.config.accessToken = response.data.accessToken
					this.config.refreshToken = response.data.refreshToken
					this.saveConfig(this.config)

					this.configUpdated(this.config)
				}
			} catch (err) {
				this.log('debug', `Failed to get access token: ${err?.message ?? err?.toString()}`)
				return {
					status: 500,
					body: `Failed to authenticate\n${err?.message ?? err?.toString()}`,
				}
			}

			return {
				status: 200,
				body: 'Success!\nYou can close this tab',
			}
		}

		return {
			status: 404,
		}
	}

	updateActions() {
		if (this.status != InstanceStatus.BadConfig) {
			console.log('Updating Actions')
			UpdateActions(this)
		}
	}

	updateFeedbacks() {
		if (this.status != InstanceStatus.BadConfig) {
			UpdateFeedbacks(this)
		}
	}

	updateVariables() {
		if (this.status != InstanceStatus.BadConfig) {
			UpdateVariables(this)
		}
	}

	async poll() {
		console.log('Polling APIs')
		if (this.pollInProgress) {
			console.log('Poll already in progress, skipping')
			return
		}

		if (this.status == InstanceStatus.BadConfig) {
			console.log('Bad Configuration, skipping poll')
			return
		}

		this.pollInProgress = true

		this.platforms = await this.getPlatforms()
		this.channels = await this.getChannels()

		//Retrieve meta for each channel in parallel
		await async
			.each(this.channels, async (channel) => {
				// Skip if channel is Custom RTMP (channel.streamingPlatformId == 29)
				if (channel.streamingPlatformId == 29) return

				//Get Channel Meta
				channel.meta = await this.getChannelMeta(channel.id)
			})
			.then(() => {
				//Update Feedbacks
				this.updateFeedbacks()

				//Check Feedbacks
				this.checkFeedbacks()

				//Update Actions
				this.updateActions()

				//Update Variables
				this.updateVariables()
			})
			.finally(() => {
				this.pollInProgress = false
			})
	}

	//Checks that needed configuration values are present
	checkConfiguration() {
		console.log('Checking Configuration')
		if (!this.config.clientID) {
			//Missing Client ID
			this.log('error', 'Missing Client ID')
			this.updateStatus(InstanceStatus.BadConfig, 'Missing Client ID')
			return false
		}
		if (!this.config.clientSecret) {
			//Missing Client Secret
			this.log('error', 'Missing Client Secret')
			this.updateStatus(InstanceStatus.BadConfig, 'Missing Client Secret')
			return false
		}
		return true
	}

	async checkAuthenticationStatus() {
		console.log('Checking Authentication Status')
		var config = this.config
		//No refresh token or access token
		if (!config.refreshToken && !config.accessToken) {
			this.log('error', 'Missing Refresh Token and Access Token')
			this.updateStatus(InstanceStatus.BadConfig)
			return false
		}

		//If there is a refresh token, try to get access token
		if (config.refreshToken && !config.accessToken) {
			this.log('warn', 'Missing Access Token, attempting to run refresh flow')
			if (!(await this.RunRefreshFlow())) {
				//Failed to get access token
				this.log('error', 'Failed to get access token')
				this.updateStatus(InstanceStatus.BadConfig)
				return false
			}
		}

		console.log('Making test request to restream api')
		await this.api
			.request({
				//make request to restream profile endpoint
				method: 'get',
				url: '/user/profile',
			})
			.then((response) => {
				console.log('Test request successful')
			})
			.catch((error) => {
				this.updateStatus(InstanceStatus.Error)
				return false
			})

		return true
	}

	async getPlatforms() {
		//TODO: Use API Wrapper?
		//Endpoint doesn't need authentication
		//But would be nice to have error handling that wrapper provides
		console.log('Getting Platforms')
		var config = {
			method: 'get',
			url: 'https://api.restream.io/v2/platform/all',
		}

		var response = await axios(config)
		var platforms = response.data
		return platforms
	}

	async getChannels() {
		console.log('Getting Channels')
		var reqconfig = {
			method: 'get',
			url: '/user/channel/all',
		}

		const channels = await this.apiWrapper(reqconfig)
		return channels
	}

	async setChannel(options) {
		console.log('Setting Channel options:', options)
		const channelID = options.channel
		const enabled = options.enabled
		const reqconfig = {
			method: 'patch',
			url: `/user/channel/${channelID}`,
			data: {
				active: JSON.parse(enabled),
			},
		}

		await this.apiWrapper(reqconfig)

		//Manually Poll
		this.poll()
	}

	async getChannelMeta(channelID) {
		console.log('Getting Channel Meta')
		const reqconfig = {
			method: 'get',
			url: `/user/channel-meta/${channelID}`,
		}

		var meta = {}

		try {
			meta = await this.apiWrapper(reqconfig)
		} catch (error) {
			console.log('Error getting channel meta:', error)
		}

		return meta
	}

	async setChannelMeta(channelID, title) {
		const reqconfig = {
			method: 'patch',
			url: `/user/channel-meta/${channelID}`,
			data: {
				title: title,
			},
		}

		await this.apiWrapper(reqconfig)
	}

	async getStreamKey() {
		const reqconfig = {
			method: 'get',
			url: `/user/streamKey`,
		}

		const res = await this.apiWrapper(reqconfig)
		const key = res.streamKey
		return key
	}

	RunAuthFlow() {
		const authorizationUri = `https://api.restream.io/login?response_type=code&client_id=${this.config.clientID}&redirect_uri=${this.config.redirectURL}&state=${this.id}`

		this.config.authURL = authorizationUri
		this.saveConfig(this.config)

		opn(authorizationUri, { wait: false }).then((cp) => cp.unref())
	}

	async RunRefreshFlow() {
		if (this._refreshFlowRunning) {
			//TODO: If it is already running, but immediately returns, the API may retry the request before the refreshFlow Completes
			console.log('Already attempting to refresh Token')
			return
		}
		if (!this.config.refreshToken) {
			this.log('error', 'Missing Refresh Token')
			return
		}
		if (!this.config.clientID) {
			this.log('error', 'Missing Client ID')
			return
		}
		if (!this.config.clientSecret) {
			this.log('error', 'Missing Client Secret')
			return
		}

		console.log('Fetching new access Token')
		this._refreshFlowRunning = true
		const params = new URLSearchParams()
		params.append('grant_type', 'refresh_token')
		params.append('refresh_token', this.config.refreshToken)

		var response = await axios
			.post('https://api.restream.io/oauth/token', params, {
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				auth: {
					username: this.config.clientID,
					password: this.config.clientSecret,
				},
			})
			.catch((err) => {
				if (err.response) {
					// The client was given an error response (5xx, 4xx)
					console.log(err.response.data)
					console.log(err.response.status)
					console.log(err.response.headers)
					if (err.response.status == 400) {
						this.log('error', 'Refresh Token Expired, please reauthenticate')
						this.updateStatus(InstanceStatus.BadConfig, 'Refresh Token Expired')
						this.saveConfig(this.config)
					}
				} else if (err.request) {
					this.log('error', 'Unable to connect to Restream API')
					this.updateStatus(InstanceStatus.ConnectionFailure, 'Unable to connect to Restream API')
				} else {
					this.log('error', 'Unknown Error while attempting to refresh token')
					this.updateStatus(InstanceStatus.UnknownError, 'Unknown Error')
				}
			})
		if (response.status != 200) {
			this.log('error', 'Unable to refresh token')
			this._refreshFlowRunning = false
			return false
		}

		this.log('info', 'Refresh Token Success, saving tokens')
		this.config.accessToken = response.data.accessToken
		this.config.refreshToken = response.data.refreshToken
		this.saveConfig(this.config)

		//Set api client auth header to new token
		this.api.headers['Authorization'] = `Bearer ${this.config.accessToken}`
		this.updateStatus(InstanceStatus.Ok)
		return true
	}

	async apiWrapper(reqconfig) {
		var response
		await this.api
			.request(reqconfig)
			.then(function (res) {
				response = res
			})
			.catch((err) => {
				if (err.response) {
					// The client was given an error response (5xx, 4xx)
					console.log(err.response.data)
					console.log(err.response.status)
					console.log(err.response.headers)
					this.log('error', 'Bad Response from Restream API - ' + err.response.status)
				} else if (err.request) {
					this.log('error', 'Error connecting to restream API')
				} else {
					this.log('error', 'Unknown Error')
				}
				return
			})
		return response.data
	}

	updateStatus(status, message) {
		this.status = status
		super.updateStatus(status, message)
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
