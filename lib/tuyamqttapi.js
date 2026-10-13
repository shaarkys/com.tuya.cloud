const mqtt = require('mqtt');
const { v1: uuidv1 } = require('uuid');
const Crypto = require('crypto');
const CryptoJS = require('crypto-js');
const GCM_TAG_LENGTH = 16;
var debuglog;
class TuyaOpenMQ {

    constructor(api, type, log) {
        this.type = type;
        this.api = api;
        this.message_listeners = new Set();
        this.connection_listeners = new Set();
        this.client = null;
        debuglog = log;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this._loop_start().catch(error => {
            debuglog.error('TuyaOpenMQ loop stopped:', error.message);
            this.stop();
        });
    }

    stop() {
        this.running = false;
        clearTimeout(this.rotationTimer);
        clearTimeout(this.outageTimer);
        clearTimeout(this.retryTimer);
        if (this.retryResolve) this.retryResolve();
        if (this.rotate) this.rotate();
        if (this.client) {
            this.client.end();
            this.client = null;
        }
    }

    async _loop_start() {

        while (this.running) {

            let res;
            try {
                res = await this._getMQConfig('mqtt');
            } catch (err) {
                debuglog.error("TuyaOpenMQ access config error:", err.message);
            }

            if (res == null || res.success == false) {
                debuglog.log("TuyaOpenMQ access config failed, retrying in 60 seconds");
                await this._waitForRetry();
                continue;
            }

            if (!this.running) break;

            let mqConfig = res.result;
            if (!mqConfig || !mqConfig.source_topic || !mqConfig.source_topic.device) {
                debuglog.error('TuyaOpenMQ access config did not include a device topic');
                await this._waitForRetry();
                continue;
            }
            let {url, client_id, username, password, expire_time, source_topic } = mqConfig;
            const deviceTopic = source_topic.device;
            debuglog.log('TuyaOpenMQ connecting');
            let client;
            try {
                client = mqtt.connect(url, {
                    clientId: client_id,
                    username: username,
                    password: password,
                });
            } catch (error) {
                debuglog.error('TuyaOpenMQ connection setup failed:', error.message);
                await this._waitForRetry();
                continue;
            }

            client.on('connect', () => {
                if (this.client !== client || !this.running) return;
                clearTimeout(this.outageTimer);
                this.outageTimer = null;
                this._onConnect();
                client.subscribe(deviceTopic, (err) => {
                    if (this.client !== client || !this.running) return;
                    if (err) {
                        debuglog.error('TuyaOpenMQ subscribe failed:', err.message);
                        if (this.rotate) this.rotate();
                        return;
                    }
                    debuglog.log('TuyaOpenMQ subscribed');
                    this.connection_listeners.forEach(listener => Promise.resolve().then(listener).catch(error => {
                        debuglog.error('TuyaOpenMQ connection listener error:', error.message);
                    }));
                });
            });
            client.on('error', this._onError);
            client.on('end', this._onEnd);
            client.on('close', () => {
                this._onClose();
                this._scheduleOutageRecovery(client);
            });
            client.on('offline', () => {
                this._onOffline();
                this._scheduleOutageRecovery(client);
            });
            client.on('reconnect', this._onReconnect);
            client.on('message', (topic, payload) => {
                if (this.client === client && topic === deviceTopic) this._onMessage(client, mqConfig, topic, payload);
            });

            if (this.client) {
                this.client.end();
            }
            this.client = client;

            const renewAfter = Number.isFinite(Number(expire_time))
                ? Math.max(60, Number(expire_time) - 60) * 1000 : 60 * 60 * 1000;
            await new Promise(resolve => {
                this.rotate = resolve;
                this.rotationTimer = setTimeout(resolve, renewAfter);
            });
            this.rotate = null;
            clearTimeout(this.rotationTimer);
            clearTimeout(this.outageTimer);
            if (this.client === client) {
                this.client = null;
                client.end();
            }
        }

    }

    async _waitForRetry() {
        await new Promise(resolve => {
            this.retryResolve = resolve;
            this.retryTimer = setTimeout(resolve, 60 * 1000);
        });
        this.retryResolve = null;
        this.retryTimer = null;
    }

    _scheduleOutageRecovery(client) {
        if (this.client !== client || !this.running || this.outageTimer) return;
        this.outageTimer = setTimeout(() => {
            this.outageTimer = null;
            debuglog.log('TuyaOpenMQ connection unavailable for 60 seconds; refreshing access config');
            if (this.rotate) this.rotate();
        }, 60 * 1000);
    }

    async _getMQConfig(linkType) {
        let res = await this.api.post('/v1.0/iot-03/open-hub/access-config', {
            'uid': this.api.tokenInfo.uid,
            'link_id': uuidv1(),
            'link_type': linkType,
            'topics': 'device',
            'msg_encrypted_version': this.type,
        });
        return res;
    }

    _onConnect() {
        debuglog.log("TuyaOpenMQ connected");
    }

    _onError(err) {
        debuglog.error("TuyaOpenMQ error:", err.message);
    }

    _onEnd() {
        debuglog.log("TuyaOpenMQ end");
    }

    _onClose() {
        debuglog.log("TuyaOpenMQ close");
    }

    _onOffline() {
        debuglog.log("TuyaOpenMQ offline");
    }

    _onReconnect() {
        debuglog.log("TuyaOpenMQ reconnecting");
    }

    _onMessage(client, mqConfig, topic, payload) {
        try {
            let message = JSON.parse(payload.toString());
            message.data = JSON.parse(this.type == '2.0' ?
                this._decodeMQMessage(message.data, mqConfig.password, message.t)
                : this._decodeMQMessage_1_0(message.data, mqConfig.password));
            this.message_listeners.forEach(listener => {
                Promise.resolve().then(() => listener(message.data)).catch(err => {
                    debuglog.error("TuyaOpenMQ message listener error:", err.message);
                });
            });
        } catch (err) {
            debuglog.error('TuyaOpenMQ onMessage failed:', err.message);
        }
    }

    // 1.0
    _decodeMQMessage_1_0(b64msg, password) {
        password = password.substring(8, 24);
        let msg = CryptoJS.AES.decrypt(b64msg, CryptoJS.enc.Utf8.parse(password), {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7,
        }).toString(CryptoJS.enc.Utf8);
        return msg;
    }

    _decodeMQMessage(data, password, t) {
        // Base64 decoding generates Buffers
        var tmpbuffer = Buffer.from(data, 'base64');
        var key = password.substring(8, 24).toString('utf8');
        //get iv_length & iv_buffer
        var iv_length = tmpbuffer.readUIntBE(0,4);
        var iv_buffer = tmpbuffer.slice(4, iv_length + 4);
        //Removes the IV bits of the head and 16 bits of the tail tags
        var data_buffer = tmpbuffer.slice(iv_length + 4, tmpbuffer.length - GCM_TAG_LENGTH);
        var cipher = Crypto.createDecipheriv('aes-128-gcm', key, iv_buffer);
        //setAuthTag buffer
        cipher.setAuthTag(tmpbuffer.slice(tmpbuffer.length - GCM_TAG_LENGTH, tmpbuffer.length));
        //setAAD buffer
        const buf = Buffer.allocUnsafe(6);
        buf.writeUIntBE(t, 0, 6);
        cipher.setAAD(buf);
        
        var msg = Buffer.concat([cipher.update(data_buffer), cipher.final()]);
        return msg.toString('utf8');
    }

    addMessageListener(listener) {
        this.message_listeners.add(listener);
    }

    removeMessageListener(listener) {
        this.message_listeners.delete(listener);
    }

    addConnectionListener(listener) {
        this.connection_listeners.add(listener);
    }

}

module.exports = TuyaOpenMQ;
