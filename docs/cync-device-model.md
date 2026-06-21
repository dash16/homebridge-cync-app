# **docs/cync-device-model.md**

## **Cync Device and Room Model**

This document defines the normalized structures used to represent Cync homes, rooms, devices, controllers, and capabilities. These definitions are derived from the behavior of the upstream Home Assistant integration.

---

## **1. Data Model Overview**

The Cync platform divides user resources into:

* **Homes**
* **Rooms (Groups)**
* **Devices (Switches, Plugs, Bulbs, Fan Switches, Motion/Ambient Sensors)**
* **Controllers (Wi-Fi switches controlling BLE mesh groups)**

The device model is primarily determined by cloud configuration, while device state is handled through the TCP protocol.

---

## **2. Home Structure**

```
CyncHome {
  id: string
  name: string
  controllers: number[]        // switch_id values
  homeDevices: { [meshIndex: number]: deviceId }
}
```

### **Properties**

* A home exists only if it contains at least one valid controller.
* Controller devices act as gateways for mesh devices over the TCP protocol.

---

## **3. Room Structure**

```
CyncRoom {
  roomId: string               // "{homeId}-{groupId}"
  name: string
  homeId: string
  meshId: number               // group ID
  roomController: string       // associated controller switch_id
  switches: string[]           // device IDs belonging to this room
  isSubgroup: boolean
  subgroups: string[]          // child rooms
  parentRoom?: string          // resolved later
}
```

### **Notes**

* Subgroups are validated as part of configuration assembly.
* Some room types represent multi-element groupings.

---

## **4. Device Structure**

```
CyncDevice {
  id: string
  name: string
  homeId: string
  roomId?: string
  roomName?: string
  meshId: number
  switchId: string             // controller association or "0"
  capabilities: CyncCapabilities
}
```

### **Behavior**

* Devices may represent plugs, bulbs, switches, fan switches, or sensors.
* Capabilities determine which HomeKit services will be exposed.

---

## **5. Capability Flags**

```
CyncCapabilities {
  onOff: boolean
  brightness: boolean
  colorTemp: boolean
  rgb: boolean

  motion: boolean
  ambientLight: boolean

  wifiControl: boolean         // device is a controller
  plug: boolean                // device is a smart plug
  fan: boolean                 // device is a fan switch

  multiElement?: number        // number of segments in multi-gang switches
}
```

These flags originate from a fixed mapping inside the upstream integration and are chosen based on the device’s reported type.

The plugin carries a normalized mapping derived from the `DeviceType` table in
a decompiled Cync Android APK. It uses the embedded product family to select
the HomeKit service and the following capabilities to expose supported controls:

- `Dimming` → Brightness
- `CctColor` → Color Temperature
- `RgbColor` → Hue and Saturation
- `FanSpeed` → Fan service and Rotation Speed
- `LightShow`, `MusicShow`, and `SegmentedControl` → corresponding show accessories

Known plugs are exposed as Outlets. Dimmable wall switches are intentionally
exposed as Lightbulbs because HomeKit Switch services do not support brightness.
Unknown future device types continue through cloud and LAN capability fallback
instead of being assigned a potentially incorrect APK-derived profile.
Per-device saved Segment metadata is also accepted as stronger runtime evidence
when it is present on a device not marked `SegmentedControl` by the APK table.

---

## **6. Controller Relationships**

Controllers bridge Wi-Fi → Cync mesh.

* Devices with `wifiControl == true` identify themselves as controllers.
* `switchID_to_homeID` maps each controller to an owning home.
* Devices without `switchId` or with `"0"` are assumed to be mesh-only nodes and must route commands through their associated controller.

---

## **7. Summary**

The model above defines the minimal structured representation required to:

* Construct Homebridge accessories.
* Route state updates.
* Build correct command frames (requires `switchId`, `meshId`).
* Group devices into rooms.
* Build user-facing metadata for configuration.

---
