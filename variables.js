module.exports = async function (self) {
	console.log('Updating Variable Definitions')
	var variables = []

	//Expose variables for each channel
	for (var chan of self.channels) {
		//add a variable for each channel's meta
		for (var meta in chan.meta) {
			variables.push({
				variableId: `channel_${chan.id}_${meta}`,
				name: `${self.platforms.find((ptfrm) => ptfrm.id == chan.streamingPlatformId).name} (${
					chan.displayName
				}) ${meta}`,
			})
		}
	}
	self.setVariableDefinitions(variables)

	console.log('Updating Variable Values')
	var values = {}
	for (var chan of self.channels) {
		for (var meta in chan.meta) {
			values[`channel_${chan.id}_${meta}`] = chan.meta[meta]
		}
	}

	self.setVariableValues(values)
}
