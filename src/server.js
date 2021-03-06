module.exports = function (classes){
  'use strict';

  var
    net = require('net'),
    http = require('http'),
    JsonParser = require('jsonparse'),

    UNAUTHORIZED = 'Unauthorized\n',
    METHOD_NOT_ALLOWED = 'Method Not Allowed\n',
    INVALID_REQUEST = 'Invalid Request\n',
    _ = classes._,
    Endpoint = classes.Endpoint,
    WebSocket = classes.Websocket,
    /**
     * JSON-RPC Server.
     */
      Server = Endpoint.define('Server', {
      construct: function (opts){
        this.$super();

        this.opts = opts || {};
        this.opts.type = typeof this.opts.type !== 'undefined' ? this.opts.type : 'http';
        this.opts.websocket = typeof this.opts.websocket !== 'undefined' ? this.opts.websocket : true;
      },
      _checkAuth: function(req, res){
        var self = this;

        if (self.authHandler) {
          var
            authHeader = req.headers['authorization'] || '', // get the header
            authToken = authHeader.split(/\s+/).pop() || '', // get the token
            auth = new Buffer(authToken, 'base64').toString(), // base64 -> string
            parts = auth.split(/:/), // split on colon
            username = parts[0],
            password = parts[1];

          if (!this.authHandler(username, password)) {
            if (res) {
              classes.EventEmitter.trace('<--', 'Unauthorized request');
              Server.handleHttpError(req, res, 401, UNAUTHORIZED);
            }
            return false;
          }
        }
        return true;
      },
      /**
       * Start listening to incoming connections.
       */
      listen   : function (port, host){
        var
          self = this,
          server = http.createServer();

        server.on('request', function (req, res){
          self.handleHttp(req, res);
        });

        if (port) {
          server.listen(port, host);
          Endpoint.trace('***', 'Server listening on http://' +
            (host || '127.0.0.1') + ':' + port + '/');
        }

        if (this.opts.websocket === true) {
          server.on('upgrade', function (req, socket, body){
            if (WebSocket.isWebSocket(req)) {
              if (self._checkAuth(req, socket)) {
                self.handleWebsocket(req, socket, body);
              }
            }
          });
        }

        return server;
      },

      listenRaw: function (port, host){
        var
          self = this,
          server = net.createServer(function(socket){
            self.handleRaw(socket);
          });

        server.listen(port, host);

        Endpoint.trace('***', 'Server listening on tcp://' +
          (host || '127.0.0.1') + ':' + port + '/');

        return server;
      },

      listenHybrid: function (port, host){
        var
          self = this,
          httpServer = self.listen(),
          server = net.createServer(function(socket){
            self.handleHybrid(httpServer, socket);
          });

        server.listen(port, host);

        Endpoint.trace('***', 'Server (hybrid) listening on http+tcp://' +
          (host || '127.0.0.1') + ':' + port + '/');

        return server;
      },

      /**
       * Handle HTTP POST request.
       */
      handleHttp: function (req, res){
        var buffer = '', self = this;

        if (!self._checkAuth(req, res)) {
          return;
        }

        Endpoint.trace('<--', 'Accepted http request');

        if (req.method !== 'POST') {
          Server.handleHttpError(req, res, 405, METHOD_NOT_ALLOWED);
          return;
        }

        var handle = function (buf){
          // Check if json is valid JSON document
          var decoded;

          try {
            decoded = JSON.parse(buf);
          } catch (error) {
            Server.handleHttpError(req, res, 400, INVALID_REQUEST);
            return;
          }

          // Check for the required fields, and if they aren't there, then
          // dispatch to the handleHttpError function.
          if (!(decoded.method && decoded.params && decoded.id)) {
            Endpoint.trace('-->', 'Response (invalid request)');
            Server.handleHttpError(req, res, 400, INVALID_REQUEST);
            return;
          }

          var reply = function (json){
            var encoded = JSON.stringify(json);

            if (!conn.isStreaming) {
              res.writeHead(200, {'Content-Type': 'application/json',
                'Content-Length'                : encoded.length});
              res.write(encoded);
              res.end();
            } else {
              res.writeHead(200, {'Content-Type': 'application/json'});
              res.write(encoded);
              // Keep connection open
            }
          };

          var callback = function (err, result){
            if (err) {
              if (self.listeners('error').length) {
                self.emit('error', err);
              }
              Endpoint.trace('-->', 'Failure (id ' + decoded.id + '): ' +
                (err.stack ? err.stack : err.toString()));
              err = err.toString();
              result = null;
            } else {
              Endpoint.trace('-->', 'Response (id ' + decoded.id + '): ' +
                JSON.stringify(result));
              err = null;
            }

            // Don't return a message if it doesn't have an ID
            if (Endpoint.hasId(decoded)) {
              reply({
                'jsonrpc': '2.0',
                'result' : result,
                'error'  : err,
                'id'     : decoded.id
              });
            }
          };

          var conn = classes.HttpServerConnection.create(self, req, res);

          self.handleCall(decoded, conn, callback);
        }; // function handle(buf)

        req.on('data', function (chunk){
          buffer = buffer + chunk;
        });

        req.on('end', function (){
          handle(buffer);
        });
      },

      handleRaw: function (socket){
        var self = this, conn, parser, requireAuth;

        Endpoint.trace('<--', 'Accepted socket connection');

        conn = classes.SocketConnection.create(self, socket);
        parser = new JsonParser();
        requireAuth = !!this.authHandler;

        parser.onValue = function (decoded){
          if (this.stack.length) {
            return;
          }

          // We're on a raw TCP socket. To enable authentication we implement a simple
          // authentication scheme that is non-standard, but is easy to call from any
          // client library.
          //
          // The authentication message is to be sent as follows:
          //   {'method': 'auth', 'params': ['myuser', 'mypass'], id: 0}
          if (requireAuth) {
            if (decoded.method !== 'auth') {
              // Try to notify client about failure to authenticate
              if (Endpoint.hasId(decoded)) {
                conn.sendReply('Error: Unauthorized', null, decoded.id);
              }
            } else {
              // Handle 'auth' message
              if (_.isArray(decoded.params) &&
                decoded.params.length === 2 &&
                self.authHandler(decoded.params[0], decoded.params[1])) {
                // Authorization completed
                requireAuth = false;

                // Notify client about success
                if (Endpoint.hasId(decoded)) {
                  conn.sendReply(null, true, decoded.id);
                }
              } else {
                if (Endpoint.hasId(decoded)) {
                  conn.sendReply('Error: Invalid credentials', null, decoded.id);
                }
              }
            }
            // Make sure we explicitly return here - the client was not yet auth'd.
            return;
          } else {
            conn.handleMessage(decoded);
          }
        };

        socket.on('data', function (chunk){
          try {
            parser.write(chunk);
          } catch (err) {
            // TODO: Is ignoring invalid data the right thing to do?
          }
        });
      },

      handleWebsocket: function (request, socket, body){
        var self = this, conn, parser;

        socket = new WebSocket(request, socket, body);

        Endpoint.trace('<--', 'Accepted Websocket connection');

        conn = classes.WebSocketConnection.create(self, socket);
        parser = new JsonParser();

        parser.onValue = function (decoded){
          if (this.stack.length) {
            return;
          }

          conn.handleMessage(decoded);
        };

        socket.on('message', function (event){
          try {
            parser.write(event.data);
          } catch (err) {
            // TODO: Is ignoring invalid data the right thing to do?
          }
        });
      },

      handleHybrid: function (httpServer, socket){
        var self = this;

        socket.once('data', function (chunk){
          // If first byte is a capital letter, treat connection as HTTP
          if (chunk[0] >= 65 && chunk[0] <= 90) {
            // TODO: need to find a better way to do this
            http._connectionListener.call(httpServer, socket);
            socket.ondata(chunk, 0, chunk.length);
          } else {
            self.handleRaw(socket);
            // Re-emit first chunk
            socket.emit('data', chunk);
          }
        });
      },

      /**
       * Set the server to require authentication.
       *
       * Can be called with a custom handler function:
       *   server.enableAuth(function (user, password) {
       *     return true; // Do authentication and return result as boolean
       *   });
       *
       * Or just with a single valid username and password:
       *   sever.enableAuth(''myuser'', ''supersecretpassword'');
       */
      enableAuth: function (handler, password){
        if (!_.isFunction(handler)) {
          var user = '' + handler;
          password = '' + password;

          handler = function checkAuth(suppliedUser, suppliedPassword){
            return user === suppliedUser && password === suppliedPassword;
          };
        }

        this.authHandler = handler;
      }
    }, {
      /**
       * Handle a low level server error.
       */
      handleHttpError: function (req, res, code, message){
        var headers = {'Content-Type': 'text/plain',
          'Content-Length'           : message.length,
          'Allow'                    : 'POST'};

        if (code === 401) {
          headers['WWW-Authenticate'] = 'Basic realm=' + 'JSON-RPC' + '';
        }

        if (res.writeHead) {
          res.writeHead(code, headers);
          res.write(message);
        } else {
          headers['Content-Length'] += 3;
          res.write(headers + '\n\n' + message + '\n');
        }
        res.end();
      }
    });

  return Server;
};