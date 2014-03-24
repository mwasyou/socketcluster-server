var engine = require('engine.io');
var Server = engine.Server;
var ClusterSocket = require('./clustersocket');
var transports = engine.transports;
var EventEmitter = require('events').EventEmitter;
var base64id = require('base64id');

var ClusterServer = function (options) {
	var self = this;
	var opts = {
		transports: ['polling', 'websocket'],
		hostname: 'localhost'
	};
	
	var i;
	for (i in options) {
		opts[i] = options[i];
	}
	
	var pollingEnabled = false;
	for (i in opts.transports) {
		if (opts.transports[i] == 'polling') {
			pollingEnabled = true;
			break;
		}
	}
	if (!pollingEnabled) {
		opts.transports.unshift('polling');
	}

	opts.pingTimeout = opts.pingTimeout * 1000;
	opts.pingInterval = opts.pingInterval * 1000;
	opts.upgradeTimeout = opts.upgradeTimeout * 1000;
	
	opts.cookie = 'n/' + opts.appName + '/io';
	opts.sessionCookie = 'n/' + opts.appName + '/ssid';
	
	Server.call(this, opts);
	
	this.sourcePort = opts.sourcePort;
	this.hostname = opts.hostname;
	this.secure = opts.secure ? 1 : 0;
	
	this._ioClusterClient = opts.ioClusterClient;
	this._sessionIdRegex = new RegExp('(' + opts.sessionCookie + '=)([^;]*)');
	this._hostRegex = /^[^:]*/;
	this._appName = opts.appName;
	this._url = opts.path;
	
	this._handleSocketError = function (error) {
		self.emit('error', error);
	};
};

ClusterServer.prototype = Object.create(Server.prototype);

ClusterServer.prototype.getURL = function () {
	return this._url;
};

ClusterServer.prototype._parseSessionId = function (cookieString) {
	if(typeof cookieString == 'string') {
		var result = cookieString.match(this._sessionIdRegex);
		if(result) {
			return result[2];
		}
	}
	return null;
};

ClusterServer.prototype.generateId = function (req) {
	var host;
	if (this.hostname) {
		host = this.hostname;
	} else {
		host = req.headers.host.match(this._hostRegex);
		if (host) {
			host = host[0];
		} else {
			host = '';
		}
	}
	var port = req.connection.address().port;
	var sourcePort;
	if (this.sourcePort == null) {
		sourcePort = port;
	} else {
		sourcePort = this.sourcePort;
	}
	return host + '_' + port + '_' + this.sourcePort + '_' + this.secure + '_' + base64id.generateId();
};

ClusterServer.prototype.on = function (event, listener) {
	if (event == 'ready') {
		this._ioClusterClient.on(event, listener);
	} else {
		Server.prototype.on.apply(this, arguments);
	}
};

ClusterServer.prototype.removeListener = function (event, listener) {
	if (event == 'ready') {
		this._ioClusterClient.removeListener(event, listener);
	} else {
		Server.prototype.removeListener.apply(this, arguments);
	}
};

ClusterServer.prototype.sendErrorMessage = function (res, code) {
	res.writeHead(400, {'Content-Type': 'application/json'});
	res.end(JSON.stringify({
		code: code,
		message: Server.errorMessages[code]
	}));
};

ClusterServer.prototype.handshake = function (transport, req) {
	var self = this;
	
	var id = this.generateId(req);
	try {
		var transport = new transports[transport](req);
	} catch (e) {
		this.sendErrorMessage(req.res, Server.errors.BAD_REQUEST);
		return;
	}
	
	var socket = new ClusterSocket(id, this, transport);
	
	socket.on('error', function (err) {
		self._handleSocketError(err);
		socket.close();
	});

	if (false !== this.cookie) {
		transport.on('headers', function (headers) {
			headers['Set-Cookie'] = self.cookie + '=' + id;
		});
	}

	transport.onRequest(req);

	this.clients[id] = socket;
	this.clientsCount++;
	
	var headers = req.headers || {};
	
	if (req.connection) {
		socket.address = headers['x-forwarded-for'] || req.connection.remoteAddress;
	}
	var ssid = this._parseSessionId(headers.cookie);
	socket.ssid = ssid || socket.id;
	
	this._ioClusterClient.bind(socket, function (err, sock, notice) {
		if (err) {
			var errorMessage = 'Failed to bind socket to io cluster - ' + err;
			socket.emit('fail', errorMessage);
			socket.close();
			if (notice) {
				self.emit('notice', errorMessage);
			} else {
				self.emit('error', new Error(errorMessage));
			}
		} else {
			socket.session = self._ioClusterClient.session(socket.ssid, socket.id);
			socket.global = self._ioClusterClient.global(socket.id);
			self.emit('connection', socket);
			socket.emit('connect', {
				soid: socket.id,
				appName: self._appName
			});
		}
	});
	
	socket.once('close', function () {
		self._ioClusterClient.unbind(socket, function (err) {
			if (err) {
				self.emit('error', new Error('Failed to unbind socket from io cluster - ' + err));
			} else {
				delete self.clients[id];
				self.clientsCount--;
				self.emit('disconnect', 'Socket was disconnected');
			}
		});
	});
};

module.exports = ClusterServer;