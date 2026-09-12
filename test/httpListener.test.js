const test = require('node:test')
const assert = require('node:assert/strict')
const HttpReceiver = require('../httpListener')

class MockResponse {
	constructor() {
		this.statusCode = 0
		this.headers = {}
		this.body = ''
		this.ended = false
	}
	writeHead(code, headers) {
		this.statusCode = code
		this.headers = { ...this.headers, ...headers }
	}
	end(chunk) {
		if (chunk) this.body += chunk
		this.ended = true
	}
}

test('HttpReceiver - Successfully captures authorization code from handleRequest', async () => {
	const receiver = new HttpReceiver('localhost', 8081, 10000)
	receiver.Signal = new (require('../httpListener').prototype.constructor.name === 'HttpReceiver'
		? receiver.Signal.constructor
		: Object)()

	const codePromise = receiver.Signal.Promise

	const req = {
		url: '/?code=test_oauth_code_xyz123&state=companion_restream',
		headers: { host: 'localhost:8081' },
	}
	const res = new MockResponse()

	receiver.handleRequest(req, res)

	assert.strictEqual(res.statusCode, 200)
	assert.ok(res.body.includes('Authorization Successful'))

	const receivedCode = await codePromise
	assert.strictEqual(receivedCode, 'test_oauth_code_xyz123')

	receiver.abort()
})

test('HttpReceiver - Ignores /favicon.ico with 204 No Content', () => {
	const receiver = new HttpReceiver('localhost', 8081, 10000)

	const req = {
		url: '/favicon.ico',
		headers: { host: 'localhost:8081' },
	}
	const res = new MockResponse()

	receiver.handleRequest(req, res)

	assert.strictEqual(res.statusCode, 204)
	assert.strictEqual(res.ended, true)
	assert.strictEqual(receiver.Signal.isSettled, false)

	receiver.abort()
})

test('HttpReceiver - Handles missing authorization code properly', async () => {
	const receiver = new HttpReceiver('localhost', 8081, 10000)

	const req = {
		url: '/?nocode=1',
		headers: { host: 'localhost:8081' },
	}
	const res = new MockResponse()

	receiver.handleRequest(req, res)

	assert.strictEqual(res.statusCode, 400)
	assert.ok(res.body.includes('Authorization code missing'))
	assert.strictEqual(receiver.Signal.isSettled, false)

	receiver.abort()
})

test('HttpReceiver - Handles OAuth error callback parameter', async () => {
	const receiver = new HttpReceiver('localhost', 8081, 10000)
	const codePromise = receiver.Signal.Promise

	const req = {
		url: '/?error=access_denied&error_description=User_cancelled_login',
		headers: { host: 'localhost:8081' },
	}
	const res = new MockResponse()

	receiver.handleRequest(req, res)

	assert.strictEqual(res.statusCode, 400)
	assert.ok(res.body.includes('OAuth Authorization Failed'))

	await assert.rejects(codePromise, /access_denied/)
	receiver.abort()
})

test('HttpReceiver - Abort cleans server and timeout timer immediately', async () => {
	const receiver = new HttpReceiver('localhost', 8081, 5000)
	receiver.timeoutTimer = setTimeout(() => {}, 5000)

	receiver.abort()
	assert.strictEqual(receiver.CallbackServer, null)
	assert.strictEqual(receiver.timeoutTimer, null)
	assert.strictEqual(receiver.sockets.size, 0)
})
