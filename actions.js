module.exports = async function (self) {
	self.setActionDefinitions({
		ChangeChannelState: {
			name: 'Change Channel State',
			options: [
				{
					id: 'channel',
					type: 'dropdown',
					label: 'Channel',
					choices: self.channels.map((chan) => ({
						id: chan.id.toString(),
						label: `${self.platforms.find((ptfrm) => ptfrm.id == chan.streamingPlatformId).name} (${chan.displayName})`,
					})),
				},
				{
					id: 'enabled',
					type: 'dropdown',
					label: 'Enabled',
					choices: [
						{ id: 'true', label: 'Yes' },
						{ id: 'false', label: 'No' },
					],
					default: 'true',
				},
			],
			callback: async (event) => {
				self.setChannel(event.options)
			},
		},
	})
}
