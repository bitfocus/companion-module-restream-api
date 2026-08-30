const test = require('node:test')
const assert = require('node:assert/strict')
require('./helpers/mockCompanion')
const UpdatePresets = require('../presets')

test('Presets - Generates stream monitoring presets and per-channel toggle presets', () => {
	const self = {
		channels: [
			{ id: 101, displayName: 'YouTube Channel', streamingPlatformId: 1, active: true },
		],
		platforms: [{ id: 1, name: 'YouTube' }],
		presetDefinitions: {},
		setPresetDefinitions(defs) {
			this.presetDefinitions = defs
		},
	}

	UpdatePresets(self)

	assert.ok(self.presetDefinitions.stream_status_indicator, 'stream_status_indicator preset must exist')
	assert.ok(self.presetDefinitions.stream_resolution_codec, 'stream_resolution_codec preset must exist')
	assert.ok(self.presetDefinitions.reconnect_websocket, 'reconnect_websocket preset must exist')
	assert.ok(self.presetDefinitions.refresh_data, 'refresh_data preset must exist')
	assert.ok(self.presetDefinitions.toggle_channel_101, 'toggle_channel_101 preset must exist')

	// Check channel preset structure
	const chanPreset = self.presetDefinitions.toggle_channel_101
	assert.strictEqual(chanPreset.type, 'button')
	assert.strictEqual(chanPreset.category, 'Channels')
	assert.strictEqual(chanPreset.steps[0].down[0].actionId, 'ToggleChannelState')
	assert.strictEqual(chanPreset.steps[0].down[0].options.channel, '101')
	assert.strictEqual(chanPreset.feedbacks[0].feedbackId, 'ChannelState')
	assert.strictEqual(chanPreset.feedbacks[0].options.channel, '101')

	// Check reconnect preset has WebSocketConnected feedback
	const reconnectPreset = self.presetDefinitions.reconnect_websocket
	assert.ok(reconnectPreset.feedbacks.some((fb) => fb.feedbackId === 'WebSocketConnected'))

	// Check that button text contains true newline characters (\n) and no literal escaped \n (\\n)
	for (const [key, preset] of Object.entries(self.presetDefinitions)) {
		if (preset.style && preset.style.text) {
			assert.ok(!preset.style.text.includes('\\n'), `Preset ${key} text must not contain literal \\n string`)
		}
	}

	assert.ok(self.presetDefinitions.stream_status_indicator.style.text.includes('\n'))
	assert.ok(self.presetDefinitions.stream_resolution_codec.style.text.includes('\n'))
	assert.ok(self.presetDefinitions.reconnect_websocket.style.text.includes('\n'))
	assert.ok(self.presetDefinitions.refresh_data.style.text.includes('\n'))
	assert.ok(self.presetDefinitions.toggle_channel_101.style.text.includes('\n'))
})

test('Presets - Safe handling when channels is undefined or empty', () => {
	const self = {
		channels: null,
		platforms: undefined,
		presetDefinitions: {},
		setPresetDefinitions(defs) {
			this.presetDefinitions = defs
		},
	}

	assert.doesNotThrow(() => {
		UpdatePresets(self)
	})

	assert.ok(self.presetDefinitions.stream_status_indicator)
	assert.ok(self.presetDefinitions.refresh_data)
})
