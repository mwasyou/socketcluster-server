/**
 * Module dependencies.
 */
 
var http = require('http');

/**
 * Expose ClusterServer constructor.
 *
 * @api public
 */
 
module.exports.ClusterServer = require('./clusterserver');

/**
 * Expose ClusterSocket constructor.
 *
 * @api public
 */
 
module.exports.ClusterSocket = require('./clustersocket');

/**
 * Creates an http.Server exclusively used for WS upgrades.
 *
 * @param {Number} port
 * @param {Function} callback
 * @param {Object} options
 * @return {ClusterServer} websocket cluster server
 * @api public
 */
 
module.exports.listen = function (port, options, fn) {
	if ('function' == typeof options) {
		fn = options;
		options = {};
	}

	var server = http.createServer(function (req, res) {
		res.writeHead(501);
		res.end('Not Implemented');
	});

	server.listen(port, fn);

	var engine = module.exports.attach(server, options);
	engine.httpServer = server;

	return engine;
};

/**
 * Captures upgrade requests for a http.Server.
 *
 * @param {http.Server} server
 * @param {Object} options
 * @return {ClusterServer} websocket cluster server
 * @api public
 */
 
module.exports.attach = function (server, options) {
	var clusterServer = new module.exports.ClusterServer(options);
	var options = options || {};
	var path = (options.path || '/engine.io').replace(/\/$/, '');

	var destroyUpgrade = (options.destroyUpgrade !== undefined) ? options.destroyUpgrade : true;
	var destroyUpgradeTimeout;
	if (options.destroyUpgradeTimeout) {
		destroyUpgradeTimeout = options.destroyUpgradeTimeout * 1000;
	} else {
		destroyUpgradeTimeout = 1000;
	}

	path += '/';

	function check(req) {
		return path == req.url.substr(0, path.length);
	}

	var listeners = server.listeners('request').slice(0);
	server.removeAllListeners('request');
	server.on('close', clusterServer.close.bind(clusterServer));

	server.on('request', function (req, res) {
		if (check(req)) {
			clusterServer.handleRequest(req, res);
		} else {
			for (var i = 0, l = listeners.length; i < l; i++) {
				listeners[i].call(server, req, res);
			}
		}
	});

	if (~clusterServer.transports.indexOf('websocket')) {
		server.on('upgrade', function (req, socket, head) {
			if (check(req)) {
				clusterServer.handleUpgrade(req, socket, head);
			} else if (false !== options.destroyUpgrade) {
				setTimeout(function () {
					if (socket.writable && socket.bytesWritten <= 0) {
						return socket.end();
					}
				}, options.destroyUpgradeTimeout);
			}
		});
	}

	var trns = clusterServer.transports;
	var policy = options.policyFile;
	if (~trns.indexOf('flashsocket') && false !== policy) {
		server.on('connection', function (socket) {
			clusterServer.handleSocket(socket);
		});
	}

	return clusterServer;
};