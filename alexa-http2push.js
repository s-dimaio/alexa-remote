const http2 = require('http2');
const EventEmitter = require('events');

// Maximum number of consecutive reconnection attempts before giving up
const MAX_RETRY_ATTEMPTS = 100; // ~94 minuti (default)

class AlexaHttp2Push extends EventEmitter {

    constructor(options, update_access_token) {
        super();

        this._options = options;
        this.stop = false;
        this.client = null;
        this.stream = null;
        this.pingPongInterval = null;
        this.errorRetryCounter = 0;
        this.reconnectTimeout = null;
        this.pongTimeout = null;
        this.initTimeout = null;
        this.connectionActive = false;
        this.access_token = null;
        this.update_access_token = update_access_token;
        this.inClosing = false;
        this.lastPongTime = null;
    }

    isConnected() {
        return this.connectionActive;
    }

    connect() {
        this.inClosing = false;
        this.update_access_token(token => {
            this.access_token = token;

            let host = 'bob-dispatch-prod-eu.amazon.com';
            if (this._options.pushDispatchHost) {
                host = this._options.pushDispatchHost;
            } else if (this._options.amazonPage === 'amazon.com') {
                host = 'bob-dispatch-prod-na.amazon.com';
            } else if (this._options.amazonPage === 'amazon.ca') {
                host = 'bob-dispatch-prod-na.amazon.com';
            } else if (this._options.amazonPage === 'amazon.com.mx') {
                host = 'bob-dispatch-prod-na.amazon.com';
            } else if (this._options.amazonPage === 'amazon.com.br') {
                host = 'bob-dispatch-prod-na.amazon.com';
            } else if (this._options.amazonPage === 'amazon.co.jp') {
                host = 'bob-dispatch-prod-fe.amazon.com';
            } else if (this._options.amazonPage === 'amazon.com.au') {
                host = 'bob-dispatch-prod-fe.amazon.com';
            } else if (this._options.amazonPage === 'amazon.com.in') {
                host = 'bob-dispatch-prod-fe.amazon.com';
            } else if (this._options.amazonPage === 'amazon.co.nz') {
                host = 'bob-dispatch-prod-fe.amazon.com';
            }
            this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Use host ${host}`);


            const http2Options = {
                ':method': 'GET',
                ':path': '/v20160207/directives',
                ':authority': host,
                ':scheme': 'https',
                'authorization': `Bearer ${this.access_token}`,
                'accept-encoding': 'gzip',
                'user-agent': 'okhttp/4.3.2-SNAPSHOT',
            };

            const onHttp2Close = (code, reason, immediateReconnect) => {
                // Double-check protection against multiple calls
                if (this.inClosing) {
                    this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: onHttp2Close already in progress, skipping');
                    return;
                }
                this.inClosing = true;
                
                // Mark as disconnected immediately
                this.connectionActive = false;
                
                if (reason) {
                    reason = reason.toString();
                }
                try {
                    this.stream && this.stream.destroy();
                } catch (err) {
                    // ignore
                }
                try {
                    this.client && this.client.destroy();
                } catch (err) {
                    // ignore
                }
                this.client = null;
                this.stream = null;
                this.connectionActive = false;
                this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Close: ${code}: ${reason}`);
                if (this.initTimeout) {
                    clearTimeout(this.initTimeout);
                    this.initTimeout = null;
                }
                if (this.pingPongInterval) {
                    clearInterval(this.pingPongInterval);
                    this.pingPongInterval = null;
                }
                if (this.pongTimeout) {
                    clearTimeout(this.pongTimeout);
                    this.pongTimeout = null;
                }
                if (this.stop) {
                    return;
                }
                if (this.errorRetryCounter > MAX_RETRY_ATTEMPTS) {
                    this.emit('disconnect', false, 'Too many failed retries. Check cookie and data');
                    return;
                }

                this.errorRetryCounter++;

                const retryDelay = (immediateReconnect || this.errorRetryCounter === 1) ? 1 : Math.min(60, this.errorRetryCounter * 5);
                this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Retry Connection in ${retryDelay}s`);
                if (code !== undefined || reason !== undefined) {
                    this.emit('disconnect', true, `Retry Connection in ${retryDelay}s (${code}: ${reason})`);
                } else {
                    this.emit('disconnect', true, `Retry Connection in ${retryDelay}s`);
                }
                this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = setTimeout(() => {
                    this.reconnectTimeout = null;
                    this.connect();
                }, retryDelay * 1000);
            };

            const onPingResponse = (resetErrorCount) => {
                // Update lastPongTime FIRST (before any other operation)
                this.lastPongTime = Date.now();
                
                if (this.pongTimeout) {
                    clearTimeout(this.pongTimeout);
                    this.pongTimeout = null;
                }
                
                if (this.initTimeout) {
                    clearTimeout(this.initTimeout);
                    this.initTimeout = null;
                    this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Initialization completed');
                    this.emit('connect');
                }
                
                this.connectionActive = true;
                
                if (resetErrorCount) {
                    this.errorRetryCounter = 0;
                }
            };

            try {
                this.client = http2.connect(`https://${http2Options[':authority']}`,  () => {
                    if (!this.client) {
                        return;
                    }
                    try {
                        this.stream = this.client.request(http2Options);
                    } catch (error) {
                        this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Error on Request ${error.message}`);
                        this.emit('error', error);
                        return;
                    }

                    this.stream.on('response', async (headers) => {
                        if (headers[':status'] === 403) {
                            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Error 403 .... refresh token');
                            this.update_access_token(token => {
                                if (token) {
                                    this.access_token = token;
                                }
                                onHttp2Close(headers[':status'], undefined, this.errorRetryCounter < 3);
                            });
                        } else if (headers[':status'] !== 200) {
                            onHttp2Close(headers[':status']);
                        }
                    });

                    this.stream.on('data', (chunk) => {
                        if (this.stop) {
                            this.stream && this.stream.end();
                            this.client && this.client.close();
                            return;
                        }
                        chunk = chunk.toString();
                        if (chunk.startsWith('------')) {
                            this.client.ping(() => onPingResponse(false));

                            this.pingPongInterval = setInterval(() => {
                                if (!this.stream || !this.client) {
                                    return;
                                }
                                this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Send Ping');
                                // console.log('SEND: ' + msg.toString('hex'));
                                try {
                                    this.client.ping(() => onPingResponse(true));
                                } catch (error) {
                                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Error on Ping ${error.message}`);
                                    // If ping throws exception, force close connection
                                    this.forceClose('Ping exception');
                                    return;
                                }

                                this.pongTimeout = setTimeout(() => {
                                    this.pongTimeout = null;
                                    this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: No Pong received after 30s');
                                    
                                    // Double-check if pong arrived late (race condition protection)
                                    if (this.lastPongTime) {
                                        const timeSincePong = Date.now() - this.lastPongTime;
                                        if (timeSincePong < 35000) { // 35s margin
                                            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Pong received late, false alarm');
                                            return;
                                        }
                                    }
                                    
                                    // Force close connection
                                    this.forceClose('No pong after 30s');
                                }, 30000);
                            }, 180000);

                            return;
                        }
                        if (chunk.startsWith('Content-Type: application/json')) {
                            const json_start = chunk.indexOf('{');
                            const json_end = chunk.lastIndexOf('}');
                            if (json_start === -1 || json_end === -1) {
                                this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Unexpected ResponseCould not find json in chunk: ${chunk}`);
                                return;
                            }
                            const message = chunk.substring(json_start, json_end + 1);
                            try {
                                const data = JSON.parse(message);
                                if (!data || !data.directive || !data.directive.payload || !Array.isArray(data.directive.payload.renderingUpdates)) {
                                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Unexpected ResponseCould not find renderingUpdates in json: ${message}`);
                                    return;
                                }
                                data.directive.payload.renderingUpdates.forEach(update => {
                                    if (!update || !update.resourceMetadata) {
                                        this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Unexpected ResponseCould not find resourceMetadata in renderingUpdates: ${message}`);
                                    }
                                    const dataContent = JSON.parse(update.resourceMetadata);

                                    const command = dataContent.command;
                                    const payload = JSON.parse(dataContent.payload);

                                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Command ${command}: ${JSON.stringify(payload, null, 4)}`);
                                    this.emit('command', command, payload);
                                });
                            } catch (err) {
                                this.emit('unexpected-response', `Could not parse json: ${message}: ${err.message}`);
                            }
                        }
                    });

                    this.stream.on('close', onHttp2Close);

                    this.stream.on('error', (error) => {
                        this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Stream-Error: ${error}`);
                        this.emit('error', error);
                        this.stream && this.stream.end();
                        this.client && this.client.close();
                    });
                });

                this.client.on('close', onHttp2Close);

                this.client.on('error', (error) => {
                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Client-Error: ${error}`);
                    this.emit('error', error);
                    this.stream && this.stream.end();
                    this.client && this.client.close();
                });
            }
            catch (err) {
                this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Error on Init ${err.message}`);
                this._options.logger && this._options.logger(err.stack);
                this.emit('error', err);
                return;
            }
            this.initTimeout && clearTimeout(this.initTimeout);

            this.initTimeout = setTimeout(() => {
                this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Initialization not done within 30s');
                try {
                    this.stream && this.stream.end();
                    this.client && this.client.close();
                } catch (err) {
                    // just make sure
                }
                if (this.stream || !this.reconnectTimeout) { // it seems no close was emitted so far?!
                    onHttp2Close();
                }
            }, 30000);
        });
    }

    /**
     * Real verification of HTTP/2 Push connection status
     * Checks all internal states to ensure the connection is actually active
     * @returns {boolean} true only if HTTP/2 connection is really active and working
     */
    isConnectedV2() {
        // Check connectionActive flag
        if (!this.connectionActive) {
            return false;
        }

        // Check HTTP/2 client existence and state
        if (!this.client || this.client.destroyed || this.client.closed) {
            return false;
        }

        // Check stream existence and state
        if (!this.stream || this.stream.destroyed || this.stream.closed) {
            return false;
        }

        // Check if not in reconnection phase
        if (this.reconnectTimeout) {
            return false;
        }

        // Check if not still initializing
        if (this.initTimeout) {
            return false;
        }

        // Check if not closing
        if (this.inClosing) {
            return false;
        }

        // Check time since last pong (passive timeout detection)
        if (this.lastPongTime) {
            const timeSinceLastPong = Date.now() - this.lastPongTime;
            // If more than 5 minutes without pong, consider disconnected
            if (timeSinceLastPong > 5 * 60 * 1000) {
                this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Last pong >5min ago, marking as disconnected');
                this.connectionActive = false;
                return false;
            }
        }

        return true;
    }

    /**
     * Performs an active HTTP/2 ping to verify the connection is really working
     * This method sends an HTTP/2 ping frame and waits for the pong response
     * @param {Function} callback - Callback function (err, duration, isAlive)
     *                              - err: Error object if ping fails
     *                              - duration: Round-trip time in milliseconds
     *                              - isAlive: boolean indicating if connection is alive
     */
    ping(callback) {
        // Check client existence
        if (!this.client) {
            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Ping failed - client not initialized');
            callback && callback(new Error('Client not initialized'), null, false);
            return;
        }

        // Check client state
        if (this.client.destroyed) {
            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Ping failed - client destroyed');
            this.connectionActive = false;
            callback && callback(new Error('Client destroyed'), null, false);
            return;
        }

        if (this.client.closed) {
            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Ping failed - client closed');
            this.connectionActive = false;
            callback && callback(new Error('Client closed'), null, false);
            return;
        }

        // Check stream existence
        if (!this.stream) {
            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Ping failed - stream not initialized');
            callback && callback(new Error('Stream not initialized'), null, false);
            return;
        }

        // Check stream state
        if (this.stream.destroyed) {
            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Ping failed - stream destroyed');
            this.connectionActive = false;
            callback && callback(new Error('Stream destroyed'), null, false);
            return;
        }

        if (this.stream.closed) {
            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Ping failed - stream closed');
            this.connectionActive = false;
            callback && callback(new Error('Stream closed'), null, false);
            return;
        }

        // 5 second timeout for ping
        const timeout = setTimeout(() => {
            this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: Ping timeout (5s)');
            this.connectionActive = false;
            callback && callback(new Error('Ping timeout after 5 seconds'), null, false);
        }, 5000);

        try {
            // Execute HTTP/2 ping
            this.client.ping((err, duration) => {
                clearTimeout(timeout);

                if (err) {
                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Ping error: ${err.message}`);
                    this.connectionActive = false;
                    callback && callback(err, null, false);
                } else {
                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Ping successful (${duration}ms)`);
                    this.lastPongTime = Date.now();
                    this.connectionActive = true;
                    callback && callback(null, duration, true);
                }
            });
        } catch (error) {
            clearTimeout(timeout);
            this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Ping exception: ${error.message}`);
            this.connectionActive = false;
            callback && callback(error, null, false);
        }
    }

    /**
     * Force close the HTTP/2 connection with automatic fallback
     * Ensures onHttp2Close is called even if events don't fire
     * @param {string} reason - Reason for closing
     */
    forceClose(reason) {
        this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Force closing - ${reason}`);
        this.connectionActive = false;
        
        // Try to close gracefully
        try {
            if (this.stream) this.stream.end();
        } catch (e) {
            this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Error ending stream: ${e.message}`);
        }
        
        try {
            if (this.client) this.client.close();
        } catch (e) {
            this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Error closing client: ${e.message}`);
        }
        
        // Fallback: if onHttp2Close is not triggered within 5s, call it manually
        // This handles cases where events don't fire properly
        const fallbackTimeout = setTimeout(() => {
            if (!this.inClosing) {
                this._options.logger && this._options.logger('Alexa-Remote HTTP2-PUSH: onHttp2Close not triggered, calling manually');
                // We need to trigger reconnection manually
                // Since we're inside the connect() closure, we can't call onHttp2Close directly
                // Instead, emit disconnect and schedule reconnection
                this.emit('disconnect', true, reason);
                
                if (!this.stop && this.errorRetryCounter < MAX_RETRY_ATTEMPTS) {
                    this.errorRetryCounter++;
                    const retryDelay = Math.min(60, this.errorRetryCounter * 5);
                    this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Scheduling reconnection in ${retryDelay}s`);
                    this.reconnectTimeout = setTimeout(() => {
                        this.reconnectTimeout = null;
                        this.inClosing = false;
                        this.connect();
                    }, retryDelay * 1000);
                }
            }
        }, 5000);
        
        // Clear fallback if connection closes normally
        const originalInClosing = this.inClosing;
        const checkInterval = setInterval(() => {
            if (this.inClosing && !originalInClosing) {
                clearTimeout(fallbackTimeout);
                clearInterval(checkInterval);
            }
        }, 100);
        
        // Clean up check interval after 6s
        setTimeout(() => clearInterval(checkInterval), 6000);
    }

    disconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.pollingTimeout) {
            clearTimeout(this.pollingTimeout);
            this.pollingTimeout = null;
        }
        if (this.initTimeout) {
            clearTimeout(this.initTimeout);
            this.initTimeout = null;
        }
        this.stop = true;
        if (!this.client && !this.stream) {
            return;
        }
        try {
            this.stream && this.stream.end();
            this.client && this.client.close();
        } catch (e) {
            this.connectionActive && this._options.logger && this._options.logger(`Alexa-Remote HTTP2-PUSH: Disconnect error: ${e.message}`);
        }
    }
}

module.exports = AlexaHttp2Push;
