const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

test('Manifest is valid and conforms to Bitfocus Companion v5 node20 runtime specifications', () => {
	const manifestPath = path.join(__dirname, '..', 'companion', 'manifest.json')
	assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist in companion directory')

	const content = fs.readFileSync(manifestPath, 'utf8')
	const manifest = JSON.parse(content)

	assert.strictEqual(manifest.id, 'restream-api')
	assert.strictEqual(manifest.name, 'restream-api')
	assert.ok(manifest.version, 'version must be present')
	assert.ok(manifest.description, 'description must be present')

	// Runtime verification
	assert.ok(manifest.runtime, 'runtime field must exist')
	assert.strictEqual(manifest.runtime.type, 'node20', 'runtime type must be node20')
	assert.strictEqual(manifest.runtime.api, 'nodejs-ipc', 'runtime api must be nodejs-ipc')
	assert.strictEqual(manifest.runtime.entrypoint, '../main.js', 'runtime entrypoint must point to main.js')

	// Entrypoint target file existence check
	const entrypointPath = path.resolve(path.dirname(manifestPath), manifest.runtime.entrypoint)
	assert.ok(fs.existsSync(entrypointPath), 'Entrypoint target file must exist on disk')

	// Maintainers and Manufacturer check
	assert.ok(Array.isArray(manifest.maintainers), 'maintainers must be an array')
	assert.ok(manifest.maintainers.length > 0, 'at least one maintainer required')
	assert.strictEqual(manifest.manufacturer, 'Restream')
})
