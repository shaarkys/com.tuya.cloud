"use strict";

const TuyaBaseDevice = require("../tuyabasedevice");

class ParksideChargerDevice extends TuyaBaseDevice {
  async onInit() {
    this.log(`ParksideChargerDevice '${this.getName()}' initializing...`);

    // Initialize Tuya device with its ID
    this.initDevice(this.getData().id);

    // Fetch device config from the Cloud
    const deviceConfig = this.get_deviceConfig();
    this.setDeviceConfig(deviceConfig);

    // Register capability listener for "onoff" to control 'charge_switch'
    if (this.hasCapability("onoff")) {
      this.registerCapabilityListener("onoff", this._onCapabilityOnoff.bind(this));
    }

    // Register capability listener for "storage_button" to control 'storage_switch'
    if (this.hasCapability("storage_button")) {
      this.registerCapabilityListener("storage_button", this._storagebuttonCapability.bind(this));
    }

    this.log(`ParksideChargerDevice '${this.getName()}' has been initialized`);
  }

  /**
   * Called from onInit and whenever the device config is refreshed
   */
  setDeviceConfig(deviceConfig) {
    if (!deviceConfig) {
      this.log("No device config for ParksideCharger");
      return;
    }
    this.log("Set device config:", JSON.stringify(deviceConfig));

    // Mark device offline/online based on config (if provided)
    this._updateOnlineState(deviceConfig.online);

    // Update capabilities from status array
    const statusArr = deviceConfig.status || [];
    this.updateCapabilities(statusArr);
  }

  /**
   * Process incoming status codes from Tuya
   */
  updateCapabilities(statusArr) {
    this.log("Update ParksideCharger capabilities from Tuya:", statusArr);

    // Optionally, if you want every normal status update to assume online:
    this._updateOnlineState(true);

    for (const statusMap of statusArr) {
      const code = statusMap.code;
      const value = statusMap.value;
      if (!code) continue;

      switch (code) {
        case "charge_switch": {
          const isOn = !!value;
          this.log("onoff ->", isOn);
          this.setCapabilityValue("onoff", isOn).catch(this.error);
          break;
        }
        case "battery_percentage": {
          const batteryVal = Number(value) || 0;
          this.log("measure_battery ->", batteryVal);
          this.setCapabilityValue("measure_battery", batteryVal).catch(this.error);
          break;
        }
        case "charge_current": {
          const mA = Number(value) || 0;
          this.log("measure_charge_current ->", mA);
          this.setCapabilityValue("measure_charge_current", mA).catch(this.error);

          // Set battery_charging based on current (>0 mA)
          if (this.hasCapability("battery_charging")) {
            const isCharging = mA > 0;
            this.log("battery_charging ->", isCharging);
            this.setCapabilityValue("battery_charging", isCharging).catch(this.error);
          }
          break;
        }
        case "charge_voltage": {
          let rawMv = Number(value) || 0;
          let volts = rawMv / 1000;
          this.log("measure_charge_voltage ->", volts);
          this.setCapabilityValue("measure_charge_voltage", volts).catch(this.error);
          break;
        }
        case "temp_current": {
          const tempVal = Number(value) || 0;
          if (tempVal === 0) {
            this.log("measure_temperature -> update skipped because value reported is '0'");
            break;
          }
          this.log("measure_temperature ->", tempVal);
          this.setCapabilityValue("measure_temperature", tempVal).catch(this.error);
          break;
        }
        case "storage_switch": {
          this.log("storage_switch ->", value);
          if (this.hasCapability("storage_button")) {
            this.setCapabilityValue("storage_button", value).catch(this.error);
          }
          break;
        }
        case "upper_temp_switch": {
          this.log("upper_temp_switch ->", value);
          break;
        }
        case "maxtemp_times": {
          this.log("maxtemp_times ->", value);
          break;
        }
        default:
          this.log(`Unhandled code '${code}' ->`, value);
          break;
      }
    }
  }

  /**
   * Called when user toggles "onoff" in Homey.
   */
  async _onCapabilityOnoff(value) {
    this.log("Capability onoff ->", value);
    const param = {
      commands: [
        {
          code: "charge_switch",
          value: value,
        },
      ],
    };
    try {
      await this.homey.app.tuyaOpenApi.sendCommand(this.id, param);
      this.log("Sent charge_switch command to Tuya");
    } catch (err) {
      this.error("Error sending charge_switch ->", err);
      throw err;
    }
  }

  /**
   * Called when user toggles "storage_button" in Homey.
   */
  async _storagebuttonCapability(value) {
    this.log("Capability storage_button ->", value);
    const param = {
      commands: [
        {
          code: "storage_switch",
          value: value,
        },
      ],
    };
    try {
      await this.homey.app.tuyaOpenApi.sendCommand(this.id, param);
      this.log("Sent storage_switch command to Tuya");
    } catch (err) {
      this.error("Error sending storage_switch ->", err);
      throw err;
    }
  }

  /**
   * Updates the alarm_device_offline capability.
   * Additionally, if the device is offline, it sets the device as unavailable.
   */
  _updateOnlineState(isOnline) {
    const isOffline = (isOnline === false);
    if (this.hasCapability("alarm_device_offline")) {
      const current = this.getCapabilityValue("alarm_device_offline");
      if (current === isOffline) {
        // No state change – exit early.
        return;
      }
    }
    this.log(`ParksideCharger isOffline: ${isOffline}`);
    if (this.hasCapability("alarm_device_offline")) {
      this.setCapabilityValue("alarm_device_offline", isOffline).catch(this.error);
    }
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

module.exports = ParksideChargerDevice;
