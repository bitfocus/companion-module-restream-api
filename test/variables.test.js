const test = require('node:test')
const assert = require('node:assert/strict')
const UpdateVariables = require('../variables')

test('Variables - Registers stream monitoring and channel variables with correct values', () => {
	const self = {
		channels: [
			{
				id: 42,
				displayName: 'Main YouTube Stream',
				streamingPlatformId: 1,
				active: true,
				meta: {
					title: 'Sunday Morning Service',
					description: 'Live broadcast from TU 95.5 FM',
				},
			},
		],
		platforms: [{ id: 1, name: 'YouTube' }],
		streamMonitor: {
			isConnected: true,
		},
		streamData: {
			status: 'LIVE',
			isStreaming: true,
			fps: 59.94,
			bitrate: 6000,
			resolution: '1920x1080',
			videoCodec: 'h264',
			audioCodec: 'aac',
			eventTitle: 'Live Broadcast Event',
		},
		variableDefinitions: [],
		variableValues: {},
		setVariableDefinitions(defs) {
			this.variableDefinitions = defs
		},
		setVariableValues(vals) {
			this.variableValues = { ...this.variableValues, ...vals }
		},
	}

	UpdateVariables(self)

	// Verify definitions
	const defIds = self.variableDefinitions.map((v) => v.variableId)
	assert.ok(defIds.includes('stream_status'))
	assert.ok(defIds.includes('is_streaming'))
	assert.ok(defIds.includes('stream_ws_connected'))
	assert.ok(defIds.includes('stream_fps'))
	assert.ok(defIds.includes('stream_bitrate'))
	assert.ok(defIds.includes('stream_resolution'))
	assert.ok(defIds.includes('stream_codec'))
	assert.ok(defIds.includes('stream_audio_codec'))
	assert.ok(defIds.includes('stream_event_title'))
	assert.ok(defIds.includes('channel_42_name'))
	assert.ok(defIds.includes('channel_42_platform'))
	assert.ok(defIds.includes('channel_42_active'))
	assert.ok(defIds.includes('channel_42_title'))
	assert.ok(defIds.includes('channel_42_description'))

	// Verify values
	assert.strictEqual(self.variableValues.stream_status, 'LIVE')
	assert.strictEqual(self.variableValues.is_streaming, 'true')
	assert.strictEqual(self.variableValues.stream_ws_connected, 'true')
	assert.strictEqual(self.variableValues.stream_fps, '59.94')
	assert.strictEqual(self.variableValues.stream_bitrate, '6000')
	assert.strictEqual(self.variableValues.stream_resolution, '1920x1080')
	assert.strictEqual(self.variableValues.stream_codec, 'h264')
	assert.strictEqual(self.variableValues.stream_audio_codec, 'aac')
	assert.strictEqual(self.variableValues.stream_event_title, 'Live Broadcast Event')
	assert.strictEqual(self.variableValues.channel_42_name, 'Main YouTube Stream')
	assert.strictEqual(self.variableValues.channel_42_platform, 'YouTube')
	assert.strictEqual(self.variableValues.channel_42_active, 'true')
	assert.strictEqual(self.variableValues.channel_42_title, 'Sunday Morning Service')
	assert.strictEqual(self.variableValues.channel_42_description, 'Live broadcast from TU 95.5 FM')
})

test('Variables - Safe null handling when self.channels or streamData is undefined', () => {
	const self = {
		channels: undefined,
		platforms: null,
		streamMonitor: null,
		streamData: null,
		variableDefinitions: [],
		variableValues: {},
		setVariableDefinitions(defs) {
			this.variableDefinitions = defs
		},
		setVariableValues(vals) {
			this.variableValues = { ...this.variableValues, ...vals }
		},
	}

	assert.doesNotThrow(() => {
		UpdateVariables(self)
	})

	assert.strictEqual(self.variableValues.stream_status, 'OFFLINE')
	assert.strictEqual(self.variableValues.is_streaming, 'false')
	assert.strictEqual(self.variableValues.stream_ws_connected, 'false')
	assert.strictEqual(self.variableValues.stream_fps, '0')
	assert.strictEqual(self.variableValues.stream_bitrate, '0')
	assert.strictEqual(self.variableValues.stream_resolution, 'N/A')
})

test('Variables - Channel title and description variables are registered when chan.meta is empty or absent', () => {
	const self = {
		channels: [
			{ id: 99, displayName: 'Empty Meta Channel', streamingPlatformId: 1, active: false },
		],
		platforms: [{ id: 1, name: 'Custom RTMP' }],
		variableDefinitions: [],
		variableValues: {},
		setVariableDefinitions(defs) {
			this.variableDefinitions = defs
		},
		setVariableValues(vals) {
			this.variableValues = { ...this.variableValues, ...vals }
		},
	}

	UpdateVariables(self)

	const defIds = self.variableDefinitions.map((v) => v.variableId)
	assert.ok(defIds.includes('channel_99_title'))
	assert.ok(defIds.includes('channel_99_description'))
	assert.strictEqual(self.variableValues.channel_99_title, '')
	assert.strictEqual(self.variableValues.channel_99_description, '')
})
