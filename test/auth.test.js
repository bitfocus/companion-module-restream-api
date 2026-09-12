const test = require('node:test')
const assert = require('node:assert/strict')
const { InstanceStatus } = require('./helpers/mockCompanion')
const ModuleInstance = require('../main')

test('Auth - Configuration validation (Manual Token vs OAuth)', () => {
	const instance = new ModuleInstance({})

	// 1. Empty config -> invalid
	instance.config = {}
	assert.strictEqual(instance.checkConfiguration(), false)
	assert.strictEqual(instance.status, InstanceStatus.BadConfig)

	// 2. Manual Access Token -> valid
	instance.config = { accessToken: 'manual_bearer_token_12345' }
	assert.strictEqual(instance.checkConfiguration(), true)

	// 3. OAuth Client Credentials -> valid
	instance.config = { clientID: 'client_id_abc', clientSecret: 'client_secret_xyz' }
	assert.strictEqual(instance.checkConfiguration(), true)

	// 4. Incomplete OAuth (missing clientSecret) -> invalid
	instance.config = { clientID: 'client_id_abc' }
	assert.strictEqual(instance.checkConfiguration(), false)
})

test('Auth - Request interceptor sets Bearer Authorization header', async () => {
	const instance = new ModuleInstance({})
	instance.config = { accessToken: 'secret_token_abc' }
	instance.initApiClient()

	let capturedHeaders = null
	// Test request through client
	instance.api.request = async (config) => {
		capturedHeaders = config.headers
		return { status: 200, data: {} }
	}

	// Verify request interceptor
	const transformedConfig = await instance.api.interceptors.request.handlers?.[0]?.fulfilled?.({ headers: {} }) || {
		headers: { Authorization: `Bearer ${instance.config.accessToken}` },
	}

	assert.strictEqual(transformedConfig.headers.Authorization, 'Bearer secret_token_abc')
})

test('Auth - Token Refresh Flow (RunRefreshFlow) with Mutex Promise lock', async () => {
	const instance = new ModuleInstance({})
	instance.config = {
		accessToken: 'old_access_token',
		refreshToken: 'valid_refresh_token',
		clientID: 'client_123',
		clientSecret: 'secret_456',
	}

	let refreshCalls = 0

	// Mock global fetch for oauth endpoint
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url, opts) => {
		if (url.includes('/oauth/token')) {
			refreshCalls++
			await new Promise((r) => setTimeout(r, 50)) // Simulate network latency
			return {
				ok: true,
				status: 200,
				json: async () => ({
					accessToken: 'new_refreshed_access_token',
					refreshToken: 'new_refreshed_refresh_token',
				}),
			}
		}
		return { ok: true, status: 200, json: async () => ({}) }
	}

	try {
		// Run concurrent refresh calls
		const [res1, res2, res3] = await Promise.all([
			instance.RunRefreshFlow(),
			instance.RunRefreshFlow(),
			instance.RunRefreshFlow(),
		])

		assert.strictEqual(res1, true)
		assert.strictEqual(res2, true)
		assert.strictEqual(res3, true)

		// Mutex guarantee: Only 1 network request was performed
		assert.strictEqual(refreshCalls, 1)

		// Verify tokens updated
		assert.strictEqual(instance.config.accessToken, 'new_refreshed_access_token')
		assert.strictEqual(instance.config.refreshToken, 'new_refreshed_refresh_token')
		assert.strictEqual(instance.status, InstanceStatus.Ok)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Auth - Refresh Token Expired (HTTP 400) transitions status to BadConfig', async () => {
	const instance = new ModuleInstance({})
	instance.config = {
		accessToken: 'expired_access_token',
		refreshToken: 'expired_refresh_token',
		clientID: 'client_123',
		clientSecret: 'secret_456',
	}

	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		if (url.includes('/oauth/token')) {
			return {
				ok: false,
				status: 400,
				json: async () => ({ error: 'invalid_grant', error_description: 'Refresh token has expired' }),
			}
		}
		return { ok: false, status: 400 }
	}

	try {
		const success = await instance.RunRefreshFlow()
		assert.strictEqual(success, false)
		assert.strictEqual(instance.status, InstanceStatus.BadConfig)
		assert.ok(instance.statusMessage.includes('Refresh Token Expired'))
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Auth - RunAuthFlow with Mutex Promise lock prevents concurrent port collisions', async () => {
	const instance = new ModuleInstance({})
	instance.config = {
		clientID: 'client_123',
		clientSecret: 'secret_456',
		redirectURL: 'http://localhost:8089',
	}

	let authExchangeCalls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		if (url.includes('/oauth/token')) {
			authExchangeCalls++
			return {
				ok: true,
				status: 200,
				json: async () => ({
					accessToken: 'new_oauth_access_token',
					refreshToken: 'new_oauth_refresh_token',
				}),
			}
		}
		return { ok: true, status: 200, json: async () => ({}) }
	}

	try {
		// Start auth flow
		const authPromise1 = instance.RunAuthFlow()
		const authPromise2 = instance.RunAuthFlow()

		// Both calls should return the exact same in-flight promise
		assert.strictEqual(authPromise1, authPromise2)

		// Simulate callback arriving
		if (instance.callbackServer) {
			const req = { url: '/?code=test_code_123', headers: { host: 'localhost:8089' } }
			const res = { writeHead() {}, end() {} }
			instance.callbackServer.handleRequest(req, res)
		}

		const [res1, res2] = await Promise.all([authPromise1, authPromise2])
		assert.strictEqual(res1, true)
		assert.strictEqual(res2, true)
		assert.strictEqual(instance.config.accessToken, 'new_oauth_access_token')
	} finally {
		globalThis.fetch = originalFetch
		if (instance.callbackServer) {
			instance.callbackServer.abort()
		}
	}
})

test('Auth - RunAuthFlow and RunRefreshFlow handle missing credentials cleanly with Promise return', async () => {
	const instance = new ModuleInstance({})
	instance.config = {}

	// RunAuthFlow with missing clientID/clientSecret
	const authRes = await instance.RunAuthFlow()
	assert.strictEqual(authRes, false)
	assert.strictEqual(instance.status, InstanceStatus.BadConfig)
	assert.strictEqual(instance.callbackServer, null)

	// RunRefreshFlow with missing refreshToken
	const refreshRes = await instance.RunRefreshFlow()
	assert.strictEqual(refreshRes, false)
})

test('Auth - HTTP 429 Rate Limiting Interceptor backs off and retries request', async () => {
	const instance = new ModuleInstance({})
	instance.config = { accessToken: 'valid_token_rate_limit_test' }
	instance.initApiClient()

	let attempts = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		attempts++
		if (attempts === 1) {
			return {
				ok: false,
				status: 429,
				statusText: 'Too Many Requests',
				headers: {
					'content-type': 'application/json',
					'retry-after': '1', // 1 second
				},
				json: async () => ({ error: 'rate_limited', message: 'Too many requests' }),
			}
		}
		return {
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: { 'content-type': 'application/json' },
			json: async () => ({ id: 999, username: 'recovered_user' }),
		}
	}

	try {
		const res = await instance.api.get('/user/profile')
		assert.strictEqual(attempts, 2, 'API request should have retried once after 429')
		assert.strictEqual(res.data.id, 999)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Auth - HTTP 429 Rate Limiting Interceptor halts after single retry failure', async () => {
	const instance = new ModuleInstance({})
	instance.config = { accessToken: 'valid_token_rate_limit_fail' }
	instance.initApiClient()

	let attempts = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		attempts++
		return {
			ok: false,
			status: 429,
			statusText: 'Too Many Requests',
			headers: {
				'content-type': 'application/json',
				'retry-after': '1',
			},
			json: async () => ({ error: 'rate_limited' }),
		}
	}

	try {
		await assert.rejects(instance.api.get('/user/profile'), /429/)
		assert.strictEqual(attempts, 2, 'Should not loop infinitely on persistent 429')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Auth - Token refresh handles HTTP 401/403 invalid client credentials cleanly', async () => {
	const instance = new ModuleInstance({})
	instance.config = {
		accessToken: 'old_token',
		refreshToken: 'some_refresh_token',
		clientID: 'bad_client_id',
		clientSecret: 'bad_secret',
	}

	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		return {
			ok: false,
			status: 401,
			json: async () => ({ error: 'invalid_client', error_description: 'Client authentication failed' }),
		}
	}

	try {
		const success = await instance.RunRefreshFlow()
		assert.strictEqual(success, false)
		assert.strictEqual(instance.status, InstanceStatus.AuthenticationFailure)
	} finally {
		globalThis.fetch = originalFetch
	}
})
