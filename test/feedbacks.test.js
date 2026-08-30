const test = require('node:test')
const assert = require('node:assert/strict')
require('./helpers/mockCompanion')
const UpdateFeedbacks = require('../feedbacks')

test('Feedbacks - Registration and ChannelState boolean feedback evaluation', () => {
	const self = {
		channels: [
			{ id: 1, displayName: 'YouTube Live', streamingPlatformId: 1, active: true },
			{ id: 2, displayName: 'Twitch', streamingPlatformId: 2, active: false },
		],
		platforms: [
			{ id: 1, name: 'YouTube' },
			{ id: 2, name: 'Twitch' },
		],
		streamMonitor: {
			isConnected: true,
		},
		streamData: {
			status: 'LIVE',
			isStreaming: true,
			fps: 60,
			bitrate: 6000,
		},
		feedbackDefinitions: {},
		setFeedbackDefinitions(defs) {
			this.feedbackDefinitions = defs
		},
	}

	UpdateFeedbacks(self)

	assert.ok(self.feedbackDefinitions.ChannelState)
	assert.ok(self.feedbackDefinitions.IsStreaming)
	assert.ok(self.feedbackDefinitions.StreamStatus)
	assert.ok(self.feedbackDefinitions.WebSocketConnected)
	assert.ok(self.feedbackDefinitions.StreamBitrateWarning)
	assert.ok(self.feedbackDefinitions.StreamFpsWarning)

	const cb = self.feedbackDefinitions.ChannelState.callback

	// Channel 1 is active -> matches true
	assert.strictEqual(cb({ options: { channel: '1', enabled: 'true' } }), true)
	assert.strictEqual(cb({ options: { channel: '1', enabled: 'false' } }), false)

	// Channel 2 is inactive -> matches false
	assert.strictEqual(cb({ options: { channel: '2', enabled: 'true' } }), false)
	assert.strictEqual(cb({ options: { channel: '2', enabled: 'false' } }), true)

	// Non-existent channel -> safe returns false
	assert.strictEqual(cb({ options: { channel: '999', enabled: 'true' } }), false)

	// WebSocketConnected
	assert.strictEqual(self.feedbackDefinitions.WebSocketConnected.callback(), true)
	self.streamMonitor.isConnected = false
	assert.strictEqual(self.feedbackDefinitions.WebSocketConnected.callback(), false)
})

test('Feedbacks - Safe null handling when self.channels or self.platforms is undefined or null', () => {
	const self = {
		channels: null,
		platforms: undefined,
		streamMonitor: null,
		streamData: null,
		feedbackDefinitions: {},
		setFeedbackDefinitions(defs) {
			this.feedbackDefinitions = defs
		},
	}

	// Should not throw TypeError
	assert.doesNotThrow(() => {
		UpdateFeedbacks(self)
	})

	const cb = self.feedbackDefinitions.ChannelState.callback
	assert.strictEqual(cb({ options: { channel: '1', enabled: 'true' } }), false)
	assert.strictEqual(self.feedbackDefinitions.IsStreaming.callback(), false)
	assert.strictEqual(self.feedbackDefinitions.WebSocketConnected.callback(), false)
	assert.strictEqual(self.feedbackDefinitions.StreamStatus.callback({ options: { status: 'LIVE' } }), false)
	assert.strictEqual(self.feedbackDefinitions.StreamBitrateWarning.callback({ options: { minBitrate: 2000 } }), false)
	assert.strictEqual(self.feedbackDefinitions.StreamFpsWarning.callback({ options: { minFps: 30 } }), false)
})

test('Feedbacks - Stream monitoring feedbacks (IsStreaming, StreamStatus, Warnings)', () => {
	const self = {
		channels: [],
		platforms: [],
		streamData: {
			status: 'LIVE',
			isStreaming: true,
			fps: 20, // below 24 threshold
			bitrate: 1500, // below 2500 threshold
		},
		setFeedbackDefinitions(defs) {
			this.defs = defs
		},
	}

	UpdateFeedbacks(self)

	// IsStreaming
	assert.strictEqual(self.defs.IsStreaming.callback(), true)

	// StreamStatus
	assert.strictEqual(self.defs.StreamStatus.callback({ options: { status: 'LIVE' } }), true)
	assert.strictEqual(self.defs.StreamStatus.callback({ options: { status: 'OFFLINE' } }), false)

	// Bitrate Warning (threshold 2500, current 1500 -> true)
	assert.strictEqual(self.defs.StreamBitrateWarning.callback({ options: { minBitrate: 2500 } }), true)
	// Bitrate Warning (threshold 1000, current 1500 -> false)
	assert.strictEqual(self.defs.StreamBitrateWarning.callback({ options: { minBitrate: 1000 } }), false)

	// FPS Warning (threshold 24, current 20 -> true)
	assert.strictEqual(self.defs.StreamFpsWarning.callback({ options: { minFps: 24 } }), true)
	// FPS Warning (threshold 15, current 20 -> false)
	assert.strictEqual(self.defs.StreamFpsWarning.callback({ options: { minFps: 15 } }), false)

	// When OFFLINE, warnings should not trigger
	self.streamData.isStreaming = false
	self.streamData.status = 'OFFLINE'
	assert.strictEqual(self.defs.IsStreaming.callback(), false)
	assert.strictEqual(self.defs.StreamBitrateWarning.callback({ options: { minBitrate: 2500 } }), false)
	assert.strictEqual(self.defs.StreamFpsWarning.callback({ options: { minFps: 24 } }), false)
})
