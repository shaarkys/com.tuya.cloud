"use strict";

const TuyaBaseDevice = require("../tuyabasedevice");

class TuyaFeederDevice extends TuyaBaseDevice {
  async onInit() {
    this.log(`Tuya Feeder '${this.getName()}' initializing...`);

    // Initialize the Tuya device
    this.initDevice(this.getData().id);

    // Grab device config from the Cloud
    const deviceConfig = this.get_deviceConfig();
    this.setDeviceConfig(deviceConfig);

    // 1) Set a default portion of "1" for manual_feed_action (if capability is present)
    if (this.hasCapability("manual_feed_action")) {
      await this.setCapabilityValue("manual_feed_action", 1).catch(this.error);
    }

    // 2) Register a listener so numeric changes to "manual_feed_action" call _onManualFeedChanged
    this.registerMultipleCapabilityListener(
      ["manual_feed_action"],
      this._onManualFeedChanged.bind(this)
    );

    // Temporary fix for the feed_now button:
    if (!this.hasCapability("feed_now")) {
      await this.addCapability("feed_now").catch(this.error);
    }
    // 3) Register our new "feed_now" button so pressing it calls _onFeedNowButtonPressed
    if (this.hasCapability("feed_now")) {
      this.registerCapabilityListener("feed_now", this._onFeedNowButtonPressed.bind(this));
    }

    this.log(`Tuya Feeder '${this.getName()}' has been initialized`);
  }

  setDeviceConfig(deviceConfig) {
    if (!deviceConfig) {
      this.log("No device config for feeder");
      return;
    }
    this.log("Set feeder device config:", JSON.stringify(deviceConfig));

    // Mark device offline/online using our optimized method
    this._updateOnlineState(deviceConfig.online);

    // Update existing status codes from the cloud
    const statusArr = deviceConfig.status || [];
    this.updateCapabilities(statusArr);
  }

  updateCapabilities(statusArr) {
    this.log("Update feeder capabilities from Tuya:", statusArr);

    // Optionally, if a normal status update implies the device is online:
    this._updateOnlineState(true);

    for (const statusMap of statusArr) {
      if (!statusMap.code) continue;

      switch (statusMap.code) {
        case "feed_state": {
          const newState = statusMap.value; // e.g. "feeding" / "standby"
          this.log("Feeder feed_state ->", newState);

          // Update text capability "feeding_state" (string)
          this.setCapabilityValue("feeding_state", newState).catch(this.error);

          // Turn alarm_feeding on if "feeding", otherwise off
          const isFeeding = newState === "feeding";
          this.setCapabilityValue("alarm_feeding", isFeeding).catch(this.error);

          // Also set the button feed_now to reflect feeding vs. standby
          if (this.hasCapability("feed_now")) {
            this.setCapabilityValue("feed_now", isFeeding).catch(this.error);
          }

          // If changed to "feeding", update last feed time
          if (isFeeding) {
            this._updateLastFeedTime();
          }
          break;
        }
        case "feed_report": {
          // E.g. "2", "1", "6" ...
          const newVal = Number(statusMap.value) || 0;
          this.log("Feeder feed_report ->", newVal);

          // Reflect it in measure_feed_portions
          this.setCapabilityValue("measure_feed_portions", newVal).catch(this.error);

          // Optionally treat any value change as a new feed event
          this._updateLastFeedTime();
          break;
        }
        case "meal_plan":
          this.log("Feeder meal_plan (raw) ->", statusMap.value);
          break;
        case "manual_feed":
          // Possibly an integer from the device side
          break;
        case "factory_reset":
          // Typically write-only
          break;
      }
    }
  }

  async _onManualFeedChanged(valueObj) {
    this.log("Manual feed slider changed ->", valueObj);
    const portions = Number(valueObj.manual_feed_action) || 0;
    if (portions < 1 || portions > 12) {
      this.log("Invalid feed portion, defaulting to 1");
      this.manualPortions = 1;
    } else {
      this.manualPortions = portions;
      this.log("Stored feed portion value:", this.manualPortions);
    }
    return true;
  }

  async _onFeedNowButtonPressed(currentValue) {
    this.log("feed_now button pressed, currentValue ->", currentValue);
    let portions = 1;
    if (typeof this.manualPortions === "number" && this.manualPortions >= 1 && this.manualPortions <= 12) {
      portions = this.manualPortions;
    }
    this.log("Feeding with portions:", portions);
    await this.feedNow(portions);
    this.setCapabilityValue("feed_now", true).catch(this.error);
    setTimeout(() => {
      this.setCapabilityValue("feed_now", false).catch(this.error);
    }, 2000);
    return true;
  }

  async feedNow(portions) {
    this.log("Feed requested ->", portions);
    if (portions < 1 || portions > 12) {
      this.log("Invalid feed portion, ignoring");
      return false;
    }
    const param = {
      commands: [{ code: "manual_feed", value: portions }],
    };
    try {
      await this.homey.app.tuyaOpenApi.sendCommand(this.id, param);
      this.log("Manual feed command sent successfully");
      return true;
    } catch (err) {
      this.error("Feeder sendCommand error:", err);
      throw err;
    }
  }

  /**
   * Updates the alarm_device_offline capability.
   * It checks the current capability value and only updates when there is a change.
   * Also sets the device as unavailable when offline.
   */
  _updateOnlineState(isOnline) {
    const isOffline = (isOnline === false);
    if (this.hasCapability("alarm_device_offline")) {
      const current = this.getCapabilityValue("alarm_device_offline");
      if (current === isOffline) {
        return;
      }
    }
    this.log(`Feeder isOffline: ${isOffline}`);
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

  _updateLastFeedTime() {
    const tz = this.homey.clock.getTimezone();
    const nowString = new Date().toLocaleString(undefined, {
      timeZone: tz,
      hour12: false
    });
    this.log("Updating last feed time to:", nowString);
    this.setCapabilityValue("text_last_feed_time", nowString).catch(this.error);
  }
}

module.exports = TuyaFeederDevice;
