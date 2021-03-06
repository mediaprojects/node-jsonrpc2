'use strict';

var
  util = require('util'),
  expect = require('expect.js'),
  rpc = require('../src/jsonrpc'),
  events = require('events'),
  server, MockRequest, MockResponse, testBadRequest, TestModule, echo;

module.exports = {
  beforeEach     : function (){
    server = rpc.Server.create();

    // MOCK REQUEST/RESPONSE OBJECTS
    MockRequest = function (method){
      this.method = method;
      events.EventEmitter.call(this);
    };

    echo = function (args, opts, callback){
      callback(null, args[0]);
    };
    server.expose('echo', echo);

    util.inherits(MockRequest, events.EventEmitter);

    MockResponse = function (){
      events.EventEmitter.call(this);
      this.writeHead = this.sendHeader = function (httpCode){
        this.httpCode = httpCode;
        this.httpHeaders = httpCode;
      };
      this.write = this.sendBody = function (httpBody){
        this.httpBody = httpBody;
      };
      this.end = this.finish = function (){};
      this.connection = new events.EventEmitter();
    };

    util.inherits(MockResponse, events.EventEmitter);

    // A SIMPLE MODULE
    TestModule = {
      foo: function (a, b){
        return ['foo', 'bar', a, b];
      },

      other: 'hello'
    };

    testBadRequest = function (testJSON, done){
      var req = new MockRequest('POST');
      var res = new MockResponse();
      server.handleHttp(req, res);
      req.emit('data', testJSON);
      req.emit('end');
      expect(res.httpCode).to.equal(400);
      done();
    };
  },
  afterEach: function(){
      server = null;
      MockRequest = null;
      MockResponse = null;
      testBadRequest = null;
      TestModule = null;
  },
  'json-rpc2': {
    'Server#expose': function (){
      expect(server.functions.echo).to.eql(echo);
    },

    'Server#exposeModule': function (){
      server.exposeModule('test', TestModule);
      expect(server.functions['test.foo']).to.eql(TestModule.foo);
    },

    'GET Server#handleNonPOST': function (){
      var req = new MockRequest('GET');
      var res = new MockResponse();
      server.handleHttp(req, res);
      expect(res.httpCode).to.equal(405);
    },

    'Missing object attribute (method)': function (done){
      var testJSON = '{ "params": ["Hello, World!"], "id": 1 }';
      testBadRequest(testJSON, done);
    },

    'Missing object attribute (params)': function (done){
      var testJSON = '{ "method": "echo", "id": 1 }';
      testBadRequest(testJSON, done);
    },

    'Missing object attribute (id)': function (done){
      var testJSON = '{ "method": "echo", "params": ["Hello, World!"] }';
      testBadRequest(testJSON, done);
    },

    'Unregistered method': function (){
      var testJSON = '{ "method": "notRegistered", "params": ["Hello, World!"], "id": 1 }';
      var req = new MockRequest('POST');
      var res = new MockResponse();
      try {
        server.handleHttp(req, res);
      } catch (e) {}
      req.emit('data', testJSON);
      req.emit('end');
      expect(res.httpCode).to.equal(200);
      var decoded = JSON.parse(res.httpBody);
      expect(decoded.id).to.equal(1);
      expect(decoded.error).to.equal('Error: Unknown RPC call "notRegistered"');
      expect(decoded.result).to.equal(null);
    },

    // VALID REQUEST

    'Simple synchronous echo': function (){
      var testJSON = '{ "method": "echo", "params": ["Hello, World!"], "id": 1 }';
      var req = new MockRequest('POST');
      var res = new MockResponse();
      server.handleHttp(req, res);
      req.emit('data', testJSON);
      req.emit('end');
      expect(res.httpCode).to.equal(200);
      var decoded = JSON.parse(res.httpBody);
      expect(decoded.id).to.equal(1);
      expect(decoded.error).to.equal(null);
      expect(decoded.result).to.equal('Hello, World!');
    },

    'Using promise': function (){
      // Expose a function that just returns a promise that we can control.
      var callbackRef = null;
      server.expose('promiseEcho', function (args, opts, callback){
        callbackRef = callback;
      });
      // Build a request to call that function
      var testJSON = '{ "method": "promiseEcho", "params": ["Hello, World!"], "id": 1 }';
      var req = new MockRequest('POST');
      var res = new MockResponse();
      // Have the server handle that request
      server.handleHttp(req, res);
      req.emit('data', testJSON);
      req.emit('end');
      // Now the request has completed, and in the above synchronous test, we
      // would be finished. However, this function is smarter and only completes
      // when the promise completes.  Therefore, we should not have a response
      // yet.
      expect(res.httpCode).to.not.be.ok();
      // We can force the promise to emit a success code, with a message.
      callbackRef(null, 'Hello, World!');
      // Aha, now that the promise has finished, our request has finished as well.
      expect(res.httpCode).to.equal(200);
      var decoded = JSON.parse(res.httpBody);
      expect(decoded.id).to.equal(1);
      expect(decoded.error).to.equal(null);
      expect(decoded.result).to.equal('Hello, World!');
    },

    'Triggering an errback': function (){
      var callbackRef = null;
      server.expose('errbackEcho', function (args, opts, callback){
        callbackRef = callback;
      });
      var testJSON = '{ "method": "errbackEcho", "params": ["Hello, World!"], "id": 1 }';
      var req = new MockRequest('POST');
      var res = new MockResponse();
      server.handleHttp(req, res);
      req.emit('data', testJSON);
      req.emit('end');
      expect(res.httpCode).to.not.be.ok();
      // This time, unlike the above test, we trigger an error and expect to see
      // it in the error attribute of the object returned.
      callbackRef('This is an error');
      expect(res.httpCode).to.equal(200);
      var decoded = JSON.parse(res.httpBody);
      expect(decoded.id).to.equal(1);
      expect(decoded.error).to.equal('This is an error');
      expect(decoded.result).to.equal(null);
    }
  }
};
