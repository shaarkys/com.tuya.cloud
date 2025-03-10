"use strict";

const TuyaBaseDevice = require("../tuyabasedevice");

const CAPABILITIES_SET_DEBOUNCE = 1000;

class TuyaLightDevice extends TuyaBaseDevice {
  onInit() {
    this.initDevice(this.getData().id);
    this.setDeviceConfig(this.get_deviceConfig());
    this.registerMultipleCapabilityListener(
      this.getCapabilities(),
      async (values, options) => {
        return this._onMultipleCapabilityListener(values, options);
      },
      CAPABILITIES_SET_DEBOUNCE
    );
    this.log(`Tuya Light ${this.getName()} has been initialized`);
  }

  setDeviceConfig(deviceConfig) {
    if (deviceConfig != null) {
      this.log("set light device config: " + JSON.stringify(deviceConfig));
      let statusArr = deviceConfig.status ? deviceConfig.status : [];

      //Distinguish Tuya different devices under the same HomeBridge Service
      this.deviceCategorie = deviceConfig.category;
      this.correctLightModeCapability(statusArr);

      //get Lightbulb dp range
      this.function_dp_range = this.getDefaultDPRange(statusArr);
      this.updateCapabilities(statusArr);
    } else {
      this.homey.log("No device config found");
    }
  }

  correctLightModeCapability(statusArr) {
    for (var statusMap of statusArr) {
      switch (statusMap.code) {
        case "colour_data":
        case "colour_data_v2":
          if (!this.hasCapability("light_mode")) {
            this.homey.log("addCapability light_mode");
            this.addCapability("light_mode");
          }
      }
    }
  }

  _onMultipleCapabilityListener(valueObj, optsObj) {
    this.log("Light capabilities changed by Homey: " + JSON.stringify(valueObj));
    try {
      if (valueObj.dim != null) {
        this.set_brightness(valueObj.dim);
      }
      if (valueObj.onoff != null) {
        this.set_on_off(valueObj.onoff === true || valueObj.onoff === 1);
      }
      if (valueObj.light_temperature != null) {
        this.set_color_temp(1 - valueObj.light_temperature);
      }
      if (valueObj.light_hue != null || valueObj.light_saturation != null) {
        this.set_color(valueObj.light_hue, valueObj.light_saturation);
      }
    } catch (ex) {
      this.homey.error(ex);
    }
  }

  //init Or refresh AccessoryService
  updateCapabilities(statusArr) {
    this.log("Update light capabilities from Tuya: " + JSON.stringify(statusArr));

    // === IMPORTANT: Because we later do a `.some()` below (and call .includes()), 
    // we first define them out here *before* the loop:
    const hasColourData = statusArr.some(s => s.code && s.code.includes("colour_data"));
    const hasBrightValue = statusArr.some(s => s.code && s.code.includes("bright_value"));

    for (var statusMap of statusArr) {
      // If there's no `code`, skip so we don't crash
      if (!statusMap.code) {
        this.log("Skipping status with no `code`:", statusMap);
        continue;
      }

      if (statusMap.code === "work_mode") {
        this.workMode = statusMap;
      }

      if (statusMap.code === "switch_led" || statusMap.code === "switch_led_1") {
        this.switchLed = statusMap;
        this.normalAsync("onoff", this.switchLed.value);
      }

      if (
        statusMap.code === "bright_value" ||
        statusMap.code === "bright_value_v2" ||
        statusMap.code === "bright_value_1"
      ) {
        this.brightValue = statusMap;
        let rawValue = this.brightValue.value;
        let percentage = Math.floor(
          ((rawValue - this.function_dp_range.bright_range.min) * 100) /
            (this.function_dp_range.bright_range.max - this.function_dp_range.bright_range.min)
        );
        let mode = null;
        if (this.hasCapability("light_mode")) {
          mode = this.getCapabilityValue("light_mode");
        }
        this.normalAsync("dim", (percentage > 100 ? 100 : percentage) / 100);
        if (mode === "color") {
          this.normalAsync("light_mode", "color");
        }
      }

      if (statusMap.code === "temp_value" || statusMap.code === "temp_value_v2") {
        this.tempValue = statusMap;
        let rawValue = this.tempValue.value;
        let percentage = Math.floor(
          ((rawValue - this.function_dp_range.temp_range.min) * 100) /
            (this.function_dp_range.temp_range.max - this.function_dp_range.temp_range.min)
        );
        this.normalAsync("light_temperature", (100 - (percentage > 100 ? 100 : percentage)) / 100);
      }

      if (statusMap.code === "colour_data" || statusMap.code === "colour_data_v2") {
        this.colourData = statusMap;
        this.colourObj =
          this.colourData.value === ""
            ? { h: 100.0, s: 100.0, v: 100.0 }
            : JSON.parse(this.colourData.value);

        let percentage = Math.floor(
          ((this.colourObj.v - this.function_dp_range.bright_range.min) * 100) /
            (this.function_dp_range.bright_range.max - this.function_dp_range.bright_range.min)
        );
        this.normalAsync("dim", (percentage > 100 ? 100 : percentage) / 100);

        const hue = Math.floor((this.colourObj.h / 359) * 100); // 0-359 → 0-100
        this.normalAsync("light_hue", (hue > 100 ? 100 : hue) / 100);

        let saturation = Math.floor(
          ((this.colourObj.s - this.function_dp_range.saturation_range.min) * 100) /
            (this.function_dp_range.saturation_range.max - this.function_dp_range.saturation_range.min)
        );
        this.normalAsync("light_saturation", (saturation > 100 ? 100 : saturation) / 100);

        if (this.hasCapability("light_mode")) {
          this.normalAsync("light_mode", "color");
        }
      }
    }

    // === After we parse them, if the device is color-only but missing 'dim', add it:
    if (hasColourData && !hasBrightValue && !this.hasCapability("dim")) {
      this.log("Device has only colour_data, missing dim capability => adding it now...");
      this.addCapability("dim").catch(this.error);
    }
  }

  normalAsync(name, hbValue) {
    this.log("Set light Capability " + name + " with " + hbValue);
    this.setCapabilityValue(name, hbValue).catch(this.error);
  }

  sendCommand(name, value, value2) {
    const param = this.getSendParam(name, value, value2);
    this.homey.app.tuyaOpenApi.sendCommand(this.id, param).catch((error) => {
      this.error("[SET][%s] capabilities Error: %s", this.id, error);
      throw new Error(`Error sending command: ${error}`);
    });
  }

  // deviceConfig.functions is null, return defaultdpRange
  getDefaultDPRange(statusArr) {
    this.isHaveDPCodeOfBrightValue = false;
    let defaultBrightRange = { min: 10, max: 1000 };
    let defaultTempRange = { min: 0, max: 1000 };
    let defaultSaturationRange = { min: 0, max: 1000 };

    for (var statusMap of statusArr) {
      // again, skip if missing code
      if (!statusMap.code) continue;

      switch (statusMap.code) {
        case "bright_value":
          this.isHaveDPCodeOfBrightValue = true;
          if (this.deviceCategorie === "dj" || this.deviceCategorie === "dc") {
            defaultBrightRange = { min: 25, max: 255 };
          } else {
            defaultBrightRange = { min: 10, max: 1000 };
          }
          break;

        case "bright_value_1":
        case "bright_value_v2":
          this.isHaveDPCodeOfBrightValue = true;
          defaultBrightRange = { min: 10, max: 1000 };
          break;

        case "temp_value":
          if (this.deviceCategorie === "dj" || this.deviceCategorie === "dc") {
            defaultTempRange = { min: 0, max: 255 };
          } else {
            defaultTempRange = { min: 0, max: 1000 };
          }
          break;

        case "temp_value_v2":
          defaultTempRange = { min: 0, max: 1000 };
          break;

        case "colour_data":
          if (this.deviceCategorie === "dj" || this.deviceCategorie === "dc") {
            defaultSaturationRange = { min: 0, max: 255 };
            defaultBrightRange = { min: 25, max: 255 };
          } else {
            defaultSaturationRange = { min: 0, max: 1000 };
            defaultBrightRange = { min: 10, max: 1000 };
          }
          break;

        case "colour_data_v2":
          defaultSaturationRange = { min: 0, max: 1000 };
          defaultBrightRange = { min: 10, max: 1000 };
          break;

        default:
          break;
      }
    }

    const function_dp_range = {
      bright_range: defaultBrightRange,
      temp_range: defaultTempRange,
      saturation_range: defaultSaturationRange,
    };
    this.log("set light device config: " + JSON.stringify(function_dp_range));
    return function_dp_range;
  }

  set_on_off(onoff) {
    this.sendCommand("onoff", onoff);
  }

  set_color_temp(color_temp) {
    this.sendCommand("light_temperature", color_temp);
  }

  set_brightness(brightness) {
    this.sendCommand("dim", brightness);
  }

  set_color(hue, saturation) {
    this.sendCommand("light_hue", hue, saturation);
  }

  //get Command SendData
  getSendParam(name, value, value2) {
    let code;
    let val;

    switch (name) {
      case "onoff": {
        const isOn = !!value;
        code = this.switchLed?.code ?? "switch_led";
        val = isOn;
        break;
      }

      case "light_temperature": {
        const temperature = Math.floor(
          value * (this.function_dp_range.temp_range.max - this.function_dp_range.temp_range.min) +
            this.function_dp_range.temp_range.min
        );
        code = this.tempValue?.code ?? "temp_value";
        val = temperature;
        break;
      }

      case "dim": {
        const percentage = Math.floor(
          (this.function_dp_range.bright_range.max - this.function_dp_range.bright_range.min) * value +
            this.function_dp_range.bright_range.min
        );
        if (
          (!this.workMode ||
            this.workMode.value === "white" ||
            this.workMode.value === "light_white") &&
          this.isHaveDPCodeOfBrightValue
        ) {
          code = this.brightValue?.code ?? "bright_value";
          val = percentage;
        } else {
          const saturation = Math.floor(
            (this.function_dp_range.saturation_range.max -
              this.function_dp_range.saturation_range.min) *
              this.getCapabilityValue("light_saturation") +
              this.function_dp_range.saturation_range.min
          );
          const hue = this.getCapabilityValue("light_hue") * 359;
          code = this.colourData?.code ?? "colour_data";
          val = {
            h: hue,
            s: saturation,
            v: percentage,
          };
        }
        break;
      }

      case "light_hue": {
        let bright = Math.floor(
          (this.function_dp_range.bright_range.max - this.function_dp_range.bright_range.min) *
            this.getCapabilityValue("dim") +
            this.function_dp_range.bright_range.min
        );
        let hue = value ? value * 359 : this.getCapabilityValue("light_hue") * 359;
        let saturation2;
        if (value2) {
          saturation2 = Math.floor(
            (this.function_dp_range.saturation_range.max -
              this.function_dp_range.saturation_range.min) *
              value2 +
              this.function_dp_range.saturation_range.min
          );
        } else {
          saturation2 = Math.floor(
            (this.function_dp_range.saturation_range.max -
              this.function_dp_range.saturation_range.min) *
              this.getCapabilityValue("light_saturation") +
              this.function_dp_range.saturation_range.min
          );
        }
        code = this.colourData?.code ?? "colour_data";
        val = {
          h: hue,
          s: saturation2,
          v: bright,
        };
        break;
      }

      default:
        break;
    }

    this.log("update Tuya light code " + code + ": " + JSON.stringify(val));
    return {
      commands: [
        {
          code: code,
          value: val,
        },
      ],
    };
  }
}

module.exports = TuyaLightDevice;
