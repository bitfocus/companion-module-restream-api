const { combineRgb } = require('@companion-module/base')

module.exports = function (self) {
	const presets = {}
	const channels = Array.isArray(self.channels) ? self.channels : []
	const platforms = Array.isArray(self.platforms) ? self.platforms : []

	// 1. Full Stream Monitor & Alerts Preset
	presets['stream_full_monitor'] = {
		type: 'button',
		category: 'Stream Monitoring',
		name: 'Stream Monitor (Title, Status, FPS, Bitrate & Alerts)',
		style: {
			text: '$(this:stream_title)\n$(this:stream_status)\n$(this:stream_fps)fps $(this:stream_bitrate)k\n$(this:stream_alert)',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(40, 40, 40),
		},
		steps: [
			{
				down: [
					{
						actionId: 'RefreshData',
						options: {},
					},
				],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'IsStreaming',
				options: {},
				style: {
					bgcolor: combineRgb(0, 200, 0),
					color: combineRgb(255, 255, 255),
				},
			},
			{
				feedbackId: 'StreamAlert',
				options: {},
				style: {
					bgcolor: combineRgb(255, 140, 0),
					color: combineRgb(0, 0, 0),
				},
			},
		],
	}

	// 2. Stream Status & Health Preset
	presets['stream_status_indicator'] = {
		type: 'button',
		category: 'Stream Monitoring',
		name: 'Stream Status & Health',
		style: {
			text: '$(this:stream_status)\n$(this:stream_bitrate) kbps\n$(this:stream_fps) fps',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(40, 40, 40),
		},
		steps: [
			{
				down: [
					{
						actionId: 'RefreshData',
						options: {},
					},
				],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'IsStreaming',
				options: {},
				style: {
					bgcolor: combineRgb(0, 200, 0),
					color: combineRgb(255, 255, 255),
				},
			},
			{
				feedbackId: 'StreamBitrateWarning',
				options: { minBitrate: 2500 },
				style: {
					bgcolor: combineRgb(255, 140, 0),
					color: combineRgb(0, 0, 0),
				},
			},
		],
	}

	// 2. Stream Resolution & Codec Preset
	presets['stream_resolution_codec'] = {
		type: 'button',
		category: 'Stream Monitoring',
		name: 'Stream Resolution & Codec',
		style: {
			text: '$(this:stream_resolution)\n$(this:stream_codec)',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(40, 40, 40),
		},
		steps: [
			{
				down: [
					{
						actionId: 'RefreshData',
						options: {},
					},
				],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'IsStreaming',
				options: {},
				style: {
					bgcolor: combineRgb(0, 102, 204),
					color: combineRgb(255, 255, 255),
				},
			},
		],
	}

	// 3. Reconnect WebSocket Preset
	presets['reconnect_websocket'] = {
		type: 'button',
		category: 'Stream Monitoring',
		name: 'Reconnect Streaming Monitor (WS)',
		style: {
			text: 'Reconnect\nWebSocket',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(60, 60, 60),
		},
		steps: [
			{
				down: [
					{
						actionId: 'ReconnectWebSocket',
						options: {},
					},
				],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'WebSocketConnected',
				options: {},
				style: {
					bgcolor: combineRgb(0, 150, 0),
					color: combineRgb(255, 255, 255),
				},
			},
		],
	}

	// 4. Refresh Data Preset
	presets['refresh_data'] = {
		type: 'button',
		category: 'General Control',
		name: 'Refresh All Data',
		style: {
			text: 'Refresh\nData',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 102, 204),
		},
		steps: [
			{
				down: [
					{
						actionId: 'RefreshData',
						options: {},
					},
				],
				up: [],
			},
		],
		feedbacks: [],
	}

	// 5. Channel Toggle Presets
	for (const chan of channels) {
		if (!chan || !chan.id) continue
		const platform = platforms.find((ptfrm) => ptfrm && ptfrm.id == chan.streamingPlatformId)
		const platformName = platform?.name || 'Channel'
		const displayName = chan.displayName || `ID ${chan.id}`

		presets[`toggle_channel_${chan.id}`] = {
			type: 'button',
			category: 'Channels',
			name: `Toggle Channel: ${platformName} (${displayName})`,
			style: {
				text: `${platformName}\n${displayName}`,
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(40, 40, 40),
			},
			steps: [
				{
					down: [
						{
							actionId: 'ToggleChannelState',
							options: {
								channel: String(chan.id),
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'ChannelState',
					options: {
						channel: String(chan.id),
						enabled: 'true',
					},
					style: {
						bgcolor: combineRgb(0, 200, 0),
						color: combineRgb(255, 255, 255),
					},
				},
			],
		}
	}

	self.setPresetDefinitions(presets)
}
