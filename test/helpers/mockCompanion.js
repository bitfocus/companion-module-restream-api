const Module = require('module')

const InstanceStatus = {
	Ok: 'ok',
	Connecting: 'connecting',
	Disconnected: 'disconnected',
	ConnectionFailure: 'connection_failure',
	AuthenticationFailure: 'authentication_failure',
	BadConfig: 'bad_config',
	UnknownError: 'unknown_error',
	Error: 'error',
}

const Regex = {
	SOMETHING: '/.+/',
	NUMBER: '/^\\d+$/',
	IP: '/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/',
	PORT: '/^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/',
}

function combineRgb(r, g, b) {
	return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

class MockInstanceBase {
	constructor(internal) {
		this.internal = internal
		this.status = InstanceStatus.Disconnected
		this.statusMessage = ''
		this.actionDefinitions = {}
		this.feedbackDefinitions = {}
		this.variableDefinitions = []
		this.variableValues = {}
		this.presetDefinitions = {}
		this.savedConfig = null
		this.logs = []
	}

	updateStatus(status, message) {
		this.status = status
		this.statusMessage = message || ''
	}

	saveConfig(config) {
		this.savedConfig = { ...config }
	}

	log(level, message) {
		this.logs.push({ level, message, timestamp: new Date() })
	}

	setActionDefinitions(definitions) {
		this.actionDefinitions = definitions
	}

	setFeedbackDefinitions(definitions) {
		this.feedbackDefinitions = definitions
	}

	setVariableDefinitions(definitions) {
		this.variableDefinitions = definitions
	}

	setVariableValues(values) {
		this.variableValues = { ...this.variableValues, ...values }
	}

	setPresetDefinitions(definitions) {
		this.presetDefinitions = definitions
	}

	checkFeedbacks(...ids) {
		// Mock feedback check
		return ids
	}
}

function runEntrypoint(ModuleClass, upgrades) {
	// Entry point hook
}

const mockCompanionBase = {
	InstanceBase: MockInstanceBase,
	InstanceStatus,
	Regex,
	combineRgb,
	runEntrypoint,
}

// Hook Module._resolveFilename if @companion-module/base is not installed
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === '@companion-module/base') {
		return '__mock_companion_base__'
	}
	return originalResolve.call(this, request, parent, isMain, options)
}

require.cache['__mock_companion_base__'] = {
	id: '__mock_companion_base__',
	filename: '__mock_companion_base__',
	loaded: true,
	exports: mockCompanionBase,
}

module.exports = {
	mockCompanionBase,
	MockInstanceBase,
	InstanceStatus,
	combineRgb,
	Regex,
}
