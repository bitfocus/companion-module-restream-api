const http = require('http')

/**
 * Process for acquiring OAuth authorization code via local HTTP server.
 */
class HttpReceiver {
	/**
	 * Initialize receiver.
	 * @param {string} listenHost Where to start HTTP server (e.g. 'localhost' or '127.0.0.1')
	 * @param {number} listenPort Port to listen on (e.g. 8081)
	 * @param {number} [timeoutMs] Optional timeout in ms (default 120000)
	 */
	constructor(listenHost = 'localhost', listenPort = 8081, timeoutMs = 120000) {
		this.Signal = new DetachedPromise()
		this.ListenHost = listenHost
		this.ListenPort = listenPort
		this.TimeoutMs = timeoutMs
		this.CallbackServer = null
		this.sockets = new Set()
		this.timeoutTimer = null
		this.closeTimer = null
	}

	/**
	 * Start listener for OAuth authorization code callback.
	 * @param {Function} onReady Callback when server is listening
	 * @returns {Promise<string>} Promise resolving to received authorization code
	 */
	async getCode(onReady) {
		this.abort() // Cancel any previous attempts

		this.Signal = new DetachedPromise()
		this.CallbackServer = http.createServer((req, res) => this.handleRequest(req, res))

		// Track active sockets for clean destruction
		this.CallbackServer.on('connection', (socket) => {
			this.sockets.add(socket)
			socket.once('close', () => this.sockets.delete(socket))
		})

		this.CallbackServer.on('error', (err) => {
			this.clearTimeoutTimer()
			this.Signal.Reject(new Error(`OAuth listener error: ${err.message}`))
			this.abort()
		})

		this.CallbackServer.on('close', () => {
			this.clearTimeoutTimer()
			this.Signal.Reject(new Error('Authorization process aborted or listener closed.'))
		})

		if (typeof onReady === 'function') {
			this.CallbackServer.once('listening', onReady)
		}

		if (this.TimeoutMs > 0) {
			this.timeoutTimer = setTimeout(() => {
				this.Signal.Reject(new Error(`OAuth listener timed out after ${this.TimeoutMs}ms`))
				this.abort()
			}, this.TimeoutMs)
		}

		this.CallbackServer.listen(this.ListenPort, this.ListenHost)
		return this.Signal.Promise
	}

	/**
	 * Handle incoming HTTP request.
	 * @param {http.IncomingMessage} req
	 * @param {http.ServerResponse} res
	 */
	handleRequest(req, res) {
		if (!req.url) return

		try {
			const host = req.headers.host || `${this.ListenHost}:${this.ListenPort}`
			const reqUrl = new URL(req.url, `http://${host}`)

			// Ignore favicon requests
			if (reqUrl.pathname === '/favicon.ico') {
				res.writeHead(204)
				res.end()
				return
			}

			const code = reqUrl.searchParams.get('code')
			const error = reqUrl.searchParams.get('error')
			const errorDesc = reqUrl.searchParams.get('error_description')

			if (error) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
				res.end(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#18181b;color:#f87171;">
					<h2>OAuth Authorization Failed</h2>
					<p>${error}: ${errorDesc || 'No details provided'}</p>
					<p>You can close this tab and try again.</p>
				</body></html>`)
				this.Signal.Reject(new Error(`OAuth Error: ${error} - ${errorDesc || ''}`))
				this.abort()
				return
			}

			if (!code) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
				res.end(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#18181b;color:#f87171;">
					<h2>Authorization code missing</h2>
					<p>No authorization code was found in the request.</p>
				</body></html>`)
				return
			}

			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#18181b;color:#4ade80;">
				<h2>Authorization Successful!</h2>
				<p>Restream code received successfully. You can now close this tab and return to Bitfocus Companion.</p>
			</body></html>`)

			this.clearTimeoutTimer()
			this.clearCloseTimer()
			this.Signal.Resolve(code)
			// Allow response to flush before aborting server
			this.closeTimer = setTimeout(() => this.abort(), 200)
		} catch (err) {
			res.writeHead(500, { 'Content-Type': 'text/plain' })
			res.end(`Internal Server Error: ${err.message}`)
		}
	}

	clearTimeoutTimer() {
		if (this.timeoutTimer) {
			clearTimeout(this.timeoutTimer)
			this.timeoutTimer = null
		}
	}

	clearCloseTimer() {
		if (this.closeTimer) {
			clearTimeout(this.closeTimer)
			this.closeTimer = null
		}
	}

	/**
	 * Stop server and clean up all connections.
	 */
	abort() {
		this.clearTimeoutTimer()
		this.clearCloseTimer()

		for (const socket of this.sockets) {
			try {
				socket.destroy()
			} catch {
				// Ignore socket destroy errors
			}
		}
		this.sockets.clear()

		if (this.CallbackServer) {
			try {
				if (typeof this.CallbackServer.closeAllConnections === 'function') {
					this.CallbackServer.closeAllConnections()
				}
				this.CallbackServer.close()
			} catch {
				// Ignore close error
			}
			this.CallbackServer = null
		}
	}
}

/**
 * Promise that can be resolved or rejected externally.
 */
class DetachedPromise {
	constructor() {
		this.Resolve = () => {}
		this.Reject = () => {}
		this.isSettled = false

		this.Promise = new Promise((res, rej) => {
			this.Resolve = (val) => {
				if (!this.isSettled) {
					this.isSettled = true
					res(val)
				}
			}
			this.Reject = (err) => {
				if (!this.isSettled) {
					this.isSettled = true
					rej(err)
				}
			}
		})
	}
}

module.exports = HttpReceiver
