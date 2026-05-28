---
name: Add Support for a New Cync Device
about: Request adding support for a Cync device
title: Add Cync Device [MODEL]
labels: enhancement
assignees: dash16

---

Thank you for helping expand device support in **homebridge-cync-app**.

To add support for a new device model, I need diagnostic information from your plugin installation and the Cync app.

Please fill out all sections below.

---

## 1. Device Information

**1.1 Product name as shown in the Cync app**

(e.g., “6" Recessed Can Retrofit Fixture (Matter)”, “Indoor Smart Plug (3-in-1)”, “Indoor Smart Plug”)

**1.2 Product page URL (GE/Cync or retailer)**

Link to the product page if available.

Example:  
https://www.gelighting.com/smart-home/led-bulbs/soft-white

**1.3 What kind of device is this?**

* Plug (on/off only)
* Dimmer
* Tunable white
* Full color light
* Multi-zone light
* Switch
* Downlight
* Other (describe)

---

## 2. Discovery Logs (Required)

Please enable **Homebridge Debug Mode**, restart Homebridge, and paste the startup discovery logs for the affected device.

Look for lines like:

```text
[Cync] CyncClient: loading Cync cloud configuration…
[Cync] Fetching Cync devices from https://api.gelighting.com/...
[Cync] Cync devices payload: top-level array length=...
[Cync] CyncClient: probing properties for mesh ... (id=..., product_id=...)
[Cync] CyncClient: mesh ... properties keys=...
[Cync] CyncClient: mesh ... bulbsArray length=...
[Cync] CyncClient: bulb #... for mesh ... → {
  displayName: ...
  deviceID: ...
  deviceType: ...
  raw: { ... }
}
```

Please include the full bulb #... block for the affected device.
You may redact Wi-Fi names, MAC addresses, and tokens.
```

<insert logs>
```

---

## 3. Screenshots from the **Cync App**

Please attach screenshots **from the Cync mobile app (not Apple Home)** showing:

* The **device settings page**
* The **main control UI** (brightness / color / mode controls)
* Any **advanced settings** available

These help determine which capabilities the device supports.

---

## 4. Anything Else?

If the device behaves in an unusual way (multiple endpoints, segmented lights, unusual controls, etc.), please describe it here.

```
<notes>
```

---

## Thank You

Once you submit this, I’ll analyze the device capabilities, determine the correct HomeKit service type, and add support to the plugin.
