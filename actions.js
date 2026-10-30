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

	self.setActionDefinitions({
		ChangeChannelState: {
			name: 'Change Channel State',
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
					label: 'State',
					choices: [
						{ id: 'true', label: 'Enable / Turn On' },
						{ id: 'false', label: 'Disable / Turn Off' },
					],
					default: 'true',
				},
			],
			callback: async (event) => {
				let chanId = event?.options?.channel
				if (typeof self.parseVariablesInString === 'function' && typeof chanId === 'string' && chanId.includes('$')) {
					chanId = await self.parseVariablesInString(chanId)
				}
				await self.setChannel({ ...event?.options, channel: chanId })
			},
		},

		ToggleChannelState: {
			name: 'Toggle Channel State',
			options: [
				{
					id: 'channel',
					type: 'dropdown',
					label: 'Channel',
					choices: channelChoices,
					default: defaultChannel,
				},
			],
			callback: async (event) => {
				let chanId = event?.options?.channel
				if (typeof self.parseVariablesInString === 'function' && typeof chanId === 'string' && chanId.includes('$')) {
					chanId = await self.parseVariablesInString(chanId)
				}
				const chanList = Array.isArray(self.channels) ? self.channels : []
				const target = chanList.find((ch) => ch && String(ch.id) === String(chanId))
				if (target) {
					const currentState = Boolean(target.active ?? target.enabled)
					const newState = !currentState
					await self.setChannel({ channel: chanId, enabled: String(newState) })
				} else {
					if (typeof self.log === 'function') {
						self.log('warn', `ToggleChannelState: Channel ${chanId} not found in channel cache`)
					}
				}
			},
		},

		SetChannelMeta: {
			name: 'Set Channel Title & Description',
			options: [
				{
					id: 'channel',
					type: 'dropdown',
					label: 'Channel',
					choices: channelChoices,
					default: defaultChannel,
				},
				{
					id: 'title',
					type: 'textinput',
					label: 'Stream Title',
					default: '',
					useVariables: true,
				},
				{
					id: 'description',
					type: 'textinput',
					label: 'Stream Description',
					default: '',
					useVariables: true,
				},
			],
			callback: async (event) => {
				let chanId = event?.options?.channel
				let title = event?.options?.title ?? ''
				let description = event?.options?.description

				if (typeof self.parseVariablesInString === 'function') {
					if (typeof chanId === 'string' && chanId.includes('$')) {
						chanId = await self.parseVariablesInString(chanId)
					}
					if (typeof title === 'string' && title.includes('$')) {
						title = await self.parseVariablesInString(title)
					}
					if (typeof description === 'string' && description.includes('$')) {
						description = await self.parseVariablesInString(description)
					}
				}

				await self.setChannelMeta(chanId, title, description)
			},
		},

		RefreshData: {
			name: 'Refresh Data / Poll API',
			options: [],
			callback: async () => {
				await self.poll()
			},
		},

		ReconnectWebSocket: {
			name: 'Reconnect Streaming Monitor (WebSocket)',
			options: [],
			callback: async () => {
				if (self.streamMonitor) {
					self.streamMonitor.reconnect()
				}
			},
		},
	})
}
