'use strict';

const TuyaBaseDriver = require('../tuyabasedriver');

class TuyaFeederDriver extends TuyaBaseDriver {

  onInit() {
    this.log('Tuya pet feeder driver has been initialized');
  }

  async onPairListDevices() {
    if (!this.homey.app.isConnected()) {
      throw new Error("Please configure the Tuya Cloud app first.");
    }

    // Acquire all feeder devices by type "feeder" (which should map to category "cwwsq" in your base driver)
    const feeders = this.get_devices_by_type("feeder");
    this.log('Discovered feeders from Tuya:', JSON.stringify(feeders, null, 2));

    const devices = feeders.map(tuyaDevice => ({
      data: {
        id: tuyaDevice.id,  // unique ID
      },
      capabilities: [
        "feed_now",
        "feeding_state",
        "measure_feed_portions",
        "manual_feed_action",
        "alarm_device_offline",
        "text_last_feed_time",
        "alarm_feeding" 
      ],
      name: tuyaDevice.name || "Tuya Feeder"
    }));

    return devices.sort(TuyaBaseDriver._compareHomeyDevice);
  }
}

module.exports = TuyaFeederDriver;
