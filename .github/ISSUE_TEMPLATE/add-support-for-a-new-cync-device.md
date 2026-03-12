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

Please enable **Homebridge Debug Mode** (`-D` or toggle in the UI), restart Homebridge, and paste the **full debug block for this device**.

Look for log lines like:

```

[Cync App] Fetched device: {
deviceId: …,
productId: …,
model: …,
capabilities: …,
raw: …
}

```

Paste them here (you may redact serial numbers if desired):

```

<insert logs>
```

---

## 3. Cloud `/property` Responses

To understand how the device reports state, please:

1. Turn the device **on**
2. Turn it **off**
3. Adjust **brightness** or **color** in the **Cync app**

Then copy any log lines showing cloud property responses such as:

```
[Cync App] [cloud] GET /product/.../device/.../property → …
```

Paste them here:

```
<insert logs>
```

---

## 4. LAN / TCP Logs (If Available)

Some Cync devices support **LAN/TCP communication** for faster updates.

If you see logs like `[Cync TCP] Connecting…`, please include examples such as:

```
[Cync TCP][recv] …
[Cync TCP][send] …
```

Paste them here:

```
<insert logs>
```

If your device does **not** show TCP logs, say so:

```
No TCP messages observed.
```

---

## 5. Screenshots from the **Cync App**

Please attach screenshots **from the Cync mobile app (not Apple Home)** showing:

* The **device settings page**
* The **main control UI** (brightness / color / mode controls)
* Any **advanced settings** available

These help determine which capabilities the device supports.

---

## 6. Anything Else?

If the device behaves in an unusual way (multiple endpoints, segmented lights, unusual controls, etc.), please describe it here.

```
<notes>
```

---

## Thank You

Once you submit this, I’ll analyze the device capabilities, determine the correct HomeKit service type, and add support to the plugin.
