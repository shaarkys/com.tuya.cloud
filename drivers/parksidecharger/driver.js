"use strict";

const TuyaBaseDriver = require("../tuyabasedriver");

class ParksideChargerDriver extends TuyaBaseDriver {

  onInit() {
    this.log("ParksideChargerDriver has been initialized");
  }

  async onPairListDevices() {
    if (!this.homey.app.isConnected()) {
      throw new Error("Please configure the Tuya Cloud app first.");
    }

    // Fetch all 'parksidecharger' devices by type from the cloud
    const chargers = this.get_devices_by_type("parksidecharger");
    this.log("Discovered Parkside chargers:", JSON.stringify(chargers, null, 2));

    // Map them into Homey device objects for the pairing wizard
    const devices = chargers.map((tuyaDevice) => ({
      data: {
        id: tuyaDevice.id, // unique Tuya ID
      },
      // Must match driver.compose.json capabilities:
      capabilities: [
        "measure_battery",
        "battery_charging",
        "measure_charge_current",
        "measure_charge_voltage",
        "storage_button",
        "measure_temperature",
        "onoff",
        "alarm_device_offline"
      ],
      name: tuyaDevice.name || "Parkside Charger",
    }));

    // Sort by device name
    return devices.sort(TuyaBaseDriver._compareHomeyDevice);
  }
}

module.exports = ParksideChargerDriver;
