const { combineRgb } = require('@companion-module/base')

module.exports = function (self) {
	const channels = Array.isArray(self.channels) ? self.channels : []
	const platforms = Array.isArray(self.platforms) ? self.platforms : []

	const channelChoices = channels.map((chan) => {
		const platform = platforms.find((ptfrm) => ptfrm && ptfrm.id == chan.streamingPlatformId)
		const platformName = platform?.name || 'Channel'
		return {
			id: String(chan.id),
			label: `${platformName} (${chan.displayName || chan.id})`,
		}
	})

	const defaultChannel = channelChoices.length > 0 ? channelChoices[0].id : ''

	self.setFeedbackDefinitions({
		ChannelState: {
			name: 'Channel State',
			type: 'boolean',
			label: 'Channel State',
			defaultStyle: {
				bgcolor: combineRgb(0, 200, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					id: 'channel',
					type: 'dropdown',
					label: 'Channel',
					choices: channelChoices,
					default: defaultChannel,
				},
				{
					id: 'enabled',
					type: 'dropdown',
					label: 'State Matches',
					choices: [
						{ id: 'true', label: 'Enabled (On)' },
						{ id: 'false', label: 'Disabled (Off)' },
					],
					default: 'true',
				},
			],
			callback: (fb) => {
				const chanList = Array.isArray(self.channels) ? self.channels : []
				const channel = chanList.find((ch) => ch && String(ch.id) === String(fb.options.channel))
				if (!channel) return false
				const expected = fb.options.enabled === 'true' || fb.options.enabled === true
				const actual = Boolean(channel.active ?? channel.enabled)
				return actual === expected
			},
		},

		IsStreaming: {
			name: 'Stream Is Live',
			type: 'boolean',
			label: 'Stream Is Live (ON AIR)',
			defaultStyle: {
				bgcolor: combineRgb(0, 200, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return Boolean(self.streamData?.isStreaming)
			},
		},

		StreamStatus: {
			name: 'Stream Status Equals',
			type: 'boolean',
			label: 'Stream Status Equals',
			defaultStyle: {
				bgcolor: combineRgb(0, 200, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					id: 'status',
					type: 'dropdown',
					label: 'Status',
					choices: [
						{ id: 'LIVE', label: 'LIVE' },
						{ id: 'OFFLINE', label: 'OFFLINE' },
						{ id: 'CONNECTING', label: 'CONNECTING' },
						{ id: 'DEGRADED', label: 'DEGRADED' },
					],
					default: 'LIVE',
				},
			],
			callback: (fb) => {
				const current = (self.streamData?.status || 'OFFLINE').toUpperCase()
				const target = (fb.options.status || 'LIVE').toUpperCase()
				return current === target
			},
		},

		WebSocketConnected: {
			name: 'Streaming Telemetry (WebSocket) Connected',
			type: 'boolean',
			label: 'WebSocket Telemetry Connected',
			defaultStyle: {
				bgcolor: combineRgb(0, 150, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return Boolean(self.streamMonitor?.isConnected)
			},
		},

		StreamBitrateWarning: {
			name: 'Stream Bitrate Low Warning',
			type: 'boolean',
			label: 'Stream Bitrate Below Threshold',
			defaultStyle: {
				bgcolor: combineRgb(255, 140, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				{
					id: 'minBitrate',
					type: 'number',
					label: 'Minimum Bitrate (kbps)',
					default: 2500,
					min: 0,
					max: 100000,
				},
			],
			callback: (fb) => {
				if (!self.streamData?.isStreaming) return false
				const currentBitrate = Number(self.streamData?.bitrate || 0)
				const threshold = Number(fb.options.minBitrate ?? 2500)
				return currentBitrate < threshold
			},
		},

		StreamFpsWarning: {
			name: 'Stream FPS Low Warning',
			type: 'boolean',
			label: 'Stream FPS Below Threshold',
			defaultStyle: {
				bgcolor: combineRgb(255, 140, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				{
					id: 'minFps',
					type: 'number',
					label: 'Minimum FPS',
					default: 24,
					min: 0,
					max: 240,
				},
			],
			callback: (fb) => {
				if (!self.streamData?.isStreaming) return false
				const currentFps = Number(self.streamData?.fps || 0)
				const threshold = Number(fb.options.minFps ?? 24)
				return currentFps < threshold
			},
		},

		StreamAlert: {
			name: 'Stream Alert / Warning Active',
			type: 'boolean',
			label: 'Stream Alert Active (Low Bitrate or Low FPS)',
			defaultStyle: {
				bgcolor: combineRgb(255, 140, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				if (!self.streamData?.isStreaming) return false
				const fps = Number(self.streamData?.fps || 0)
				const bitrate = Number(self.streamData?.bitrate || 0)
				return (fps > 0 && fps < 24) || (bitrate > 0 && bitrate < 2000)
			},
		},
	})
}
