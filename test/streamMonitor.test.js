const test = require('node:test')
const assert = require('node:assert/strict')
const StreamMonitor = require('../streamMonitor')

class MockInstance {
	constructor() {
		this.streamData = {}
		this.feedbacksChecked = []
		this.variablesUpdated = 0
		this.logs = []
	}
	log(level, msg) {
		this.logs.push({ level, msg })
	}
	checkFeedbacks(...ids) {
		this.feedbacksChecked.push(...ids)
	}
	updateVariables() {
		this.variablesUpdated++
	}
}

test('StreamMonitor - Initialization and defaults', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance, { wsUrl: 'wss://streaming.api.restream.io/ws' })

	assert.strictEqual(monitor.wsUrl, 'wss://streaming.api.restream.io/ws')
	assert.strictEqual(monitor.streamData.status, 'OFFLINE')
	assert.strictEqual(monitor.streamData.isStreaming, false)
	assert.strictEqual(monitor.streamData.fps, 0)
	assert.strictEqual(monitor.streamData.bitrate, 0)
	assert.strictEqual(monitor.streamData.resolution, 'N/A')
	assert.strictEqual(monitor.streamData.videoCodec, 'N/A')

	monitor.destroy()
})

test('StreamMonitor - Process status messages and state transitions (LIVE / OFFLINE)', (t) => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)

	const transitions = []
	monitor.on('transition', (tr) => transitions.push(tr))

	// 1. Transition to LIVE via status action
	monitor.processStreamEvent({
		action: 'status',
		data: {
			status: 'LIVE',
			live: true,
		},
	})

	assert.strictEqual(monitor.streamData.status, 'LIVE')
	assert.strictEqual(monitor.streamData.isStreaming, true)
	assert.strictEqual(transitions.length, 1)
	assert.strictEqual(transitions[0].from, 'OFFLINE')
	assert.strictEqual(transitions[0].to, 'LIVE')
	assert.strictEqual(transitions[0].isStreaming, true)
	assert.strictEqual(instance.streamData.status, 'LIVE')
	assert.ok(instance.feedbacksChecked.includes('StreamStatus'))

	// 2. Metrics while LIVE
	monitor.processStreamEvent({
		action: 'metrics',
		data: {
			fps: 59.94,
			bitrate: 6200000, // bps -> should convert to kbps: 6200
			width: 1920,
			height: 1080,
			video_codec: 'h264',
			audio_codec: 'aac',
		},
	})

	assert.strictEqual(monitor.streamData.status, 'LIVE')
	assert.strictEqual(monitor.streamData.isStreaming, true)
	assert.strictEqual(monitor.streamData.fps, 59.94)
	assert.strictEqual(monitor.streamData.bitrate, 6200)
	assert.strictEqual(monitor.streamData.resolution, '1920x1080')
	assert.strictEqual(monitor.streamData.videoCodec, 'h264')
	assert.strictEqual(monitor.streamData.audioCodec, 'aac')

	// 3. Transition to OFFLINE
	monitor.processStreamEvent({
		action: 'status',
		data: {
			status: 'OFFLINE',
			live: false,
		},
	})

	assert.strictEqual(monitor.streamData.status, 'OFFLINE')
	assert.strictEqual(monitor.streamData.isStreaming, false)
	assert.strictEqual(monitor.streamData.fps, 0, 'FPS must reset to 0 on OFFLINE')
	assert.strictEqual(monitor.streamData.bitrate, 0, 'Bitrate must reset to 0 on OFFLINE')
	assert.strictEqual(transitions.length, 2)
	assert.strictEqual(transitions[1].from, 'LIVE')
	assert.strictEqual(transitions[1].to, 'OFFLINE')
	assert.strictEqual(transitions[1].isStreaming, false)

	monitor.destroy()
})

test('StreamMonitor - Bitrate normalization (kbps vs bps)', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)

	// Direct kbps value (< 100000)
	monitor.processStreamEvent({
		action: 'metrics',
		data: { bitrate: 4500 },
	})
	assert.strictEqual(monitor.streamData.bitrate, 4500)

	// Large bps value (> 100000)
	monitor.processStreamEvent({
		action: 'metrics',
		data: { bitrate: 8000000 },
	})
	assert.strictEqual(monitor.streamData.bitrate, 8000)

	// bitrate_kbps field
	monitor.processStreamEvent({
		action: 'metrics',
		data: { bitrate_kbps: 3500 },
	})
	assert.strictEqual(monitor.streamData.bitrate, 3500)

	monitor.destroy()
})

test('StreamMonitor - Non-standard and nested event payload variations', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)

	// Payload with active boolean
	monitor.processStreamEvent({ active: true, fps: 30, resolution: '1280x720' })
	assert.strictEqual(monitor.streamData.status, 'LIVE')
	assert.strictEqual(monitor.streamData.isStreaming, true)
	assert.strictEqual(monitor.streamData.fps, 30)
	assert.strictEqual(monitor.streamData.resolution, '1280x720')

	// Nested video and audio objects
	monitor.processStreamEvent({
		data: {
			video: { fps: 60, bitrate: 4000, codec: 'hevc', width: 2560, height: 1440 },
			audio: { codec: 'opus' },
		},
	})
	assert.strictEqual(monitor.streamData.fps, 60)
	assert.strictEqual(monitor.streamData.bitrate, 4000)
	assert.strictEqual(monitor.streamData.resolution, '2560x1440')
	assert.strictEqual(monitor.streamData.videoCodec, 'hevc')
	assert.strictEqual(monitor.streamData.audioCodec, 'opus')

	// Event name strings (stream.offline)
	monitor.processStreamEvent({ event: 'stream.offline' })
	assert.strictEqual(monitor.streamData.status, 'OFFLINE')
	assert.strictEqual(monitor.streamData.isStreaming, false)

	// Event name strings (stream.live)
	monitor.processStreamEvent({ event: 'stream.live' })
	assert.strictEqual(monitor.streamData.status, 'LIVE')
	assert.strictEqual(monitor.streamData.isStreaming, true)

	// Payload with state string
	monitor.processStreamEvent({ state: 'offline' })
	assert.strictEqual(monitor.streamData.status, 'OFFLINE')
	assert.strictEqual(monitor.streamData.isStreaming, false)

	// DEGRADED state
	monitor.processStreamEvent({ status: 'DEGRADED' })
	assert.strictEqual(monitor.streamData.status, 'DEGRADED')
	assert.strictEqual(monitor.streamData.isStreaming, true)

	monitor.destroy()
})

test('StreamMonitor - Binary WebSocket message frames (Uint8Array, Buffer, ArrayBuffer, Array)', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)

	// 1. Buffer string payload
	const jsonBuf = Buffer.from(JSON.stringify({ action: 'status', data: { status: 'LIVE', fps: 30 } }))
	monitor.handleMessage(jsonBuf)
	assert.strictEqual(monitor.streamData.status, 'LIVE')
	assert.strictEqual(monitor.streamData.fps, 30)

	// 2. Uint8Array binary frame
	const u8 = new Uint8Array(Buffer.from(JSON.stringify({ action: 'metrics', data: { bitrate: 5500 } })))
	monitor.handleMessage(u8)
	assert.strictEqual(monitor.streamData.bitrate, 5500)

	// 3. Array of events
	monitor.handleMessage([
		{ action: 'status', data: { status: 'LIVE' } },
		{ action: 'metrics', data: { fps: 60, bitrate: 6500 } },
	])
	assert.strictEqual(monitor.streamData.fps, 60)
	assert.strictEqual(monitor.streamData.bitrate, 6500)

	// 4. Non-json pong text
	monitor.handleMessage('pong')
	assert.strictEqual(monitor.streamData.status, 'LIVE') // unchanged

	monitor.destroy()
})

test('StreamMonitor - REST Fallback Processing (/user/events/in-progress)', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)

	// 1. Active in-progress event
	monitor.updateFromRest([
		{
			id: 101,
			title: 'Sunday Morning Live Broadcast',
			status: 'in-progress',
			streamHealth: {
				fps: 60,
				bitrate: 5500000,
				resolution: '1920x1080',
				videoCodec: 'h264',
			},
		},
	])

	assert.strictEqual(monitor.streamData.status, 'LIVE')
	assert.strictEqual(monitor.streamData.isStreaming, true)
	assert.strictEqual(monitor.streamData.eventTitle, 'Sunday Morning Live Broadcast')
	assert.strictEqual(monitor.streamData.fps, 60)
	assert.strictEqual(monitor.streamData.bitrate, 5500)
	assert.strictEqual(monitor.streamData.resolution, '1920x1080')
	assert.strictEqual(monitor.streamData.videoCodec, 'h264')

	// 2. Empty event list when WS is disconnected -> transitions to OFFLINE
	monitor.isConnected = false
	monitor.updateFromRest([])

	assert.strictEqual(monitor.streamData.status, 'OFFLINE')
	assert.strictEqual(monitor.streamData.isStreaming, false)
	assert.strictEqual(monitor.streamData.fps, 0)
	assert.strictEqual(monitor.streamData.bitrate, 0)
	assert.strictEqual(monitor.streamData.eventTitle, '')

	// 3. Nested object wrapper formats { events: [...] } and { result: [...] }
	monitor.updateFromRest({
		result: [
			{
				id: 202,
				title: 'Wrapped Event Test',
				status: 'live',
				metrics: { fps: 30, bitrate_kbps: 4500, resolution: '1280x720' },
			},
		],
	})
	assert.strictEqual(monitor.streamData.status, 'LIVE')
	assert.strictEqual(monitor.streamData.eventTitle, 'Wrapped Event Test')
	assert.strictEqual(monitor.streamData.fps, 30)
	assert.strictEqual(monitor.streamData.bitrate, 4500)

	monitor.destroy()
})

test('StreamMonitor - Socket instance identity guard prevents stale socket events and ghost reconnects', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)
	monitor.token = 'test_token'

	const staleSocket = { close() {}, terminate() {} }
	const activeSocket = { close() {}, terminate() {} }

	monitor.ws = activeSocket
	monitor.isConnected = true

	// Stale socket emits close -> must be ignored, active socket remains connected
	monitor.handleClose({ code: 1000 }, staleSocket)
	assert.strictEqual(monitor.isConnected, true)
	assert.strictEqual(monitor.reconnectTimer, null)

	// Stale socket emits error -> must be ignored
	monitor.handleError(new Error('Stale socket network drop'), staleSocket)
	assert.strictEqual(monitor.isConnected, true)

	// closeSocket intentionally closes and clears reconnect timer
	monitor.closeSocket(true)
	assert.strictEqual(monitor.ws, null)
	assert.strictEqual(monitor.isConnected, false)
	assert.strictEqual(monitor.reconnectTimer, null)

	monitor.destroy()
})

test('StreamMonitor - Destroy cleans all timers without leaks', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)

	monitor.pingTimer = setInterval(() => {}, 1000)
	monitor.reconnectTimer = setTimeout(() => {}, 1000)

	monitor.destroy()

	assert.strictEqual(monitor.destroyed, true)
	assert.strictEqual(monitor.pingTimer, null)
	assert.strictEqual(monitor.reconnectTimer, null)
	assert.strictEqual(monitor.ws, null)
})

test('StreamMonitor - Safe handling of null, undefined, primitive, and malformed payloads', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)

	// Direct calls with null, undefined, primitive values
	assert.doesNotThrow(() => monitor.processStreamEvent(null))
	assert.doesNotThrow(() => monitor.processStreamEvent(undefined))
	assert.doesNotThrow(() => monitor.processStreamEvent(12345))
	assert.doesNotThrow(() => monitor.processStreamEvent('some text'))
	assert.doesNotThrow(() => monitor.processStreamEvent({ data: null }))
	assert.doesNotThrow(() => monitor.processStreamEvent({ payload: null }))

	// REST fallback calls with null, undefined, primitive values
	assert.doesNotThrow(() => monitor.updateFromRest(null))
	assert.doesNotThrow(() => monitor.updateFromRest(undefined))
	assert.doesNotThrow(() => monitor.updateFromRest('invalid string'))
	assert.doesNotThrow(() => monitor.updateFromRest(123))

	monitor.destroy()
})

test('StreamMonitor - Notification deduplication when event listeners are registered', () => {
	const instance = new MockInstance()
	const monitor = new StreamMonitor(instance)

	let listenerTriggered = 0
	monitor.on('metrics', () => {
		listenerTriggered++
	})

	monitor.processStreamEvent({ action: 'metrics', data: { fps: 30 } })

	assert.strictEqual(listenerTriggered, 1)
	// Direct instance notification was skipped because listener is active
	assert.strictEqual(instance.variablesUpdated, 0)

	monitor.destroy()
})
