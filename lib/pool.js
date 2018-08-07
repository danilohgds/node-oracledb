/* Copyright (c) 2016, Oracle and/or its affiliates. All rights reserved. */

/******************************************************************************
 *
 * You may not use the identified files except in compliance with the Apache
 * License, Version 2.0 (the "License.")
 *
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0.
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 *****************************************************************************/

'use strict';

var connection = require('./connection.js');
var nodbUtil = require('./util.js');
var getConnectionPromisified;
var closePromisified;

// completeConnectionRequest does the actual work of getting a connection from
// a pool. It's abstracted out so it can be called from getConnection and
// checkRequestQueue consistently.
function completeConnectionRequest(config, getConnectionCb) {
  var self = this;

  // Incrementing _connectionsOut prior to making the async call to get a connection
  // to prevent other connection requests from exceeding the poolMax.
  self._connectionsOut += 1;

  self._getConnection(config, function(err, connInst) {
    if (err) {
      // Decrementing _connectionsOut if we didn't actually get a connection
      // and then rechecking the queue.
      self._connectionsOut -= 1;

      if (self._enableStats) {
        self._totalFailedRequests += 1;
      }

      process.nextTick(function() {
        checkRequestQueue.call(self);
      });

      getConnectionCb(err);

      return;
    }

    connection.extend(connInst, self._oracledb, self);

    connInst.on('_after_close', function() {
      self._connectionsOut -= 1;

      checkRequestQueue.call(self);
    });

    getConnectionCb(null, connInst);
  });
}

// Requests for connections from pools are queued. checkRequestQueue determines
// when requests for connections should be completed and cancels any timeout
// that may have been associated with the request.
function checkRequestQueue() {
  var self = this;
  var payload;
  var waitTime;

  if (self._connRequestQueue.length === 0 || self._connectionsOut === self.poolMax) {
    return; // no need to do any work
  }

  payload = self._connRequestQueue.shift();

  if (self._enableStats) {
    self._totalRequestsDequeued += 1;

    waitTime = Date.now() - payload.enqueuedTime;

    self._totalTimeInQueue += waitTime;
    self._minTimeInQueue = Math.min(self._minTimeInQueue, waitTime);
    self._maxTimeInQueue = Math.max(self._maxTimeInQueue, waitTime);
  }

  if (self._usingQueueTimeout) {
    clearTimeout(payload.timeoutHandle);

    delete self._connRequestTimersMap[payload.timerIdx];
    payload.timeoutHandle = null;
    payload.timerIdx = null;
  }

  completeConnectionRequest.call(self, payload.config,
      payload.getConnectionCb);
}

// onRequestTimeout is used to prevent requests for connections from sitting in the
// queue for too long. The number of milliseconds can be set via queueTimeout
// property of the poolAttrs used when creating a pool.
function onRequestTimeout(timerIdx) {
  var self = this;
  var payloadToDequeue = self._connRequestTimersMap[timerIdx];
  var requestIndex;

  if (payloadToDequeue) {
    if (self._enableStats) {
      self._totalRequestTimeouts += 1;
      self._totalTimeInQueue += Date.now() - payloadToDequeue.enqueuedTime;
    }

    requestIndex = self._connRequestQueue.indexOf(payloadToDequeue);

    self._connRequestQueue.splice(requestIndex, 1);
    delete self._connRequestTimersMap[timerIdx];

    payloadToDequeue.getConnectionCb(new Error(nodbUtil.getErrorMessage('NJS-040')));
  }
}

// This function gets a connection from the pool. If there are fewer
// connections out than the poolMax setting, then the request will return
// immediately; otherwise, the request will be queued for up to queueTimeout
// milliseconds.
function getConnection(a1, a2) {
  var self = this;
  var payload;
  var timeoutHandle;
  var timerIdx;
  var poolMax;
  var getConnectionCb = arguments[arguments.length - 1];
  var options = {};

  nodbUtil.assert(arguments.length >= 1 && arguments.length <= 2, 'NJS-009');
  nodbUtil.assert(typeof getConnectionCb === 'function', 'NJS-006', arguments.length);
  nodbUtil.assert(self.closing === false, 'NJS-064', self.poolAlias);

  // Optional JSON parameter
  if (arguments.length > 1 ) {
    options = arguments[0];
    nodbUtil.assert(nodbUtil.isObject(options), 'NJS-006', 1 );
  }

  if (self._enableStats) {
    self._totalConnectionRequests += 1;
  }

  // getting the poolMax setting on the pool may fail if the pool is no longer
  // valid
  try {
    poolMax = self.poolMax;
  } catch (err) {
    getConnectionCb(err);
    if (self._enableStats) {
      self._totalFailedRequests += 1;
    }
    return;
  }

  if (self._connectionsOut < poolMax) {
    completeConnectionRequest.call(self, options, getConnectionCb);
  } else { // need to queue the request
    if (self._usingQueueTimeout) {
      self._connRequestTimersIdx += 1;
      timerIdx = self._connRequestTimersIdx;

      timeoutHandle = setTimeout(
        function() {
          onRequestTimeout.call(self, timerIdx);
        },
        self.queueTimeout
      );
    }

    payload = {
      timerIdx: timerIdx,
      timeoutHandle: timeoutHandle,
      getConnectionCb: getConnectionCb,
      config : options
    };

    if (self._usingQueueTimeout) {
      self._connRequestTimersMap[timerIdx] = payload;
    }

    self._connRequestQueue.push(payload);

    if (self._enableStats) {
      payload.enqueuedTime = Date.now();
      self._totalRequestsEnqueued += 1;
      self._maxQueueLength = Math.max(self._maxQueueLength, self._connRequestQueue.length);
    }
  }
}

getConnectionPromisified = nodbUtil.promisify(getConnection);

function closeWrapper(mode, closeCb) {
  var self = this;

  console.log(mode);
  
  self._close({forceClose:mode}, function (err) {
  if (!err) {
      self._isValid = false;

      self.emit('_after_close', self);
    }
    closeCb(err);
  });
}

function close(a1, a2) {
  var self = this;

  nodbUtil.assert(arguments.length === 1 || arguments.length === 2, 'NJS-009');

  const closeCb = arguments[arguments.length - 1];
  nodbUtil.assert(typeof closeCb === 'function', 'NJS-006', 1);

  const forceClose = arguments.length === 1 ? false : true;
  self.closing = forceClose;

  if (arguments.length === 1) {
    self.closeWrapper(false, closeCb);
  } else {
    //If a drainTime has been provided, it will use that value, given that connections count is not 0
    //if connectionsOut is === 0, closePool is called right away, as there is no need to wait at all.
    const drainTime = self._connectionsOut === 0 ? 0 : arguments[arguments.length - 2] * 1000;
    //SetTimeout does not accept numbers greather than a 32bit signed integer.
    const upperLimitTimeout = 2147483647;

    nodbUtil.assert(typeof drainTime === 'number', 'NJS-006', 2);
    nodbUtil.assert(drainTime >= 1 && drainTime <= upperLimitTimeout, 'NJS-005', 2);

    if (drainTime === 0) {
      self.closeWrapper(true, closeCb);
    } else {
      setTimeout(() => {
        self.closeWrapper(true, closeCb);
      }, drainTime);
    }
  }
}

closePromisified = nodbUtil.promisify(close);

// logStats is used to add a hidden method (_logStats) to each pool instance. This
// provides an easy way to log out the statistics related information that's collected
// when _enableStats is set to true when creating a pool. This functionality may
// be altered or enhanced in the future.
function logStats() {
  var self = this;
  var averageTimeInQueue;

  if (!self._isValid) {
    throw new Error(nodbUtil.getErrorMessage('NJS-002'));
  }

  if (self._enableStats !== true) {
    console.log('Pool statistics not enabled');
    return;
  }

  averageTimeInQueue = 0;

  if (self._totalRequestsEnqueued !== 0) {
    averageTimeInQueue = Math.round(self._totalTimeInQueue/self._totalRequestsEnqueued);
  }

  console.log('\nPool statistics:');
  console.log('...total up time (milliseconds):', Date.now() - self._createdDate);
  console.log('...total connection requests:', self._totalConnectionRequests);
  console.log('...total requests enqueued:', self._totalRequestsEnqueued);
  console.log('...total requests dequeued:', self._totalRequestsDequeued);
  console.log('...total requests failed:', self._totalFailedRequests);
  console.log('...total request timeouts:', self._totalRequestTimeouts);
  console.log('...max queue length:', self._maxQueueLength);
  console.log('...sum of time in queue (milliseconds):', self._totalTimeInQueue);
  console.log('...min time in queue (milliseconds):', self._minTimeInQueue);
  console.log('...max time in queue (milliseconds):', self._maxTimeInQueue);
  console.log('...avg time in queue (milliseconds):', averageTimeInQueue);
  console.log('...pool connections in use:', self.connectionsInUse);
  console.log('...pool connections open:', self.connectionsOpen);
  console.log('Related pool attributes:');
  console.log('...poolAlias:', self.poolAlias);
  console.log('...queueTimeout (milliseconds):', self.queueTimeout);
  console.log('...poolMin:', self.poolMin);
  console.log('...poolMax:', self.poolMax);
  console.log('...poolIncrement:', self.poolIncrement);
  console.log('...poolTimeout (seconds):', self.poolTimeout);
  console.log('...poolPingInterval:', self.poolPingInterval);
  console.log('...stmtCacheSize:', self.stmtCacheSize);
  console.log('Related environment variables:');
  console.log('...process.env.UV_THREADPOOL_SIZE:', process.env.UV_THREADPOOL_SIZE);
}

// The extend method is used to extend Pool instances from the C layer with custom
// properties, methods, and method overrides. References to the original methods are
// maintained so they can be invoked by the overriding method at the right time.
function extend(pool, poolAttrs, poolAlias, oracledb) {
  var queueTimeout;

  if (typeof poolAttrs.queueTimeout !== 'undefined') {
    queueTimeout = poolAttrs.queueTimeout;
  } else {
    queueTimeout = oracledb.queueTimeout;
  }

  nodbUtil.makeEventEmitter(pool);

  // Using Object.defineProperties to add properties to the Pool instance with special
  // properties, such as enumerable but not writable.
  Object.defineProperties(
    pool,
    {
      _oracledb: { // storing a reference to the base instance to avoid circular references with require
        value: oracledb
      },
      queueTimeout: { // milliseconds a connection request can spend in queue before being failed
        enumerable: true,
        get: function() {
          return queueTimeout;
        },
        set: function() {
          throw new Error(nodbUtil.getErrorMessage('NJS-014', 'queueTimeout'));
        }
      },
      _isValid: { // used to ensure operations are not done after close
        value: true,
        writable: true
      },
      _enableStats: { // true means pool stats will be recorded
        value: poolAttrs._enableStats === true
      },
      _logStats: { // output pool stats
        value: logStats
      },
      _createdDate: {
        value: Date.now()
      },
      _totalConnectionRequests: { // total number of pool.getConnection requests
        value: 0,
        writable: true
      },
      _totalRequestsEnqueued: { // number of pool.getConnection requests added to queue
        value: 0,
        writable: true
      },
      _totalRequestsDequeued: { // number of pool.getConnection requests removed from queue because a pool connection became available
        value: 0,
        writable: true
      },
      _totalFailedRequests: { // number of pool.getConnection requests that failed at the C layer
        value: 0,
        writable: true
      },
      _totalRequestTimeouts: { // number of queued pool.getConnection requests that timed out without being satisfied
        value: 0,
        writable: true
      },
      _totalTimeInQueue: { // sum of time in milliseconds that all pool.getConnection requests spent in the queue
        value: 0,
        writable: true
      },
      _maxQueueLength: { // maximum length of pool queue
        value: 0,
        writable: true
      },
      _minTimeInQueue: { // shortest amount of time (milliseconds) that any pool.getConnection request spent in queue
        value: 0,
        writable: true
      },
      _maxTimeInQueue: { // longest amount of time (milliseconds) that any pool.getConnection request spent in queue
        value: 0,
        writable: true
      },
      _usingQueueTimeout: {
        value: queueTimeout !== 0
      },
      _connectionsOut: { // number of connections checked out from the pool. Must be inc/dec in the main thread in JS
        value: 0,
        writable: true
      },
      _connRequestQueue: {
        value: [],
        writable: true
      },
      _connRequestTimersIdx: {
        value: 0,
        writable: true
      },
      _connRequestTimersMap: {
        value: {},
        writable: true
      },
      _getConnection: {
        value: pool.getConnection
      },
      poolAlias: {
        enumerable: true,
        get: function() {
          return poolAlias;
        },
        set: function() {
          throw new Error(nodbUtil.getErrorMessage('NJS-014', 'poolAlias'));
        }
      },
      getConnection: {
        value: getConnectionPromisified,
        enumerable: true,
        writable: true
      },
      _close: {
        value: pool.close
      },
      close: {
        value: closePromisified,
        enumerable: true,
        writable: true
      },
      terminate: { // alias for close
        value: closePromisified,
        enumerable: true,
        writable: true
      },
      closing: {
        writable: true,
        enumerable: true,
        value: false
      },
      closeWrapper: {
        value: closeWrapper
      }
    }
  );
}

module.exports.extend = extend;
