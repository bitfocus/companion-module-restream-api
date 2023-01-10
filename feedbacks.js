const { combineRgb } = require('@companion-module/base')

module.exports = async function (self) {
	console.log('Updating Feedbacks')
	self.setFeedbackDefinitions({
		ChannelState: {
			name: 'Channel State',
			type: 'boolean',
			label: 'Channel State',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(0, 0, 0),
			},

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
			callback: (fb) => {
				console.log('Checking Feedback')
				console.log(fb.options.channel)
				return self.channels.find((ch) => ch.id == fb.options.channel).enabled
			},
		},
	})
}
