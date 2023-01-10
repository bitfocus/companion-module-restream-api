const http = require('http')
const url = require('url')
const destroyer = require('server-destroy')

/**
 * Process for acquiring new user authorization tokens.
 */
class HttpReceiver {
	/**
	 * Initialize this receiver.
	 * @param listenHost Where to start the HTTP server.
	 * @param listenPort Where to start the HTTP server.
	 */
	constructor(listenHost, listenPort) {
		this.Signal = new DetachedPromise()
		this.ListenHost = listenHost
		this.ListenPort = listenPort
	}

	/**
	 * Start the listener for the authorization code callback.
	 * @param onReady Function that will be called when the listener is ready to accept callbacks.
	 * @returns Promise for the received value.
	 */
	async getCode(onReady) {
		this.abort() // cancel previous attempts

		this.CallbackServer = new http.Server()
		destroyer(this.CallbackServer)

		this.CallbackServer.on('listening', onReady)
		this.CallbackServer.on('request', (req, res) => this.handleRequest(req, res))
		this.CallbackServer.on('close', () => {
			// note: if the promise is already resolve()'d, this has no effect (which is great)
			this.Signal.Reject(new Error('Authorization process aborted.'))
		})
		this.CallbackServer.listen(this.ListenPort, this.ListenHost)

		return this.Signal.Promise
	}

	/**
	 * Handle a request to the HTTP authorization code listener.
	 * @param req HTTP request
	 * @param res HTTP response
	 */
	handleRequest(req, res) {
		if (typeof req.url == 'undefined') return

		const address = url.parse(req.url, true)

		const codeFrag = address.query['code']
		let code

		if (typeof codeFrag == 'string') {
			code = codeFrag
		} else if (Array.isArray(codeFrag) && codeFrag.length > 0) {
			code = codeFrag[0]
		} else {
			res.writeHead(400, { 'Content-Type': 'text/plain' })
			res.end('Authorization token required')
			return
		}

		res.writeHead(200, { 'Content-Type': 'text/plain' })
		res.end('Authorization code received successfully! You can now close this window.')

		this.Signal.Resolve(code)
		this.abort()
	}

	/**
	 * Stop the server (and cancel pending listener)
	 */
	abort() {
		this.CallbackServer?.destroy()
		this.CallbackServer = undefined
	}
}

/**
 * Promise that can be fulfilled outside of its executor.
 */
class DetachedPromise {
	/** Create a new detached promise. */
	constructor() {
		this.Resolve = (_) => {
			return
		}
		this.Reject = (_) => {
			return
		}

		this.Promise = new Promise((res, rej) => {
			this.Resolve = res
			this.Reject = rej
		})
	}
}

module.exports = HttpReceiver
