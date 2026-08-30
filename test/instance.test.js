const test = require('node:test')
const assert = require('node:assert/strict')
const { InstanceStatus } = require('./helpers/mockCompanion')
const ModuleInstance = require('../main')

test('ModuleInstance - Complete Lifecycle (init, poll, setChannel, setChannelMeta, destroy)', async () => {
	const instance = new ModuleInstance({})

	let patchedChannel = null
	let patchedMeta = null

	// Mock REST API endpoints
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url, opts) => {
		const u = String(url)
		const method = opts?.method || 'GET'

		if (u.includes('/user/profile')) {
			return {
				ok: true,
				status: 200,
				headers: new Headers({ 'content-type': 'application/json' }),
				json: async () => ({ id: 123, username: 'testuser' }),
			}
		}
		if (u.includes('/platform/all')) {
			return {
				ok: true,
				status: 200,
				headers: new Headers({ 'content-type': 'application/json' }),
				json: async () => [
					{ id: 1, name: 'YouTube' },
					{ id: 2, name: 'Twitch' },
				],
			}
		}
		if (u.includes('/user/channel/all')) {
			return {
				ok: true,
				status: 200,
				headers: new Headers({ 'content-type': 'application/json' }),
				json: async () => [
					{ id: 10, displayName: 'YT Primary', streamingPlatformId: 1, active: true },
					{ id: 20, displayName: 'Twitch Secondary', streamingPlatformId: 2, active: false },
				],
			}
		}
		if (u.includes('/user/channel-meta/')) {
			if (method === 'PATCH') {
				patchedMeta = { url: u, body: JSON.parse(opts.body) }
				return {
					ok: true,
					status: 200,
					headers: new Headers({ 'content-type': 'application/json' }),
					json: async () => patchedMeta.body,
				}
			}
			return {
				ok: true,
				status: 200,
				headers: new Headers({ 'content-type': 'application/json' }),
				json: async () => ({ title: 'Live Stream Title', description: 'Description text' }),
			}
		}
		if (u.includes('/user/channel/')) {
			if (method === 'PATCH') {
				patchedChannel = { url: u, body: JSON.parse(opts.body) }
				return {
					ok: true,
					status: 200,
					headers: new Headers({ 'content-type': 'application/json' }),
					json: async () => ({ id: 10, ...patchedChannel.body }),
				}
			}
		}
		if (u.includes('/user/events/in-progress')) {
			return {
				ok: true,
				status: 200,
				headers: new Headers({ 'content-type': 'application/json' }),
				json: async () => [
					{
						id: 99,
						title: 'Sunday Live Event',
						status: 'in-progress',
						streamHealth: {
							fps: 60,
							bitrate: 6000000,
							resolution: '1920x1080',
							videoCodec: 'h264',
							audioCodec: 'aac',
						},
					},
				],
			}
		}
		return {
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({}),
		}
	}

	try {
		// 1. Initialize instance with valid manual access token
		await instance.init({
			accessToken: 'valid_manual_token_abc',
			pollTime: 10,
			enableWs: false, // disable live WS for deterministic lifecycle test
		})

		assert.strictEqual(instance.status, InstanceStatus.Ok)
		assert.strictEqual(instance.channels.length, 2)
		assert.strictEqual(instance.platforms.length, 2)
		assert.strictEqual(instance.channels[0].meta.title, 'Live Stream Title')

		// Stream state from REST fallback in-progress event
		assert.strictEqual(instance.streamData.status, 'LIVE')
		assert.strictEqual(instance.streamData.isStreaming, true)
		assert.strictEqual(instance.streamData.fps, 60)
		assert.strictEqual(instance.streamData.bitrate, 6000)
		assert.strictEqual(instance.streamData.resolution, '1920x1080')

		// Variables populated
		assert.strictEqual(instance.variableValues.stream_status, 'LIVE')
		assert.strictEqual(instance.variableValues.is_streaming, 'true')
		assert.strictEqual(instance.variableValues.stream_ws_connected, 'false')
		assert.strictEqual(instance.variableValues.channel_10_active, 'true')
		assert.strictEqual(instance.variableValues.channel_20_active, 'false')

		// Poll interval timer active
		assert.ok(instance.poll_interval !== null, 'poll_interval timer must be active')

		// 2. Test setChannel
		await instance.setChannel({ channel: '10', enabled: 'false' })
		assert.strictEqual(patchedChannel.body.active, false)
		assert.strictEqual(instance.variableValues.channel_10_active, 'false')

		// 3. Test setChannelMeta and verify immediate local cache and variable update
		await instance.setChannelMeta('10', 'Updated Title', 'Updated Desc')
		assert.deepStrictEqual(patchedMeta.body, { title: 'Updated Title', description: 'Updated Desc' })
		assert.strictEqual(instance.variableValues.channel_10_title, 'Updated Title')
		assert.strictEqual(instance.variableValues.channel_10_description, 'Updated Desc')

		// 4. Test configUpdated with different pollTime
		await instance.configUpdated({
			accessToken: 'valid_manual_token_abc',
			pollTime: 60,
			enableWs: false,
		})

		assert.ok(instance.poll_interval !== null)

		// 5. Destroy instance -> clean teardown of timers and resources
		await instance.destroy()
		assert.strictEqual(instance.poll_interval, null, 'poll_interval must be null after destroy')
		assert.strictEqual(instance.streamMonitor, null, 'streamMonitor must be null after destroy')
		assert.strictEqual(instance.callbackServer, null, 'callbackServer must be null after destroy')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('ModuleInstance - Rapid concurrent poll() calls trigger pollQueued loop without state drop', async () => {
	const instance = new ModuleInstance({})
	let fetchCalls = 0

	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		const u = String(url)
		if (u.includes('/user/profile')) {
			return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) }
		}
		if (u.includes('/platform/all')) {
			fetchCalls++
			await new Promise((r) => setTimeout(r, 20))
			return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => [] }
		}
		if (u.includes('/user/channel/all')) {
			return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => [] }
		}
		if (u.includes('/user/events/in-progress')) {
			return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => [] }
		}
		return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) }
	}

	try {
		await instance.init({ accessToken: 'valid_token_123', enableWs: false })

		// Trigger rapid parallel polls
		const p1 = instance.poll()
		const p2 = instance.poll()
		const p3 = instance.poll()

		await Promise.all([p1, p2, p3])

		assert.strictEqual(instance.pollInProgress, false)
		assert.strictEqual(instance.pollQueued, false)

		await instance.destroy()
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('ModuleInstance - getConfigFields returns valid field structure', () => {
	const instance = new ModuleInstance({})
	const fields = instance.getConfigFields()

	assert.ok(Array.isArray(fields))
	const fieldIds = fields.map((f) => f.id)
	assert.ok(fieldIds.includes('accessToken'))
	assert.ok(fieldIds.includes('refreshToken'))
	assert.ok(fieldIds.includes('clientID'))
	assert.ok(fieldIds.includes('clientSecret'))
	assert.ok(fieldIds.includes('redirectURL'))
	assert.ok(fieldIds.includes('enableWs'))
	assert.ok(fieldIds.includes('wsUrl'))
	assert.ok(fieldIds.includes('pollTime'))
})
