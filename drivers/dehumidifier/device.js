'use strict';

const TuyaBaseDevice = require('../tuyabasedevice');
const DataUtil = require("../../util/datautil");

const CAPABILITIES_SET_DEBOUNCE = 1000;
// const tuyaToHomeyModeMap =  new Map([
//     ['low','low'],
//     ['middle','middle'],
//     ['high','high'],
//     ['auto','auto'],
//     ['off','off']
// ]);
// const homeyToTuyaModeMap = new Map([
//     ['low','low'],
//     ['middle','middle'],
//     ['high','high'],
//     ['auto','auto'],
//     ['off','off']
// ]);


class TuyaDehumidifierDevice extends TuyaBaseDevice {
    onInit() {
        // this.lastKnowHomeyThermostatMode = 'off'
        this.scale = this.getStoreValue('scale');
        if (this.scale == undefined){
            this.scale = 5;
        }
        this.initDevice(this.getData().id);
        this.updateCapabilities(this.get_deviceConfig().status);
        this.registerMultipleCapabilityListener(this.getCapabilities(), async (values, options) => {
            return this._onMultipleCapabilityListener(values, options); }, CAPABILITIES_SET_DEBOUNCE);
        this.log(`Tuya dehumidifier ${this.getName()} has been initialized`);
    }
    _onMultipleCapabilityListener(valueObj, optsObj) {
        this.log("Dehumidifier capabilities changed by Homey: " + JSON.stringify(valueObj));
        try {
            if (valueObj.target_humidity != null) {
                this.set_target_humidity(valueObj.target_humidity);
            }
            if (valueObj.onoff != null) {
                this.set_on_off(valueObj.onoff === true || valueObj.onoff === 1);
            }
            // if (valueObj.thermostat_heater_mode != null) {
            //     this.set_thermostat_mode(valueObj.thermostat_heater_mode);
            // }
        } catch (ex) {
            this.homey.app.logToHomey(ex);
        }
    }

    //init Or refresh AccessoryService
    updateCapabilities(statusArr) {
                this.log("Update dehumidifier capabilities from Tuya: " + JSON.stringify(statusArr));
        statusArr.forEach(status => {
            switch (status.code) {
                case 'switch':
                    this.normalAsync('onoff', status.value);
                    // if(status.value) {
                    //     this.normalAsync('thermostat_heater_mode', this.lastKnowHomeyThermostatMode);
                    // }else{
                    //     this.normalAsync('thermostat_heater_mode', 'off');
                    // }
                    break;
                case 'dehumidify_set_enum':
                    this.normalAsync('target_humidity', status.value);
                    break;
                //case 'humidity_indoor':
                //    this.normalAsync('measure_humidity', status.value/Math.pow(10,this.scale));
                //    break;
                // case 'mode':
                //     const homeyMode = tuyaToHomeyModeMap.get(status.value);
                //     if(homeyMode!=='off') {
                //         this.lastKnowHomeyThermostatMode = homeyMode
                //     }
                //     this.normalAsync('thermostat_heater_mode', homeyMode);
            }

        });
        }

    normalAsync(name, hbValue) {
        this.log("Set dehumidifier Capability " + name + " with " + hbValue);
        this.setCapabilityValue(name, hbValue)
            .catch(error => console.error(error));
    }

    sendCommand(code, value) {
        var param = {
            "commands": [
                {
                    "code": code,
                    "value": value
                }
            ]
        }
        this.homey.app.tuyaOpenApi.sendCommand(this.id, param).catch((error) => {
            this.error('[SET][%s] capabilities Error: %s', this.id, error);
            throw new Error(`Error sending command: ${error}`);
        });
    }

    set_on_off(onoff) {
        this.sendCommand("switch", onoff);
        // if(!onoff) {
        //     this.normalAsync('thermostat_heater_mode', 'off');
        // }else{
        //     this.normalAsync('thermostat_heater_mode', this.lastKnowHomeyThermostatMode);
        // }

    }

    // set_thermostat_mode(mode) {
    //     const tuyaMode = homeyToTuyaModeMap.get(mode);
    //     if(tuyaMode==='off') {
    //         this.sendCommand("switch", false);
    //         this.normalAsync('onoff', false);
    //     }
    //     else{
    //         this.lastKnowHomeyThermostatMode = mode;
    //         this.sendCommand("switch", true);
    //         this.sendCommand("mode", tuyaMode);
    //         this.normalAsync('onoff', true);
    //     }

    // }

    set_target_humidity(targetHumidity) {
        this.sendCommand("dehumidify_set_enum", targetHumidity);
    }
}

module.exports = TuyaDehumidifierDevice;
