'use strict';

/*
 * Created with @iobroker/create-adapter v2.2.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const core = require('@iobroker/adapter-core');
const NedbPersistence = require('aedes-persistence-nedb');
const Aedes = require('aedes');
const net = require('net');
const mqtt = require('mqtt');
const checkConfig = require('./lib/check').checkConfig;
const adapterInfo = require('./lib/messages').adapterInfo;
const zigbee2mqttInfo = require('./lib/messages').zigbee2mqttInfo;
const createDeviceDefinitions = require('./lib/deviceController').createDeviceDefinitions;
const createGroupDefinitions = require('./lib/deviceController').createGroupDefinitions;
const createOrUpdateDevices = require('./lib/deviceController').createOrUpdateDevices;
const processDeviceMessage = require('./lib/stateController').processDeviceMessage;
const createZ2MMessage = require('./lib/z2mMessages').createZ2MMessage;
const proxyZ2MLogs = require('./lib/z2mMessages').proxyZ2MLogs;


let mqttClient;
let createDevicesReady = false;
let isConnected = false;
const incStatsQueue = [];
const createCache = {};
// eslint-disable-next-line prefer-const
let deviceCache = [];
// eslint-disable-next-line prefer-const
let groupCache = [];
let ping;
let pingTimeout;
let autoRestartTimeout;
let debugLogEnabled;
let proxyZ2MLogsEnabled;
let checkAvailableTimout;
let debugDevices = '';
let logfilter = [];
let useKelvin = false;
let showInfo = true;


class Zigbee2mqtt extends core.Adapter {

	constructor(options) {
		super({
			...options,
			name: 'zigbee2mqtt',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	async onReady() {
		const mqttDataDir = `${core.getAbsoluteInstanceDataDir(this)}/mqttData`;
		const db = new NedbPersistence({
			path: mqttDataDir,
			prefix: ''
		});
		// @ts-ignore
		const aedes = Aedes({ persistence: db });
		const mqttServer = net.createServer(aedes.handle);
		const port = 1883;

		// Initialize your adapter here
		adapterInfo(this.config, this.log);
		this.setStateAsync('info.connection', false, true);
		//this.createWsClient(this.config.server, this.config.port);

		debugLogEnabled = this.config.debugLogEnabled;
		proxyZ2MLogsEnabled = this.config.proxyZ2MLogs;
		useKelvin = this.config.useKelvin;

		const debugDevicesState = await this.getStateAsync('info.debugmessages');
		if (debugDevicesState && debugDevicesState.val) {
			debugDevices = String(debugDevicesState.val);
		}

		const logfilterState = await this.getStateAsync('info.logfilter');
		if (logfilterState && logfilterState.val) {
			logfilter = String(logfilterState.val).split(';').filter(x => x); // filter removes empty strings here
		}

		mqttServer.listen(port, () => { });

		mqttClient = mqtt.connect('mqtt://localhost:1883', { clientId: 'ioBroker.zigbee2mqtt', clean: true, reconnectPeriod: 500 });
		mqttClient.on('connect', () => { isConnected = true; });
		mqttClient.subscribe('#');
		mqttClient.on('message', (topic, payload) => {
			const newMessage = `{"payload":${payload.toString() == '' ? '"null"' : payload.toString()},"topic":"${topic.slice(topic.search('/') + 1)}"}`;
			//console.log(newMessage);
			this.messageParse(newMessage);
		});
	}


	async messageParse(message) {
		const messageObj = JSON.parse(message);

		switch (messageObj.topic) {
			case 'bridge/config':
				break;
			case 'bridge/info':
				if (showInfo) {
					zigbee2mqttInfo(messageObj.payload, this.log);
					checkConfig(messageObj.payload.config, this.log);
					showInfo = false;
				}
				break;
			case 'bridge/state':
				break;
			case 'bridge/devices':
				// As long as we are busy creating the devices, the states are written to the queue.
				createDevicesReady = false;
				await createDeviceDefinitions(deviceCache, messageObj.payload, useKelvin);
				await createOrUpdateDevices(this, groupCache.concat(deviceCache), createCache);
				await this.subscribeWritableStates();
				createDevicesReady = true;

				// Now process all entries in the states queue
				while (incStatsQueue.length > 0) {
					processDeviceMessage(this, incStatsQueue.shift(), groupCache.concat(deviceCache), debugDevices);
				}
				break;
			case 'bridge/groups':
				await createGroupDefinitions(groupCache, messageObj.payload, useKelvin);
				await createOrUpdateDevices(this, groupCache.concat(deviceCache), createCache);
				this.subscribeWritableStates();
				break;

			case 'bridge/event':
				break;
			case 'bridge/extensions':
				break;
			case 'bridge/logging':
				if (proxyZ2MLogsEnabled == true) {
					proxyZ2MLogs(this, messageObj, logfilter);
				}
				break;
			//{"payload":{"data":{"from":"dev_Device","homeassistant_rename":false,"to":"dev_Deviceiop"},"status":"ok","transaction":"x3y3u-1"},"topic":"bridge/response/device/rename"}
			case 'bridge/response/device/rename':
				createDevicesReady = false;
				// Rename device id
				groupCache.concat(deviceCache).find(x => x.id == messageObj.payload.data.from).id = messageObj.payload.data.to;
				// Update Devices in iob
				await createOrUpdateDevices(this, groupCache.concat(deviceCache), createCache);
				createDevicesReady = true;
				break;
			case 'bridge/response/networkmap':
				break;
			case 'bridge/response/touchlink/scan':
				break;
			case 'bridge/response/touchlink/identify':
				break;
			case 'bridge/response/touchlink/factory_reset':
				break;
			default:
				{
					// {"payload":{"state":"online"},"topic":"FL.Licht.Links/availability"}  ---->  {"payload":{"available":true},"topic":"FL.Licht.Links"}
					if (messageObj.topic.endsWith('/availability')) {
						const topicSplit = messageObj.topic.split('/');

						// If an availability message for an old device ID comes with a payload of NULL, this is the indicator that a device has been unnamed.
						// If this is then still available in the cache, the messages must first be cached.
						if (messageObj.payload == null) {
							if (groupCache.concat(deviceCache).find(x => x.id == topicSplit[0])) {
								createDevicesReady = false;
								break;
							}
						}

						if (topicSplit.length == 2 && messageObj.payload && messageObj.payload.state) {
							const newMessage = {
								payload: { available: messageObj.payload.state == 'online' },
								topic: topicSplit[0]
							};
							// As long as we are busy creating the devices, the states are written to the queue.
							if (createDevicesReady == false) {
								incStatsQueue[incStatsQueue.length] = newMessage;
								break;
							}
							processDeviceMessage(this, newMessage, groupCache.concat(deviceCache), debugDevices);
						}
						// States
					} else if (!messageObj.topic.includes('/')) {
						// As long as we are busy creating the devices, the states are written to the queue.
						if (createDevicesReady == false) {
							incStatsQueue[incStatsQueue.length] = messageObj;
							break;
						}
						processDeviceMessage(this, messageObj, groupCache.concat(deviceCache), debugDevices);
					}
				}
				break;
		}
	}

	async subscribeWritableStates() {
		await this.unsubscribeObjectsAsync('*');
		for (const device of groupCache.concat(deviceCache)) {
			for (const state of device.states) {
				if (state.write == true) {
					this.subscribeStatesAsync(`${device.ieee_address}.${state.id}`);
				}
			}
		}
		this.subscribeStatesAsync('info.debugmessages');
		this.subscribeStatesAsync('info.logfilter');
	}

	async logDebug(message) {
		if (debugLogEnabled == true) {
			this.log.debug(message);
		}
	}

	async setAllAvailableToFalse() {
		for (const device of deviceCache) {
			for (const state of device.states) {
				if (state.id == 'available') {
					await this.setStateAsync(`${device.ieee_address}.${state.id}`, false, true);
				}
			}
		}
	}

	async onUnload(callback) {
		try {
			await this.setAllAvailableToFalse();
			clearTimeout(ping);
			clearTimeout(pingTimeout);
			clearTimeout(autoRestartTimeout);
			clearTimeout(checkAvailableTimout);
			callback();
		} catch (e) {
			callback();
		}
	}

	async onStateChange(id, state) {
		if (state && state.ack == false) {
			if (id.includes('info.debugmessages')) {
				debugDevices = state.val;
				this.setState(id, state.val, true);
				return;
			}
			if (id.includes('info.logfilter')) {
				logfilter = state.val.split(';').filter(x => x); // filter removes empty strings here
				this.setState(id, state.val, true);
				return;
			}

			const message = await createZ2MMessage(this, id, state, groupCache.concat(deviceCache), isConnected) || { topic: '', payload: '' };
			mqttClient.publish('zigbee2mqtt/' + message.topic, JSON.stringify(message.payload));
		}
	}
}


if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<core.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Zigbee2mqtt(options);
} else {
	// otherwise start the instance directly
	new Zigbee2mqtt();
}
