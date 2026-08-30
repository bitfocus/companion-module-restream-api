module.exports = function (self) {
	const variables = [
		{ variableId: 'stream_status', name: 'Stream Status (LIVE/OFFLINE)' },
		{ variableId: 'is_streaming', name: 'Is Stream Live (true/false)' },
		{ variableId: 'stream_title', name: 'Active Stream / Event Name' },
		{ variableId: 'stream_name', name: 'Active Stream Name (Alias)' },
		{ variableId: 'stream_event_title', name: 'Current Event / Stream Title' },
		{ variableId: 'stream_fps', name: 'Stream FPS' },
		{ variableId: 'stream_bitrate', name: 'Stream Bitrate (kbps)' },
		{ variableId: 'stream_bitrate_mbps', name: 'Stream Bitrate (Mbps)' },
		{ variableId: 'stream_resolution', name: 'Stream Resolution' },
		{ variableId: 'stream_codec', name: 'Stream Video Codec' },
		{ variableId: 'stream_audio_codec', name: 'Stream Audio Codec' },
		{ variableId: 'stream_alert', name: 'Stream Health Alert Summary (OK, Low Bitrate, etc.)' },
		{ variableId: 'has_alert', name: 'Has Stream Alert (true/false)' },
		{ variableId: 'stream_ws_connected', name: 'Streaming Telemetry (WebSocket) Connected' },
	]

	const channels = Array.isArray(self.channels) ? self.channels : []
	const platforms = Array.isArray(self.platforms) ? self.platforms : []

	// Expose variables for each channel
	for (const chan of channels) {
		if (!chan || !chan.id) continue
		const platform = platforms.find((ptfrm) => ptfrm && ptfrm.id == chan.streamingPlatformId)
		const platformName = platform?.name || 'Channel'
		const labelPrefix = `${platformName} (${chan.displayName || chan.id})`

		variables.push({
			variableId: `channel_${chan.id}_name`,
			name: `${labelPrefix} Display Name`,
		})
		variables.push({
			variableId: `channel_${chan.id}_platform`,
			name: `${labelPrefix} Platform Name`,
		})
		variables.push({
			variableId: `channel_${chan.id}_active`,
			name: `${labelPrefix} Active Status`,
		})
		variables.push({
			variableId: `channel_${chan.id}_title`,
			name: `${labelPrefix} Stream Title`,
		})
		variables.push({
			variableId: `channel_${chan.id}_description`,
			name: `${labelPrefix} Stream Description`,
		})

		// Channel metadata variables (any extra custom fields)
		if (chan.meta && typeof chan.meta === 'object') {
			for (const metaKey of Object.keys(chan.meta)) {
				if (metaKey === 'title' || metaKey === 'description') continue
				variables.push({
					variableId: `channel_${chan.id}_${metaKey}`,
					name: `${labelPrefix} ${metaKey}`,
				})
			}
		}
	}

	self.setVariableDefinitions(variables)

	// Find active stream title
	let streamTitle = self.streamData?.eventTitle || ''
	if (!streamTitle && channels.length > 0) {
		const activeChanWithTitle = channels.find((c) => c && c.meta?.title && (c.active || c.enabled))
		const anyChanWithTitle = channels.find((c) => c && c.meta?.title)
		streamTitle = activeChanWithTitle?.meta?.title || anyChanWithTitle?.meta?.title || ''
	}

	const isStreaming = Boolean(self.streamData?.isStreaming)
	const fps = Number(self.streamData?.fps || 0)
	const bitrateKbps = Number(self.streamData?.bitrate || 0)
	const bitrateMbps = (bitrateKbps / 1000).toFixed(1)

	// Calculate stream alert status
	let alertText = 'Offline'
	let hasAlert = false

	if (isStreaming) {
		const alerts = []
		if (fps > 0 && fps < 24) {
			alerts.push(`Low FPS (${fps})`)
		}
		if (bitrateKbps > 0 && bitrateKbps < 2000) {
			alerts.push(`Low Bitrate (${bitrateKbps}k)`)
		}
		if (alerts.length > 0) {
			alertText = `⚠️ ${alerts.join(' | ')}`
			hasAlert = true
		} else {
			alertText = 'OK'
		}
	} else {
		alertText = 'Offline'
	}

	// Update Variable Values
	const values = {
		stream_status: self.streamData?.status || 'OFFLINE',
		is_streaming: isStreaming ? 'true' : 'false',
		stream_title: streamTitle,
		stream_name: streamTitle,
		stream_event_title: streamTitle,
		stream_ws_connected: self.streamMonitor?.isConnected ? 'true' : 'false',
		stream_fps: self.streamData?.fps !== undefined ? String(self.streamData.fps) : '0',
		stream_bitrate: self.streamData?.bitrate !== undefined ? String(self.streamData.bitrate) : '0',
		stream_bitrate_mbps: `${bitrateMbps} Mbps`,
		stream_resolution: self.streamData?.resolution || 'N/A',
		stream_codec: self.streamData?.videoCodec || 'N/A',
		stream_audio_codec: self.streamData?.audioCodec || 'N/A',
		stream_alert: alertText,
		has_alert: hasAlert ? 'true' : 'false',
	}

	for (const chan of channels) {
		if (!chan || !chan.id) continue
		const platform = platforms.find((ptfrm) => ptfrm && ptfrm.id == chan.streamingPlatformId)
		values[`channel_${chan.id}_name`] = chan.displayName || ''
		values[`channel_${chan.id}_platform`] = platform?.name || ''
		values[`channel_${chan.id}_active`] = Boolean(chan.active ?? chan.enabled) ? 'true' : 'false'
		values[`channel_${chan.id}_title`] =
			chan.meta?.title !== undefined && chan.meta?.title !== null ? String(chan.meta.title) : ''
		values[`channel_${chan.id}_description`] =
			chan.meta?.description !== undefined && chan.meta?.description !== null ? String(chan.meta.description) : ''

		if (chan.meta && typeof chan.meta === 'object') {
			for (const [key, val] of Object.entries(chan.meta)) {
				values[`channel_${chan.id}_${key}`] = val !== undefined && val !== null ? String(val) : ''
			}
		}
	}

	self.setVariableValues(values)
}
