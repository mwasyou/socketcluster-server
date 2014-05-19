var engine = require('engine.io');
var EventEmitter = require('events').EventEmitter;
var Socket = engine.Socket;
var formatter = require('./formatter');

var Response = function (socket, id) {
  this.socket = socket;
  this.id = id;
};

Response.prototype._respond = function (responseData) {
  this.socket.send(formatter.stringify(responseData));
};

Response.prototype.end = function (data) {
  if (this.id) {
    var responseData = {
      cid: this.id
    };
    if (data !== undefined) {
      responseData.data = data;
    }
    
    this._respond(responseData);
  }
};

Response.prototype.error = function (error, data) {
  if (this.id) {
    var err;
    if(error instanceof Error) {
      err = {name: error.name, message: error.message, stack: error.stack};      
    } else {
      err = error;
    }
    
    var responseData = {
      cid: this.id,
      error: err
    };
    if (data !== undefined) {
      responseData.data = data;
    }
    
    this._respond(responseData);
  }
};

var ClusterSocket = function (id, server, transport) {
  this._localEvents = {
    'open': 1,
    'error': 1,
    'packet': 1,
    'heartbeat': 1,
    'data': 1,
    'message': 1,
    'upgrade': 1,
    'close': 1,
    'packetCreate': 1,
    'flush': 1,
    'drain': 1,
    'disconnect': 1
  };
  
  Socket.call(this, id, server, transport);
  
  var self = this;
  
  this._cid = 1;
  this._callbackMap = {};
  
  Socket.prototype.on.call(this, 'message', function (message) {
    var e = formatter.parse(message);
    
    if(e.event) {
      var response = new Response(self, e.cid);
      EventEmitter.prototype.emit.call(self, e.event, e.data, response);
    } else if (e.cid != null) {
      var ret = self._callbackMap[e.cid];
      if (ret) {
        clearTimeout(ret.timeout);
        delete self._callbackMap[e.cid];
        ret.callback(e.error, e.data);
      }
    }
  });
};

ClusterSocket.prototype = Object.create(Socket.prototype);

ClusterSocket.prototype._nextCallId = function () {
  return this._cid++;
};

ClusterSocket.prototype.emit = function (event, data, callback) {
  if (this._localEvents[event] == null) {
    var eventObject = {
      event: event
    };
    if (data !== undefined) {
      eventObject.data = data;
    }
    if (callback) {
      var self = this;
      var cid = this._nextCallId();
      eventObject.cid = cid;
      
      var timeout = setTimeout(function () {
        delete self._callbackMap[cid];
        callback('Event response timed out', eventObject);
      }, this.server.pingTimeout);
      
      this._callbackMap[cid] = {callback: callback, timeout: timeout};
    }
    Socket.prototype.send.call(this, formatter.stringify(eventObject));
  } else {
    EventEmitter.prototype.emit.call(this, event, data);
  }
};

ClusterSocket.prototype.on = function (event, listener) {
  if (this._localEvents[event] == null) {
    EventEmitter.prototype.on.call(this, event, listener);
  } else {
    EventEmitter.prototype.on.apply(this, arguments);
  }
};

ClusterSocket.prototype.once = function (event, listener) {
  if (this._localEvents[event] == null) {
    EventEmitter.prototype.once.call(this, event, listener);
  } else {
    EventEmitter.prototype.once.apply(this, arguments);
  }
};

ClusterSocket.prototype.removeListener = function (event, listener) {
  if (this._localEvents[event] == null) {
    EventEmitter.prototype.removeListener.call(this, event, listener);
  } else {
    EventEmitter.prototype.removeListener.apply(this, arguments);
  }
};

ClusterSocket.prototype.removeAllListeners = function (event) {
  EventEmitter.prototype.removeAllListeners.call(this, event);
};

ClusterSocket.prototype.listeners = function (event) {
  EventEmitter.prototype.listeners.call(this, event);
};

module.exports = ClusterSocket;