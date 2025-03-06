"use strict";

const TuyaBaseDevice = require("../tuyabasedevice");
const DataUtil = require("../../util/datautil");

const CAPABILITIES_SET_DEBOUNCE = 1000;

class TuyaSocketDevice extends TuyaBaseDevice {
  onInit() {
    this.initDevice(this.getData().id);
    this.setDeviceConfig(this.get_deviceConfig());
    this.log(`Tuya socket ${this.getName()} has been initialized`);
  }

  setDeviceConfig(deviceConfig) {
    if (deviceConfig != null) {
      console.log("set socket device config: " + JSON.stringify(deviceConfig));
      // Update online/offline status if provided
      if (deviceConfig.online !== undefined) {
        this._updateOnlineState(deviceConfig.online);
      }
      let statusArr = deviceConfig.status ? deviceConfig.status : [];
      this.correctMeasurePowerCapability(statusArr);
      let capabilities = this.getCustomCapabilities(DataUtil.getSubService(statusArr));
      this.updateCapabilities(statusArr);
      this.registerMultipleCapabilityListener(
        capabilities,
        async (values, options) => {
          return this._onMultipleCapabilityListener(values, options);
        },
        CAPABILITIES_SET_DEBOUNCE
      );
    }
  }

  correctMeasurePowerCapability(statusArr) {
    for (let statusMap of statusArr) {
      if (statusMap.code === "cur_power") {
        if (!this.hasCapability("measure_power")) {
          this.homey.log("addCapability measure_power");
          this.addCapability("measure_power");
        }
      }
    }
  }

  getCustomCapabilities(subcodes) {
    let capabilities = [];
    for (let code of subcodes) {
      let name;
      if (subcodes.length === 1) {
        name = "onoff";
        this.multiswitch = false;
      } else {
        name = "onoff." + code;
        this.multiswitch = true;
      }
      capabilities.push(name);
    }
    return capabilities;
  }

  _onMultipleCapabilityListener(valueObj, optsObj) {
    this.log("Socket Capabilities changed by Homey: " + JSON.stringify(valueObj));
    try {
      for (let key of Object.keys(valueObj)) {
        let value = valueObj[key];
        this.sendCommand(key, value);
      }
    } catch (ex) {
      this.homey.error(ex);
    }
  }

  updateCapabilities(statusArr) {
    this.log("Update socket capabilities from Tuya: " + JSON.stringify(statusArr));
    if (!statusArr) return;

    // Process onoff capabilities (using subcodes)
    let subcodes = DataUtil.getSubService(statusArr);
    for (let subType of subcodes) {
      let status = statusArr.find((item) => item.code === subType);
      if (!status) continue;
      let name;
      let value = status.value;
      if (!this.multiswitch) {
        name = "onoff";
        this.switchValue = status;
      } else {
        name = "onoff." + subType;
      }
      this.log(`Set socket capability ${name} with value ${value}`);
      this.setCapabilityValue(name, value).catch(this.error);
      this.triggerSocketChanged(subType, value);
    }
    // Process additional capabilities:
    for (let statusMap of statusArr) {
      // measure_power: divide by 10 as before
      if (statusMap.code === "cur_power" && this.hasCapability("measure_power")) {
        this.setCapabilityValue("measure_power", Number(statusMap.value) / 10).catch(this.error);
      }
      // measure_voltage: divide by 10, at least for LSC Power Plug w/ Power Meter FR
      if (statusMap.code === "cur_voltage") {
        const newValue = Number(statusMap.value) / 10;
        if (!this.hasCapability("measure_voltage")) {
          this.addCapability("measure_voltage")
            .then(() => {
              this.log("Added capability measure_voltage");
              this.setCapabilityValue("measure_voltage", newValue).catch(this.error);
            })
            .catch((err) => {
              this.error("Failed to add measure_voltage:", err);
            });
        } else {
          this.setCapabilityValue("measure_voltage", newValue).catch(this.error);
        }
      }
      // measure_current: divide by 100, at least for LSC Power Plug w/ Power Meter FR
      if (statusMap.code === "cur_current") {
        const newValue = Number(statusMap.value) / 1000;
        if (!this.hasCapability("measure_current")) {
          this.addCapability("measure_current")
            .then(() => {
              this.log("Added capability measure_current");
              this.setCapabilityValue("measure_current", newValue).catch(this.error);
            })
            .catch((err) => {
              this.error("Failed to add measure_current:", err);
            });
        } else {
          this.setCapabilityValue("measure_current", newValue).catch(this.error);
        }
      }
    }
  }

  triggerSocketChanged(name, value) {
    let tokens = {};
    let state = {
      socketid: name,
      state: value ? "On" : "Off",
    };
    this.driver.triggerSocketChanged(this, tokens, state);
  }

  sendCommand(name, value) {
    let param = this.getSendParam(name, value);
    this.homey.app.tuyaOpenApi.sendCommand(this.id, param).catch((error) => {
      this.error("[SET][%s] capabilities Error: %s", this.id, error);
      throw new Error(`Error sending command: ${error}`);
    });
  }

  getSendParam(name, value) {
    let code;
    const isOn = value ? true : false;
    if (name.indexOf(".") === -1) {
      code = this.switchValue.code;
    } else {
      code = name.split(".")[1];
    }
    value = isOn;
    this.log("update Tuya socket code " + code + ": " + JSON.stringify(value));
    return {
      commands: [
        {
          code: code,
          value: value,
        },
      ],
    };
  }

  /**
   * Optimized online/offline update.
   * Checks the current value of "alarm_device_offline" (if present) and only updates when changed.
   * Also marks device as unavailable when offline.
   */
  _updateOnlineState(isOnline) {
    const isOffline = isOnline === false;
    if (this.hasCapability("alarm_device_offline")) {
      const current = this.getCapabilityValue("alarm_device_offline");
      if (current === isOffline) {
        return;
      }
      this.setCapabilityValue("alarm_device_offline", isOffline).catch(this.error);
    }
    this.log(`Socket isOffline: ${isOffline}`);
    if (isOffline) {
      this.setUnavailable("Device is offline").catch(this.error);
    } else {
      this.setAvailable().catch(this.error);
    }
  }

  /**
   * Called by app.js if the Tuya cloud reports 'offline'
   */
  markAsOffline() {
    this._updateOnlineState(false);
  }

  /**
   * Called by app.js if the Tuya cloud reports 'online'
   */
  markAsOnline() {
    this._updateOnlineState(true);
  }
}

module.exports = TuyaSocketDevice;
