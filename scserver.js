var engine = require('engine.io');
var Server = engine.Server;
var ClusterSocket = require('./scsocket');
var transports = engine.transports;
var EventEmitter = require('events').EventEmitter;
var base64id = require('base64id');
var async = require('async');

var SCServer = function (options) {
  var self = this;
  
  var opts = {
    transports: ['polling', 'websocket'],
    host: 'localhost'
  };
  
  var i;
  for (i in options) {
    opts[i] = options[i];
  }
  
  this.MIDDLEWARE_HANDSHAKE = 'handshake';

  this._middleware = {};
  this._middleware[this.MIDDLEWARE_HANDSHAKE] = [];
  
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
  this.host = opts.host;
  this.secure = opts.secure ? 1 : 0;
  
  this._ioClusterClient = opts.ioClusterClient;
  this._sessionIdRegex = new RegExp('(' + opts.sessionCookie + '=)([^;]*)');
  this._sessionHostRegex = /^[^_]*/;
  this._hostRegex = /^[^:]*/;
  this._hasSidRegex = /[?&]sid=/;
  
  this._appName = opts.appName;
  this._url = opts.path || '/engine.io';
  
  this._handleSocketError = function (error) {
    self.emit('error', error);
  };
};

SCServer.prototype = Object.create(Server.prototype);

SCServer.prototype.global = function () {
  return this._ioClusterClient.global();
};

SCServer.prototype.getURL = function () {
  return this._url;
};

SCServer.prototype._parseSessionId = function (cookieString) {
  if (typeof cookieString == 'string') {
    var result = cookieString.match(this._sessionIdRegex);
    if (result) {
      var sessionHost = result[2].match(this._sessionHostRegex);
      if (sessionHost && sessionHost[0] != this.host && sessionHost[0] != 'localhost') {
        return null;
      }
      return result[2];
    }
  }
  return null;
};

SCServer.prototype.generateId = function (req) {
  var host;
  if (this.host) {
    host = this.host;
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

SCServer.prototype.on = function (event, listener) {
  if (event == 'ready' || event == 'sessiondestroy') {
    this._ioClusterClient.on(event, listener);
  } else {
    Server.prototype.on.apply(this, arguments);
  }
};

SCServer.prototype.removeListener = function (event, listener) {
  if (event == 'ready' || event == 'sessiondestroy') {
    this._ioClusterClient.removeListener(event, listener);
  } else {
    Server.prototype.removeListener.apply(this, arguments);
  }
};

SCServer.prototype.sendErrorMessage = function (res, code) {
  res.writeHead(400, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({
    code: code,
    message: Server.errorMessages[code]
  }));
};

SCServer.prototype.addMiddleware = function (type, middleware) {
  this._middleware[type].push(middleware);
};

SCServer.prototype.verify = function (req, upgrade, fn) {
  var self = this;
  
  var handshakeMiddleware = this._middleware[this.MIDDLEWARE_HANDSHAKE];
  if (handshakeMiddleware.length < 1 || this._hasSidRegex.test(req.url)) {
    Server.prototype.verify.call(this, req, upgrade, fn);
  } else {
    async.applyEachSeries(handshakeMiddleware, req, function (err) {
      if (err) {
        self.emit('notice', err);
        fn(err);
      } else {
        Server.prototype.verify.call(self, req, upgrade, fn);
      }
    });
  }
};

SCServer.prototype.handshake = function (transport, req) {
  var self = this;
  
  var id = this.generateId(req);
  
  var transportName = transport;
  try {
    var transport = new transports[transport](req);
    if ('polling' == transportName) {
      transport.maxHttpBufferSize = this.maxHttpBufferSize;
    }

    if (req._query && req._query.b64) {
      transport.supportsBinary = false;
    } else {
      transport.supportsBinary = true;
    }
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
  
  this._ioClusterClient.bind(socket, function (err, sock, isNotice) {
    if (err) {
      var errorMessage = 'Failed to bind socket to io cluster - ' + err;
      socket.emit('fail', errorMessage);
      socket.close();
      if (isNotice) {
        self.emit('notice', errorMessage);
      } else {
        self.emit('error', new Error(errorMessage));
      }
    } else {
      socket.session = self._ioClusterClient.session(socket.ssid, socket.id, true);
      socket.global = self._ioClusterClient.global(socket.id);
      
      socket.emit('connect', {
        soid: socket.id,
        appName: self._appName
      }, function (err) {
        self.emit('connection', socket);
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
        self.emit('disconnection', socket);
        socket.emit('disconnect', socket);
      }
    });
  });
};

module.exports = SCServer;