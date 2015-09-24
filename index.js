/**!
 * koa-redis - index.js
 * Copyright(c) 2015
 * MIT Licensed
 *
 * Authors:
 *   dead_horse <dead_horse@qq.com> (http://deadhorse.me)
 */

'use strict';

/**
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('koa-redis');
var Redis = require('redis');
var util = require('util');

var co = require('co');

/**
 * Initialize redis session middleware with `opts`:
 *
 * @param {Object} options
 *   - {Object} client    redis client
 *   - {String} host      redis connect host (with out options.client)
 *   - {Number} port      redis connect port (with out options.client)
 *   - {String} socket    redis connect socket (with out options.client)
 *   - {String} db        redis db
 *   - {String} pass      redis password
 */
var RedisStore = module.exports = function (options) {
  if (!(this instanceof RedisStore)) {
    return new RedisStore(options);
  }
  EventEmitter.call(this);
  options = options || {};

  var client;
  if (!options.client) {
    options.host = options.host || 'localhost';
    options.port = options.port || options.socket || 6379;
    debug('Init redis with host: %s, port: %d', options.host, options.port);
    client = Redis.createClient(options.port, options.host, options);
  } else {
    client = options.client;
  }

  options.pass && client.auth(options.pass, function (err) {
    if (err) {
      throw err;
    }
  });

  if (options.db) {
    client.select(options.db);
    client.on("connect", function() {
      client.send_anyways = true;
      client.select(options.db);
      client.send_anyways = false;
    });
  }
  client.on('error', this.emit.bind(this, 'disconnect'));
  client.on('end', this.emit.bind(this, 'disconnect'));
  client.on('connect', this.emit.bind(this, 'connect'));

  //wrap redis
  this._redisClient = client;
  this.client = require('co-redis')(client);
};

util.inherits(RedisStore, EventEmitter);

RedisStore.prototype.get = function *(sid) {
  var data = yield this.client.get(sid);
  debug('get session: %s', data || 'none');
  if (!data) {
    return null;
  }
  try {
    return JSON.parse(data.toString());
  } catch (err) {
    // ignore err
    debug('parse session error: %s', err.message);
  }
};

RedisStore.prototype.set = function *(sid, sess, ttl) {
  if (typeof ttl === 'number') {
    ttl = Math.ceil(ttl / 1000);
  }

  if (sess.passport && sess.passport.user) {
    this.client.sadd(this._getUidKey(sess.passport.user), sid);
  }

  sess = JSON.stringify(sess);
  if (ttl) {
    debug('SETEX %s %s %s', sid, ttl, sess);
    yield this.client.setex(sid, ttl, sess);
  } else {
    debug('SET %s %s', sid, sess);
    yield this.client.set(sid, sess);
  }
  debug('SET %s complete', sid);
};

RedisStore.prototype.destroy = function *(sid, sess) {
  debug('DEL %s', sid);
  yield this.client.del(sid);
  debug('DEL %s complete', sid);
};


RedisStore.prototype._getUidKey = function(uid) {
  return this.prefix + 'user_sessions:' + uid;
};

RedisStore.prototype._dropPrefix = function(sid) {
  return sid.replace(this.prefix, '');
};

RedisStore.prototype.allUserSessions = function* (uid) {
  var _this = this;
  var sessions = yield this.client.smembers(this._getUidKey(uid));

  var mc = sessions.map(function(sid) {
    return ['get', sid];
  });

  var resp = yield _this.client.multi(mc).exec();
  /**
   * If we retrieve null from Redis, it means this session was destroyed.
   * In that case remove it from the set to speed up future queries.
   */
  var parsed = [];
  for (var i in resp) {
    var data = resp[i];
    var added = JSON.parse(data);
    // if added is null, we deleted this session, if added.passport is 0, then we're logged out
    if (added === null || added.passport.user === undefined) {
      var deleteSid = sessions[i];
      _this.client.srem(_this._getUidKey(uid), deleteSid);
    } else {
      added.sid = _this._dropPrefix(sessions[i]);
      parsed.push(added);
    }
  }
  return parsed;

};
