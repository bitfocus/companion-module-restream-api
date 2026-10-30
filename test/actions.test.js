const test = require('node:test')
const assert = require('node:assert/strict')
const UpdateActions = require('../actions')

test('Actions - Action registration and callback execution', async () => {
	let channelSetParams = null
	let metaSetParams = null
	let pollCalled = false
	let wsReconnected = false

	const self = {
		channels: [
			{ id: 10, displayName: 'Facebook Live', streamingPlatformId: 1, active: true },
			{ id: 20, displayName: 'Twitch Channel', streamingPlatformId: 2, active: false },
		],
		platforms: [
			{ id: 1, name: 'Facebook' },
			{ id: 2, name: 'Twitch' },
		],
		streamMonitor: {
			reconnect() {
				wsReconnected = true
			},
		},
		actionDefinitions: {},
		setActionDefinitions(defs) {
			this.actionDefinitions = defs
		},
		async setChannel(options) {
			channelSetParams = options
		},
		async setChannelMeta(chan, title, desc) {
			metaSetParams = { chan, title, desc }
		},
		async poll() {
			pollCalled = true
		},
		async parseVariablesInString(str) {
			if (str === '$(custom:stream_title)') return 'Parsed Dynamic Title'
			if (str === '$(custom:stream_desc)') return 'Parsed Dynamic Description'
			if (str === '$(custom:stream_channel)') return '10'
			return str
		},
	}

	UpdateActions(self)

	assert.ok(self.actionDefinitions.ChangeChannelState)
	assert.ok(self.actionDefinitions.ToggleChannelState)
	assert.ok(self.actionDefinitions.SetChannelMeta)
	assert.ok(self.actionDefinitions.RefreshData)
	assert.ok(self.actionDefinitions.ReconnectWebSocket)

	// 1. Test ChangeChannelState callback
	await self.actionDefinitions.ChangeChannelState.callback({
		options: { channel: '10', enabled: 'false' },
	})
	assert.deepStrictEqual(channelSetParams, { channel: '10', enabled: 'false' })

	// 2. Test ToggleChannelState callback on active channel (10 is active -> toggles to false)
	channelSetParams = null
	await self.actionDefinitions.ToggleChannelState.callback({
		options: { channel: '10' },
	})
	assert.deepStrictEqual(channelSetParams, { channel: '10', enabled: 'false' })

	// 3. Test ToggleChannelState callback on inactive channel (20 is inactive -> toggles to true)
	channelSetParams = null
	await self.actionDefinitions.ToggleChannelState.callback({
		options: { channel: '20' },
	})
	assert.deepStrictEqual(channelSetParams, { channel: '20', enabled: 'true' })

	// 4. Test SetChannelMeta callback with variable parsing for channel, title, and description
	await self.actionDefinitions.SetChannelMeta.callback({
		options: {
			channel: '$(custom:stream_channel)',
			title: '$(custom:stream_title)',
			description: '$(custom:stream_desc)',
		},
	})
	assert.deepStrictEqual(metaSetParams, {
		chan: '10',
		title: 'Parsed Dynamic Title',
		desc: 'Parsed Dynamic Description',
	})

	// 5. Test ChangeChannelState with dynamic variable channel ID
	channelSetParams = null
	await self.actionDefinitions.ChangeChannelState.callback({
		options: { channel: '$(custom:stream_channel)', enabled: 'true' },
	})
	assert.deepStrictEqual(channelSetParams, { channel: '10', enabled: 'true' })

	// 6. Test RefreshData callback
	await self.actionDefinitions.RefreshData.callback()
	assert.strictEqual(pollCalled, true)

	// 7. Test ReconnectWebSocket callback
	await self.actionDefinitions.ReconnectWebSocket.callback()
	assert.strictEqual(wsReconnected, true)
})

test('Actions - Safe null handling when self.channels or self.platforms is undefined or null', () => {
	const self = {
		channels: undefined,
		platforms: null,
		actionDefinitions: {},
		setActionDefinitions(defs) {
			this.actionDefinitions = defs
		},
	}

	assert.doesNotThrow(() => {
		UpdateActions(self)
	})

	assert.ok(self.actionDefinitions.ChangeChannelState)
	assert.strictEqual(self.actionDefinitions.ChangeChannelState.options[0].choices.length, 0)
})

test('Actions - SetChannelMeta and ToggleChannelState handle unexpected options safely', async () => {
	let setMetaCalled = false
	let loggedWarnings = []

	const self = {
		channels: [{ id: 10, displayName: 'Test', active: true }],
		platforms: [],
		actionDefinitions: {},
		setActionDefinitions(defs) {
			this.actionDefinitions = defs
		},
		log(level, msg) {
			if (level === 'warn') loggedWarnings.push(msg)
		},
		async setChannel() {},
		async setChannelMeta(chan, title, desc) {
			setMetaCalled = true
			assert.strictEqual(chan, '10')
			assert.strictEqual(title, '')
		},
		async parseVariablesInString(str) {
			return str
		},
	}

	UpdateActions(self)

	// SetChannelMeta with undefined title and description
	await self.actionDefinitions.SetChannelMeta.callback({
		options: { channel: '10' },
	})
	assert.strictEqual(setMetaCalled, true)

	// ToggleChannelState for non-existent channel ID
	await self.actionDefinitions.ToggleChannelState.callback({
		options: { channel: '99999' },
	})
	assert.ok(loggedWarnings.some((w) => w.includes('Channel 99999 not found')))
})
